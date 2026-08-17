// src/lib/compliance/breach-notification.ts
// ----------------------------------------------------------------------------
// Breach notification generator (audit P0-3 / Feature 4 — automated
// breach notification process).
//
// Companion to `src/lib/compliance/incident-response.ts`. Produces the
// GDPR-compliant supervisory-authority notification email body for a
// given security incident.
//
// GDPR Article 33(3) requires the notification to AT MINIMUM describe:
//   (a) the nature of the breach including, where possible, the categories
//       and approximate number of data subjects and personal data records
//       concerned;
//   (b) the name and contact details of the data protection officer or
//       other contact point where more information can be obtained;
//   (c) the likely consequences of the breach;
//   (d) the measures taken or proposed to be taken by the controller
//       to address the breach and, where appropriate, to mitigate its
//       possible adverse effects.
//
// This module produces a template covering (a)-(d); the super_admin
// filling out the incident record is expected to fill in the
// incident-specific narrative (description, root_cause, mitigation_steps).
// ----------------------------------------------------------------------------
import type { SecurityIncident } from "@/lib/compliance/incident-response";

/**
 * The supervisory authority's email address. Configurable per
 * deployment (different tenants may fall under different DPAs — e.g.
// the Austrian DSB vs. the Irish DPC). Defaults to a placeholder so
// a missing env var surfaces in the email body itself rather than
 * silently sending to a wrong address.
 */
const DEFAULT_DPA_EMAIL = "dpa@example.com";

export function getDpaEmail(): string {
  return process.env.BREACH_NOTIFICATION_DPA_EMAIL || DEFAULT_DPA_EMAIL;
}

/**
 * The DPO / on-call security contact's email — used as the Reply-To
 * address on the outbound notification so the supervisory authority can
 * reach a human. Defaults to the platform's NOREPLY_EMAIL (so it never
 * bounces) but SHOULD be overridden with a real DPO address in
 * production.
 */
export function getDpoContactEmail(): string {
  return process.env.BREACH_NOTIFICATION_DPO_EMAIL || process.env.NOREPLY_EMAIL || "security@example.com";
}

/**
 * The outbound notification payload — `to` is the supervisory authority,
 * `subject` and `body` are GDPR-Art. 33(3)-compliant.
 */
export interface BreachNotificationPayload {
  to: string;
  cc?: string;
  replyTo: string;
  subject: string;
  body: string;
  /** ISO 8601 — when this notification was generated. */
  generatedAt: string;
  /** The incident id, for the audit trail. */
  incidentId: string;
}

/**
 * Generate the GDPR-compliant breach notification email for a given
 * incident.
 *
 * The body is plain-text (not HTML) so it survives any transport —
 * outbound SMTP, Postmark, Resend, even a manual paste into a webmail
 * compose window — without rendering differences. The fields (a)-(d)
 * of Art. 33(3) are clearly labeled so the DPA can quickly triage.
 *
 * If the incident is missing `description`, `root_cause`, or
 * `mitigation_steps`, the corresponding section is filled with a
 * placeholder ("Not yet determined — to be provided in a follow-up
 * notification within the meaning of Art. 33(4)") so the email can be
 * sent IMMEDIATELY to start the 72-hour clock, with follow-up
 * notifications filling in the details as they become available.
 */
