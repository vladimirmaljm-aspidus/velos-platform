import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";
import { requirePermission } from "@/lib/permissions/can";
import { isValidDocumentStatus } from "@/lib/data/marketplace-trade-documents-store";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// PUT    /api/admin/marketplace/documents/[id]                              (101)
// DELETE /api/admin/marketplace/documents/[id]                              (101)
//
// Admin control over a single marketplace trade document.
//
// PUT body: { status?: "draft"|"generated"|"sent"|"signed"|"rejected",
//             reference_number?: string|null }
//   • status fix + reference correction are the two safe, meaningful admin
//     edits (the document_data content is a generated artefact — the
//     issuer regenerates it from the wizard, we don't hand-edit JSON).
//   • Signed documents: status is left alone unless the admin explicitly
//     passes ?force=1 (an audit trail entry is written either way).
//
// DELETE: removes the row (hard delete — trade documents have no storage
//   object; the PDF is rendered live from document_data). Signed docs
//   require ?force=1. Audited with the full row snapshot.
//
// • super_admin — any tenant; tenant admin — own tenant only.
// Auth: `marketplace.documents` permission.
// ─────────────────────────────────────────────────────────────────────────────

async function _put(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.documents");
    if (_d) return _d;
  }
  const { id } = await ctx.params;
  const force = new URL(req.url).searchParams.get("force") === "1";

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const sb = getSupabase();
    const { data: raw, error: lookupErr } = await sb
      .from("marketplace_trade_documents")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!raw) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const doc = raw as any;
    if (!auth.isSuperAdmin && doc.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const patch: Record<string, unknown> = {};

    if (body?.status !== undefined) {
      const status = String(body.status || "");
      if (!isValidDocumentStatus(status)) {
        return NextResponse.json(
          { error: "Invalid status. Allowed: draft, generated, sent, signed, rejected." },
          { status: 400 },
        );
      }
      if (doc.digital_signature && doc.status !== status && !force) {
        return NextResponse.json(
          { error: "This document is signed — its status is locked. Retry with ?force=1 to override (the action is audited)." },
          { status: 409 },
        );
      }
      patch.status = status;
    }
    if (body?.reference_number !== undefined) {
      const ref = body.reference_number === null ? null : String(body.reference_number).trim();
      if (ref !== null && ref.length > 64) {
        return NextResponse.json({ error: "reference_number is too long (max 64 chars)." }, { status: 400 });
      }
      patch.reference_number = ref;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update — provide status or reference_number." }, { status: 400 });
    }

    const { data: updated, error: updateErr } = await sb
      .from("marketplace_trade_documents")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    await audit(auth.store, auth.user, req, "marketplace.document.admin_edit", "marketplace_trade_document", id, {
      document_type: doc.document_type,
      changes: patch,
      previous: { status: doc.status, reference_number: doc.reference_number },
      forced: !!force && !!doc.digital_signature,
    });
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[admin.marketplace.documents] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

async function _delete(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const _d = requirePermission(auth, "marketplace.documents");
    if (_d) return _d;
  }
  const { id } = await ctx.params;
  const force = new URL(req.url).searchParams.get("force") === "1";

  try {
    const sb = getSupabase();
    const { data: raw, error: lookupErr } = await sb
      .from("marketplace_trade_documents")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!raw) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const doc = raw as any;
    if (!auth.isSuperAdmin && doc.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (doc.digital_signature && !force) {
      return NextResponse.json(
        { error: "This document is signed — deleting it removes a signed record. Retry with ?force=1 to override (the action is audited)." },
        { status: 409 },
      );
    }

    await sb.from("marketplace_trade_documents").delete().eq("id", id);

    await audit(auth.store, auth.user, req, "marketplace.document.admin_delete", "marketplace_trade_document", id, {
      document_type: doc.document_type,
      status: doc.status,
      reference_number: doc.reference_number,
      partner_id: doc.partner_id,
      post_id: doc.post_id,
      negotiation_id: doc.negotiation_id,
      signed: !!doc.digital_signature,
      forced: !!force && !!doc.digital_signature,
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[admin.marketplace.documents] DELETE failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const PUT = withApm(_put, "PUT /api/admin/marketplace/documents/[id]");
export const DELETE = withApm(_delete, "DELETE /api/admin/marketplace/documents/[id]");
