import { getSupabase } from "@/lib/supabase/client";

/**
 * RFQ attachments — the link between a portal RFQ and the spec documents
 * the client uploads with it (task: "deo gde mogu da uploaduju svoja
 * dokumenta kada traze robu kako bi znali koja specifikacija").
 *
 * Storage + ownership were already solved by `portal_uploads` + the
 * `/api/portal/upload` route (category "rfq") — what was missing is the
 * LINK: which upload belongs to which RFQ. Migration 092 adds
 * `portal_uploads.rfq_id`, and this module is the only writer/reader of
 * that column.
 *
 * Security contract:
 *   • `linkRfqAttachments` is called ONLY from POST /api/portal/rfqs,
 *     AFTER the RFQ row is created, with ids the server has VALIDATED:
 *     each upload row must belong to the caller's tenant + partner and
 *     must not be soft-deleted. A client can therefore never link
 *     another partner's (or tenant's) file to their RFQ.
 *   • Downloads flow through the existing permission-checked routes
 *     (/api/portal/attachments/[id] portal-side, /api/portal-uploads/[id]/download
 *     admin-side) — this module only links and lists, it never serves bytes.
 *
 * OPTIONAL-TABLE CONTRACT (mirrors partner-events): when the rfq_id
 * column is missing (pre-migration 092), every operation degrades to a
 * no-op / empty result — the RFQ flow keeps working, just without
 * attachments.
 */

/** Max attachments per RFQ (enforced server-side AND in the form UI). */
export const MAX_RFQ_ATTACHMENTS = 10;

/** Lightweight attachment metadata embedded on each PortalRfq row. */
export interface RfqAttachmentMeta {
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
  rfq_id: string | null;
}

/**
 * Validate + link upload rows to a freshly created RFQ.
 *
 * Validation per id: row exists, tenant_id + partner_id match the caller,
 * deleted_at IS NULL. Ids that fail validation are silently skipped (the
 * RFQ creation itself must never 500 because a client sent a stale id);
 * the number of rows actually linked is returned for audit logging.
 *
 * Never throws — returns 0 on any storage error (pre-migration no-op).
 */
export async function linkRfqAttachments(
  tenantId: string,
  partnerId: string,
  rfqId: string,
  attachmentIds: unknown,
): Promise<number> {
  if (!Array.isArray(attachmentIds)) return 0;
  const ids = attachmentIds
    .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 100)
    .slice(0, MAX_RFQ_ATTACHMENTS);
  if (ids.length === 0) return 0;

  try {
    const sb = getSupabase();
    // Fetch candidates WITHOUT writing: ownership check happens first.
    const { data: rows, error } = await sb
      .from("portal_uploads")
      .select("id, tenant_id, partner_id, deleted_at, rfq_id")
      .in("id", ids);
    if (error) {
      console.debug("[rfq-attachments] link lookup skipped:", error.message);
      return 0;
    }
    const valid = ((rows || []) as UploadRow[]).filter(
      (r) => r.tenant_id === tenantId && r.partner_id === partnerId && r.deleted_at === null,
    );
    if (valid.length === 0) return 0;

    const { error: updErr } = await sb
      .from("portal_uploads")
      .update({ rfq_id: rfqId })
      .in("id", valid.map((r) => r.id));
    if (updErr) {
      console.debug("[rfq-attachments] link update skipped:", updErr.message);
      return 0;
    }
    return valid.length;
  } catch (e) {
    console.debug("[rfq-attachments] link failed:", e);
    return 0;
  }
}

/**
 * Fetch attachments for a batch of RFQ ids, grouped for easy attachment
 * onto list responses. Returns an empty Map on any error (pre-migration
 * no-op — the UI simply shows no attachment chips).
 */
export async function attachmentsForRfqs(
  tenantId: string,
  rfqIds: string[],
): Promise<Map<string, RfqAttachmentMeta[]>> {
  const out = new Map<string, RfqAttachmentMeta[]>();
  const ids = (rfqIds || []).filter((x) => typeof x === "string" && x.length > 0).slice(0, 500);
  if (ids.length === 0) return out;

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("portal_uploads")
      .select("id, rfq_id, filename, mime_type, size_bytes, category, uploaded_at")
      .eq("tenant_id", tenantId)
      .in("rfq_id", ids)
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: true });
    if (error) {
      console.debug("[rfq-attachments] fetch skipped:", error.message);
      return out;
    }
    for (const row of (data || []) as Array<{
      id: string;
      rfq_id: string | null;
      filename: string;
      mime_type: string | null;
      size_bytes: number;
      category: string;
      uploaded_at: string;
    }>) {
      if (!row.rfq_id) continue;
      const list = out.get(row.rfq_id) || [];
      list.push({
        id: row.id,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: Number(row.size_bytes) || 0,
        category: row.category,
        uploaded_at: row.uploaded_at,
      });
      out.set(row.rfq_id, list);
    }
    return out;
  } catch (e) {
    console.debug("[rfq-attachments] fetch failed:", e);
    return out;
  }
}

/** Enrich a list of RFQ rows (in place) with an `attachments` array. */
export function attachToRfqs<T extends { id: string }>(
  rfqs: T[],
  byRfq: Map<string, RfqAttachmentMeta[]>,
): (T & { attachments: RfqAttachmentMeta[] })[] {
  return rfqs.map((r) => ({ ...r, attachments: byRfq.get(r.id) || [] }));
}
