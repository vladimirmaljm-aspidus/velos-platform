// Marketplace Phase 8 store — trade documents (auto-generated invoices,
// packing lists, certificates of origin, bills of lading / eBL, proformas,
// customs declarations, etc.).
//
// All functions talk directly to the `marketplace_trade_documents` table
// created in migration 050_marketplace_documents.sql. The store is
// intentionally a separate module from marketplace-store.ts /
// marketplace-logistics-store.ts to keep the Phase 1-7 files readable; API
// routes import this module directly and pass `tenantId` / `partnerId`
// from the resolved auth context.
//
// SECURITY MODEL
//   • createDocument(): the caller is the issuing partner. tenant_id +
//     partner_id are stamped from the auth context — never trust a
//     body-supplied partner_id.
//   • getDocument(): scoped by tenant_id; the caller's partner_id is
//     verified to be the issuer OR — when post_id / negotiation_id /
//     shipment_id is set — a participant in the post owner / negotiation
//     pair / the booking partner. The auth check happens at the API layer
//     before calling this store.
//   • updateDocument(): the issuing partner only (the store filters by
//     tenant_id + partner_id so a partner from tenant A cannot update
//     tenant B's docs by guessing ids). Signed documents are immutable —
//     the API layer rejects the PATCH before calling the store, and the
//     store additionally refuses to overwrite the digital_signature /
//     signed_at / signed_by columns.
//   • listDocuments(): returns the caller's documents (partner_id filter)
//     with optional filters for post_id / negotiation_id / shipment_id /
//     document_type / status.
//   • signDocument(): sets the digital_signature + signed_at + signed_by.
//     Restricted to the issuing partner.

import { getSupabase } from "@/lib/supabase/client";
import type {
  MarketplaceTradeDocumentStatus,
  MarketplaceTradeDocumentType,
} from "@/lib/marketplace/document-generators";
import {
  ALLOWED_DOCUMENT_STATUSES,
  ALLOWED_DOCUMENT_TYPES,
} from "@/lib/marketplace/document-generators";

// ─── Public row shape ───────────────────────────────────────────────────────

