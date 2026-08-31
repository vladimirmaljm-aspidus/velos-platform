import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
// 8c-2: KYC gate — mirror top-level marketplace POST route. Without this,
// a portal client whose KYC is `rejected` / `suspended` could still create
// shipments / sign trade documents / post community content — binding
// commitments that affect counterparty's downstream flows.
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { getDocument, signDocument } from "@/lib/data/marketplace-trade-documents-store";
import { computeDocumentFingerprint } from "@/lib/marketplace/document-pdf";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";
import { getSupabase } from "@/lib/supabase/client";
import { notifyDocumentSigned } from "@/lib/notif/helper";

export const runtime = "nodejs";

// POST /api/marketplace/documents/[id]/sign — apply a tamper-detection
// fingerprint to a trade document. The "fingerprint" (currently named
// `digital_signature` in the DB column for backward compatibility, but
// surfaced as `document_fingerprint` in the API response) is a SHA-256
// over the canonicalised `document_data` JSONB + the signer's partner_id
// (so the same payload signed by two different partners produces two
// different fingerprints).
//
// ⚠️ MARKET-H24 — IMPORTANT SEMANTIC NOTE:
// This value is NOT a cryptographic digital signature in the
// non-repudiation sense. It is a tamper-detection FINGERPRINT. Anyone
// with the document_data + the partner_id can recompute it (the
// "private key" is just the partner_id, which is not secret). It can
// prove the document_data has not changed since the fingerprint was
// recorded, but it cannot prove WHO recorded it — anyone could have
// computed the same hash. A real digital signature (one that holds up
// in court as a non-repudiation proof) requires per-partner asymmetric
// key pairs (private key signs, public key verifies) — a future
// iteration. Until then this column is named `document_fingerprint` in
// the API response to avoid implying a stronger guarantee than the
// system actually provides. The DB column stays `digital_signature`
// so existing migrations / RLS / audit joins keep working.
//
// Auth: the issuing partner only (the store filters by tenant_id +
// partner_id). The signer must be the issuer — a counterparty cannot
// sign a document they did not create; they sign their acceptance by
// issuing their own counter-document (e.g. a counter-invoice).
//
// SIGNED DOCUMENTS ARE IMMUTABLE: once signed, the document_data cannot
// be modified (the store refuses any PUT to a signed row). The
// fingerprint + signed_at + signed_by columns are committed atomically.
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  // 8c-2: KYC gate — defence-in-depth, mirror top-level marketplace POST.
  const _kycBlock = await requireKycApproved(access);
  if (_kycBlock) return _kycBlock;
  const { id } = await ctx.params;

  // Parse an optional body. The route accepts an empty body (the standard
  // path) OR { notes?: string } for an audit-trail annotation.
  let body: { notes?: string } = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as { notes?: string };
    }
  } catch {
    // Empty body is fine.
  }

  try {
    // Fetch the doc to (a) verify it exists + belongs to caller's tenant
    // and (b) read the JSONB so we can compute the fingerprint. The
    // fingerprint is computed over the *current* document_data — if the
    // caller has already modified the data, the signature reflects that
    // latest version (signing is a "snapshot" of the doc as-is).
    const doc = await getDocument(id, access.tenant_id);
    if (!doc) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (doc.partner_id !== access.partner_id) {
      return NextResponse.json(
        { error: "Only the issuing partner can sign this document." },
        { status: 403 },
      );
    }
    if (doc.digital_signature) {
      // Already signed — idempotent return of the current state. Surface
      // the existing fingerprint under the `document_fingerprint` name
      // (see the MARKET-H24 note above for the rationale).
      const { digital_signature, ...restDoc } = doc;
      return NextResponse.json({
        document: { ...restDoc, document_fingerprint: digital_signature },
        already_signed: true,
      });
    }

    // Compute the tamper-detection fingerprint (NOT a cryptographic
    // signature — see the MARKET-H24 block comment at the top of this
    // file). Renamed from `signature` to `documentFingerprint` in the
    // local scope so future readers don't mistake it for non-repudiation.
    const documentFingerprint = computeDocumentFingerprint(
      doc.document_data as Record<string, any>,
      access.partner_id,
    );

    const signed = await signDocument(
      id,
      access.tenant_id,
      access.partner_id,
      documentFingerprint,
    );
    if (!signed) {
      return NextResponse.json(
        { error: "Failed to sign document." },
        { status: 500 },
      );
    }

    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.document_signed",
        "marketplace_trade_documents",
        signed.id,
        {
          document_type: signed.document_type,
          reference_number: signed.reference_number,
          fingerprint_prefix: documentFingerprint.slice(0, 12),
          notes: body.notes ?? null,
        },
      );
      // Phase 12 — fire marketplace.document_signed webhook
      // (fire-and-forget). Receivers can use this to trigger downstream
      // flows: eBL hand-off to the carrier, customs filing of the
      // signed commercial invoice, payment-schedule activation, etc.
      void triggerWebhooks(store, access.tenant_id, "marketplace.document_signed", "marketplace_trade_document", signed.id, {
        document_id: signed.id,
        document_type: signed.document_type,
        reference_number: signed.reference_number,
        signed_by: access.partner_id,
        signed_at: signed.signed_at,
        fingerprint_prefix: documentFingerprint.slice(0, 12),
      }).catch(() => {});
    } catch (e) {
      console.error("[marketplace.documents.sign] audit failed:", e);
    }

    // FIX-NOTIF-A11Y: notify the non-signing party that the document
    // was digitally signed by the issuer. The audit + webhook above
    // are the system record / external integration; this is the in-app
    // signal to the partner on the other side of the trade so they
    // know the issuer's signature is recorded and they can act on it
    // (e.g. counter-sign, file customs, release goods).
    //
    // Counterparty resolution priority:
    //   1. negotiation_id → the OTHER partner in the negotiation room
    //      (partner_id_a vs partner_id_b, pick the one != signer).
    //   2. post_id → if the signer is the post owner, the counterparty
    //      is the partner whose response is accepted on this post;
    //      otherwise the counterparty is the post owner.
    //   3. neither → standalone doc, no counterparty to notify.
    // Best-effort — failures are caught and never break the response.
    try {
      const sb = getSupabase();
      let nonSigningPartyId: string | null = null;
      if (signed.negotiation_id) {
        const { data: negRow } = await sb
          .from("marketplace_negotiations")
          .select("partner_id_a, partner_id_b")
          .eq("id", signed.negotiation_id)
          .maybeSingle();
        const neg = negRow as { partner_id_a: string; partner_id_b: string } | null;
        if (neg) {
          nonSigningPartyId =
            neg.partner_id_a === access.partner_id
              ? neg.partner_id_b
              : neg.partner_id_a;
        }
      } else if (signed.post_id) {
        const { data: postRow } = await sb
          .from("marketplace_posts")
          .select("partner_id")
          .eq("id", signed.post_id)
          .maybeSingle();
        const postOwner = (postRow as { partner_id: string } | null)?.partner_id;
        if (postOwner && postOwner !== access.partner_id) {
          // Signer is the responder; counterparty is the post owner.
          nonSigningPartyId = postOwner;
        } else if (postOwner === access.partner_id) {
          // Signer is the post owner; counterparty is the partner
          // with an accepted response on this post (if any).
          const { data: acceptedResp } = await sb
            .from("marketplace_responses")
            .select("partner_id")
            .eq("post_id", signed.post_id)
            .eq("tenant_id", access.tenant_id)
            .eq("status", "accepted")
            .limit(1)
            .maybeSingle();
          const responder = (acceptedResp as { partner_id: string } | null)?.partner_id;
          if (responder && responder !== access.partner_id) {
            nonSigningPartyId = responder;
          }
        }
      }
      if (nonSigningPartyId) {
        const docTitle =
          signed.reference_number ||
          signed.document_type?.replace(/_/g, " ") ||
          "a trade document";
        // Look up the signing partner's name to include in the
        // notification message for context.
        let signedByName: string | undefined;
        try {
          const store2 = await getStore();
          const signer = await store2.getPartner(access.partner_id);
          if (signer?.name) signedByName = signer.name;
        } catch {
          /* non-fatal — name is optional context */
        }
        void notifyDocumentSigned(
          access.tenant_id,
          nonSigningPartyId,
          signed.id,
          docTitle,
          signedByName,
        );
      }
    } catch (e) {
      console.error("[marketplace.documents.sign] notify failed:", e);
    }
    // Surface the fingerprint under the `document_fingerprint` name in
    // the response (see the MARKET-H24 note at the top of this file).
    // Strip the DB-column name `digital_signature` so the API contract
    // doesn't promise a stronger guarantee than the system actually
    // provides (it's a tamper-detection hash, not a non-repudiation
    // signature).
    const { digital_signature: _strippedDbSig, ...restSigned } = signed;
    return NextResponse.json({
      document: { ...restSigned, document_fingerprint: signed.digital_signature },
      already_signed: false,
    });
  } catch (e: any) {
    console.error("[marketplace.documents.sign]", e);
    const msg = sanitizeError(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/documents/[id]/sign");
