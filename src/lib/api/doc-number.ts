// src/lib/api/doc-number.ts
// ----------------------------------------------------------------------------
// Atomic document numbering via Postgres SEQUENCE.
//
// All document types (offers, invoices, proformas) used to be numbered with
// `listX().total + 1` — a non-atomic read-then-write that races under
// concurrent requests and produces duplicate numbers. The fix lives in the
// database: a SEQUENCE object per doc_type, exposed through the
// `get_next_doc_number(doc_type)` Postgres function (see
// supabase/migrations/004_document_sequences.sql).
//
// This module wraps the RPC call with a defensive fallback: if the RPC fails
// (e.g. the migration hasn't been applied yet, or Supabase is unreachable),
// we fall back to the legacy `store.listX().total + 1` approach. The unique-
// constraint retry loop in the API routes remains as a final safety net.
// ----------------------------------------------------------------------------

import { isSupabaseConfigured, getSupabase } from "@/lib/supabase/client";

export type DocType = "offer" | "invoice" | "proforma" | "rfq" | "demand";

/**
 * Atomically reserve the next document number for the given type.
 *
 * Returns the number in the canonical format `<PREFIX>-<YEAR>-<NNNN>`:
 *   - offer    → OF-2025-0042
 *   - invoice  → INV-2025-0042
 *   - proforma → PRO-2025-0042
 *   - rfq      → RFQ-2025-0042  (Tier 2 fix C-2; requires SQL migration —
 *                see supabase/migrations/004_document_sequences.sql + the
 *                worklog entry for G-fixes-tier2. If the migration hasn't
 *                been applied yet, the RPC will raise 'unknown doc_type'
 *                and this function returns null so callers fall back to
 *                their legacy `listX().total + 1` pattern.)
 *
 * Strategy:
 *   1. Call `get_next_doc_number(doc_type)` via Supabase RPC — atomic
 *      (Postgres SEQUENCE nextval).
 *   2. If RPC unavailable / unconfigured / errors → return null so the
 *      caller can fall back to its legacy `listX().total + 1` logic.
 */
export async function nextDocNumber(docType: DocType): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const sb = getSupabase();
    // CRITICAL FIX (F-FINAL / P0): the canonical RPC signature is
    // `get_next_doc_number(p_doc_type text, p_tenant_id text DEFAULT NULL)`
    // (migration 011). Calling with `{ doc_type }` produced a PostgREST
    // PGRST202 "Could not find the function public.get_next_doc_number(doc_type)"
    // error on every create-offer/invoice/proforma without an explicit
    // number → 500 with sanitized "Database error." body. Use the canonical
    // `p_doc_type` arg name so the RPC resolves correctly.
    const { data, error } = await sb.rpc("get_next_doc_number", {
      p_doc_type: docType,
    });
    if (error) {
      console.warn(
        `[doc-number] RPC get_next_doc_number('${docType}') failed:`,
        error.message,
      );
      return null;
    }
    if (!data || typeof data !== "string") return null;
    return data;
  } catch (e: any) {
    console.warn(
      `[doc-number] RPC get_next_doc_number('${docType}') threw:`,
      e?.message || e,
    );
    return null;
  }
}

/**
 * Format a document number for a given doc_type and explicit sequence value.
 *
 * Used by callers that need to render the legacy fallback (total + 1) in the
 * canonical format, keeping the visible format consistent across both the
 * atomic and the fallback paths.
 */
export function formatDocNumber(
  docType: DocType,
  year: number,
  seq: number,
): string {
  const prefix =
    docType === "offer"
      ? "OF"
      : docType === "invoice"
        ? "INV"
        : docType === "proforma"
          ? "PRO"
          : docType === "demand"
            ? "DM"
            : "RFQ";
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}
