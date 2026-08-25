import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// ── NOTIF-UX — per-type notification preferences ──────────────────────────
// Stored on the user row's `notif_prefs` JSONB column (added in the original
// users table DDL — already exists, see prisma/schema.prisma). The shape is:
//
//   {
//     "offers":      true,  // offer accepted/rejected/received/expired/countered
//     "invoices":    true,  // invoice paid/overdue/sent
//     "messages":    true,  // portal_message + marketplace_message_received
//     "kyc":         true,  // kyc submitted/approved/rejected
//     "marketplace": true,  // marketplace_response_* notifications
//     "trial":       true,  // trial_expiring / subscription warnings
//     "system":      true,  // system_message / low_stock_alert / signup_request
//   }
//
// Anything missing from the JSON is treated as `true` (default-on so a fresh
// account never silently loses notifications because the prefs row hasn't
// been written yet). The notification-dispatch layer reads the same shape —
// this route is the only writer.

const VALID_KEYS = [
  "offers", "invoices", "messages", "kyc",
  "marketplace", "trial", "system",
] as const;
type NotifPrefKey = (typeof VALID_KEYS)[number];

function isPrefKey(v: string): v is NotifPrefKey {
  return (VALID_KEYS as readonly string[]).includes(v);
}

function normalizePrefs(raw: unknown): Record<NotifPrefKey, boolean> {
  const out: Record<NotifPrefKey, boolean> = {
    offers: true, invoices: true, messages: true, kyc: true,
    marketplace: true, trial: true, system: true,
  };
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isPrefKey(k)) out[k] = v !== false; // any non-false value = on
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Self-only — any authenticated user reads/edits their own notif prefs.
    // No permission gate beyond `requireAuth`; the row we touch is the
    // caller's own user row.

    const prefs = await loadNotifPrefs(auth);
    return NextResponse.json({ prefs });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid body." }, { status: 400 });
    }

    // Whitelist + normalize. Anything not in VALID_KEYS is dropped silently.
    const next: Record<NotifPrefKey, boolean> = {
      offers: true, invoices: true, messages: true, kyc: true,
      marketplace: true, trial: true, system: true,
    };
    const current = await loadNotifPrefs(auth);
    for (const k of Object.keys(current) as NotifPrefKey[]) next[k] = current[k];
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (isPrefKey(k)) next[k] = v !== false;
    }

    const merged = await saveNotifPrefs(auth, next);
    try {
      await audit(auth.store, auth.user, req, "notif_prefs.update", "user", auth.user.id, { keys: Object.keys(body) });
    } catch (e) { console.error("[audit]", e); }
    return NextResponse.json({ ok: true, prefs: merged });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ── Store helpers ─────────────────────────────────────────────────────────
// We talk directly to the users table via the supabase client exposed on the
// store (`sb()`). The store interface doesn't yet have a `getUserNotifPrefs`
// helper, and adding one to all three store implementations (supabase / prisma
// / mock) just for two boolean toggles is overkill — a targeted client update
// here is the same pattern used in /api/notifications/[id] DELETE.

async function loadNotifPrefs(auth: any): Promise<Record<NotifPrefKey, boolean>> {
  const { data, error } = await (auth.store as any)
    .sb()
    .from("users")
    .select("notif_prefs")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (error) throw error;
  return normalizePrefs(data?.notif_prefs);
}

async function saveNotifPrefs(
  auth: any,
  prefs: Record<NotifPrefKey, boolean>,
): Promise<Record<NotifPrefKey, boolean>> {
  const { error } = await (auth.store as any)
    .sb()
    .from("users")
    .update({ notif_prefs: prefs })
    .eq("id", auth.user.id);
  if (error) throw error;
  return prefs;
}
