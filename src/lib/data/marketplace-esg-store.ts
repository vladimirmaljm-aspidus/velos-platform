// Marketplace Phase 11 store — ESG scores, sustainability certifications,
// and carbon offsets.
//
// All functions talk directly to the tables added in migration
// 052_marketplace_esg.sql:
//   • marketplace_esg_scores            — one row per company
//   • marketplace_sustainability_certs — certification ledger
//   • marketplace_carbon_offsets        — offset purchases linked to a shipment
//
// SECURITY MODEL
//   • `partner_id` is the canonical "who". The API route stamps it from the
//     portal session (PortalAccess.partner_id); the store never trusts a
//     body-supplied partner_id — it always overrides whatever the body
//     claims with the auth-context value.
//   • getESGScore(): public — any authenticated partner can read any
//     company's ESG score (it's a public signal on the company profile).
//   • upsertESGScore(): SUPER-ADMIN ONLY. The API route enforces this via
//     requireSuperAdmin(); the store doesn't double-check the role (the
//     route is the single source of truth for "who can call this").
//   • listSustainabilityCerts(): public — same reasoning as getESGScore.
//   • addSustainabilityCert(): the owning partner only. The store stamps
//     partner_id from the auth context; the cert starts `verified = false`
//     and is promoted by an admin later.
//   • verifySustainabilityCert(): SUPER-ADMIN ONLY. Flips verified to true
//     (or false) and stamps verified_at.
//   • deleteSustainabilityCert(): the owning partner only.
//   • createCarbonOffset(): the owning partner only. partner_id is stamped
//     from the auth context.
//   • listCarbonOffsets(): the owning partner only — offset purchases are
//     private to the company (the public profile surfaces the AGGREGATE
//     "X tonnes offset" but not the individual transactions).
//   • calculateESGScore(): a PUBLIC helper that auto-derives a provisional
//     ESG score from the partner's verified sustainability certifications.
//     It does NOT write to the DB — it returns the computed shape so a
//     super-admin can review and then call upsertESGScore() to persist it.

import { getSupabase } from "@/lib/supabase/client";
import type {
  CarbonOffset,
  CarbonOffsetCreate,
  CarbonOffsetStatus,
  CarbonOffsetType,
  CertType,
  ESGRating,
  ESGScore,
  ESGScoreUpsert,
  SustainabilityCert,
  SustainabilityCertCreate,
  SustainabilityCertPatch,
} from "@/lib/supabase/marketplace-esg-types";
import { CERT_TYPE_PILLAR } from "@/lib/supabase/marketplace-esg-types";

// ─── Validation helpers ────────────────────────────────────────────────────

const VALID_CERT_TYPES = new Set<string>([
  "fsc", "rspo", "msc", "iso14001", "iso45001", "iso50001",
  "sa8000", "fairtrade", "organic", "global_gap",
  "rainforest_alliance", "carbon_neutral", "b_corp",
]);

const VALID_OFFSET_TYPES = new Set<string>([
  "tree_planting", "renewable_energy", "methane_capture", "direct_air_capture",
]);

const VALID_OFFSET_STATUSES = new Set<string>([
  "pending", "purchased", "retired", "cancelled",
]);

const VALID_RATINGS = new Set<string>([
  "unrated", "ccc", "b", "bb", "bbb", "a", "aa", "aaa",
]);

function assertScoreRange(field: string, v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`${field} must be a number in [0, 100].`);
  }
}

function assertIsoDateOrNull(s: unknown, field: string): asserts s is string | null {
  if (s === null || s === undefined) return;
  if (typeof s !== "string" || Number.isNaN(Date.parse(s))) {
    throw new Error(`${field} must be an ISO 8601 date string or null.`);
  }
}

function assertStringOrNull(s: unknown, field: string, max = 500): asserts s is string | null {
  if (s === null || s === undefined) return;
  if (typeof s !== "string" || s.length > max) {
    throw new Error(`${field} must be a string of at most ${max} chars.`);
  }
}

