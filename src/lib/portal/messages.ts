import { getSupabase } from "@/lib/supabase/client";

/**
 * Portal ↔ Admin threaded messaging. Backed by the `portal_messages` table.
 *
 * All messages between an admin and a specific partner share the same
 * partner_id thread. Direction distinguishes who sent it. read_at marks
 * when the OTHER side viewed it.
 */

export type PortalMessage = {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  direction: "portal_to_admin" | "admin_to_portal";
  body: string;
  sender_username: string;
  sender_user_id: string | null;
  read_at: string | null;
  delivered_email_at: string | null;
  attachment_url: string | null;
  attachment_name: string | null;
  attachment_type: string | null;
  created_at: string;
};

const MAX_BODY = 8000;

/** Sanitize inbound message body — strip tags, trim, cap length. */
export function sanitizeMessageBody(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Remove any HTML tags — React renders as text so this is defense-in-depth
  // for anywhere the value might be rendered as HTML (email preview etc).
  const noHtml = s.replace(/<[^>]*>/g, "");
  return noHtml.trim().slice(0, MAX_BODY);
}

export async function listThread(tenantId: string, partnerId: string, limit = 200): Promise<PortalMessage[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("portal_messages")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as PortalMessage[]) || [];
}

export async function insertMessage(m: Omit<PortalMessage, "id" | "created_at" | "read_at" | "delivered_email_at">): Promise<PortalMessage> {
  const sb = getSupabase();
  const { data, error } = await sb.from("portal_messages").insert({
    ...m,
    body: sanitizeMessageBody(m.body),
  }).select().single();
  if (error) throw error;
  return data as PortalMessage;
}

/** Mark all messages from the OTHER side as read. */
export async function markThreadRead(
  tenantId: string,
  partnerId: string,
  readerSide: "portal" | "admin",
): Promise<void> {
  const sb = getSupabase();
  const otherDirection = readerSide === "portal" ? "admin_to_portal" : "portal_to_admin";
  await sb
    .from("portal_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .eq("direction", otherDirection)
    .is("read_at", null);
}

/** Unread count for the reader's inbox (messages from the other side, still unread). */
export async function unreadCountForPartner(
  tenantId: string,
  partnerId: string,
  readerSide: "portal" | "admin",
): Promise<number> {
  const sb = getSupabase();
  const otherDirection = readerSide === "portal" ? "admin_to_portal" : "portal_to_admin";
  const { count } = await sb
    .from("portal_messages")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .eq("direction", otherDirection)
    .is("read_at", null);
  return count || 0;
}

/** Cross-partner unread total for an admin dashboard badge. */
export async function unreadCountForTenant(tenantId: string): Promise<number> {
  const sb = getSupabase();
  const { count } = await sb
    .from("portal_messages")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("direction", "portal_to_admin")
    .is("read_at", null);
  return count || 0;
}

export async function markEmailDelivered(id: string): Promise<void> {
  const sb = getSupabase();
  await sb.from("portal_messages").update({ delivered_email_at: new Date().toISOString() }).eq("id", id);
}
