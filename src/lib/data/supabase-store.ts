// SupabaseStore — production implementation of the Store interface.
// Talks directly to your Supabase project via the service_role key.
// Table names match schemas/supabase_v23_1.sql (snake_case).

import { Store, ListParams, ListResult } from "./store";
import { getSupabase } from "@/lib/supabase/client";
import { ensureStarterTemplates } from "./starter-templates";
import {
  User, Partner, Product, Deal, Offer, Demand, SharedDocument,
  AuditLog, Setting, UserTask, InventoryMovement, EntityNote,
  DashboardInsights, DashboardCharts,
  DashboardSalesPoint, DashboardTopProduct, DashboardOfferStatusSlice,
  DashboardMarginByCategory, DashboardPaymentPoint,
  OfferStatus,
  DealStage,
  Invoice, Proforma, DocumentRegisterEntry, DocumentRevision,
  VaultSecret, ApiKey, Webhook, WebhookDelivery, WebhookPayload,
  SecuritySession, LoginHistoryEntry, KnownIp, TrustedDevice,
  MailQueueEntry,
  Tenant, ProductCatalogEntry, SupplierOffer, TradeCalculation,
  PortalAccess, DocumentTemplate, DocumentVerification, VerificationLog,
  TenantLetterhead, TenantSeal,
  KycSubmission, KycDocument, PortalRfq,
  TenantFeatureFlags,
  Notification,
  CommissionAgent, DealCommission, CommissionPayout, CommissionSummary,
  ErpAccount, FiscalPeriod, ErpJournalEntry, ErpJournalLine,
  ErpCostCenter, ErpBankAccount, ErpBankTransaction, ErpSetting,
  TrialBalance, TrialBalanceItem, BalanceSheetItem, BalanceSheet, ProfitAndLoss, GeneralLedger, GeneralLedgerEntry,
  FxRevaluationAdjustment, FxRevaluationResult,
  UserPreference,
} from "@/lib/supabase/types";
import { verifyPassword } from "@/lib/auth/password";
import { createHash } from "crypto";
// P0-3 / Feature 2 — field-level encryption: the portal_access equality-
// search methods (login, forgot-password, duplicate-check) need a
// deterministic HMAC token to query by, since portal_email itself is
// encrypted with AES-256-GCM (random IV per row — no equality leakage).
// See migration 042_field_encryption_hmac.sql and the docstring at the
// bottom of src/lib/crypto/field-encryption.ts.
import { hmacField } from "@/lib/crypto/field-encryption";

type SupaRow = Record<string, unknown>;

function paginate<T>(items: T[], params?: ListParams): ListResult<T> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  return { items: items.slice(offset, offset + limit), total: items.length };
}

/**
 * Push pagination to the database via `.range()` + `count: "exact"`.
 *
 * P2 / task C-6 Fix 1: replaces the legacy pattern of
 *   `const { data } = await q; return paginate(data, params);`
 * which fetched the ENTIRE table then sliced in memory — a query that
 * grows linearly with table size and pulls thousands of rows over the
 * wire on every list call.
 *
 * The caller MUST:
 *   1. Pass `.select("*", { count: "exact" })` (or with explicit columns
 *      + `{ count: "exact" }`) so PostgREST returns the total row count
 *      in the response — without this, `count` comes back as `null` and
 *      the caller sees `total: 0`.
 *   2. Apply all filters / `.order()` to the builder before calling this
 *      helper — range() must be the LAST modifier so PostgREST applies
 *      it after filtering (otherwise the page slice is wrong).
 *
 * `limit` is capped at 500 to prevent a single request from pulling
 * thousands of rows (defence-in-depth against a client that asks for
 * `?limit=100000`). The default mirrors `paginate()`'s 50.
 *
 * Typing: `q` is a PostgrestFilterBuilder whose `range()` returns `this`
 * (thenable). We model it as `PromiseLike<{data, error, count}> & {range}`
 * so TypeScript accepts any supabase-js query builder without importing
 * its (complex) generic type parameters.
 */
type PaginatableQuery = {
  range(from: number, to: number): PromiseLike<{
    data: unknown;
    error: unknown;
    count: number | null;
  }>;
};

async function paginateQuery<T>(
  q: PaginatableQuery,
  params?: ListParams,
): Promise<ListResult<T>> {
  // S-FIX / data-loss: previously capped at 500 (the typical UI list
  // page size). This silently truncated bulk exports — e.g. a tenant
  // with 576 products got back 499 rows from
  // `/api/export?type=products` (which passes `limit: 10000` but was
  // clamped here). The cap is now 10k, matching the documented export
  // ceiling in src/app/api/export/route.ts. UI list routes (deals,
  // products, partners, offers, …) still cap at 500 at the *route*
  // layer (see `Math.min(Number(url.searchParams.get("limit")), 500)`
  // in those route files), so raising the store-layer cap does not
  // expose any list endpoint to a higher request ceiling.
  const limit = Math.min(params?.limit ?? 50, 10000);
  const offset = params?.offset ?? 0;
  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw error;
  return { items: (data as T[]) || [], total: count ?? 0 };
}

/**
 * Sanitize a user-provided search term before interpolating it into a
 * PostgREST `.or()` filter string (audit finding A-3/P0-3).
 *
 * PostgREST parses top-level commas as OR-clause separators and parentheses
 * as group delimiters, so a malicious search like `foo,number.ilike.%bar`
 * would inject an extra filter clause. Stripping these characters closes
 * the injection vector.
 *
 * NOTE: supabase-js v2.x `.or()` only accepts a raw filter string — the
 * runtime coerces arrays to `([object Object],...)`, so the structured
 * object form is unavailable. Input sanitization is the defense.
 */
function safeSearch(value: string): string {
  return value.replace(/[(),\\]/g, " ");
}

export class SupabaseStore implements Store {
  private sb() {
    return getSupabase();
  }

