import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (mail-queue.delete)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.delete"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_mail_queue)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_mail_queue", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const { id } = await params;
  // Use a direct fetch by ID — works for both regular users (tenant-scoped
  // at the policy level) and super_admin (no scope). (Audit finding H-9.)
  const { data: existing, error } = await (auth.store as any)
    .sb()
    .from("mail_queue")
    .select("id, tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Tenant ownership check for non-super-admins.
  if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await auth.store.deleteMailQueueEntry(id);
  await audit(auth.store, auth.user, req, "mail.delete", "mail_queue", id);
  return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
