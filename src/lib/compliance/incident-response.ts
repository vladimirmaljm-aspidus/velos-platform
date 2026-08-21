// src/lib/compliance/incident-response.ts
// ----------------------------------------------------------------------------
// Security incident response runbook (audit P0-3 / Feature 3 — beyond-vault
// compliance tooling).
//
// Background
// ----------
// GDPR Article 33 requires notifying the supervisory authority of a
// personal-data breach within 72 hours of becoming aware of it. Article 34
// requires notifying affected data subjects without delay when the breach
// is likely to result in a high risk to their rights and freedoms. The
// platform had no incident-response framework — no runbook, no audit
// trail of who declared an incident and when, no automatic deadline
// tracking, no escalation path for missed deadlines.
//
// This module is the single source of truth for:
//   - The `SecurityIncident` shape (mirrors the `security_incidents` table
//     in migration 039_security_incidents.sql).
//   - The per-type response runbooks (`INCIDENT_RESPONSE_STEPS`).
//   - Deadline arithmetic (`getBreachNotificationDeadline` — 72 hours
//     from detection, per GDPR Art. 33(1)).
//   - The "is this notifiable?" decision (`shouldNotifyAuthority`).
//
// The HTTP routes under `/api/admin/incidents/*` are the CRUD + notify
// surface (super_admin only). The cron route
// `/api/cron/breach-notification-check` polls for approaching deadlines
// and escalates when a deadline is < 24h away and the authority has not
// been notified.
//
// Out of scope (left as follow-ups):
//   - Automatic detection (anomaly / SIEM integration). The current model
//     is human-declared — a super_admin opens an incident when they
//     become aware of a breach.
//   - Data-subject notification automation (Art. 34). The supervisory-
//     authority notification (Art. 33) is the time-critical one; data-
//     subject notification is broader and depends on the risk assessment.
//     The `shouldNotifyDataSubjects` helper below captures the policy but
//     the actual outbound comms are a follow-up.
// ----------------------------------------------------------------------------
export type IncidentType =
  | "data_breach"
  | "unauthorized_access"
  | "malware"
  | "system_compromise"
  | "phishing"
  | "other";

export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export type IncidentStatus =
  | "open"
  | "investigating"
  | "contained"
  | "resolved"
  | "reported";

/**
 * The canonical incident record. Mirrors the `security_incidents` table
 * columns (migration 039) — the API routes round-trip this shape between
 * the HTTP layer and Postgres.
 */
export interface SecurityIncident {
  id: string;
  /** NULL for platform-wide incidents (e.g. a key compromise); a tenant
   * UUID for tenant-scoped incidents (e.g. a partner portal breach). */
  tenant_id: string | null;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  detected_at: string; // ISO 8601 timestamp
  reported_at?: string | null; // ISO 8601 — when the authority was notified
  affected_tenants: string[]; // JSONB array in the DB
  affected_users: string[]; // JSONB array in the DB
  description: string;
  root_cause?: string | null;
  mitigation_steps?: string[]; // JSONB array
  /** True once the supervisory authority has been notified (Art. 33). */
  gdpr_notified: boolean;
  /** ISO 8601 — 72 hours after `detected_at` per Art. 33(1). */
  gdpr_notification_deadline?: string | null;
  created_by?: string | null; // super_admin user_id
  created_at?: string;
  updated_at?: string;
}

/**
 * The per-type incident-response runbook. Each entry is an ordered list
 * of steps — the first step is the immediate containment action, the
 * last step is the post-incident review.
 *
 * These runbooks are surfaced in the admin UI next to the incident form
 * so the on-call super_admin sees the right playbook the moment they
 * declare the incident type.
 */
