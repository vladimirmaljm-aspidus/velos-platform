import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  INCIDENT_RESPONSE_STEPS,
  getBreachNotificationDeadline,
  shouldNotifyAuthority,
  shouldNotifyDataSubjects,
  msUntilDeadline,
  isDeadlineBreached,
  isDeadlineApproaching,
  NOTIFIABLE_INCIDENT_TYPES,
  type SecurityIncident,
} from "@/lib/compliance/incident-response";

// Incident-response unit tests.
//
// Covers:
//   - the per-type runbook is complete (no missing type → undefined).
//   - the deadline arithmetic (72 hours from detection, per Art. 33(1)).
//   - the notifiability decision (severity thresholds).
//   - the deadline-approaching / deadline-breached predicates.
//   - the set of notifiable incident types.

function makeIncident(over: Partial<SecurityIncident>): SecurityIncident {
  const detectedAt = over.detected_at || "2024-01-01T00:00:00.000Z";
  return {
    id: "inc-1",
    tenant_id: null,
    type: "data_breach",
    severity: "high",
    status: "open",
    detected_at: detectedAt,
    reported_at: null,
    affected_tenants: [],
    affected_users: [],
    description: "test incident",
    root_cause: null,
    mitigation_steps: [],
    gdpr_notified: false,
    gdpr_notification_deadline: getBreachNotificationDeadline(detectedAt),
    ...over,
  } as SecurityIncident;
}

describe("incident-response — runbook completeness", () => {
  const ALL_TYPES = [
    "data_breach",
    "unauthorized_access",
    "malware",
    "system_compromise",
    "phishing",
    "other",
  ] as const;

  it("has a runbook for every incident type", () => {
    for (const t of ALL_TYPES) {
      expect(INCIDENT_RESPONSE_STEPS[t]).toBeDefined();
      expect(Array.isArray(INCIDENT_RESPONSE_STEPS[t])).toBe(true);
      expect(INCIDENT_RESPONSE_STEPS[t].length).toBeGreaterThan(0);
    }
  });

  it("orders each runbook step with a numeric prefix (1., 2., ...)", () => {
    for (const t of ALL_TYPES) {
      const steps = INCIDENT_RESPONSE_STEPS[t];
      for (let i = 0; i < steps.length; i++) {
        const prefix = steps[i].match(/^\s*(\d+)\./);
        expect(prefix, `step ${i} of ${t} should start with N.`).not.toBeNull();
      }
    }
  });

  it("covers containment, notification, documentation, review in data_breach runbook", () => {
    const steps = INCIDENT_RESPONSE_STEPS.data_breach.join(" ").toLowerCase();
    expect(steps).toContain("contain");
    expect(steps).toContain("72 hours");
    expect(steps).toContain("notify");
    expect(steps).toContain("audit");
    expect(steps).toContain("review");
  });

  it("covers key rotation in system_compromise runbook", () => {
    const steps = INCIDENT_RESPONSE_STEPS.system_compromise.join(" ").toLowerCase();
    // The system_compromise runbook explicitly lists the keys to rotate.
    expect(steps).toContain("jwt_secret_key");
    expect(steps).toContain("vault_key_v2");
    expect(steps).toContain("field_encryption_key");
    expect(steps).toContain("secret_key");
    expect(steps).toContain("supabase_service_role_key");
  });
});

describe("incident-response — GDPR Art. 33 deadline", () => {
  it("deadline = detected_at + 72 hours, per Art. 33(1)", () => {
    const detectedAt = "2024-06-15T08:30:00.000Z";
    const deadline = getBreachNotificationDeadline(detectedAt);
    // 72 hours later, same wall-clock time.
    expect(deadline).toBe("2024-06-18T08:30:00.000Z");
  });

  it("deadline is exactly 72*60*60*1000 ms after detection", () => {
    const detectedAt = "2024-01-01T00:00:00.000Z";
    const deadline = getBreachNotificationDeadline(detectedAt);
    const diff = new Date(deadline).getTime() - new Date(detectedAt).getTime();
    expect(diff).toBe(72 * 60 * 60 * 1000);
  });

  it("handles a detected_at with timezone offset correctly", () => {
    // detected_at with explicit offset — should still produce a UTC deadline.
    const detectedAt = "2024-01-01T00:00:00+02:00";
    const deadline = getBreachNotificationDeadline(detectedAt);
    // +02:00 means 22:00Z the previous day; +72h = 22:00Z on Jan 3.
    expect(deadline).toBe("2024-01-03T22:00:00.000Z");
  });
});

