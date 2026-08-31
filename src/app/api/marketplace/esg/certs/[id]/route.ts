import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";
import {
  deleteSustainabilityCert,
  patchSustainabilityCert,
} from "@/lib/data/marketplace-esg-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// PUT /api/marketplace/esg/certs/[id] — patch a sustainability cert.
//
// Two authorisation paths:
//   • Super-admin (any field, including `verified`): used by the verify
//     button on the company profile / admin review surface. When
//     `verified: true` is supplied the store stamps verified_at = now;
//     when `verified: false` is supplied the store clears verified_at.
//   • Owning partner (non-`verified` fields only): used by the company
//     itself to correct the cert_number / issuer / expiry / document_url.
//     The owning partner CANNOT flip verified — that path throws 403.
//
// Body (any subset):
//   { verified?, cert_number?, cert_issuer?, valid_until?, document_url? }
async function _put(req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Field-level validation (regardless of which path is taken).
  if (body.verified !== undefined && typeof body.verified !== "boolean") {
    return NextResponse.json({ error: "verified must be a boolean." }, { status: 400 });
  }
  if (body.cert_number !== undefined && body.cert_number !== null && (typeof body.cert_number !== "string" || body.cert_number.length > 200)) {
    return NextResponse.json({ error: "cert_number must be ≤ 200 chars." }, { status: 400 });
  }
  if (body.cert_issuer !== undefined && body.cert_issuer !== null && (typeof body.cert_issuer !== "string" || body.cert_issuer.length > 200)) {
    return NextResponse.json({ error: "cert_issuer must be ≤ 200 chars." }, { status: 400 });
  }
  if (body.valid_until !== undefined && body.valid_until !== null && (typeof body.valid_until !== "string" || Number.isNaN(Date.parse(body.valid_until)))) {
    return NextResponse.json({ error: "valid_until must be an ISO 8601 date." }, { status: 400 });
  }
  if (body.document_url !== undefined && body.document_url !== null && (typeof body.document_url !== "string" || body.document_url.length > 1000)) {
    return NextResponse.json({ error: "document_url must be ≤ 1000 chars." }, { status: 400 });
  }

  // Authorisation path 1 — super-admin (any field, including `verified`).
  const adminAuth = await requireSuperAdmin(req);
  if (!(adminAuth instanceof NextResponse)) {
    try {
      const updated = await patchSustainabilityCert(id, {
        verified: body.verified,
        cert_number: body.cert_number ?? undefined,
        cert_issuer: body.cert_issuer ?? undefined,
        valid_until: body.valid_until ?? undefined,
        document_url: body.document_url ?? undefined,
      });
      if (!updated) {
        return NextResponse.json({ error: "Cert not found." }, { status: 404 });
      }
      try {
        await audit(
          adminAuth.store,
          { id: adminAuth.user.id, username: adminAuth.user.username, tenant_id: adminAuth.tenantId ?? undefined },
          req,
          "marketplace.sustainability_cert_verified",
          "marketplace_sustainability_certs",
          updated.id,
          { verified: updated.verified, cert_type: updated.cert_type, partner_id: updated.partner_id },
        );
      } catch (e) {
        console.error("[marketplace.esg.certs.verify] audit failed:", e);
      }
      return NextResponse.json(updated);
    } catch (e: any) {
      console.error("[marketplace.esg.certs.verify]", e);
      const msg = sanitizeError(e);
      const status = /invalid|must be/i.test(msg) ? 400 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  }

  // The super-admin path returned a NextResponse (403). Fall through to the
  // owning-partner path — but ONLY if the body did NOT include `verified`
  // (a non-super-admin partner cannot flip the verified flag).
  if (body.verified !== undefined) {
    return NextResponse.json(
      { error: "Only super-admins can verify certifications." },
      { status: 403 },
    );
  }

  // Authorisation path 2 — owning partner (non-verified fields only).
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  try {
    const updated = await patchSustainabilityCert(id, {
      cert_number: body.cert_number ?? undefined,
      cert_issuer: body.cert_issuer ?? undefined,
      valid_until: body.valid_until ?? undefined,
      document_url: body.document_url ?? undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Cert not found." }, { status: 404 });
    }
    // Re-check ownership — the store returns the row regardless of who owns
    // it; the caller may only patch their OWN cert.
    if (updated.partner_id !== access.partner_id) {
      return NextResponse.json({ error: "Not authorised." }, { status: 403 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.sustainability_cert_updated",
        "marketplace_sustainability_certs",
        updated.id,
        { cert_type: updated.cert_type },
      );
    } catch (e) {
      console.error("[marketplace.esg.certs.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.esg.certs.update]", e);
    const msg = sanitizeError(e);
    const status = /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE /api/marketplace/esg/certs/[id] — delete a sustainability cert.
// Owning partner only. The store filters by partner_id so a partner from
// tenant A can never delete tenant B's certs by guessing ids.
async function _delete(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ok = await deleteSustainabilityCert(id, access.partner_id);
    if (!ok) {
      return NextResponse.json({ error: "Cert not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.sustainability_cert_deleted",
        "marketplace_sustainability_certs",
        id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.esg.certs.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.esg.certs.delete]", e);
    return NextResponse.json({ error: "Failed to delete cert." }, { status: 500 });
  }
}

export const PUT = withApm(_put, "PUT /api/marketplace/esg/certs/[id]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/esg/certs/[id]");
