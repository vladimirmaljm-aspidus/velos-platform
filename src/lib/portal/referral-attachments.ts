import { getSupabase } from "@/lib/supabase/client";

/**
 * Referral commission attachments — documents the partner uploads for a
 * specific referral commission entry (contract with the introduced client,
 * proof of the referred transaction, invoice copies…). Mirrors
 * rfq-attachments.ts (migration 092) on top of migration 097's
 * `portal_uploads.referral_id` column.
 *
 * Security contract:
 *   • `linkReferralAttachments` is called ONLY from
 *     POST /api/portal/referrals/attachments, AFTER validating that the
 *     referral commission row belongs to the caller's partner: each upload
 *     row must belong to the caller's tenant + partner and not be
 *     soft-deleted.
 *   • Downloads flow through the existing permission-checked routes
 *     (/api/portal/attachments/[id] portal-side,
 *     /api/portal-uploads/[id]/download admin-side).
 *
 * OPTIONAL-TABLE CONTRACT: when the referral_id column is missing
 * (pre-migration 097), every operation degrades to a no-op / empty result.
 */

/** Max documents per referral commission entry. */
export const MAX_REFERRAL_ATTACHMENTS = 20;

export interface ReferralAttachmentMeta {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  category: string;
  uploaded_at: string;
}

interface UploadRow {
  id: string;
  tenant_id: string;
  partner_id: string;
  deleted_at: string | null;
  referral_id: string | null;
}

/**
 * Validate + link upload rows to a referral commission entry owned by the
 * caller's partner. Ids failing validation are silently skipped; the count
 * of rows actually linked is returned. Never throws.
 */
export async function linkReferralAttachments(
  tenantId: string,
  partnerId: string,
  referralId: string,
  attachmentIds: unknown,
): Promise<number> {
  if (!Array.isArray(attachmentIds)) return 0;
  const ids = attachmentIds
    .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 100)
    .slice(0, MAX_REFERRAL_ATTACHMENTS);
  if (ids.length === 0) return 0;

  try {
    const sb = getSupabase();
    const { data: rows, error } = await sb
      .from("portal_uploads")
      .select("id, tenant_id, partner_id, deleted_at, referral_id")
      .in("id", ids);
    if (error) {
      console.debug("[referral-attachments] link lookup skipped:", error.message);
      return 0;
    }
    const valid = ((rows || []) as UploadRow[]).filter(
      (r) => r.tenant_id === tenantId && r.partner_id === partnerId && r.deleted_at === null,
    );
    if (valid.length === 0) return 0;

    const { error: updErr } = await sb
      .from("portal_uploads")
      .update({ referral_id: referralId })
      .in("id", valid.map((r) => r.id));
    if (updErr) {
      console.debug("[referral-attachments] link update skipped:", updErr.message);
      return 0;
    }
    return valid.length;
  } catch (e) {
    console.debug("[referral-attachments] link failed:", e);
    return 0;
  }
}

/** Fetch attachments for a batch of referral ids (partner-scoped). */
export async function attachmentsForReferrals(
  tenantId: string,
  partnerId: string | null,
  referralIds: string[],
): Promise<Map<string, ReferralAttachmentMeta[]>> {
  const out = new Map<string, ReferralAttachmentMeta[]>();
  const ids = (referralIds || []).filter((x) => typeof x === "string" && x.length > 0).slice(0, 200);
  if (ids.length === 0) return out;

  try {
    const sb = getSupabase();
    let q = sb
      .from("portal_uploads")
      .select("id, referral_id, filename, mime_type, size_bytes, category, uploaded_at")
      .eq("tenant_id", tenantId)
      .in("referral_id", ids)
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: true });
    if (partnerId) q = q.eq("partner_id", partnerId);
    const { data, error } = await q;
    if (error) {
      console.debug("[referral-attachments] fetch skipped:", error.message);
      return out;
    }
    for (const row of (data || []) as Array<{
      id: string;
      referral_id: string | null;
      filename: string;
      mime_type: string | null;
      size_bytes: number;
      category: string;
      uploaded_at: string;
    }>) {
      if (!row.referral_id) continue;
      const list = out.get(row.referral_id) || [];
      list.push({
        id: row.id,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: Number(row.size_bytes) || 0,
        category: row.category,
        uploaded_at: row.uploaded_at,
      });
      out.set(row.referral_id, list);
    }
    return out;
  } catch (e) {
    console.debug("[referral-attachments] fetch failed:", e);
    return out;
  }
}

/** Enrich referral rows (copies) with an `attachments` array. */
export function attachToReferrals<T extends { id: string }>(
  referrals: T[],
  byReferral: Map<string, ReferralAttachmentMeta[]>,
): (T & { attachments: ReferralAttachmentMeta[] })[] {
  return referrals.map((r) => ({ ...r, attachments: byReferral.get(r.id) || [] }));
}
