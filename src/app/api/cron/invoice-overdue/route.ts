import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit } from "@/lib/api/helpers";
import { emailInvoiceOverdue } from "@/lib/notif/helper";

export const runtime = "nodejs";

/**
 * Cron endpoint — daily sweep that marks invoices as overdue when their
 * due_date has passed. Idempotent; safe to run daily.
 *
 * Authentication: caller must supply an `Authorization: Bearer <CRON_TOKEN>`
 * header matching the CRON_TOKEN env var (preferred — F-8 security fix),
 * OR `?token=…` URL query (legacy, kept for backward compatibility), OR a
 * valid super_admin session (for manual runs from the browser).
 *
 * P2 / task C-6 Fix 4: each successful run appends a `cron.invoice_overdue`
 * audit log entry so ops can verify the cron is firing and how many invoices
 * it touched. Uses a system-level user (`id="system"`, `username="cron"`,
 * `tenant_id=null`); the per-tenant breakdown is captured in `details`.
 */
export async function GET(req: NextRequest) {
  try {
    // Auth: shared cron token (header preferred, URL query legacy) OR a
    // super_admin session cookie (for manual runs from the browser).
    // P1 timing-attack fix (task C-5 Fix 1): token comparison is now
    // constant-time via `crypto.timingSafeEqual` — see `authorizeCron`.
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    const sb = getSupabase();
    const today = new Date().toISOString().split("T")[0];
    // Mark sent/viewed invoices as overdue when due_date < today.
    // FIX-NOTIF-A11Y: also select `due_date` so we can compute days
    // overdue for the email body.
    const { data, error } = await sb
      .from("invoices")
      .update({ status: "overdue" })
      .in("status", ["sent", "viewed"])
      .lt("due_date", today)
      .select("id, number, partner_id, tenant_id, due_date");
    if (error) throw error;
    const updated = (data as Array<{ id: string; number: string; partner_id: string | null; tenant_id: string; due_date: string | null }>) || [];
    // Fire notifications for each overdue invoice. Errors here are non-fatal
    // — the status update is the source of truth.
    const store = await getStore();
    for (const inv of updated) {
      try {
        const { notify } = await import("@/lib/notif/helper");
        await notify({
          tenantId: inv.tenant_id,
          userId: null,
          type: "invoice_overdue",
          title: `Invoice ${inv.number} is overdue`,
          message: `Invoice ${inv.number} has passed its due date.`,
          entityType: "invoice",
          entityId: inv.id,
        });
        // FIX-NOTIF-A11Y: also email the tenant admins so finance
        // teams learn about overdue invoices without logging in.
        // Fire-and-forget — failures are caught inside
        // emailInvoiceOverdue. The in-app notification above is the
        // source of truth; the email is a bonus delivery path. We
        // look up the partner name for context (best-effort) and
        // compute days overdue from the due_date.
        try {
          let partnerName: string | null = null;
          if (inv.partner_id) {
            const p = await store.getPartner(inv.partner_id);
            partnerName = p?.name || null;
          }
          const daysOverdue = inv.due_date
            ? Math.max(1, Math.round((Date.now() - new Date(inv.due_date).getTime()) / (24 * 60 * 60 * 1000)))
            : 1;
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_BASE_URL;
          void emailInvoiceOverdue({
            tenantId: inv.tenant_id,
            partnerName,
            invoiceNumber: inv.number,
            daysOverdue,
            baseUrl,
          }).catch((e) =>
            console.error("[cron/invoice-overdue] email failed", inv.id, e),
          );
        } catch (e) {
          console.error("[cron/invoice-overdue] email lookup failed", inv.id, e);
        }
      } catch {
        /* non-fatal */
      }
    }

    // P2 / task C-6 Fix 4: audit-log the sweep outcome. Group updated
    // invoices by tenant so the audit trail shows per-tenant impact
    // (a single cron run can touch multiple tenants).
    const byTenant = new Map<string, string[]>();
    for (const inv of updated) {
      const arr = byTenant.get(inv.tenant_id) || [];
      arr.push(inv.id);
      byTenant.set(inv.tenant_id, arr);
    }
    await audit(
      store,
      { id: undefined, username: "cron", tenant_id: null },
      req,
      "cron.invoice_overdue",
      "system",
      "cron",
      {
        updated: updated.length,
        by_tenant: Object.fromEntries(byTenant),
        invoice_ids: updated.map((i) => i.id),
      },
    );

    return NextResponse.json({ ok: true, updated: updated.length });
  } catch (e: any) {
    console.error("[cron/invoice-overdue]", e);
    return NextResponse.json({ error: e?.message || "Failed" }, { status: 500 });
  }
}
