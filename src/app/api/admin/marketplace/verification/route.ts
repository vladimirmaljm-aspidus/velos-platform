import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";
import type { MarketplaceVerificationLevel } from "@/lib/supabase/marketplace-profile-types";

export const runtime = "nodejs";

const LEVELS: MarketplaceVerificationLevel[] = ["none", "bronze", "silver", "gold", "platinum"];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/marketplace/verification
//
// Returns every company profile on the platform with its verification level
// + the partner's name / country so the super-admin can decide which
// companies to promote / demote.
//
// Query params:
//   - level:    none | bronze | silver | gold | platinum (default: all)
//   - search:   substring match on partner name
//
// Auth: super_admin only.
// ─────────────────────────────────────────────────────────────────────────────
async function _get(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sb = getSupabase();
    const url = new URL(req.url);
    const level = url.searchParams.get("level");
    const search = url.searchParams.get("search")?.trim();

    let q = sb
      .from("marketplace_company_profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (level && LEVELS.includes(level as MarketplaceVerificationLevel)) {
      q = q.eq("verification_level", level);
    }

    const { data: profiles, error } = await q.limit(500);
    if (error) throw error;

    const rows = (profiles as any[]) || [];

    // Hydrate the partner name / country / tenant for each profile.
    const partnerIds = Array.from(new Set(rows.map((p) => p.partner_id).filter(Boolean)));
    let partnersById: Record<string, { name: string; country: string | null; tenant_id: string | null; email: string | null }> = {};
    if (partnerIds.length > 0) {
      const { data: partnerRows } = await sb
        .from("partners")
        .select("id, name, country, tenant_id, email")
        .in("id", partnerIds);
      partnersById = Object.fromEntries(((partnerRows as any[]) || []).map((p) => [p.id, p]));
    }

    let items = rows.map((p) => {
      const partner = partnersById[p.partner_id];
      return {
        ...p,
        company_name: partner?.name ?? null,
        company_country: partner?.country ?? null,
        company_email: partner?.email ?? null,
        tenant_id: partner?.tenant_id ?? p.tenant_id,
      };
    });

    // Search filter (post-filter because we JOIN partners after the fact).
    if (search) {
      const s = search.toLowerCase();
      items = items.filter(
        (p) =>
          (p.company_name || "").toLowerCase().includes(s) ||
          (p.company_email || "").toLowerCase().includes(s),
      );
    }

    return NextResponse.json({ items, total: items.length });
  } catch (e: any) {
    console.error("[admin.marketplace.verification] GET failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/marketplace/verification
//
// Approve / reject / set verification level for a single company.
//
// Body:
//   {
//     partner_id: string,
//     action:    "approve" | "reject" | "set_level",
//     level?:    "none" | "bronze" | "silver" | "gold" | "platinum"   (required for set_level / approve)
//     reason?:   string   (free-text admin note, optional)
//   }
//
//   • approve → set level (default 'bronze' if level not given), stamp verified_at/by
//   • reject  → set level='none', clear verified_at/by, leave a paper trail via audit
//   • set_level→ explicit level change
//
// Auth: super_admin only. Mirrors /api/admin/verify-partner (the older
// single-purpose route) but with the broader action enum the UI needs.
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

  if (!body?.partner_id || typeof body.partner_id !== "string") {
    return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
  }
  const action = String(body.action || "");
  if (!["approve", "reject", "set_level"].includes(action)) {
    return NextResponse.json(
      { error: "action must be one of: approve, reject, set_level." },
      { status: 400 },
    );
  }

  let level: MarketplaceVerificationLevel = "none";
  if (action === "approve" || action === "set_level") {
    const requested = String(body.level || (action === "approve" ? "bronze" : ""));
    if (!LEVELS.includes(requested as MarketplaceVerificationLevel)) {
      return NextResponse.json(
        { error: `level must be one of: ${LEVELS.join(", ")}.` },
        { status: 400 },
      );
    }
    level = requested as MarketplaceVerificationLevel;
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

    const patch =
      action === "reject"
        ? {
            verification_level: "none" as MarketplaceVerificationLevel,
            verified_at: null,
            verified_by: null,
          }
        : {
            verification_level: level,
            verified_at: new Date().toISOString(),
            verified_by: auth.user.username,
          };

    const { data: updated, error: updErr } = await sb
      .from("marketplace_company_profiles")
      .update(patch)
      .eq("partner_id", body.partner_id)
      .select()
      .maybeSingle();
    if (updErr) throw updErr;

    const auditAction =
      action === "approve"
        ? "marketplace.verification_approved"
        : action === "reject"
        ? "marketplace.verification_rejected"
        : "marketplace.verification_level_changed";

    try {
      await audit(
        auth.store,
        { id: auth.user.id, username: auth.user.username, tenant_id: (partner as any).tenant_id },
        req,
        auditAction,
        "marketplace_company_profiles",
        body.partner_id,
        {
          partner_id: body.partner_id,
          partner_name: (partner as any).name,
          level: action === "reject" ? "none" : level,
          reason: body.reason || null,
          admin: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.marketplace.verification] audit failed:", e);
    }

    return NextResponse.json({ profile: updated });
  } catch (e: any) {
    console.error("[admin.marketplace.verification] PUT failed:", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/admin/marketplace/verification");
export const PUT = withApm(_put, "PUT /api/admin/marketplace/verification");
