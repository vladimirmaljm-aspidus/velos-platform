import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (mail-queue.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_mail_queue)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_mail_queue", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const result = await auth.store.listMailQueue(tid, { search, filters: { status } });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[mail-queue GET]", e);
    return NextResponse.json(
      { error: e.message || "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (mail-queue.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.create"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_mail_queue)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_mail_queue", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    body.tenant_id = tid;
    const created = await auth.store.upsertMailQueueEntry(body);
    await audit(auth.store, auth.user, req, body.id ? "mail.update" : "mail.queue", "mail_queue", created.id, { subject: created.subject });
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[mail-queue POST]", e);
    return NextResponse.json(
      { error: e.message || "Internal server error" },
      { status: 500 },
    );
  }
}
