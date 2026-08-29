import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { requireKycApproved } from "@/lib/portal/kyc-gate";
import { requireGpsVerified } from "@/lib/portal/require-gps";
import { getSupabase } from "@/lib/supabase/client";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";
import { nextDocNumber, formatDocNumber } from "@/lib/api/doc-number";

export const runtime = "nodejs";

/**
 * GET  /api/portal/logistics       → list requests submitted by this partner
 * POST /api/portal/logistics       → create a new logistics request
 */

/**
 * PORTAL-L8 — Atomic logistics-number generation.
 *
 * The previous implementation read `count + 1` from the database, which is
 * the classic non-atomic read-then-write pattern: two concurrent portal
 * clients could each read the same count, produce the same `LOG-<year>-N`,
 * and either collide on a unique constraint or persist a duplicate number.
 *
 * The fix is to use the canonical `nextDocNumber("logistics")` helper,
 * which RPCs into the Postgres `get_next_doc_number('logistics')` function
 * backed by a SEQUENCE (migration 061). `nextval()` is atomic at the DB
 * level — concurrent callers always get distinct values.
 *
 * The helper returns null when:
 *   • Supabase isn't configured (local dev / MockStore), or
 *   • The migration hasn't been applied yet (RPC raises "Unknown doc_type"),
 *   • The RPC errors for any other reason.
 *
 * In all those cases we fall back to the legacy `count + 1` pattern so the
 * INSERT still gets a number. The legacy path remains race-prone, but only
 * in environments where the atomic path is unavailable — production (which
 * has Supabase configured and migrations applied) gets the atomic guarantee.
 */
async function nextNumber(tenantId: string): Promise<string> {
  // 1. Atomic path: Postgres SEQUENCE via RPC.
  const atomic = await nextDocNumber("logistics");
  if (atomic) return atomic;

  // 2. Legacy fallback: count + 1 (race-prone, but only used when the
  //    atomic path is unavailable). Preserved verbatim from the previous
  //    implementation so the visible number format is unchanged for
  //    existing dev/CI tenants.
  const year = new Date().getFullYear();
  const sb = getSupabase();
  const { count } = await sb
    .from("logistics_requests")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("created_at", `${year}-01-01`);
  return formatDocNumber("logistics", year, (count || 0) + 1);
}

export async function GET() {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const kyc = await requireKycApproved(access);
  if (kyc) return kyc;

  // CRITICAL FIX (audit P0-5): GPS gate must also apply to logistics LIST —
  // and previously only the offers/invoices/proformas LIST endpoints enforced
  // it, while logistics skipped the check entirely.
  const _gpsGet = await requireGpsVerified(access);
  if (_gpsGet) return _gpsGet;

  const sb = getSupabase();
  const { data, error } = await sb
    .from("logistics_requests")
    .select("*")
    .eq("tenant_id", access.tenant_id)
    .eq("partner_id", access.partner_id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data || [] });
}

export async function POST(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const kyc = await requireKycApproved(access);
  if (kyc) return kyc;

  // CRITICAL FIX (audit P0-5): GPS gate must also apply to logistics CREATE —
  // otherwise a portal client could submit a new logistics request without
  // sharing their location, bypassing the client-side gate.
  const _gpsPost = await requireGpsVerified(access);
  if (_gpsPost) return _gpsPost;

  if (!access.partner_id) {
    return NextResponse.json({ error: "Portal account is not linked to a partner. Ask your admin to link it before submitting a request." }, { status: 400 });
  }

  const store = await getStore();

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Server-imposed fields — never trust the client on tenant/partner/status/number
  const insert = {
    tenant_id: access.tenant_id,
    partner_id: access.partner_id,
    portal_access_id: access.id,
    number: await nextNumber(access.tenant_id),
    status: "pending",
    mode: body.mode,
    container_type: body.container_type || null,
    incoterm: body.incoterm || null,
    target_pickup_date: body.target_pickup_date || null,
    target_delivery_date: body.target_delivery_date || null,
    urgency: body.urgency || "normal",
    // origin
    origin_company: body.origin_company || null,
    origin_contact_name: body.origin_contact_name || null,
    origin_contact_phone: body.origin_contact_phone || null,
    origin_contact_email: body.origin_contact_email || null,
    origin_country: body.origin_country || null,
    origin_state: body.origin_state || null,
    origin_city: body.origin_city || null,
    origin_postal_code: body.origin_postal_code || null,
    origin_address_line: body.origin_address_line || null,
    origin_port: body.origin_port || null,
    // destination
    destination_company: body.destination_company || null,
    destination_contact_name: body.destination_contact_name || null,
    destination_contact_phone: body.destination_contact_phone || null,
    destination_contact_email: body.destination_contact_email || null,
    destination_country: body.destination_country || null,
    destination_state: body.destination_state || null,
    destination_city: body.destination_city || null,
    destination_postal_code: body.destination_postal_code || null,
    destination_address_line: body.destination_address_line || null,
    destination_port: body.destination_port || null,
    // cargo
    total_weight_kg: body.total_weight_kg ?? null,
    total_volume_cbm: body.total_volume_cbm ?? null,
    total_packages: body.total_packages ?? null,
    cargo_description: body.cargo_description || null,
    hs_codes: body.hs_codes || null,
    is_hazardous: !!body.is_hazardous,
    is_temperature_controlled: !!body.is_temperature_controlled,
    temperature_range: body.temperature_range || null,
    insurance_required: !!body.insurance_required,
    cargo_value: body.cargo_value ?? null,
    cargo_currency: body.cargo_currency || "USD",
    special_instructions: body.special_instructions || null,
    packing_list: Array.isArray(body.packing_list) ? body.packing_list : [],
  };
  if (!insert.mode) return NextResponse.json({ error: "Transport mode is required." }, { status: 400 });

  const sb = getSupabase();
  const { data, error } = await sb.from("logistics_requests").insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Timeline event: created by the client
  try {
    const { logLogisticsEvent } = await import("@/lib/logistics/events");
    await logLogisticsEvent({
      tenant_id: access.tenant_id,
      logistics_request_id: (data as any).id,
      event_type: "created",
      to_status: "pending",
      actor_id: access.id,
      actor_role: "client",
      message: `New ${insert.mode} request ${insert.number}`,
      metadata: { number: insert.number, mode: insert.mode },
    });
  } catch { /* non-critical */ }

  // Audit the portal logistics request creation
  try {
    await audit(
      store,
      { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
      req,
      "portal.logistics_request_created",
      "logistics_request",
      (data as any)?.id,
      {
        number: insert.number,
        mode: insert.mode,
        origin_country: insert.origin_country,
        destination_country: insert.destination_country,
      },
    );
  } catch (e) { console.error("[audit]", e); }

  // Notify tenant admins in-app
  try {
    const partner = await store.getPartner(access.partner_id);
    await store.createNotification({
      tenant_id: access.tenant_id,
      user_id: null,
      partner_id: access.partner_id,
      type: "rfq_received" as any,
      title: `New logistics request from ${partner?.name || access.portal_email}`,
      message: `${insert.number} · ${insert.mode.toUpperCase()} · ${insert.origin_country || "?"} → ${insert.destination_country || "?"}`,
      entity_type: "logistics_request",
      entity_id: (data as any).id,
      action_url: `/logistics?open=${(data as any).id}`,
      action_label: "Open request",
    } as any);
  } catch (e) { console.warn("[portal.logistics.POST notify]", e); }

  return NextResponse.json(data);
}
