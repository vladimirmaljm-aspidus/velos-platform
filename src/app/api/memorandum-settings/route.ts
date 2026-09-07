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

  // Auto-create default settings if none exist.
  // audit35: a brand-new row starts UNLOCKED (setup mode) — the tenant tunes
  // the memo freely, and the UI pushes the prominent "Lock memorandum"
  // action. Rows created by migration 095 (existing, already-configured
  // tenants) start locked=TRUE: once set, the frame is frozen everywhere.
  if (!data) {
    const { data: created, error: insErr } = await sb
      .from("memorandum_settings")
      .insert({ tenant_id: tenantId, locked: false })
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

  // ── audit35: GLOBAL MEMORANDUM LOCK ────────────────────────────────
  // The memo owns the document FRAME on EVERY document (renderer reads it
  // exclusively — audit33). While locked=TRUE, NO frame edit is accepted:
  //   • { action: "lock" }                  → freeze the memo
  //   • { action: "unlock", unlock_phrase }  → type-to-confirm ritual
  //       (phrase must be exactly "MEMORANDUM")
  //   • any field write while locked         → 400 { code: "MEMO_LOCKED" }
  // A mistake can never change the frame: no UI path sends the phrase
  // unless a human typed it.
  const action = body.action === "lock" || body.action === "unlock" ? body.action : undefined;
  delete body.action;
  const unlockPhrase = typeof body.unlock_phrase === "string" ? body.unlock_phrase.trim().toUpperCase() : "";
  delete body.unlock_phrase;

  if (action && Object.keys(body).some((k) => !isManagedKey(k))) {
    return NextResponse.json(
      { error: `The "${action}" action takes no settings — send it alone.` },
      { status: 400 },
    );
  }

  const sb = getSupabase();

  // Ensure a row exists (auto-create on first PUT — matches GET behaviour;
  // audit35: created unlocked = setup mode, same as GET).
  const { data: existing } = await sb
    .from("memorandum_settings")
    .select("id, locked")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (action === "lock" || action === "unlock") {
    if (action === "unlock" && unlockPhrase !== "MEMORANDUM") {
      return NextResponse.json(
        { error: 'Wrong unlock phrase — type MEMORANDUM exactly.', code: "MEMO_LOCKED" },
        { status: 400 },
      );
    }
    const { data: updated, error: updErr } = await sb
      .from("memorandum_settings")
      .update({ locked: action === "lock", updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .select()
      .maybeSingle();
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    try {
      await audit(
        auth.store, auth.user, req,
        action === "lock" ? "memorandum_settings.lock" : "memorandum_settings.unlock",
        "memorandum_settings", tenantId, {},
      );
    } catch (e) {
      console.error("[audit]", e);
    }
    return NextResponse.json(updated);
  }

  // Normal field write while the memo is locked → refused.
  if (existing?.locked === true) {
    const attempted = Object.keys(body).filter((k) => !isManagedKey(k));
    if (attempted.length > 0) {
      return NextResponse.json(
        {
          error:
            "The memorandum is LOCKED — its frame is identical on every document and cannot be edited. Unlock it first (type-to-confirm ritual).",
          code: "MEMO_LOCKED",
          locked: true,
        },
        { status: 423 },
      );
    }
  }

  // 31-f — numeric-field validation BEFORE the write (audit 30-a finding
  // 30a-09: PUT {body_font_size: "huge"} previously flowed raw into the
  // insert/update and Postgres rejected it with a RAW error — 500
  // 'invalid input syntax for type integer: "huge"' — leaking the DB
  // dialect + column typing to the client. All the *_mm / *_pct / font-size
  // / QR geometry columns below are integer (body_line_height is real);
  // coerce numeric strings, 400 on junk so the raw PG text can never leak.
  {
    // audit33: extended for the Memorandum Engine v2 columns (page setup,
    // margins, footer-left fonts, footer border, QR opacity).
    const bad = assertNumeric(body, [
      "header_height_mm", "header_left_font_size",
      "logo_max_width_mm", "logo_max_height_mm",
      "logo_position_x_mm", "logo_position_y_mm",
      "footer_height_mm", "qr_size_mm",
      "qr_position_x_mm", "qr_position_y_mm",
      "footer_center_font_size", "footer_right_font_size",
      "footer_left_width_pct", "footer_center_width_pct", "footer_right_width_pct",
      "body_font_size", "body_line_height",
      "margin_top_mm", "margin_bottom_mm", "margin_left_mm", "margin_right_mm",
      "footer_left_font_size",
    ]);
    if (bad) return bad;
  }

  // ── audit33: enum-ish TEXT columns get value validation (a bad value
  // would otherwise trip the DB CHECK constraints added in migration 090
  // and leak a raw 23514 error as a 500). Whitelist, 400 on junk.
  {
    const enums: [string, string[]][] = [
      ["page_size", ["A4", "Letter"]],
      ["logo_side", ["left", "right"]],
      ["qr_position", ["left", "center", "right", "none"]],
      ["footer_address_source", ["tenant", "custom"]],
    ];
    for (const [col, allowed] of enums) {
      const v = body[col];
      if (v !== undefined && v !== null && (typeof v !== "string" || !allowed.includes(v))) {
        return NextResponse.json(
          { error: `Invalid ${col}. Allowed: ${allowed.join(", ")}.` },
          { status: 400 },
        );
      }
    }
    // Numeric-ish REAL columns (opacity, border width) — coerce strings,
    // range-check, 400 on junk.
    const reals: [string, number, number][] = [
      ["qr_opacity", 0, 1],
      ["header_border_width", 0, 6],
    ];
    for (const [col, min, max] of reals) {
      const v = body[col];
      if (v === undefined || v === null) continue;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        return NextResponse.json(
          { error: `Invalid ${col}. Must be a number between ${min} and ${max}.` },
          { status: 400 },
        );
      }
      body[col] = n;
    }
    // footer_address_custom is free multi-line text — cap the length so a
    // pasted novel can't blow the footer render.
    if (typeof body.footer_address_custom === "string" && body.footer_address_custom.length > 2000) {
      body.footer_address_custom = body.footer_address_custom.slice(0, 2000);
    }
  }

  // Strip fields that shouldn't be updated directly
  delete body.id;
  delete body.tenant_id;
  delete body.created_at;
  delete body.updated_at;
  // audit35: the lock flag itself is NEVER writable through a field PUT —
  // only through the explicit lock/unlock actions above.
  delete body.locked;

  function isManagedKey(k: string): boolean {
    return k === "id" || k === "tenant_id" || k === "created_at" || k === "updated_at" || k === "locked";
  }

  // (the row-existence check + lock actions above already ran; this is the
  // normal field-update path — reached only when unlocked or when the row
  // doesn't exist yet, in which case the insert starts in setup mode)
  let data: Record<string, unknown> | null = null;
  let error: { message: string } | null = null;

  if (!existing) {
    const res = await sb
      .from("memorandum_settings")
      .insert({ tenant_id: tenantId, locked: false, ...body })
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