// ─── Rating derivation ─────────────────────────────────────────────────────

/**
 * Map an overall numeric score in [0, 100] to the ESG letter-grade rating.
 *
 * The bucket thresholds are deliberately conservative (a partner needs
 * ~85+ to hit "aaa") so the rating reflects a strong all-round ESG
 * performance, not just one strong pillar.
 *
 *   85–100  → aaa
 *   75–84   → aa
 *   65–74   → a
 *   55–64   → bbb
 *   45–54   → bb
 *   30–44   → b
 *   0–29    → ccc
 *
 * `unrated` is reserved for partners with no assessment row at all (it's
 * the column default) — a stored row always carries a real bucket.
 */
export function ratingFromScore(overall: number): ESGRating {
  if (!Number.isFinite(overall) || overall < 0) return "ccc";
  if (overall >= 85) return "aaa";
  if (overall >= 75) return "aa";
  if (overall >= 65) return "a";
  if (overall >= 55) return "bbb";
  if (overall >= 45) return "bb";
  if (overall >= 30) return "b";
  return "ccc";
}

/**
 * Compute the overall score (rounded mean of E/S/G) and the letter grade.
 * Used on every upsert so the denormalised columns never drift out of
 * sync with the subscores.
 */
function deriveOverall(env: number, soc: number, gov: number): {
  overall: number;
  rating: ESGRating;
} {
  const overall = Math.round((env + soc + gov) / 3);
  return { overall, rating: ratingFromScore(overall) };
}

// ─── Carbon offset cost estimation ─────────────────────────────────────────

/**
 * Rough USD-per-tonne CO2 offset cost by type. Used by createCarbonOffset
 * when the caller doesn't supply an explicit `offset_cost`. The numbers are
 * conservative midpoints of the 2024 voluntary carbon market ranges:
 *   • tree_planting     — ~$15 / tCO2e (reforestation / afforestation)
 *   • renewable_energy  — ~$10 / tCO2e (avoided fossil generation)
 *   • methane_capture   — ~$12 / tCO2e (landfill / dairy digesters)
 *   • direct_air_capture — ~$200 / tCO2e (DAC is still very expensive)
 */
const OFFSET_COST_PER_TON: Record<CarbonOffsetType, number> = {
  tree_planting: 15,
  renewable_energy: 10,
  methane_capture: 12,
  direct_air_capture: 200,
};

/** Public so the carbon-offset widget can preview the cost before purchase. */
export function estimateOffsetCost(
  co2Tons: number,
  type: CarbonOffsetType | null,
): number | null {
  if (!Number.isFinite(co2Tons) || co2Tons <= 0) return null;
  if (!type || !OFFSET_COST_PER_TON[type]) return null;
  return Math.round(co2Tons * OFFSET_COST_PER_TON[type] * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── ESG SCORES ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read a company's ESG score. Public — any authenticated partner can read
 * any company's score (it's a public signal on the company profile).
 *
 * Returns null when the partner has no assessment row yet (rating will
 * surface as "unrated" on the profile).
 */
export async function getESGScore(partnerId: string): Promise<ESGScore | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_esg_scores")
    .select("*")
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw error;
  return (data as ESGScore) || null;
}

/**
 * Super-admin create/update. Idempotent on partner_id (UNIQUE constraint →
 * upsert by partner_id). The store recomputes overall_score + rating from
 * the three subscores; the body's overall_score / rating (if any) are
 * ignored so they can never drift out of sync.
 *
 * `assessed_by` is stamped by the API route from the super-admin's username.
 */
