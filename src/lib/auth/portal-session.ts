import { getSessionFromCookie } from "@/lib/auth/session";
import { getStore } from "@/lib/data/store";
import type { PortalAccess } from "@/lib/supabase/types";

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
