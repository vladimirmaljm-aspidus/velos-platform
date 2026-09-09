import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getPortalUpload, softDeletePortalUpload, hardDeletePortalUpload, updatePortalUpload, type PortalUploadCategory } from "@/lib/portal/uploads";
import { getSupabase } from "@/lib/supabase/client";

/** Super-admin fallback: no tenant scope → look up tenant_id from the row itself. */
async function findAnyUpload(id: string) {
  const { data } = await getSupabase().from("portal_uploads").select("*").eq("id", id).maybeSingle();
  return data as any;
}

export const runtime = "nodejs";

/**
 * GET    /api/portal-uploads/[id]        → metadata
 * DELETE /api/portal-uploads/[id]        → soft-delete (default) or ?hard=1 to remove storage + row
 */

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.read"); if (_d) return _d; }

    const { id } = await params;
    const finalUpload = auth.isSuperAdmin
      ? await findAnyUpload(id)
      : await getPortalUpload(id, auth.tenantId || "");
    if (!finalUpload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && finalUpload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(finalUpload);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.delete"); if (_d) return _d; }

    const { id } = await params;
    // ADMIN-H4: use the same super-admin fallback as GET — `getPortalUpload`
    // adds `.eq("tenant_id", tenantId)` to its query, so a super-admin
    // with no tenant context (or whose tenant_id is set to something
    // other than the upload's owning tenant) would 404 even though they
    // legitimately should be able to see + delete any tenant's upload.
    const upload = auth.isSuperAdmin
      ? await findAnyUpload(id)
      : await getPortalUpload(id, auth.tenantId || "");
    if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && upload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const hard = new URL(req.url).searchParams.get("hard") === "1";
    if (hard) {
      await hardDeletePortalUpload(id, upload.tenant_id);
      await audit(auth.store, auth.user, req, "portal_upload.hard_delete", "portal_upload", id, { filename: upload.filename, storage_path: upload.storage_path });
      return NextResponse.json({ ok: true, hard: true });
    }
    await softDeletePortalUpload(id, upload.tenant_id, auth.user.username);
    await audit(auth.store, auth.user, req, "portal_upload.soft_delete", "portal_upload", id, { filename: upload.filename });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/portal-uploads/[id]                                             (101)
//
// Admin edit of an uploaded document's metadata — closes the user request
// "admins must be able to tidy up old/bad documents that clients uploaded
// through the portal (anywhere, marketplace included)".
//
// Body (all optional, at least one required):
//   { filename?: string, category?: PortalUploadCategory,
//     description?: string | null }
//
// Rules:
//   • `filename` — trimmed, 1..200 chars. The display name only; the
//     storage object/path is NOT moved (downloads still stream the
//     original bytes, served under the corrected name).
//   • `category` — one of the portal_uploads_category_check values
//     (kyc | rfq | message | general | other | commission).
//   • `description` — ≤ 500 chars (null clears it).
//   • Soft-deleted rows cannot be edited — restore first (POST …/restore).
//   • Tenant admins: own tenant only. Super admin: any tenant.
//
// Audited as portal_upload.edit with an old → new diff.
// ─────────────────────────────────────────────────────────────────────────────
const EDITABLE_CATEGORIES: PortalUploadCategory[] = ["kyc", "rfq", "message", "general", "other", "commission"];

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "portal-uploads.update"); if (_d) return _d;
    }

    const { id } = await params;
    const upload = auth.isSuperAdmin
      ? await findAnyUpload(id)
      : await getPortalUpload(id, auth.tenantId || "");
    if (!upload) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && upload.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (upload.deleted_at) {
      return NextResponse.json(
        { error: "This file is deleted. Restore it first, then edit." },
        { status: 409 },
      );
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const patch: { filename?: string; category?: PortalUploadCategory; description?: string | null } = {};

    if (body?.filename !== undefined) {
      const name = String(body.filename || "").trim();
      if (!name || name.length > 200) {
        return NextResponse.json({ error: "Filename must be 1–200 characters." }, { status: 400 });
      }
      patch.filename = name;
    }
    if (body?.category !== undefined) {
      const cat = String(body.category || "");
      if (!EDITABLE_CATEGORIES.includes(cat as PortalUploadCategory)) {
        return NextResponse.json(
          { error: `Invalid category. Allowed: ${EDITABLE_CATEGORIES.join(", ")}.` },
          { status: 400 },
        );
      }
      patch.category = cat as PortalUploadCategory;
    }
    if (body?.description !== undefined) {
      const desc = body.description === null ? null : String(body.description).trim();
      if (desc !== null && desc.length > 500) {
        return NextResponse.json({ error: "Description must be at most 500 characters." }, { status: 400 });
      }
      patch.description = desc;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update — provide filename, category, or description." }, { status: 400 });
    }

    const updated = await updatePortalUpload(id, upload.tenant_id, patch);
    if (!updated) return NextResponse.json({ error: "Not found." }, { status: 404 });

    await audit(auth.store, auth.user, req, "portal_upload.edit", "portal_upload", id, {
      filename: upload.filename,
      changes: patch,
      previous: {
        filename: upload.filename,
        category: upload.category,
        description: upload.description,
      },
    });
    return NextResponse.json(updated);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
