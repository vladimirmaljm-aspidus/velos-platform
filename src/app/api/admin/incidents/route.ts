import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  type IncidentType,
  type IncidentSeverity,
  type IncidentStatus,
  getBreachNotificationDeadline,
  shouldNotifyAuthority,
  NOTIFIABLE_INCIDENT_TYPES,
} from "@/lib/compliance/incident-response";

export const runtime = "nodejs";

/**
 * GET /api/admin/incidents — list security incidents.
 *
 * Super-admin only. Returns incidents across ALL tenants (the platform
 * level is where incidents are managed — a tenant admin cannot declare
 * or view incidents, since incidents are inherently cross-tenant or
 * platform-level).
 *
 * Query params:
 *   - status  — filter by status (open, investigating, contained, resolved, reported)
 *   - type    — filter by type
 *   - severity — filter by severity
 *   - tenant_id — filter by tenant_id (or "platform" for tenant_id IS NULL)
 *   - limit / offset — pagination (default 100, max 500)
 */
export async function GET(req: NextRequest) {
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

    const url = new URL(req.url);
    const status = url.searchParams.get("status") || undefined;
    const type = url.searchParams.get("type") || undefined;
    const severity = url.searchParams.get("severity") || undefined;
    const tenantIdFilter = url.searchParams.get("tenant_id");
    const limit = Math.min(
      Number(url.searchParams.get("limit")) || 100,
      500,
    );
    const offset = Number(url.searchParams.get("offset")) || 0;

    let q = sb.from("security_incidents").select("*", { count: "exact" });
    if (status) q = q.eq("status", status);
    if (type) q = q.eq("type", type);
    if (severity) q = q.eq("severity", severity);
    // tenant_id IS NULL is the marker for platform-level incidents.
    // ?tenant_id=platform filters for those.
    if (tenantIdFilter === "platform") {
      q = q.is("tenant_id", null);
    } else if (tenantIdFilter) {
      q = q.eq("tenant_id", tenantIdFilter);
    }
    q = q.order("detected_at", { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    return NextResponse.json({
      items: data || [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * POST /api/admin/incidents — declare a new security incident.
 *
 * Super-admin only. Creates the incident record, computes the GDPR Art.
 * 33(1) 72-hour notification deadline, and audits the declaration.
 *
 * Body (the `SecurityIncident` input shape — server fills in `id`,
 * `gdpr_notification_deadline`, `created_at`, `updated_at`):
 *   {
 *     type: "data_breach" | "unauthorized_access" | ...,
 *     severity: "low" | "medium" | "high" | "critical",
 *     status?: "open" | "investigating" | ... (default "open"),
 *     detected_at?: ISO string (default now),
 *     tenant_id?: UUID | null,
 *     affected_tenants?: string[],
 *     affected_users?: string[],
 *     description: string,
 *     root_cause?: string,
 *     mitigation_steps?: string[],
 *   }
 */
export async function POST(req: NextRequest) {
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

    const body = await req.json();
    if (!body?.type || !body?.severity || !body?.description) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: type, severity, description are required to declare an incident.",
        },
        { status: 400 },
      );
    }

    const type = String(body.type) as IncidentType;
    const severity = String(body.severity) as IncidentSeverity;
    const status = (body.status ? String(body.status) : "open") as IncidentStatus;
    const detectedAt = body.detected_at
      ? String(body.detected_at)
      : new Date().toISOString();
    const tenantId = body.tenant_id ? String(body.tenant_id) : null;
    const affectedTenants = Array.isArray(body.affected_tenants) ? body.affected_tenants : [];
    const affectedUsers = Array.isArray(body.affected_users) ? body.affected_users : [];

    // Compute the Art. 33(1) 72-hour deadline up-front so it is set
    // even if the cron is not running — the deadline is the source of
    // truth for escalation, not the cron's belief about it.
    const deadline = getBreachNotificationDeadline(detectedAt);

    const insertPayload = {
      tenant_id: tenantId,
      type,
      severity,
      status,
      detected_at: detectedAt,
      affected_tenants: affectedTenants,
      affected_users: affectedUsers,
      description: String(body.description),
      root_cause: body.root_cause ? String(body.root_cause) : null,
      mitigation_steps: Array.isArray(body.mitigation_steps) ? body.mitigation_steps : [],
      gdpr_notified: false,
      gdpr_notification_deadline: deadline,
      created_by: auth.user.id,
    };

    const { data, error } = await sb
      .from("security_incidents")
      .insert(insertPayload)
      .select("*")
      .single();
    if (error) throw error;

    // Audit the declaration. The incident id is captured so the audit
    // trail links the declaration event back to the incident record.
    await audit(
      auth.store,
      auth.user,
      req,
      "incident.create",
      "security_incident",
      data.id,
      {
        type,
        severity,
        status,
        tenant_id: tenantId,
        deadline,
        // Surface the notifiability decision so the audit log reflects
        // whether the declaring super_admin should have triggered the
        // breach notification flow (Art. 33) immediately.
        notifiable: shouldNotifyAuthority({
          ...insertPayload,
          id: data.id,
        } as any),
        in_notifiable_types: NOTIFIABLE_INCIDENT_TYPES.has(type),
      },
    );

    return NextResponse.json(data, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
