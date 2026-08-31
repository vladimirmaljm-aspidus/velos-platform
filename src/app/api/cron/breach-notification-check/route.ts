import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/api/cron-auth";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  isDeadlineApproaching,
  isDeadlineBreached,
  shouldNotifyAuthority,
  NOTIFIABLE_INCIDENT_TYPES,
  type SecurityIncident,
  type IncidentType,
} from "@/lib/compliance/incident-response";
import { sendBreachNotification } from "@/lib/compliance/breach-notification";
// 9b-N9: outbound webhook must be HMAC-signed so the receiver can verify
// authenticity + integrity. Uses the same `signPayload` primitive as the
// generic webhook delivery pipeline (`@/lib/webhooks/deliver`) — the
// receiver side can share the verification logic via `verifySignature`.
import { signPayload } from "@/lib/webhooks/deliver";

export const runtime = "nodejs";

/**
 * Cron endpoint — escalate security incidents whose GDPR Art. 33(1)
 * 72-hour supervisory-authority notification deadline is approaching or
 * already breached, and which have NOT yet been notified.
 *
 * Scheduled HOURLY at minute 0 via pg_cron — see migration
 * `039_security_incidents.sql`. The hourly cadence matches the deadline
 * granularity (hours, not minutes); running more often would not change
 * the outcome (an incident whose deadline is in 23 hours does not become
 * "more urgent" by polling every minute).
 *
 * Two escalation paths:
 *
 *   1. APPROACHING — deadline < 24h away, gdpr_notified=false.
 *      → Send the breach notification email automatically (Art. 33
 *        clock is at risk; if the operator has not already notified, the
 *        cron does it for them).
 *      → Emit an `incident.deadline.approaching` audit log entry.
 *      → Call the configured escalation webhook (BREACH_NOTIFICATION_WEBHOOK_URL,
 *        if set — typically Slack / PagerDuty / Opsgenie).
 *
 *   2. BREACHED — deadline in the past, gdpr_notified=false.
 *      → The 72-hour clock has expired. This is a P0 compliance event.
 *      → Retry the email dispatch (in case the original failure was
 *        transient — provider outage, mail_queue stuck, etc.).
 *      → Emit an `incident.deadline.breached` audit log entry with the
 *        overrun (deadline - now()).
 *      → Call the webhook with the overrun in the payload so the on-call
 *        escalation policy knows how late the notification is.
 *
 * Auth: same `authorizeCron` as the other cron routes — the pg_cron
 * caller supplies `Authorization: Bearer <CRON_TOKEN>`, OR a super_admin
 * session cookie (manual browser run from the admin UI).
 *
 * Idempotent: re-reads the incidents list each run. If a previous run
 * already dispatched the notification and flipped gdpr_notified=true,
 * the next run skips that incident.
 */
