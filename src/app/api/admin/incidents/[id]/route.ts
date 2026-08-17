import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * GET /api/admin/incidents/[id] — fetch a single incident by id.
 *
 * Super-admin only. Returns the full incident record including the
 * mitigation_steps and root_cause (which are not surfaced in the
 * list view to keep list payloads small).
 */
export async function GET(
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

    const { data, error } = await sb
      .from("security_incidents")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404 },
      );
    }

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * PUT /api/admin/incidents/[id] — update an incident.
 *
 * Super-admin only. Used to:
 *   - change status as the incident progresses through the runbook
 *     (open → investigating → contained → resolved → reported),
 *   - add root_cause / mitigation_steps once known,
 *   - mark gdpr_notified=true after the supervisory authority has been
 *     notified (the notify endpoint below does this automatically on
 *     successful dispatch).
 *
 * Body: a partial SecurityIncident — only the supplied fields are
 * updated. `id`, `created_by`, `created_at`, `detected_at`, and
 * `gdpr_notification_deadline` are NOT updatable (the deadline is
 * computed from `detected_at` at creation time; if the detection
 * timestamp was wrong, the super_admin should redeclare the incident
 * rather than mutate the deadline — audit trail integrity).
 */
export async function PUT(
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

    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body." }, { status: 400 });
    }

    // Build the update payload — only allow known, mutable columns.
    // The allowlist is the defence against the super_admin (or a
    // compromised super_admin session) mutating `id` / `created_by`
    // / `detected_at` / `gdpr_notification_deadline` to rewrite
    // history. Audit trail integrity > convenience.
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const allowedKeys = [
      "type",
      "severity",
      "status",
      "tenant_id",
      "affected_tenants",
      "affected_users",
      "description",
      "root_cause",
      "mitigation_steps",
      "gdpr_notified",
      "reported_at",
    ];
    for (const k of allowedKeys) {
      if (k in body) update[k] = body[k];
    }
    // `reported_at` is auto-set when gdpr_notified flips to true (the
    // notify endpoint below does this); but allow the super_admin to
    // set it explicitly (e.g. for a notification dispatched out-of-band
    // — phone, registered mail).
    if (update.gdpr_notified === true && !update.reported_at) {
      update.reported_at = new Date().toISOString();
    }

    const { data, error } = await sb
      .from("security_incidents")
      .update(update)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404 },
      );
    }

    await audit(
      auth.store,
      auth.user,
      req,
      "incident.update",
      "security_incident",
      id,
      {
        updated_fields: Object.keys(update).filter(
          (k) => k !== "updated_at" && body[k] !== undefined,
        ),
        new_status: update.status,
        new_gdpr_notified: update.gdpr_notified,
      },
    );

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
