import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";
import {
  calculateESGScore,
  upsertESGScore,
} from "@/lib/data/marketplace-esg-store";
import { audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// POST /api/admin/esg-score — super-admin only.
//
// Body:
//   {
//     partner_id: string,
//     environmental_score: number,  // 0–100
//     social_score: number,         // 0–100
//     governance_score: number,    // 0–100
//     assessment_date?: string,    // ISO 8601, defaults to now
//     notes?: string,
//     auto_calculate?: boolean,     // when true, ignore the body's scores
//                                  //   and use calculateESGScore() instead
//   }
//
// The store recomputes overall_score (mean of E/S/G, rounded) and rating
// (aaa → ccc bucket) from the three subscores; the body's overall_score /
// rating (if any) are ignored so they can never drift out of sync.
//
// `assessed_by` is stamped from the super-admin's username.
//
// When `auto_calculate: true` is supplied, the route ignores the body's
// subscores and instead derives them from the partner's VERIFIED
// sustainability certifications (see `calculateESGScore()`). This lets a
// super-admin promote the auto-derived score to the official record with a
// single click — but they can still tweak the subscores manually before
// persisting by calling the route again without `auto_calculate`.
async function _post(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.partner_id || typeof body.partner_id !== "string") {
    return NextResponse.json({ error: "partner_id is required." }, { status: 400 });
  }

  // Verify the partner exists (any tenant — super-admin scope).
  const sb = getSupabase();
  const { data: partner, error: pErr } = await sb
    .from("partners")
    .select("id, tenant_id, name")
    .eq("id", body.partner_id)
    .maybeSingle();
  if (pErr) {
    console.error("[admin.esg-score] partner lookup failed:", pErr);
    return NextResponse.json({ error: "Failed to verify partner." }, { status: 500 });
  }
  if (!partner) {
    return NextResponse.json({ error: "Partner not found." }, { status: 404 });
  }

  try {
    let envScore: number;
    let socScore: number;
    let govScore: number;
    let autoNote = "";

    if (body.auto_calculate === true) {
      // Auto-derive from verified sustainability certs.
      const calc = await calculateESGScore(body.partner_id);
      envScore = calc.environmental_score;
      socScore = calc.social_score;
      govScore = calc.governance_score;
      autoNote = `Auto-calculated from ${calc.verified_cert_count} verified certification(s). `;
    } else {
      for (const [k, v] of [
        ["environmental_score", body.environmental_score],
        ["social_score", body.social_score],
        ["governance_score", body.governance_score],
      ] as const) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
          return NextResponse.json(
            { error: `${k} must be a number in [0, 100].` },
            { status: 400 },
          );
        }
      }
      envScore = body.environmental_score;
      socScore = body.social_score;
      govScore = body.governance_score;
    }

    if (body.assessment_date !== undefined && body.assessment_date !== null && (typeof body.assessment_date !== "string" || Number.isNaN(Date.parse(body.assessment_date)))) {
      return NextResponse.json({ error: "assessment_date must be an ISO 8601 date." }, { status: 400 });
    }
    if (body.notes !== undefined && body.notes !== null && (typeof body.notes !== "string" || body.notes.length > 5000)) {
      return NextResponse.json({ error: "notes must be ≤ 5000 chars." }, { status: 400 });
    }

    const notes = body.notes
      ? `${autoNote}${body.notes}`.trim()
      : (autoNote || null);

    const updated = await upsertESGScore(
      {
        partner_id: body.partner_id,
        environmental_score: envScore,
        social_score: socScore,
        governance_score: govScore,
        assessment_date: body.assessment_date ?? undefined,
        notes,
      },
      auth.user.username,
    );
    try {
      await audit(
        auth.store,
        {
          id: auth.user.id,
          username: auth.user.username,
          tenant_id: (partner as { tenant_id?: string | null }).tenant_id ?? undefined,
        },
        req,
        "marketplace.esg_score_set",
        "marketplace_esg_scores",
        updated.id,
        {
          partner_id: body.partner_id,
          partner_name: (partner as { name?: string | null }).name,
          environmental_score: updated.environmental_score,
          social_score: updated.social_score,
          governance_score: updated.governance_score,
          overall_score: updated.overall_score,
          rating: updated.rating,
          auto_calculated: body.auto_calculate === true,
          assessed_by: auth.user.username,
        },
      );
    } catch (e) {
      console.error("[admin.esg-score] audit failed:", e);
    }
    return NextResponse.json({ score: updated });
  } catch (e: any) {
    console.error("[admin.esg-score]", e);
    const msg = sanitizeError(e);
    const status = /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const POST = withApm(_post, "POST /api/admin/esg-score");
