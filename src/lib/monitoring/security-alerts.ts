/**
 * P0-2 (Monitoring) — Security event reporting pipeline.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Centralised "report a security-relevant event" sink for the whole platform.
 * Every notable security event — failed login, blocked login, role escalation,
 * super-admin impersonation start/stop, vault reveal, cross-tenant probe,
 * CSRF block, rate-limit hit, 2FA disable, permission denial, suspicious
 * activity — funnels through `reportSecurityEvent()`.
 *
 * The function is **synchronous** and **non-blocking** by design:
 *   1. Sentry `captureMessage` (no-op when `SENTRY_DSN` is unset — see
 *      `sentry.server.config.ts`).
 *   2. Prominent `console.warn` so the signal shows up in Render logs
 *      immediately (the same way `[AUDIT FAILED]` does).
 *   3. In-memory burst tracker — 5+ identical events from the same IP/user
 *      in 60 s auto-escalate to a `suspicious.activity` event.
 *   4. `detectAnomalies()` rolling-window IDS — runs the rule set from
 *      `src/lib/security/anomaly-detector.ts` over a 5-min event window
 *      (brute force, mass 2FA disable, cross-tenant probe, …).
 *   5. Asynchronous webhook fan-out to every tenant webhook whose `events`
 *      array carries `security.*` or `security.<type>` (fire-and-forget,
 *      non-blocking — never throws into the calling route).
 *
 * ── SUPER-ADMIN RULE ─────────────────────────────────────────────────────────
 *
 * "Super admin must NEVER be blocked." This module **reports** events; it does
 * **not** gate any route. Super-admin actions (impersonate, vault reads, role
 * escalation, …) are LOGGED for the audit trail but never block the
 * super-admin — the impersonate/vault/role-escalation routes still execute.
 * The only places that return early after `reportSecurityEvent` are existing
 * authorization gates (`requirePermission`, CSRF defense, rate limit) where
 * the caller was already denied; for super-admin callers those gates never
 * trigger because `can()` returns `true` for `role === "super_admin"`, the
 * CSRF check applies uniformly (a CSRF attack against a super-admin session
 * is the worst-case the defense exists to stop), and the rate limit applies
 * per-IP (super-admins also login from a single IP).
 *
 * ── RECURSION GUARD ──────────────────────────────────────────────────────────
 *
 * The burst tracker and the IDS both escalate to `suspicious.activity`. If
 * an `suspicious.activity` event itself re-entered both pipelines, every
 * escalation would spawn a second escalation, then a third, … infinite
 * recursion. The guard `if (event.type === "suspicious.activity")` in BOTH
 * the burst branch (below) and `detectAnomalies` (in anomaly-detector.ts)
 * breaks the cycle: suspicious events are still Sentry-reported, log-lined,
 * and webhook-fanned-out, but they neither re-burst nor re-trigger IDS rules.
 */

// Sentry is loaded lazily on the first security event so that importing this
// module (which happens transitively whenever a route imports `helpers.ts`)
// does NOT eagerly load the Sentry SDK in environments that don't need it —
// e.g. the unit test suite, where `@sentry/nextjs` is not mocked and loading
// it would pull in browser-only code paths. The laziness also means a Sentry
// init/transport failure cannot break the calling route (the rejection is
// swallowed inside `getSentry`).
type SentryModule = typeof import("@sentry/nextjs");
let _sentry: SentryModule | null | undefined;
function getSentry(): Promise<SentryModule | null> {
  if (_sentry === undefined) {
    _sentry = null; // mark as "loading attempted" so we don't retry on every event
    return import("@sentry/nextjs")
      .then((mod) => {
        _sentry = mod;
        return mod;
      })
      .catch(() => null);
  }
  return Promise.resolve(_sentry);
}

// Static import for the IDS — `detectAnomalies` is called inside
// `reportSecurityEvent`'s function body (lazily, at runtime) and
// `reportSecurityEvent` is called inside `detectAnomalies`'s rule evaluation
// (also lazily). The cycle between this module and anomaly-detector.ts is
// therefore safe in Node ESM: both exports are function declarations
// (hoisted), and neither is referenced at module top-level evaluation.
import { detectAnomalies } from "@/lib/security/anomaly-detector";

