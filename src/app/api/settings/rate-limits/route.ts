import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import {
  getRateLimitConfig,
  validateRateLimitConfig,
  DEFAULT_RATE_LIMIT_CONFIG,
  invalidateRateLimitCache,
} from "@/lib/security/rate-limit-config";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const config = await getRateLimitConfig();
  return NextResponse.json({ config, defaults: DEFAULT_RATE_LIMIT_CONFIG });
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const errors = validateRateLimitConfig(body);
  if (errors.length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  const current = await getRateLimitConfig();
  const updated = { ...current, ...body };

  const { getSupabase } = await import("@/lib/supabase/client");
  const supabase = getSupabase();

  // Upsert (handle the case where the row doesn't exist yet)
  const { data: existing } = await supabase
    .from("settings")
    .select("id")
    .eq("key", "rate_limit_config")
    .is("tenant_id", "null")
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("settings")
      .update({ value: updated })
      .eq("id", existing.id);
    if (error) return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  } else {
    const { error } = await supabase
      .from("settings")
      .insert({ key: "rate_limit_config", value: updated, tenant_id: null });
    if (error) return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }

  invalidateRateLimitCache();

  await audit(auth.store, auth.user, req, "settings.rate_limits.update", "settings", "rate_limit_config", {});

  return NextResponse.json({ config: updated });
}