export function generateBreachNotification(
  incident: SecurityIncident,
): BreachNotificationPayload {
  const generatedAt = new Date().toISOString();
  const deadline =
    incident.gdpr_notification_deadline ||
    new Date(
      new Date(incident.detected_at).getTime() + 72 * 60 * 60 * 1000,
    ).toISOString();
  const affectedTenantsCount = incident.affected_tenants?.length ?? 0;
  const affectedUsersCount = incident.affected_users?.length ?? 0;
  const mitigation = (incident.mitigation_steps ?? []).length > 0
    ? incident.mitigation_steps!.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
    : "  (no mitigation steps recorded yet — to be provided in a follow-up notification per Art. 33(4))";
  const description = incident.description?.trim() ||
    "(not yet determined — to be provided in a follow-up notification per Art. 33(4))";
  const rootCause = incident.root_cause?.trim() ||
    "(root cause under investigation — to be provided in a follow-up notification per Art. 33(4))";

  const body = [
    `GDPR Article 33(1) — Personal Data Breach Notification`,
    ``,
    `To: Supervisory Authority`,
    `From: ${process.env.APP_BASE_URL || "VELOS CRM"} (controller)`,
    `Reply-To: ${getDpoContactEmail()}`,
    `Generated at: ${generatedAt}`,
    `Incident ID: ${incident.id}`,
    ``,
    `── Summary ────────────────────────────────────────────────────────────`,
    ``,
    `Incident type:        ${incident.type}`,
    `Severity:             ${incident.severity}`,
    `Status:               ${incident.status}`,
    `Detected at:          ${incident.detected_at}`,
    `Notification deadline (Art. 33(1), 72h): ${deadline}`,
    `Affected tenants:     ${affectedTenantsCount} tenant(s)`,
    `Affected data subjects (users): ${affectedUsersCount} user(s)`,
    ``,
    `── (a) Nature of the breach (Art. 33(3)(a)) ─────────────────────────`,
    ``,
    description,
    ``,
    `Categories of personal data concerned: (to be specified by the controller`,
    `based on the specific tables / fields exposed by this breach — see the`,
    `incident record's description field for details.)`,
    ``,
    `Approximate number of data subjects: ${affectedUsersCount} (per the`,
    `incident record's affected_users list; the actual count may be higher`,
    `if the breach exposed bulk tables — the controller will provide a`,
    `refined estimate in the follow-up notification per Art. 33(4).)`,
    ``,
    `── (b) DPO / contact point (Art. 33(3)(b)) ──────────────────────────`,
    ``,
    `Data Protection Officer / on-call security contact:`,
    `  ${getDpoContactEmail()}`,
    ``,
    `── (c) Likely consequences (Art. 33(3)(c)) ───────────────────────────`,
    ``,
    `Root cause:`,
    `  ${rootCause}`,
    ``,
    `Likely consequences: (to be assessed by the controller based on the`,
    `nature of the exposed data; typical consequences for ${incident.type}`,
    `incidents include: unauthorized access to personal data, potential`,
    `identity theft, phishing targeting the affected data subjects, etc.)`,
    ``,
    `── (d) Measures taken / proposed (Art. 33(3)(d)) ────────────────────`,
    ``,
    `Mitigation steps:`,
    mitigation,
    ``,
    `── End of notification ────────────────────────────────────────────────`,
    ``,
    `This notification is generated in accordance with Article 33 of the`,
    `EU General Data Protection Regulation (2016/679). Where information is`,
    `not yet available, it will be provided in a follow-up notification`,
    `without further undue delay, per Article 33(4).`,
  ].join("\n");

  return {
    to: getDpaEmail(),
    replyTo: getDpoContactEmail(),
    subject: `GDPR Art. 33 — Personal Data Breach Notification — ${incident.type} (${incident.severity}) — ${incident.id}`,
    body,
    generatedAt,
    incidentId: incident.id,
  };
}

/**
 * Fire the breach notification — sends the email via the configured
 * email provider (falling back to the mail_queue if no provider is
 * configured). Returns the send outcome so the calling route can
 * update the incident's `gdpr_notified` + `reported_at` fields and
 * audit the dispatch.
 *
 * Failure mode: if the email provider is unavailable, the notification
 * is queued (mail_queue), and the calling route should NOT mark the
 * incident as `gdpr_notified=true` — that flag is reserved for
 * successful dispatch. The cron will re-attempt until the deadline
 * passes (at which point it escalates to a P0 alert).
 */
export async function sendBreachNotification(
  incident: SecurityIncident,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const payload = generateBreachNotification(incident);
  try {
    const { sendEmail } = await import("@/lib/email/service");
    const result = await sendEmail({
      to: payload.to,
      replyTo: payload.replyTo,
      subject: payload.subject,
      html: `<pre style="font-family: ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word;">${escapeHtml(payload.body)}</pre>`,
      text: payload.body,
      // No tenant_id — breach notifications are platform-level, not
      // scoped to a single tenant. The mail_queue fallback will store
      // the row with tenant_id=NULL (see email/service.ts queue path).
      tenantId: undefined,
    });
    return {
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.message || String(e) || "Failed to send breach notification email",
    };
  }
}

/**
 * HTML-escape a string for safe interpolation into an HTML email body.
 * Re-implemented here (instead of importing from `lib/email/service.ts`)
 * to avoid a circular import — `sendBreachNotification` lazy-imports
 * `sendEmail` from that module, so importing the escape helper at module
 * load time would create a circular dep at evaluation time.
 */
function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
