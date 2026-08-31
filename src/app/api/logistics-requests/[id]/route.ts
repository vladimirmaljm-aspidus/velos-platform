import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { isValidEmail } from "@/lib/validation/email";

export const runtime = "nodejs";

/**
 * GET    /api/logistics/[id]  → single request
 * PATCH  /api/logistics/[id]  → admin updates status / quote / notes
 * DELETE /api/logistics/[id]  → admin removes (only if cancelled)
 */

async function loadOwned(id: string, auth: any) {
  const sb = getSupabase();
  const { data } = await sb.from("logistics_requests").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  if (!auth.isSuperAdmin && data.tenant_id !== auth.tenantId) return null;
  return data;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(_req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "logistics.read"); if (_d) return _d; }

    const { id } = await params;
    const row = await loadOwned(id, auth);
    if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(row);
  } catch (e: any) {
    console.error("[logistics-requests.GET]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "logistics.update"); if (_d) return _d; }

    const { id } = await params;
    const row = await loadOwned(id, auth);
    if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Status transition guard (H-2) — block illegal status jumps on
    // logistics requests. Super-admins bypass so they can correct bad data.
    const allowedTransitions: Record<string, string[]> = {
      pending: ["quoted", "in_progress", "cancelled"],
      quoted: ["in_progress", "cancelled"],
      in_progress: ["delivered", "cancelled"],
      delivered: [],  // terminal
      cancelled: [],  // terminal
    };
    const newStatus = body.status;
    if (newStatus && newStatus !== row.status && !auth.isSuperAdmin) {
      const err = validateStatusTransition("logistics_request", row.status, newStatus, allowedTransitions);
      if (err) return NextResponse.json({ error: err }, { status: 409 });
    }

    const allow = [
      "status", "quoted_price", "quoted_currency", "quoted_transit_days",
      "quoted_notes", "linked_offer_id", "admin_notes",
      "target_pickup_date", "target_delivery_date",
      // Tracking / carrier fields — filled in as the shipment progresses
      "tracking_number", "tracking_url", "carrier", "carrier_reference",
    ];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allow) if (body[k] !== undefined) patch[k] = body[k];

    // Auto-set milestone timestamps based on status transition — so the
    // timeline / dashboard can show 'quoted 3 days ago', 'shipped Tuesday',
    // without every UI having to compute it from events.
    if (typeof patch.status === "string" && patch.status !== row.status) {
      const now = new Date().toISOString();
      if (patch.status === "quoted" && !row.quoted_at) patch.quoted_at = now;
      if (patch.status === "accepted" && !row.accepted_at) patch.accepted_at = now;
      if (patch.status === "in_progress" && !row.shipped_at) patch.shipped_at = now;
      if (patch.status === "completed" && !row.delivered_at) patch.delivered_at = now;
    }

    const sb = getSupabase();
    const { data, error } = await sb.from("logistics_requests").update(patch).eq("id", id).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await audit(auth.store, auth.user, req, "logistics.update", "logistics_request", id, { fields: Object.keys(patch) });

    // Notify the client if the quote just became available or status meaningfully changed
    const becameQuoted = row.status !== "quoted" && data.status === "quoted";
    const statusChanged = row.status !== data.status;

    // Timeline event for any status change or quote assignment
    try {
      const { logLogisticsEvent } = await import("@/lib/logistics/events");
      if (statusChanged) {
        await logLogisticsEvent({
          tenant_id: data.tenant_id,
          logistics_request_id: id,
          event_type: becameQuoted ? "quoted" : (data.status as any),
          from_status: row.status,
          to_status: data.status,
          actor_id: auth.user.id,
          actor_role: "admin",
          message: becameQuoted && data.quoted_price != null
            ? `Quoted ${data.quoted_currency || ""} ${data.quoted_price} · ${data.quoted_transit_days || "?"} days`
            : `Status changed to ${data.status}`,
          metadata: becameQuoted ? { price: data.quoted_price, currency: data.quoted_currency, transit_days: data.quoted_transit_days } : {},
        });
      } else if (patch.quoted_notes || patch.admin_notes) {
        await logLogisticsEvent({
          tenant_id: data.tenant_id,
          logistics_request_id: id,
          event_type: "note",
          actor_id: auth.user.id,
          actor_role: "admin",
          message: (patch.quoted_notes as string) || null,
        });
      }
    } catch { /* non-critical */ }
    if (becameQuoted || statusChanged) {
      try {
        const { getStore } = await import("@/lib/data/store");
        const store = await getStore();
        const partner = await store.getPartner(data.partner_id);
        await store.createNotification({
          tenant_id: data.tenant_id,
          user_id: null,
          partner_id: data.partner_id,
          type: (becameQuoted ? "logistics_quoted" : "logistics_status") as any,
          title: becameQuoted
            ? `Freight quote available for ${data.number}`
            : `Freight request ${data.number} · ${data.status}`,
          message: becameQuoted && data.quoted_price != null
            ? `${data.quoted_currency || ""} ${data.quoted_price} · ${data.quoted_transit_days || "?"} days`
            : `Status updated to ${data.status}`,
          entity_type: "logistics_request",
          entity_id: id,
          action_url: `/portal/logistics`,
          action_label: "Open request",
        } as any);

        // Email the client when a quote becomes available. Best-effort — a
        // mail server hiccup must not block the PATCH from succeeding.
        if (becameQuoted && data.quoted_price != null) {
          try {
            const partner = await store.getPartner(data.partner_id);
            // AUDIT16 — `partner.email` is the legacy plaintext column and
            // is often empty; `contact_email` is encrypted at rest (P0-3).
            // Previously only partner?.email was used, so partners whose
            // only address is the encrypted contact_email silently got NO
            // quote email (the audit15/16 encrypted-To bug class). Decrypt
            // and guard it the same way.
            const { decryptField, isEncrypted } = await import("@/lib/crypto/field-encryption");
            const rawEmail = partner?.email || decryptField(partner?.contact_email || "");
            const partnerEmail =
              rawEmail && !isEncrypted(rawEmail) && isValidEmail(rawEmail) ? rawEmail : "";
            if (partner && partnerEmail) {
              const tenant = await store.getTenant(data.tenant_id);
              // AUDIT16 — drop the stale hardcoded aspidus.onrender.com
              // fallback (SEC-L6 sandbox artifact; every other route was
              // scrubbed of it). No configured APP_BASE_URL → link to the
              // login page path only, which still works via redirect.
              const baseUrl = process.env.APP_BASE_URL || "";
              const { logisticsQuoteReadyEmail, sendEmail } = await import("@/lib/email/service");
              const route = `${data.origin_city || data.origin_country || "?"} → ${data.destination_city || data.destination_country || "?"}`;
              const { subject, html } = logisticsQuoteReadyEmail({
                partnerName: partner.name || "Client",
                requestNumber: data.number,
                route,
                mode: data.mode,
                price: data.quoted_price,
                currency: data.quoted_currency || "USD",
                transitDays: data.quoted_transit_days ?? "—",
                notes: data.quoted_notes || null,
                tenantName: tenant?.name || "VELOS",
                portalUrl: `${baseUrl}/portal/logistics`,
              });
              await sendEmail({ to: partnerEmail, subject, html, tenantId: data.tenant_id });
            }
          } catch (e) { console.warn("[logistics.PATCH email]", e); }
        }
      } catch (e) { console.warn("[logistics.PATCH notify]", e); }
    }
    return NextResponse.json(data);
  } catch (e: any) {
    console.error("[logistics-requests.PATCH]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "logistics.delete"); if (_d) return _d; }

    const { id } = await params;
    const row = await loadOwned(id, auth);
    if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Status guard (H-6) — only draft/cancelled logistics requests can be
    // hard-deleted. Pending/quoted/in_progress/delivered rows carry an
    // audit trail (and a "draft" status isn't currently used by this
    // entity, so the practical effect is: only "cancelled" deletable).
    if (row.status && !["draft", "cancelled"].includes(row.status)) {
      return NextResponse.json(
        { error: `Cannot delete a record in status '${row.status}'.` },
        { status: 409 },
      );
    }

    const sb = getSupabase();
    const { error: deleteError } = await sb.from("logistics_requests").delete().eq("id", id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    await audit(auth.store, auth.user, req, "logistics.delete", "logistics_request", id, { number: row.number });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[logistics-requests.DELETE]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
