import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import type { MailQueueEntry } from "@/lib/supabase/types";

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

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;

    // ── Cross-tenant listing for super-admin ─────────────────────────────
    // The Mail Queue banner advertises "cross-tenant delivery
    // observability" but `listMailQueue(tid, …)` filters by tenant_id —
    // so a super_admin with no tenant context (no ?tenant_id=xxx and
    // no active tenant in their session) was getting 400 + zero entries.
    // The platform owner is the ONLY caller who needs a system-wide view
    // (tenant admins are scoped to their own tenant by `resolveTenantId`
    // below). When super_admin + no tenant context, list ALL mail queue
    // entries across ALL tenants — no tenant_id filter, just the search
    // + status filters the operator chose. Tenant admins always take the
    // existing tenant-scoped path (resolveTenantId returns their own
    // tenant_id, never null for non-super-admin callers).
    const tid = resolveTenantId(auth, req);
    if (auth.isSuperAdmin && !tid) {
      // Build the cross-tenant query directly on the service-role client
      // (same pattern as /api/vault/[id]/route.ts — `listMailQueue(tid)`
      // always adds `.eq("tenant_id", tid)` which would return zero rows
      // for `tid=""`). Service-role bypass is the platform-level escape
      // hatch; tenant isolation for non-super-admin callers is preserved
      // by `requireAuth` + the `resolveTenantId` non-super-admin branch.
      let q = (auth.store as any).sb().from("mail_queue").select("*", { count: "exact" as const });
      if (search) {
        // HACK-SIM Fix 2 (MEDIUM): sanitize the search string before passing
        // it to `.or()` to prevent PostgREST filter-expression injection.
        // Commas separate OR clauses, parens group them, backslashes escape
        // — an attacker (or even a curious super_admin) could inject
        // `id.eq.<x>` or `tenant_id.eq.<y>` to bypass intended filters.
        // Mirror the sanitization pattern used in logistics-requests/route.ts
        // and admin/marketplace/posts/route.ts.
        const s = search.replace(/[(),\\]/g, " ").trim();
        if (s) {
          q = q.or(`subject.ilike.%${s}%,to_email.ilike.%${s}%`);
        }
      }
      if (status) q = q.eq("status", status);
      q = q.order("created_at", { ascending: false });
      const { data, count, error } = await q;
      if (error) throw error;
      const items = (data as MailQueueEntry[]) || [];
      try {
        await audit(auth.store, auth.user, req, "mail.read", "mail_queue", undefined, {
          cross_tenant: true,
          count: items.length,
        });
      } catch (e) {
        console.error("[mail-queue GET cross-tenant audit]", e);
      }
      return NextResponse.json({ items, total: count ?? items.length });
    }

    if (!tid) return NextResponse.json({ error: "No tenant context." }, { status: 400 });
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
