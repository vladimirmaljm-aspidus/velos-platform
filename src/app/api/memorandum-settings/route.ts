import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
// 31-f — shared numeric-field validation (audit 30-a finding 30a-09: a
// raw Postgres type-cast error leaked to the client as a 500; now a 400).
import { assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

/**
 * GET /api/memorandum-settings?tenant_id=xxx
 *
 * Fetch the memorandum (header/footer/body) settings for the resolved tenant.
 * Super-admin can pass ?tenant_id=xxx to manage a specific tenant.
 *
 * Auto-creates a row with all defaults on first fetch — tenants never have
 * to "save" before they can preview. Returns `null` for super-admins with no
 * tenant context (so the UI shows an empty/disabled state instead of an error).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate (memorandum_settings.read)
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "memorandum_settings.read");
    if (_d) return _d;
  }

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    if (auth.isSuperAdmin) return NextResponse.json(null);
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("memorandum_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auto-create default settings if none exist
  if (!data) {
    const { data: created, error: insErr } = await sb
      .from("memorandum_settings")
      .insert({ tenant_id: tenantId })
      .select()
      .maybeSingle();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    return NextResponse.json(created);
  }

  return NextResponse.json(data);
}

/**
 * PUT /api/memorandum-settings?tenant_id=xxx
 *
 * Update the memorandum settings for the resolved tenant.
 * The tenant_id is resolved server-side and overrides any value in the body.
 * System-managed columns (id, created_at, updated_at) are stripped — updated_at
 * is set server-side.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Permission gate (memorandum_settings.update)
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "memorandum_settings.update");
    if (_d) return _d;
  }

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // 31-f — numeric-field validation BEFORE the write (audit 30-a finding
  // 30a-09: PUT {body_font_size: "huge"} previously flowed raw into the
  // insert/update and Postgres rejected it with a RAW error — 500
  // 'invalid input syntax for type integer: "huge"' — leaking the DB
  // dialect + column typing to the client. All the *_mm / *_pct / font-size
  // / QR geometry columns below are integer (body_line_height is real);
  // coerce numeric strings, 400 on junk so the raw PG text can never leak.
  {
    const bad = assertNumeric(body, [
      "header_height_mm", "header_left_font_size",
      "logo_max_width_mm", "logo_max_height_mm",
      "logo_position_x_mm", "logo_position_y_mm",
      "footer_height_mm", "qr_size_mm",
      "qr_position_x_mm", "qr_position_y_mm",
      "footer_center_font_size", "footer_right_font_size",
      "footer_left_width_pct", "footer_center_width_pct", "footer_right_width_pct",
      "body_font_size", "body_line_height",
    ]);
    if (bad) return bad;
  }

  // Strip fields that shouldn't be updated directly
  delete body.id;
  delete body.tenant_id;
  delete body.created_at;
  delete body.updated_at;

  const sb = getSupabase();

  // Ensure a row exists (auto-create on first PUT — matches GET behaviour).
  // Use upsert semantics so a stale client (no prior GET) still works.
  const { data: existing } = await sb
    .from("memorandum_settings")
    .select("id")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  let data: Record<string, unknown> | null = null;
  let error: { message: string } | null = null;

  if (!existing) {
    const res = await sb
      .from("memorandum_settings")
      .insert({ tenant_id: tenantId, ...body })
      .select()
      .maybeSingle();
    data = res.data;
    error = res.error;
  } else {
    const res = await sb
      .from("memorandum_settings")
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .select()
      .maybeSingle();
    data = res.data;
    error = res.error;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await audit(
      auth.store,
      auth.user,
      req,
      "memorandum_settings.update",
      "memorandum_settings",
      tenantId,
      {}
    );
  } catch (e) {
    console.error("[audit]", e);
  }

  return NextResponse.json(data);
}
