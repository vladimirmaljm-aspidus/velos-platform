import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { listPortalUploads } from "@/lib/portal/uploads";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(_req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (kyc.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "kyc.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_kyc)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_kyc", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  const sub = await auth.store.getKycSubmission(id);
  if (!sub) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && sub.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Attach uploaded KYC documents (portal_uploads with category=kyc + submission link)
  const { items: uploads } = await listPortalUploads(sub.tenant_id, {
    partnerId: sub.partner_id,
    category: "kyc",
    limit: 500,
  });
  const documents = uploads
    .filter((u: any) => u.kyc_submission_id === sub.id)
    .map((u: any) => ({
      id: u.id,
      type: u.doc_type,
      filename: u.filename,
      mime_type: u.mime_type,
      size: u.size_bytes,
      uploaded_at: u.uploaded_at,
      // URL the admin UI can call to open the file in a new tab
      url: `/api/portal-uploads/${u.id}/download?mode=inline`,
    }));
  return NextResponse.json({ ...sub, documents });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (kyc.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "kyc.update"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_kyc)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_kyc", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  // Tenant ownership check
  const existing = await auth.store.getKycSubmission(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const updated = await auth.store.upsertKycSubmission({ ...body, id, tenant_id: existing.tenant_id });
  await audit(auth.store, auth.user, req, "kyc.update", "kyc_submission", id, { status: updated.status });
  return NextResponse.json(updated);
}
