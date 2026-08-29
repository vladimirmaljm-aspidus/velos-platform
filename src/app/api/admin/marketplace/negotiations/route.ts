import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/negotiations
//
// Cross-tenant negotiations browser for the super-admin panel.
//
// The portal-facing /api/marketplace/negotiations route is partner-scoped
// (a partner only sees negotiations they're a party to); this admin variant
// returns rows from EVERY tenant so the super-admin can intervene when a
// negotiation is deadlocked / disputed / needs to be force-closed.
//
// Query params:
//   - status:    active | accepted | rejected | expired | cancelled  (default: all)
//   - tenant_id: filter to a single tenant (cross-tenant by default)
//   - limit:     page size (default 50, max 200)
//   - offset:    pagination offset
//
// Each item is hydrated with:
//   - post_title (from marketplace_posts.product_name via the post_id)
//   - partner_a_name + partner_b_name (from partners.name via the partner_id_a/b)
//
// Auth: super_admin only. `requireSuperAdmin` enforces.
//
// Response shape:
//   { items: NegotiationAdminRow[]; total: number; limit: number; offset: number }
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const offset = Number(url.searchParams.get("offset") || 0);
    const status = url.searchParams.get("status");
    const tenantId = url.searchParams.get("tenant_id");

    // FIX-AUDIT3-MED-2 #2 — explicit column list (matches the spec) so
    // we don't pull the heavy Phase-2 JSONB columns (agreed_terms,
    // awaiting_party, etc.) the admin list doesn't render.
    const NEGOTIATION_COLUMNS =
      "id, post_id, response_id, tenant_id_a, partner_id_a, " +
      "tenant_id_b, partner_id_b, status, last_message_at, " +
      "created_at, updated_at";
    let q = sb
      .from("marketplace_negotiations")
      .select(NEGOTIATION_COLUMNS, { count: "exact" })
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (status) q = q.eq("status", status);
    // Tenant filter — a negotiation belongs to TWO tenants (tenant_id_a
    // and tenant_id_b); the filter matches when EITHER side equals the
    // requested tenant. We use the PostgREST `or` filter for this.
    if (tenantId) {
      const safe = tenantId.replace(/[(),\\]/g, " ").trim();
      if (safe) {
        q = q.or(`tenant_id_a.eq.${safe},tenant_id_b.eq.${safe}`);
      }
    }

    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) throw error;

    const rows = (data as any[]) || [];

    // Batched post-title lookup — never N+1. The marketplace_posts table
    // is tenant-scoped but post_id is globally unique (UUID PK), so we
    // can fetch by id alone.
    const postIds = Array.from(new Set(rows.map((r) => r.post_id).filter(Boolean)));
    let postsById: Record<string, { product_name: string | null }> = {};
    if (postIds.length > 0) {
      const { data: postRows } = await sb
        .from("marketplace_posts")
        .select("id, product_name")
        .in("id", postIds);
      postsById = Object.fromEntries(
        ((postRows as any[]) || []).map((p) => [p.id, p]),
      );
    }

    // Batched partner-name lookup — both sides in one query.
    const partnerIds = Array.from(
      new Set(
        rows.flatMap((r) => [r.partner_id_a, r.partner_id_b].filter(Boolean)),
      ),
    );
    let partnersById: Record<string, { name: string | null; tenant_id: string | null }> = {};
    if (partnerIds.length > 0) {
      const { data: partnerRows } = await sb
        .from("partners")
        .select("id, name, tenant_id")
        .in("id", partnerIds);
      partnersById = Object.fromEntries(
        ((partnerRows as any[]) || []).map((p) => [p.id, p]),
      );
    }

    const items = rows.map((r) => {
      const post = postsById[r.post_id];
      const partnerA = partnersById[r.partner_id_a];
      const partnerB = partnersById[r.partner_id_b];
      return {
        id: r.id,
        post_id: r.post_id,
        post_title: post?.product_name ?? null,
        partner_id_a: r.partner_id_a,
        partner_id_b: r.partner_id_b,
        partner_a_name: partnerA?.name ?? null,
        partner_b_name: partnerB?.name ?? null,
        tenant_id_a: r.tenant_id_a,
        tenant_id_b: r.tenant_id_b,
        status: r.status,
        last_message_at: r.last_message_at ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    return NextResponse.json({ items, total: count ?? 0, limit, offset });
  } catch (e: any) {
    console.error("[admin.marketplace.negotiations] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/negotiations
//
// Force-close a negotiation. Used for admin intervention when a
// negotiation is deadlocked (e.g. the two parties can't agree on terms but
// neither will cancel; or the negotiation has become a vector for
// harassment and the admin needs to end it immediately).
//
// Body:
//   { negotiation_id: string,
//     action:       "disputed" | "cancelled" }
//
// Both actions set `status = "cancelled"` on the negotiation row (the DB
// has no "disputed" enum value) — the difference is preserved in the audit
// log's `action` field so admins can later distinguish "the admin marked
// this as disputed" from "the admin cancelled it" when reviewing the
// audit trail.
//
// Auth: super_admin only. Every action writes an audit_logs row.
// ─────────────────────────────────────────────────────────────────────────────
async function _put(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.negotiation_id || typeof body.negotiation_id !== "string") {
    return NextResponse.json(
      { error: "negotiation_id is required." },
      { status: 400 },
    );
  }
  const action = String(body.action || "");
  if (!["disputed", "cancelled"].includes(action)) {
    return NextResponse.json(
      { error: "action must be one of: disputed, cancelled." },
      { status: 400 },
    );
  }

  try {
    const sb = getSupabase();

    // Resolve the negotiation (cross-tenant — super-admin scope).
    // We select a small slice for the audit trail snapshot + the
    // partner-name lookup for the system message.
    const { data: neg, error: nErr } = await sb
      .from("marketplace_negotiations")
      .select(
        "id, post_id, partner_id_a, partner_id_b, tenant_id_a, tenant_id_b, status",
      )
      .eq("id", body.negotiation_id)
      .maybeSingle();
    if (nErr) throw nErr;
    if (!neg) {
      return NextResponse.json(
        { error: "Negotiation not found." },
        { status: 404 },
      );
    }
    const prevStatus = (neg as any).status as string;

    // Flip the status to "cancelled". Both `disputed` and `cancelled`
    // actions land here — the difference is captured in the audit log
    // (below) via the `action` field. Bump `last_message_at` so the
    // closed negotiation sorts to the top of the admin list (matches
    // the portal cancel route's behaviour).
    const closedAt = new Date().toISOString();
    const { data: updated, error: updErr } = await sb
      .from("marketplace_negotiations")
      .update({
        status: "cancelled",
        last_message_at: closedAt,
      })
      .eq("id", body.negotiation_id)
      .select()
      .maybeSingle();
    if (updErr) throw updErr;

    // Insert a system message into the negotiation thread so both
    // parties see the admin intervention in-line (the portal room's
    // MessageBubble renders `system` messages centered + italic). The
    // message text differs per action so the counterparty knows whether
    // the admin cancelled or marked the negotiation as disputed.
    const systemMessageText =
      action === "disputed"
        ? "Negotiation marked as disputed by an administrator and force-closed."
        : "Negotiation force-closed by an administrator.";
    try {
      await sb.from("marketplace_messages").insert({
        negotiation_id: body.negotiation_id,
        // sender_partner_id is NULL — this is an admin action, not a
        // partner message. The column is nullable per the migration.
        sender_partner_id: null,
        message: systemMessageText,
        message_type: "system",
        offer_data: null,
        attachment_url: null,
      });
    } catch (sysErr) {
      console.error(
        "[admin.marketplace.negotiations] system-insert failed:",
        sysErr,
      );
    }

    // Audit-log the force-close. `action` distinguishes "disputed" from
    // "cancelled" in the audit trail — both flip the row to status=
    // "cancelled" but the admin's intent is preserved here.
    const auditAction =
      action === "disputed"
        ? "marketplace.negotiation_disputed"
        : "marketplace.negotiation_force_closed";
    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        auditAction,
        "marketplace_negotiation",
        body.negotiation_id,
        {
          negotiation_id: body.negotiation_id,
          post_id: (neg as any).post_id,
          partner_id_a: (neg as any).partner_id_a,
          partner_id_b: (neg as any).partner_id_b,
          previous_status: prevStatus,
          action,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.negotiations] audit failed:", e);
    }

    return NextResponse.json({ ok: true, negotiation: updated });
  } catch (e: any) {
    console.error("[admin.marketplace.negotiations] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/negotiations");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/negotiations");
