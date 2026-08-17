// src/app/api/admin/backfill-encryption/route.ts
// ----------------------------------------------------------------------------
// Field-encryption backfill (audit V-2 / Fix 7).
//
// Background
// ----------
// Migration 042 added the HMAC columns (`tax_id_hmac`, `vat_number_hmac`)
// to `partners` but did NOT encrypt the PII columns themselves
// (`contact_email`, `phone`, `tax_id`, `vat_number`). The encryption
// happens lazily on the next POST/PUT via `encryptField()` — so the
// 30 existing partners on the live DB at the time of the audit were
// 100% plaintext (0/30 encrypted, 0/30 HMAC tokens set).
//
// This endpoint is a one-time, super-admin-only migration helper. It:
//   1. Fetches every partner (across every tenant — super-admin scope).
//   2. For each row, if `contact_email` / `phone` / `tax_id` /
//      `vat_number` does NOT start with `enc:`, calls `encryptField()`
//      on the plaintext and writes the ciphertext back.
//   3. For `tax_id` / `vat_number`, ALSO sets the matching `_hmac`
//      column via `hmacField()` (so the duplicate-check on the next
//      POST works).
//   4. Reports per-field counts: how many rows were already encrypted
//      (skipped), how many were encrypted by this run, how many had
//      no value (empty), how many errors.
//
// Idempotent: re-running is a no-op for already-encrypted rows (the
// `isEncrypted()` check skips them). Safe to call multiple times.
//
// SUPER-ADMIN RULE
// ----------------
// Only `super_admin` can call this endpoint. The encryption touches
// every tenant's data — a tenant admin must never be able to invoke
// it (would let them observe cross-tenant PII shapes via the per-row
// success/failure pattern). `requireSuperAdmin` enforces this.
//
// WHY THIS IS AN ENDPOINT (not a SQL migration)
// ---------------------------------------------
// The encryption key (`FIELD_ENCRYPTION_KEY` / `SECRET_KEY`) lives in
// the app's environment — NOT in the Postgres role's config. A SQL
// migration has no way to call `encryptField()` (which uses Node's
// `crypto` module). The backfill MUST run in the Node process so it
// has access to the key.
//
// This endpoint also re-runs the HMAC backfill from migration 042
// (which silently no-op'd on the live DB because `app.field_hmac_key`
// wasn't set). The `hmacField()` function reads `FIELD_HMAC_KEY` /
// `FIELD_ENCRYPTION_KEY` / `SECRET_KEY` from the app env, so this
// backfill produces real tokens.
// ----------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit, sanitizeError } from "@/lib/api/helpers";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import {
  encryptField,
  hmacField,
  isEncrypted,
} from "@/lib/crypto/field-encryption";

export const runtime = "nodejs";

interface FieldStats {
  total: number;
  already_encrypted: number;
  encrypted_now: number;
  empty: number;
  hmac_set: number;
  errors: number;
}

const PII_FIELDS = ["contact_email", "phone", "tax_id", "vat_number"] as const;
type PiiField = (typeof PII_FIELDS)[number];