export const INCIDENT_RESPONSE_STEPS: Record<IncidentType, string[]> = {
  data_breach: [
    "1. Identify scope of breach (what data, how many users, which tenants).",
    "2. Contain the breach (revoke access, rotate keys, block IPs).",
    "3. Assess if it's a notifiable breach (GDPR Art. 33 — likely yes if personal data).",
    "4. Notify DPO (if applicable) and legal counsel.",
    "5. Prepare breach notification to supervisory authority (within 72 hours).",
    "6. Notify affected data subjects (if high risk — GDPR Art. 34).",
    "7. Document everything for audit trail (this incident record + audit_logs).",
    "8. Post-incident review and prevention measures.",
  ],
  unauthorized_access: [
    "1. Revoke compromised credentials (password reset, token_version bump).",
    "2. Review audit logs for the affected user/tenant.",
    "3. Check for lateral movement (other accounts accessed).",
    "4. Force password reset for all users in affected tenant.",
    "5. Review and update access controls (RBAC grants, API keys, sessions).",
    "6. Document incident and root cause.",
  ],
  malware: [
    "1. Isolate affected systems (take offline if possible).",
    "2. Identify the malware strain and entry vector.",
    "3. Run full AV/EDR scan on all hosts in the affected tenant.",
    "4. Restore from known-clean backup if data was encrypted/exfiltrated.",
    "5. Patch the entry vector (vulnerability, phishing vector, supply chain).",
    "6. Document incident and post-incident review.",
  ],
  system_compromise: [
    "1. Rotate ALL secrets (SECRET_KEY, JWT_SECRET_KEY, VAULT_KEY_V2, FIELD_ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_TOKEN).",
    "2. Revoke every active session (bump token_version for all users).",
    "3. Review every super_admin action in audit_logs for the compromise window.",
    "4. Inspect deployed code for backdoors (git diff against last known-good commit).",
    "5. Notify tenants whose data was accessible to the attacker.",
    "6. Forensic snapshot of the DB + filesystem for evidence.",
    "7. Document incident, root cause, and remediation.",
  ],
  phishing: [
    "1. Identify the phishing vector (email, fake login page, etc.).",
    "2. Block the sender / URL at the perimeter (email gateway, WAF).",
    "3. Force password reset + 2FA re-enrollment for users who clicked.",
    "4. Notify affected users with a security advisory.",
    "5. Train staff on the phishing pattern (post-incident).",
    "6. Document incident.",
  ],
  other: [
    "1. Identify the scope and impact of the incident.",
    "2. Contain and mitigate the immediate threat.",
    "3. Document the incident type and root cause.",
    "4. Determine if GDPR / SOC 2 / contractual notification is required.",
    "5. Notify stakeholders as appropriate.",
    "6. Post-incident review.",
  ],
};

/**
 * Compute the GDPR Art. 33(1) supervisory-authority notification deadline
 * for an incident: 72 hours after the detection timestamp.
 *
 * Returns an ISO 8601 string. The cron route uses this to escalate when
 * the deadline is < 24 hours away and the authority has not yet been
 * notified.
 */
export function getBreachNotificationDeadline(detectedAt: string): string {
  return new Date(
    new Date(detectedAt).getTime() + 72 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Decide whether a given incident must be reported to the supervisory
 * authority.
 *
 * GDPR Art. 33(1): notify UNLESS the breach is "unlikely to result in a
 * risk to the rights and freedoms of natural persons". The platform
 * interprets this conservatively: ANY high-severity or critical-severity
 * incident involving personal data is treated as notifiable. Low and
 * medium severity are typically not (e.g. a single user's account briefly
 * accessed, contained and remediated). The super_admin can override by
 * manually triggering the notify endpoint regardless.
 */
export function shouldNotifyAuthority(incident: SecurityIncident): boolean {
  return incident.severity === "high" || incident.severity === "critical";
}

/**
 * Decide whether affected data subjects must be notified (Art. 34).
 *
 * Art. 34(1): notify data subjects WITHOUT undue delay when the breach
 * "is likely to result in a high risk to the rights and freedoms" of
 * natural persons. The platform interprets this as critical-severity
 * incidents involving personal data — a step above the Art. 33 threshold.
 */
export function shouldNotifyDataSubjects(incident: SecurityIncident): boolean {
  return incident.severity === "critical";
}

/**
 * Returns the remaining time (ms) until the notification deadline.
 * Negative if the deadline has passed (the cron escalates these).
 */
export function msUntilDeadline(incident: SecurityIncident): number {
  const deadline =
    incident.gdpr_notification_deadline ||
    getBreachNotificationDeadline(incident.detected_at);
  return new Date(deadline).getTime() - Date.now();
}

/**
 * Has the GDPR 72-hour notification deadline passed WITHOUT the authority
 * being notified? The cron escalates these to a P0 alert (slack / sentry
 * / webhook).
 */
export function isDeadlineBreached(incident: SecurityIncident): boolean {
  if (incident.gdpr_notified) return false;
  return msUntilDeadline(incident) < 0;
}

/**
 * Is the deadline approaching? Used by the cron to escalate incidents
 * that are within `withinMs` of their deadline and have not yet been
 * notified. Default `withinMs` is 24 hours (the cron's escalation window).
 */
export function isDeadlineApproaching(
  incident: SecurityIncident,
  withinMs: number = 24 * 60 * 60 * 1000,
): boolean {
  if (incident.gdpr_notified) return false;
  const remaining = msUntilDeadline(incident);
  // 0 < remaining < withinMs → approaching. Negative (already breached)
  // is handled separately by `isDeadlineBreached`.
  return remaining > 0 && remaining < withinMs;
}

/**
 * The set of incident types that involve personal data and therefore
 * trigger Art. 33 notification (subject to `shouldNotifyAuthority`).
 * Used by the cron's escalation logic — incidents whose type is not in
 * this set are still tracked but don't count toward the 72-hour clock.
 */
export const NOTIFIABLE_INCIDENT_TYPES: ReadonlySet<IncidentType> = new Set([
  "data_breach",
  "unauthorized_access",
  "system_compromise",
  "phishing",
  "other", // conservative — assume personal data until proven otherwise
]);