export interface TradeDocument {
  id: string;
  tenant_id: string;
  partner_id: string;
  post_id: string | null;
  negotiation_id: string | null;
  shipment_id: string | null;
  document_type: MarketplaceTradeDocumentType;
  status: MarketplaceTradeDocumentStatus;
  document_data: Record<string, unknown>;
  generated_pdf_url: string | null;
  digital_signature: string | null;
  signed_at: string | null;
  signed_by: string | null;
  reference_number: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradeDocumentCreate {
  post_id?: string | null;
  negotiation_id?: string | null;
  shipment_id?: string | null;
  document_type: MarketplaceTradeDocumentType;
  status?: MarketplaceTradeDocumentStatus;
  document_data: Record<string, unknown>;
  reference_number?: string | null;
  generated_pdf_url?: string | null;
}

export interface TradeDocumentUpdate {
  status?: MarketplaceTradeDocumentStatus;
  document_data?: Record<string, unknown>;
  generated_pdf_url?: string | null;
  reference_number?: string | null;
}

// ─── Validation helpers ────────────────────────────────────────────────────

export function isValidDocumentType(v: string): v is MarketplaceTradeDocumentType {
  return (ALLOWED_DOCUMENT_TYPES as string[]).includes(v);
}

export function isValidDocumentStatus(v: string): v is MarketplaceTradeDocumentStatus {
  return (ALLOWED_DOCUMENT_STATUSES as string[]).includes(v);
}

// ─── Public sanitisation helper ────────────────────────────────────────────

/**
 * Strip tenant_id / partner_id from a document before returning it to a
 * caller who is NOT the issuing partner. The issuer gets the full row;
 * everyone else (e.g. the buyer in a negotiation) sees the sanitised
 * shape so the issuer's exact internal partner_id does not leak.
 */
export function sanitisePublicDocument(d: TradeDocument): Record<string, unknown> {
  const { tenant_id: _t, partner_id: _p, ...rest } = d;
  void _t;
  void _p;
  return rest as Record<string, unknown>;
}

// ─── Create ────────────────────────────────────────────────────────────────

/**
 * Create a new trade document. tenant_id + partner_id are stamped from
 * the auth context by the API route — never trust a body-supplied
 * partner_id.
 *
 * When `post_id` / `negotiation_id` / `shipment_id` is supplied the store
 * verifies the FK target belongs to the caller's tenant before inserting
 * so a partner cannot attach a document to another tenant's marketplace
 * entity by guessing the id.
 */
export async function createDocument(
  tenantId: string,
  partnerId: string,
  data: TradeDocumentCreate,
): Promise<TradeDocument> {
  const sb = getSupabase();

  // Validate the document_type + status enums.
  if (!isValidDocumentType(data.document_type)) {
    throw new Error(`Invalid document_type: "${data.document_type}".`);
  }
  const status: MarketplaceTradeDocumentStatus =
    data.status && isValidDocumentStatus(data.status) ? data.status : "draft";

  // Validate FK targets belong to caller's tenant.
  await assertFkInTenant(sb, tenantId, data.post_id, "marketplace_posts", "Post");
  await assertFkInTenant(sb, tenantId, data.negotiation_id, "marketplace_negotiations", "Negotiation", ["tenant_id_a", "tenant_id_b"]);
  await assertFkInTenant(sb, tenantId, data.shipment_id, "marketplace_shipments", "Shipment");

  const payload = {
    tenant_id: tenantId,
    partner_id: partnerId,
    post_id: data.post_id ?? null,
    negotiation_id: data.negotiation_id ?? null,
    shipment_id: data.shipment_id ?? null,
    document_type: data.document_type,
    status,
    document_data: data.document_data,
    reference_number: data.reference_number ?? null,
    generated_pdf_url: data.generated_pdf_url ?? null,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_trade_documents")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as TradeDocument;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Fetch a single trade document by id, scoped to the caller's tenant.
 * Returns null when the document doesn't exist or belongs to another
 * tenant.
 *
 * Note: the per-participant auth check (issuer / post owner / negotiation
 * party / booking partner) is performed by the API layer BEFORE calling
 * this store. The store filters by tenant_id only.
 */
export async function getDocument(
  documentId: string,
  tenantId: string,
): Promise<TradeDocument | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_trade_documents")
    .select("*")
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  return (data as TradeDocument) ?? null;
}

// ─── Update ─────────────────────────────────────────────────────────────────

/**
 * Update a trade document. The caller MUST verify ownership (partner_id
 * === caller) BEFORE calling this function — the API route performs that
 * check; the store filters by tenant_id + partner_id so a partner from
 * tenant A cannot update tenant B's rows by guessing ids.
 *
 * SIGNED DOCUMENTS ARE IMMUTABLE: the store refuses to update any row
 * whose digital_signature column is non-null. The caller should DELETE
 * the document and re-create if a fix is needed after signing.
 */
export async function updateDocument(
  documentId: string,
  tenantId: string,
  partnerId: string,
  patch: TradeDocumentUpdate,
): Promise<TradeDocument | null> {
  const sb = getSupabase();

  // Strip fields the DB owns (id, tenant_id, partner_id, created_at,
  // updated_at) so the UPDATE never tries to write them.
  const {
    id: _id,
    tenant_id: _t,
    partner_id: _p,
    created_at: _c,
    updated_at: _u,
    document_type: _dt,           // immutable — set at create time
    post_id: _post,
    negotiation_id: _neg,
    shipment_id: _ship,
    digital_signature: _sig,     // immutable — set only via signDocument()
    signed_at: _sa,
    signed_by: _sb,
    ...fields
  } = patch as Record<string, unknown>;
  void _id; void _t; void _p; void _c; void _u;
  void _dt; void _post; void _neg; void _ship;
  void _sig; void _sa; void _sb;

  // Validate enum fields when supplied.
  if (fields.status !== undefined && fields.status !== null && !isValidDocumentStatus(String(fields.status))) {
    throw new Error(`Invalid status: "${fields.status}".`);
  }

  // Refuse to update a signed document — the signature is a tamper-evident
  // commitment. The caller must DELETE + re-create if a fix is needed.
  const { data: cur, error: curErr } = await sb
    .from("marketplace_trade_documents")
    .select("digital_signature")
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (curErr) throw curErr;
  if (!cur) return null;
  if ((cur as { digital_signature: string | null }).digital_signature) {
    throw new Error("Document is signed and cannot be modified. Delete and re-create instead.");
  }

  const { data, error } = await sb
    .from("marketplace_trade_documents")
    .update(fields)
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as TradeDocument) ?? null;
}

// ─── Sign ──────────────────────────────────────────────────────────────────

/**
 * Apply a digital signature to a document. Sets digital_signature +
 * signed_at + signed_by. Restricted to the issuing partner (the store
 * filters by tenant_id + partner_id). The signature itself is computed
 * by the API layer using `computeDocumentFingerprint()` (SHA-256 over the
 * JSONB + the signer's partner_id) so the store never reads the JSONB
 * payload directly.
 *
 * Idempotent: signing an already-signed document is a no-op when the
 * caller's partner_id matches signed_by and the signature matches.
 */
export async function signDocument(
  documentId: string,
  tenantId: string,
  partnerId: string,
  signature: string,
): Promise<TradeDocument | null> {
  const sb = getSupabase();

  // Use UPDATE … WHERE digital_signature IS NULL to make the signature
  // step atomic — concurrent signers race, only one wins.
  const { data, error } = await sb
    .from("marketplace_trade_documents")
    .update({
      digital_signature: signature,
      signed_at: new Date().toISOString(),
      signed_by: partnerId,
      status: "signed",
    })
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .is("digital_signature", null)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (data) return data as TradeDocument;

  // No row updated — either the doc doesn't exist / belongs to another
  // tenant, or it's already signed. Distinguish for the caller.
  const { data: cur, error: curErr } = await sb
    .from("marketplace_trade_documents")
    .select("id, digital_signature, signed_by")
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (curErr) throw curErr;
  if (!cur) return null;                       // not found / wrong tenant
  const c = cur as { id: string; digital_signature: string | null; signed_by: string | null };
  if (c.digital_signature) {
    // Already signed — return the row as-is (idempotent).
    return getDocument(documentId, tenantId);
  }
  return null;                                  // unreachable
}

// ─── List ──────────────────────────────────────────────────────────────────

export interface TradeDocumentFilters {
  post_id?: string;
  negotiation_id?: string;
  shipment_id?: string;
  document_type?: MarketplaceTradeDocumentType;
  status?: MarketplaceTradeDocumentStatus;
  limit?: number;
  offset?: number;
}

/**
 * List a partner's own trade documents, newest first. Returns the FULL
 * row (no sanitisation) — the caller IS the issuer.
 */
export async function listDocuments(
  tenantId: string,
  partnerId: string,
  opts?: TradeDocumentFilters,
): Promise<{ items: TradeDocument[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);

  let q = sb
    .from("marketplace_trade_documents")
    .select("*", { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("partner_id", partnerId);

  if (opts?.post_id) q = q.eq("post_id", opts.post_id);
  if (opts?.negotiation_id) q = q.eq("negotiation_id", opts.negotiation_id);
  if (opts?.shipment_id) q = q.eq("shipment_id", opts.shipment_id);
  if (opts?.document_type && isValidDocumentType(opts.document_type)) {
    q = q.eq("document_type", opts.document_type);
  }
  if (opts?.status && isValidDocumentStatus(opts.status)) {
    q = q.eq("status", opts.status);
  }

  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return {
    items: (data as TradeDocument[]) || [],
    total: count ?? 0,
  };
}

// ─── FK-in-tenant helper ────────────────────────────────────────────────────

/**
 * Verify that an optional FK target (post_id / negotiation_id /
 * shipment_id) belongs to the caller's tenant before inserting. The
 * caller passes the column-name(s) to verify; for the negotiations table
 * we check tenant_id_a OR tenant_id_b (a negotiation has two parties).
 *
 * Throws when the FK target exists but is in another tenant. No-ops when
 * the FK is null / undefined.
 */
async function assertFkInTenant(
  sb: ReturnType<typeof getSupabase>,
  tenantId: string,
  fkId: string | null | undefined,
  table: "marketplace_posts" | "marketplace_negotiations" | "marketplace_shipments",
  label: string,
  tenantCols: string[] = ["tenant_id"],
): Promise<void> {
  if (!fkId) return;
  const selectCols = tenantCols.join(",");
  const { data, error } = await sb
    .from(table)
    .select(selectCols)
    .eq("id", fkId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`${label} not found.`);
  const row = data as unknown as Record<string, string>;
  if (!tenantCols.some((c) => row[c] === tenantId)) {
    throw new Error(`${label} not found.`);
  }
}
