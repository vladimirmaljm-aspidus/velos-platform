import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, type AuthContext, type ApiKeyAuthContext, sanitizeError, getAuthUser } from "@/lib/api/helpers";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";
// FIX-ALL-2 / Fix 1 — strip KYC / bank / vat / tax fields from API-key responses.
import { redactPartnerFields, shapePartnerRow } from "@/lib/api/redact";
// FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields.
import { sanitizeFields } from "@/lib/security/sanitize-input";
// P0-3 / Feature 2 — field-level encryption. The partner PII fields
// contact_email, phone, tax_id (and vat_number) are encrypted at rest
// with AES-256-GCM (enc: prefix). tax_id / vat_number are also used in
// the duplicate-check during create, so a deterministic HMAC token
// (tax_id_hmac / vat_number_hmac) is stored alongside for equality
// search — see migration 042_field_encryption_hmac.sql and
// src/lib/crypto/field-encryption.ts.
import {
  encryptField,
  decryptField,
  decryptFieldMasked,
  hmacField,
  isEncrypted,
} from "@/lib/crypto/field-encryption";
// 31-f — shared numeric-field validation (audit 30-a finding 30a-02:
// POST /api/partners {risk_score: "not-a-number"} → 500 "Invalid input
// format." — PostgREST 22P02 on the integer cast; now a clean 400).
import { assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

/**
 * SEC-M9 (mass-assignment) — strip client-controlled fields that the
 * partner upsert path must NOT let a caller set directly. The previous
 * implementation spread `...body` raw into `upsertPartner`, so a
 * partner:write caller could self-approve their KYC, mint a portal
 * token, set verification_level, etc. — full privilege-escalation
 * surface via the partner write API.
 *
 * FIX-AUDIT2-CRIT / C1 — the previous allow-list was hand-rolled and
 * drifted from the Partner schema: it allowed 7 columns that do NOT
 * exist on the table (`legal_name`, `contact_person`, `address`,
 * `description`, `currency`, `payment_terms`, `active`) while silently
 * dropping 16+ legitimate ones (email, contact_name, contact_phone,
 * address_line, every bank_*, every preferred_*, registration_number,
 * tags, entity_type, portal_level, industry, portal_visible_products,
 * portal_permissions, rating, social, whatsapp, lead_source,
 * linked_company_id, activities). The net effect was that the partner
 * create/update form silently dropped email + bank + contact + trade
 * preferences on every save.
 *
 * The allow-list is now built from the ACTUAL Partner interface in
 * src/lib/supabase/types.ts (lines 44-104) — every client-settable field
 * is allowed; the privileged / server-derived fields are not.
 *
 * Protected (NOT in the allow-list):
 *   • tenant_id          — server-resolved from auth context (the POST
 *                          handler re-attaches `tid!` after the whitelist;
 *                          the PUT handler overrides with the existing
 *                          row's tenant_id via the upsert spread).
 *   • approved_by / approved_at / kyc_status / kyc_data /
 *     kyc_reviewed_by / kyc_reviewed_at / verification_level /
 *     verified_at / verified_by — only the KYC review endpoints may
 *     mutate these. Allowing a partner:write caller to set them would
 *     be a self-approve-KYC / self-verify privilege escalation.
 *   • portal_token       — only the portal-access endpoints may mint
 *                          / rotate this credential.
 *   • tax_id_hmac / vat_number_hmac — server-derived from the plaintext
 *                          tax_id / vat_number by the encryption block
 *                          below; a client-supplied value would be a
 *                          forge attempt against the equality-search
 *                          index.
 *   • created_at / updated_at — DB-managed.
 *
 * `id` IS allowed — POST supports upsert-by-id (the audit log already
 * branches on `body.id ? "partner.update" : "partner.create"`), and the
 * CSV import path (which reuses this whitelist) needs `id` for the
 * documented update-in-place behaviour (see FIX-AUDIT2-CRIT / C2).
 * The PUT [id] route overrides `id` with the URL param via the upsert
 * spread, so allowing it here is harmless for PUT.
 */
export function whitelistPartnerFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    // Identity
    "id",                 // upsert-by-id (update-in-place) — see C2
    "name",
    "entity_type",
    "type",
    "email",
    "phone",
    "website",
    "tax_id",
    "vat_number",
    "registration_number",
    // Address
    "address_line",
    "city",
    "state",
    "postal_code",
    "country",
    // Contact person
    "contact_name",
    "contact_email",
    "contact_phone",
    // Bank
    "bank_name",
    "bank_account",
    "bank_swift",
    "bank_iban",
    // Trade preferences
    "preferred_currency",
    "preferred_incoterm",
    "preferred_payment_terms",
    // Commission agent
    "is_commissioner",
    // CRM
    "status",
    "risk_score",
    "notes",
    "tags",
    // Portal (client-settable presentation bits — NOT portal_token)
    "portal_enabled",
    "portal_level",
    "portal_permissions",
    "portal_visible_products",
    // CRM enrichment / metadata
    "industry",
    "lead_source",
    "linked_company_id",
    "rating",
    "social",
    "whatsapp",
    "activities",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

async function _get(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (partners.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "partners.read"); if (_d) return _d; } } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);

    // Permission check for API keys
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "partners:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const type = url.searchParams.get("type") || undefined;
    // F-9-3: cap limit to 500 to prevent ?limit=999999 style abuse that
    // would pull the entire table into memory and serialize a multi-MB JSON
    // response. The audit found a 100KB product name being stored — even
    // a single malicious row would balloon the response payload.
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;

    const result = await auth.store.listPartners(tid!, {
      search, limit, offset,
      filters: { status, type },
    });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    if (shouldFilter && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((p) => p.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    // CRITICAL FIX (audit D-5): strip portal_token from API responses.
    // This field is a 32+ char secret stored on the partner row and was
    // being leaked to anyone with partners:read permission (including API keys).
    // The field is legacy (no code path uses it for auth) — safe to strip.
    // P0-3 / Feature 2: decrypt contact_email / phone on read so the
    // admin UI shows plaintext PII. tax_id / vat_number are ALSO decrypted
    // here so the UI shows them — they're not used for equality search on
    // the read path (the HMAC column is, on the write path's duplicate-check).
    // AUDIT18 — canonical shaping (shapePartnerRow) replaces the hand-rolled
    // decrypt/strip block (this was one of 5 drifted copies of the same logic).
    const safeItems = result.items.map((row: any) => shapePartnerRow(row, auth));
    // (shapePartnerRow already applies redactPartnerFields for API-key callers)
    return NextResponse.json({ ...result, items: safeItems });
  } catch (e: any) {
    console.error("[partners.list]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

async function _post(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (partners.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "partners.create"); if (_d) return _d; } } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);

    // Permission check for API keys
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "partners:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      // FIX-ALL-2 / Fix 7 — surface a clear 400 instead of letting the
      // JSON parse throw bubble up as a 500 "Database error" later.
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // FIX-ALL-2 / Fix 7 — validation BEFORE DB write. Audit Part D
    // found POST /api/products {} returned "Database error Missing
    // required field." — the message leaked the implementation detail
    // that Postgres hit the NOT NULL constraint. The same gap exists on
    // partners (the `name` column is NOT NULL). Validate the required
    // fields here so we return a clean 400 with a list of missing
    // fields, never reaching the DB on a malformed payload.
    if (!body.id) {
      const missing: string[] = [];
      if (!body.name || String(body.name).trim() === "") missing.push("name");
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `Missing required field(s): ${missing.join(", ")}.` },
          { status: 400 },
        );
      }
    }

    // 31-f — numeric-field validation BEFORE the DB write (audit 30-a
    // finding 30a-02: {risk_score: "not-a-number"} reached PostgREST and
    // came back as 500 "Invalid input format." — the 22P02 integer cast
    // error mapped by sanitizeError). risk_score and rating are integer
    // columns; coerce numeric strings, 400 on junk.
    {
      const bad = assertNumeric(body, ["risk_score", "rating"]);
      if (bad) return bad;
    }

    // FIX-ALL-2 / Fix 6 — XSS prevention. Escape `<`/`>`/`"`/`'` in
    // free-text fields before storing so a later `dangerouslySetInnerHTML`
    // render path can't execute injected script. The fields below are the
    // user-visible free-text columns on `partners`; structured fields
    // (tax_id, email, …) are validated by format elsewhere.
    body = sanitizeFields(body, [
      "name",
      "legal_name",
      "description",
      "contact_person",
      "address",
      "city",
      "state",
      "country",
      "website",
      "notes",
    ]);

    body.tenant_id = tid!;
    if (!body.id) {
      const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "partners", isSA);
      if (denied) return denied;

      // Duplicate check: tax_id / vat_number collision within the same tenant
      // is a hard error; identical name is a soft-warn 409 (client can force).
      //
      // P0-3 / Feature 2 — field-level encryption: the tax_id / vat_number
      // columns are encrypted at rest with AES-256-GCM (random IV per row),
      // so `.eq("tax_id", v)` cannot match. Use the deterministic HMAC token
      // column (tax_id_hmac / vat_number_hmac) added by migration 042 for
      // equality search. The token is keyed with FIELD_HMAC_KEY →
      // FIELD_ENCRYPTION_KEY → SECRET_KEY (see src/lib/crypto/field-encryption.ts).
      // If migration 042 has not been applied, the HMAC column query returns
      // an error and we fall back to the legacy plaintext `.eq(field, v)`
      // query so the duplicate-check keeps working during the rollout window.
      try {
        const { getSupabase } = await import("@/lib/supabase/client");
        const sb = getSupabase();
        for (const field of ["tax_id", "vat_number"]) {
          const v = (body as any)[field];
          if (v && String(v).trim() !== "") {
            const hmacCol = `${field}_hmac`;
            const token = hmacField(String(v));
            // Try the HMAC column first (post-migration-042 deployment).
            const { data: hitByHmac, error: hmacErr } = await sb
              .from("partners")
              .select(`id, name, ${field}`)
              .eq("tenant_id", tid!)
              .eq(hmacCol, token)
              .maybeSingle();
            if (!hmacErr && hitByHmac) {
              // Surface the plaintext tax_id / vat_number to the admin
              // (hitByHmac[<field>] is encrypted at rest — decrypt for UX).
              // Cast through `unknown` first because the Supabase client's
              // static type doesn't include the dynamically-computed column
              // name in `select(\`id, name, ${field}\`)` — the runtime shape
              // is correct, the type isn't.
              const hitByHmacRow = hitByHmac as unknown as Record<string, unknown>;
              const display: Record<string, unknown> = { ...hitByHmacRow };
              const dv = display[field];
              if (dv && typeof dv === "string") {
                display[field] = decryptFieldMasked(dv);
              }
              const hitName = hitByHmacRow.name;
              return NextResponse.json({ error: `Partner with ${field} "${v}" already exists (${hitName}).`, duplicate: field, existing: display }, { status: 409 });
            }
            // Fall back to legacy plaintext equality (pre-migration-042
            // deployment where the HMAC column does not exist).
            if (hmacErr && !/could not find the ['\"]?[\w_]+_hmac['\"]? column/i.test(hmacErr.message)) {
              console.warn(`[partners.upsert] HMAC dup-check on ${field} failed:`, hmacErr.message);
            }
            const { data: hit } = await sb.from("partners").select("id, name, tax_id, vat_number").eq("tenant_id", tid!).eq(field, v).maybeSingle();
            if (hit) {
              return NextResponse.json({ error: `Partner with ${field} "${v}" already exists (${hit.name}).`, duplicate: field, existing: hit }, { status: 409 });
            }
          }
        }
        if (body.name && String(body.name).trim() !== "" && !body.force) {
          const { data: byName } = await sb.from("partners").select("id, name, country").eq("tenant_id", tid!).ilike("name", body.name).limit(1);
          if (byName && byName.length > 0) {
            return NextResponse.json({ error: `Partner "${body.name}" already exists. Send force:true to override.`, duplicate: "name", existing: byName[0] }, { status: 409 });
          }
        }
      } catch (e) { console.warn("[partners.upsert] dupe-check failed (allowing):", e); }
    }
    // CRITICAL FIX (audit M-6): `force` is route-only logic (used by the
    // duplicate-name soft-warn above) and is NOT a column on `partners`.
    // PostgREST rejects the insert with a 400 if it reaches the upsert.
    // Strip it, mirroring products/route.ts.
    delete body.force;

    // SEC-M9 (mass-assignment) — apply the field whitelist BEFORE the
    // encryption step. The whitelist strips client-supplied values for
    // privileged columns (approved_by, kyc_status, verification_level,
    // portal_token, *_hmac, …) so a partner:write caller cannot self-
    // approve KYC or mint a portal token. The encryption block below
    // then SETS the *_hmac columns server-side from the plaintext
    // tax_id / vat_number the whitelist preserved.
    body = whitelistPartnerFields(body);
    // tenant_id was stripped by the whitelist — re-attach the server-
    // resolved value before the upsert. (Existing line below.)
    body.tenant_id = tid!;

    // ── P0-3 / Feature 2 — field-level encryption ──────────────────────────
    // Encrypt contact_email, phone, tax_id, vat_number at rest with
    // AES-256-GCM (enc: prefix). tax_id / vat_number ALSO get a
    // deterministic HMAC token (tax_id_hmac / vat_number_hmac) for the
    // duplicate-check on the next create. Idempotent: already-encrypted
    // values (enc: prefix) are left untouched so a re-save of a
    // loaded-but-unmodified row is a no-op.
    if (body.contact_email != null) {
      if (typeof body.contact_email === "string" && body.contact_email !== "" && !isEncrypted(body.contact_email)) {
        body.contact_email = encryptField(body.contact_email);
      }
    }
    if (body.phone != null) {
      if (typeof body.phone === "string" && body.phone !== "" && !isEncrypted(body.phone)) {
        body.phone = encryptField(body.phone);
      }
    }
    // AUDIT16 — contact_phone: the portal profile PUT already encrypts it
    // (B4), so the admin write path must too — otherwise the same column
    // ends up with a MIX of plaintext (admin-created) and ciphertext
    // (client-edited) rows.
    if (body.contact_phone != null) {
      if (typeof body.contact_phone === "string" && body.contact_phone !== "" && !isEncrypted(body.contact_phone)) {
        body.contact_phone = encryptField(body.contact_phone);
      }
    }
    if (body.tax_id != null) {
      if (typeof body.tax_id === "string" && body.tax_id !== "" && !isEncrypted(body.tax_id)) {
        body.tax_id_hmac = hmacField(body.tax_id);
        body.tax_id = encryptField(body.tax_id);
      }
    }
    if (body.vat_number != null) {
      if (typeof body.vat_number === "string" && body.vat_number !== "" && !isEncrypted(body.vat_number)) {
        body.vat_number_hmac = hmacField(body.vat_number);
        body.vat_number = encryptField(body.vat_number);
      }
    }
    const created = await auth.store.upsertPartner(body);
    await audit(auth.store, getAuthUser(auth), req, body.id ? "partner.update" : "partner.create", "partner", created.id, { name: created.name });

    // ── F-4: fire outbound webhooks (partner.created / partner.updated) ────
    // Fire-and-forget — webhook delivery failures must NEVER block the
    // partner mutation. We strip `portal_token` from the payload (parity
    // with the GET handler's defense-in-depth strip — see audit D-5).
    // P0-3 / Feature 2: ALSO strip the internal HMAC columns AND decrypt
    // the encrypted PII fields so webhook subscribers receive plaintext
    // (webhook payloads are server-to-server, never exposed to browsers).
    const { portal_token: _omit, tax_id_hmac: _omitTid, vat_number_hmac: _omitVn, ...partnerSafe } = created as any;
    if (partnerSafe.contact_email && typeof partnerSafe.contact_email === "string") {
      partnerSafe.contact_email = decryptFieldMasked(partnerSafe.contact_email);
    }
    if (partnerSafe.phone && typeof partnerSafe.phone === "string") {
      partnerSafe.phone = decryptFieldMasked(partnerSafe.phone);
    }
    if (partnerSafe.tax_id && typeof partnerSafe.tax_id === "string") {
      partnerSafe.tax_id = decryptFieldMasked(partnerSafe.tax_id);
    }
    if (partnerSafe.vat_number && typeof partnerSafe.vat_number === "string") {
      partnerSafe.vat_number = decryptFieldMasked(partnerSafe.vat_number);
    }
    void triggerWebhooks(
      auth.store,
      tid!,
      body.id ? "partner.updated" : "partner.created",
      "partner",
      created.id,
      partnerSafe as Record<string, unknown>,
    ).catch((e) => console.error("[partners.post] webhook trigger failed:", e));

    // P0-3 / Feature 2: decrypt PII fields on the response so the admin UI
    // shows plaintext; strip the HMAC columns (internal-only).
    const { tax_id_hmac: _omitTid2, vat_number_hmac: _omitVn2, ...safeCreated } = created as any;
    if (safeCreated.contact_email && typeof safeCreated.contact_email === "string") {
      safeCreated.contact_email = decryptFieldMasked(safeCreated.contact_email);
    }
    if (safeCreated.phone && typeof safeCreated.phone === "string") {
      safeCreated.phone = decryptFieldMasked(safeCreated.phone);
    }
    if (safeCreated.tax_id && typeof safeCreated.tax_id === "string") {
      safeCreated.tax_id = decryptFieldMasked(safeCreated.tax_id);
    }
    if (safeCreated.vat_number && typeof safeCreated.vat_number === "string") {
      safeCreated.vat_number = decryptFieldMasked(safeCreated.vat_number);
    }
    // FIX-ALL-2 / Fix 1 — strip KYC / bank / vat / tax from API-key
    // responses (parity with the GET list handler).
    const redactedCreated = redactPartnerFields(safeCreated as any, auth);
    return NextResponse.json(redactedCreated);
  } catch (e: any) {
    console.error("[partners.upsert]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

// ── APM wrappers (task D-8) ──────────────────────────────────────────────
// Wraps GET/POST with response-time, slow-request, and error-rate metrics.
// See src/lib/monitoring/apm.ts for the buffer + dashboard wiring.
export const GET = withApm(_get, "GET /api/partners");
export const POST = withApm(_post, "POST /api/partners");