export async function GET(req: NextRequest) {
  try {
    // Auth: shared cron token (header preferred, URL query legacy) OR a
    // super_admin session cookie (for manual runs from the browser).
    const unauth = await authorizeCron(req);
    if (unauth) return unauth;

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }
    const sb = getSupabase();

    // Load every incident where the authority has NOT been notified.
    // The composite partial index `security_incidents_deadline_idx`
    // covers this query — it stays small (most incidents get notified
    // within hours of declaration).
    const { data: incidents, error } = await sb
      .from("security_incidents")
      .select("*")
      .eq("gdpr_notified", false)
      .order("gdpr_notification_deadline", { ascending: true });
    if (error) throw error;

    const ranAt = new Date().toISOString();
    const escalatedApproaching: string[] = [];
    const escalatedBreached: string[] = [];
    const dispatched: string[] = [];
    const dispatchFailed: Array<{ id: string; error: string }> = [];
    const skippedNonNotifiable: string[] = [];

    for (const inc of (incidents || []) as unknown as SecurityIncident[]) {
      // Skip incidents whose type does not trigger Art. 33 (the policy
      // is in `NOTIFIABLE_INCIDENT_TYPES`). They're tracked but don't
      // count toward the 72-hour clock.
      if (!NOTIFIABLE_INCIDENT_TYPES.has(inc.type as IncidentType)) {
        skippedNonNotifiable.push(inc.id);
        continue;
      }

      const breached = isDeadlineBreached(inc);
      const approaching = isDeadlineApproaching(inc, 24 * 60 * 60 * 1000);
      if (!breached && !approaching) continue;

      // Escalation 1: send / retry the breach notification email.
      // The cron does this automatically — the operator's "manual notify"
      // path is the /api/admin/incidents/[id]/notify endpoint; the cron
      // is the safety net for when that hasn't happened.
      const sendResult = await sendBreachNotification(inc);
      if (sendResult.success) {
        // Flip gdpr_notified + reported_at. The cron route does NOT
        // flip `status` to "reported" — the super_admin owns the
        // status transitions; the cron only owns the notification
        // flag. (Status = "reported" implies "we have notified AND
        // closed the loop with the DPA"; the cron can't make that
        // judgement.)
        const reportedAt = new Date().toISOString();
        const { error: updErr } = await sb
          .from("security_incidents")
          .update({
            gdpr_notified: true,
            reported_at: reportedAt,
            updated_at: reportedAt,
          })
          .eq("id", inc.id);
        if (updErr) {
          // The email was sent but we couldn't record it. This is a
          // compliance problem (the audit trail now doesn't reflect
          // that the notification went out) — log prominently so ops
          // can manually record it.
          console.error(
            `[cron/breach-notification-check] incident ${inc.id} notification sent ` +
            `but DB update failed: ${updErr.message}. MANUAL RECORD REQUIRED.`,
          );
          dispatchFailed.push({ id: inc.id, error: updErr.message });
        } else {
          dispatched.push(inc.id);
        }
      } else {
        dispatchFailed.push({ id: inc.id, error: sendResult.error || "unknown" });
      }

      // Escalation 2: emit the audit log entry naming the escalation
      // tier (approaching vs. breached). The audit trail is what proves
      // to the supervisory authority (and to internal SOC 2 auditors)
      // that the platform had an automated escalation policy in place.
      try {
        const { getStore } = await import("@/lib/data/store");
        const store = await getStore();
        await audit(
          store,
          { id: undefined, username: "cron", tenant_id: null },
          req,
          breached ? "incident.deadline.breached" : "incident.deadline.approaching",
          "security_incident",
          inc.id,
          {
            incident_id: inc.id,
            type: inc.type,
            severity: inc.severity,
            detected_at: inc.detected_at,
            deadline: inc.gdpr_notification_deadline,
            // For breached incidents, log the overrun so the audit
            // trail shows how late the notification was dispatched
            // (or how late the cron attempted to dispatch).
            overrun_ms: breached
              ? Date.now() - new Date(inc.gdpr_notification_deadline || inc.detected_at).getTime()
              : null,
            dispatched_by_cron: sendResult.success,
            message_id: sendResult.messageId,
            // The "should notify" policy decision — so an auditor
            // can verify the cron only escalated notifiable incidents.
            should_notify: shouldNotifyAuthority(inc),
          },
        );
      } catch (e) {
        console.error("[cron/breach-notification-check] audit failed:", e);
      }

      // Escalation 3: call the configured webhook (Slack / PagerDuty /
      // Opsgenie). The webhook URL is optional — deployments that don't
      // configure it skip this step (the audit log is still the source
      // of truth).
      //
      // 9b-N9: the outbound webhook is now HMAC-signed. The receiver must
      // verify `X-Velos-Signature: sha256=<hex>` over the raw request body
      // (timing-safe compare — see `verifySignature` in
      // `@/lib/webhooks/deliver`). The signature is computed over the
      // EXACT JSON string we send (not a re-serialised copy) so the
      // receiver's `verifySignature(rawBody, sig, secret)` works on the
      // raw bytes — no canonical-JSON canonicalisation mismatch possible.
      //
      // FAIL-CLOSED: if `BREACH_NOTIFICATION_WEBHOOK_SECRET` is missing,
      // the webhook call is SKIPPED with a `console.error`. The cron
      // still dispatches the email + audit log; only the outbound webhook
      // is suppressed. Rationale: an unsigned webhook is worse than no
      // webhook — a misconfigured receiver might log + act on the
      // unsigned payload, and an attacker who could reach the receiver
      // (e.g. DNS-rebinding) could forge their own escalation. Better to
      // skip until ops set the secret than to send unsigned.
      const webhookUrl = process.env.BREACH_NOTIFICATION_WEBHOOK_URL;
      const webhookSecret = process.env.BREACH_NOTIFICATION_WEBHOOK_SECRET;
      if (webhookUrl) {
        if (!webhookSecret) {
          console.error(
            `[cron/breach-notification-check] BREACH_NOTIFICATION_WEBHOOK_SECRET env var is missing — ` +
            `skipping outbound webhook for incident ${inc.id} (fail-closed). Set the secret on the deployment.`,
          );
        } else {
          try {
            // Build the body ONCE as a string. The same string is signed
            // AND sent — the receiver recomputes the HMAC over the raw
            // body and compares (timing-safe) with the X-Velos-Signature
            // header. No re-serialisation mismatch is possible because
            // the bytes the receiver hashes are the bytes we signed.
            const webhookBody = JSON.stringify({
              event: breached ? "breach_deadline_breached" : "breach_deadline_approaching",
              incident_id: inc.id,
              type: inc.type,
              severity: inc.severity,
              detected_at: inc.detected_at,
              deadline: inc.gdpr_notification_deadline,
              overrun_ms: breached
                ? Date.now() - new Date(inc.gdpr_notification_deadline || inc.detected_at).getTime()
                : null,
              dispatched_by_cron: sendResult.success,
              message_id: sendResult.messageId,
              ran_at: ranAt,
            });
            const signature = signPayload(webhookBody, webhookSecret);

            await fetch(webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Velos-Signature": `sha256=${signature}`,
              },
              signal: AbortSignal.timeout(10_000),
              body: webhookBody,
            });
          } catch (e: any) {
            // Webhook failure is non-fatal — the audit log + email
            // dispatch already happened. Just log so ops can triage.
            console.error(
              `[cron/breach-notification-check] webhook call failed for incident ${inc.id}:`,
              e?.message || e,
            );
          }
        }
      }

      if (breached) escalatedBreached.push(inc.id);
      else escalatedApproaching.push(inc.id);
    }

    console.info(
      `[cron/breach-notification-check] ran_at=${ranAt} ` +
      `escalated_approaching=${escalatedApproaching.length} ` +
      `escalated_breached=${escalatedBreached.length} ` +
      `dispatched=${dispatched.length} ` +
      `dispatch_failed=${dispatchFailed.length} ` +
      `skipped_non_notifiable=${skippedNonNotifiable.length}`,
    );

    // P2 audit summary so ops can verify the cron fired (defence-in-
    // depth: the per-incident escalation audit entries above cover
    // individual incidents; this entry covers "the cron itself ran").
    try {
      const { getStore } = await import("@/lib/data/store");
      const store = await getStore();
      await audit(
        store,
        // V-3 FIX: `id: undefined` (NOT "system") — the audit_logs.user_id
        // column has a FK to users(id) which rejects the literal "system".
        // Per-incident escalation audit at line 148 was already fixed in
        // D-FIX; the summary audit here was the missed 6th call site.
        // The FK constraint accepts NULL (ON DELETE SET NULL on the FK).
        { id: undefined, username: "cron", tenant_id: null } as any,
        req,
        "cron.breach_notification_check",
        "system",
        "cron",
        {
          ran_at: ranAt,
          open_incidents_polled: (incidents || []).length,
          escalated_approaching: escalatedApproaching.length,
          escalated_breached: escalatedBreached.length,
          dispatched: dispatched.length,
          dispatch_failed: dispatchFailed.length,
          skipped_non_notifiable: skippedNonNotifiable.length,
        },
      );
    } catch (e) {
      console.error("[cron/breach-notification-check] summary audit failed:", e);
    }

    return NextResponse.json({
      ok: true,
      ran_at: ranAt,
      open_incidents_polled: (incidents || []).length,
      escalated_approaching: escalatedApproaching,
      escalated_breached: escalatedBreached,
      dispatched,
      dispatch_failed: dispatchFailed,
      skipped_non_notifiable: skippedNonNotifiable,
    });
  } catch (e: any) {
    console.error("[cron/breach-notification-check]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}