describe("incident-response — notifiability decisions", () => {
  it("shouldNotifyAuthority = true for high and critical severity", () => {
    expect(shouldNotifyAuthority(makeIncident({ severity: "high" }))).toBe(true);
    expect(shouldNotifyAuthority(makeIncident({ severity: "critical" }))).toBe(true);
  });

  it("shouldNotifyAuthority = false for low and medium severity (conservative default)", () => {
    expect(shouldNotifyAuthority(makeIncident({ severity: "low" }))).toBe(false);
    expect(shouldNotifyAuthority(makeIncident({ severity: "medium" }))).toBe(false);
  });

  it("shouldNotifyDataSubjects = true only for critical severity", () => {
    expect(shouldNotifyDataSubjects(makeIncident({ severity: "critical" }))).toBe(true);
    expect(shouldNotifyDataSubjects(makeIncident({ severity: "high" }))).toBe(false);
    expect(shouldNotifyDataSubjects(makeIncident({ severity: "medium" }))).toBe(false);
    expect(shouldNotifyDataSubjects(makeIncident({ severity: "low" }))).toBe(false);
  });

  it("NOTIFIABLE_INCIDENT_TYPES includes data_breach, unauthorized_access, system_compromise, phishing, other (excludes only malware)", () => {
    expect(NOTIFIABLE_INCIDENT_TYPES.has("data_breach")).toBe(true);
    expect(NOTIFIABLE_INCIDENT_TYPES.has("unauthorized_access")).toBe(true);
    expect(NOTIFIABLE_INCIDENT_TYPES.has("system_compromise")).toBe(true);
    expect(NOTIFIABLE_INCIDENT_TYPES.has("phishing")).toBe(true);
    expect(NOTIFIABLE_INCIDENT_TYPES.has("other")).toBe(true);
    // Malware is NOT in the notifiable set — pure malware without a
    // personal-data exposure is not automatically Art. 33 notifiable
    // (the super_admin can still manually notify via the /notify endpoint).
    expect(NOTIFIABLE_INCIDENT_TYPES.has("malware")).toBe(false);
  });
});

describe("incident-response — deadline escalation predicates", () => {
  it("msUntilDeadline is positive when deadline is in the future", () => {
    // Detected 1 hour ago → deadline is ~71 hours away. Allow a 1-second
    // tolerance band around 71h so the test is robust to execution delay
    // between the `new Date()` snapshot and the predicate evaluation.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: oneHourAgo });
    const remaining = msUntilDeadline(inc);
    const seventyOneHoursMs = 71 * 60 * 60 * 1000;
    expect(remaining).toBeGreaterThan(seventyOneHoursMs - 1000);
    expect(remaining).toBeLessThan(seventyOneHoursMs + 1000);
  });

  it("msUntilDeadline is negative when deadline has passed", () => {
    // Detected 100 hours ago → deadline was 28 hours ago.
    const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: longAgo });
    expect(msUntilDeadline(inc)).toBeLessThan(0);
  });

  it("isDeadlineBreached = true when deadline has passed and not yet notified", () => {
    const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: longAgo, gdpr_notified: false });
    expect(isDeadlineBreached(inc)).toBe(true);
  });

  it("isDeadlineBreached = false when already notified (no escalation)", () => {
    const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const inc = makeIncident({
      detected_at: longAgo,
      gdpr_notified: true,
    });
    expect(isDeadlineBreached(inc)).toBe(false);
  });

  it("isDeadlineApproaching = true when deadline is < 24h away", () => {
    // Detected 50 hours ago → deadline is 22 hours away (< 24h).
    const past = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: past });
    expect(isDeadlineApproaching(inc, 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("isDeadlineApproaching = false when deadline is > 24h away", () => {
    // Detected 1 hour ago → deadline is 71 hours away (> 24h).
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: past });
    expect(isDeadlineApproaching(inc, 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("isDeadlineApproaching = false when already notified", () => {
    const past = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: past, gdpr_notified: true });
    expect(isDeadlineApproaching(inc, 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("isDeadlineApproaching = false when deadline already breached (negative remaining)", () => {
    const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const inc = makeIncident({ detected_at: longAgo, gdpr_notified: false });
    // Already breached → not "approaching" (the cron handles breached
    // separately via isDeadlineBreached).
    expect(isDeadlineApproaching(inc, 24 * 60 * 60 * 1000)).toBe(false);
    expect(isDeadlineBreached(inc)).toBe(true);
  });

  it("uses gdpr_notification_deadline if set (preferred over recomputing from detected_at)", () => {
    // detected_at is far in the past, but the stored deadline is far in
    // the future (e.g. the deadline was extended by a regulator). The
    // predicates must use the STORED deadline, not a recomputed one.
    const inc = makeIncident({
      detected_at: "2024-01-01T00:00:00.000Z", // long ago
      gdpr_notification_deadline: new Date(
        Date.now() + 10 * 60 * 60 * 1000,
      ).toISOString(), // 10 hours from now
    });
    expect(isDeadlineApproaching(inc, 24 * 60 * 60 * 1000)).toBe(true);
    expect(isDeadlineBreached(inc)).toBe(false);
  });
});