  /**
   * Sanitize a payload before sending it to Supabase:
   *   • Empty strings ("") become NULL — Postgres refuses "" for
   *     date/timestamp/numeric/uuid/jsonb columns (error 22007).
   *   • Nested plain objects are STRIPPED — these come back from SELECT
   *     queries that use PostgREST join syntax (e.g. `*, letterhead:...(*),
   *     seal:...(*)`) and end up as nested objects on the row. They are NOT
   *     real columns in the target table, so sending them back on an
   *     UPDATE/INSERT triggers a 500 from PostgREST
   *     ('column "letterhead" of relation "document_templates" does not
   *     exist'). The classic case is `document_templates.letterhead` and
   *     `document_templates.seal` — both join results.
   *   • Arrays are KEPT — they map to jsonb columns
   *     (e.g. document_templates.selected_bank_accounts, users.permissions).
   */
  private sanitizePayload(row: SupaRow): SupaRow {
    // Known JOIN result keys that come back from SELECT joins but are NOT
    // real DB columns. Strip them entirely (both null and object values)
    // to prevent PostgREST 500 "column does not exist" errors.
    const JOIN_KEYS = new Set([
      "letterhead", "seal", "partner", "deal", "offer", "invoice",
      "proforma", "demand", "product", "supplier", "buyer", "owner",
      "user", "tenant", "fiscal_period", "journal_entry", "bank_account",
      "cost_center", "account", "created_by_user", "posted_by_user",
      "commission_agent", "portal_access", "kyc_submission",
    ]);
    // CRITICAL FIX (audit F-4): these JSONB columns hold plain objects (not
    // JOIN results) and must NOT be stripped. Without this whitelist,
    // sanitizePayload silently drops logistics, attributes, inventory,
    // settings, etc. — causing silent data loss on every product save.
    const JSONB_OBJECT_COLUMNS = new Set([
      "logistics", "attributes", "inventory", "settings", "costs",
      "services", "specifications", "payment_dates", "bank_accounts",
      "social", "metadata", "notif_prefs", "supplier_bank_details",
      "comms", "permissions", "data",
    ]);
    const out: SupaRow = {};
    for (const [k, v] of Object.entries(row)) {
      // Skip known JOIN result keys (even if null — null still triggers
      // "column does not exist" in PostgREST)
      if (JOIN_KEYS.has(k)) continue;
      // Skip nested plain objects — they're JOIN results too
      // UNLESS they're known JSONB columns that hold plain objects.
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        if (!JSONB_OBJECT_COLUMNS.has(k)) continue;
      }
      if (v === "") out[k] = null;
      else out[k] = v;
    }
    return out;
  }

  /**
   * Smart upsert: uses INSERT when no id is provided, UPDATE when id exists.
   * This avoids issues with Supabase's upsert() and auto-generated UUIDs.
   *
   * CRITICAL SECURITY FIX (audit T-1/DEEP-3): the UPDATE path now filters
   * by BOTH id AND tenant_id, preventing cross-tenant IDOR. A caller from
   * tenant A can no longer POST body.id=<tenant-B-uuid> to overwrite
   * tenant B's record — the UPDATE matches 0 rows.
   *
   * CRITICAL SECURITY FIX (audit P2-1/C-7): when `data.id` is provided AND
   * `tenantId` is set AND the UPDATE matches 0 rows, we now THROW instead
   * of falling back to INSERT. The previous fallback created a NEW record
   * with the caller's tenant_id — safe from cross-tenant hijack, but it
   * (a) silently created duplicate rows when a caller mistyped an id,
   * (b) bypassed create-time validation in routes that gate on
   * `if (!body.id)`, and (c) returned a confusing PK-conflict 500 when
   * the row existed in another tenant. Throwing surfaces the failure
   * cleanly so the caller can correct the id or POST without an id to
   * create.
   *
   * The INSERT fallback is reserved for TRULY NEW records only — i.e.
   * super-admin / platform contexts where `tenantId` is unset. In that
   * case the legacy "create-or-update by id" semantics are preserved so
   * idempotent import scripts (e.g. seed.ts) that supply a stable UUID
   * keep working.
   *
   * On UPDATE we additionally strip:
   *   • created_at — DB owns this column; sending it would silently overwrite
   *     the original creation timestamp.
   *   • created_by — same; the original author shouldn't change on every edit.
   *   • updated_at — Postgres has a default/trigger that sets this; sending
   *     a client-supplied value can clobber it or trigger a NOT NULL /
   *     immutability error on some schemas.
   */
  private async smartUpsert<T>(
    table: string,
    data: Partial<T> & { id?: string },
    tenantId?: string,
  ): Promise<T> {
    const payload: SupaRow = this.sanitizePayload({ ...data });
    if (data.id) {
      // UPDATE existing record — never overwrite audit columns.
      const { id, ...fields } = payload;
      delete fields.created_at;
      delete fields.created_by;
      // Let the DB default/trigger update updated_at.
      delete fields.updated_at;
      // CRITICAL: filter by tenant_id to prevent cross-tenant IDOR.
      // If the row doesn't belong to this tenant, the UPDATE matches 0 rows.
      let query = this.sb().from(table).update(fields).eq("id", id);
      if (tenantId && "tenant_id" in fields) {
        query = query.eq("tenant_id", tenantId);
      }
      const { data: updated, error } = await query.select().single();
      if (error) {
        // PGRST116 = "JSON object requested, multiple (or no) rows returned"
        // — means 0 rows matched (either row doesn't exist OR belongs to a
        // different tenant). Other errors (constraint violation, RLS denial,
        // etc.) would also land here; we treat them the same because the
        // UPDATE did not produce a row either way.
        //
        // P0-3 / Feature 2 — field-level encryption: if the error is
        // "column X does not exist" (e.g. tax_id_hmac / vat_number_hmac /
        // portal_email_hmac added by migration 042 not yet applied), retry
        // the UPDATE once with that column stripped. This keeps the
        // partner / portal_access upserts tolerant of pre-migration-042
        // deployments the same way upsertPortalAccess already is.
        const missingColMatch = String(error.message || "").match(
          /Could not find the ['"]?([\w_]+)['"]? column/,
        );
        if (missingColMatch) {
          const missingCol = missingColMatch[1];
          const safeFields: SupaRow = { ...fields };
          delete safeFields[missingCol];
          // Also strip from payload for the INSERT fallback below.
          delete (payload as SupaRow)[missingCol];
          const retryQuery = this.sb().from(table).update(safeFields).eq("id", id);
          if (tenantId && "tenant_id" in safeFields) {
            retryQuery.eq("tenant_id", tenantId);
          }
          const { data: retried, error: retriedErr } = await retryQuery.select().single();
          if (!retriedErr && retried) return retried as T;
          // If the retry still failed with the 0-row match case, fall
          // through to the existing INSERT fallback below.
          if (retriedErr && !/PGRST116|JSON object requested/.test(retriedErr.message || "")) {
            // A different error after the column-strip retry — propagate.
            throw retriedErr;
          }
        }
        // SECURITY GATE (task C-7 / audit P2-1): when `tenantId` is set
        // (i.e. a tenant-scoped request, NOT a super-admin platform
        // request), THROW instead of falling back to INSERT. The caller
        // supplied an id, meaning they intended to UPDATE an existing
        // record — a 0-row match means the record is gone, was deleted,
        // or belongs to another tenant. Silently creating a new record
        // would (a) bypass create-time validation in routes that gate on
        // `if (!body.id)`, (b) create duplicate rows when a caller
        // mistypes an id, and (c) surface a confusing PK-conflict 500
        // when the id already exists in another tenant.
        //
        // The INSERT fallback is reserved for the super-admin / platform
        // context (tenantId unset) so idempotent imports and
        // "create-or-update by id" flows keep working — those requests
        // are explicitly NOT tenant-scoped and run with the service_role
        // key, so there's no cross-tenant IDOR vector to defend against.
        if (tenantId && !missingColMatch) {
          throw new Error(
            `Record not found or access denied (table=${table}, id=${id}).`,
          );
        }
        // Fall through to INSERT path (super-admin / no tenant scope only,
        // OR a column-strip retry that still found 0 rows).
      } else if (updated) {
        return updated as T;
      }
      // Super-admin context (no tenantId): row doesn't exist OR was
      // deleted — fall back to INSERT. This preserves the legacy
      // "create-or-update by id" semantics used by idempotent import
      // scripts (e.g. prisma/seed.ts) that supply a stable UUID.
      const { data: inserted, error: insErr } = await this.sb()
        .from(table)
        .insert(payload)
        .select()
        .single();
      if (insErr) {
        // P0-3 / Feature 2: same column-strip retry on the INSERT path.
        // Same pattern as above — strip the unknown column and retry.
        const insMissing = String(insErr.message || "").match(
          /Could not find the ['"]?([\w_]+)['"]? column/,
        );
        if (insMissing) {
          const safePayload: SupaRow = { ...payload };
          delete safePayload[insMissing[1]];
          const { data: ins2, error: ins2Err } = await this.sb()
            .from(table)
            .insert(safePayload)
            .select()
            .single();
          if (ins2Err) throw ins2Err;
          return ins2 as T;
        }
        throw insErr;
      }
      return inserted as T;
    }
    // INSERT new record (database auto-generates id)
    const { data: inserted, error } = await this.sb()
      .from(table)
      .insert(payload)
      .select()
      .single();
    if (error) {
      // P0-3 / Feature 2: same column-strip retry as above.
      const missing = String(error.message || "").match(
        /Could not find the ['"]?([\w_]+)['"]? column/,
      );
      if (missing) {
        const safePayload: SupaRow = { ...payload };
        delete safePayload[missing[1]];
        const { data: ins2, error: ins2Err } = await this.sb()
          .from(table)
          .insert(safePayload)
          .select()
          .single();
        if (ins2Err) throw ins2Err;
        return ins2 as T;
      }
      throw error;
    }
    return inserted as T;
  }

  // ---- auth ----
  async getUserByUsername(username: string): Promise<User | null> {
    const { data, error } = await this.sb()
      .from("users")
      .select("*")
      .eq("username", username)
      .maybeSingle();
    if (error) throw error;
    return (data as User) || null;
  }
  async getUserById(id: string): Promise<User | null> {
    const { data, error } = await this.sb().from("users").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as User) || null;
  }
  async listUsers(tenantId: string): Promise<User[]> {
    // A falsy tenantId means "super-admin, no tenant filter" (see AuthContext.tenantId
    // doc comment: "null = super-admin, sees all"). `.eq("tenant_id", "")` or
    // `.eq("tenant_id", null)` matches zero rows in Postgres, which silently broke
    // every platform-wide count (e.g. the Platform Dashboard overview).
    let q = this.sb().from("users").select("*");
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) throw error;
    return (data as User[]) || [];
  }
  async upsertUser(u: Partial<User> & { id?: string }): Promise<User> {
    // When id is provided, use UPDATE — avoids NOT NULL constraint violations
    // on columns like username/email that aren't in the partial payload.
    // Supabase upsert tries INSERT first, which fails on NOT NULL columns
    // before the ON CONFLICT clause can kick in.
    if (u.id) {
      const { id, ...fields } = u;
      // CRITICAL: filter by tenant_id to prevent cross-tenant IDOR. A caller
      // from tenant A can no longer POST body.id=<tenant-B-uuid> to overwrite
      // tenant B's user. If fields.tenant_id is falsy (super_admin has
      // tenant_id = null), skip the filter — `.eq("tenant_id", null)` would
      // match zero rows in Postgres and break super_admin updates.
      let q = this.sb().from("users").update(fields).eq("id", id);
      if (fields.tenant_id) q = q.eq("tenant_id", fields.tenant_id as string);
      const { data, error } = await q.select().single();
      if (error) throw error;
      if (!data) {
        // Row doesn't exist yet — fall back to insert with full payload
        const { data: ins, error: insErr } = await this.sb()
          .from("users")
          .insert(u as SupaRow)
          .select()
          .single();
        if (insErr) throw insErr;
        return ins as User;
      }
      return data as User;
    }
    // No id — insert new user (database generates id via gen_random_uuid()::text)
    const payload: SupaRow = { ...u };
    const { data, error } = await this.sb()
      .from("users")
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data as User;
  }
  async deleteUser(id: string): Promise<void> {
    const { error } = await this.sb().from("users").delete().eq("id", id);
    if (error) throw error;
  }
  // GDPR Article 17 (right to erasure) — anonymise the PII columns
  // (username, ip, user_agent) of every audit_logs row owned by `userId`,
  // WITHOUT deleting the rows (audit_logs is append-only by migration 010
  // for tamper-evidence / financial-audit reasons; we strip PII but keep
  // the audit trail). Implemented as a SECURITY DEFINER RPC that
  // temporarily disables the append-only trigger. Created by migration
  // `supabase/migrations/030_gdpr_audit_anonymization.sql`. Must be called
  // BEFORE `deleteUser` so the user_id still exists in audit_logs to match
  // on (the function filters `WHERE user_id = p_user_id`).
  async anonymizeUserAuditLogs(userId: string): Promise<number> {
    const { data, error } = await this.sb().rpc(
      "anonymize_user_audit_logs",
      { p_user_id: userId },
    );
    if (error) {
      // The RPC was added by migration 030. If it is missing (e.g. the
      // migration has not been applied to this environment, or the store
      // is pointing at a non-Supabase backend), surface a clear error
      // rather than silently leaving PII behind — a failed right-to-erasure
      // request is a GDPR violation, not a recoverable warning.
      throw new Error(
        `anonymizeUserAuditLogs failed for user ${userId}: ${error.message} ` +
          `(has migration 030_gdpr_audit_anonymization.sql been applied?)`,
      );
    }
    return (data as number) ?? 0;
  }
  async updateUserLastLogin(id: string, ip: string): Promise<void> {
    const { error } = await this.sb()
      .from("users")
      .update({ last_login_at: new Date().toISOString(), last_login_ip: ip })
      .eq("id", id);
    if (error) throw error;
  }
  async bumpUserTokenVersion(id: string): Promise<number> {
    // CRITICAL FIX (audit M-4): use atomic increment via RPC instead of
    // read-modify-write. Previously two concurrent calls could both read
    // token_version=5 and both write 6 — losing one increment and breaking
    // session invalidation guarantees.
    //
    // The RPC `bump_token_version(p_user_id)` is created by migration
    // `supabase/migrations/017_bump_token_version_rpc.sql`. It performs a
    // single UPDATE ... SET token_version = COALESCE(token_version, 0) + 1
    // RETURNING token_version, which is atomic at the Postgres level.
    //
    // Fallback: if the RPC is missing (e.g. migration not yet applied to
    // this environment, or running against the mock/prima store which
    // doesn't implement it), fall back to the old read-modify-write. This
    // is less safe under concurrency but preserves functionality.
    const { data, error } = await this.sb().rpc("bump_token_version", { p_user_id: id });
    if (error) {
      // Fall back to read-modify-write if RPC doesn't exist.
      const u = await this.getUserById(id);
      const next = (u?.token_version ?? 0) + 1;
      const { error: e2 } = await this.sb().from("users").update({ token_version: next }).eq("id", id);
      if (e2) throw e2;
      return next;
    }
    return data ?? 0;
  }

  // ---- partners ----
  async listPartners(tenantId: string, params?: ListParams): Promise<ListResult<Partner>> {
    let q = this.sb().from("partners").select("*", { count: "exact" });
    if (tenantId) q = q.eq("tenant_id", tenantId);
    // D-1: tsvector full-text search on (name A, email B, contact_name B, phone C)
    // via the partners_search_idx GIN index — replaces O(n) ILIKE seq-scan.
    // Migration 037_fulltext_search.sql adds the column + trigger + index.
    if (params?.search) q = q.textSearch("search_vector", params.search, { type: "websearch" });
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    if (params?.filters?.type) q = q.eq("type", params.filters.type);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Partner>(q, params);
  }
  async getPartner(id: string): Promise<Partner | null> {
    const { data, error } = await this.sb().from("partners").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Partner) || null;
  }
  async upsertPartner(p: Partial<Partner> & { id?: string }): Promise<Partner> {
    return this.smartUpsert<Partner>("partners", p, p.tenant_id ?? undefined);
  }
  async deletePartner(id: string): Promise<void> {
    const { error } = await this.sb().from("partners").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- products ----
  async listProducts(tenantId: string, params?: ListParams): Promise<ListResult<Product>> {
    let q = this.sb().from("products").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    // D-1: tsvector full-text search on (name A, sku A, description B,
    // category B, brand C, hs_code C) via products_search_idx GIN index —
    // replaces the legacy name+sku ILIKE pair AND broadens match coverage.
    if (params?.search) q = q.textSearch("search_vector", params.search, { type: "websearch" });
    if (params?.filters?.category) q = q.eq("category", params.filters.category);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Product>(q, params);
  }
  async getProduct(id: string): Promise<Product | null> {
    const { data, error } = await this.sb().from("products").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Product) || null;
  }
  async upsertProduct(p: Partial<Product> & { id?: string }): Promise<Product> {
    return this.smartUpsert<Product>("products", p, p.tenant_id ?? undefined);
  }
  async deleteProduct(id: string): Promise<void> {
    const { error } = await this.sb().from("products").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- deals ----
  async listDeals(tenantId: string, params?: ListParams): Promise<ListResult<Deal>> {
    let q = this.sb().from("deals").select("*", { count: "exact" });
    if (tenantId) q = q.eq("tenant_id", tenantId);
    // D-1: tsvector full-text search on (title A, description B) via
    // deals_search_idx GIN index — replaces single-column title ILIKE
    // and adds description coverage.
    if (params?.search) q = q.textSearch("search_vector", params.search, { type: "websearch" });
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    if (params?.filters?.stage) q = q.eq("stage", params.filters.stage);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Deal>(q, params);
  }
  async getDeal(id: string): Promise<Deal | null> {
    const { data, error } = await this.sb().from("deals").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Deal) || null;
  }
  async upsertDeal(d: Partial<Deal> & { id?: string }): Promise<Deal> {
    return this.smartUpsert<Deal>("deals", d, d.tenant_id ?? undefined);
  }
  async deleteDeal(id: string): Promise<void> {
    const { error } = await this.sb().from("deals").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- offers ----
  async listOffers(tenantId: string, params?: ListParams): Promise<ListResult<Offer>> {
    let q = this.sb().from("offers").select("*", { count: "exact" });
    if (tenantId) q = q.eq("tenant_id", tenantId);
    // D-1: tsvector full-text search on (number A, subject B, notes C)
    // via offers_search_idx GIN index — replaces number+subject ILIKE pair
    // and adds notes coverage. NOTE: the column is `number` not
    // `offer_number` (see migration 037 header comment).
    if (params?.search) q = q.textSearch("search_vector", params.search, { type: "websearch" });
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Offer>(q, params);
  }
  async getOffer(id: string): Promise<Offer | null> {
    const { data, error } = await this.sb().from("offers").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Offer) || null;
  }
  async upsertOffer(o: Partial<Offer> & { id?: string }): Promise<Offer> {
    return this.smartUpsert<Offer>("offers", o, o.tenant_id ?? undefined);
  }
  async deleteOffer(id: string): Promise<void> {
    const { error } = await this.sb().from("offers").delete().eq("id", id);
    if (error) throw error;
  }

  /**
   * Atomic document creation with auto-generated sequence number.
   *
   * P1 (VAT compliance) / task C-4 Fix 1: delegates to the
   * `create_doc_with_number` Postgres RPC (migration 032), which calls
   * `nextval()` on the per-doc-type SEQUENCE and INSERTs the row in a
   * single function call. This minimises VAT-sequence gaps that occur
   * when the legacy two-step pattern (`nextDocNumber()` → `upsertX()`)
   * fails between the nextval() and the INSERT.
   *
   * IMPORTANT: this method is for the INSERT path only (new records with
   * no client-supplied `id` or `number`). Callers MUST have already:
   *   - validated the payload (required fields, FK targets, etc.)
   *   - stripped non-column fields (e.g. `_`-prefixed trade-calc metadata)
   *   - verified tenant_id is set
   * The RPC will OVERRIDE any client-supplied `number` field with the
   * server-generated value.
   *
   * Falls back to the legacy two-step pattern (`nextDocNumber()` +
   * `smartUpsert`) if the RPC is unavailable (e.g. before migration 032
   * has been applied, or Supabase unreachable). The fallback is NOT
   * atomic — a gap can still occur — but it preserves backward
   * compatibility.
   */
  async createDocWithNumber(
    docType: "offer" | "invoice" | "proforma" | "demand" | "rfq",
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Sanitize the payload through the same path used by smartUpsert so
    // JOIN keys, empty strings, and nested objects are stripped before
    // the RPC sees them (the RPC's jsonb_populate_record would otherwise
    // raise "column does not exist" on unknown keys for some schemas).
    const sanitized = this.sanitizePayload({ ...payload });

    try {
      const { data, error } = await this.sb().rpc("create_doc_with_number", {
        p_doc_type: docType,
        p_payload: sanitized,
      });
      if (error) {
        // PGRST errors (constraint violations, etc.) surface here. Throw
        // so the route handler can return a 500 and the gap is at least
        // logged (the nextval value is still consumed — Postgres SEQUENCE
        // limitation — but the failure is visible, not silent).
        throw new Error(
          `create_doc_with_number RPC failed for '${docType}': ${error.message}`,
        );
      }
      if (!data || typeof data !== "object") {
        throw new Error(
          `create_doc_with_number RPC returned no data for '${docType}'`,
        );
      }
      return data as Record<string, unknown>;
    } catch (e: any) {
      // If the RPC itself is missing (migration 032 not applied yet) the
      // supabase-js client returns a PGRST error like "Could not find the
      // function public.create_doc_with_number". Fall back to the legacy
      // two-step pattern so the app keeps working on un-migrated deploys.
      const msg = String(e?.message || e);
      if (
        msg.includes("create_doc_with_number") &&
        (msg.includes("Could not find") || msg.includes("does not exist") || msg.includes("not found"))
      ) {
        console.warn(
          `[createDocWithNumber] RPC unavailable (migration 032 not applied?), falling back to legacy two-step pattern for '${docType}':`,
          msg,
        );
        return this.createDocWithNumberLegacy(docType, payload);
      }
      // Genuine insert failure (constraint violation, etc.) — re-throw so
      // the route handler returns a 500 and the failure is visible.
      throw e;
    }
  }

  /**
   * Legacy two-step fallback: nextDocNumber() → smartUpsert(). Used when
   * the `create_doc_with_number` RPC is unavailable. NOT atomic — a gap
   * can occur if the upsert fails after nextval(). Kept for backward
   * compatibility with deployments that haven't applied migration 032.
   */
  private async createDocWithNumberLegacy(
    docType: "offer" | "invoice" | "proforma" | "demand" | "rfq",
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { nextDocNumber, formatDocNumber } = await import("@/lib/api/doc-number");
    let seqNum = await nextDocNumber(docType);
    // F-FINAL / P0: defensive fallback — if the atomic RPC returned null
    // (Supabase unreachable, migration 011 not applied, or PGRST arg-name
    // mismatch regression), fall back to the legacy `listX().total + 1`
    // approach so the INSERT still gets a number and doesn't trip the
    // NOT NULL constraint on `offers.number` / `invoices.number` /
    // `proformas.number` / etc. This matches the original defensive
    // design described in the doc-number.ts header comment and the
    // createDocWithNumber docstring above.
    if (!seqNum) {
      const tid = (payload as any).tenant_id as string | undefined;
      if (tid) {
        try {
          let total = 0;
          switch (docType) {
            case "offer":    total = (await this.listOffers(tid)).total; break;
            case "invoice":  total = (await this.listInvoices(tid)).total; break;
            case "proforma": total = (await this.listProformas(tid)).total; break;
            case "demand":   total = (await this.listDemands(tid)).total; break;
            case "rfq":      total = (await this.listPortalRfqs(tid)).total; break;
          }
          const year = new Date().getFullYear();
          seqNum = formatDocNumber(docType, year, total + 1);
          console.warn(
            `[createDocWithNumberLegacy] RPC returned null for '${docType}', ` +
            `falling back to listX().total + 1 = ${seqNum} (tenant ${tid}).`,
          );
        } catch (fallbackErr: any) {
          console.error(
            `[createDocWithNumberLegacy] listX fallback failed for '${docType}':`,
            fallbackErr?.message || fallbackErr,
          );
        }
      }
    }
    if (seqNum) {
      payload.number = seqNum;
    }
    // Delegate to the existing per-doc-type upsert. We map doc_type →
    // method rather than dispatching through smartUpsert directly so the
    // per-table behaviour (e.g. offer items handling, totals recomputation)
    // is preserved.
    switch (docType) {
      case "offer":
        return this.smartUpsert<Offer>("offers", payload as Partial<Offer> & { id?: string }, (payload as any).tenant_id) as unknown as Record<string, unknown>;
      case "invoice":
        return this.smartUpsert<Invoice>("invoices", payload as Partial<Invoice> & { id?: string }, (payload as any).tenant_id) as unknown as Record<string, unknown>;
      case "proforma":
        return this.smartUpsert<Proforma>("proformas", payload as Partial<Proforma> & { id?: string }, (payload as any).tenant_id) as unknown as Record<string, unknown>;
      case "demand":
        return this.smartUpsert<Demand>("demands", payload as Partial<Demand> & { id?: string }, (payload as any).tenant_id) as unknown as Record<string, unknown>;
      case "rfq":
        return this.smartUpsert<PortalRfq>("portal_rfqs", payload as Partial<PortalRfq> & { id?: string }, (payload as any).tenant_id) as unknown as Record<string, unknown>;
      default:
        throw new Error(`createDocWithNumberLegacy: unsupported doc_type '${docType}'`);
    }
  }

  // ---- demands ----
  async listDemands(tenantId: string, params?: ListParams): Promise<ListResult<Demand>> {
    let q = this.sb().from("demands").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`number.ilike.%${safeSearch(params.search)}%,subject.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Demand>(q, params);
  }
  async getDemand(id: string): Promise<Demand | null> {
    const { data, error } = await this.sb().from("demands").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Demand) || null;
  }
  async upsertDemand(d: Partial<Demand> & { id?: string }): Promise<Demand> {
    return this.smartUpsert<Demand>("demands", d, d.tenant_id ?? undefined);
  }
  async deleteDemand(id: string): Promise<void> {
    const { error } = await this.sb().from("demands").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- documents ----
  async listDocuments(tenantId: string, params?: ListParams): Promise<ListResult<SharedDocument>> {
    let q = this.sb().from("shared_documents").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.ilike("filename", `%${params.search}%`);
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<SharedDocument>(q, params);
  }
  async getDocument(id: string): Promise<SharedDocument | null> {
    const { data, error } = await this.sb().from("shared_documents").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as SharedDocument) || null;
  }
  async upsertDocument(d: Partial<SharedDocument> & { id?: string }): Promise<SharedDocument> {
    return this.smartUpsert<SharedDocument>("shared_documents", d, d.tenant_id ?? undefined);
  }
  async deleteDocument(id: string): Promise<void> {
    const { error } = await this.sb().from("shared_documents").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- audit ----
  async listAudit(tenantId: string, params?: ListParams): Promise<ListResult<AuditLog>> {
    let q = this.sb().from("audit_logs").select("*", { count: "exact" });
    if (tenantId) q = q.eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`action.ilike.%${safeSearch(params.search)}%,username.ilike.%${safeSearch(params.search)}%`);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<AuditLog>(q, params);
  }
  async appendAudit(entry: Omit<AuditLog, "id" | "created_at">): Promise<AuditLog> {
    const { data, error } = await this.sb()
      .from("audit_logs")
      .insert({ ...entry })
      .select()
      .single();
    if (error) throw error;
    return data as AuditLog;
  }

  // ---- settings ----
  // Every setting lives under a specific tenant_id. `tenant_id = null` rows
  // are PLATFORM-level settings (fallback SMTP, platform password policy,
  // etc.) — only super_admin can read/write those.
  async getSetting<T = unknown>(key: string, tenantId: string | null = null): Promise<T | null> {
    const q = this.sb().from("settings").select("value").eq("key", key);
    if (tenantId === null) q.is("tenant_id", null);
    else q.eq("tenant_id", tenantId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data?.value as T) ?? null;
  }
  async setSetting(key: string, value: unknown, tenantId: string | null = null): Promise<void> {
    // Manual upsert: composite key (tenant_id, key) — but tenant_id can be null,
    // so we look up first then update or insert.
    const existing = this.sb().from("settings").select("id").eq("key", key);
    if (tenantId === null) existing.is("tenant_id", null);
    else existing.eq("tenant_id", tenantId);
    const { data: found } = await existing.maybeSingle();
    if (found) {
      const { error } = await this.sb()
        .from("settings")
        .update({ value, updated_at: new Date().toISOString() })
        .eq("id", (found as any).id);
      if (error) throw error;
    } else {
      const { error } = await this.sb()
        .from("settings")
        .insert({ key, value, tenant_id: tenantId, updated_at: new Date().toISOString() });
      if (error) throw error;
    }
  }
  async getAllSettings(tenantId: string | null = null): Promise<Setting[]> {
    const q = this.sb().from("settings").select("*");
    if (tenantId === null) q.is("tenant_id", null);
    else q.eq("tenant_id", tenantId);
    const { data, error } = await q;
    if (error) throw error;
    return (data as Setting[]) || [];
  }

  // ---- tasks ----
  async listTasks(tenantId: string, userId?: string): Promise<UserTask[]> {
    let q = this.sb().from("user_tasks").select("*").eq("tenant_id", tenantId);
    if (userId) q = q.eq("user_id", userId);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return (data as UserTask[]) || [];
  }
  async upsertTask(t: Partial<UserTask> & { id?: string }): Promise<UserTask> {
    return this.smartUpsert<UserTask>("user_tasks", t, t.tenant_id ?? undefined);
  }
  async deleteTask(id: string): Promise<void> {
    const { error } = await this.sb().from("user_tasks").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- notes ----
  async listNotes(tenantId: string, entityType: string, entityId: string): Promise<EntityNote[]> {
    const { data, error } = await this.sb()
      .from("entity_notes")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as EntityNote[]) || [];
  }
  async upsertNote(n: Partial<EntityNote> & { id?: string }): Promise<EntityNote> {
    return this.smartUpsert<EntityNote>("entity_notes", n, n.tenant_id ?? undefined);
  }
  async deleteNote(id: string): Promise<void> {
    const { error } = await this.sb().from("entity_notes").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- inventory ----
  async listInventory(tenantId: string, partnerId: string): Promise<InventoryMovement[]> {
    const { data, error } = await this.sb()
      .from("inventory_movements")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("partner_id", partnerId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as InventoryMovement[]) || [];
  }
  async addInventoryMovement(m: Partial<InventoryMovement> & { id?: string }): Promise<InventoryMovement> {
    const payload: SupaRow = { ...m };
    const { data, error } = await this.sb().from("inventory_movements").insert(payload).select().single();
    if (error) throw error;
    return data as InventoryMovement;
  }

  // ---- dashboard ----
  async getInsights(tenantId?: string): Promise<DashboardInsights> {
    const sb = this.sb();
    const partnersQ = sb.from("partners").select("id, status");
    const dealsQ = sb.from("deals").select("id, stage, value, partner_id");
    const offersQ = sb.from("offers").select("id, status, created_at");
    const productsQ = sb.from("products").select("id, name, sku, stock, reorder_level");
    let auditQ = sb.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(6);
    const invoicesQ = sb.from("invoices").select("id, status, total, paid_at");
    const inventoryQ = sb.from("inventory_movements").select("id, created_at");

    if (tenantId) {
      partnersQ.eq("tenant_id", tenantId);
      dealsQ.eq("tenant_id", tenantId);
      offersQ.eq("tenant_id", tenantId);
      productsQ.eq("tenant_id", tenantId);
      auditQ = auditQ.eq("tenant_id", tenantId);
      invoicesQ.eq("tenant_id", tenantId);
      inventoryQ.eq("tenant_id", tenantId);
    }

    const [partnersR, dealsR, offersR, productsR, auditR, invoicesR, inventoryR] = await Promise.all([
      partnersQ,
      dealsQ,
      offersQ,
      productsQ,
      auditQ,
      invoicesQ,
      inventoryQ,
    ]);

    const partners = (partnersR.data as Partner[]) || [];
    const deals = (dealsR.data as Deal[]) || [];
    const offers = (offersR.data as Offer[]) || [];
    const products = (productsR.data as Product[]) || [];
    const recent = (auditR.data as AuditLog[]) || [];
    const invoices = (invoicesR.data as Invoice[]) || [];
    const inventoryMovements = (inventoryR.data as InventoryMovement[]) || [];

    const openDeals = deals.filter((d) => !["won", "lost"].includes(d.stage));
    const wonValue = deals.filter((d) => d.stage === "won").reduce((s, d) => s + (d.value || 0), 0);
    const pipelineValue = openDeals.reduce((s, d) => s + (d.value || 0), 0);
    const lowStockProducts = products
      .filter((p) => (p.reorder_level || 0) > 0 && (p.stock || 0) <= (p.reorder_level || 0))
      .map((p) => ({ id: p.id, name: p.name, sku: p.sku, stock: p.stock || 0, reorder_level: p.reorder_level || 0 }))
      .slice(0, 5);
    const lowStock = lowStockProducts.length;

    // outstanding invoices = sent or overdue
    const outstandingInvoices = invoices.filter(
      (i) => i.status === "sent" || i.status === "overdue"
    ).length;

    // inventory movements in the last 30 days
    const inv30 = inventoryMovements.filter(
      (m) => Date.now() - new Date(m.created_at).getTime() < 30 * 86400000
    ).length;

    const stages: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
    const byStage = stages.map((stage) => ({
      stage,
      count: deals.filter((d) => d.stage === stage).length,
      value: deals.filter((d) => d.stage === stage).reduce((s, d) => s + (d.value || 0), 0),
    }));

    // top partners by deal value
    const partnerValue = new Map<string, number>();
    deals.forEach((d) => partnerValue.set(d.partner_id, (partnerValue.get(d.partner_id) || 0) + (d.value || 0)));
    // P2 / task C-6 Fix 2: previously this made one `getPartner(pid)` query
    // per top-deal partner (N+1 — up to 5 separate round-trips just to
    // resolve names for the dashboard widget). Now batched into a single
    // `IN` query; falls back to the partner id if the row is missing or
    // the query itself fails (defence-in-depth — the dashboard must not
    // 500 just because the partners lookup failed).
    // S-FIX / defense-in-depth: the `dealsQ` above is already tenant-
    // scoped, so `partnerValue` should only ever contain partner_ids from
    // the caller's tenant. However, if a cross-tenant partner_id were
    // somehow already stored on a deal row (e.g. via the now-fixed POST
    // /api/deals IDOR, or by direct DB insertion), the lookup below would
    // resolve its name and silently leak it to the dashboard. Adding
    // `.eq("tenant_id", tenantId)` here means a cross-tenant partner_id
    // is treated as "unknown" — the dashboard falls back to showing the
    // raw id rather than the partner name. No enumeration leak.
    const topPartnerIds = Array.from(partnerValue.keys()).slice(0, 5);
    let partnerNameMap = new Map<string, string>();
    if (topPartnerIds.length > 0) {
      try {
        const partnerQuery = this.sb()
          .from("partners")
          .select("id, name")
          .in("id", topPartnerIds);
        // Only apply the tenant filter when we actually have a tenantId —
        // super-admin (tenantId undefined) intentionally sees across
        // tenants on the platform-level dashboard.
        if (tenantId) partnerQuery.eq("tenant_id", tenantId);
        const { data: partnerRows, error: partnerErr } = await partnerQuery;
        if (!partnerErr && partnerRows) {
          for (const p of partnerRows as Pick<Partner, "id" | "name">[]) {
            partnerNameMap.set(p.id, p.name || p.id);
          }
        }
      } catch {
        // Non-fatal — fall back to using the partner id as the name.
      }
    }
    const topPartners = topPartnerIds
      .map((pid) => ({
        id: pid,
        name: partnerNameMap.get(pid) || pid,
        deal_value: partnerValue.get(pid) || 0,
      }))
      .sort((a, b) => b.deal_value - a.deal_value)
      .slice(0, 5);

    // offers last 14 days (best-effort from returned data)
    const offersLast30: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      offersLast30.push({ date: d, count: offers.filter((o) => (o.created_at || "").slice(0, 10) === d).length });
    }

    // revenue last 14 days (sum of invoice totals paid on that day)
    const revenueLast30: { date: string; value: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const value = invoices
        .filter((inv) => inv.status === "paid" && (inv.paid_at || "").slice(0, 10) === d)
        .reduce((s, inv) => s + (inv.total || 0), 0);
      revenueLast30.push({ date: d, value });
    }

    return {
      kpis: {
        partners_total: partners.length,
        partners_active: partners.filter((p) => p.status === "active").length,
        deals_open: openDeals.length,
        deals_won_value: wonValue,
        pipeline_value: pipelineValue,
        offers_pending: offers.filter((o) => o.status === "sent" || o.status === "draft").length,
        low_stock_count: lowStock,
        invoices_outstanding: outstandingInvoices,
        inventory_movements_30d: inv30,
      },
      deals_by_stage: byStage,
      offers_last_30d: offersLast30,
      revenue_last_30d: revenueLast30,
      recent_activity: recent,
      top_partners: topPartners,
      low_stock_products: lowStockProducts,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Dashboard analytics charts (task D-2).
  //
  // Five pre-aggregated series returned in ONE round-trip so the dashboard
  // can render every chart from a single fetch. The wire payload is kept
  // small by selecting only the columns needed for aggregation (mirrors
  // the getInsights() pattern — never `select("*")` for analytics).
  //
  // Series semantics:
  //   • salesData       — monthly revenue from invoices ISSUED
  //                       (issue_date bucket, excludes cancelled invoices)
  //   • topProducts     — top N products by aggregate offer line-item total
  //   • offerStatus     — count + total value grouped by OfferStatus
  //   • marginByCategory — volume-weighted avg (price-cost)/price %
  //                       grouped by Product.category
  //   • paymentTrend    — monthly CASH received from PAID invoices
  //                       (paid_at bucket, status=paid only)
  //
  // `period` is currently advisory — only "12m" is implemented. Any other
  // value (or undefined) falls back to 12 months so the endpoint stays
  // usable for new tenants with sparse data.
  // ────────────────────────────────────────────────────────────────────────
  async getDashboardCharts(
    tenantId: string | null | undefined,
    period: string = "12m",
    topN: number = 5,
  ): Promise<DashboardCharts> {
    const sb = this.sb();
    const months = period === "6m" ? 6 : 12; // only 12m / 6m honoured; default 12

    // ── Time bucket helpers ────────────────────────────────────────────────
    // Build the list of trailing month buckets (oldest → newest) so empty
    // months still appear in the series with zero values. Buckets are keyed
    // by "YYYY-MM" (ISO) and labelled with a short, locale-neutral
    // "Mon YYYY" string (pre-formatted server-side so the client doesn't
    // need a date lib to render the axis).
    const now = new Date();
    const buckets: { key: string; label: string; year: number; month: number }[] = [];
    const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      buckets.push({
        key,
        label: `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        year: d.getUTCFullYear(),
        month: d.getUTCMonth(),
      });
    }
    const earliest = Date.UTC(buckets[0].year, buckets[0].month, 1);

    // ── Parallel column-projected queries ─────────────────────────────────
    // Only select the columns needed for aggregation — fetching `items`
    // (jsonb) on every offer would balloon the payload (offers carry the
    // full line-item array). We pull items separately ONLY for the top-N
    // computation to keep memory + wire cost bounded.
    const invoicesQ = sb.from("invoices")
      .select("id, status, total, issue_date, paid_at");
    const offersStatusQ = sb.from("offers")
      .select("id, status, total");
    const offersItemsQ = sb.from("offers")
      .select("id, status, items");
    const productsQ = sb.from("products")
      .select("id, name, sku, category, price, cost");

    if (tenantId) {
      invoicesQ.eq("tenant_id", tenantId);
      offersStatusQ.eq("tenant_id", tenantId);
      offersItemsQ.eq("tenant_id", tenantId);
      productsQ.eq("tenant_id", tenantId);
    }

    const [invoicesR, offersStatusR, offersItemsR, productsR] = await Promise.all([
      invoicesQ,
      offersStatusQ,
      offersItemsQ,
      productsQ,
    ]);

    type InvoiceLite = { id: string; status: string; total: number | null;
                         issue_date: string | null; paid_at: string | null };
    type OfferLite = { id: string; status: OfferStatus; total: number | null };
    type OfferWithItems = { id: string; status: OfferStatus;
                            items: Offer["items"] | null };
    type ProductLite = { id: string; name: string; sku: string;
                         category: string | null;
                         price: number | null; cost: number | null };

    const invoices = (invoicesR.data as InvoiceLite[]) || [];
    const offersStatusRows = (offersStatusR.data as OfferLite[]) || [];
    const offersItemsRows = (offersItemsR.data as OfferWithItems[]) || [];
    const products = (productsR.data as ProductLite[]) || [];

    // ── 1. Sales trend (monthly invoices issued, excl. cancelled) ─────────
    // Buckets by `issue_date` (the date the invoice was raised to the
    // customer). "Cancelled" invoices are excluded — they represent
    // voided sales, not actual revenue.
    const salesByMonth = new Map<string, { revenue: number; count: number }>();
    for (const b of buckets) salesByMonth.set(b.key, { revenue: 0, count: 0 });

    for (const inv of invoices) {
      if (inv.status === "cancelled") continue;
      if (!inv.issue_date) continue;
      const d = new Date(inv.issue_date);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const bucket = salesByMonth.get(key);
      if (!bucket) continue; // outside the trailing window
      const t = Number(inv.total) || 0;
      bucket.revenue += t;
      bucket.count += 1;
    }

    const salesData: DashboardSalesPoint[] = buckets.map((b) => ({
      month: b.key,
      label: b.label,
      revenue: Math.round((salesByMonth.get(b.key)?.revenue || 0) * 100) / 100,
      count: salesByMonth.get(b.key)?.count || 0,
    }));

    // ── 2. Top products by offer line-item revenue ────────────────────────
    // Walks every offer's `items` jsonb array and aggregates `total` per
    // `product_id`. Skips line items with no product_id (free-text lines
    // aren't attributable to a catalogue product). Caps at `topN` after
    // sorting by revenue desc.
    type Acc = { product_id: string; name: string; sku: string;
                 revenue: number; count: number };
    const productAgg = new Map<string, Acc>();
    for (const o of offersItemsRows) {
      if (!o.items || !Array.isArray(o.items)) continue;
      for (const line of o.items) {
        const pid = (line as { product_id?: string | null }).product_id;
        if (!pid) continue;
        const total = Number((line as { total?: number | null }).total) || 0;
        const name = (line as { product_name?: string | null }).product_name || pid;
        const sku = (line as { sku?: string | null }).sku || "";
        const prev = productAgg.get(pid) ||
          { product_id: pid, name, sku, revenue: 0, count: 0 };
        prev.revenue += total;
        prev.count += 1;
        // Prefer the most recent non-empty name/sku seen (offers may
        // rename products over time — keep the latest label).
        if (name && name !== pid) prev.name = name;
        if (sku) prev.sku = sku;
        productAgg.set(pid, prev);
      }
    }
    const topProducts: DashboardTopProduct[] = Array.from(productAgg.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, Math.max(1, Math.min(topN, 20)))
      .map((p) => ({
        product_id: p.product_id,
        name: p.name,
        sku: p.sku,
        revenue: Math.round(p.revenue * 100) / 100,
        count: p.count,
      }));

    // ── 3. Offer status distribution ──────────────────────────────────────
    // Counts every offer (no time filter — status is current state, not a
    // time series). Slices are emitted in the canonical OfferStatus order
    // so the donut chart legend reads top-to-bottom: draft → sent →
    // accepted → rejected → expired. Zero-count slices are still emitted
    // so the legend stays stable.
    const STATUS_ORDER: OfferStatus[] =
      ["draft", "sent", "accepted", "rejected", "expired"];
    const statusAgg = new Map<OfferStatus, { count: number; value: number }>();
    for (const s of STATUS_ORDER) statusAgg.set(s, { count: 0, value: 0 });
    for (const o of offersStatusRows) {
      const s = (o.status || "draft") as OfferStatus;
      if (!statusAgg.has(s)) statusAgg.set(s, { count: 0, value: 0 });
      const entry = statusAgg.get(s)!;
      entry.count += 1;
      entry.value += Number(o.total) || 0;
    }
    const offerStatus: DashboardOfferStatusSlice[] = STATUS_ORDER.map((s) => ({
      status: s,
      count: statusAgg.get(s)?.count || 0,
      value: Math.round((statusAgg.get(s)?.value || 0) * 100) / 100,
    }));

    // ── 4. Margin by category ─────────────────────────────────────────────
    // For each product, margin % = (price - cost) / price * 100 (when both
    // are positive). Aggregated per category using a SIMPLE average (not
    // volume-weighted — we don't have a reliable quantity signal on the
    // products table; volume-weighting would have to come from trade
    // calculations or offer line items, which is a different aggregation
    // level). Products with no `cost`, no `price`, or `price <= 0` are
    // skipped (margin undefined). Products with no category fall under
    // "Uncategorised".
    const catAgg = new Map<string, { sum: number; count: number }>();
    for (const p of products) {
      const price = Number(p.price) || 0;
      const cost = Number(p.cost) || 0;
      if (price <= 0) continue; // margin undefined without a sell price
      const marginPct = ((price - cost) / price) * 100;
      const cat = (p.category && String(p.category).trim()) || "Uncategorised";
      const prev = catAgg.get(cat) || { sum: 0, count: 0 };
      prev.sum += marginPct;
      prev.count += 1;
      catAgg.set(cat, prev);
    }
    const marginByCategory: DashboardMarginByCategory[] = Array.from(catAgg.entries())
      .map(([category, v]) => ({
        category,
        marginPct: Math.round((v.sum / v.count) * 10) / 10,
        productCount: v.count,
      }))
      .sort((a, b) => b.marginPct - a.marginPct)
      .slice(0, 10); // cap at 10 categories for legibility

    // ── 5. Payment trend (monthly cash received from paid invoices) ───────
    // Buckets by `paid_at` (the date the payment was recorded). Only
    // status=paid invoices contribute. Same trailing-month window as the
    // sales series so the two charts align on the x-axis.
    const paymentsByMonth = new Map<string, { payments: number; count: number }>();
    for (const b of buckets) paymentsByMonth.set(b.key, { payments: 0, count: 0 });

    for (const inv of invoices) {
      if (inv.status !== "paid") continue;
      if (!inv.paid_at) continue;
      const d = new Date(inv.paid_at);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const bucket = paymentsByMonth.get(key);
      if (!bucket) continue; // outside the trailing window
      bucket.payments += Number(inv.total) || 0;
      bucket.count += 1;
    }

    const paymentTrend: DashboardPaymentPoint[] = buckets.map((b) => ({
      month: b.key,
      label: b.label,
      payments: Math.round((paymentsByMonth.get(b.key)?.payments || 0) * 100) / 100,
      count: paymentsByMonth.get(b.key)?.count || 0,
    }));

    // `earliest` is currently unused for filtering (the trailing buckets
    // already restrict the series), but it's referenced here to silence
    // "declared but never used" for future time-window logic. Drop when
    // a real filter is added.
    void earliest;

    return {
      period,
      salesData,
      topProducts,
      offerStatus,
      marginByCategory,
      paymentTrend,
    };
  }

  // ---- invoices ----
  async listInvoices(tenantId: string, params?: ListParams): Promise<ListResult<Invoice>> {
    let q = this.sb().from("invoices").select("*", { count: "exact" });
    if (tenantId) q = q.eq("tenant_id", tenantId);
    // D-1: tsvector full-text search on (number A, notes C) via
    // invoices_search_idx GIN index — replaces number+subject ILIKE pair.
    // NOTE: the legacy ILIKE included `subject` but the task D-1 spec scopes
    // the invoice search_vector to (number, notes) only — invoice.subject is
    // usually a short copy of offer.subject and is well-covered by `number`.
    if (params?.search) q = q.textSearch("search_vector", params.search, { type: "websearch" });
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Invoice>(q, params);
  }
  async getInvoice(id: string): Promise<Invoice | null> {
    const { data, error } = await this.sb().from("invoices").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Invoice) || null;
  }
  async upsertInvoice(i: Partial<Invoice> & { id?: string }): Promise<Invoice> {
    return this.smartUpsert<Invoice>("invoices", i, i.tenant_id ?? undefined);
  }
  async deleteInvoice(id: string): Promise<void> {
    const { error } = await this.sb().from("invoices").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- proformas ----
  async listProformas(tenantId: string, params?: ListParams): Promise<ListResult<Proforma>> {
    let q = this.sb().from("proformas").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`number.ilike.%${safeSearch(params.search)}%,subject.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<Proforma>(q, params);
  }
  async getProforma(id: string): Promise<Proforma | null> {
    const { data, error } = await this.sb().from("proformas").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Proforma) || null;
  }
  async upsertProforma(p: Partial<Proforma> & { id?: string }): Promise<Proforma> {
    return this.smartUpsert<Proforma>("proformas", p, p.tenant_id ?? undefined);
  }
  async deleteProforma(id: string): Promise<void> {
    const { error } = await this.sb().from("proformas").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- document register ----
  async listDocumentRegister(tenantId: string, params?: ListParams): Promise<ListResult<DocumentRegisterEntry>> {
    let q = this.sb().from("document_register").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`number.ilike.%${safeSearch(params.search)}%,title.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.type) q = q.eq("type", params.filters.type);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<DocumentRegisterEntry>(q, params);
  }
  async upsertDocumentRegisterEntry(e: Partial<DocumentRegisterEntry> & { id?: string }): Promise<DocumentRegisterEntry> {
    return this.smartUpsert<DocumentRegisterEntry>("document_register", e, e.tenant_id ?? undefined);
  }
  async listDocumentRevisions(tenantId: string, documentId: string): Promise<DocumentRevision[]> {
    const { data, error } = await this.sb()
      .from("document_revisions")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("document_id", documentId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as DocumentRevision[]) || [];
  }
  async addDocumentRevision(r: Partial<DocumentRevision> & { id?: string }): Promise<DocumentRevision> {
    const payload: SupaRow = { ...r };
    if (r.id) payload.id = r.id;
    if (!payload.tenant_id && r.tenant_id) payload.tenant_id = r.tenant_id;
    const { data, error } = await this.sb().from("document_revisions").insert(payload).select().single();
    if (error) throw error;
    return data as DocumentRevision;
  }
  async deleteDocumentRegisterEntry(id: string): Promise<void> {
    const { error } = await this.sb().from("document_register").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- vault ----
  async listVault(tenantId: string, params?: ListParams): Promise<ListResult<VaultSecret>> {
    let q = this.sb().from("vault_secrets").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`key.ilike.%${safeSearch(params.search)}%,description.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.category) q = q.eq("category", params.filters.category);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<VaultSecret>(q, params);
  }
  async upsertVaultSecret(s: Partial<VaultSecret> & { id?: string }): Promise<VaultSecret> {
    return this.smartUpsert<VaultSecret>("vault_secrets", s, s.tenant_id ?? undefined);
  }
  async deleteVaultSecret(id: string): Promise<void> {
    const { error } = await this.sb().from("vault_secrets").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- api keys ----
  async listApiKeys(tenantId: string): Promise<ApiKey[]> {
    const { data, error } = await this.sb().from("api_keys").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data as ApiKey[]) || [];
  }
  async upsertApiKey(k: Partial<ApiKey> & { id?: string }): Promise<ApiKey> {
    return this.smartUpsert<ApiKey>("api_keys", k, k.tenant_id ?? undefined);
  }
  async deleteApiKey(id: string): Promise<void> {
    const { error } = await this.sb().from("api_keys").delete().eq("id", id);
    if (error) throw error;
  }
  async authenticateApiKey(rawKey: string): Promise<{ apiKey: ApiKey; tenantId: string } | null> {
    if (!rawKey.startsWith("asp_")) return null;
    const hash = createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.slice(0, 12);
    const { data, error } = await this.sb()
      .from("api_keys")
      .select("*")
      .eq("key_prefix", prefix)
      .eq("key_hash", hash)
      .eq("active", true)
      .maybeSingle();
    if (error) { console.error("[authenticateApiKey]", error); return null; }
    if (!data) return null;
    const key = data as ApiKey;
    // Check expiration
    if (key.expires_at && new Date(key.expires_at) < new Date()) return null;
    return { apiKey: key, tenantId: key.tenant_id };
  }
  async updateApiKeyLastUsed(id: string, ip: string): Promise<void> {
    await this.sb()
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString(), last_used_ip: ip })
      .eq("id", id);
  }

  // ---- webhooks ----
  async listWebhooks(tenantId: string): Promise<Webhook[]> {
    const { data, error } = await this.sb().from("webhooks").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data as Webhook[]) || [];
  }
  async upsertWebhook(w: Partial<Webhook> & { id?: string }): Promise<Webhook> {
    return this.smartUpsert<Webhook>("webhooks", w, w.tenant_id ?? undefined);
  }
  async deleteWebhook(id: string): Promise<void> {
    const { error } = await this.sb().from("webhooks").delete().eq("id", id);
    if (error) throw error;
  }
  async getWebhookById(id: string, tenantId?: string): Promise<Webhook | null> {
    let q = this.sb().from("webhooks").select("*").eq("id", id);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data as Webhook) || null;
  }

  // ---- webhook deliveries (outbound delivery log + retry queue) ----
  //
  // Lifecycle:
  //   triggerWebhooks() → createWebhookDelivery(status:"pending", attempts:0)
  //                     → HTTP POST → updateWebhookDelivery(status, attempts:1, ...)
  //   /api/cron/webhook-retry → listFailedWebhookDeliveries()
  //                          → retry → updateWebhookDelivery(attempts++)
  //
  // `payload` is JSONB — bypass sanitizePayload (which strips unknown nested
  // objects) and write the row directly. WebhookPayload is a known shape.
  async createWebhookDelivery(d: {
    webhook_id: string;
    tenant_id: string;
    event: string;
    payload: WebhookPayload;
    status?: string;
    attempts?: number;
  }): Promise<WebhookDelivery> {
    const row: SupaRow = {
      webhook_id: d.webhook_id,
      tenant_id: d.tenant_id,
      event: d.event,
      payload: d.payload,
      status: d.status || "pending",
      attempts: d.attempts ?? 0,
    };
    const { data, error } = await this.sb()
      .from("webhook_deliveries")
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data as WebhookDelivery;
  }
  async updateWebhookDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void> {
    // Strip read-only / joined fields so we never accidentally write them.
    const { id: _omitId, created_at: _omitCreatedAt, ...fields } = patch as any;
    // Coerce empty strings → null for nullable timestamp / int columns
    // (parity with sanitizePayload behaviour — Postgres refuses "" for these).
    for (const [k, v] of Object.entries(fields)) {
      if (v === "") (fields as any)[k] = null;
    }
    const { error } = await this.sb().from("webhook_deliveries").update(fields).eq("id", id);
    if (error) throw error;
  }
  async listWebhookDeliveries(tenantId: string, webhookId?: string, limit?: number): Promise<WebhookDelivery[]> {
    let q = this.sb().from("webhook_deliveries").select("*").eq("tenant_id", tenantId);
    if (webhookId) q = q.eq("webhook_id", webhookId);
    q = q.order("created_at", { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return (data as WebhookDelivery[]) || [];
  }
  async listFailedWebhookDeliveries(limit?: number): Promise<WebhookDelivery[]> {
    // Retry-eligible deliveries: status='failed' AND attempts < 5 AND
    // (next_attempt_at IS NULL OR next_attempt_at <= now()).
    // The `or()` filter combines the two timestamp conditions; the `lt`
    // cap on attempts ensures we give up after 5 tries.
    let q = this.sb()
      .from("webhook_deliveries")
      .select("*")
      .eq("status", "failed")
      .lt("attempts", 5)
      .or("next_attempt_at.is.null,next_attempt_at.lte." + new Date().toISOString())
      .order("created_at", { ascending: true });
    if (limit) q = q.limit(limit);
    else q = q.limit(100);
    const { data, error } = await q;
    if (error) throw error;
    return (data as WebhookDelivery[]) || [];
  }
  async getWebhookDelivery(id: string): Promise<WebhookDelivery | null> {
    const { data, error } = await this.sb()
      .from("webhook_deliveries")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as WebhookDelivery) || null;
  }

  // ---- security ----
  async listSessions(tenantId: string, userId?: string): Promise<SecuritySession[]> {
    let q = this.sb().from("sessions").select("*").eq("tenant_id", tenantId);
    if (userId) q = q.eq("user_id", userId);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return (data as SecuritySession[]) || [];
  }
  async revokeSession(id: string): Promise<void> {
    // CRITICAL FIX (audit P0-2/D-2): revoked sessions were still valid for
    // up to 7 days because requireAuth() only checks token_version in the
    // JWT, not the `revoked` flag in the DB. Bumping token_version here
    // forces ALL of the user's JWTs to become invalid immediately.
    // (Yes, this logs out all devices — that's the secure default for an
    // explicit "revoke session" action. The admin can re-login.)
    const { data: session, error: fetchErr } = await this.sb()
      .from("sessions")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    const { error } = await this.sb().from("sessions").update({ revoked: true }).eq("id", id);
    if (error) throw error;
    if (session?.user_id) {
      if (session.user_id.startsWith("portal:")) {
        // Portal session — bump portal_access.token_version atomically.
        const portalId = session.user_id.replace("portal:", "");
        const { data: pa } = await this.sb()
          .from("portal_access")
          .select("token_version")
          .eq("id", portalId)
          .maybeSingle();
        if (pa) {
          await this.sb()
            .from("portal_access")
            .update({ token_version: (pa.token_version ?? 0) + 1 })
            .eq("id", portalId);
        }
      } else {
        // Regular user — bump users.token_version.
        await this.bumpUserTokenVersion(session.user_id);
      }
    }
  }
  async listLoginHistory(tenantId: string, userId?: string, limit?: number): Promise<LoginHistoryEntry[]> {
    let q = this.sb().from("login_history").select("*").eq("tenant_id", tenantId);
    if (userId) q = q.eq("user_id", userId);
    q = q.order("created_at", { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return (data as LoginHistoryEntry[]) || [];
  }
  async listKnownIps(tenantId: string, userId?: string): Promise<KnownIp[]> {
    let q = this.sb().from("known_ips").select("*").eq("tenant_id", tenantId);
    if (userId) q = q.eq("user_id", userId);
    q = q.order("last_seen", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return (data as KnownIp[]) || [];
  }
  async trustIp(id: string, trusted: boolean): Promise<void> {
    const { error } = await this.sb().from("known_ips").update({ trusted }).eq("id", id);
    if (error) throw error;
  }
  async forgetIp(id: string): Promise<void> {
    const { error } = await this.sb().from("known_ips").delete().eq("id", id);
    if (error) throw error;
  }
  async listTrustedDevices(tenantId: string, userId?: string): Promise<TrustedDevice[]> {
    let q = this.sb().from("trusted_devices").select("*").eq("tenant_id", tenantId);
    if (userId) q = q.eq("user_id", userId);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return (data as TrustedDevice[]) || [];
  }
  async revokeTrustedDevice(id: string): Promise<void> {
    const { error } = await this.sb().from("trusted_devices").update({ revoked: true }).eq("id", id);
    if (error) throw error;
  }

  // ---- mail queue ----
  async listMailQueue(tenantId: string, params?: ListParams): Promise<ListResult<MailQueueEntry>> {
    let q = this.sb().from("mail_queue").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`subject.ilike.%${safeSearch(params.search)}%,to_email.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<MailQueueEntry>(q, params);
  }
  async upsertMailQueueEntry(m: Partial<MailQueueEntry> & { id?: string }): Promise<MailQueueEntry> {
    return this.smartUpsert<MailQueueEntry>("mail_queue", m, m.tenant_id ?? undefined);
  }
  async deleteMailQueueEntry(id: string): Promise<void> {
    const { error } = await this.sb().from("mail_queue").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- all inventory (global view) ----
  async listAllInventory(tenantId: string, params?: ListParams): Promise<ListResult<InventoryMovement>> {
    let q = this.sb().from("inventory_movements").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`reason.ilike.%${safeSearch(params.search)}%,reference.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    if (params?.filters?.product_id) q = q.eq("product_id", params.filters.product_id);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<InventoryMovement>(q, params);
  }

  // ---- tenants (multi-tenancy) ----
  async listTenants(): Promise<Tenant[]> {
    const { data, error } = await this.sb()
      .from("tenants")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as Tenant[]) || [];
  }
  async getTenant(id: string): Promise<Tenant | null> {
    const { data, error } = await this.sb().from("tenants").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Tenant) || null;
  }
  async upsertTenant(t: Partial<Tenant> & { id?: string }): Promise<Tenant> {
    return this.smartUpsert<Tenant>("tenants", t, (t as any).tenant_id ?? undefined);
  }
  // P3 / task C-8 — atomic tenant status transition. Single SQL UPDATE
  // with a WHERE clause on the current status — Postgres serialises the
  // row lock, so two concurrent calls cannot both flip the same row. The
  // `.in("status", fromStatuses)` filter is the atomic guard: if the row
  // is no longer in one of the `fromStatuses` (because the other call
  // already flipped it), this UPDATE matches 0 rows and we return `null`.
  //
  // The `.maybeSingle()` (vs `.single()`) is intentional: when 0 rows
  // match, PostgREST returns an empty array + no error, and `maybeSingle`
  // returns `null` rather than throwing `PGRK116` like `.single()` would.
  async atomicTenantStatusTransition(
    tenantId: string,
    fromStatuses: string[],
    toStatus: string,
    patch?: Partial<Tenant>,
  ): Promise<Tenant | null> {
    if (!tenantId) return null;
    if (!fromStatuses || fromStatuses.length === 0) return null;

    // Build the update payload. Never overwrite audit columns — let the DB
    // default / trigger handle created_at and (the trigger-updated)
    // updated_at. We DO set updated_at explicitly here because the
    // supabase JS client doesn't reliably let triggers fire on `.update()`
    // without a RETURNING clause — and we need the RETURNING for the
    // response anyway.
    const update: Record<string, unknown> = {
      status: toStatus,
      updated_at: new Date().toISOString(),
    };
    if (patch) {
      const p = this.sanitizePayload({ ...patch }) as Record<string, unknown>;
      delete p.id;
      delete p.tenant_id;
      delete p.created_at;
      delete p.created_by;
      // updated_at is already set above — don't let the patch override it
      // with a stale value.
      delete p.updated_at;
      // status is already set above — don't let the patch override the
      // transition target.
      delete p.status;
      Object.assign(update, p);
    }

    const { data, error } = await this.sb()
      .from("tenants")
      .update(update)
      .eq("id", tenantId)
      .in("status", fromStatuses)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    return (data as Tenant) || null;
  }
  async deleteTenant(id: string): Promise<void> {
    const { error } = await this.sb().from("tenants").delete().eq("id", id);
    if (error) throw error;
  }

  // ── Safe tenant deletion (P0 / task C-1) ────────────────────────────────
  // The live DB has very few FK constraints with ON DELETE CASCADE (per
  // migration 021 comment) — most tenant_id / partner_id / user_id columns
  // are plain text with no FK at all. A naive `DELETE FROM tenants WHERE
  // id=?` therefore orphans every dependent row (offers, invoices, users,
  // audit_logs, …) which then dangles forever, shows up in cross-tenant
  // queries if any RLS policy is mis-scoped, and makes "is this tenant
  // really gone?" impossible to answer from the DB alone.
  //
  // `countTenantDependencies` introspects every tenant-scoped table and
  // returns a per-table row count plus a `total`. The DELETE route uses it
  // to refuse a hard-delete unless the caller passes `confirm=true` (or
  // asks for a soft-delete instead) — see
  // `src/app/api/tenants/[id]/route.ts`.
  //
  // `deleteTenantCascade` walks the same set of tables in dependency order
  // (children before parents, weak entities before strong entities, append-
  // only / trigger-protected tables skipped — those need dedicated RPCs
  // like `anonymize_user_audit_logs` from migration 030) and then deletes
  // the tenant row last. Each child delete is wrapped in try/catch so a
  // missing or renamed table in a given env does not abort the whole
  // cascade (the table list is a superset of what any single env has).
  //
  // This is a defence-in-depth app-layer cascade. The real fix is a
  // migration that adds FK constraints with proper ON DELETE CASCADE /
  // RESTRICT / SET NULL semantics — tracked as follow-up. Until that
  // migration lands, this method is the only thing preventing orphan rows.
  async countTenantDependencies(
    tenantId: string,
  ): Promise<Record<string, number> & { total: number }> {
    const tables = [
      "users", "partners", "products", "offers", "invoices", "proformas",
      "supplier_offers", "trade_calculations", "deals", "demands",
      "settings", "document_templates", "tenant_letterheads",
      "tenant_seals", "portal_access", "api_keys", "webhooks",
      "mail_queue", "notifications", "entity_notes", "user_tasks",
      "inventory_movements", "erp_journal_entries", "commission_agents",
      "deal_commissions", "commission_payouts", "sessions", "audit_logs",
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      try {
        const { count } = await this.sb()
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("tenant_id", tenantId);
        counts[table] = count || 0;
      } catch {
        // Table may not exist in this env (e.g. dev snapshot missing a
        // table that production has, or vice-versa). Count as 0 so the
        // hard-delete gate does not over-block.
        counts[table] = 0;
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { ...counts, total };
  }

  async deleteTenantCascade(tenantId: string): Promise<void> {
    // First: force-delete the tenant's audit_logs via a SECURITY DEFINER
    // RPC that temporarily disables the audit_logs_append_only trigger.
    // Without this, the trigger blocks the DELETE and the cascade fails.
    // Also handle document_verification_logs (may have a similar trigger).
    try {
      await this.sb().rpc("force_delete_tenant_audit_logs", { t_uuid: tenantId });
    } catch {
      // RPC may not exist in all environments — the per-table try/catch
      // below will handle audit_logs (it'll fail silently there too).
    }

    // Order matters: children before parents. audit_logs is intentionally
    // ABSENT from this list — it's handled by the RPC above. Other
    // append-only tables (document_verification_logs) are also skipped;
    // their rows survive the cascade but become orphaned (acceptable for
    // a hard-delete — the tenant is gone).
    const order = [
      "sessions", "mail_queue", "notifications",
      "entity_notes", "user_tasks", "inventory_movements",
      "erp_journal_lines", "erp_journal_entries", "deal_commissions",
      "commission_payouts", "commission_agents", "document_revisions",
      "document_register", "shared_documents", "portal_rfqs",
      "portal_access", "api_keys", "webhook_deliveries", "webhooks",
      "kyc_submissions", "user_preferences", "offers", "invoices",
      "proformas", "supplier_offers", "trade_calculations", "demands",
      "deals", "products", "partners", "tenant_letterheads",
      "tenant_seals", "document_templates", "settings", "users",
    ];
    for (const table of order) {
      try {
        await this.sb().from(table).delete().eq("tenant_id", tenantId);
      } catch {
        // Table may not exist in this env — skip and continue. The
        // tenant row delete below is the only hard requirement.
      }
    }
    const { error } = await this.sb().from("tenants").delete().eq("id", tenantId);
    if (error) throw error;
  }

  // ── Safe user deletion (P0 / task C-1) ─────────────────────────────────
  // Same orphan problem as tenants: `users.id` has no FK from most tables
  // that reference it (sessions, user_tasks, entity_notes, user_preferences,
  // …), so a plain `DELETE FROM users WHERE id=?` orphans rows. The user
  // DELETE route calls this AFTER `anonymizeUserAuditLogs` (which strips
  // PII from the append-only audit_logs — see migration 030). The tables
  // listed here are the non-append-only PII / session tables that are safe
  // to hard-delete in dependency order.
  async deleteUserCascade(userId: string): Promise<void> {
    // First: force-anonymize the user's audit_logs via a SECURITY DEFINER
    // RPC that temporarily disables the audit_logs_append_only trigger.
    // The trigger blocks both DELETE and UPDATE, so without this RPC,
    // any attempt to strip PII from audit_logs (or delete it) fails.
    try {
      await this.sb().rpc("force_anonymize_user_audit_logs", { t_user_id: userId });
    } catch {
      // RPC may not exist in all environments — continue anyway.
    }

    const order = [
      "sessions", "user_tasks", "entity_notes", "user_preferences",
      "user_favorites", "login_history", "known_ips", "trusted_devices",
      "notifications",
    ];
    for (const table of order) {
      try {
        await this.sb().from(table).delete().eq("user_id", userId);
      } catch {
        // Table may not exist in this env (e.g. user_favorites is not in
        // the dev snapshot). Skip and continue — the users row delete is
        // the only hard requirement.
      }
    }
    const { error } = await this.sb().from("users").delete().eq("id", userId);
    if (error) throw error;
  }

  // ---- product catalog ----
  async listProductCatalog(tenantId: string, params?: ListParams): Promise<ListResult<ProductCatalogEntry>> {
    let q = this.sb().from("product_catalog").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`name.ilike.%${safeSearch(params.search)}%,hs_code.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.category) q = q.eq("category", params.filters.category);
    if (params?.filters?.active !== undefined) q = q.eq("active", params.filters.active === "true");
    q = q.order("created_at", { ascending: false });
    return paginateQuery<ProductCatalogEntry>(q, params);
  }
  async getProductCatalogEntry(id: string): Promise<ProductCatalogEntry | null> {
    const { data, error } = await this.sb().from("product_catalog").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as ProductCatalogEntry) || null;
  }
  async upsertProductCatalogEntry(p: Partial<ProductCatalogEntry> & { id?: string }): Promise<ProductCatalogEntry> {
    return this.smartUpsert<ProductCatalogEntry>("product_catalog", p, p.tenant_id ?? undefined);
  }
  async deleteProductCatalogEntry(id: string): Promise<void> {
    const { error } = await this.sb().from("product_catalog").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- supplier offers ----
  async listSupplierOffers(tenantId: string, params?: ListParams): Promise<ListResult<SupplierOffer>> {
    let q = this.sb().from("supplier_offers").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`offer_number.ilike.%${safeSearch(params.search)}%,packaging.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.product_id) q = q.eq("product_id", params.filters.product_id);
    if (params?.filters?.supplier_id) q = q.eq("supplier_id", params.filters.supplier_id);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<SupplierOffer>(q, params);
  }
  async getSupplierOffer(id: string): Promise<SupplierOffer | null> {
    const { data, error } = await this.sb().from("supplier_offers").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as SupplierOffer) || null;
  }
  async upsertSupplierOffer(s: Partial<SupplierOffer> & { id?: string }): Promise<SupplierOffer> {
    return this.smartUpsert<SupplierOffer>("supplier_offers", s, s.tenant_id ?? undefined);
  }
  async deleteSupplierOffer(id: string): Promise<void> {
    const { error } = await this.sb().from("supplier_offers").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- trade calculations ----
  async listTradeCalculations(tenantId: string, params?: ListParams): Promise<ListResult<TradeCalculation>> {
    let q = this.sb().from("trade_calculations").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.ilike("name", `%${params.search}%`);
    if (params?.filters?.product_id) q = q.eq("product_id", params.filters.product_id);
    if (params?.filters?.supplier_id) q = q.eq("supplier_id", params.filters.supplier_id);
    if (params?.filters?.buyer_id) q = q.eq("buyer_id", params.filters.buyer_id);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<TradeCalculation>(q, params);
  }
  async getTradeCalculation(id: string): Promise<TradeCalculation | null> {
    const { data, error } = await this.sb().from("trade_calculations").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as TradeCalculation) || null;
  }
  async upsertTradeCalculation(t: Partial<TradeCalculation> & { id?: string }): Promise<TradeCalculation> {
    return this.smartUpsert<TradeCalculation>("trade_calculations", t, t.tenant_id ?? undefined);
  }
  async deleteTradeCalculation(id: string): Promise<void> {
    const { error } = await this.sb().from("trade_calculations").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- portal access ----
  async getPortalAccessByPartner(partnerId: string): Promise<PortalAccess | null> {
    const { data, error } = await this.sb().from("portal_access").select("*").eq("partner_id", partnerId).maybeSingle();
    if (error) throw error;
    return (data as PortalAccess) || null;
  }
  /**
   * P0-3 / Feature 2 — field-level encryption: query by the deterministic
   * HMAC token (portal_email_hmac) instead of the encrypted portal_email
   * column. AES-256-GCM uses a random IV per row, so two encryptions of
   * the same plaintext email produce different ciphertexts — direct
   * `WHERE portal_email = ?` cannot work.
   *
   * The HMAC column is populated by the API route layer (alongside
   * encrypting portal_email) and backfilled by migration 042 for legacy
   * rows. If the column is missing entirely (migration 042 not applied),
   * PostgREST returns an error and we fall back to the legacy plaintext
   * `portal_email = ?` query so the login flow stays working during the
   * rollout window.
   */
  async getPortalAccessByEmail(tenantId: string, email: string): Promise<PortalAccess | null> {
    const token = hmacField(email);
    if (token) {
      const { data, error } = await this.sb()
        .from("portal_access")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("portal_email_hmac", token)
        .maybeSingle();
      if (!error && data) return data as PortalAccess;
      // If the error is "column portal_email_hmac does not exist"
      // (migration 042 not applied), fall back to legacy plaintext search.
      // Any other error propagates.
      if (error && !/could not find the ['"]?portal_email_hmac['"]? column/i.test(error.message)) {
        // Fall through to legacy plaintext search for other errors too —
        // it's safer than throwing. Log so ops can triage.
        console.warn("[getPortalAccessByEmail] HMAC query failed, falling back to plaintext:", error.message);
      }
    }
    // Legacy plaintext fallback (pre-migration-042 deployment, OR rows
    // whose portal_email_hmac is still NULL after a partial backfill).
    const { data: legacy, error: legErr } = await this.sb()
      .from("portal_access")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("portal_email", email)
      .maybeSingle();
    if (legErr) throw legErr;
    return (legacy as PortalAccess) || null;
  }
  async getPortalAccessById(id: string): Promise<PortalAccess | null> {
    const { data, error } = await this.sb().from("portal_access").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as PortalAccess) || null;
  }
  async listPortalAccess(tenantId: string): Promise<PortalAccess[]> {
    const { data, error } = await this.sb().from("portal_access").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data as PortalAccess[]) || [];
  }
  async upsertPortalAccess(p: Partial<PortalAccess> & { id?: string }): Promise<PortalAccess> {
    // Columns that have been added to portal_access at various points in the
    // schema's history. We only strip when they are explicitly undefined so
    // callers can still set them when the column is present in the live DB.
    const columnsThatMayNotExist = [
      "feature_flags", "onboarding_status", "portal_locked_until",
      "failed_login_attempts", "lockout_until", "notes",
      "failed_attempts", "locked_until", "token_version",
      // ↑ existing columns (present in current schema) — kept as a safety net
      //   for older deployments that may be missing one.
      // ↓ newly-introduced columns — see migration 005_portal_access_last_login_country.sql.
      "last_login_country",
      // ↓ newly-introduced column — see migration 015_portal_access_gps_verified_at.sql.
      "gps_verified_at",
      // ↓ newly-introduced column — see migration 019_portal_access_locale.sql.
      "locale",
      // ↓ P0-3 / Feature 2 — field-level encryption. The HMAC token column
      //   is populated by the API route layer (alongside encrypting
      //   portal_email). Listed here so upsertPortalAccess stays tolerant
      //   of deployments where migration 042 has not yet been applied —
      //   the column is stripped before the INSERT / UPDATE so the write
      //   doesn't 400 on "column does not exist". The route layer falls
      //   back to the legacy plaintext-equality search path in that case.
      "portal_email_hmac",
    ];
    const stripOptionalColumns = (row: SupaRow): SupaRow => {
      const out: SupaRow = { ...row };
      for (const col of columnsThatMayNotExist) {
        if (out[col] === undefined) delete out[col];
      }
      return out;
    };

    // Inner worker that performs the actual upsert. Throws on DB error.
    const doUpsert = async (input: Partial<PortalAccess> & { id?: string }): Promise<PortalAccess> => {
      const payload = stripOptionalColumns(input as SupaRow);
      // When id is provided, use UPDATE — avoids NOT NULL constraint violations
      // on columns like partner_id that aren't in the partial payload.
      if (input.id) {
        const { id, ...fields } = payload;
        // Strip any undefined values to avoid overwriting with null
        const cleanFields: SupaRow = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v !== undefined) cleanFields[k] = v;
        }
        // CRITICAL: filter by tenant_id to prevent cross-tenant IDOR. A caller
        // from tenant A can no longer POST body.id=<tenant-B-uuid> to hijack
        // tenant B's portal access. portal_access.tenant_id is NOT NULL, so a
        // falsy value here means the caller is doing something wrong — we
        // still guard with the `if` for safety (and to mirror upsertUser).
        let q = this.sb().from("portal_access").update(cleanFields).eq("id", id);
        if (cleanFields.tenant_id) q = q.eq("tenant_id", cleanFields.tenant_id as string);
        const { data, error } = await q.select().single();
        if (error) throw error;
        if (!data) {
          // Row doesn't exist yet — fall back to insert with full payload
          const { data: ins, error: insErr } = await this.sb()
            .from("portal_access")
            .insert(payload)
            .select()
            .single();
          if (insErr) throw insErr;
          return ins as PortalAccess;
        }
        return data as PortalAccess;
      }
      // No id — insert new portal access
      const { data, error } = await this.sb().from("portal_access").insert(payload).select().single();
      if (error) throw error;
      return data as PortalAccess;
    };

    try {
      return await doUpsert(p);
    } catch (e: any) {
      // If the failure looks like "column X doesn't exist in the schema", retry
      // once without that column. This makes the upsert tolerant of deployments
      // where migration 005 (portal_access.last_login_country) hasn't been
      // applied yet — the login flow stays working and the country is still
      // captured in the audit log + login_history.
      const msg = String((e && (e.message || e.code)) || "");
      const missingColMatch = msg.match(/Could not find the ['"]?([\w_]+)['"]? column/);
      if (missingColMatch) {
        const missingCol = missingColMatch[1];
        const safeInput = { ...p } as Record<string, unknown>;
        delete safeInput[missingCol];
        return await doUpsert(safeInput as Partial<PortalAccess> & { id?: string });
      }
      throw e;
    }
  }
  async deletePortalAccess(id: string): Promise<void> {
    const { error } = await this.sb().from("portal_access").delete().eq("id", id);
    if (error) throw error;
  }
  async verifyPortalCredentials(tenantId: string, email: string, password: string): Promise<PortalAccess | null> {
    const pa = await this.getPortalAccessByEmail(tenantId, email);
    if (!pa || !pa.password_hash) return null;
    if (pa.status !== "active") return null;
    const valid = await verifyPassword(password, pa.password_hash);
    if (!valid) return null;
    return pa;
  }

  /**
   * P0-3 / Feature 2 — equality search by HMAC token (see
   * getPortalAccessByEmail above). Used by the login flow when the user
   * does NOT supply a tenant_id — we look up by email alone.
   */
  async verifyPortalCredentialsByEmail(email: string, password: string): Promise<PortalAccess | null> {
    const pa = await this.getPortalAccessByEmailAnyTenant(email);
    if (!pa || !pa.password_hash) return null;
    if (pa.status !== "active") return null;
    const valid = await verifyPassword(password, pa.password_hash);
    return valid ? pa : null;
  }
  async getPortalAccessByEmailAnyTenant(email: string): Promise<PortalAccess | null> {
    const token = hmacField(email);
    if (token) {
      const { data, error } = await this.sb()
        .from("portal_access")
        .select("*")
        .eq("portal_email_hmac", token)
        .maybeSingle();
      if (!error && data) return data as PortalAccess;
      if (error && !/could not find the ['"]?portal_email_hmac['"]? column/i.test(error.message)) {
        console.warn("[getPortalAccessByEmailAnyTenant] HMAC query failed, falling back to plaintext:", error.message);
      }
    }
    const { data: legacy, error: legErr } = await this.sb()
      .from("portal_access")
      .select("*")
      .eq("portal_email", email)
      .maybeSingle();
    if (legErr || !legacy) return null;
    return legacy as PortalAccess;
  }
  async listPortalAccessByEmail(email: string): Promise<PortalAccess[]> {
    const token = hmacField(email);
    if (token) {
      const { data, error } = await this.sb()
        .from("portal_access")
        .select("*")
        .eq("portal_email_hmac", token);
      if (!error && data && data.length > 0) return data as PortalAccess[];
      if (error && !/could not find the ['"]?portal_email_hmac['"]? column/i.test(error.message)) {
        console.warn("[listPortalAccessByEmail] HMAC query failed, falling back to plaintext:", error.message);
      }
    }
    const { data: legacy, error: legErr } = await this.sb()
      .from("portal_access")
      .select("*")
      .eq("portal_email", email);
    if (legErr) return [];
    return (legacy as PortalAccess[]) || [];
  }

  // ---- document templates ----
  // Join columns: include nested letterhead + seal rows so the PDF renderer
  // has direct access to logo_url / image_url without an extra round-trip.
  // We use the PostgREST embedded-resource hint syntax `!fk_column` because
  // the document_templates.letterhead_id / seal_id columns don't always have
  // explicit FOREIGN KEY constraints in older schema revisions.
  private static readonly TEMPLATE_SELECT =
    "*, letterhead:tenant_letterheads!letterhead_id(*), seal:tenant_seals!seal_id(*)";

  async listDocumentTemplates(tenantId: string): Promise<DocumentTemplate[]> {
    const { data, error } = await this.sb()
      .from("document_templates")
      .select(SupabaseStore.TEMPLATE_SELECT)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as DocumentTemplate[]) || [];
  }
  async getDocumentTemplate(id: string): Promise<DocumentTemplate | null> {
    const { data, error } = await this.sb()
      .from("document_templates")
      .select(SupabaseStore.TEMPLATE_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as DocumentTemplate) || null;
  }
  async getDefaultDocumentTemplate(tenantId: string, type: string): Promise<DocumentTemplate | null> {
    // 1) Look for an existing default template for this doc type.
    const { data, error } = await this.sb()
      .from("document_templates")
      .select(SupabaseStore.TEMPLATE_SELECT)
      .eq("tenant_id", tenantId)
      .eq("type", type)
      .eq("is_default", true)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as DocumentTemplate;

    // 2) Fall back to any default template (any type) — a tenant might have
    //    created a single "all-documents" template instead of per-type ones.
    const { data: anyType } = await this.sb()
      .from("document_templates")
      .select(SupabaseStore.TEMPLATE_SELECT)
      .eq("tenant_id", tenantId)
      .eq("is_default", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (anyType) return anyType as DocumentTemplate;

    // 3) Auto-create a default template from the tenant's default (or first)
    //    letterhead + seal so PDFs actually use the configured branding. This
    //    is idempotent: we only get here when NO default template exists yet.
    try {
      // 3a) If the tenant has zero templates at all, seed the professional
      //     starter pack (offer / invoice / proforma). This gives brand-new
      //     tenants a sensible default for every document type without
      //     requiring them to visit the Templates view first. The starter
      //     templates are is_default=true for their respective types, so
      //     after seeding we can short-circuit and return the matching one.
      const allTemplates = await this.listDocumentTemplates(tenantId);
      if (allTemplates.length === 0) {
        await ensureStarterTemplates(tenantId, this);
        const { data: starterMatch } = await this.sb()
          .from("document_templates")
          .select(SupabaseStore.TEMPLATE_SELECT)
          .eq("tenant_id", tenantId)
          .eq("type", type)
          .eq("is_default", true)
          .maybeSingle();
        if (starterMatch) return starterMatch as DocumentTemplate;
      }

      const letterheads = await this.listLetterheads(tenantId);
      const seals = await this.listSeals(tenantId);
      const activeLetterhead =
        letterheads.find((l) => l.is_default) || letterheads[0] || null;
      const activeSeal =
        seals.find((s) => s.is_default) || seals[0] || null;

      // No branding assets at all → nothing to wire up. Leave template null.
      if (!activeLetterhead && !activeSeal) return null;

      const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const now = new Date().toISOString();

      const payload: SupaRow = {
        id: newId,
        tenant_id: tenantId,
        name: "Default Template",
        type,
        is_default: true,
        // Page layout — inherit from letterhead when available
        page_size: activeLetterhead?.page_size || "A4",
        page_margin_top: activeLetterhead?.margin_top_mm ?? 25,
        page_margin_bottom: activeLetterhead?.margin_bottom_mm ?? 25,
        page_margin_left: activeLetterhead?.margin_left_mm ?? 20,
        page_margin_right: activeLetterhead?.margin_right_mm ?? 20,
        // Header
        header_enabled: true,
        header_height: activeLetterhead?.header_height_mm ?? 20,
        header_content: null,
        header_show_logo: activeLetterhead?.header_show_logo ?? true,
        header_show_company_name: activeLetterhead?.header_show_company_name ?? true,
        header_show_contact: activeLetterhead?.header_show_contact ?? true,
        // Footer
        footer_enabled: true,
        footer_height: activeLetterhead?.footer_height_mm ?? 15,
        footer_content: null,
        footer_show_page_number: activeLetterhead?.footer_show_page_number ?? true,
        footer_show_bank_details: activeLetterhead?.footer_show_bank_details ?? true,
        footer_show_tax_id: activeLetterhead?.footer_show_tax_id ?? true,
        // Body typography
        body_font_family: activeLetterhead?.body_font_family || "Inter",
        body_font_size: activeLetterhead?.body_font_size_pt ?? 11,
        body_line_height: 1.5,
        // Branding colors
        primary_color: activeLetterhead?.primary_color || "#0f766e",
        accent_color: activeLetterhead?.accent_color || "#0d9488",
        // Table styling
        table_header_bg: activeLetterhead?.primary_color || "#0f766e",
        table_header_color: "#ffffff",
        table_border_color: "#e5e7eb",
        table_stripe: true,
        // Linked branding assets
        letterhead_id: activeLetterhead?.id || null,
        seal_id: activeSeal?.id || null,
        seal_enabled: !!activeSeal,
        // Metadata
        created_by: null,
        created_at: now,
        updated_at: now,
      };

      const { data: created, error: insErr } = await this.sb()
        .from("document_templates")
        .insert(payload)
        .select(SupabaseStore.TEMPLATE_SELECT)
        .single();
      if (insErr) {
        console.warn("[getDefaultDocumentTemplate] Auto-create failed:", insErr.message);
        return null;
      }
      return (created as DocumentTemplate) || null;
    } catch (autoErr) {
      console.warn("[getDefaultDocumentTemplate] Auto-create error:", autoErr);
      return null;
    }
  }
  async upsertDocumentTemplate(t: Partial<DocumentTemplate> & { id?: string }): Promise<DocumentTemplate> {
    return this.smartUpsert<DocumentTemplate>("document_templates", t, t.tenant_id ?? undefined);
  }
  async deleteDocumentTemplate(id: string): Promise<void> {
    const { error } = await this.sb().from("document_templates").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- document verification ----
  async createDocumentVerification(v: Omit<DocumentVerification, "id" | "created_at" | "verification_count" | "last_verified_at" | "last_verified_ip" | "status"> & { status?: string }): Promise<DocumentVerification> {
    const payload: SupaRow = { ...v };
    const { data, error } = await this.sb().from("document_verifications").insert(payload).select().single();
    if (error) throw error;
    return data as DocumentVerification;
  }
  async getDocumentVerificationByCode(code: string): Promise<DocumentVerification | null> {
    try {
      const { data, error } = await this.sb().from("document_verifications").select("*").eq("verification_code", code).maybeSingle();
      if (error) {
        console.warn("[getDocumentVerificationByCode] Query failed:", error.message);
        return null;
      }
      return (data as DocumentVerification) || null;
    } catch (err) {
      console.warn("[getDocumentVerificationByCode] Unexpected error:", err);
      return null;
    }
  }
  async getDocumentVerificationByDoc(tenantId: string, docType: string, docId: string): Promise<DocumentVerification | null> {
    try {
      const { data, error } = await this.sb().from("document_verifications").select("*").eq("tenant_id", tenantId).eq("document_type", docType).eq("document_id", docId).maybeSingle();
      if (error) {
        console.warn("[getDocumentVerificationByDoc] Query failed:", error.message);
        return null;
      }
      return (data as DocumentVerification) || null;
    } catch (err) {
      console.warn("[getDocumentVerificationByDoc] Unexpected error:", err);
      return null;
    }
  }
  async logVerification(log: Omit<VerificationLog, "id" | "verified_at">): Promise<VerificationLog> {
    try {
      const { data, error } = await this.sb().from("verification_logs").insert({ ...log }).select().single();
      if (error) {
        // verification_logs table may not exist yet — fail gracefully
        console.warn("[logVerification] Could not write verification log:", error.message);
        return { ...log, id: "fallback", verified_at: new Date().toISOString() } as VerificationLog;
      }
      return data as VerificationLog;
    } catch (err) {
      // verification_logs table may not exist — fail gracefully
      console.warn("[logVerification] Unexpected error writing verification log:", err);
      return { ...log, id: "fallback", verified_at: new Date().toISOString() } as VerificationLog;
    }
  }
  async listVerificationLogs(verificationId: string): Promise<VerificationLog[]> {
    try {
      const { data, error } = await this.sb().from("verification_logs").select("*").eq("verification_id", verificationId).order("verified_at", { ascending: false });
      if (error) {
        console.warn("[listVerificationLogs] Could not read verification logs:", error.message);
        return [];
      }
      return (data as VerificationLog[]) || [];
    } catch (err) {
      console.warn("[listVerificationLogs] Unexpected error:", err);
      return [];
    }
  }

  // ---- KYC submissions ----
  async listKycSubmissions(tenantId: string, params?: ListParams): Promise<ListResult<KycSubmission>> {
    let q = this.sb().from("kyc_submissions").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`legal_name.ilike.%${safeSearch(params.search)}%,trade_name.ilike.%${safeSearch(params.search)}%,contact_email.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<KycSubmission>(q, params);
  }
  async getKycSubmission(id: string): Promise<KycSubmission | null> {
    const { data, error } = await this.sb().from("kyc_submissions").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as KycSubmission) || null;
  }
  async getKycSubmissionByPartner(partnerId: string): Promise<KycSubmission | null> {
    const { data, error } = await this.sb().from("kyc_submissions").select("*").eq("partner_id", partnerId).order("created_at", { ascending: false }).limit(1);
    if (error) throw error;
    return ((data as KycSubmission[]) || [])[0] || null;
  }
  async upsertKycSubmission(s: Partial<KycSubmission> & { id?: string }): Promise<KycSubmission> {
    return this.smartUpsert<KycSubmission>("kyc_submissions", s, s.tenant_id ?? undefined);
  }
  async deleteKycSubmission(id: string): Promise<void> {
    const { error } = await this.sb().from("kyc_submissions").delete().eq("id", id);
    if (error) throw error;
  }
  async addKycDocument(doc: Omit<KycDocument, "id" | "uploaded_at">): Promise<KycDocument> {
    // Legacy path — kyc_documents table doesn't exist. We now record everything
    // in portal_uploads with category='kyc' and echo back a KycDocument-shaped
    // response so old callers keep working.
    const submission = await this.getKycSubmission(doc.submission_id);
    if (!submission) throw new Error("KYC submission not found");
    // portal_uploads canonical column is `size_bytes` (verified against
    // production DB introspection). No `size` fallback — PostgREST rejects
    // unknown columns on some deployments.
    const { data, error } = await this.sb().from("portal_uploads").insert({
      tenant_id: submission.tenant_id,
      partner_id: submission.partner_id,
      portal_access_id: submission.portal_access_id,
      category: "kyc",
      doc_type: doc.type,
      kyc_submission_id: doc.submission_id,
      filename: doc.filename,
      storage_bucket: "kyc-documents",
      storage_path: doc.storage_path,
      mime_type: doc.mime_type,
      size_bytes: doc.size,
    }).select().single();
    if (error) throw error;
    return {
      id: (data as any).id,
      submission_id: doc.submission_id,
      type: doc.type,
      filename: doc.filename,
      storage_path: doc.storage_path,
      mime_type: doc.mime_type,
      size: doc.size,
      uploaded_at: (data as any).uploaded_at,
    } as KycDocument;
  }
  async removeKycDocument(id: string): Promise<void> {
    // Legacy: soft-delete the equivalent portal_uploads row.
    const { error } = await this.sb().from("portal_uploads").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  }
  async approveKycAndTransfer(submissionId: string, reviewedBy: string): Promise<{ submission: KycSubmission; partner: Partner }> {
    // 1. Get the submission
    const sub = await this.getKycSubmission(submissionId);
    if (!sub) throw new Error("KYC submission not found");

    // 2. Update the submission status
    const { data: updatedSub, error: subErr } = await this.sb()
      .from("kyc_submissions")
      .update({
        status: "approved",
        reviewed_by: reviewedBy,
        reviewed_at: new Date().toISOString(),
        auto_transferred: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", submissionId)
      .select()
      .single();
    if (subErr) throw subErr;

    // 3. Transfer KYC data to the partner record
    const partnerUpdate: Record<string, unknown> = {
      kyc_status: "approved",
      kyc_reviewed_by: reviewedBy,
      kyc_reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Transfer address & contact fields if present
    if (sub.legal_name) partnerUpdate.name = sub.legal_name;
    if (sub.tax_id) partnerUpdate.tax_id = sub.tax_id;
    if (sub.vat_number) partnerUpdate.vat_number = sub.vat_number;
    if (sub.registration_number) partnerUpdate.registration_number = sub.registration_number;
    if (sub.company_website) partnerUpdate.website = sub.company_website;
    if (sub.address_line) partnerUpdate.address_line = sub.address_line;
    if (sub.city) partnerUpdate.city = sub.city;
    if (sub.state) partnerUpdate.state = sub.state;
    if (sub.postal_code) partnerUpdate.postal_code = sub.postal_code;
    if (sub.country) partnerUpdate.country = sub.country;
    if (sub.contact_name) partnerUpdate.contact_name = sub.contact_name;
    if (sub.contact_email) partnerUpdate.contact_email = sub.contact_email;
    if (sub.contact_phone) partnerUpdate.contact_phone = sub.contact_phone;
    if (sub.bank_name) partnerUpdate.bank_name = sub.bank_name;
    if (sub.bank_account) partnerUpdate.bank_account = sub.bank_account;
    if (sub.bank_iban) partnerUpdate.bank_iban = sub.bank_iban;
    if (sub.bank_swift) partnerUpdate.bank_swift = sub.bank_swift;
    // Store the full KYC data blob
    partnerUpdate.kyc_data = sub;

    const { data: updatedPartner, error: partnerErr } = await this.sb()
      .from("partners")
      .update(partnerUpdate)
      .eq("id", sub.partner_id)
      .select()
      .single();
    if (partnerErr) throw partnerErr;

    return { submission: updatedSub as KycSubmission, partner: updatedPartner as Partner };
  }

  // ---- portal RFQs ----
  async listPortalRfqs(tenantId: string, params?: ListParams): Promise<ListResult<PortalRfq>> {
    let q = this.sb().from("portal_rfqs").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`number.ilike.%${safeSearch(params.search)}%,product_name.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    if (params?.filters?.partner_id) q = q.eq("partner_id", params.filters.partner_id);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<PortalRfq>(q, params);
  }
  async listPortalRfqsByPartner(partnerId: string): Promise<PortalRfq[]> {
    const { data, error } = await this.sb().from("portal_rfqs").select("*").eq("partner_id", partnerId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data as PortalRfq[]) || [];
  }
  async getPortalRfq(id: string): Promise<PortalRfq | null> {
    const { data, error } = await this.sb().from("portal_rfqs").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as PortalRfq) || null;
  }
  async upsertPortalRfq(r: Partial<PortalRfq> & { id?: string }): Promise<PortalRfq> {
    return this.smartUpsert<PortalRfq>("portal_rfqs", r, r.tenant_id ?? undefined);
  }
  async deletePortalRfq(id: string): Promise<void> {
    const { error } = await this.sb().from("portal_rfqs").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- feature flags ----
  async getFeatureFlags(tenantId: string): Promise<TenantFeatureFlags | null> {
    const { data, error } = await this.sb().from("feature_flags").select("*").eq("tenant_id", tenantId).maybeSingle();
    if (error) throw error;
    return (data as TenantFeatureFlags) || null;
  }
  async upsertFeatureFlags(f: Partial<TenantFeatureFlags> & { id?: string; tenant_id: string }): Promise<TenantFeatureFlags> {
    const payload: SupaRow = { ...f };
    if (f.id) payload.id = f.id;
    const { data, error } = await this.sb().from("feature_flags").upsert(payload, { onConflict: "tenant_id" }).select().single();
    if (error) throw error;
    return data as TenantFeatureFlags;
  }

  // ---- notifications ----
  // Broadcast notifications (KYC, RFQ, invoice paid, etc.) are written with
  // user_id=null so every admin on the tenant sees them — the filter must
  // match "assigned to me" OR "broadcast", never just "assigned to me".
  async listNotifications(tenantId: string, userId?: string, unreadOnly?: boolean): Promise<Notification[]> {
    let q = this.sb().from("notifications").select("*").eq("tenant_id", tenantId);
    if (userId) q = q.or(`user_id.eq.${userId},user_id.is.null`);
    if (unreadOnly) q = q.eq("read", false);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return (data as Notification[]) || [];
  }
  async listNotificationsByPartner(tenantId: string, partnerId: string): Promise<Notification[]> {
    // STRICT: only notifications addressed to this exact partner. No broadcast
    // leak — internal notifications with partner_id=null are NEVER exposed to
    // the portal. Also restricted to portal-safe types so misrouted internal
    // notifications can't slip through.
    const PORTAL_SAFE_TYPES = [
      "kyc_submitted", "kyc_approved", "kyc_rejected",
      "rfq_received", "rfq_quoted",
      "offer_sent", "offer_accepted", "offer_rejected", "offer_expired",
      "invoice_sent", "invoice_overdue", "invoice_paid",
      "proforma_sent",
      "document_shared",
      "portal_access_requested", "portal_access_approved", "portal_invite_sent",
      "portal_message",
      // Marketplace (Phase 2) — negotiation rooms + offer notifications
      "marketplace_response_received",
      "marketplace_response_accepted",
      "marketplace_response_rejected",
      "marketplace_message_received",
    ];
    const { data, error } = await this.sb()
      .from("notifications")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("partner_id", partnerId)
      .in("type", PORTAL_SAFE_TYPES)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as Notification[]) || [];
  }
  async createNotification(n: Omit<Notification, "id" | "created_at" | "read" | "read_at">): Promise<Notification> {
    const { data, error } = await this.sb().from("notifications").insert({ ...n, read: false }).select().single();
    if (error) throw error;
    return data as Notification;
  }
  async markNotificationRead(id: string, tenantId: string): Promise<void> {
    // CRITICAL FIX (audit A3): add tenant filter to prevent cross-tenant
    // notification reads. Previously this method filtered only by `id`, so a
    // caller from tenant A could mark tenant B's notification as read by
    // guessing/enumerating the uuid. Callers must pass the tenant scope they
    // resolved (their own tenant for regular users, the notification's
    // tenant for super-admins operating cross-tenant).
    const { error } = await this.sb()
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) throw error;
  }
  async markAllNotificationsRead(tenantId: string, userId: string): Promise<void> {
    const { error } = await this.sb().from("notifications").update({ read: true, read_at: new Date().toISOString() })
      .eq("tenant_id", tenantId).or(`user_id.eq.${userId},user_id.is.null`).eq("read", false);
    if (error) throw error;
  }
  async deleteNotification(id: string): Promise<void> {
    const { error } = await this.sb().from("notifications").delete().eq("id", id);
    if (error) throw error;
  }
  async getUnreadCount(tenantId: string, userId: string): Promise<number> {
    const { count, error } = await this.sb().from("notifications").select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId).or(`user_id.eq.${userId},user_id.is.null`).eq("read", false);
    if (error) throw error;
    return count ?? 0;
  }
  async getNotificationById(id: string): Promise<Notification | null> {
    const { data, error } = await this.sb().from("notifications").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Notification) || null;
  }

  // ---- commission agents ----
  async listCommissionAgents(tenantId: string, params?: ListParams): Promise<ListResult<CommissionAgent>> {
    let q = this.sb().from("commission_agents").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.ilike("partner_id", `%${params.search}%`);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<CommissionAgent>(q, params);
  }
  async getCommissionAgent(id: string): Promise<CommissionAgent | null> {
    const { data, error } = await this.sb().from("commission_agents").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as CommissionAgent) || null;
  }
  async getCommissionAgentByPartner(partnerId: string): Promise<CommissionAgent | null> {
    const { data, error } = await this.sb().from("commission_agents").select("*").eq("partner_id", partnerId).maybeSingle();
    if (error) throw error;
    return (data as CommissionAgent) || null;
  }
  async upsertCommissionAgent(a: Partial<CommissionAgent> & { id?: string }): Promise<CommissionAgent> {
    return this.smartUpsert<CommissionAgent>("commission_agents", a, a.tenant_id ?? undefined);
  }
  async deleteCommissionAgent(id: string): Promise<void> {
    const { error } = await this.sb().from("commission_agents").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- deal commissions ----
  async listDealCommissions(tenantId: string, params?: ListParams): Promise<ListResult<DealCommission>> {
    let q = this.sb().from("deal_commissions").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.ilike("deal_id", `%${params.search}%`);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<DealCommission>(q, params);
  }
  async listDealCommissionsByDeal(dealId: string): Promise<DealCommission[]> {
    const { data, error } = await this.sb().from("deal_commissions").select("*").eq("deal_id", dealId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data as DealCommission[]) || [];
  }
  async listDealCommissionsByAgent(agentId: string): Promise<DealCommission[]> {
    const { data, error } = await this.sb().from("deal_commissions").select("*").eq("agent_id", agentId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data as DealCommission[]) || [];
  }
  async getDealCommission(id: string): Promise<DealCommission | null> {
    const { data, error } = await this.sb().from("deal_commissions").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as DealCommission) || null;
  }
  async upsertDealCommission(c: Partial<DealCommission> & { id?: string }): Promise<DealCommission> {
    return this.smartUpsert<DealCommission>("deal_commissions", c, c.tenant_id ?? undefined);
  }
  async deleteDealCommission(id: string): Promise<void> {
    const { error } = await this.sb().from("deal_commissions").delete().eq("id", id);
    if (error) throw error;
  }
  async approveDealCommission(id: string, approvedBy: string): Promise<DealCommission> {
    const { data, error } = await this.sb()
      .from("deal_commissions")
      .update({ status: "approved", approved_by: approvedBy, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data as DealCommission;
  }
  async markDealCommissionPaid(id: string, payoutReference?: string): Promise<DealCommission> {
    const update: Record<string, unknown> = {
      status: "paid",
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (payoutReference) update.payout_reference = payoutReference;
    // Only update if the commission is NOT already paid — prevents the
    // double-payment vector flagged in FLOW-3 (a payout that re-includes an
    // already-paid commission id would otherwise overwrite paid_at and
    // payout_reference, masking the duplicate).
    const { data, error } = await this.sb()
      .from("deal_commissions")
      .update(update)
      .eq("id", id)
      .neq("status", "paid")
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      // No row updated — either the commission doesn't exist OR it was
      // already paid. Log a warning and fetch the current row so callers
      // still receive a DealCommission (signature unchanged).
      console.warn(`[markDealCommissionPaid] Commission ${id} was not updated — already paid or missing.`);
      const { data: existing, error: fetchErr } = await this.sb()
        .from("deal_commissions")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) throw new Error(`DealCommission ${id} not found`);
      return existing as DealCommission;
    }
    return data as DealCommission;
  }

  // ---- commission payouts ----
  async listCommissionPayouts(tenantId: string, params?: ListParams): Promise<ListResult<CommissionPayout>> {
    let q = this.sb().from("commission_payouts").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.ilike("agent_id", `%${params.search}%`);
    q = q.order("created_at", { ascending: false });
    return paginateQuery<CommissionPayout>(q, params);
  }
  async getCommissionPayout(id: string): Promise<CommissionPayout | null> {
    const { data, error } = await this.sb().from("commission_payouts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as CommissionPayout) || null;
  }
  async upsertCommissionPayout(p: Partial<CommissionPayout> & { id?: string }): Promise<CommissionPayout> {
    return this.smartUpsert<CommissionPayout>("commission_payouts", p, p.tenant_id ?? undefined);
  }
  /**
   * Atomic commission-payout creation via the `create_commission_payout` RPC
   * (migration 002, patched in 031_erp_rpc_adoption.sql to skip the bulk
   * mark-paid when status != 'completed' and to return the inserted payout
   * row). The RPC wraps the payout INSERT + the bulk UPDATE of
   * deal_commissions.status='paid' in a single Postgres transaction —
   * replaces the previous non-atomic `upsertCommissionPayout` + JS loop of
   * `markDealCommissionPaid` pattern (audit B-1 P3 / C-3).
   */
  async createCommissionPayoutAtomic(
    payout: Partial<CommissionPayout> & { commission_ids: string[] },
    commissionIds: string[],
  ): Promise<CommissionPayout> {
    // The RPC requires `id`, `tenant_id`, and `partner_id` on p_payout
    // (it raises if any is missing). Generate a client-side id for the
    // new payout (the table has a default gen_random_uuid(), but the RPC
    // reads p_payout->>'id' rather than relying on the default).
    const payoutId = payout.id ?? ((typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `cp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    if (!payout.tenant_id) {
      throw new Error("createCommissionPayoutAtomic: tenant_id is required");
    }
    if (!payout.partner_id) {
      throw new Error("createCommissionPayoutAtomic: partner_id is required");
    }
    const p_payout: SupaRow = {
      id: payoutId,
      tenant_id: payout.tenant_id,
      agent_id: payout.agent_id,
      partner_id: payout.partner_id,
      total_amount: payout.total_amount ?? 0,
      currency: payout.currency || "USD",
      // RPC stores commission_ids as the text[] column on commission_payouts.
      commission_ids: commissionIds,
      payment_method: payout.payment_method,
      payment_reference: payout.payment_reference,
      status: payout.status || "completed",
      notes: payout.notes,
      created_by: payout.created_by,
    };
    const { data, error } = await this.sb().rpc("create_commission_payout", {
      p_payout,
      p_commission_ids: commissionIds,
    });
    if (error) throw error;
    const result = data as {
      payout: CommissionPayout;
      payout_id: string;
      commissions_marked_paid: number;
      commissions_already_paid: number;
      commissions_total: number;
    } | null;
    if (!result || !result.payout) {
      throw new Error("create_commission_payout RPC returned no payout");
    }
    // Log counts for observability — the route handler's audit log captures
    // the high-level event; these counts help reconcile commission status
    // during support investigations.
    console.info(
      `[createCommissionPayoutAtomic] payout=${result.payout_id} marked_paid=${result.commissions_marked_paid} already_paid=${result.commissions_already_paid} total=${result.commissions_total}`,
    );
    return result.payout;
  }
  async deleteCommissionPayout(id: string): Promise<void> {
    const { error } = await this.sb().from("commission_payouts").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- commission summaries ----
  async getCommissionSummaries(tenantId: string): Promise<CommissionSummary[]> {
    const agents = await this.listCommissionAgents(tenantId);
    const summaries: CommissionSummary[] = [];
    for (const agent of agents.items) {
      if (!agent.active) continue;
      const commissions = await this.listDealCommissionsByAgent(agent.id);
      const partner = await this.getPartner(agent.partner_id);
      summaries.push({
        agent_id: agent.id,
        partner_id: agent.partner_id,
        partner_name: partner?.name || "Unknown",
        total_deals: commissions.length,
        total_commission: commissions.reduce((sum, c) => sum + c.calculated_commission, 0),
        paid_commission: commissions.filter(c => c.status === "paid").reduce((sum, c) => sum + c.calculated_commission, 0),
        pending_commission: commissions.filter(c => c.status === "pending" || c.status === "approved").reduce((sum, c) => sum + c.calculated_commission, 0),
        currency: agent.commission_currency,
      });
    }
    return summaries;
  }
  async calculateCommission(agentId: string, dealValue: number, dealProfit: number, dealQuantity: number, _dealUnit: string, dealCurrency: string): Promise<number> {
    const agent = await this.getCommissionAgent(agentId);
    if (!agent) return 0;

    // CRITICAL FIX (audit P1-5): convert dealValue and dealProfit from the
    // deal's currency to the agent's commission_currency before calculating.
    // Without this, an agent owed €225 on a EUR deal with commission_currency=USD
    // would get $225 instead of ~$243.
    const agentCurrency = agent.commission_currency || dealCurrency || "USD";
    let convertedDealValue = dealValue;
    let convertedDealProfit = dealProfit;

    if (dealCurrency && agentCurrency && dealCurrency.toUpperCase() !== agentCurrency.toUpperCase()) {
      try {
        const { getExchangeRate } = await import("@/lib/utils/exchange-rates");
        const rate = await getExchangeRate(dealCurrency.toUpperCase(), agentCurrency.toUpperCase());
        if (rate && rate > 0) {
          convertedDealValue = Math.round(dealValue * rate * 100) / 100;
          convertedDealProfit = Math.round(dealProfit * rate * 100) / 100;
        }
      } catch {
        // Rate fetch failed — use original values (best effort).
        // The commission will be in the deal's currency, not the agent's.
      }
    }

    switch (agent.commission_type) {
      // CRITICAL FIX (audit P1-4): never return negative commission on loss-making deals.
      case "profit_percent": return Math.max(0, convertedDealProfit) * (agent.commission_rate / 100);
      case "revenue_percent": return convertedDealValue * (agent.commission_rate / 100);
      case "fixed": return agent.commission_rate;
      case "per_unit": return (agent.commission_per_unit || 0) * dealQuantity;
      case "custom": return agent.commission_rate;
      default: return 0;
    }
  }

  // ─── ERP Accounts ────────────────────────────────────────────────────────
  async listErpAccounts(tenantId: string, params?: ListParams): Promise<ListResult<ErpAccount>> {
    let q = this.sb().from("erp_accounts").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`code.ilike.%${safeSearch(params.search)}%,name.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.account_type) q = q.eq("account_type", params.filters.account_type);
    if (params?.filters?.is_active !== undefined) q = q.eq("is_active", params.filters.is_active);
    q = q.order("code", { ascending: true });
    return paginateQuery<ErpAccount>(q, params);
  }

  async getErpAccount(id: string): Promise<ErpAccount | null> {
    const { data, error } = await this.sb().from("erp_accounts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as ErpAccount) || null;
  }

  async upsertErpAccount(a: Partial<ErpAccount> & { id?: string }): Promise<ErpAccount> {
    const payload: SupaRow = { ...a };
    if (a.id) payload.id = a.id;
    const { data, error } = await this.sb().from("erp_accounts").upsert(payload, { onConflict: "tenant_id,code" }).select().single();
    if (error) throw error;
    return data as ErpAccount;
  }

  async deleteErpAccount(id: string): Promise<void> {
    const { error } = await this.sb().from("erp_accounts").delete().eq("id", id);
    if (error) throw error;
  }

  // ─── Fiscal Periods ──────────────────────────────────────────────────────
  async listFiscalPeriods(tenantId: string, params?: ListParams): Promise<ListResult<FiscalPeriod>> {
    let q = this.sb().from("fiscal_periods").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.ilike("name", `%${params.search}%`);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    if (params?.filters?.fiscal_year) q = q.eq("fiscal_year", params.filters.fiscal_year);
    q = q.order("start_date", { ascending: false });
    return paginateQuery<FiscalPeriod>(q, params);
  }

  async getFiscalPeriod(id: string): Promise<FiscalPeriod | null> {
    const { data, error } = await this.sb().from("fiscal_periods").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as FiscalPeriod) || null;
  }

  async upsertFiscalPeriod(p: Partial<FiscalPeriod> & { id?: string }): Promise<FiscalPeriod> {
    return this.smartUpsert<FiscalPeriod>("fiscal_periods", p, p.tenant_id ?? undefined);
  }

  async closeFiscalPeriod(id: string, closedBy: string): Promise<FiscalPeriod> {
    const { data, error } = await this.sb()
      .from("fiscal_periods")
      .update({ status: "closed", closed_by: closedBy, closed_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data as FiscalPeriod;
  }

  // ─── Journal Entries ─────────────────────────────────────────────────────
  async listErpJournalEntries(tenantId: string, params?: ListParams): Promise<ListResult<ErpJournalEntry>> {
    // P2 / task C-6 Fix 1: push pagination to the DB (was: fetch ALL entries
    // then slice in memory + fetch lines for every entry — O(N×M) on every
    // call). Now we fetch only the page slice, then batch-fetch lines for
    // just those entry ids.
    let q = this.sb().from("erp_journal_entries").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`entry_number.ilike.%${safeSearch(params.search)}%,description.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.status) q = q.eq("status", params.filters.status);
    if (params?.filters?.reference_type) q = q.eq("reference_type", params.filters.reference_type);
    if (params?.filters?.reference_id) q = q.eq("reference_id", params.filters.reference_id);
    q = q.order("date", { ascending: false });
    const { items: entries, total } = await paginateQuery<ErpJournalEntry>(q, params);
    // Attach lines for each entry (batched — single IN query for the whole page)
    if (entries.length > 0) {
      const entryIds = entries.map(e => e.id);
      const { data: linesData, error: linesError } = await this.sb()
        .from("erp_journal_lines")
        .select("*")
        .in("journal_entry_id", entryIds)
        .order("line_number", { ascending: true });
      if (linesError) throw linesError;
      const lines = (linesData as ErpJournalLine[]) || [];
      const linesByEntry = new Map<string, ErpJournalLine[]>();
      for (const l of lines) {
        const arr = linesByEntry.get(l.journal_entry_id) || [];
        arr.push(l);
        linesByEntry.set(l.journal_entry_id, arr);
      }
      for (const e of entries) {
        e.lines = linesByEntry.get(e.id) || [];
      }
    }
    return { items: entries, total };
  }

  async getErpJournalEntry(id: string): Promise<ErpJournalEntry | null> {
    const { data, error } = await this.sb().from("erp_journal_entries").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const entry = data as ErpJournalEntry;
    // Fetch lines
    const { data: linesData, error: linesError } = await this.sb()
      .from("erp_journal_lines")
      .select("*")
      .eq("journal_entry_id", id)
      .order("line_number", { ascending: true });
    if (linesError) throw linesError;
    entry.lines = (linesData as ErpJournalLine[]) || [];
    return entry;
  }

  async upsertErpJournalEntry(e: Omit<Partial<ErpJournalEntry>, "lines"> & { id?: string; lines?: Partial<ErpJournalLine & { id?: string }>[] }): Promise<ErpJournalEntry> {
    const { lines, ...entryFields } = e;
    // Compute debit/credit totals from lines if provided
    if (lines && lines.length > 0) {
      entryFields.debit_total = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
      entryFields.credit_total = lines.reduce((sum, l) => sum + (l.credit || 0), 0);
    }
    // CRITICAL FIX (audit P2-8): validate journal entry balances before
    // persisting. Double-entry bookkeeping requires debits == credits. An
    // unbalanced entry would silently corrupt the GL.
    if (Math.abs((entryFields.debit_total || 0) - (entryFields.credit_total || 0)) > 0.01) {
      throw new Error(`Journal entry does not balance: debit=${entryFields.debit_total}, credit=${entryFields.credit_total}`);
    }

    // CRITICAL FIX (audit B-1 P0 #3 / C-3): persist via the atomic
    // `upsert_journal_entry` RPC (migration 002) instead of the previous
    // non-atomic 3-step JS path (UPSERT header → DELETE old lines →
    // INSERT new lines). The RPC wraps all three statements in a single
    // Postgres transaction, so a failure between DELETE and INSERT can no
    // longer leave the entry header with zero lines but non-zero totals —
    // the GL corruption vector flagged by the audit.
    //
    // The RPC requires `id` and `tenant_id` on p_entry (it raises if either
    // is missing). For POST-style create flows that don't supply an id, we
    // generate one client-side (the RPC INSERT path needs it).
    const entryId = (entryFields.id as string | undefined) ?? ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `je_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    const tenantId = entryFields.tenant_id as string | undefined;
    if (!tenantId) {
      throw new Error("upsertErpJournalEntry: tenant_id is required");
    }
    // The RPC's INSERT path requires `created_by` (NOT NULL on the table).
    // For UPDATEs, the RPC preserves the existing created_by via COALESCE.
    if (!entryFields.created_by && !entryFields.id) {
      throw new Error("upsertErpJournalEntry: created_by is required for new entries");
    }

    // If no lines are provided (header-only UPDATE — e.g. description change),
    // we MUST NOT route through the RPC: the RPC always DELETEs existing
    // lines for the entry, which would orphan an entry that previously had
    // lines. Fall back to a plain single-statement UPDATE (atomic by itself
    // for the header) and return the entry with its existing lines intact.
    if (!lines || lines.length === 0) {
      if (entryFields.id) {
        const { data: updData, error: updErr } = await this.sb()
          .from("erp_journal_entries")
          .update({ ...entryFields, id: undefined, updated_at: new Date().toISOString() })
          .eq("id", entryFields.id)
          .eq("tenant_id", tenantId)
          .select()
          .single();
        if (updErr) throw updErr;
        const entry = updData as ErpJournalEntry;
        const { data: existingLines } = await this.sb()
          .from("erp_journal_lines")
          .select("*")
          .eq("journal_entry_id", entry.id)
          .order("line_number", { ascending: true });
        entry.lines = (existingLines as ErpJournalLine[]) || [];
        return entry;
      }
      // No id, no lines → throw (POST requires lines per the route's validation,
      // so this should never hit, but be defensive).
      throw new Error("upsertErpJournalEntry: cannot create a journal entry without lines");
    }

    const p_entry: SupaRow = {
      id: entryId,
      tenant_id: tenantId,
      entry_number: entryFields.entry_number,
      // The RPC casts `date` → timestamptz with COALESCE(now()) fallback,
      // so we can safely pass undefined for the JS side.
      date: entryFields.date ?? new Date().toISOString(),
      description: entryFields.description,
      reference_type: entryFields.reference_type,
      reference_id: entryFields.reference_id,
      fiscal_period_id: entryFields.fiscal_period_id,
      status: entryFields.status || "draft",
      source_type: entryFields.source_type,
      debit_total: entryFields.debit_total ?? 0,
      credit_total: entryFields.credit_total ?? 0,
      currency: entryFields.currency,
      exchange_rate: entryFields.exchange_rate,
      // E-2 (multi-currency ERP): pass the new multi-currency + revaluation
      // fields through to the RPC. Each is optional — the RPC COALESCEs
      // to a sane default when absent, so existing callers that don't
      // send them keep working unchanged.
      base_currency: entryFields.base_currency,
      is_revaluation: entryFields.is_revaluation,
      revaluation_of: entryFields.revaluation_of,
      notes: entryFields.notes,
      created_by: entryFields.created_by,
      posted_by: entryFields.posted_by,
      posted_at: entryFields.posted_at,
    };

    // E-2 (multi-currency ERP): the RPC now persists currency, fx_rate,
    // debit_base, and credit_base per line. We forward whatever the
    // caller provided. For lines that omit currency/fx_rate, the RPC
    // falls back to the entry-level currency / exchange_rate (and a
    // default of 1.0 when neither is set), then derives
    // debit_base = debit * fx_rate and credit_base = credit * fx_rate.
    // For one-sided revaluation adjustments, the caller passes
    // debit_base/credit_base explicitly with debit=credit=0; the RPC
    // respects the explicit values via COALESCE(NULLIF(..., '')).
    const p_lines = lines.map((l, idx) => ({
      line_number: l.line_number ?? (idx + 1),
      account_id: l.account_id,
      description: l.description,
      debit: l.debit || 0,
      credit: l.credit || 0,
      currency: l.currency,
      fx_rate: l.fx_rate,
      debit_base: l.debit_base,
      credit_base: l.credit_base,
    }));

    const { data, error } = await this.sb().rpc("upsert_journal_entry", {
      p_entry,
      p_lines,
    });
    if (error) throw error;

    const result = data as { entry: ErpJournalEntry; lines: ErpJournalLine[] } | null;
    if (!result || !result.entry) {
      throw new Error("upsert_journal_entry RPC returned no entry");
    }
    // RPC uses `date` (timestamptz) which the JS type calls `date` too — types align.
    result.entry.lines = (result.lines as ErpJournalLine[]) || [];
    return result.entry;
  }

  async postErpJournalEntry(id: string, postedBy: string): Promise<ErpJournalEntry> {
    // Fiscal-period validation (audit finding E P0 #2): refuse to post entries
    // into closed/locked periods. We fetch the entry first to read its date —
    // the method signature takes `id` (not the full entry) so the lookup is
    // required. If no fiscal period is configured for the entry's date, we
    // allow the post (don't block on missing config).
    const existing = await this.getErpJournalEntry(id);
    if (existing && existing.date) {
      // CRITICAL FIX (audit P1-8): add tenant filter to fiscal period lookup.
      // Without this, tenant A's closed period can block tenant B's posting.
      const period = await this.sb()
        .from("fiscal_periods")
        .select("id, status")
        .lte("start_date", existing.date)
        .gte("end_date", existing.date)
        .eq("tenant_id", existing.tenant_id)
        .maybeSingle();
      if (period.error) throw period.error;
      if (period.data && period.data.status === "closed") {
        throw new Error(`Fiscal period is closed for ${existing.date}`);
      }
      // If no period found, allow (period not configured) — don't block.
    }

    const { data, error } = await this.sb()
      .from("erp_journal_entries")
      .update({ status: "posted", posted_by: postedBy, posted_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    // Attach lines
    const { data: linesData } = await this.sb().from("erp_journal_lines").select("*").eq("journal_entry_id", id).order("line_number", { ascending: true });
    (data as ErpJournalEntry).lines = (linesData as ErpJournalLine[]) || [];
    return data as ErpJournalEntry;
  }

  async reverseErpJournalEntry(id: string, reversedBy: string): Promise<ErpJournalEntry> {
    // Fetch original entry
    const original = await this.getErpJournalEntry(id);
    if (!original) throw new Error("Journal entry not found");
    if (original.status === "reversed") throw new Error("Entry already reversed");
    // CRITICAL FIX (audit P2-7): cannot reverse a draft entry. Drafts have
    // no effect on the general ledger (they haven't been posted yet), so
    // reversing them would create a phantom posted reversal entry that
    // debases the books. The correct action is to delete or edit the draft.
    if (original.status === "draft") {
      throw new Error("Cannot reverse a draft journal entry. Post it first.");
    }
    // Fetch lines (we still need them locally to build p_reversal_lines —
    // the RPC takes the ORIGINAL lines and swaps debit/credit server-side).
    const { data: origLines } = await this.sb().from("erp_journal_lines").select("*").eq("journal_entry_id", id).order("line_number", { ascending: true });
    const lines = (origLines as ErpJournalLine[]) || [];
    if (lines.length === 0) {
      throw new Error("Cannot reverse a journal entry with no lines");
    }

    // CRITICAL FIX (audit B-1 P0 #3 / C-3): persist via the atomic
    // `reverse_journal_entry` RPC (migration 002) instead of the previous
    // non-atomic 3-step JS path (INSERT reversal header → INSERT reversed
    // lines → UPDATE original status='reversed'). The RPC wraps all three
    // in a single Postgres transaction, so a failure mid-reversal can no
    // longer leave the original marked 'reversed' with no reversal entry,
    // or a reversal entry with no lines.
    const reversalId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `rev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const reversalNumber = `REV-${original.entry_number}`;
    // CRITICAL FIX (audit P1-9): resolve today's fiscal period for the reversal,
    // not the original's (possibly closed) period. The reversal is dated today,
    // so it must land in today's period. If today has no period or the period
    // is closed, fall back to null (post without a period) rather than risking
    // a posting into the original's closed period.
    let reversalPeriodId: string | null = null;
    try {
      const today = new Date().toISOString().split("T")[0];
      const { data: todayPeriod, error: todayPeriodError } = await this.sb()
        .from("fiscal_periods")
        .select("id, status")
        .lte("start_date", today)
        .gte("end_date", today)
        .eq("tenant_id", original.tenant_id)
        .maybeSingle();
      if (!todayPeriodError && todayPeriod && todayPeriod.status !== "closed") {
        reversalPeriodId = todayPeriod.id;
      }
    } catch {
      /* non-fatal — fall back to null period */
    }
    // p_reversal_entry — only the fields the RPC's INSERT actually reads.
    // The RPC hardcodes reference_type='reversal' and reference_id=p_original_id
    // (more audit-friendly than the old JS path which copied the original's
    // reference_type). posted_by/posted_at are NOT read by the RPC's INSERT
    // — the reversal entry will have status='posted' with posted_by=NULL /
    // posted_at=NULL. Acceptable trade-off for atomicity; the route handler
    // still writes an audit_logs entry capturing `reversed_by`.
    const p_reversal_entry: SupaRow = {
      tenant_id: original.tenant_id,
      entry_number: reversalNumber,
      date: new Date().toISOString(),
      description: `Reversal of ${original.entry_number}: ${original.description}`,
      fiscal_period_id: reversalPeriodId,
      debit_total: original.credit_total,
      credit_total: original.debit_total,
      currency: original.currency,
      exchange_rate: original.exchange_rate,
      created_by: reversedBy,
    };
    // p_reversal_lines — the ORIGINAL lines (debit/credit). The RPC swaps
    // them server-side. We only send the columns the RPC reads.
    const p_reversal_lines = lines.map((l) => ({
      account_id: l.account_id,
      description: l.description,
      debit: l.debit || 0,
      credit: l.credit || 0,
    }));
    const p_reversal_reason = `Reversal of entry ${original.entry_number} by ${reversedBy}`;

    const { data: rpcData, error: rpcError } = await this.sb().rpc("reverse_journal_entry", {
      p_original_id: id,
      p_reversal_id: reversalId,
      p_reversal_entry,
      p_reversal_lines,
      p_reversal_reason,
    });
    if (rpcError) throw rpcError;
    const rpcResult = rpcData as { reversal_id: string; original_id: string; status: string } | null;
    if (!rpcResult || !rpcResult.reversal_id) {
      throw new Error("reverse_journal_entry RPC returned no reversal_id");
    }
    // Fetch the persisted reversal entry (with its lines) to return.
    const reversal = await this.getErpJournalEntry(rpcResult.reversal_id);
    if (!reversal) {
      throw new Error(`Reversal entry ${rpcResult.reversal_id} not found after RPC`);
    }
    return reversal;
  }

  async deleteErpJournalEntry(id: string): Promise<void> {
    // Lines cascade delete via FK
    const { error } = await this.sb().from("erp_journal_entries").delete().eq("id", id);
    if (error) throw error;
  }

  // E-2 (multi-currency ERP) — generate an FX revaluation journal entry.
  // Routes to the `create_fx_revaluation(text, date, text, jsonb, text)`
  // RPC (migration 038). The function creates a draft revaluation entry
  // (is_revaluation = true) with one balanced line-pair per adjustment.
  // Returns the RPC's JSONB result as a typed `FxRevaluationResult`.
  async createFxRevaluation(
    tenantId: string,
    revalDate: string,
    baseCurrency: string,
    adjustments: FxRevaluationAdjustment[],
    createdBy: string,
  ): Promise<FxRevaluationResult> {
    if (!tenantId) throw new Error("createFxRevaluation: tenant_id is required");
    if (!createdBy) throw new Error("createFxRevaluation: created_by is required");
    const { data, error } = await this.sb().rpc("create_fx_revaluation", {
      p_tenant_id: tenantId,
      p_reval_date: revalDate,
      p_base_currency: baseCurrency,
      p_adjustments: adjustments as unknown as SupaRow,
      p_created_by: createdBy,
    });
    if (error) throw error;
    const result = data as FxRevaluationResult | null;
    if (!result || !result.id) {
      throw new Error("create_fx_revaluation RPC returned no entry id");
    }
    return result;
  }

  // ─── Cost Centers ────────────────────────────────────────────────────────
  async listErpCostCenters(tenantId: string, params?: ListParams): Promise<ListResult<ErpCostCenter>> {
    let q = this.sb().from("erp_cost_centers").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (params?.search) q = q.or(`code.ilike.%${safeSearch(params.search)}%,name.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.is_active !== undefined) q = q.eq("is_active", params.filters.is_active);
    q = q.order("code", { ascending: true });
    return paginateQuery<ErpCostCenter>(q, params);
  }

  async upsertErpCostCenter(c: Partial<ErpCostCenter> & { id?: string }): Promise<ErpCostCenter> {
    const payload: SupaRow = { ...c };
    if (c.id) payload.id = c.id;
    const { data, error } = await this.sb().from("erp_cost_centers").upsert(payload, { onConflict: "tenant_id,code" }).select().single();
    if (error) throw error;
    return data as ErpCostCenter;
  }

  async deleteErpCostCenter(id: string): Promise<void> {
    const { error } = await this.sb().from("erp_cost_centers").delete().eq("id", id);
    if (error) throw error;
  }

  // ─── Bank Accounts ───────────────────────────────────────────────────────
  async listErpBankAccounts(tenantId: string): Promise<ErpBankAccount[]> {
    const { data, error } = await this.sb().from("erp_bank_accounts").select("*").eq("tenant_id", tenantId).order("bank_name", { ascending: true });
    if (error) throw error;
    return (data as ErpBankAccount[]) || [];
  }

  async upsertErpBankAccount(b: Partial<ErpBankAccount> & { id?: string }): Promise<ErpBankAccount> {
    return this.smartUpsert<ErpBankAccount>("erp_bank_accounts", b, b.tenant_id ?? undefined);
  }

  async deleteErpBankAccount(id: string): Promise<void> {
    const { error } = await this.sb().from("erp_bank_accounts").delete().eq("id", id);
    if (error) throw error;
  }

  // ─── Bank Transactions ──────────────────────────────────────────────────
  async listErpBankTransactions(tenantId: string, bankAccountId?: string, params?: ListParams): Promise<ListResult<ErpBankTransaction>> {
    let q = this.sb().from("erp_bank_transactions").select("*", { count: "exact" }).eq("tenant_id", tenantId);
    if (bankAccountId) q = q.eq("bank_account_id", bankAccountId);
    if (params?.search) q = q.or(`description.ilike.%${safeSearch(params.search)}%,reference.ilike.%${safeSearch(params.search)}%,counterparty.ilike.%${safeSearch(params.search)}%`);
    if (params?.filters?.is_reconciled !== undefined) q = q.eq("is_reconciled", params.filters.is_reconciled);
    q = q.order("date", { ascending: false });
    return paginateQuery<ErpBankTransaction>(q, params);
  }

  async upsertErpBankTransaction(t: Partial<ErpBankTransaction> & { id?: string }): Promise<ErpBankTransaction> {
    const payload: SupaRow = { ...t };
    let txn: ErpBankTransaction;
    // CRITICAL: tenant_id from the payload, used to scope every UPDATE/SELECT
    // below so a caller from tenant A can't hijack tenant B's transaction by
    // POSTing body.id=<tenant-B-txn-uuid>. ErpBankTransaction.tenant_id is
    // NOT NULL, so a falsy value means the caller is doing something wrong —
    // we still guard with the `if` to mirror upsertUser.
    const tenantId = (payload.tenant_id as string | undefined) ?? undefined;
    // If updating, fetch the OLD amount/type FIRST (before the write) so we
    // can reverse its effect on the bank balance. Fetching after the update
    // would return the new values and yield a zero net adjustment.
    let oldTxn: { amount: number; transaction_type: string } | null = null;
    if (t.id) {
      let oldQ = this.sb()
        .from("erp_bank_transactions")
        .select("amount, transaction_type")
        .eq("id", t.id);
      if (tenantId) oldQ = oldQ.eq("tenant_id", tenantId);
      const { data: old } = await oldQ.maybeSingle();
      oldTxn = (old as { amount: number; transaction_type: string } | null) ?? null;
      const { id, ...fields } = payload;
      let updQ = this.sb()
        .from("erp_bank_transactions")
        .update(fields)
        .eq("id", id);
      if (tenantId) updQ = updQ.eq("tenant_id", tenantId);
      const { data, error } = await updQ.select().single();
      if (error) throw error;
      if (!data) {
        // Row vanished between fetch and update — treat as a fresh insert and
        // drop the stale oldTxn so we don't double-reverse a deleted row.
        oldTxn = null;
        const { data: inserted, error: insErr } = await this.sb()
          .from("erp_bank_transactions")
          .insert(payload)
          .select()
          .single();
        if (insErr) throw insErr;
        txn = inserted as ErpBankTransaction;
      } else {
        txn = data as ErpBankTransaction;
      }
    } else {
      const { data, error } = await this.sb()
        .from("erp_bank_transactions")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      txn = data as ErpBankTransaction;
    }
    // Update bank account balance. Scope the bank_account lookup by tenant_id
    // too: a forged txn.bank_account_id pointing at another tenant's account
    // would otherwise leak its balance into this tenant's adjustment.
    if (txn.bank_account_id) {
      let baQ = this.sb().from("erp_bank_accounts").select("balance").eq("id", txn.bank_account_id);
      const baTenantId = tenantId ?? (txn.tenant_id as string | undefined);
      if (baTenantId) baQ = baQ.eq("tenant_id", baTenantId);
      const { data: ba } = await baQ.maybeSingle();
      if (ba) {
        const isCredit = txn.transaction_type === "credit" || txn.transaction_type === "income";
        const adjustment = isCredit ? txn.amount : -txn.amount;
        // If updating, reverse the OLD adjustment then apply the new one so
        // we don't re-apply the full amount on every edit.
        let netAdjustment = adjustment;
        if (oldTxn) {
          const oldIsCredit = oldTxn.transaction_type === "credit" || oldTxn.transaction_type === "income";
          const oldAdjustment = oldIsCredit ? -oldTxn.amount : oldTxn.amount; // reverse of old
          netAdjustment = oldAdjustment + adjustment;
        }
        let balQ = this.sb()
          .from("erp_bank_accounts")
          .update({ balance: (ba.balance as number) + netAdjustment })
          .eq("id", txn.bank_account_id);
        if (baTenantId) balQ = balQ.eq("tenant_id", baTenantId);
        await balQ;
      }
    }
    return txn;
  }

  async reconcileBankTransaction(id: string, journalEntryId: string): Promise<ErpBankTransaction> {
    const { data, error } = await this.sb()
      .from("erp_bank_transactions")
      .update({ is_reconciled: true, journal_entry_id: journalEntryId, reconciled_with: journalEntryId })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data as ErpBankTransaction;
  }

  // ─── ERP Settings (already implemented — kept as-is) ────────────────────
  async getErpSettings(tenantId: string): Promise<ErpSetting | null> {
    const { data, error } = await this.sb().from("erp_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
    if (error) throw error;
    return (data as ErpSetting) || null;
  }
  async upsertErpSettings(s: Partial<ErpSetting> & { id?: string; tenant_id: string }): Promise<ErpSetting> {
    const payload: SupaRow = { ...s };
    if (s.id) payload.id = s.id;
    const { data, error } = await this.sb().from("erp_settings").upsert(payload, { onConflict: "tenant_id" }).select().single();
    if (error) throw error;
    return data as ErpSetting;
  }

  // ─── ERP Reports ────────────────────────────────────────────────────────
  // E-2 (multi-currency ERP) helper: returns the base-currency amount for
  // a journal line. The line's `debit_base`/`credit_base` columns are
  // populated by the `upsert_journal_entry` RPC for all new lines. For
  // rows created before migration 038, the columns default to 0 — in
  // that case we fall back to the foreign-currency `debit`/`credit`
  // (which is the legacy single-currency behaviour: fx_rate is 1).
  private effectiveBase(line: { debit_base?: number | null; credit_base?: number | null; debit?: number | null; credit?: number | null }): { debit_base: number; credit_base: number } {
    const db = Number(line.debit_base);
    const cb = Number(line.credit_base);
    return {
      debit_base: Number.isFinite(db) && db !== 0 ? db : Number(line.debit) || 0,
      credit_base: Number.isFinite(cb) && cb !== 0 ? cb : Number(line.credit) || 0,
    };
  }

  // E-2 (multi-currency ERP) helper: returns the tenant's base currency
  // for a report header. Resolved from erp_settings.default_currency
  // (the existing per-tenant setting) with a 'USD' fallback. The
  // journal entries themselves carry an entry-level `base_currency`
  // column too, but erp_settings is the canonical tenant-wide value.
  private async getTenantBaseCurrency(tenantId: string): Promise<string> {
    const settings = await this.getErpSettings(tenantId);
    return settings?.default_currency || "USD";
  }

  async getTrialBalance(tenantId: string, asOfDate: string): Promise<TrialBalance> {
    // Fetch all posted journal entries up to asOfDate.
    // CRITICAL FIX (audit P1-10): include both "posted" and "reversed" entries.
    // When an entry is reversed, its status changes to "reversed" — excluding it
    // from reports would retroactively change historical periods. Including both
    // means the reversal entry (status="posted") nets out the original.
    const { data: entries, error: entriesError } = await this.sb()
      .from("erp_journal_entries")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("status", ["posted", "reversed"])
      .lte("date", asOfDate);
    if (entriesError) throw entriesError;
    const entryIds = ((entries || []) as { id: string }[]).map(e => e.id);
    if (entryIds.length === 0) return { items: [], total_debit: 0, total_credit: 0, as_of_date: asOfDate, total_debit_base: 0, total_credit_base: 0, base_currency: await this.getTenantBaseCurrency(tenantId) };
    // Fetch all lines for those entries — include the new base-currency
    // columns added by migration 038 so the report can show both the
    // foreign-currency amounts (debit/credit) and the base-currency
    // equivalents (debit_base/credit_base).
    const { data: lines, error: linesError } = await this.sb()
      .from("erp_journal_lines")
      .select("account_id, debit, credit, debit_base, credit_base, currency, fx_rate")
      .in("journal_entry_id", entryIds);
    if (linesError) throw linesError;
    // Fetch accounts for this tenant
    const { data: accounts, error: accountsError } = await this.sb()
      .from("erp_accounts")
      .select("id, code, name, account_type")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    if (accountsError) throw accountsError;
    const accountMap = new Map<string, { code: string; name: string; account_type: string }>();
    for (const a of (accounts || []) as { id: string; code: string; name: string; account_type: string }[]) {
      accountMap.set(a.id, a);
    }
    // Aggregate by account — both foreign and base amounts
    const accTotals = new Map<string, { debit: number; credit: number; debit_base: number; credit_base: number }>();
    for (const l of (lines || []) as { account_id: string; debit: number; credit: number; debit_base?: number | null; credit_base?: number | null }[]) {
      const cur = accTotals.get(l.account_id) || { debit: 0, credit: 0, debit_base: 0, credit_base: 0 };
      const eb = this.effectiveBase(l);
      cur.debit += l.debit || 0;
      cur.credit += l.credit || 0;
      cur.debit_base += eb.debit_base;
      cur.credit_base += eb.credit_base;
      accTotals.set(l.account_id, cur);
    }
    const items: TrialBalanceItem[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    let totalDebitBase = 0;
    let totalCreditBase = 0;
    for (const [accountId, totals] of accTotals) {
      const acc = accountMap.get(accountId);
      if (!acc) continue;
      const balance = totals.debit - totals.credit;
      const balanceBase = totals.debit_base - totals.credit_base;
      items.push({
        account_id: accountId,
        account_code: acc.code,
        account_name: acc.name,
        account_type: acc.account_type,
        debit_total: totals.debit,
        credit_total: totals.credit,
        balance,
        debit_total_base: totals.debit_base,
        credit_total_base: totals.credit_base,
        balance_base: balanceBase,
      });
      totalDebit += totals.debit;
      totalCredit += totals.credit;
      totalDebitBase += totals.debit_base;
      totalCreditBase += totals.credit_base;
    }
    items.sort((a, b) => a.account_code.localeCompare(b.account_code));
    return {
      items,
      total_debit: totalDebit,
      total_credit: totalCredit,
      as_of_date: asOfDate,
      total_debit_base: totalDebitBase,
      total_credit_base: totalCreditBase,
      base_currency: await this.getTenantBaseCurrency(tenantId),
    };
  }

  async getBalanceSheet(tenantId: string, asOfDate: string): Promise<BalanceSheet> {
    // Get trial balance data
    const tb = await this.getTrialBalance(tenantId, asOfDate);
    const assets: BalanceSheetItem[] = [];
    const liabilities: BalanceSheetItem[] = [];
    const equity: BalanceSheetItem[] = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;
    let totalAssetsBase = 0;
    let totalLiabilitiesBase = 0;
    let totalEquityBase = 0;
    for (const item of tb.items) {
      const balanceBase = item.balance_base ?? item.balance;
      const bsItem: BalanceSheetItem = {
        account_code: item.account_code,
        account_name: item.account_name,
        amount: Math.abs(item.balance),
        amount_base: Math.abs(balanceBase),
      };
      switch (item.account_type) {
        case "asset":
          assets.push(bsItem);
          totalAssets += item.balance; // assets: normal DEBIT balance (positive)
          totalAssetsBase += balanceBase;
          break;
        case "liability":
          liabilities.push(bsItem);
          // CRITICAL FIX (audit P1-6): liabilities and equity have a normal
          // CREDIT balance. Trial-balance `balance = debit - credit` is
          // therefore negative for them. Use Math.abs() so the balance
          // sheet actually balances: assets = liabilities + equity.
          totalLiabilities += Math.abs(item.balance);
          totalLiabilitiesBase += Math.abs(balanceBase);
          break;
        case "equity":
          equity.push(bsItem);
          totalEquity += Math.abs(item.balance); // same credit-balance fix
          totalEquityBase += Math.abs(balanceBase);
          break;
        default:
          break;
      }
    }
    return {
      assets, liabilities, equity,
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity: totalEquity,
      as_of_date: asOfDate,
      total_assets_base: totalAssetsBase,
      total_liabilities_base: totalLiabilitiesBase,
      total_equity_base: totalEquityBase,
      base_currency: tb.base_currency,
    };
  }

  async getProfitAndLoss(tenantId: string, periodStart: string, periodEnd: string): Promise<ProfitAndLoss> {
    // Fetch journal entries in the period.
    // CRITICAL FIX (audit P1-10): include both "posted" and "reversed" entries
    // so reversals (status="posted") correctly net out their reversed originals
    // (status="reversed") without retroactively changing historical P&L.
    const { data: entries, error: entriesError } = await this.sb()
      .from("erp_journal_entries")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("status", ["posted", "reversed"])
      .gte("date", periodStart)
      .lte("date", periodEnd);
    if (entriesError) throw entriesError;
    const entryIds = ((entries || []) as { id: string }[]).map(e => e.id);
    if (entryIds.length === 0) return { revenue: [], expenses: [], total_revenue: 0, total_expenses: 0, net_profit: 0, period_start: periodStart, period_end: periodEnd, total_revenue_base: 0, total_expenses_base: 0, net_profit_base: 0, base_currency: await this.getTenantBaseCurrency(tenantId) };
    // Fetch lines — include base-currency columns
    const { data: lines, error: linesError } = await this.sb()
      .from("erp_journal_lines")
      .select("account_id, debit, credit, debit_base, credit_base, currency, fx_rate")
      .in("journal_entry_id", entryIds);
    if (linesError) throw linesError;
    // Fetch revenue and expense accounts
    const { data: accounts, error: accountsError } = await this.sb()
      .from("erp_accounts")
      .select("id, code, name, account_type")
      .eq("tenant_id", tenantId)
      .in("account_type", ["revenue", "expense"])
      .eq("is_active", true);
    if (accountsError) throw accountsError;
    const accountMap = new Map<string, { code: string; name: string; account_type: string }>();
    for (const a of (accounts || []) as { id: string; code: string; name: string; account_type: string }[]) {
      accountMap.set(a.id, a);
    }
    // Aggregate — both foreign and base amounts
    const accTotals = new Map<string, { debit: number; credit: number; debit_base: number; credit_base: number }>();
    for (const l of (lines || []) as { account_id: string; debit: number; credit: number; debit_base?: number | null; credit_base?: number | null }[]) {
      const cur = accTotals.get(l.account_id) || { debit: 0, credit: 0, debit_base: 0, credit_base: 0 };
      const eb = this.effectiveBase(l);
      cur.debit += l.debit || 0;
      cur.credit += l.credit || 0;
      cur.debit_base += eb.debit_base;
      cur.credit_base += eb.credit_base;
      accTotals.set(l.account_id, cur);
    }
    const revenue: BalanceSheetItem[] = [];
    const expenses: BalanceSheetItem[] = [];
    let totalRevenue = 0;
    let totalExpenses = 0;
    let totalRevenueBase = 0;
    let totalExpensesBase = 0;
    for (const [accountId, totals] of accTotals) {
      const acc = accountMap.get(accountId);
      if (!acc) continue;
      const amount = Math.abs(totals.credit - totals.debit);
      const amountBase = Math.abs(totals.credit_base - totals.debit_base);
      const item: BalanceSheetItem = {
        account_code: acc.code,
        account_name: acc.name,
        amount,
        amount_base: amountBase,
      };
      if (acc.account_type === "revenue") {
        revenue.push(item);
        totalRevenue += totals.credit - totals.debit; // revenue: credit balance
        totalRevenueBase += totals.credit_base - totals.debit_base;
      } else if (acc.account_type === "expense") {
        expenses.push(item);
        totalExpenses += totals.debit - totals.credit; // expense: debit balance
        totalExpensesBase += totals.debit_base - totals.credit_base;
      }
    }
    return {
      revenue, expenses,
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      net_profit: totalRevenue - totalExpenses,
      period_start: periodStart,
      period_end: periodEnd,
      total_revenue_base: totalRevenueBase,
      total_expenses_base: totalExpensesBase,
      net_profit_base: totalRevenueBase - totalExpensesBase,
      base_currency: await this.getTenantBaseCurrency(tenantId),
    };
  }

  async getGeneralLedger(tenantId: string, accountId: string, dateFrom?: string, dateTo?: string): Promise<GeneralLedger> {
    // Get account info
    const account = await this.getErpAccount(accountId);
    const accountCode = account?.code || "";
    const accountName = account?.name || "";
    // Get all posted journal entries for this tenant
    let entryQuery = this.sb()
      .from("erp_journal_entries")
      .select("id, entry_number, date, description, reference_type, reference_id")
      .eq("tenant_id", tenantId)
      .eq("status", "posted");
    if (dateFrom) entryQuery = entryQuery.gte("date", dateFrom);
    if (dateTo) entryQuery = entryQuery.lte("date", dateTo);
    const { data: entries, error: entriesError } = await entryQuery.order("date", { ascending: true });
    if (entriesError) throw entriesError;
    const entryIds = ((entries || []) as { id: string }[]).map(e => e.id);
    if (entryIds.length === 0) {
      return {
        account_id: accountId, account_code: accountCode, account_name: accountName,
        entries: [], opening_balance: 0, closing_balance: 0, total_debit: 0, total_credit: 0,
        opening_balance_base: 0, closing_balance_base: 0, total_debit_base: 0, total_credit_base: 0,
        base_currency: await this.getTenantBaseCurrency(tenantId),
      };
    }
    // Get lines for this account across all matching entries — include
    // base-currency columns.
    const { data: lines, error: linesError } = await this.sb()
      .from("erp_journal_lines")
      .select("journal_entry_id, debit, credit, debit_base, credit_base, currency, fx_rate")
      .eq("account_id", accountId)
      .in("journal_entry_id", entryIds);
    if (linesError) throw linesError;
    const linesByEntry = new Map<string, { debit: number; credit: number; debit_base: number; credit_base: number; currency?: string }>();
    for (const l of (lines || []) as { journal_entry_id: string; debit: number; credit: number; debit_base?: number | null; credit_base?: number | null; currency?: string }[]) {
      const eb = this.effectiveBase(l);
      linesByEntry.set(l.journal_entry_id, {
        debit: l.debit, credit: l.credit,
        debit_base: eb.debit_base, credit_base: eb.credit_base,
        currency: l.currency,
      });
    }
    // Compute opening balance (all posted lines before dateFrom) — both
    // foreign and base-currency running totals.
    let openingBalance = 0;
    let openingBalanceBase = 0;
    if (dateFrom) {
      const { data: preEntries } = await this.sb()
        .from("erp_journal_entries")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("status", "posted")
        .lt("date", dateFrom);
      const preEntryIds = ((preEntries || []) as { id: string }[]).map(e => e.id);
      if (preEntryIds.length > 0) {
        const { data: preLines } = await this.sb()
          .from("erp_journal_lines")
          .select("debit, credit, debit_base, credit_base")
          .eq("account_id", accountId)
          .in("journal_entry_id", preEntryIds);
        for (const pl of (preLines || []) as { debit: number; credit: number; debit_base?: number | null; credit_base?: number | null }[]) {
          openingBalance += (pl.debit || 0) - (pl.credit || 0);
          const eb = this.effectiveBase(pl);
          openingBalanceBase += eb.debit_base - eb.credit_base;
        }
      }
    }
    // Build entries list
    const glEntries: GeneralLedgerEntry[] = [];
    let runningBalance = openingBalance;
    let runningBalanceBase = openingBalanceBase;
    let totalDebit = 0;
    let totalCredit = 0;
    let totalDebitBase = 0;
    let totalCreditBase = 0;
    for (const entry of (entries || []) as { id: string; entry_number: string; date: string; description: string; reference_type: string | null; reference_id: string | null }[]) {
      const line = linesByEntry.get(entry.id);
      if (!line) continue;
      const debit = line.debit || 0;
      const credit = line.credit || 0;
      const debitBase = line.debit_base || 0;
      const creditBase = line.credit_base || 0;
      runningBalance += debit - credit;
      runningBalanceBase += debitBase - creditBase;
      totalDebit += debit;
      totalCredit += credit;
      totalDebitBase += debitBase;
      totalCreditBase += creditBase;
      glEntries.push({
        journal_entry_id: entry.id,
        entry_number: entry.entry_number,
        date: entry.date,
        description: entry.description,
        debit,
        credit,
        balance: runningBalance,
        reference_type: entry.reference_type,
        reference_id: entry.reference_id,
        debit_base: debitBase,
        credit_base: creditBase,
        balance_base: runningBalanceBase,
        currency: line.currency,
      });
    }
    return {
      account_id: accountId,
      account_code: accountCode,
      account_name: accountName,
      entries: glEntries,
      opening_balance: openingBalance,
      closing_balance: runningBalance,
      total_debit: totalDebit,
      total_credit: totalCredit,
      opening_balance_base: openingBalanceBase,
      closing_balance_base: runningBalanceBase,
      total_debit_base: totalDebitBase,
      total_credit_base: totalCreditBase,
      base_currency: await this.getTenantBaseCurrency(tenantId),
    };
  }

  // ─── Auto-Journal ────────────────────────────────────────────────────────
  async autoJournalFromInvoice(invoiceId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null> {
    const invoice = await this.getInvoice(invoiceId);
    if (!invoice) return null;
    const settings = await this.getErpSettings(tenantId);
    const receivableAccountId = settings?.receivable_account_id;
    const revenueAccountId = settings?.revenue_account_id;
    if (!receivableAccountId || !revenueAccountId) return null;

    // CRITICAL FIX (audit B-1 P0 #3 / C-3): previously this method did a
    // non-atomic 2-step INSERT (header → lines). If the lines INSERT failed,
    // the header row was orphaned with debit_total/credit_total set but zero
    // lines — silent GL corruption. Now we route through the atomic
    // `upsert_journal_entry` RPC (migration 002) via the now-atomic
    // `upsertErpJournalEntry` store method. The header + lines are persisted
    // in a single Postgres transaction.
    //
    // IDEMPOTENCY (audit TXN-5): before persisting, check if a journal entry
    // already exists for this invoice (reference_type='invoice' +
    // reference_id=invoiceId for this tenant). If so, return the existing
    // entry — a retry of the parent flow (e.g. record-payment cascade) must
    // not double-post revenue. The deployed `auto_journal_from_invoice` RPC
    // also has this idempotency check, but it uses placeholder account_ids
    // ('accounts_receivable' / 'sales_revenue') which would regress the
    // erp_settings-based account resolution we do here. So we keep the
    // settings lookup + idempotency check client-side and only delegate the
    // atomic write to the upsert RPC.
    const { data: existingJe } = await this.sb()
      .from("erp_journal_entries")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("reference_type", "invoice")
      .eq("reference_id", invoiceId)
      .limit(1)
      .maybeSingle();
    if (existingJe) {
      const existing = await this.getErpJournalEntry(existingJe.id as string);
      if (existing) return existing;
      // fall through if the lookup somehow fails (race with delete)
    }

    const entryNumber = `INV-${invoice.number}-${Date.now()}`;
    // Two balanced lines: Debit AR, Credit Revenue. (Per-line partner_id /
    // cost_center_id / currency are NOT preserved by the upsert RPC — see
    // 031_erp_rpc_adoption.sql for the documented limitation.)
    //
    // Explicit element type annotation is required because `ErpJournalEntry`
    // also declares an optional `lines?: ErpJournalLine[]` (the joined view
    // used by GET endpoints). Without the annotation, TypeScript's
    // contextual typing widens the inline literal to the intersection of
    // `ErpJournalLine[]` and `Partial<ErpJournalLine & { id?: string }>[]`,
    // which demands every required ErpJournalLine field be present on each
    // element — not what we want here.
    const lines: Partial<ErpJournalLine & { id?: string }>[] = [
      { account_id: receivableAccountId, line_number: 1, description: `AR for invoice ${invoice.number}`, debit: invoice.total, credit: 0 },
      { account_id: revenueAccountId, line_number: 2, description: `Revenue for invoice ${invoice.number}`, debit: 0, credit: invoice.total },
    ];
    // Defer entry-id + payload construction to `upsertErpJournalEntry` — it
    // generates a UUID, validates balance, and calls the atomic RPC.
    const created = await this.upsertErpJournalEntry({
      tenant_id: tenantId,
      entry_number: entryNumber,
      date: invoice.issue_date,
      description: `Invoice ${invoice.number} - ${invoice.subject || "Sales"}`,
      reference_type: "invoice",
      reference_id: invoiceId,
      status: settings.auto_post_journal ? "posted" : "draft",
      source_type: "auto",
      debit_total: invoice.total,
      credit_total: invoice.total,
      currency: invoice.currency,
      exchange_rate: 1,
      created_by: userId,
      posted_by: settings.auto_post_journal ? userId : null,
      posted_at: settings.auto_post_journal ? new Date().toISOString() : null,
      lines,
    });
    return created;
  }

  async autoJournalFromDeal(dealId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null> {
    const deal = await this.getDeal(dealId);
    if (!deal) return null;
    const settings = await this.getErpSettings(tenantId);
    const revenueAccountId = settings?.revenue_account_id;
    const expenseAccountId = settings?.expense_account_id;
    const receivableAccountId = settings?.receivable_account_id;
    if (!revenueAccountId || !receivableAccountId) return null;
    const entryNumber = `DEAL-${dealId.slice(0, 8)}-${Date.now()}`;
    const totalDebit = deal.value;
    const totalCredit = deal.value;
    const entry: SupaRow = {
      tenant_id: tenantId,
      entry_number: entryNumber,
      date: new Date().toISOString(),
      description: `Deal revenue: ${deal.title}`,
      reference_type: "deal",
      reference_id: dealId,
      status: settings?.auto_post_journal ? "posted" : "draft",
      source_type: "auto",
      debit_total: totalDebit,
      credit_total: totalCredit,
      currency: deal.currency,
      exchange_rate: 1,
      created_by: userId,
      posted_by: settings?.auto_post_journal ? userId : null,
      posted_at: settings?.auto_post_journal ? new Date().toISOString() : null,
    };
    const { data, error } = await this.sb().from("erp_journal_entries").insert(entry).select().single();
    if (error) throw error;
    const je = data as ErpJournalEntry;
    const linePayloads: SupaRow[] = [
      { tenant_id: tenantId, journal_entry_id: je.id, account_id: receivableAccountId, line_number: 1, description: `AR for deal ${deal.title}`, debit: deal.value, credit: 0, currency: deal.currency, partner_id: deal.partner_id },
      { tenant_id: tenantId, journal_entry_id: je.id, account_id: revenueAccountId, line_number: 2, description: `Revenue for deal ${deal.title}`, debit: 0, credit: deal.value, currency: deal.currency, partner_id: deal.partner_id },
    ];
    // Add COGS line if deal has buy_cost and expense account configured
    if (deal.buy_cost > 0 && expenseAccountId) {
      const payableAccountId = settings?.payable_account_id || expenseAccountId;
      linePayloads.push(
        { tenant_id: tenantId, journal_entry_id: je.id, account_id: expenseAccountId, line_number: 3, description: `COGS for deal ${deal.title}`, debit: deal.buy_cost, credit: 0, currency: deal.currency, partner_id: deal.partner_id },
        { tenant_id: tenantId, journal_entry_id: je.id, account_id: payableAccountId, line_number: 4, description: `AP for deal ${deal.title} cost`, debit: 0, credit: deal.buy_cost, currency: deal.currency, partner_id: deal.partner_id },
      );
      // Adjust totals
      je.debit_total += deal.buy_cost;
      je.credit_total += deal.buy_cost;
      await this.sb().from("erp_journal_entries").update({ debit_total: je.debit_total, credit_total: je.credit_total }).eq("id", je.id).eq("tenant_id", tenantId);
    }
    const { data: insertedLines, error: linesError } = await this.sb().from("erp_journal_lines").insert(linePayloads).select();
    if (linesError) throw linesError;
    je.lines = (insertedLines as ErpJournalLine[]) || [];
    return je;
  }

  async autoJournalFromCommission(commissionId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null> {
    const commission = await this.getDealCommission(commissionId);
    if (!commission) return null;
    const settings = await this.getErpSettings(tenantId);
    const expenseAccountId = settings?.expense_account_id;
    const payableAccountId = settings?.payable_account_id;
    if (!expenseAccountId || !payableAccountId) return null;
    const entryNumber = `COMM-${commissionId.slice(0, 8)}-${Date.now()}`;
    const amount = commission.calculated_commission;
    const entry: SupaRow = {
      tenant_id: tenantId,
      entry_number: entryNumber,
      date: new Date().toISOString(),
      description: `Commission expense: ${commission.commission_type} on deal ${commission.deal_id}`,
      reference_type: "commission",
      reference_id: commissionId,
      status: settings?.auto_post_journal ? "posted" : "draft",
      source_type: "auto",
      debit_total: amount,
      credit_total: amount,
      currency: commission.commission_currency,
      exchange_rate: 1,
      created_by: userId,
      posted_by: settings?.auto_post_journal ? userId : null,
      posted_at: settings?.auto_post_journal ? new Date().toISOString() : null,
    };
    const { data, error } = await this.sb().from("erp_journal_entries").insert(entry).select().single();
    if (error) throw error;
    const je = data as ErpJournalEntry;
    const linePayloads: SupaRow[] = [
      { tenant_id: tenantId, journal_entry_id: je.id, account_id: expenseAccountId, line_number: 1, description: `Commission expense`, debit: amount, credit: 0, currency: commission.commission_currency, partner_id: commission.partner_id },
      { tenant_id: tenantId, journal_entry_id: je.id, account_id: payableAccountId, line_number: 2, description: `Commission payable`, debit: 0, credit: amount, currency: commission.commission_currency, partner_id: commission.partner_id },
    ];
    const { data: insertedLines, error: linesError } = await this.sb().from("erp_journal_lines").insert(linePayloads).select();
    if (linesError) throw linesError;
    je.lines = (insertedLines as ErpJournalLine[]) || [];
    return je;
  }

  // ---- user preferences ----
  async getUserPreference(userId: string, key: string): Promise<UserPreference | null> {
    const { data, error } = await this.sb()
      .from("user_preferences")
      .select("*")
      .eq("user_id", userId)
      .eq("preference_key", key)
      .maybeSingle();
    if (error) throw error;
    return data as UserPreference | null;
  }

  async setUserPreference(userId: string, key: string, value: unknown): Promise<UserPreference> {
    const { data, error } = await this.sb()
      .from("user_preferences")
      .upsert(
        {
          user_id: userId,
          preference_key: key,
          preference_value: typeof value === "string" ? value : JSON.stringify(value),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,preference_key" }
      )
      .select()
      .single();
    if (error) throw error;
    return data as UserPreference;
  }

  async deleteUserPreference(userId: string, key: string): Promise<void> {
    const { error } = await this.sb()
      .from("user_preferences")
      .delete()
      .eq("user_id", userId)
      .eq("preference_key", key);
    if (error) throw error;
  }

  async listUserPreferences(userId: string): Promise<UserPreference[]> {
    const { data, error } = await this.sb()
      .from("user_preferences")
      .select("*")
      .eq("user_id", userId)
      .order("preference_key");
    if (error) throw error;
    return (data as UserPreference[]) || [];
  }

  // ─── Security (write methods) ───────────────────────────────────────────

  async createSession(s: { user_id: string; ip?: string | null; user_agent?: string | null; country?: string | null; expires_at: string; current?: boolean }): Promise<SecuritySession> {
    // Resolve tenant_id from user
    const user = await this.getUserById(s.user_id);
    const payload: SupaRow = {
      user_id: s.user_id,
      tenant_id: user?.tenant_id || null,
      ip: s.ip ?? null,
      user_agent: s.user_agent ?? null,
      country: s.country ?? null,
      expires_at: s.expires_at,
      current: s.current ?? false,
      revoked: false,
      last_used_at: new Date().toISOString(),
    };
    const { data, error } = await this.sb().from("sessions").insert(payload).select().single();
    if (error) throw error;
    return data as SecuritySession;
  }

  async revokeSessionById(id: string): Promise<void> {
    // CRITICAL FIX (audit P0-2/D-2): same as revokeSession — must bump
    // token_version so the JWT actually becomes invalid.
    const { data: session, error: fetchErr } = await this.sb()
      .from("sessions")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    const { error } = await this.sb().from("sessions").update({ revoked: true, current: false }).eq("id", id);
    if (error) throw error;
    if (session?.user_id) {
      if (session.user_id.startsWith("portal:")) {
        const portalId = session.user_id.replace("portal:", "");
        const { data: pa } = await this.sb()
          .from("portal_access")
          .select("token_version")
          .eq("id", portalId)
          .maybeSingle();
        if (pa) {
          await this.sb()
            .from("portal_access")
            .update({ token_version: (pa.token_version ?? 0) + 1 })
            .eq("id", portalId);
        }
      } else {
        await this.bumpUserTokenVersion(session.user_id);
      }
    }
  }

  async touchSession(id: string): Promise<void> {
    try {
      await this.sb().from("sessions").update({ last_used_at: new Date().toISOString() }).eq("id", id);
    } catch { /* best-effort */ }
  }

  async recordLoginHistory(e: { user_id: string; username: string; ip?: string | null; user_agent?: string | null; country?: string | null; success: boolean; reason?: string | null }): Promise<LoginHistoryEntry> {
    const user = e.user_id ? await this.getUserById(e.user_id) : null;
    const payload: SupaRow = {
      user_id: e.user_id || null,
      tenant_id: user?.tenant_id || null,
      username: e.username,
      ip: e.ip ?? null,
      user_agent: e.user_agent ?? null,
      country: e.country ?? null,
      success: e.success,
      reason: e.reason ?? null,
    };
    const { data, error } = await this.sb().from("login_history").insert(payload).select().single();
    if (error) throw error;
    return data as LoginHistoryEntry;
  }

  async upsertKnownIp(ip: { user_id: string; ip: string; country?: string | null; trusted?: boolean }): Promise<KnownIp> {
    const user = await this.getUserById(ip.user_id);
    // Find existing
    const { data: existing } = await this.sb()
      .from("known_ips")
      .select("*")
      .eq("user_id", ip.user_id)
      .eq("ip", ip.ip)
      .maybeSingle();
    if (existing) {
      const { data, error } = await this.sb()
        .from("known_ips")
        .update({
          last_seen: new Date().toISOString(),
          country: ip.country ?? (existing as any).country,
          trusted: ip.trusted ?? (existing as any).trusted,
        })
        .eq("id", (existing as any).id)
        .select()
        .single();
      if (error) throw error;
      return data as KnownIp;
    }
    const payload: SupaRow = {
      user_id: ip.user_id,
      tenant_id: user?.tenant_id || null,
      ip: ip.ip,
      country: ip.country ?? null,
      trusted: ip.trusted ?? false,
    };
    const { data, error } = await this.sb().from("known_ips").insert(payload).select().single();
    if (error) throw error;
    return data as KnownIp;
  }

  async upsertTrustedDevice(d: { user_id: string; device_name: string; fingerprint: string; ip?: string | null }): Promise<TrustedDevice> {
    const user = await this.getUserById(d.user_id);
    const { data: existing } = await this.sb()
      .from("trusted_devices")
      .select("*")
      .eq("user_id", d.user_id)
      .eq("fingerprint", d.fingerprint)
      .maybeSingle();
    if (existing) {
      const { data, error } = await this.sb()
        .from("trusted_devices")
        .update({
          last_used: new Date().toISOString(),
          ip: d.ip ?? (existing as any).ip,
          device_name: d.device_name || (existing as any).device_name,
        })
        .eq("id", (existing as any).id)
        .select()
        .single();
      if (error) throw error;
      return data as TrustedDevice;
    }
    const payload: SupaRow = {
      user_id: d.user_id,
      tenant_id: user?.tenant_id || null,
      device_name: d.device_name,
      fingerprint: d.fingerprint,
      ip: d.ip ?? null,
    };
    const { data, error } = await this.sb().from("trusted_devices").insert(payload).select().single();
    if (error) throw error;
    return data as TrustedDevice;
  }

  async revokeTrustedDeviceById(id: string): Promise<void> {
    const { error } = await this.sb().from("trusted_devices").update({ revoked: true }).eq("id", id);
    if (error) throw error;
  }

  // ─── Tenant Letterheads (Memorandum firme) ──────────────────────────────

  async listLetterheads(tenantId: string): Promise<TenantLetterhead[]> {
    const { data, error } = await this.sb()
      .from("tenant_letterheads")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as TenantLetterhead[]) || [];
  }

  async getLetterhead(id: string): Promise<TenantLetterhead | null> {
    const { data, error } = await this.sb().from("tenant_letterheads").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as TenantLetterhead) || null;
  }

  async getDefaultLetterhead(tenantId: string): Promise<TenantLetterhead | null> {
    const { data, error } = await this.sb()
      .from("tenant_letterheads")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("is_default", true)
      .maybeSingle();
    if (error) throw error;
    return (data as TenantLetterhead) || null;
  }

  async upsertLetterhead(l: Partial<TenantLetterhead> & { id?: string; tenant_id: string }): Promise<TenantLetterhead> {
    // If setting as default, unset other defaults
    if (l.is_default) {
      await this.sb()
        .from("tenant_letterheads")
        .update({ is_default: false })
        .eq("tenant_id", l.tenant_id)
        .eq("is_default", true)
        .neq("id", l.id || "00000000-0000-0000-0000-000000000000");
    }
    return this.smartUpsert<TenantLetterhead>("tenant_letterheads", l, l.tenant_id ?? undefined);
  }

  async deleteLetterhead(id: string): Promise<void> {
    // Unlink templates referencing this letterhead
    await this.sb().from("document_templates").update({ letterhead_id: null }).eq("letterhead_id", id);
    const { error } = await this.sb().from("tenant_letterheads").delete().eq("id", id);
    if (error) throw error;
  }

  // ─── Tenant Seals (Zigled) ──────────────────────────────────────────────

  async listSeals(tenantId: string): Promise<TenantSeal[]> {
    const { data, error } = await this.sb()
      .from("tenant_seals")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data as TenantSeal[]) || [];
  }

  async getSeal(id: string): Promise<TenantSeal | null> {
    const { data, error } = await this.sb().from("tenant_seals").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as TenantSeal) || null;
  }

  async getDefaultSeal(tenantId: string): Promise<TenantSeal | null> {
    const { data, error } = await this.sb()
      .from("tenant_seals")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("is_default", true)
      .maybeSingle();
    if (error) throw error;
    return (data as TenantSeal) || null;
  }

  async upsertSeal(s: Partial<TenantSeal> & { id?: string; tenant_id: string }): Promise<TenantSeal> {
    if (s.is_default) {
      await this.sb()
        .from("tenant_seals")
        .update({ is_default: false })
        .eq("tenant_id", s.tenant_id)
        .eq("is_default", true)
        .neq("id", s.id || "00000000-0000-0000-0000-000000000000");
    }
    return this.smartUpsert<TenantSeal>("tenant_seals", s, s.tenant_id ?? undefined);
  }

  async deleteSeal(id: string): Promise<void> {
    await this.sb().from("document_templates").update({ seal_id: null }).eq("seal_id", id);
    const { error } = await this.sb().from("tenant_seals").delete().eq("id", id);
    if (error) throw error;
  }
}