export async function upsertESGScore(
  data: ESGScoreUpsert,
  assessedBy: string,
): Promise<ESGScore> {
  assertScoreRange("environmental_score", data.environmental_score);
  assertScoreRange("social_score", data.social_score);
  assertScoreRange("governance_score", data.governance_score);
  assertStringOrNull(data.notes, "notes", 5000);
  assertIsoDateOrNull(data.assessment_date, "assessment_date");

  const { overall, rating } = deriveOverall(
    data.environmental_score,
    data.social_score,
    data.governance_score,
  );

  const sb = getSupabase();
  const payload = {
    partner_id: data.partner_id,
    environmental_score: data.environmental_score,
    social_score: data.social_score,
    governance_score: data.governance_score,
    overall_score: overall,
    rating,
    assessment_date: data.assessment_date ?? new Date().toISOString(),
    assessed_by: assessedBy,
    notes: data.notes ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data: upserted, error } = await sb
    .from("marketplace_esg_scores")
    .upsert(payload, { onConflict: "partner_id" })
    .select()
    .single();
  if (error) throw error;
  return upserted as ESGScore;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── SUSTAINABILITY CERTIFICATIONS ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List a company's sustainability certifications. Public — same reasoning
 * as getESGScore (certs are a public trust signal on the profile).
 *
 * Verified certs sort first, then by valid_until desc (soonest-to-expire
 * at the top so they can be re-verified before lapsing).
 */
export async function listSustainabilityCerts(
  partnerId: string,
): Promise<SustainabilityCert[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_sustainability_certs")
    .select("*")
    .eq("partner_id", partnerId)
    .order("verified", { ascending: false })
    .order("valid_until", { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data as SustainabilityCert[]) || [];
}

/**
 * Add a sustainability cert. The owning partner only — partner_id is
 * stamped from the auth context (the body's partner_id, if any, is
 * ignored). New certs start `verified = false`; the verification is a
 * separate admin-only step.
 */
export async function addSustainabilityCert(
  partnerId: string,
  data: SustainabilityCertCreate,
): Promise<SustainabilityCert> {
  if (!VALID_CERT_TYPES.has(data.cert_type)) {
    throw new Error(`Invalid cert_type: ${data.cert_type}.`);
  }
  assertStringOrNull(data.cert_number, "cert_number", 200);
  assertStringOrNull(data.cert_issuer, "cert_issuer", 200);
  assertIsoDateOrNull(data.valid_from, "valid_from");
  assertIsoDateOrNull(data.valid_until, "valid_until");
  assertStringOrNull(data.document_url, "document_url", 1000);

  if (data.valid_from && data.valid_until && Date.parse(data.valid_until) < Date.parse(data.valid_from)) {
    throw new Error("valid_until must be on or after valid_from.");
  }

  const sb = getSupabase();
  const payload = {
    partner_id: partnerId,
    cert_type: data.cert_type,
    cert_number: data.cert_number ?? null,
    cert_issuer: data.cert_issuer ?? null,
    valid_from: data.valid_from ?? null,
    valid_until: data.valid_until ?? null,
    verified: false,
    verified_at: null,
    document_url: data.document_url ?? null,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_sustainability_certs")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as SustainabilityCert;
}

/**
 * Patch a sustainability cert. Super-admin only — used to flip `verified`
 * (and update issuer / expiry / document_url). When `verified: true` is
 * supplied the store stamps verified_at = now(); when `verified: false`
 * is supplied the store clears verified_at.
 */
export async function patchSustainabilityCert(
  certId: string,
  patch: SustainabilityCertPatch,
): Promise<SustainabilityCert | null> {
  if (patch.cert_number !== undefined) assertStringOrNull(patch.cert_number, "cert_number", 200);
  if (patch.cert_issuer !== undefined) assertStringOrNull(patch.cert_issuer, "cert_issuer", 200);
  if (patch.valid_until !== undefined) assertIsoDateOrNull(patch.valid_until, "valid_until");
  if (patch.document_url !== undefined) assertStringOrNull(patch.document_url, "document_url", 1000);

  const writable: Record<string, unknown> = {};
  if (patch.cert_number !== undefined) writable.cert_number = patch.cert_number ?? null;
  if (patch.cert_issuer !== undefined) writable.cert_issuer = patch.cert_issuer ?? null;
  if (patch.valid_until !== undefined) writable.valid_until = patch.valid_until ?? null;
  if (patch.document_url !== undefined) writable.document_url = patch.document_url ?? null;
  if (patch.verified === true) {
    writable.verified = true;
    writable.verified_at = new Date().toISOString();
  } else if (patch.verified === false) {
    writable.verified = false;
    writable.verified_at = null;
  }

  if (Object.keys(writable).length === 0) {
    // Nothing to update — return the current row.
    const sb0 = getSupabase();
    const { data: cur } = await sb0
      .from("marketplace_sustainability_certs")
      .select("*")
      .eq("id", certId)
      .maybeSingle();
    return (cur as SustainabilityCert) || null;
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_sustainability_certs")
    .update(writable)
    .eq("id", certId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as SustainabilityCert) || null;
}

/**
 * Delete a sustainability cert. The owning partner only — the store filters
 * by partner_id so a partner from tenant A can never delete tenant B's
 * certs by guessing ids.
 */
export async function deleteSustainabilityCert(
  certId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();
  const { error } = await sb
    .from("marketplace_sustainability_certs")
    .delete()
    .eq("id", certId)
    .eq("partner_id", partnerId);
  if (error) throw error;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── CARBON OFFSETS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List a company's carbon offsets. Owning partner only — offset purchases
 * are private (the public profile surfaces the AGGREGATE tonnes-offset, not
 * the individual transactions).
 */
export async function listCarbonOffsets(
  partnerId: string,
): Promise<CarbonOffset[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_carbon_offsets")
    .select("*")
    .eq("partner_id", partnerId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as CarbonOffset[]) || [];
}

/**
 * Create a carbon offset. The owning partner only — partner_id is stamped
 * from the auth context. When `offset_cost` is not supplied, the store
 * auto-derives it from `offset_type` + `co2_tons` via estimateOffsetCost.
 *
 * `status` starts at `pending` — the partner later promotes it to
 * `purchased` and then `retired` (the API route enforces the lifecycle).
 */
export async function createCarbonOffset(
  partnerId: string,
  data: CarbonOffsetCreate,
): Promise<CarbonOffset> {
  if (typeof data.co2_tons !== "number" || !Number.isFinite(data.co2_tons) || data.co2_tons <= 0) {
    throw new Error("co2_tons must be a positive number.");
  }
  if (data.offset_type && !VALID_OFFSET_TYPES.has(data.offset_type)) {
    throw new Error(`Invalid offset_type: ${data.offset_type}.`);
  }
  if (data.shipment_id !== undefined && data.shipment_id !== null && typeof data.shipment_id !== "string") {
    throw new Error("shipment_id must be a string UUID.");
  }
  if (data.currency !== undefined && (typeof data.currency !== "string" || data.currency.length !== 3)) {
    throw new Error("currency must be a 3-letter ISO code.");
  }
  assertStringOrNull(data.certificate_url, "certificate_url", 1000);

  // Auto-derive the offset cost when not supplied.
  const offsetCost =
    data.offset_cost !== undefined && data.offset_cost !== null
      ? data.offset_cost
      : estimateOffsetCost(data.co2_tons, data.offset_type ?? null);

  const sb = getSupabase();
  const payload = {
    partner_id: partnerId,
    shipment_id: data.shipment_id ?? null,
    co2_tons: data.co2_tons,
    offset_cost: offsetCost,
    currency: data.currency ?? "USD",
    offset_type: data.offset_type ?? null,
    status: "pending",
    certificate_url: data.certificate_url ?? null,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_carbon_offsets")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as CarbonOffset;
}

/**
 * Update a carbon offset's status. Owning partner only. The store validates
 * the lifecycle transition:
 *   pending  → purchased | cancelled
 *   purchased → retired   | cancelled
 *   retired  → (terminal — no further transitions)
 *   cancelled → (terminal)
 */
export async function updateCarbonOffsetStatus(
  offsetId: string,
  partnerId: string,
  nextStatus: CarbonOffsetStatus,
  certificateUrl?: string | null,
): Promise<CarbonOffset | null> {
  if (!VALID_OFFSET_STATUSES.has(nextStatus)) {
    throw new Error(`Invalid status: ${nextStatus}.`);
  }
  const sb = getSupabase();
  // Fetch + verify ownership in one round-trip.
  const { data: cur, error: fErr } = await sb
    .from("marketplace_carbon_offsets")
    .select("*")
    .eq("id", offsetId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (fErr) throw fErr;
  if (!cur) return null;
  const row = cur as CarbonOffset;

  const ALLOWED: Record<CarbonOffsetStatus, CarbonOffsetStatus[]> = {
    pending: ["purchased", "cancelled"],
    purchased: ["retired", "cancelled"],
    retired: [],
    cancelled: [],
  };
  if (!ALLOWED[row.status]?.includes(nextStatus)) {
    throw new Error(`Cannot transition offset from "${row.status}" to "${nextStatus}".`);
  }

  const writable: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "retired" && certificateUrl !== undefined) {
    writable.certificate_url = certificateUrl ?? null;
  }
  const { data: updated, error } = await sb
    .from("marketplace_carbon_offsets")
    .update(writable)
    .eq("id", offsetId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (updated as CarbonOffset) || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── AUTO-CALCULATE ESG SCORE FROM CERTS ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Provisional ESG score auto-derived from the partner's VERIFIED
 * sustainability certifications. Pure function — does NOT write to the DB.
 *
 * Methodology (intentionally simple, transparent, and conservative):
 *
 *   • Each verified cert contributes a fixed per-pillar boost:
 *       - Environmental certs (FSC, RSPO, MSC, ISO 14001, ISO 50001,
 *         organic, global_gap, rainforest_alliance, carbon_neutral):
 *         +10 to Environmental, +1 to Governance.
 *       - Social certs (ISO 45001, SA8000, Fairtrade):
 *         +10 to Social, +1 to Governance.
 *       - Governance certs (B Corp):
 *         +15 to Governance (covers overall sustainability management).
 *
 *   • Caps: each subscore is clamped to [0, 100].
 *
 *   • The base score for an unknown / unmeasured pillar is 30 — i.e. a
 *     partner with no certs at all gets ~30 across the board (rating "b"),
 *     not 0 ("ccc"). This keeps the auto-score from being punitively low
 *     for SMEs that simply haven't pursued certification yet.
 *
 * The super-admin can review this output and then call upsertESGScore()
 * to persist it (with optional manual adjustments to one or more pillars
 * based on non-cert signals they're aware of — e.g. an internal
 * environmental audit, a community-investment programme, board
 * independence, etc.).
 */
export async function calculateESGScore(
  partnerId: string,
): Promise<{
  environmental_score: number;
  social_score: number;
  governance_score: number;
  overall_score: number;
  rating: ESGRating;
  verified_cert_count: number;
}> {
  const certs = await listSustainabilityCerts(partnerId);
  const verified = certs.filter((c) => c.verified);

  let env = 30;
  let soc = 30;
  let gov = 30;

  for (const c of verified) {
    const pillar = CERT_TYPE_PILLAR[c.cert_type as CertType];
    if (!pillar) continue;
    if (pillar === "e") {
      env += 10;
      gov += 1;
    } else if (pillar === "s") {
      soc += 10;
      gov += 1;
    } else if (pillar === "g") {
      gov += 15;
    }
  }

  env = Math.min(100, env);
  soc = Math.min(100, soc);
  gov = Math.min(100, gov);
  const { overall, rating } = deriveOverall(env, soc, gov);

  return {
    environmental_score: env,
    social_score: soc,
    governance_score: gov,
    overall_score: overall,
    rating,
    verified_cert_count: verified.length,
  };
}

// Re-export the validation sets so the API routes can use them for input
// validation without duplicating the literals.
export {
  VALID_CERT_TYPES,
  VALID_OFFSET_TYPES,
  VALID_OFFSET_STATUSES,
  VALID_RATINGS,
};
