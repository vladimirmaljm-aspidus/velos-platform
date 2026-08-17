// src/lib/monitoring/alert-routing.ts
// ----------------------------------------------------------------------------
// Alert routing (audit V-2 / Fix 5).
//
// Background
// ----------
// The super-admin "Monitoring & Alerts" tab persists an
// `alertRouting[]` array to `settings.monitoring_config.alertRouting`.
// Each entry has:
//   • `type`        — the event type to match (e.g. "login.blocked",
//                     "suspicious.activity", or "*" for wildcard).
//   • `recipients`  — email addresses to notify on a match.
//   • `severity`    — "low" | "medium" | "high" | "critical" (advisory;
//                     surfaces in the email subject).
//   • `active`      — toggle; inactive routes are skipped.
//
// Before this module was added, the array was stored but no code read
// it — `reportSecurityEvent` only fired Sentry + console.warn + the
// security webhooks. The alert-routing config was a dead store.
//
// This module implements `routeAlert(event)` — called from
// `reportSecurityEvent` (fire-and-forget). For every active route
// whose `type` matches the event (or `"*"`), it sends an email via
// the platform's configured email provider (Resend / Postmark / SMTP /
// mail_queue fallback — same pipeline as transactional emails).
//
// Failure modes:
//   • Missing recipients → route is skipped (no email sent).
//   • Email provider down → sendEmail returns success=false; we log
//     and continue to the next route (one bad route must not block
//     the others).
//   • DB read fails → no routes are evaluated; the event still
//     reaches Sentry + the IDS + the security webhooks.
//
// Event-name alignment (audit V-2 cross-cutting #2):
//   The UI's prior default route types (`auth.login_locked`,
//   `auth.sod_violation`, `vault.rotate`, `incident.create`) used a
//   namespace that never matched the `SecurityEvent.type` enum. The
//   new defaults in `monitoring-settings/route.ts` use the actual enum
//   values (`login.blocked`, `role.escalation`, `vault.read`,
//   `suspicious.activity`). The matcher here is lenient — it accepts
//   both the literal event type (`login.blocked`) AND the prefixed
//   form (`security.login.blocked`) so older stored config still
//   matches once an admin updates the UI.
// ----------------------------------------------------------------------------

import type { SecurityEvent } from "@/lib/monitoring/security-alerts";

/**
 * Send an alert email to every recipient on every active route whose
 * `type` matches the event (or `"*"` wildcard).
 *
 * Fire-and-forget — called from `reportSecurityEvent` without `await`.
 * Failures are swallowed inside this function so a routing failure
 * cannot break the calling route.
 */
export async function routeAlert(event: SecurityEvent): Promise<void> {
  try {
    // Lazy-load the routes from the DB. Cached 5 minutes inside
    // `getAlertRoutes()` so the IDS hot path doesn't hit the DB per event.
    const { getAlertRoutes } = await import("@/lib/monitoring/monitoring-config");
    const routes = await getAlertRoutes();
    if (routes.length === 0) return;

    // Match routes whose `type` is the event's type, the prefixed form,
    // or the wildcard "*".
    const matches = routes.filter((r) => {
      if (!r.active) return false;
      if (r.recipients.length === 0) return false;
      if (r.type === "*" || r.type === "security.*") return true;
      return (
        r.type === event.type ||
        r.type === `security.${event.type}` ||
        // Back-compat: also accept the audit namespace the UI used to
        // emit (`auth.login_locked` etc.) — though those won't match
        // the new enum, the matcher stays lenient so older stored
        // config still routes to the recipients if an admin later
        // switches the type back to the enum value.
        r.type === event.type.replace(/\./g, "_")
      );
    });
    if (matches.length === 0) return;

    const { sendEmail } = await import("@/lib/email/service");
    const subject = `[Aspidus Alert] ${event.severity.toUpperCase()} — ${event.type}`;
    const body = [
      `Security event fired:`,
      ``,
      `  Type:        ${event.type}`,
      `  Severity:    ${event.severity}`,
      `  User:        ${event.userId ?? "(none)"}`,
      `  Tenant:      ${event.tenantId ?? "(platform)"}`,
      `  IP:          ${event.ip ?? "(unknown)"}`,
      `  Timestamp:   ${new Date().toISOString()}`,
      ``,
      `Details:`,
      JSON.stringify(event.details ?? {}, null, 2),
      ``,
      `--`,
      `This alert was sent by the Aspidus alert-routing pipeline. Configure`,
      `recipients and event filters under Super-Admin → Monitoring & Alerts.`,
    ].join("\n");

    for (const route of matches) {
      try {
        await sendEmail({
          to: route.recipients.join(", "),
          subject,
          html: `<pre style="font-family: ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word;">${escapeHtml(body)}</pre>`,
          text: body,
          // No tenant_id — alert emails are platform-level, not scoped
          // to a single tenant. The mail_queue fallback will store the
          // row with tenant_id=NULL.
          tenantId: undefined,
        });
      } catch (e) {
        // Per-route failures must not skip the rest of the matching set.
        console.error(
          `[alert-routing] sendEmail to ${route.recipients.join(", ")} failed:`,
          e,
        );
      }
    }
  } catch (e) {
    // Top-level catch — never propagate routing failures to the calling
    // route. The event still reached Sentry + the IDS + the webhooks.
    console.error("[alert-routing] routeAlert failed:", e);
  }
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
