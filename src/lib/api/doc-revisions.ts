import { getSupabase } from "@/lib/supabase/client";

/**
 * Document revision recorder.
 *
 * Called around every update to an offer / invoice / proforma. Diffs the
 * old row against the new row and writes:
 *   - a `document_revisions` row containing the pre-change snapshot and a
 *     `changed_fields` array of {field, before, after}
 *   - bumps the parent document's `version` column
 *
 * Fields excluded from the diff (noise): updated_at, viewed_at,
 * view_count, viewed_by_email, sent_at, pdf_file_url, pdf_generated_at.
 */

const IGNORE_FIELDS = new Set([
  "updated_at", "viewed_at", "view_count", "viewed_by_email",
  "sent_at", "pdf_file_url", "pdf_generated_at", "version",
]);

type DocType = "offer" | "invoice" | "proforma";
const TABLE_BY_TYPE: Record<DocType, string> = {
  offer: "offers", invoice: "invoices", proforma: "proformas",
};

function diffRows(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: { field: string; before: unknown; after: unknown }[] = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (IGNORE_FIELDS.has(k)) continue;
    const b = (before || {})[k];
    const a = (after || {})[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changes.push({ field: k, before: b, after: a });
    }
  }
  return changes;
}

export async function recordRevision(opts: {
  docType: DocType;
  documentId: string;
  tenantId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  userId: string | null;
  username: string | null;
  changeNote?: string | null;
}): Promise<void> {
  const sb = getSupabase();
  const changes = diffRows(opts.before, opts.after);
  if (changes.length === 0) return;

  // Determine next version number by counting existing revisions.
  const { count } = await sb
    .from("document_revisions")
    .select("id", { count: "exact", head: true })
    .eq("document_id", opts.documentId)
    .eq("document_type", opts.docType);
  const nextVersion = (count || 0) + 2; // v1 = initial create; first revision = v2

  await sb.from("document_revisions").insert({
    tenant_id: opts.tenantId,
    document_id: opts.documentId,
    document_type: opts.docType,
    version: nextVersion,
    changed_fields: changes,
    snapshot_before: opts.before,
    changed_by_username: opts.username,
    created_by: opts.userId,
    change_note: opts.changeNote ?? null,
  });

  // Bump the parent document's version pointer.
  const table = TABLE_BY_TYPE[opts.docType];
  await sb.from(table).update({ version: nextVersion }).eq("id", opts.documentId).eq("tenant_id", opts.tenantId);
}

/** Convenience wrapper: fetch `before`, call the update, then record diff. */
export async function withRevisionTracking<T extends Record<string, unknown>>(opts: {
  docType: DocType;
  documentId: string;
  tenantId: string;
  userId: string | null;
  username: string | null;
  changeNote?: string | null;
  updater: (before: T | null) => Promise<T>;
}): Promise<T> {
  const sb = getSupabase();
  const table = TABLE_BY_TYPE[opts.docType];
  const { data: before } = await sb.from(table).select("*").eq("id", opts.documentId).eq("tenant_id", opts.tenantId).maybeSingle();
  const after = await opts.updater(before as T | null);
  if (before) {
    await recordRevision({
      docType: opts.docType, documentId: opts.documentId, tenantId: opts.tenantId,
      before: before as Record<string, unknown>, after: after as Record<string, unknown>,
      userId: opts.userId, username: opts.username, changeNote: opts.changeNote ?? null,
    }).catch((e) => console.warn("[recordRevision]", e));
  }
  return after;
}
