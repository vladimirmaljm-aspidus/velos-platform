import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateBreachNotification,
  getDpaEmail,
  getDpoContactEmail,
} from "@/lib/compliance/breach-notification";
import type { SecurityIncident } from "@/lib/compliance/incident-response";

// Breach-notification unit tests.
//
// Covers:
//   - The Art. 33(3)(a)-(d) required sections appear in the email body.
//   - The `to`/`subject`/`replyTo` fields are correctly populated from
//     the configured env vars (DPA email, DPO contact).
//   - Missing fields (description / root_cause / mitigation_steps) are
//     filled with the Art. 33(4) follow-up placeholder, so the email
//     can be dispatched IMMEDIATELY to start the 72-hour clock.
//   - The email body is plain-text and survives any transport (no HTML
//     in the text body).

const BASE_INCIDENT: SecurityIncident = {
  id: "inc-test-1",
  tenant_id: null,
  type: "data_breach",
  severity: "high",
  status: "open",
  detected_at: "2024-06-15T08:30:00.000Z",
  reported_at: null,
  affected_tenants: ["t1", "t2"],
  affected_users: ["u1", "u2", "u3"],
  description: "Unauthorized access to the partners table — emails and tax_ids exposed.",
  root_cause: "Misconfigured RLS policy on partners table allowed tenant_id=null reads.",
  mitigation_steps: [
    "Rotated SUPABASE_SERVICE_ROLE_KEY.",
    "Patched RLS policy.",
    "Forced password reset for all users.",
  ],
  gdpr_notified: false,
  gdpr_notification_deadline: "2024-06-18T08:30:00.000Z",
};

describe("breach-notification — Art. 33(3)(a)–(d) coverage", () => {
  beforeEach(() => {
    process.env.BREACH_NOTIFICATION_DPA_EMAIL = "dpa@example.gov";
    process.env.BREACH_NOTIFICATION_DPO_EMAIL = "dpo@example.com";
  });
  afterEach(() => {
    delete process.env.BREACH_NOTIFICATION_DPA_EMAIL;
    delete process.env.BREACH_NOTIFICATION_DPO_EMAIL;
    delete process.env.NOREPLY_EMAIL;
  });

  it("populates to / replyTo / subject with the configured DPA + DPO", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.to).toBe("dpa@example.gov");
    expect(payload.replyTo).toBe("dpo@example.com");
    expect(payload.subject).toContain("GDPR Art. 33");
    expect(payload.subject).toContain("data_breach");
    expect(payload.subject).toContain("high");
    expect(payload.subject).toContain(BASE_INCIDENT.id);
  });

  it("includes section (a) — nature of the breach", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain("(a) Nature of the breach");
    expect(payload.body).toContain(BASE_INCIDENT.description!);
    expect(payload.body).toContain("Categories of personal data");
    expect(payload.body).toContain("Approximate number of data subjects: 3");
  });

  it("includes section (b) — DPO / contact point", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain("(b) DPO / contact point");
    expect(payload.body).toContain("dpo@example.com");
  });

  it("includes section (c) — likely consequences", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain("(c) Likely consequences");
    expect(payload.body).toContain(BASE_INCIDENT.root_cause!);
  });

  it("includes section (d) — measures taken / proposed", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain("(d) Measures taken / proposed");
    // Mitigation steps appear as a numbered list.
    expect(payload.body).toContain("1. Rotated SUPABASE_SERVICE_ROLE_KEY.");
    expect(payload.body).toContain("2. Patched RLS policy.");
    expect(payload.body).toContain("3. Forced password reset for all users.");
  });

  it("includes the incident id + detected_at + deadline in the header", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain(`Incident ID: ${BASE_INCIDENT.id}`);
    expect(payload.body).toContain(`Detected at:          ${BASE_INCIDENT.detected_at}`);
    expect(payload.body).toContain(
      `Notification deadline (Art. 33(1), 72h): ${BASE_INCIDENT.gdpr_notification_deadline}`,
    );
  });

  it("references Art. 33(4) for follow-up notifications in the closing", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain("Article 33(4)");
  });

  it("carries generatedAt + incidentId metadata for the audit trail", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.incidentId).toBe(BASE_INCIDENT.id);
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("breach-notification — Art. 33(4) follow-up placeholders", () => {
  beforeEach(() => {
    process.env.BREACH_NOTIFICATION_DPA_EMAIL = "dpa@example.gov";
    process.env.BREACH_NOTIFICATION_DPO_EMAIL = "dpo@example.com";
  });
  afterEach(() => {
    delete process.env.BREACH_NOTIFICATION_DPA_EMAIL;
    delete process.env.BREACH_NOTIFICATION_DPO_EMAIL;
  });

  it("fills the description with a follow-up placeholder when description is empty", () => {
    const inc: SecurityIncident = { ...BASE_INCIDENT, description: "" };
    const payload = generateBreachNotification(inc);
    expect(payload.body).toContain("(not yet determined");
    expect(payload.body).toContain("Art. 33(4)");
  });

  it("fills the root cause with a follow-up placeholder when root_cause is missing", () => {
    const inc: SecurityIncident = { ...BASE_INCIDENT, root_cause: null };
    const payload = generateBreachNotification(inc);
    expect(payload.body).toContain("(root cause under investigation");
    expect(payload.body).toContain("Art. 33(4)");
  });

  it("fills the mitigation section with a follow-up placeholder when steps are empty", () => {
    const inc: SecurityIncident = { ...BASE_INCIDENT, mitigation_steps: [] };
    const payload = generateBreachNotification(inc);
    expect(payload.body).toContain(
      "(no mitigation steps recorded yet",
    );
    expect(payload.body).toContain("Art. 33(4)");
  });

  it("still sends the email immediately (72-hour clock starts) even with missing fields", () => {
    // The whole point of the placeholder strategy: the email MUST be
    // dispatchable from the moment the incident is declared, even if
    // the controller doesn't yet know the root cause or full scope.
    const inc: SecurityIncident = {
      ...BASE_INCIDENT,
      description: "",
      root_cause: null,
      mitigation_steps: [],
    };
    const payload = generateBreachNotification(inc);
    // The email body is non-empty, contains all four Art. 33(3) sections,
    // and is dispatchable as-is.
    expect(payload.body.length).toBeGreaterThan(500);
    expect(payload.body).toContain("(a)");
    expect(payload.body).toContain("(b)");
    expect(payload.body).toContain("(c)");
    expect(payload.body).toContain("(d)");
  });
});

