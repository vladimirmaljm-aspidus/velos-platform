// src/app/api/settings/retention-config/route.ts
// ----------------------------------------------------------------------------
// Configurable per-table retention windows (P1-1 / Feature 3).
//
//   GET    /api/settings/retention-config
//          → returns { config, defaults }. Super-admin only.
//
//   PUT    /api/settings/retention-config
//          Body: partial RetentionConfig (only the fields to update).
//          → merges with current config, validates, persists.
//          Super-admin only. Audit-logged.
//
// SUPER-ADMIN RULE
// ----------------
// Only super_admin can configure retention policy. The route uses
// `requireSuperAdmin` (NEVER blocked for super_admin; everyone else
// gets 401 / 403). Super_admin can also MANUALLY trigger the cleanup
// (the cron route at `/api/cron/data-retention` accepts a super-admin
// session cookie via `authorizeCron` — already implemented) and view
// the deleted-counts summary (the cron response body).
//
// Regulatory minima are enforced by `validateRetentionConfig`:
//   • audit_logs_years      ≥ 7 (SOX §802)
//   • kyc_submissions_years ≥ 5 (EU 5AMLD Article 40)
// A super-admin cannot configure a shorter window — that would put
// the platform in breach of the underlying regulation.
// ----------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import {
  getRetentionConfig,
  validateRetentionConfig,
  DEFAULT_RETENTION_CONFIG,
  invalidateRetentionConfigCache,
  type RetentionConfig,
} from "@/lib/compliance/retention";

export const runtime = "nodejs";

/**
 * GET /api/settings/retention-config
 *
 * Returns the current retention config + the defaults (for diff
 * display in the admin UI).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const config = await getRetentionConfig();
  return NextResponse.json({ config, defaults: DEFAULT_RETENTION_CONFIG });
}

/**
 * PUT /api/settings/retention-config
 *
 * Body: partial RetentionConfig. Only the supplied fields are
 * overwritten — the rest keep their current (or default) values.
 * Returns the merged config after persisting.
 *
 * Validation: every supplied field must pass `validateRetentionConfig`
 * (positive number, within bounds, regulatory minima respected).
 */
export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // Pull only the known RetentionConfig keys — drop anything else
  // the body might carry (defence-in-depth against a malicious body
  // trying to set unrelated settings fields via this route).
  const allowedKeys: Array<keyof RetentionConfig> = [
    "sessions_days",
    "login_history_days",
    "password_resets_hours",
    "rate_limits_hours",
    "mail_queue_days",
    "notifications_days",
    "audit_logs_years",
    "kyc_submissions_years",
  ];
  const incoming: Partial<RetentionConfig> = {};
  for (const k of allowedKeys) {
    if (body[k] !== undefined) {
      incoming[k] = body[k];
    }
  }

  const errors = validateRetentionConfig(incoming);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  // Merge with the current config (so a partial PUT preserves the
  // previous values for any field not supplied).
  const current = await getRetentionConfig();
  const updated: RetentionConfig = { ...current, ...incoming };

  // Persist to the `settings` table (key = "retention_config",
  // tenant_id IS NULL — platform-wide).
  const { getSupabase } = await import("@/lib/supabase/client");
  const sb = getSupabase();
  const { data: existing, error: selErr } = await sb
    .from("settings")
    .select("id")
    .eq("key", "retention_config")
    .is("tenant_id", "null")
    .maybeSingle();
  if (selErr) {
    return NextResponse.json({ error: sanitizeError(selErr) }, { status: 500 });
  }

  if (existing) {
    const { error: updErr } = await sb
      .from("settings")
      .update({ value: updated })
      .eq("id", existing.id);
    if (updErr) {
      return NextResponse.json({ error: sanitizeError(updErr) }, { status: 500 });
    }
  } else {
    const { error: insErr } = await sb
      .from("settings")
      .insert({ key: "retention_config", value: updated, tenant_id: null });
    if (insErr) {
      return NextResponse.json({ error: sanitizeError(insErr) }, { status: 500 });
    }
  }

  // Drop the in-memory cache so the next read (incl. the cron route)
  // sees the new values immediately.
  invalidateRetentionConfigCache();

  await audit(
    auth.store,
    auth.user,
    req,
    "settings.retention_config.update",
    "settings",
    "retention_config",
    { updated, incoming },
  );

  return NextResponse.json({ config: updated, defaults: DEFAULT_RETENTION_CONFIG });
}
