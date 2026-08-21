import { getSupabase } from "@/lib/supabase/client";
import { deleteFile } from "@/lib/upload/service";

export type PortalUploadCategory = "kyc" | "rfq" | "message" | "general" | "other";

export interface PortalUpload {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  category: PortalUploadCategory;
  doc_type: string | null;
  kyc_submission_id: string | null;
  message_id: string | null;
  filename: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by_email: string | null;
  description: string | null;
  uploaded_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export async function recordPortalUpload(input: Omit<PortalUpload, "id" | "uploaded_at" | "deleted_at" | "deleted_by">): Promise<PortalUpload> {
  const sb = getSupabase();
  const { data, error } = await sb.from("portal_uploads").insert(input).select().single();
  if (error) throw error;
  return data as PortalUpload;
}

export interface ListUploadsFilter {
  partnerId?: string;
  category?: PortalUploadCategory;
  includeDeleted?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listPortalUploads(tenantId: string, filter: ListUploadsFilter = {}): Promise<{ items: PortalUpload[]; total: number }> {
  const sb = getSupabase();
  let q = sb.from("portal_uploads").select("*", { count: "exact" }).eq("tenant_id", tenantId);
  if (filter.partnerId) q = q.eq("partner_id", filter.partnerId);
  if (filter.category) q = q.eq("category", filter.category);
  if (!filter.includeDeleted) q = q.is("deleted_at", null);
  if (filter.search) q = q.ilike("filename", `%${filter.search}%`);
  q = q.order("uploaded_at", { ascending: false });
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  q = q.range(offset, offset + limit - 1);
  const { data, count, error } = await q;
  if (error) throw error;
  return { items: (data as PortalUpload[]) || [], total: count || 0 };
}

export async function getPortalUpload(id: string, tenantId: string): Promise<PortalUpload | null> {
  const sb = getSupabase();
  const { data } = await sb.from("portal_uploads").select("*").eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  return (data as PortalUpload) || null;
}

export async function softDeletePortalUpload(id: string, tenantId: string, deletedBy: string): Promise<void> {
  const sb = getSupabase();
  await sb.from("portal_uploads").update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
    .eq("id", id).eq("tenant_id", tenantId).is("deleted_at", null);
}

/** Hard delete: removes the row AND the storage object. Requires prior soft-delete or admin override. */
export async function hardDeletePortalUpload(id: string, tenantId: string): Promise<void> {
  const upload = await getPortalUpload(id, tenantId);
  if (!upload) return;
  await deleteFile(upload.storage_bucket, upload.storage_path);
  const sb = getSupabase();
  await sb.from("portal_uploads").delete().eq("id", id).eq("tenant_id", tenantId);
}

/** Per-partner aggregated summary for the admin folder view. */
export async function summarizeByPartner(tenantId: string): Promise<Array<{ partner_id: string; total: number; last_upload: string; categories: Record<string, number> }>> {
  const sb = getSupabase();
  const { data } = await sb.from("portal_uploads").select("partner_id, category, uploaded_at")
    .eq("tenant_id", tenantId).is("deleted_at", null);
  const rows = (data as Array<{ partner_id: string; category: string; uploaded_at: string }>) || [];
  const acc = new Map<string, { partner_id: string; total: number; last_upload: string; categories: Record<string, number> }>();
  for (const r of rows) {
    const cur = acc.get(r.partner_id) ?? { partner_id: r.partner_id, total: 0, last_upload: r.uploaded_at, categories: {} };
    cur.total += 1;
    cur.categories[r.category] = (cur.categories[r.category] || 0) + 1;
    if (r.uploaded_at > cur.last_upload) cur.last_upload = r.uploaded_at;
    acc.set(r.partner_id, cur);
  }
  return [...acc.values()].sort((a, b) => b.last_upload.localeCompare(a.last_upload));
}
