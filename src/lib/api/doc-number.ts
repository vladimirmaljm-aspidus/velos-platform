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

// ────────────────────────────────────────────────────────────────────────────
// Document Register auto-numbering (FIX-UX)
//
// `document_register` rows used to receive whatever `number` the client
// supplied. Concurrent creates could collide (and many rows persisted with
// `number=null` when the client omitted it). Unlike invoices/proformas,
// there is NO `document_register_*_seq` Postgres SEQUENCE in the migrations —
// so we synthesise a per-tenant, per-type sequence client-side by reading
// MAX(number) for the type and incrementing. A unique-violation retry loop
// protects against the rare race where two concurrent POSTs each read the
// same MAX and produce the same next number.
// ────────────────────────────────────────────────────────────────────────────

const DOC_REGISTER_PREFIX: Record<string, string> = {
  contract: "CONTRACT",
  invoice: "INVOICE",
  proforma: "PROFORMA",
  offer: "OFFER",
  spec: "SPEC",
  other: "DOC",
};

function docRegisterPrefix(type: string): string {
  return DOC_REGISTER_PREFIX[type] || String(type || "DOC").toUpperCase().slice(0, 8);
}

/** Extract the trailing `-NNN` sequence from a document-register number.
 *  Returns 0 when the number doesn't match the expected `PREFIX-YEAR-NNN`
 *  shape (legacy rows, free-form numbers, etc.). */
function parseSeq(num: string): number {
  const m = String(num || "").match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Atomically reserve the next document-register number for the given
 * tenant + type, formatted as `${PREFIX}-${YEAR}-${SEQ}` (SEQ zero-padded
 * to 3 digits, matching the spec example "CONTRACT-2026-001").
 *
 * Returns null when Supabase isn't configured (local dev/CI) so the caller
 * can fall back to whatever the client supplied (or an empty string).
 *
 * NOTE: this is NOT a true atomic SEQUENCE — it's MAX(number)+1 with a
 * retry-on-collision loop in the caller. For low-volume document_register
 * uploads this is acceptable; if volume grows, add a Postgres SEQUENCE
 * (mirroring migration 004) and call it via RPC.
 */
export async function nextDocRegisterNumber(
  tenantId: string,
  type: string,
): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  if (!tenantId || !type) return null;
  try {
    const sb = getSupabase();
    const prefix = docRegisterPrefix(type);
    const year = new Date().getFullYear();
    // Pattern: any string ending in `${prefix}-${year}-NNN`
    const likePattern = `${prefix}-${year}-%`;
    const { data, error } = await sb
      .from("document_register")
      .select("number")
      .eq("tenant_id", tenantId)
      .eq("type", type)
      .like("number", likePattern)
      .order("number", { ascending: false })
      .limit(1);
    if (error) {
      console.warn("[doc-number] doc_register MAX query failed:", error.message);
      return null;
    }
    const maxSeq = Array.isArray(data) && data.length > 0
      ? parseSeq((data[0] as { number?: string }).number || "")
      : 0;
    const nextSeq = maxSeq + 1;
    return `${prefix}-${year}-${String(nextSeq).padStart(3, "0")}`;
  } catch (e: any) {
    console.warn("[doc-number] nextDocRegisterNumber threw:", e?.message || e);
    return null;
  }
}

/** Generate the n-th retry candidate (SEQ + offset) for the document
 *  register number, keeping the same PREFIX-YEAR shape. Used by the
 *  route's retry-on-collision loop. */
export function bumpDocRegisterNumber(
  current: string,
  offset: number,
): string {
  // current looks like "CONTRACT-2026-001" — replace the trailing digits
  // with (parseSeq(current) + offset) zero-padded to at least 3.
  const base = String(current || "").replace(/-\d+$/, "");
  const seq = parseSeq(current) + offset;
  return `${base}-${String(seq).padStart(3, "0")}`;
}
