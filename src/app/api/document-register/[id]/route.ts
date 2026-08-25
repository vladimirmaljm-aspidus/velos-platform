import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import type { DocumentRegisterEntry } from "@/lib/supabase/types";

export const runtime = "nodejs";

// ── FIX-TENANT-DOC: verification workflow ──
// PUT /api/document-register/[id] — used by the "Verify" and "Reject"
// buttons in the document-register view. Body:
//   { verification_status: "verified" | "rejected", reject_reason?: string }
// Updates the row's `metadata.verification_status` (and the related
// `verified_by` / `verified_at` / `reject_reason` fields). The DB schema
// isn't changed — all extension fields live inside the existing
// `metadata` JSONB column.
//
// Permission gate: `document-register.update` for any state change.
// (An admin role is implicitly required by that permission — see
// `src/lib/permissions/catalog.ts`.)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (document-register.update)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-register.update"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;

    // Tenant ownership check: listDocumentRegister filters by tenant_id,
    // so a non-super_admin only sees their own tenant's rows.
    const all = await auth.store.listDocumentRegister(auth.tenantId ?? "", { limit: 100000 });
    const existing = all.items.find((d) => d.id === id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    let body: { verification_status?: "verified" | "rejected" | "pending"; reject_reason?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const newStatus = body.verification_status;
    if (newStatus !== "verified" && newStatus !== "rejected" && newStatus !== "pending") {
      return NextResponse.json(
        { error: "verification_status must be 'verified', 'rejected', or 'pending'." },
        { status: 400 },
      );
    }
    if (newStatus === "rejected" && !body.reject_reason?.trim()) {
      return NextResponse.json(
        { error: "reject_reason is required when rejecting a document." },
        { status: 400 },
      );
    }

    // Merge the verification fields into the existing metadata so we
    // don't clobber other extension fields (file_url, linked_*_id, etc).
    const existingMeta =
      (existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}) as Record<string, unknown>;
    const updatedMeta: Record<string, unknown> = {
      ...existingMeta,
      verification_status: newStatus,
      // verified_by / verified_at are set on every transition — both
      // verify and reject. The reject_reason is null unless rejecting.
      verified_by: auth.user.id,
      verified_at: new Date().toISOString(),
      reject_reason: newStatus === "rejected" ? (body.reject_reason?.trim() || null) : null,
    };

    // Re-upsert the row. The smartUpsert call below updates the row in
    // place because we pass the existing id.
    const patch: Partial<DocumentRegisterEntry> & { id?: string } = {
      id: existing.id,
      tenant_id: existing.tenant_id,
      metadata: updatedMeta,
    };
    const updated = await auth.store.upsertDocumentRegisterEntry(patch);

    await audit(
      auth.store,
      auth.user,
      req,
      `document.register.${newStatus}`,
      "document_register",
      existing.id,
      { number: existing.number, reject_reason: body.reject_reason || null },
    );

    // Surface the metadata-stored extension fields onto the response so
    // the UI can update its local cache without a separate GET. Same
    // merge logic as the GET / POST routes.
    const merged: DocumentRegisterEntry = {
      ...updated,
      verification_status: newStatus,
      verified_by: updatedMeta.verified_by as string | null,
      verified_at: updatedMeta.verified_at as string | null,
      reject_reason: updatedMeta.reject_reason as string | null,
    };
    return NextResponse.json(merged);
  } catch (error: any) {
    console.error("[document-register PUT id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (document-register.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-register.delete"); if (_d) return _d; } /* requirePermission wired */
    const { id } = await params;
    // Tenant ownership check: listDocumentRegister ignores tenantId in the store,
    // so we fetch all and filter for non-super_admin.
    const all = await auth.store.listDocumentRegister(auth.tenantId ?? "", { limit: 100000 });
    const existing = all.items.find((d) => d.id === id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await auth.store.deleteDocumentRegisterEntry(id);
    await audit(auth.store, auth.user, req, "document.register.delete", "document_register", id);
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[document-register DELETE id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (document-register.read)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-register.read"); if (_d) return _d; } /* requirePermission wired */

    const { id } = await params;
    // Tenant ownership check on the parent document before listing its revisions.
    const all = await auth.store.listDocumentRegister(auth.tenantId ?? "", { limit: 100000 });
    const existing = all.items.find((d) => d.id === id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const revisions = await auth.store.listDocumentRevisions(auth.tenantId ?? "", id);
    return NextResponse.json({ items: revisions });
  } catch (error: any) {
    console.error("[document-register GET id]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
