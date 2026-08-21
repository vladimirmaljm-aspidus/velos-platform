/**
 * Portal redaction — strips every internal / commercially-sensitive field
 * from documents before they leave the server to a portal client.
 *
 * Rule: portal clients see WHAT they buy, HOW MUCH they pay, and WHEN it
 * arrives — nothing else. In particular they NEVER see:
 *   - cost / cost_price / landed_cost / margin / markup
 *   - commission_amount / commission_rate / agent_id / commissioner_*
 *   - admin_notes / internal_notes / staff_notes
 *   - owner_id / created_by / assigned_to
 *   - supplier information linked to a line
 *
 * The redaction is defense-in-depth: even if the DB stores extra fields on
 * the offer's `items` jsonb (cost per line, etc.) they are scrubbed before
 * response.
 */

const INTERNAL_TOP_FIELDS = new Set([
  "cost",
  "cost_price",
  "cost_total",
  "landed_cost",
  "margin",
  "margin_pct",
  "markup",
  "markup_pct",
  "internal_notes",
  "admin_notes",
  "staff_notes",
  "owner_id",
  "created_by",
  "assigned_to",
  "commission_amount",
  "commission_rate",
  "commission_agent_id",
  "commissioner_id",
  "supplier_id",
  "supplier_offer_id",
  "pdf_file_url",  // never expose signed storage paths
  "old_id",
  "deleted_at",
]);

const INTERNAL_ITEM_FIELDS = new Set([
  "cost",
  "cost_price",
  "unit_cost",
  "landed_cost",
  "margin",
  "margin_pct",
  "markup",
  "markup_pct",
  "supplier_id",
  "supplier_offer_id",
  "internal_notes",
  "admin_notes",
  "commission",
  "commission_amount",
  "commission_rate",
]);

function stripKeys<T extends Record<string, unknown>>(obj: T, blacklist: Set<string>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!blacklist.has(k)) out[k] = v;
  }
  return out as T;
}

function redactItems(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((it) => {
    if (!it || typeof it !== "object") return it;
    return stripKeys(it as Record<string, unknown>, INTERNAL_ITEM_FIELDS);
  });
}

export function redactDocumentForPortal<T extends Record<string, unknown>>(doc: T): T {
  if (!doc || typeof doc !== "object") return doc;
  const scrubbed = stripKeys(doc, INTERNAL_TOP_FIELDS);
  if ("items" in scrubbed) {
    (scrubbed as any).items = redactItems((scrubbed as any).items);
  }
  return scrubbed;
}

/** Redact every doc in a list response {items, total, ...}. */
export function redactListForPortal<T extends { items?: unknown }>(list: T): T {
  if (!list || typeof list !== "object" || !Array.isArray(list.items)) return list;
  return { ...list, items: list.items.map((d) => redactDocumentForPortal(d as any)) };
}
