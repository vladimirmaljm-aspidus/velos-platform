import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import {
  getSessionConfig,
  validateSessionConfig,
  DEFAULT_SESSION_CONFIG,
  invalidateSessionConfigCache,
} from "@/lib/auth/session-config";

export const runtime = "nodejs";

/**
 * GET /api/settings/session-config — return the current session-config
 * (platform-level, super-admin only).
 *
 * Body: none.
 *
 * Response: `{ config: SessionConfig, defaults: SessionConfig }`.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const config = await getSessionConfig();
  return NextResponse.json({ config, defaults: DEFAULT_SESSION_CONFIG });
}

/**
 * PUT /api/settings/session-config — update the session-config row in
 * the platform-level settings table. Super-admin only.
 *
 * Body: `Partial<SessionConfig>` — only the fields you want to change.
 * Returns the merged config after the update.
 *
 * CRITICAL: even if a super_admin misconfigures `superAdminTtlMs` to a
 * tiny value, `requireAuth` ignores it for super_admin — see
 * session-config.ts CRITICAL INVARIANT.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const errors = validateSessionConfig(body as Partial<Parameters<typeof validateSessionConfig>[0]>);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const current = await getSessionConfig();
  const updated = { ...current, ...(body as Partial<typeof current>) };

  const { getSupabase } = await import("@/lib/supabase/client");
  const supabase = getSupabase();

  // Upsert (handle the case where the row doesn't exist yet).
  const { data: existing } = await supabase
    .from("settings")
    .select("id")
    .eq("key", "session_config")
    .is("tenant_id", "null")
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("settings")
      .update({ value: updated })
      .eq("id", existing.id);
    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  } else {
    const { error } = await supabase
      .from("settings")
      .insert({ key: "session_config", value: updated, tenant_id: null });
    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }

  invalidateSessionConfigCache();

  await audit(auth.store, auth.user, req, "settings.session_config.update", "settings", "session_config", {});

  return NextResponse.json({ config: updated });
}