describe("breach-notification — env var fallbacks", () => {
  afterEach(() => {
    delete process.env.BREACH_NOTIFICATION_DPA_EMAIL;
    delete process.env.BREACH_NOTIFICATION_DPO_EMAIL;
    delete process.env.NOREPLY_EMAIL;
  });

  it("getDpaEmail falls back to the placeholder when no env var is set", () => {
    delete process.env.BREACH_NOTIFICATION_DPA_EMAIL;
    expect(getDpaEmail()).toBe("dpa@example.com");
  });

  it("getDpoContactEmail falls back to NOREPLY_EMAIL", () => {
    delete process.env.BREACH_NOTIFICATION_DPO_EMAIL;
    process.env.NOREPLY_EMAIL = "noreply@example.com";
    expect(getDpoContactEmail()).toBe("noreply@example.com");
  });

  it("getDpoContactEmail falls back to a default when no email env is set", () => {
    delete process.env.BREACH_NOTIFICATION_DPO_EMAIL;
    delete process.env.NOREPLY_EMAIL;
    expect(getDpoContactEmail()).toBe("security@example.com");
  });
});

describe("breach-notification — body is plain-text safe", () => {
  beforeEach(() => {
    process.env.BREACH_NOTIFICATION_DPA_EMAIL = "dpa@example.gov";
    process.env.BREACH_NOTIFICATION_DPO_EMAIL = "dpo@example.com";
  });
  afterEach(() => {
    delete process.env.BREACH_NOTIFICATION_DPA_EMAIL;
    delete process.env.BREACH_NOTIFICATION_DPO_EMAIL;
  });

  it("does not include any HTML tags in the text body", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    // The plain-text body must not contain HTML tags — it gets sent as
    // the `text` alternative of the email and pasted into webmail
    // compose windows without rendering.
    expect(payload.body).not.toMatch(/<\/?[a-z][^>]*>/i);
  });

  it("reflects the affected tenants count in the body", () => {
    const payload = generateBreachNotification(BASE_INCIDENT);
    expect(payload.body).toContain("Affected tenants:     2 tenant(s)");
  });
});
