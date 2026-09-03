import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import type { MailQueueEntry } from "@/lib/supabase/types";
import { resolveQueueToAddress } from "@/lib/email/service";
// 31-f — shared request-body validation helpers (audit 30-b BUG-2: a
// mail-queue POST missing to/subject — or with a non-string subject —
// surfaced the DB NOT NULL / 22P02 error as a 500 "Missing required
// field."; now a clean 400 before the DB write).
import { requireFields, assertNumeric } from "@/lib/api/validate";

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
      // AUDIT17 / P3: decrypt to_email for display — legacy rows wrote the
      // address before per-tenant encryption-at-rest landed and some carry
      // `enc:` ciphertext; rendering it in the admin UI is the ciphertext-
      // in-UI bug class. resolveQueueToAddress is a decrypt-no-op on
      // plaintext and refuses undecryptable values (kept as-is so the
      // operator can see the row is broken and mark it failed).
      const items = ((data as MailQueueEntry[]) || []).map((row) => ({
        ...row,
        to_email: resolveQueueToAddress(row.to_email || "").to,
      }));
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
    // AUDIT17 / P3: same to_email decrypt-for-display as the cross-tenant
    // path above.
    if (result?.items) {
      result.items = result.items.map((row: MailQueueEntry) => ({
        ...row,
        to_email: resolveQueueToAddress(row.to_email || "").to,
      }));
    }
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[mail-queue GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) || "Internal server error" },
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
    // 31-f — required-field + type validation BEFORE the upsert (audit
    // 30-b BUG-2: {subject: 12345} or a missing recipient hit the
    // mail_queue NOT NULL / text-column cast and returned 500). to_email /
    // subject / body are text NOT NULL columns with no defaults, so a
    // create needs all three — and a JSON number in a text column is a
    // PostgREST 22P02, so enforce the string type up front (mirrors the
    // offers route's `typeof body.subject !== "string"` guard).
    if (!body.id) {
      const bad = requireFields(body, ["to_email", "subject", "body"]);
      if (bad) return bad;
      if (typeof body.to_email !== "string" || typeof body.subject !== "string") {
        return NextResponse.json(
          { error: "Fields 'to_email' and 'subject' must be strings." },
          { status: 400 },
        );
      }
    }
    // attempts / retry counters are integer columns — reject junk strings
    // with a 400 instead of letting PostgREST 22P02 bubble up as a 500.
    {
      const bad = assertNumeric(body, ["attempts"]);
      if (bad) return bad;
    }
    body.tenant_id = tid;
    const created = await auth.store.upsertMailQueueEntry(body);
    await audit(auth.store, auth.user, req, body.id ? "mail.update" : "mail.queue", "mail_queue", created.id, { subject: created.subject });
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[mail-queue POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e) || "Internal server error" },
      { status: 500 },
    );
  }
}
