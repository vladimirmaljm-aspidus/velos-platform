import { getSessionFromCookie } from "@/lib/auth/session";
import { getStore } from "@/lib/data/store";
import type { PortalAccess } from "@/lib/supabase/types";
// 8b-2 / 8d-9: load SessionConfig for the same TTL values that `requireAuth`
// uses for admin sessions — so a super_admin who tightens `userTtlMs` /
// `idleTimeoutMs` (or removes the `portal_client` exemption if one is added
// in the future) gets the change enforced on portal sessions too. Without
// this, stolen portal cookies stayed valid for the full 7-day JWT `exp`
// cap regardless of the operator's idle / absolute TTL settings.
import { getSessionConfig, isAbsoluteTtlApplicable, isIdleTimeoutApplicable } from "@/lib/auth/session-config";

/**
 * Server-side helper that reads the portal session cookie and returns the
 * active PortalAccess row (or null when not signed in / signed in as admin).
 *
 * Centralised so every portal API route can use the same lookup + same
 * status checks (active, not locked) without duplicating the logic.
 *
 * AUDIT2-LOGIC-UX H4 — also checks the owning tenant's status. A portal
 * client whose tenant has been suspended / cancelled must NOT be able to
 * keep using the portal on a still-valid 7-day cookie. The login route
 * already rejects suspended tenants at sign-in; this closes the
 * "session already issued before suspension" hole for the ~6.9 days the
 * cookie would otherwise remain valid.
 *
 * 8b-2 / 8d-9 — also enforces the application-level absolute TTL
 * (`expires_at`) and idle timeout (`last_activity_at`) that `requireAuth`
 * has enforced for admin/super_admin sessions since the C1 fix. Portal
 * sessions used to bypass these checks entirely — a stolen cookie was
 * valid for up to 7 days regardless of the operator's TTL settings, and
 * the idle-timeout (30 min by default) was effectively a no-op because
 * portal routes never called `bumpSessionActivity` either. We now apply
 * the same checks (using `isAbsoluteTtlApplicable` / `isIdleTimeoutApplicable`
 * so future role-specific exemptions are honoured transparently).
 */
export async function getPortalSessionAccess(): Promise<PortalAccess | null> {
  const session = await getSessionFromCookie();
  if (!session || session.role !== "portal_client") return null;
  if (!session.sub?.startsWith("portal:")) return null;

  const accessId = session.sub.slice("portal:".length);
  const store = await getStore();
  const access = await store.getPortalAccessById(accessId);
  if (!access) return null;
  if (access.status !== "active") return null;
  // Reject stale JWTs: token_version is bumped whenever the password changes
  // or access is revoked, so old sessions stop working immediately instead
  // of remaining valid for the rest of their 7-day cookie lifetime.
  if ((session.token_version || 0) !== (access.token_version || 0)) return null;

  // 8b-2 / 8d-9 — application-level TTL checks mirroring `requireAuth`.
  // Portal_client role is included by `isAbsoluteTtlApplicable` /
  // `isIdleTimeoutApplicable` (both return `true` for every role after
  // the C1 fix removed the super_admin permanent-session backdoor). A
  // super_admin who tightens these in /api/settings/session-config now
  // sees the change applied to portal sessions on the next request —
  // not just admin sessions.
  try {
    const config = await getSessionConfig();
    if (
      isAbsoluteTtlApplicable(session.role) &&
      typeof session.expires_at === "number" &&
      session.expires_at < Date.now()
    ) {
      return null;
    }
    if (
      isIdleTimeoutApplicable(session.role) &&
      typeof session.last_activity_at === "number" &&
      Date.now() - session.last_activity_at > config.idleTimeoutMs
    ) {
      return null;
    }
  } catch (e) {
    // If the config can't be loaded, fall back to the previous behaviour
    // (trust the JWT exp). Failing closed here would lock every portal
    // client out if the config store had a transient blip — and the JWT
    // `exp` cap (7d) still bounds the session.
    console.warn("[getPortalSessionAccess] SessionConfig load failed — TTL check skipped:", e);
  }

  // AUDIT2-LOGIC-UX H4 — block when the owning tenant is suspended /
  // cancelled. A still-valid cookie would otherwise keep the portal
  // client logged in until the cookie expires. We accept the extra
  // tenant lookup (it's cheap: indexed by PK and the result is cached
  // by the underlying store) — the cost is negligible compared with
  // letting a suspended tenant's clients keep operating.
  const tenant = await store.getTenant(access.tenant_id);
  if (!tenant || tenant.status === "suspended" || tenant.status === "cancelled") {
    return null;
  }
  return access;
}
