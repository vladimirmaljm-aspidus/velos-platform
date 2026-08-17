import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  sendBreachNotification,
  generateBreachNotification,
} from "@/lib/compliance/breach-notification";

export const runtime = "nodejs";

/**
 * POST /api/admin/incidents/[id]/notify — trigger the GDPR Art. 33
 * supervisory-authority breach notification.
 *
 * Super-admin only. Generates the GDPR-compliant notification email
 * (Art. 33(3)(a)–(d) covered — see `generateBreachNotification`) and
 * sends it via the platform's configured email provider (Resend /
 * Postmark / SMTP / mail-queue fallback).
 *
 * On successful dispatch:
 *   - sets `gdpr_notified=true` on the incident,
 *   - sets `reported_at=<dispatch timestamp>`,
 *   - sets `status="reported"` (unless the super_admin already moved
 *     it to `resolved` — the notify endpoint does NOT downgrade the
 *     status; `resolved` is treated as "everything is over" which
 *     subsumes "reported"),
 *   - audits the dispatch with the message id (so the audit trail
 *     proves the 72-hour clock was met — Art. 5(2) accountability).
 *
 * On dispatch failure: the incident's gdpr_notified flag is NOT flipped
 * (it stays false), the response carries the error, and the cron
 * (`/api/cron/breach-notification-check`) will re-attempt dispatch on
 * its next run. The deadline is still tracked; if it passes without
 * successful dispatch, the cron escalates to a P0 alert.
 *
 * Body (optional):
 *   {
 *     "force": true   — re-send even if gdpr_notified is already true
 *                       (e.g. to provide an Art. 33(4) follow-up
 *                       notification with additional details)
 *   }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }
    const sb = getSupabase();
    const { id } = await params;

    // Load the incident.
    const { data: incident, error: loadErr } = await sb
      .from("security_incidents")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!incident) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404 },
      );
    }

    // Parse the (optional) body.
    let body: { force?: boolean } = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch {
      // Empty / malformed body — fine, treat as no-override.
    }

    // Idempotency: if the incident has already been notified, refuse
    // unless the super_admin explicitly passes force=true (Art. 33(4)
    // follow-up notification use case).
    if (incident.gdpr_notified === true && !body.force) {
      return NextResponse.json(
        {
          error:
            "Incident has already been notified to the supervisory authority. " +
            "Pass force=true to send a follow-up notification (Art. 33(4)).",
          incident_id: id,
          reported_at: incident.reported_at,
        },
        { status: 409 },
      );
    }

    // Send the notification email. The generator builds the GDPR-
    // compliant body from the incident's current fields; if a field
    // is missing (description / root_cause / mitigation_steps), the
    // body carries a placeholder noting that details will follow per
    // Art. 33(4) — so the 72-hour clock can start IMMEDIATELY.
    const sendResult = await sendBreachNotification(incident as any);

    if (!sendResult.success) {
      // Don't flip gdpr_notified — the cron will retry.
      await audit(
        auth.store,
        auth.user,
        req,
        "incident.notify.failed",
        "security_incident",
        id,
        {
          error: sendResult.error,
          // Still log the generated subject/to so the audit trail
          // shows WHAT we tried to send (not just that it failed).
          to: generateBreachNotification(incident as any).to,
          subject: generateBreachNotification(incident as any).subject,
        },
      );
      return NextResponse.json(
        {
          error:
            "Breach notification dispatch failed — incident gdpr_notified flag NOT updated. " +
            "The cron will retry on the next run; see logs for the provider error.",
          provider_error: sendResult.error,
          incident_id: id,
        },
        { status: 502 },
      );
    }

    // Successful dispatch — update the incident.
    const reportedAt = new Date().toISOString();
    const update: Record<string, unknown> = {
      gdpr_notified: true,
      reported_at: reportedAt,
      updated_at: reportedAt,
    };
    // Only upgrade status to "reported" — never downgrade from
    // "resolved" (which means the incident is fully closed).
    if (incident.status !== "resolved") {
      update.status = "reported";
    }

    const { error: updErr } = await sb
      .from("security_incidents")
      .update(update)
      .eq("id", id);
    if (updErr) throw updErr;

    await audit(
      auth.store,
      auth.user,
      req,
      "incident.notify.sent",
      "security_incident",
      id,
      {
        to: generateBreachNotification(incident as any).to,
        subject: generateBreachNotification(incident as any).subject,
        message_id: sendResult.messageId,
        reported_at: reportedAt,
        follow_up: body.force === true,
      },
    );

    return NextResponse.json({
      ok: true,
      incident_id: id,
      message_id: sendResult.messageId,
      reported_at: reportedAt,
      follow_up: body.force === true,
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
