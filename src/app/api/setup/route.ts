import { NextRequest, NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { getIp } from "@/lib/api/helpers";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// F-7 (Rate Limiting): 3 bootstrap attempts per IP per 60 minutes.
// /api/setup is gated by SETUP_TOKEN (when configured) AND a one-time
// "no admin exists yet" guard. Rate-limiting is defense-in-depth against:
//   • an attacker who somehow obtains SETUP_TOKEN brute-forcing usernames
//   • log noise / DoS from someone hitting the endpoint repeatedly
// 3/hour is generous — bootstrap happens once in the lifetime of a deploy.
const SETUP_RATE_LIMIT = { maxAttempts: 3, windowMs: 60 * 60 * 1000 };

export async function GET() {
  try {
    let needsSetup = false;
    try {
      const { getStore } = await import("@/lib/data/store");
      const store = await getStore();
      const tenants = await store.listTenants();
      if (tenants.length === 0) {
        needsSetup = true;
      } else {
        for (const t of tenants) {
          const users = await store.listUsers(t.id);
          if (users.some((u) => u.role === "admin" || u.role === "super_admin")) {
            needsSetup = false;
            break;
          }
          needsSetup = true;
        }
      }
    } catch {
      needsSetup = false;
    }
    return NextResponse.json({ needsSetup, nextStep: needsSetup ? "Call POST /api/setup to create admin user" : "Login with your credentials" });
  } catch {
    return NextResponse.json({ needsSetup: false });
  }
}

export async function POST(req: NextRequest) {
  try {
    // ── F-7: DB-backed per-IP rate limit ──────────────────────────────────
    // Defense-in-depth on top of the SETUP_TOKEN guard. Even an attacker
    // who somehow has SETUP_TOKEN gets capped at 3 bootstrap attempts per
    // hour per IP — they can't brute-force the admin username or DoS the
    // endpoint with pointless requests.
    const ip = getIp(req);
    const rl = await checkRateLimit(
      `setup:ip:${ip}`,
      SETUP_RATE_LIMIT.maxAttempts,
      SETUP_RATE_LIMIT.windowMs,
    );
    if (!rl.allowed) {
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "Too many setup attempts from this address. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    const backend = process.env.DB_BACKEND;
    if (backend !== "supabase") {
      return NextResponse.json({ error: "Setup only available when DB_BACKEND=supabase" }, { status: 400 });
    }
    let body: Record<string, string> = {};
    try { body = await req.json(); } catch {}
    // Extra bootstrap guard: when SETUP_TOKEN is configured, require it —
    // closes the window between a fresh deploy and the first admin login
    // where this endpoint would otherwise mint a super_admin for anyone.
    if (process.env.SETUP_TOKEN && body.setup_token !== process.env.SETUP_TOKEN) {
      return NextResponse.json({ error: "Invalid setup token." }, { status: 403 });
    }
    const username = body.username || process.env.ADMIN_USERNAME;
    const password = body.password || process.env.ADMIN_PASSWORD;
    const email = body.email || process.env.ADMIN_EMAIL;
    const fullName = body.full_name || "Administrator";
    if (!username || !password) return NextResponse.json({ error: "Admin credentials are required." }, { status: 400 });
    if (!email) return NextResponse.json({ error: "Admin email is required." }, { status: 400 });
    // FIX-V1: validate the bootstrap admin password against the platform-
    // wide policy. Previously this only checked `password.length < 8` —
    // a super_admin bootstrap password like "abcdefgh" passed. Falls
    // back to DEFAULT_POLICY (8+ upper/lower/number, no symbols) on a
    // fresh deploy where the security_config row doesn't exist yet —
    // the same shape the inline check enforced implicitly.
    const pwValidation = await validatePasswordWithPlatformPolicy(password);
    if (!pwValidation.ok) {
      return NextResponse.json({ error: pwValidation.errors.join(" ") }, { status: 400 });
    }
    const tenantName = body.tenant_name || "VELOS Trade";
    const { getStore } = await import("@/lib/data/store");
    const store = await getStore();
    const existingTenants = await store.listTenants();

    // Setup is a one-time bootstrap: once ANY tenant has an admin/super_admin
    // user, refuse further calls. Without this, an unauthenticated attacker
    // could POST here at any time and mint a fresh super_admin account.
    for (const t of existingTenants) {
      const users = await store.listUsers(t.id);
      if (users.some((u) => u.role === "admin" || u.role === "super_admin")) {
        return NextResponse.json({ error: "Setup already completed." }, { status: 403 });
      }
    }

    let tenant = existingTenants.find((t) => t.name === tenantName);
    if (!tenant) {
      tenant = await store.upsertTenant({ name: tenantName, legal_name: tenantName, country: "RS", currency: "EUR", plan: "enterprise", status: "active", max_users: 50 });
    }
    const existingUser = await store.getUserByUsername(username);
    if (existingUser) {
      return NextResponse.json({ message: "Setup already completed — admin user exists", tenant_id: tenant.id, user_id: existingUser.id, username: existingUser.username });
    }
    const passwordHash = await hashPassword(password);
    const admin = await store.upsertUser({ tenant_id: tenant.id, username, email, full_name: fullName, role: "super_admin", password_hash: passwordHash, active: true, permissions: ["*"], token_version: 1 });
    try {
      const existingSettings = await store.getErpSettings(tenant.id);
      if (!existingSettings) {
        await store.upsertErpSettings({ tenant_id: tenant.id, accounting_standard: "eu", default_currency: "EUR", vat_enabled: true, vat_rate: 20, auto_post_journal: false });
      }
    } catch (e) { console.warn("[setup] Could not create ERP settings:", e); }
    return NextResponse.json({ message: "Setup completed successfully!", tenant_id: tenant.id, user_id: admin.id, username, email, login_url: "/" });
  } catch (e: unknown) {
    console.error("[setup] Error:", e);
    return NextResponse.json({ error: "Setup failed" }, { status: 500 });
  }
}
