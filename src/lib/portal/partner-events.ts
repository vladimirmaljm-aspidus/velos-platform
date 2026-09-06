import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/client";
import { getIp } from "@/lib/utils/ip";

/**
 * Partner activity events — the per-partner event stream behind the
 * Partner 360 "Activity" tab.
 *
 * Scope / Namena (task 37):
 *   The admin side already had the raw signals scattered across:
 *     • audit_logs  (portal.login / portal.login_failed / portal.location)
 *     • offers/lois/invoices/proformas.viewed_at + view_count columns
 *     • portal_rfqs / marketplace_posts / marketplace_responses /
 *       marketplace_negotiations / marketplace_follows rows
 *   …but NOTHING gave a partner-centric answer to "what did this client
 *   look at, what interests them, when did they log in and from where".
 *
 *   This module is the WRITE side of a small new `portal_events` table
 *   (supabase/migrations/091_portal_events.sql) that captures the signals
 *   the structures above cannot express:
 *     • catalog product detail views (client-side, via /api/portal/track)
 *     • marketplace post detail views + per-partner searches
 *     • document / offer / LOI / invoice / proforma downloads
 *     • marketplace bids, follows, RFQ submissions
 *
 *   Login history is intentionally NOT written here — audit_logs already
 *   holds months of portal.login / portal.location rows in production and
 *   stays the source of truth for that (the 360 activity API reads it).
 *
 * OPTIONAL-TABLE CONTRACT: the migration may not be applied yet. Every
 * write is fire-and-forget with a silent no-op on failure, and every read
 * returns [] on error — the platform degrades to "no fine-grained events"
 * without breaking anything.
 */

export type PortalEventType =
  | "login"
  | "login_failed"
  | "location"
  | "offer_viewed"
  | "loi_viewed"
  | "invoice_viewed"
  | "proforma_viewed"
  | "offer_downloaded"
  | "loi_downloaded"
  | "invoice_downloaded"
  | "proforma_downloaded"
  | "document_downloaded"
  | "catalog_product_viewed"
  | "catalog_search"
  | "marketplace_viewed"
  | "marketplace_search"
  | "marketplace_bid"
  | "marketplace_follow"
  | "rfq_created";

export interface PortalEventRow {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  label: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

/** Types the public /api/portal/track endpoint may receive from the browser. */
export const CLIENT_TRACKABLE_TYPES: readonly string[] = [
  "catalog_product_viewed",
  "catalog_search",
  "marketplace_viewed",
] as const;

const LABEL_MAX = 200;

/** Clamp + strip any tags from a client-supplied label before persisting. */
export function sanitizeEventLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/<[^>]*>/g, "").trim().slice(0, LABEL_MAX);
  return clean.length > 0 ? clean : null;
}

/** Clamp a client-supplied details object to a small, flat, JSON-safe map. */
export function sanitizeEventDetails(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 12) break; // hard cap on keys
    if (typeof v === "string") {
      out[k.slice(0, 40)] = v.replace(/<[^>]*>/g, "").slice(0, 300);
      n++;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k.slice(0, 40)] = v;
      n++;
    } else if (typeof v === "boolean") {
      out[k.slice(0, 40)] = v;
      n++;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

interface PortalAccessLike {
  id: string;
  tenant_id: string;
  partner_id: string;
}

/**
 * Fire-and-forget event write. NEVER throws, NEVER blocks the caller —
 * call it with `void trackPortalEvent(...)` or without await; the promise
 * resolves either way. IP + user-agent are read from the request (the
 * shared getIp() helper — last X-Forwarded-For entry, not the first).
 */
export async function trackPortalEvent(
  access: PortalAccessLike,
  req: NextRequest | null,
  ev: {
    type: PortalEventType;
    entity_type?: string | null;
    entity_id?: string | null;
    label?: string | null;
    details?: Record<string, unknown> | null;
    ip?: string | null;
  },
): Promise<void> {
  try {
    const sb = getSupabase();
    const { error } = await sb.from("portal_events").insert({
      tenant_id: access.tenant_id,
      partner_id: access.partner_id,
      portal_access_id: access.id,
      type: ev.type,
      entity_type: ev.entity_type ?? null,
      entity_id: ev.entity_id ?? null,
      label: ev.label != null ? sanitizeEventLabel(ev.label) : null,
      details: ev.details ?? null,
      ip: ev.ip ?? (req ? getIp(req) : null),
      user_agent: req ? req.headers.get("user-agent") || null : null,
    });
    if (error) {
      // Expected state pre-migration-091 (42P01 undefined_table) — debug-level
      // only so the console is not spammed on every portal page view.
      console.debug("[portal-events] insert skipped:", error.message);
    }
  } catch (e) {
    console.debug("[portal-events] insert failed:", e);
  }
}

/**
 * Read the most recent events for one partner (tenant-scoped).
 * Returns [] when the table is missing / on any error — the 360 Activity
 * tab then simply falls back to the audit-log-derived timeline.
 */
export async function listPartnerEvents(
  tenantId: string,
  partnerId: string,
  limit = 500,
): Promise<PortalEventRow[]> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("portal_events")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("partner_id", partnerId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 1000));
    if (error) {
      console.debug("[portal-events] read skipped:", error.message);
      return [];
    }
    return (data as PortalEventRow[]) || [];
  } catch (e) {
    console.debug("[portal-events] read failed:", e);
    return [];
  }
}
