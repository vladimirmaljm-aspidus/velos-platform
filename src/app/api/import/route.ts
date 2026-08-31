import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, sanitizeError, type AuthContext, type ApiKeyAuthContext, getAuthUser } from "@/lib/api/helpers";
// SEC-M11 — partner mass-assignment whitelist (mirrors the POST/PUT
// partner routes). Reused so the import path can never desync from the
// interactive create/update paths.
import { whitelistPartnerFields } from "@/app/api/partners/route";

export const runtime = "nodejs";

const SUPPORTED_TYPES = ["products", "partners"] as const;
type ImportType = (typeof SUPPORTED_TYPES)[number];

const PERMISSION_KEY: Record<ImportType, string> = {
  products: "products:write",
  partners: "partners:write",
};

const ROLE_PERMISSION_KEY: Record<ImportType, string> = {
  products: "products.create",
  partners: "partners.create",
};

interface ImportResultRow {
  row: number;
  identifier: string;
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * SEC-M11 — product field whitelist for the CSV import path. Mirrors the
 * shape of `whitelistPartnerFields` (which is shared with the partners
 * POST/PUT routes). The previous `coerceRow` only stripped `tenant_id`
 * — every other CSV column flowed through to `upsertProduct`, so a CSV
 * importer could set audit / lifecycle columns (`created_at`, `created_by`,
 * `updated_at`) or non-existent columns that PostgREST would 500 on.
 *
 * Allowed: business-level product fields only. `active` is allowed
 * because the import is admin-initiated (partners:write / products.create
 * holder) — the admin is explicitly setting the active flag during a
 * bulk load, which the spec considers an authorized explicit set.
 *
 * FIX-AUDIT2-CRIT / C2 — `id` is in the allow-list. The CSV import
 * docs promise update-in-place ("`id` is honoured if present
 * (update-in-place); otherwise a new row is created"), but the previous
 * whitelist stripped `id` so every import row created a NEW product
 * instead of updating the existing one. Re-attaching `id` here lets the
 * upsert path match on the PK and update the existing row.
 */
function whitelistProductFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    "id",          // update-in-place: upsert matches on PK
    "sku",
    "name",
    "description",
    "category",
    "unit",
    "price",
    "currency",
    "cost",
    "stock",
    "reorder_level",
    "active",
    "attributes",
    "brand",
    "hs_code",
    "image_url",
    "show_in_catalog",
    "origin_country",
    "shelf_life",
    "tags",
    "detailed_spec",
    "coa_params",
    "logistics",
    "inventory",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

/**
 * POST /api/import?type=products
 * Body: FormData with "file" field containing CSV
 *
 * Parses the CSV, maps each row to a record, and upserts it via the store.
 * Designed for the "Import CSV" button on the products / partners list
 * views — a typical use case is migrating a CSV from an ERP / spreadsheet.
 *
 * Behaviour:
 *  - The first row MUST be a header row whose column names match the
 *    entity's field names (e.g. `sku,name,price,currency,unit`).
 *  - Unknown columns are ignored. Missing required columns surface as a
 *    per-row error in the response (the row is skipped, others continue).
 *  - Numeric / boolean fields are coerced: empty string → null, "true"/"1"
 *    → true, "false"/"0" → false, numeric strings → Number.
 *  - `id` is honoured if present (update-in-place); otherwise a new row is
 *    created.
 *  - Tenant scope is forced from the auth context — a CSV-supplied
 *    `tenant_id` is silently overwritten to prevent cross-tenant data
 *    injection.
 *
 * Caps:
 *  - Max 1000 rows per import (prevents a single upload from saturating
 *    the event loop). Larger imports should be chunked client-side.
 *  - Max file size: 5 MB (Next.js default body limit).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    const url = new URL(req.url);
    const type = (url.searchParams.get("type") || "products").toLowerCase() as ImportType;

    if (!SUPPORTED_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Unsupported import type: ${type}. Supported: ${SUPPORTED_TYPES.join(", ")}.` },
        { status: 400 },
      );
    }

    if ("apiKeyId" in auth) {
      if (!hasPermission(auth.permissions, PERMISSION_KEY[type])) {
        return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
      }
    } else {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, ROLE_PERMISSION_KEY[type]);
      if (_d) return _d;
    }

    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json(
        { error: "tenant_id is required for import. Super-admins must pass ?tenant_id=." },
        { status: 400 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File too large. Maximum 5 MB per import." },
        { status: 413 },
      );
    }

    const csv = await file.text();
    const rows = parseCSV(csv);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Empty CSV. The file must have a header row and at least one data row." },
        { status: 400 },
      );
    }
    if (rows.length > 1000) {
      return NextResponse.json(
        { error: `Too many rows. Maximum 1000 per import (received ${rows.length}).` },
        { status: 400 },
      );
    }

    const results: ImportResultRow[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 because row 1 is the header.
      const identifier = String(row.sku || row.name || row.id || `row ${rowNum}`);
      try {
        const record = coerceRow(row, type);
        // Force the tenant_id from the auth context — never trust the CSV.
        record.tenant_id = tid;

        if (type === "products") {
          // Skip the duplicate-name guard on import — the user is bulk-loading
          // and may legitimately re-import the same SKUs to update them.
          (record as Record<string, unknown>).force = true;
          const created = await auth.store.upsertProduct(
            record as Parameters<typeof auth.store.upsertProduct>[0],
          );
          results.push({ row: rowNum, identifier, success: true, id: created.id });
        } else {
          // partners
          const created = await auth.store.upsertPartner(
            record as Parameters<typeof auth.store.upsertPartner>[0],
          );
          results.push({ row: rowNum, identifier, success: true, id: created.id });
        }
        successCount++;
      } catch (e) {
        failureCount++;
        results.push({
          row: rowNum,
          identifier,
          success: false,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    await audit(
      auth.store,
      getAuthUser(auth),
      req,
      `${type}.import_csv`,
      type,
      "",
      { count: rows.length, successCount, failureCount, type },
    );

    return NextResponse.json({
      results,
      successCount,
      failureCount,
      totalRows: rows.length,
    });
  } catch (e) {
    console.error("[import]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─── CSV parsing ──────────────────────────────────────────────────────────

function parseCSV(csv: string): Record<string, string>[] {
  // Strip BOM if present (Excel exports often start with one).
  const cleaned = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  // Normalise line endings — handle \r\n and \r.
  const normalised = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = splitCSVLines(normalised);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, ""));
  if (headers.length === 0) return [];

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = values[j] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Split a CSV document into logical lines. Handles quoted newlines — a
 * newline inside a quoted field does NOT end the record.
 */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      // Doubled quote inside a quoted field = literal quote, not a closer.
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if (char === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// ─── Row coercion ─────────────────────────────────────────────────────────

const NUMERIC_FIELDS: Record<ImportType, Set<string>> = {
  products: new Set([
    "price", "cost", "stock", "reorder_level", "tax_rate",
  ]),
  partners: new Set(["risk_score"]),
};

const BOOLEAN_FIELDS: Record<ImportType, Set<string>> = {
  products: new Set(["active", "show_in_catalog"]),
  partners: new Set(["active", "portal_enabled", "is_commissioner"]),
};

const INTEGER_FIELDS: Record<ImportType, Set<string>> = {
  products: new Set(["stock", "reorder_level"]),
  partners: new Set(["risk_score"]),
};

function coerceRow(
  row: Record<string, string>,
  type: ImportType,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const numeric = NUMERIC_FIELDS[type];
  const boolean = BOOLEAN_FIELDS[type];
  const integer = INTEGER_FIELDS[type];

  for (const [key, raw] of Object.entries(row)) {
    if (key === "" || key === "tenant_id") continue; // never trust CSV tenant_id
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") {
      // Skip empty strings entirely — let the DB defaults apply.
      continue;
    }
    if (numeric.has(key)) {
      const n = Number(trimmed);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (boolean.has(key)) {
      const lower = trimmed.toLowerCase();
      out[key] = lower === "true" || lower === "1" || lower === "yes" || lower === "y";
    } else if (integer.has(key)) {
      const n = parseInt(trimmed, 10);
      out[key] = Number.isFinite(n) ? n : 0;
    } else {
      out[key] = trimmed;
    }
  }

  // SEC-M11 (CSV import mass-assignment) — apply the field whitelist
  // AFTER coercion but BEFORE the row reaches upsertProduct / upsertPartner.
  // The previous implementation only filtered out `tenant_id`, so every
  // other CSV column (including `approved_by`, `kyc_status`,
  // `verification_level`, `portal_token`, `*_hmac`, `created_at`, …)
  // flowed through to the upsert and landed in the DB. This gates each
  // imported row through the same allow-list the interactive POST/PUT
  // routes use, so an attacker who crafts a malicious CSV can no longer
  // self-approve KYC / mint portal tokens / forge audit columns via the
  // import path. (Admin explicit `active` is preserved because `active`
  // is in both whitelists — admins importing CSV are partners:write /
  // products.create holders, so the spec's "admin explicitly sets it"
  // exception applies.)
  if (type === "partners") {
    return whitelistPartnerFields(out);
  }
  return whitelistProductFields(out);
}