export interface SecurityEvent {
  type:
    | "login.failed"
    | "login.failed.burst"
    | "login.blocked"
    | "role.escalation"
    | "impersonate.start"
    | "impersonate.stop"
    | "vault.read"
    | "vault.reveal"
    | "cross.tenant.attempt"
    | "csrf.blocked"
    | "rate.limit.hit"
    | "2fa.disabled"
    | "permission.denied"
    | "password.reset"
    | "suspicious.activity";
  userId?: string;
  tenantId?: string;
  ip?: string;
  details?: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
  /**
   * Epoch milliseconds. Set by `detectAnomalies` when it caches the event in
   * its rolling window. Callers SHOULD leave this undefined — `reportSecurityEvent`
   * and the IDS both stamp `Date.now()` when they need a timestamp.
   */
  timestamp?: number;
}

// ── Burst tracker (per type+IP/userId) ──────────────────────────────────────
//
// Tracks how many times the same (event type, IP-or-userId) tuple has fired
// inside a 60 s window. At ≥5 the burst is escalated to a single
// `suspicious.activity` event (severity=critical) and the counter is reset so
// subsequent hits of the same type start a fresh burst window — this prevents
// re-escalation on every hit after the threshold (we already paged once for
// this burst).
//
// Module-scoped — survives across requests in the same Node.js process
// (single-instance Render deployment). On multi-replica deployments each
// replica tracks its own bursts; a follow-up could push these counters to
// Redis if cross-replica burst detection becomes necessary.
const eventCounts = new Map<string, { count: number; firstAt: number }>();
const BURST_THRESHOLD = 5;
const BURST_WINDOW_MS = 60_000;

/**
 * Reset the in-memory burst tracker. Used by tests; production code does not
 * normally call this. The rolling-window IDS in `anomaly-detector.ts` has its
 * own `clearAnomalyWindow()` for the same purpose on its side.
 */
export function clearBurstState(): void {
  eventCounts.clear();
}

/**
 * Report a security-relevant event.
 *
 * Never throws — every step is wrapped so a logging/Sentry/webhook failure
 * cannot break the calling route. Returns `void` (synchronous) so callers
 * can invoke it inline without `await`.
 */
export function reportSecurityEvent(event: SecurityEvent): void {
  // 1. Send to Sentry (no-op when SENTRY_DSN is unset — see
  //    sentry.server.config.ts). Loaded lazily so this module does not
  //    eagerly pull in the Sentry SDK on import.
  if (process.env.SENTRY_DSN) {
    getSentry()
      .then((Sentry) => {
        if (!Sentry) return;
        try {
          Sentry.captureMessage(`Security: ${event.type}`, {
            level:
              event.severity === "critical"
                ? "error"
                : event.severity === "warning"
                ? "warning"
                : "info",
            extra: { ...event },
            tags: {
              security_event: event.type,
              severity: event.severity,
            },
          });
        } catch {
          // Sentry init/transport failures must never break the calling route.
        }
      })
      .catch(() => {});
  }

  // 2. Prominent log — Render captures stderr/stdout, so this is the default
  //    signal trail when Sentry is not configured. Matches the `[AUDIT FAILED]`
  //    convention from `src/lib/api/helpers.ts`.
  console.warn(`[SECURITY] ${event.type}`, event);

  // 3. Burst detection — 5+ identical events from the same IP/userId in 60 s
  //    auto-escalate. Suspicious events themselves are excluded (they would
  //    re-escalate infinitely).
  if (event.type !== "suspicious.activity") {
    const key = `${event.type}:${event.ip || event.userId || "unknown"}`;
    const existing = eventCounts.get(key);
    const now = Date.now();

    if (existing && now - existing.firstAt < BURST_WINDOW_MS) {
      existing.count++;
      if (existing.count >= BURST_THRESHOLD) {
        // Escalate to suspicious.activity — the recursive call returns
        // immediately from the burst branch because the type is
        // "suspicious.activity" (the guard above). Recursion terminates.
        reportSecurityEvent({
          type: "suspicious.activity",
          ip: event.ip,
          userId: event.userId,
          tenantId: event.tenantId,
          details: {
            rule: "burst",
            originalEvent: event.type,
            count: existing.count,
          },
          severity: "critical",
        });
        // Reset so subsequent hits start a fresh burst — we already paged
        // once for this burst, no need to page on every extra hit.
        eventCounts.delete(key);
      }
    } else {
      eventCounts.set(key, { count: 1, firstAt: now });
    }
  }

  // 4. Rolling-window IDS — runs the rule set in anomaly-detector.ts.
  //    The detector itself calls back into `reportSecurityEvent` when a rule
  //    fires; the recursion guard in `detectAnomalies` (skip rules when the
  //    incoming event is `suspicious.activity`) prevents infinite loops.
  try {
    detectAnomalies(event);
  } catch {
    // Defensive — an IDS rule bug must never break the calling route.
  }

  // 5. Fire security webhook(s) — async, non-blocking. Fan-out is
  //    fire-and-forget; failures are swallowed inside `fireSecurityWebhook`.
  fireSecurityWebhook(event).catch(() => {});

  // 6. Alert routing — fire-and-forget email fan-out to recipients
  //    configured under Super-Admin → Monitoring & Alerts → Alert
  //    routing (audit V-2 / Fix 5). Same non-blocking contract as
  //    `fireSecurityWebhook`: a routing failure must never break the
  //    calling route.
  routeAlert(event).catch(() => {});
}

