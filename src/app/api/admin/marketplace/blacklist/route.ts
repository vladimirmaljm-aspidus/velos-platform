import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/blacklist
//
// Returns all active blacklist entries. Hydrates the partner_name /
// country / tenant_id from the partners table.
//
// Query params:
//   - include_inactive: "true" → also return rows with active=false
//                       omitted → only active=true
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const url = new URL(req.url);
    const includeInactive = url.searchParams.get("include_inactive") === "true";

    let q = sb
      .from("marketplace_blacklist")
      .select("*")
      .order("created_at", { ascending: false });
    if (!includeInactive) q = q.eq("active", true);

    const { data, error } = await q.limit(500);
    if (error) throw error;

    const rows = (data as any[]) || [];
    const partnerIds = Array.from(new Set(rows.map((r) => r.partner_id).filter(Boolean)));
    let partnersById: Record<string, { name: string; country: string | null; tenant_id: string | null; email: string | null }> = {};
    if (partnerIds.length > 0) {
      const { data: partnerRows } = await sb
        .from("partners")
        .select("id, name, country, tenant_id, email")
        .in("id", partnerIds);
      partnersById = Object.fromEntries(((partnerRows as any[]) || []).map((p) => [p.id, p]));
    }

    const items = rows.map((r) => ({
      ...r,
      company_name: partnersById[r.partner_id]?.name ?? r.partner_name ?? null,
      company_country: partnersById[r.partner_id]?.country ?? null,
      company_email: partnersById[r.partner_id]?.email ?? null,
      company_tenant_id: partnersById[r.partner_id]?.tenant_id ?? null,
    }));

    return NextResponse.json({ items, total: items.length });
  } catch (e: any) {
    console.error("[admin.marketplace.blacklist] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/marketplace/blacklist
//
// Add a company (partner) to the blacklist. Idempotent: if a row already
// exists for the partner_id, it's reactivated (active=true) and the
// reason / blocked_by fields are updated.
//
// Body:
//   { partner_id: string, reason?: string }
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _post(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.partner_id || typeof body.partner_id !== "string") {
    return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
  }

  try {
    const sb = getSupabase();

    // Resolve the partner (cross-tenant).
    const { data: partner, error: pErr } = await sb
      .from("partners")
      .select("id, tenant_id, name")
      .eq("id", body.partner_id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!partner) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }

    const payload = {
      partner_id: body.partner_id,
      partner_name: (partner as any).name,
      reason: body.reason || null,
      blocked_by: auth.user.username,
      active: true,
    };

    // Upsert on partner_id (UNIQUE) so re-adding a previously-removed
    // partner reactivates the row instead of erroring on a duplicate.
    const { data: row, error } = await sb
      .from("marketplace_blacklist")
      .upsert(payload, { onConflict: "partner_id" })
      .select()
      .single();
    if (error) throw error;

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: (partner as any).tenant_id },
        req,
        "marketplace.blacklist_added",
        "marketplace_blacklist",
        body.partner_id,
        {
          partner_id: body.partner_id,
          partner_name: (partner as any).name,
          reason: body.reason || null,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.blacklist] audit failed:", e);
    }

    return NextResponse.json({ entry: row });
  } catch (e: any) {
    console.error("[admin.marketplace.blacklist] POST failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/marketplace/blacklist?id=<entry_id>
//
// Remove a partner from the blacklist. Sets active=false (audit trail kept)
// rather than physically deleting the row, so a re-add later still knows the
// previous reason + admin.
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _del(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const entryId = url.searchParams.get("id");
  if (!entryId) {
    return NextResponse.json({ error: "id query param is required." }, { status: 400 });
  }

  try {
    const sb = getSupabase();

    // Fetch the row first so we know which partner this is for the audit.
    const { data: entry, error: fErr } = await sb
      .from("marketplace_blacklist")
      .select("id, partner_id, partner_name, reason, blocked_by, active")
      .eq("id", entryId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!entry) {
      return NextResponse.json({ error: "Blacklist entry not found." }, { status: 404 });
    }

    // Soft-delete: flip active to false. The row stays so re-adding the
    // same partner later is an idempotent reactivation (see POST above).
    const { error: updErr } = await sb
      .from("marketplace_blacklist")
      .update({ active: false })
      .eq("id", entryId);
    if (updErr) throw updErr;

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: null },
        req,
        "marketplace.blacklist_removed",
        "marketplace_blacklist",
        entryId,
        {
          partner_id: (entry as any).partner_id,
          partner_name: (entry as any).partner_name,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.blacklist] audit failed:", e);
    }

    return NextResponse.json({ ok: true, deactivated: entryId });
  } catch (e: any) {
    console.error("[admin.marketplace.blacklist] DELETE failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/blacklist");
export const POST = withApm(_post, "POST /api/admin/marketplace/blacklist");
export const DELETE = withApm(_del, "DELETE /api/admin/marketplace/blacklist");