function isHmacField(field: PiiField): boolean {
  return field === "tax_id" || field === "vat_number";
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }
    const sb = getSupabase();

    // Fetch every partner across every tenant. Cap at 10k for safety
    // (the live DB has 30 rows; this cap protects against a future
    // 100k-row tenant where a synchronous backfill would time out —
    // a paginated backfill script would be the right follow-up then).
    const { data: partners, error: listErr } = await sb
      .from("partners")
      .select("id, tenant_id, contact_email, phone, tax_id, vat_number, tax_id_hmac, vat_number_hmac")
      .order("created_at", { ascending: true })
      .limit(10000);
    if (listErr) throw listErr;

    const stats: Record<PiiField, FieldStats> = {
      contact_email: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
      phone: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
      tax_id: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
      vat_number: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
    };

    let rowsProcessed = 0;
    let rowsUpdated = 0;
    let rowsSkipped = 0;

    for (const row of (partners ?? []) as Array<Record<string, unknown>>) {
      rowsProcessed++;
      const patch: Record<string, string> = {};
      let dirty = false;

      for (const field of PII_FIELDS) {
        const v = row[field];
        stats[field].total++;
        if (v == null || (typeof v === "string" && v === "")) {
          stats[field].empty++;
          continue;
        }
        if (typeof v !== "string") {
          stats[field].errors++;
          continue;
        }
        if (isEncrypted(v)) {
          stats[field].already_encrypted++;
          continue;
        }
        // Encrypt + (for tax_id/vat_number) compute HMAC.
        patch[field] = encryptField(v);
        if (isHmacField(field)) {
          const hmacCol = `${field}_hmac`;
          const existingHmac = row[hmacCol];
          if (!existingHmac || typeof existingHmac !== "string" || existingHmac === "") {
            patch[hmacCol] = hmacField(v);
          }
        }
        stats[field].encrypted_now++;
        if (isHmacField(field)) stats[field].hmac_set++;
        dirty = true;
      }

      if (!dirty) {
        rowsSkipped++;
        continue;
      }

      try {
        const { error: updErr } = await sb
          .from("partners")
          .update(patch)
          .eq("id", String(row.id));
        if (updErr) {
          console.error("[backfill-encryption] update failed for", row.id, updErr.message);
          for (const field of PII_FIELDS) {
            if (patch[field] !== undefined) stats[field].errors++;
          }
        } else {
          rowsUpdated++;
        }
      } catch (e) {
        console.error("[backfill-encryption] update threw for", row.id, e);
        for (const field of PII_FIELDS) {
          if (patch[field] !== undefined) stats[field].errors++;
        }
      }
    }

    await audit(auth.store, auth.user, req, "admin.backfill_encryption", "partners", undefined, {
      rows_processed: rowsProcessed,
      rows_updated: rowsUpdated,
      rows_skipped: rowsSkipped,
      stats,
    });

    return NextResponse.json({
      ok: true,
      rows_processed: rowsProcessed,
      rows_updated: rowsUpdated,
      rows_skipped: rowsSkipped,
      stats,
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

/**
 * GET — dry-run preview. Returns the per-field counts of plaintext vs.
 * already-encrypted rows WITHOUT writing anything. Lets the super-admin
 * verify the backfill is needed before POSTing.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireSuperAdmin(req);
    if (auth instanceof NextResponse) return auth;

    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
        { status: 503 },
      );
    }
    const sb = getSupabase();

    const { data: partners, error: listErr } = await sb
      .from("partners")
      .select("id, contact_email, phone, tax_id, vat_number, tax_id_hmac, vat_number_hmac")
      .order("created_at", { ascending: true })
      .limit(10000);
    if (listErr) throw listErr;

    const preview: Record<PiiField, FieldStats> = {
      contact_email: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
      phone: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
      tax_id: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
      vat_number: { total: 0, already_encrypted: 0, encrypted_now: 0, empty: 0, hmac_set: 0, errors: 0 },
    };

    for (const row of (partners ?? []) as Array<Record<string, unknown>>) {
      for (const field of PII_FIELDS) {
        const v = row[field];
        preview[field].total++;
        if (v == null || (typeof v === "string" && v === "")) {
          preview[field].empty++;
          continue;
        }
        if (typeof v === "string" && isEncrypted(v)) {
          preview[field].already_encrypted++;
          continue;
        }
        // Plaintext — would be encrypted by the POST.
        preview[field].encrypted_now++;
        if (isHmacField(field)) {
          const hmacCol = `${field}_hmac`;
          const existingHmac = row[hmacCol];
          if (!existingHmac || typeof existingHmac !== "string" || existingHmac === "") {
            preview[field].hmac_set++;
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      total_rows: (partners ?? []).length,
      preview,
    });
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
