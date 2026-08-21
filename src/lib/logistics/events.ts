import { getSupabase } from "@/lib/supabase/client";

export type LogisticsEventType =
  | "created"
  | "quoted"
  | "accepted"
  | "rejected"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "note"
  | "converted_to_offer"
  | "status_changed";

export interface LogisticsEvent {
  id: string;
  tenant_id: string;
  logistics_request_id: string;
  event_type: LogisticsEventType;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  actor_role: "admin" | "client" | "system";
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Record a logistics event. Failures never break the caller — logging is
 * best-effort. Missing table (e.g. before migration) becomes a no-op.
 */
export async function logLogisticsEvent(input: {
  tenant_id: string;
  logistics_request_id: string;
  event_type: LogisticsEventType;
  from_status?: string | null;
  to_status?: string | null;
  actor_id?: string | null;
  actor_role?: "admin" | "client" | "system";
  message?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from("logistics_events").insert({
      tenant_id: input.tenant_id,
      logistics_request_id: input.logistics_request_id,
      event_type: input.event_type,
      from_status: input.from_status ?? null,
      to_status: input.to_status ?? null,
      actor_id: input.actor_id ?? null,
      actor_role: input.actor_role ?? "system",
      message: input.message ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (e) {
    console.warn("[logLogisticsEvent] non-critical:", e);
  }
}

export async function listLogisticsEvents(
  tenantId: string,
  logisticsRequestId: string,
): Promise<LogisticsEvent[]> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("logistics_events")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("logistics_request_id", logisticsRequestId)
      .order("created_at", { ascending: true });
    if (error) return [];
    return (data as LogisticsEvent[]) || [];
  } catch {
    return [];
  }
}
