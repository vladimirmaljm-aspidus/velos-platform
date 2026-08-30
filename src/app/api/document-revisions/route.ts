import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-register.update"); if (_d) return _d; }
  if (!auth.tenantId) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // ── TENANT-OWNERSHIP CHECK on document_id (audit 2d2-F25) ──────────
  // Previously this route accepted body.document_id without verifying
  // that the parent document (offer / invoice / proforma / LOI) actually
  // belongs to the caller's tenant. The `tenant_id` field on the new
  // revision row was set to auth.tenantId (line 18), but `document_id`
  // could be a foreign tenant's offer id → the revision row was created
  // with the foreign document_id + the caller's tenant_id (a cross-tenant
  // revision injection). The 2c2-F8 finding also noted the
  // document_revisions.document_id FK is missing from the live DB — so
  // nothing prevented the row from being persisted with an orphan
  // document_id.
  //
  // Fix: before INSERT, look up the parent document across the four
  // candidate tables (offers, invoices, proformas, lois) and require an
  // exact tenant_id match. A 404 is returned for foreign document_ids
  // (defense in depth: the response is identical to "document doesn't
  // exist" so the caller learns nothing about other tenants' ids).
  if (body.document_id) {
    const sb = getSupabase();
    const candidateTables = ["offers", "invoices", "proformas", "lois"];
    let foundOwnTenant = false;
    for (const t of candidateTables) {
      try {
        const { data: parent, error: lookupErr } = await sb
          .from(t)
          .select("id, tenant_id")
          .eq("id", body.document_id)
          .maybeSingle();
        if (lookupErr) {
          // Defensive: log + skip this table, try the next. A persistent
          // error across all four tables will result in a 404 below.
          console.warn(`[document-revisions POST] tenant-ownership lookup on ${t} failed:`, lookupErr.message);
          continue;
        }
        if (parent && parent.tenant_id === auth.tenantId) {
          foundOwnTenant = true;
          break;
        }
      } catch (e: any) {
        console.warn(`[document-revisions POST] tenant-ownership lookup on ${t} threw:`, e?.message || e);
        continue;
      }
    }
    if (!foundOwnTenant) {
      // Either the document doesn't exist, or it exists but belongs to
      // another tenant. Same 404 in both cases (no information leak).
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
  }

  body.tenant_id = auth.tenantId;
  if (!body.created_by) body.created_by = auth.user.id;
  const created = await auth.store.addDocumentRevision(body);
  await audit(auth.store, auth.user, req, "document.revision.create", "document_revision", created.id, {
    document_id: created.document_id,
    version: created.version,
  });
  return NextResponse.json(created);
}
