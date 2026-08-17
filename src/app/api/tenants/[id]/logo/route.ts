import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { uploadFile } from "@/lib/upload/service";
import { verifyLogoUpload } from "@/lib/upload/verify-file";
import { MAX_LOGO_UPLOAD_SIZE, LOGO_ALLOWED_MIME_TYPES } from "@/lib/upload/constants";

export const runtime = "nodejs";

// Upload tenant logo — stored in Supabase Storage (or mock path in dev)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Super-admin can upload any tenant's logo; tenant admin can upload their own.
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "settings.update"); if (_d) return _d; } /* requirePermission wired */
    const { id } = await params;
    // Tenant ownership check: a tenant admin can only upload a logo for their own tenant.
    // Super_admin can upload for any tenant.
    if (!auth.isSuperAdmin && id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("logo") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No logo file provided." }, { status: 400 });
    }

    // Validate — size + MIME limits come from the shared `@/lib/upload/constants`
    // module (audit P2-2 / task C-7) so they stay in sync with `uploadFile()`.
    if (file.size > MAX_LOGO_UPLOAD_SIZE) {
      return NextResponse.json({ error: "Logo too large. Max 2MB." }, { status: 400 });
    }
    const allowedTypes = LOGO_ALLOWED_MIME_TYPES;
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: "Invalid type. Allowed: PNG, JPEG, WebP." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Verify actual content via magic bytes (SVG banned — stored XSS risk via <script> tags)
    const verification = verifyLogoUpload(buffer, file.type);
    if (!verification.isValid) {
      return NextResponse.json({ error: verification.error }, { status: 400 });
    }
    // Derive extension from verified MIME type, not client filename.
    // Audit fix P2-16: prevents logo.aspx / invoice.htm path pollution.
    const MIME_TO_EXT: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    };
    const ext = MIME_TO_EXT[file.type] || "png";
    const path = `${id}/logo.${ext}`;

    const result = await uploadFile("tenant-logos", path, buffer, file.type, file.size);

    // Update tenant with logo URL
    const tenant = await auth.store.getTenant(id);
    if (tenant) {
      await auth.store.upsertTenant({ ...tenant, logo_url: result.url || result.path });
    }

    await audit(auth.store, auth.user, req, "tenant.logo_upload", "tenant", id, {});

    return NextResponse.json({ url: result.url || result.path });
  } catch (error: any) {
    console.error("[tenants logo POST]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
