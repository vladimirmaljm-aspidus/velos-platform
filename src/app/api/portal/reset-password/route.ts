import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/data/store";
import { hashPassword } from "@/lib/auth/password";
import { validatePasswordWithPlatformPolicy } from "@/lib/auth/password-policy";
import { consumePasswordReset } from "@/lib/auth/password-reset";
import { getIp } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * POST /api/portal/reset-password
 * Body: { reset_token: "xxx", password: "newpassword123" }
 *
 * Consumes a single-use hashed token from `password_resets`, sets the new password,
 * and bumps token_version to invalidate any existing sessions.
 *
 * D-AUDIT-3: now validates against the platform-wide password policy
 * (super-admin Security tab) rather than the hard-coded DEFAULT_POLICY.
 */
export async function POST(req: NextRequest) {
  try {
    const { reset_token, password } = await req.json();
    if (!reset_token || !password) {
      return NextResponse.json({ error: "Reset token and password are required." }, { status: 400 });
    }
    const validation = await validatePasswordWithPlatformPolicy(password);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.errors.join(" ") }, { status: 400 });
    }

    const result = await consumePasswordReset(reset_token);
    if (!result.ok) {
      const msg =
        result.reason === "expired" ? "This reset link has expired. Please request a new one." :
        result.reason === "already_used" ? "This reset link has already been used. Please request a new one." :
        "Invalid reset token.";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (result.targetType !== "portal_access") {
      return NextResponse.json({ error: "Invalid reset token." }, { status: 400 });
    }

    const store = await getStore();
    const passwordHash = await hashPassword(password);
    const current = await store.getPortalAccessById(result.targetId!);
    if (!current) {
      return NextResponse.json({ error: "Account not found." }, { status: 400 });
    }

    await store.upsertPortalAccess({
      id: result.targetId!,
      password_hash: passwordHash,
      must_set_password: false,
      token_version: (current.token_version || 0) + 1,
    });

    await store.appendAudit({
      tenant_id: result.tenantId || null,
      user_id: null,
      username: `portal:${current.portal_email || result.targetId}`,
      action: "portal.password_reset_completed",
      entity_type: "portal_access",
      entity_id: result.targetId!,
      details: { email: current.portal_email },
      ip: getIp(req),
      user_agent: req.headers.get("user-agent") || null,
    });

    return NextResponse.json({ ok: true, message: "Password reset successfully. You can now log in." });
  } catch (e: any) {
    console.error("[portal.reset-password]", e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