/**
 * Fire alert-routing emails for the event. Imported lazily to avoid a
 * static-import cycle: `alert-routing.ts` lazy-imports `sendEmail`
 * from `lib/email/service.ts`, which transitively imports
 * `lib/data/store.ts`, which in turn imports this module. The lazy
 * import keeps the cycle from forming at module-evaluation time.
 */
async function routeAlert(event: SecurityEvent): Promise<void> {
  try {
    const { routeAlert } = await import("@/lib/monitoring/alert-routing");
    await routeAlert(event);
  } catch {
    // Swallowed — see reportSecurityEvent module docstring.
  }
}

/**
 * Fire `security.<event.type>` to every tenant webhook whose `events` array
 * carries `security.*` or `security.<event.type>`.
 *
 * Implementation notes:
 *   • Uses the existing webhook delivery machinery in
 *     `src/lib/webhooks/deliver.ts` — payloads are HMAC-signed, persisted as
 *     `webhook_deliveries` rows (audit trail), retried by
 *     `/api/cron/webhook-retry`, and PII-sanitised by
 *     `sanitizeWebhookPayload` before being POSTed to the receiver.
 *   • Each matching webhook is fanned out to its OWN `tenant_id`. Super-admin
 *     events (no tenant scope) only reach webhooks that are tenant-owned —
 *     the `triggerWebhooks` helper refuses to broadcast without a tenantId
 *     so platform-internal events never leak to every tenant's endpoints.
 *   • All I/O is wrapped in try/catch so a webhook failure cannot break the
 *     calling route (the function returns void; the caller `.catch()`-es the
 *     returned promise as a fire-and-forget).
 */
async function fireSecurityWebhook(event: SecurityEvent): Promise<void> {
  try {
    // Only fan out when Supabase is configured (skip in mock/dev backends).
    const { isSupabaseConfigured, getSupabase } = await import(
      "@/lib/supabase/client"
    );
    if (!isSupabaseConfigured()) return;

    const supabase = getSupabase();
    // Pull ALL active webhooks across every tenant — security events are
    // platform-level signals, and the per-tenant filtering below scopes the
    // delivery to the webhook's own tenant_id. (RLS is bypassed because the
    // server uses the service_role key — see src/lib/supabase/client.ts.)
    const { data: webhooks, error } = await supabase
      .from("webhooks")
      .select("*")
      .eq("active", true);
    if (error) {
      console.error("[security-webhook] list webhooks failed:", error);
      return;
    }

    const matching = (webhooks || []).filter((w: any) => {
      const events: string[] = Array.isArray(w.events) ? w.events : [];
      return (
        events.includes("security.*") ||
        events.includes(`security.${event.type}`)
      );
    });
    if (matching.length === 0) return;

    // Lazy-load the delivery module + store — heavy imports are deferred so
    // the synchronous part of `reportSecurityEvent` stays fast.
    const { getStore } = await import("@/lib/data/store");
    const { triggerWebhooks } = await import("@/lib/webhooks/deliver");
    const store = await getStore();

    for (const webhook of matching) {
      const tenantId: string | null | undefined = webhook.tenant_id;
      // `triggerWebhooks` refuses to broadcast without a tenantId — skip
      // webhooks without one (super-admin-only webhooks aren't supported on
      // the webhook system today; security events for super-admin actions
      // still reach Sentry + the IDS + console).
      if (!tenantId) continue;
      try {
        await triggerWebhooks(
          store,
          tenantId,
          "security." + event.type,
          "security",
          event.userId || "system",
          {
            ...event,
            // Overwrite any caller-supplied timestamp so receivers see a
            // consistent, monotonic event time.
            timestamp: new Date().toISOString(),
          },
        );
      } catch (e) {
        // Per-webhook failures must not skip the rest of the matching set.
        console.error(
          `[security-webhook] delivery to ${webhook.id} (${webhook.url}) failed:`,
          e,
        );
      }
    }
  } catch (e) {
    // Top-level catch — never propagate webhook failures to the calling route.
    console.error("[security-webhook] fireSecurityWebhook failed:", e);
  }
}
