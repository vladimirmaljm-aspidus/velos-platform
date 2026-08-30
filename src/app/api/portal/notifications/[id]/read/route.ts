import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * PUT /api/portal/notifications/[id]/read
 *
 * Mark a single notification as read for the logged-in portal partner.
 *
 * 2b2-F2 (related) — previously this route called
 * `listNotificationsByPartner` (unbounded SELECT * for the partner)
 * and then `.find(id)` to verify the notification belonged to the
 * caller. That scan was unnecessary defense-in-depth: the UPDATE itself
 * is scoped by `(id, tenant_id)` in `markNotificationRead`. The fetch
 * is replaced by a single-row existence check that:
 *   • SELECTs only the `id` column (1 row, 1 column — minimal wire cost).
 *   • Filters by `id` + `tenant_id` + `partner_id` + portal-safe-type
 *     whitelist (matches the list query's filter so a notification
 *     the partner couldn't see in the list is also not markable here).
 *   • Uses `.maybeSingle()` (returns null when no row matches).
 *
 * The `markNotificationRead` UPDATE still passes the caller's
 * `tenant_id` (defense-in-depth: the existence check is the only thing
 * the route needs — the UPDATE's tenant scope catches any race where
 * a row was reassigned to another tenant between the SELECT and UPDATE).
 *
 * 2b2-F2 — see worklog Task 2-b (round 2).
 */
const PORTAL_SAFE_TYPES = [
  "kyc_submitted", "kyc_approved", "kyc_rejected",
  "rfq_received", "rfq_quoted",
  "offer_sent", "offer_accepted", "offer_rejected", "offer_expired",
  "invoice_sent", "invoice_overdue", "invoice_paid",
  "proforma_sent",
  "document_shared",
  "portal_access_requested", "portal_access_approved", "portal_invite_sent",
  "portal_message",
  "marketplace_response_received",
  "marketplace_response_accepted",
  "marketplace_response_rejected",
  "marketplace_message_received",
];

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await getPortalSessionAccess();
    if (!access) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const { id } = await params;
    const store = await getStore();

    // Single-row existence check (replaces the full list fetch).
    // `.eq("id", id)` + `.eq("tenant_id", …)` + `.eq("partner_id", …)` +
    // `.in("type", PORTAL_SAFE_TYPES)` — exactly the same scope the
    // list query uses, but limited to one row by id.
    const sb = getSupabase();
    const { data: exists, error: existsErr } = await sb
      .from("notifications")
      .select("id")
      .eq("id", id)
      .eq("tenant_id", access.tenant_id)
      .eq("partner_id", access.partner_id)
      .in("type", PORTAL_SAFE_TYPES)
      .maybeSingle();
    if (existsErr) {
      console.error("[portal.notifications.read] existence-check failed:", existsErr.message);
      return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
    }
    if (!exists) {
      return NextResponse.json({ error: "Notification not found." }, { status: 404 });
    }

    // CRITICAL FIX (audit A3): pass tenant_id to scope the UPDATE —
    // preserved from the previous implementation. The existence check
    // above already verified ownership, but the UPDATE's tenant filter
    // is defense-in-depth against any race between the SELECT and the
    // UPDATE.
    await store.markNotificationRead(id, access.tenant_id);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("[portal.notifications.read]", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
