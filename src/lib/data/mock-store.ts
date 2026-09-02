// MockStore — implements the Store interface over the in-memory seed data.
// Mutations persist for the lifetime of the process (fine for dev/demo).
// NOTE: This store is used only when DB_BACKEND=mock (testing only).
// Production uses SupabaseStore. Type errors are suppressed because the
// mock seed data has drifted from the multi-tenant types in supabase/types.ts.
// @ts-nocheck

import { Store, ListParams, ListResult } from "./store";
import * as mock from "./mock";
import { ensureStarterTemplates } from "./starter-templates";
// AUDIT16 — encryption parity with the API layer (see SupabaseStore).
import { encryptField, decryptField, hmacField, isEncrypted } from "@/lib/crypto/field-encryption";
import {
  User, Partner, Product, Deal, Offer, Demand, SharedDocument,
  AuditLog, Setting, UserTask, InventoryMovement, EntityNote,
  DashboardInsights,
  DashboardCharts,
  Invoice, Proforma, DocumentRegisterEntry, DocumentRevision,
  VaultSecret, ApiKey, Webhook,
  SecuritySession, LoginHistoryEntry, KnownIp, TrustedDevice,
  MailQueueEntry,
  Tenant, ProductCatalogEntry, SupplierOffer, TradeCalculation,
  PortalAccess, DocumentTemplate, DocumentVerification, VerificationLog,
  KycSubmission, KycDocument, PortalRfq,
  TenantFeatureFlags,
  Notification,
  CommissionAgent, DealCommission, CommissionPayout, CommissionSummary,
  ErpAccount, FiscalPeriod, ErpJournalEntry, ErpJournalLine,
  ErpCostCenter, ErpBankAccount, ErpBankTransaction, ErpSetting,
  TrialBalance, TrialBalanceItem, BalanceSheet, BalanceSheetItem,
  ProfitAndLoss, GeneralLedger, GeneralLedgerEntry,
  FxRevaluationAdjustment, FxRevaluationResult,
  UserPreference,
} from "@/lib/supabase/types";

function matchesSearch(haystack: string, needle?: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function paginate<T>(items: T[], params?: ListParams): ListResult<T> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  return { items: items.slice(offset, offset + limit), total: items.length };
}


// AUDIT18: interface-parity stubs for modules that exist only on the Supabase
// backend (LOIs, commissions, letterheads/seals, security-session writes).
// Previously these methods were entirely ABSENT, so any route touching them
// crashed with "store.listLois is not a function" (opaque 500). Now they fail
// with an actionable message instead. Production (DB_BACKEND=supabase / Vercel)
// is unaffected — SupabaseStore implements all of them for real.
function mockUnsupported(op: string): Error {
  return new Error(
    `${op}() is not implemented on the MockStore backend. This module requires the Supabase store — set DB_BACKEND=supabase. The MockStore is an in-memory test fallback and was never extended with this module's tables.`,
  );
}

export class MockStore implements Store {
  async listLois(tenantId: string, params?: ListParams) { throw mockUnsupported("listLois"); }
  async getLoi(id: string) { throw mockUnsupported("getLoi"); }
  async upsertLoi(l: Partial<LetterOfIntent> & { id?: string }) { throw mockUnsupported("upsertLoi"); }
  async deleteLoi(id: string) { throw mockUnsupported("deleteLoi"); }
  async listLetterheads(tenantId: string) { throw mockUnsupported("listLetterheads"); }
  async getLetterhead(id: string) { throw mockUnsupported("getLetterhead"); }
  async getDefaultLetterhead(tenantId: string) { throw mockUnsupported("getDefaultLetterhead"); }
  async upsertLetterhead(l: Partial<TenantLetterhead> & { id?: string; tenant_id: string }) { throw mockUnsupported("upsertLetterhead"); }
  async deleteLetterhead(id: string) { throw mockUnsupported("deleteLetterhead"); }
  async listSeals(tenantId: string) { throw mockUnsupported("listSeals"); }
  async getSeal(id: string) { throw mockUnsupported("getSeal"); }
  async getDefaultSeal(tenantId: string) { throw mockUnsupported("getDefaultSeal"); }
  async upsertSeal(s: Partial<TenantSeal> & { id?: string; tenant_id: string }) { throw mockUnsupported("upsertSeal"); }
  async deleteSeal(id: string) { throw mockUnsupported("deleteSeal"); }
  async createSession(s: { user_id: string; tenant_id?: string; ip?: string | null; user_agent?: string | null; country?: string | null; expires_at: string; current?: boolean }) { throw mockUnsupported("createSession"); }
  async revokeSessionById(id: string) { throw mockUnsupported("revokeSessionById"); }
  async touchSession(id: string) { throw mockUnsupported("touchSession"); }
  async recordLoginHistory(e: { user_id: string; username: string; ip?: string | null; user_agent?: string | null; country?: string | null; success: boolean; reason?: string | null }) { throw mockUnsupported("recordLoginHistory"); }
  async upsertKnownIp(ip: { user_id: string; tenant_id?: string; ip: string; country?: string | null; trusted?: boolean }) { throw mockUnsupported("upsertKnownIp"); }
  async upsertTrustedDevice(d: { user_id: string; tenant_id?: string; device_name: string; fingerprint: string; ip?: string | null }) { throw mockUnsupported("upsertTrustedDevice"); }
  async revokeTrustedDeviceById(id: string) { throw mockUnsupported("revokeTrustedDeviceById"); }

  // ---- ERP in-memory maps ----
  private erpAccounts = new Map<string, ErpAccount>();
  private fiscalPeriods = new Map<string, FiscalPeriod>();
  private erpJournalEntries = new Map<string, ErpJournalEntry>();
  private erpJournalLines = new Map<string, ErpJournalLine>();
  private erpCostCenters = new Map<string, ErpCostCenter>();
  private erpBankAccounts = new Map<string, ErpBankAccount>();
  private erpBankTransactions = new Map<string, ErpBankTransaction>();
  private erpSettings = new Map<string, ErpSetting>();
  private journalEntryCounter = 0;

  // ---- auth ----
  async getUserByUsername(username: string): Promise<User | null> {
    return mock.users.find((u) => u.username === username) || null;
  }
  async getUserById(id: string): Promise<User | null> {
    return mock.users.find((u) => u.id === id) || null;
  }
  async listUsers(_tenantId: string): Promise<User[]> {
    return [...mock.users];
  }
  async upsertUser(u: Partial<User> & { id?: string }): Promise<User> {
    const existing = u.id ? mock.users.find((x) => x.id === u.id) : null;
    if (existing) {
      Object.assign(existing, u, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newUser: User = {
      id: u.id || mock.nid("u_"),
      tenant_id: u.tenant_id || null,
      username: u.username || "",
      email: u.email || "",
      full_name: u.full_name || null,
      role: u.role || "user",
      permissions: u.permissions || null,
      password_hash: u.password_hash || mock.mockHash("password"),
      totp_secret: u.totp_secret || null,
      totp_enabled: u.totp_enabled ?? false,
      recovery_codes: u.recovery_codes ?? null,
      locked_until: u.locked_until || null,
      failed_attempts: u.failed_attempts ?? 0,
      last_login_at: u.last_login_at || null,
      last_login_ip: u.last_login_ip || null,
      last_login_country: u.last_login_country || null,
      must_change_password: u.must_change_password ?? false,
      token_version: u.token_version ?? 1,
      signature: u.signature || null,
      notif_prefs: u.notif_prefs || null,
      active: u.active ?? true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.users.push(newUser);
    return newUser;
  }
  async deleteUser(id: string): Promise<void> {
    const idx = mock.users.findIndex((u) => u.id === id);
    if (idx >= 0) mock.users.splice(idx, 1);
  }
  // GDPR Article 17 — no-op in the mock store (mock has no audit_logs table).
  // Returns 0 so callers in the user-deletion cascade can invoke this
  // unconditionally without checking which store implementation is active.
  async anonymizeUserAuditLogs(_userId: string): Promise<number> {
    return 0;
  }
  async updateUserLastLogin(id: string, ip: string): Promise<void> {
    const u = mock.users.find((x) => x.id === id);
    if (u) {
      u.last_login_at = new Date().toISOString();
      u.last_login_ip = ip;
    }
  }
  async bumpUserTokenVersion(id: string): Promise<number> {
    const u = mock.users.find((x) => x.id === id);
    if (u) { u.token_version += 1; return u.token_version; }
    return 1;
  }

  // ---- partners ----
  async listPartners(_tenantId: string, params?: ListParams): Promise<ListResult<Partner>> {
    let items = [...mock.partners];
    if (params?.search) {
      items = items.filter((p) =>
        matchesSearch(`${p.name} ${p.email || ""} ${p.contact_name || ""}`, params.search)
      );
    }
    if (params?.filters?.status) items = items.filter((p) => p.status === params.filters!.status);
    if (params?.filters?.type) items = items.filter((p) => p.type === params.filters!.type);
    return paginate(items, params);
  }
  async getPartner(id: string): Promise<Partner | null> {
    return mock.partners.find((p) => p.id === id) || null;
  }
  async upsertPartner(p: Partial<Partner> & { id?: string }): Promise<Partner> {
    const existing = p.id ? mock.partners.find((x) => x.id === p.id) : null;
    if (existing) {
      Object.assign(existing, p, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newP: Partner = {
      id: p.id || mock.nid("p_"),
      tenant_id: p.tenant_id || "",
      name: p.name || "New Partner",
      entity_type: p.entity_type || "company",
      type: p.type || "buyer",
      email: p.email || null,
      phone: p.phone || null,
      website: p.website || null,
      tax_id: p.tax_id || null,
      address_line: p.address_line || null,
      city: p.city || null,
      state: p.state || null,
      postal_code: p.postal_code || null,
      country: p.country || null,
      contact_name: p.contact_name || null,
      contact_email: p.contact_email || null,
      contact_phone: p.contact_phone || null,
      bank_name: p.bank_name || null,
      bank_account: p.bank_account || null,
      bank_swift: p.bank_swift || null,
      status: p.status || "active",
      risk_score: p.risk_score ?? 0,
      notes: p.notes || null,
      tags: p.tags || null,
      portal_enabled: p.portal_enabled ?? false,
      portal_token: p.portal_token || null,
      portal_level: p.portal_level || "none",
      kyc_status: p.kyc_status || "not_submitted",
      kyc_data: p.kyc_data || null,
      kyc_reviewed_by: p.kyc_reviewed_by || null,
      kyc_reviewed_at: p.kyc_reviewed_at || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.partners.push(newP);
    return newP;
  }
  async deletePartner(id: string): Promise<void> {
    const idx = mock.partners.findIndex((p) => p.id === id);
    if (idx >= 0) mock.partners.splice(idx, 1);
  }

  // ---- products ----
  async listProducts(_tenantId: string, params?: ListParams): Promise<ListResult<Product>> {
    let items = [...mock.products];
    if (params?.search) {
      items = items.filter((p) =>
        matchesSearch(`${p.name} ${p.sku} ${p.category || ""}`, params.search)
      );
    }
    if (params?.filters?.category) items = items.filter((p) => p.category === params.filters!.category);
    return paginate(items, params);
  }
  async getProduct(id: string): Promise<Product | null> {
    return mock.products.find((p) => p.id === id) || null;
  }
  async upsertProduct(p: Partial<Product> & { id?: string }): Promise<Product> {
    const existing = p.id ? mock.products.find((x) => x.id === p.id) : null;
    if (existing) {
      Object.assign(existing, p, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newP: Product = {
      id: p.id || mock.nid("pr_"),
      sku: p.sku || "",
      name: p.name || "",
      description: p.description || null,
      category: p.category || null,
      unit: p.unit || "kom",
      price: p.price ?? 0,
      currency: p.currency || "USD",
      cost: p.cost ?? null,
      stock: p.stock ?? 0,
      reorder_level: p.reorder_level ?? 0,
      active: p.active ?? true,
      attributes: p.attributes || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.products.push(newP);
    return newP;
  }
  async deleteProduct(id: string): Promise<void> {
    const idx = mock.products.findIndex((p) => p.id === id);
    if (idx >= 0) mock.products.splice(idx, 1);
  }

  // ---- deals ----
  async listDeals(_tenantId: string, params?: ListParams): Promise<ListResult<Deal>> {
    let items = [...mock.deals];
    if (params?.search) items = items.filter((d) => matchesSearch(d.title, params.search));
    if (params?.filters?.partner_id) items = items.filter((d) => d.partner_id === params.filters!.partner_id);
    if (params?.filters?.stage) items = items.filter((d) => d.stage === params.filters!.stage);
    return paginate(items, params);
  }
  async getDeal(id: string): Promise<Deal | null> {
    return mock.deals.find((d) => d.id === id) || null;
  }
  async upsertDeal(d: Partial<Deal> & { id?: string }): Promise<Deal> {
    const existing = d.id ? mock.deals.find((x) => x.id === d.id) : null;
    if (existing) {
      Object.assign(existing, d, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newD: Deal = {
      id: d.id || mock.nid("d_"),
      title: d.title || "New Deal",
      partner_id: d.partner_id || "",
      owner_id: d.owner_id || null,
      stage: d.stage || "lead",
      value: d.value ?? 0,
      currency: d.currency || "USD",
      expected_close: d.expected_close || null,
      probability: d.probability ?? 0,
      description: d.description || null,
      lost_reason: d.lost_reason || null,
      commission_agent_id: d.commission_agent_id ?? null,
      buy_cost: d.buy_cost ?? 0,
      quantity: d.quantity ?? 0,
      unit: d.unit || "pcs",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.deals.push(newD);
    return newD;
  }
  async deleteDeal(id: string): Promise<void> {
    const idx = mock.deals.findIndex((d) => d.id === id);
    if (idx >= 0) mock.deals.splice(idx, 1);
  }

  // ---- offers ----
  async listOffers(_tenantId: string, params?: ListParams): Promise<ListResult<Offer>> {
    let items = [...mock.offers];
    if (params?.search) items = items.filter((o) => matchesSearch(`${o.number} ${o.subject}`, params.search));
    if (params?.filters?.partner_id) items = items.filter((o) => o.partner_id === params.filters!.partner_id);
    if (params?.filters?.status) items = items.filter((o) => o.status === params.filters!.status);
    return paginate(items, params);
  }
  async getOffer(id: string): Promise<Offer | null> {
    return mock.offers.find((o) => o.id === id) || null;
  }
  async upsertOffer(o: Partial<Offer> & { id?: string }): Promise<Offer> {
    const existing = o.id ? mock.offers.find((x) => x.id === o.id) : null;
    if (existing) {
      Object.assign(existing, o, { updated_at: new Date().toISOString() });
      return existing;
    }
    const num = `OF-2026-${String(mock.offers.length + 1).padStart(3, "0")}`;
    const newO: Offer = {
      id: o.id || mock.nid("o_"),
      number: o.number || num,
      deal_id: o.deal_id || null,
      partner_id: o.partner_id || "",
      owner_id: o.owner_id || null,
      status: o.status || "draft",
      subject: o.subject || "Nova ponuda",
      currency: o.currency || "USD",
      subtotal: o.subtotal ?? 0,
      discount_total: o.discount_total ?? 0,
      tax_total: o.tax_total ?? 0,
      total: o.total ?? 0,
      notes: o.notes || null,
      terms: o.terms || null,
      valid_until: o.valid_until || null,
      sent_at: o.sent_at || null,
      responded_at: o.responded_at || null,
      items: o.items || [],
      // Trade / import fields
      offer_no: o.offer_no || null,
      bank_details: o.bank_details || null,
      pol: o.pol || null,
      pod: o.pod || null,
      vessel: o.vessel || null,
      container_no: o.container_no || null,
      lead_time: o.lead_time || null,
      packaging: o.packaging || null,
      payment_terms: o.payment_terms || null,
      tax_clause: o.tax_clause || null,
      incoterm: o.incoterm || null,
      selling_price: o.selling_price ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.offers.push(newO);
    return newO;
  }
  async deleteOffer(id: string): Promise<void> {
    const idx = mock.offers.findIndex((o) => o.id === id);
    if (idx >= 0) mock.offers.splice(idx, 1);
  }

  // ---- demands ----
  async listDemands(_tenantId: string, params?: ListParams): Promise<ListResult<Demand>> {
    let items = [...mock.demands];
    if (params?.search) items = items.filter((d) => matchesSearch(`${d.number} ${d.subject}`, params.search));
    if (params?.filters?.partner_id) items = items.filter((d) => d.partner_id === params.filters!.partner_id);
    if (params?.filters?.status) items = items.filter((d) => d.status === params.filters!.status);
    return paginate(items, params);
  }
  async getDemand(id: string): Promise<Demand | null> {
    return mock.demands.find((d) => d.id === id) || null;
  }
  async upsertDemand(d: Partial<Demand> & { id?: string }): Promise<Demand> {
    const existing = d.id ? mock.demands.find((x) => x.id === d.id) : null;
    if (existing) {
      Object.assign(existing, d, { updated_at: new Date().toISOString() });
      return existing;
    }
    const num = `RFQ-2026-${String(mock.demands.length + 1).padStart(3, "0")}`;
    const newD: Demand = {
      id: d.id || mock.nid("dm_"),
      number: d.number || num,
      partner_id: d.partner_id || "",
      status: d.status || "open",
      priority: d.priority || "medium",
      subject: d.subject || "Nova potražnja",
      description: d.description || null,
      requested_delivery: d.requested_delivery || null,
      currency: d.currency || "EUR",
      items: d.items || [],
      // Trade / import fields
      product_id: d.product_id || null,
      product_name: d.product_name || null,
      target_price: d.target_price ?? null,
      is_new_product: d.is_new_product ?? false,
      source: d.source || null,
      auto_hints: d.auto_hints || null,
      buyer_bank: d.buyer_bank || null,
      destination: d.destination || null,
      needed_by: d.needed_by || null,
      payment_terms: d.payment_terms || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.demands.push(newD);
    return newD;
  }
  async deleteDemand(id: string): Promise<void> {
    const idx = mock.demands.findIndex((d) => d.id === id);
    if (idx >= 0) mock.demands.splice(idx, 1);
  }

  // ---- documents ----
  async listDocuments(_tenantId: string, params?: ListParams): Promise<ListResult<SharedDocument>> {
    let items = [...mock.documents];
    if (params?.search) items = items.filter((d) => matchesSearch(d.filename, params.search));
    if (params?.filters?.partner_id) items = items.filter((d) => d.partner_id === params.filters!.partner_id);
    return paginate(items, params);
  }
  async getDocument(id: string): Promise<SharedDocument | null> {
    return mock.documents.find((d) => d.id === id) || null;
  }
  async upsertDocument(d: Partial<SharedDocument> & { id?: string }): Promise<SharedDocument> {
    const existing = d.id ? mock.documents.find((x) => x.id === d.id) : null;
    if (existing) {
      Object.assign(existing, d);
      return existing;
    }
    const newD: SharedDocument = {
      id: d.id || mock.nid("doc_"),
      partner_id: d.partner_id || "",
      filename: d.filename || "document",
      mime_type: d.mime_type || "application/octet-stream",
      size: d.size ?? 0,
      storage_path: d.storage_path || "",
      category: d.category || "other",
      uploaded_by: d.uploaded_by || null,
      visible_to_partner: d.visible_to_partner ?? false,
      created_at: new Date().toISOString(),
    };
    mock.documents.push(newD);
    return newD;
  }
  async deleteDocument(id: string): Promise<void> {
    const idx = mock.documents.findIndex((d) => d.id === id);
    if (idx >= 0) mock.documents.splice(idx, 1);
  }

  // ---- audit ----
  async listAudit(_tenantId: string, params?: ListParams): Promise<ListResult<AuditLog>> {
    let items = [...mock.auditLogs].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (params?.search) items = items.filter((a) => matchesSearch(`${a.action} ${a.username || ""}`, params.search));
    // ADMIN-H12: in-memory mirror of the server-side filters the
    // Supabase store pushes down. Mock store is dev-only, but should
    // still honour the same filter contract so dev tests don't pass
    // here and fail in production.
    if (params?.action) {
      const a = params.action.toLowerCase();
      items = items.filter((x) => (x.action || "").toLowerCase().includes(a));
    }
    if (params?.username) {
      const u = params.username.toLowerCase();
      items = items.filter((x) => (x.username || "").toLowerCase().includes(u));
    }
    if (params?.entity_type) {
      const e = params.entity_type.toLowerCase();
      items = items.filter((x) => (x.entity_type || "").toLowerCase().includes(e));
    }
    if (params?.date_from) {
      const t = new Date(params.date_from).getTime();
      if (!isNaN(t)) items = items.filter((x) => new Date(x.created_at).getTime() >= t);
    }
    if (params?.date_to) {
      const t = new Date(params.date_to).getTime();
      if (!isNaN(t)) items = items.filter((x) => new Date(x.created_at).getTime() <= t);
    }
    return paginate(items, params);
  }
  async appendAudit(entry: Omit<AuditLog, "id" | "created_at">): Promise<AuditLog> {
    const log: AuditLog = {
      ...entry,
      id: mock.nid("a_"),
      created_at: new Date().toISOString(),
    };
    mock.auditLogs.unshift(log);
    return log;
  }

  // ---- settings ----
  async getSetting<T = unknown>(key: string, tenantId: string | null = null): Promise<T | null> {
    const scoped = `${tenantId ?? "__platform__"}::${key}`;
    return (mock.settings[scoped] as T) ?? null;
  }
  async setSetting(key: string, value: unknown, tenantId: string | null = null): Promise<void> {
    const scoped = `${tenantId ?? "__platform__"}::${key}`;
    mock.settings[scoped] = value;
  }
  async getAllSettings(tenantId: string | null = null): Promise<Setting[]> {
    const prefix = `${tenantId ?? "__platform__"}::`;
    return Object.entries(mock.settings)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({
        key: k.slice(prefix.length),
        value: v,
        tenant_id: tenantId,
        updated_at: new Date().toISOString(),
      } as unknown as Setting));
  }

  // ---- tasks ----
  async listTasks(_tenantId: string, userId?: string): Promise<UserTask[]> {
    return userId ? mock.tasks.filter((t) => t.user_id === userId) : [...mock.tasks];
  }
  async upsertTask(t: Partial<UserTask> & { id?: string }): Promise<UserTask> {
    const existing = t.id ? mock.tasks.find((x) => x.id === t.id) : null;
    if (existing) {
      Object.assign(existing, t);
      return existing;
    }
    const newT: UserTask = {
      id: t.id || mock.nid("t_"),
      user_id: t.user_id || "",
      title: t.title || "",
      done: t.done ?? false,
      due_date: t.due_date || null,
      entity_type: t.entity_type || null,
      entity_id: t.entity_id || null,
      priority: t.priority || "medium",
      created_at: new Date().toISOString(),
    };
    mock.tasks.push(newT);
    return newT;
  }
  async deleteTask(id: string): Promise<void> {
    const idx = mock.tasks.findIndex((t) => t.id === id);
    if (idx >= 0) mock.tasks.splice(idx, 1);
  }

  // ---- notes ----
  async listNotes(_tenantId: string, entityType: string, entityId: string): Promise<EntityNote[]> {
    return mock.notes.filter((n) => n.entity_type === entityType && n.entity_id === entityId);
  }
  async upsertNote(n: Partial<EntityNote> & { id?: string }): Promise<EntityNote> {
    const existing = n.id ? mock.notes.find((x) => x.id === n.id) : null;
    if (existing) {
      Object.assign(existing, n);
      return existing;
    }
    const newN: EntityNote = {
      id: n.id || mock.nid("n_"),
      entity_type: n.entity_type || "",
      entity_id: n.entity_id || "",
      content: n.content || "",
      pinned: n.pinned ?? false,
      created_by: n.created_by || null,
      created_at: new Date().toISOString(),
    };
    mock.notes.push(newN);
    return newN;
  }
  async deleteNote(id: string): Promise<void> {
    const idx = mock.notes.findIndex((n) => n.id === id);
    if (idx >= 0) mock.notes.splice(idx, 1);
  }

  // ---- inventory ----
  async listInventory(_tenantId: string, partnerId: string): Promise<InventoryMovement[]> {
    return mock.inventoryMovements.filter((m) => m.partner_id === partnerId);
  }
  async addInventoryMovement(m: Partial<InventoryMovement> & { id?: string }): Promise<InventoryMovement> {
    const newM: InventoryMovement = {
      id: m.id || mock.nid("im_"),
      partner_id: m.partner_id || "",
      product_id: m.product_id || "",
      delta: m.delta ?? 0,
      reason: m.reason || "",
      reference: m.reference || null,
      created_at: new Date().toISOString(),
    };
    mock.inventoryMovements.push(newM);
    return newM;
  }

  // ---- dashboard ----
  async getInsights(): Promise<DashboardInsights> {
    return mock.computeInsights();
  }

  // ── Dashboard analytics charts (task D-2) ───────────────────────────────
  // MockStore is the dev/test backend (DB_BACKEND=mock). It ships with no
  // seed data, so we return zero-filled series matching the trailing-12-
  // month bucket layout that SupabaseStore produces. This keeps the
  // dashboard charts renderable in mock mode (empty state) instead of
  // throwing "auth.store.getDashboardCharts is not a function".
  //
  // If a future task seeds the mock store with sample invoices / offers,
  // swap this stub for a real aggregation over `mock.invoices` etc.
  async getDashboardCharts(
    _tenantId: string | null | undefined,
    period: string = "12m",
    _topN: number = 5,
  ): Promise<DashboardCharts> {
    const months = period === "6m" ? 6 : 12;
    const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = new Date();
    const buckets: { key: string; label: string }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      buckets.push({ key, label: `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCFullYear()}` });
    }
    return {
      period,
      salesData: buckets.map((b) => ({ month: b.key, label: b.label, revenue: 0, count: 0 })),
      topProducts: [],
      offerStatus: [
        { status: "draft", count: 0, value: 0 },
        { status: "sent", count: 0, value: 0 },
        { status: "accepted", count: 0, value: 0 },
        { status: "rejected", count: 0, value: 0 },
        { status: "expired", count: 0, value: 0 },
      ],
      marginByCategory: [],
      paymentTrend: buckets.map((b) => ({ month: b.key, label: b.label, payments: 0, count: 0 })),
    };
  }

  // ---- invoices ----
  async listInvoices(_tenantId: string, params?: ListParams): Promise<ListResult<Invoice>> {
    let items = [...mock.invoices];
    if (params?.search) items = items.filter((i) => matchesSearch(`${i.number} ${i.subject}`, params.search));
    if (params?.filters?.partner_id) items = items.filter((i) => i.partner_id === params.filters!.partner_id);
    if (params?.filters?.status) items = items.filter((i) => i.status === params.filters!.status);
    return paginate(items, params);
  }
  async getInvoice(id: string): Promise<Invoice | null> {
    return mock.invoices.find((i) => i.id === id) || null;
  }
  async upsertInvoice(i: Partial<Invoice> & { id?: string }): Promise<Invoice> {
    const existing = i.id ? mock.invoices.find((x) => x.id === i.id) : null;
    if (existing) { Object.assign(existing, i, { updated_at: new Date().toISOString() }); return existing; }
    const num = `INV-2026-${String(mock.invoices.length + 1).padStart(3, "0")}`;
    const newI: Invoice = {
      id: i.id || mock.nid("inv_"), number: i.number || num, offer_id: i.offer_id || null,
      partner_id: i.partner_id || "", status: i.status || "draft", subject: i.subject || "New invoice",
      currency: i.currency || "USD", subtotal: i.subtotal ?? 0, discount_total: i.discount_total ?? 0,
      tax_total: i.tax_total ?? 0, total: i.total ?? 0, issue_date: i.issue_date || new Date().toISOString(),
      due_date: i.due_date || new Date(Date.now() + 14 * 86400000).toISOString(),
      sent_at: i.sent_at || null, paid_at: i.paid_at || null, notes: i.notes || null,
      items: i.items || [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.invoices.push(newI); return newI;
  }
  async deleteInvoice(id: string): Promise<void> {
    const idx = mock.invoices.findIndex((i) => i.id === id); if (idx >= 0) mock.invoices.splice(idx, 1);
  }

  // ---- proformas ----
  async listProformas(_tenantId: string, params?: ListParams): Promise<ListResult<Proforma>> {
    let items = [...mock.proformas];
    if (params?.search) items = items.filter((i) => matchesSearch(`${i.number} ${i.subject}`, params.search));
    if (params?.filters?.partner_id) items = items.filter((i) => i.partner_id === params.filters!.partner_id);
    if (params?.filters?.status) items = items.filter((i) => i.status === params.filters!.status);
    return paginate(items, params);
  }
  async getProforma(id: string): Promise<Proforma | null> {
    return mock.proformas.find((i) => i.id === id) || null;
  }
  async upsertProforma(p: Partial<Proforma> & { id?: string }): Promise<Proforma> {
    const existing = p.id ? mock.proformas.find((x) => x.id === p.id) : null;
    if (existing) { Object.assign(existing, p, { updated_at: new Date().toISOString() }); return existing; }
    const num = `PRO-2026-${String(mock.proformas.length + 1).padStart(3, "0")}`;
    const newP: Proforma = {
      id: p.id || mock.nid("pro_"), number: p.number || num, offer_id: p.offer_id || null,
      partner_id: p.partner_id || "", status: p.status || "draft", subject: p.subject || "New proforma",
      currency: p.currency || "EUR", subtotal: p.subtotal ?? 0, discount_total: p.discount_total ?? 0,
      tax_total: p.tax_total ?? 0, total: p.total ?? 0, issue_date: p.issue_date || new Date().toISOString(),
      valid_until: p.valid_until || new Date(Date.now() + 14 * 86400000).toISOString(),
      sent_at: p.sent_at || null, paid_at: p.paid_at || null, payment_terms: p.payment_terms || "net30",
      notes: p.notes || null,
      items: p.items || [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.proformas.push(newP); return newP;
  }
  async deleteProforma(id: string): Promise<void> {
    const idx = mock.proformas.findIndex((i) => i.id === id); if (idx >= 0) mock.proformas.splice(idx, 1);
  }

  // ---- document register ----
  async listDocumentRegister(_tenantId: string, params?: ListParams): Promise<ListResult<DocumentRegisterEntry>> {
    let items = [...mock.documentRegister];
    if (params?.search) items = items.filter((e) => matchesSearch(`${e.number} ${e.title}`, params.search));
    if (params?.filters?.type) items = items.filter((e) => e.type === params.filters!.type);
    if (params?.filters?.status) items = items.filter((e) => e.status === params.filters!.status);
    // 2h-F1 fix (round 4): honour reference_id server-side (mock equivalent).
    if (params?.filters?.reference_id) items = items.filter((e) => e.reference_id === params.filters!.reference_id);
    return paginate(items, params);
  }
  async getDocumentRegisterEntry(id: string, tenantId?: string): Promise<DocumentRegisterEntry | null> {
    const row = mock.documentRegister.find((e) => e.id === id && (!tenantId || e.tenant_id === tenantId));
    return row || null;
  }
  async getMaxDocumentRegisterVersion(tenantId: string, referenceId: string, type: string): Promise<number> {
    const rows = mock.documentRegister.filter((e) => e.tenant_id === tenantId && e.reference_id === referenceId && e.type === type);
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((r) => Number(r.version) || 0));
  }
  async upsertDocumentRegisterEntry(e: Partial<DocumentRegisterEntry> & { id?: string }): Promise<DocumentRegisterEntry> {
    const existing = e.id ? mock.documentRegister.find((x) => x.id === e.id) : null;
    if (existing) { Object.assign(existing, e, { updated_at: new Date().toISOString() }); return existing; }
    const newE: DocumentRegisterEntry = {
      id: e.id || mock.nid("dr_"), number: e.number || "", type: e.type || "other", version: e.version ?? 1,
      reference_id: e.reference_id || null, partner_id: e.partner_id || null, title: e.title || "",
      status: e.status || "current", created_by: e.created_by || null, metadata: e.metadata || null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.documentRegister.push(newE); return newE;
  }
  async listDocumentRevisions(tenantId: string, documentId: string): Promise<DocumentRevision[]> {
    return mock.documentRevisions.filter((r) => r.document_id === documentId && r.tenant_id === tenantId);
  }
  async addDocumentRevision(r: Partial<DocumentRevision> & { id?: string }): Promise<DocumentRevision> {
    const newR: DocumentRevision = {
      id: r.id || mock.nid("rev_"), document_id: r.document_id || "", version: r.version ?? 1,
      change_note: r.change_note || "", created_by: r.created_by || null, created_at: new Date().toISOString(),
    };
    mock.documentRevisions.push(newR); return newR;
  }
  async deleteDocumentRegisterEntry(id: string): Promise<void> {
    const idx = mock.documentRegister.findIndex((e) => e.id === id); if (idx >= 0) mock.documentRegister.splice(idx, 1);
  }

  // ---- vault ----
  async listVault(_tenantId: string, params?: ListParams): Promise<ListResult<VaultSecret>> {
    let items = [...mock.vaultSecrets];
    if (params?.search) items = items.filter((s) => matchesSearch(`${s.key} ${s.description || ""}`, params.search));
    if (params?.filters?.category) items = items.filter((s) => s.category === params.filters!.category);
    return paginate(items, params);
  }
  async upsertVaultSecret(s: Partial<VaultSecret> & { id?: string }): Promise<VaultSecret> {
    const existing = s.id ? mock.vaultSecrets.find((x) => x.id === s.id) : null;
    if (existing) { Object.assign(existing, s, { updated_at: new Date().toISOString() }); return existing; }
    const newS: VaultSecret = {
      id: s.id || mock.nid("vs_"), key: s.key || "", description: s.description || null,
      encrypted_value: s.encrypted_value || "", category: s.category || "other",
      last_accessed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.vaultSecrets.push(newS); return newS;
  }
  async deleteVaultSecret(id: string): Promise<void> {
    const idx = mock.vaultSecrets.findIndex((s) => s.id === id); if (idx >= 0) mock.vaultSecrets.splice(idx, 1);
  }

  // ---- api keys ----
  async listApiKeys(_tenantId: string): Promise<ApiKey[]> { return [...mock.apiKeys]; }
  async upsertApiKey(k: Partial<ApiKey> & { id?: string }): Promise<ApiKey> {
    const existing = k.id ? mock.apiKeys.find((x) => x.id === k.id) : null;
    if (existing) { Object.assign(existing, k); return existing; }
    const prefix = "asp_" + (k.name || "key").toLowerCase().replace(/\s+/g, "_").slice(0, 8) + "_";
    const newK: ApiKey = {
      id: k.id || mock.nid("ak_"), name: k.name || "API Key", key_prefix: prefix,
      key_hash: "hash_" + Date.now(), permissions: k.permissions || [], last_used_at: null,
      last_used_ip: null, active: k.active ?? true, expires_at: k.expires_at || null,
      created_at: new Date().toISOString(),
    };
    mock.apiKeys.push(newK); return newK;
  }
  async deleteApiKey(id: string): Promise<void> {
    const idx = mock.apiKeys.findIndex((k) => k.id === id); if (idx >= 0) mock.apiKeys.splice(idx, 1);
  }
  async authenticateApiKey(_rawKey: string): Promise<{ apiKey: ApiKey; tenantId: string } | null> { return null; }
  async updateApiKeyLastUsed(_id: string, _ip: string): Promise<void> {}

  // ---- webhooks ----
  async listWebhooks(_tenantId: string): Promise<Webhook[]> { return [...mock.webhooks]; }
  async upsertWebhook(w: Partial<Webhook> & { id?: string }): Promise<Webhook> {
    const existing = w.id ? mock.webhooks.find((x) => x.id === w.id) : null;
    if (existing) { Object.assign(existing, w); return existing; }
    const newW: Webhook = {
      id: w.id || mock.nid("wh_"), name: w.name || "Webhook", url: w.url || "",
      events: w.events || [], secret: "whsec_" + Math.random().toString(36).slice(2),
      last_triggered_at: null, last_status: null, active: w.active ?? true,
      created_at: new Date().toISOString(),
    };
    mock.webhooks.push(newW); return newW;
  }
  async deleteWebhook(id: string): Promise<void> {
    const idx = mock.webhooks.findIndex((w) => w.id === id); if (idx >= 0) mock.webhooks.splice(idx, 1);
  }
  async getWebhookById(id: string, _tenantId?: string): Promise<Webhook | null> {
    return mock.webhooks.find((w) => w.id === id) || null;
  }

  // ---- webhook deliveries (no-op stubs — MockStore has no DB to persist to) ----
  async createWebhookDelivery(_d: any): Promise<any> {
    return { id: "whd_" + Math.random().toString(36).slice(2), status: "pending", attempts: 0, ..._d, created_at: new Date().toISOString() };
  }
  async updateWebhookDelivery(_id: string, _patch: any): Promise<void> { /* no-op */ }
  async listWebhookDeliveries(_tenantId: string, _webhookId?: string, _limit?: number): Promise<any[]> { return []; }
  async listFailedWebhookDeliveries(_limit?: number): Promise<any[]> { return []; }
  async getWebhookDelivery(_id: string): Promise<any | null> { return null; }

  // ---- security ----
  async listSessions(_tenantId: string, userId?: string): Promise<SecuritySession[]> {
    return userId ? mock.securitySessions.filter((s) => s.user_id === userId) : [...mock.securitySessions];
  }
  async revokeSession(id: string): Promise<void> {
    const s = mock.securitySessions.find((x) => x.id === id); if (s) s.revoked = true;
  }
  async listLoginHistory(_tenantId: string, userId?: string, limit?: number): Promise<LoginHistoryEntry[]> {
    let items = userId ? mock.loginHistory.filter((l) => l.user_id === userId) : [...mock.loginHistory];
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return limit ? items.slice(0, limit) : items;
  }
  async listKnownIps(_tenantId: string, userId?: string): Promise<KnownIp[]> {
    return userId ? mock.knownIps.filter((i) => i.user_id === userId) : [...mock.knownIps];
  }
  async trustIp(id: string, trusted: boolean): Promise<void> {
    const ip = mock.knownIps.find((i) => i.id === id); if (ip) ip.trusted = trusted;
  }
  async forgetIp(id: string): Promise<void> {
    const idx = mock.knownIps.findIndex((i) => i.id === id); if (idx >= 0) mock.knownIps.splice(idx, 1);
  }
  async listTrustedDevices(_tenantId: string, userId?: string): Promise<TrustedDevice[]> {
    return userId ? mock.trustedDevices.filter((d) => d.user_id === userId) : [...mock.trustedDevices];
  }
  async revokeTrustedDevice(id: string): Promise<void> {
    const d = mock.trustedDevices.find((x) => x.id === id); if (d) d.revoked = true;
  }

  // ---- mail queue ----
  async listMailQueue(_tenantId: string, params?: ListParams): Promise<ListResult<MailQueueEntry>> {
    let items = [...mock.mailQueue].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (params?.search) items = items.filter((m) => matchesSearch(`${m.subject} ${m.to_email}`, params.search));
    if (params?.filters?.status) items = items.filter((m) => m.status === params.filters!.status);
    return paginate(items, params);
  }
  async upsertMailQueueEntry(m: Partial<MailQueueEntry> & { id?: string }): Promise<MailQueueEntry> {
    const existing = m.id ? mock.mailQueue.find((x) => x.id === m.id) : null;
    if (existing) { Object.assign(existing, m); return existing; }
    const newM: MailQueueEntry = {
      id: m.id || mock.nid("mq_"), to_email: m.to_email || "", subject: m.subject || "",
      body: m.body || "", status: m.status || "queued", attempts: 0, error: null,
      sent_at: null, created_at: new Date().toISOString(),
    };
    mock.mailQueue.push(newM); return newM;
  }
  async deleteMailQueueEntry(id: string): Promise<void> {
    const idx = mock.mailQueue.findIndex((m) => m.id === id); if (idx >= 0) mock.mailQueue.splice(idx, 1);
  }

  // ---- all inventory (for global view) ----
  async listAllInventory(_tenantId: string, params?: ListParams): Promise<ListResult<InventoryMovement>> {
    let items = [...mock.inventoryMovements].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (params?.filters?.partner_id) items = items.filter((m) => m.partner_id === params.filters!.partner_id);
    if (params?.filters?.product_id) items = items.filter((m) => m.product_id === params.filters!.product_id);
    return paginate(items, params);
  }

  // FIX-MARKET-UI / FIX 4 — products at or below reorder level.
  async listLowStockProducts(_tenantId: string, params?: ListParams): Promise<ListResult<Product>> {
    let items = mock.products.filter(
      (p) => (p.reorder_level || 0) > 0 && (p.stock || 0) <= (p.reorder_level || 0),
    );
    items.sort((a, b) => (a.stock || 0) - (b.stock || 0));
    return paginate(items, params);
  }

  // ---- tenants ----
  async listTenants(): Promise<Tenant[]> { return [...mock.tenants]; }
  async getTenant(id: string): Promise<Tenant | null> { return mock.tenants.find((t) => t.id === id) || null; }
  async upsertTenant(t: Partial<Tenant> & { id?: string }): Promise<Tenant> {
    const existing = t.id ? mock.tenants.find((x) => x.id === t.id) : null;
    if (existing) { Object.assign(existing, t, { updated_at: new Date().toISOString() }); return existing; }
    const newT: Tenant = {
      id: t.id || mock.nid("t_"), name: t.name || "New Tenant", legal_name: t.legal_name || null,
      country: t.country || null, currency: t.currency || "USD", tax_id: t.tax_id || null,
      vat_number: t.vat_number || null, registration_number: t.registration_number || null,
      address_line: t.address_line || null, city: t.city || null, postal_code: t.postal_code || null,
      bank_name: t.bank_name || null, bank_iban: t.bank_iban || null, bank_swift: t.bank_swift || null,
      logo_url: null, primary_color: t.primary_color || null,
      plan: t.plan || "trial", status: t.status || "active", max_users: t.max_users ?? 10,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.tenants.push(newT); return newT;
  }
  // P3 / task C-8 — atomic tenant status transition. The mock store is
  // single-threaded (no real concurrency), so the atomicity guarantee
  // trivially holds: we check + update in the same synchronous block.
  // The `fromStatuses.includes(current.status)` gate mirrors the SQL
  // `.in("status", fromStatuses)` filter so the mock behaves identically
  // to the supabase store for tests / preview.
  async atomicTenantStatusTransition(
    tenantId: string,
    fromStatuses: string[],
    toStatus: string,
    patch?: Partial<Tenant>,
  ): Promise<Tenant | null> {
    const existing = mock.tenants.find((t) => t.id === tenantId);
    if (!existing) return null;
    if (!fromStatuses.includes(existing.status)) return null;
    const { id: _id, tenant_id: _tid, created_at: _ca, updated_at: _ua, status: _s, ...rest } = patch ?? ({} as Partial<Tenant>);
    void _id; void _tid; void _ca; void _ua; void _s;
    Object.assign(existing, rest, { status: toStatus, updated_at: new Date().toISOString() });
    return existing;
  }
  async deleteTenant(id: string): Promise<void> {
    const idx = mock.tenants.findIndex((t) => t.id === id); if (idx >= 0) mock.tenants.splice(idx, 1);
  }
  // AUDIT19 / F4 — atomic document status transition (mock equivalent of
  // supabase-store's atomicDocStatusTransition). Single-threaded: the
  // check + update run in the same synchronous block, mirroring the SQL
  // `.in("status", fromStatuses)` conditional-update semantics for tests.
  async atomicDocStatusTransition(
    table: "offers" | "invoices" | "proformas" | "lois",
    id: string,
    fromStatuses: string[],
    toStatus: string,
    patch?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const storeMap: Record<string, any[]> = {
      offers: mock.offers,
      invoices: mock.invoices,
      proformas: mock.proformas,
      // The mock store does not implement LOI persistence (listLois/getLoi
      // throw mockUnsupported) — treat it as an empty collection so the
      // transition returns null ("not found") instead of crashing.
      lois: [],
    };
    const rows = storeMap[table];
    if (!rows) return null;
    const existing = rows.find((r: any) => r.id === id);
    if (!existing) return null;
    if (!fromStatuses.includes(existing.status)) return null;
    const safePatch = { ...(patch ?? {}) };
    delete safePatch.id;
    delete safePatch.tenant_id;
    delete safePatch.created_at;
    delete safePatch.updated_at;
    delete safePatch.status;
    Object.assign(existing, safePatch, { status: toStatus, updated_at: new Date().toISOString() });
    return existing as Record<string, unknown>;
  }
  // P0 / task C-1 — mock-store stubs. The mock store has no orphan-row
  // problem (it deletes by array filter), so these are no-ops / counters
  // that let the tenant / user DELETE routes call them unconditionally
  // across all store implementations.
  async countTenantDependencies(
    _tenantId: string,
  ): Promise<Record<string, number> & { total: number }> {
    return { total: 0 };
  }
  async deleteTenantCascade(_tenantId: string): Promise<void> {}
  async deleteUserCascade(_userId: string): Promise<void> {}

  // ---- product catalog ----
  async listProductCatalog(tenantId: string, params?: ListParams): Promise<ListResult<ProductCatalogEntry>> {
    let items = mock.productCatalog.filter((p) => p.tenant_id === tenantId);
    if (params?.search) items = items.filter((p) => matchesSearch(`${p.name} ${p.hs_code || ""}`, params.search));
    if (params?.filters?.category) items = items.filter((p) => p.category === params.filters!.category);
    return paginate(items, params);
  }
  async getProductCatalogEntry(id: string): Promise<ProductCatalogEntry | null> {
    return mock.productCatalog.find((p) => p.id === id) || null;
  }
  async upsertProductCatalogEntry(p: Partial<ProductCatalogEntry> & { id?: string }): Promise<ProductCatalogEntry> {
    const existing = p.id ? mock.productCatalog.find((x) => x.id === p.id) : null;
    if (existing) { Object.assign(existing, p, { updated_at: new Date().toISOString() }); return existing; }
    const newP: ProductCatalogEntry = {
      id: p.id || mock.nid("pc_"), tenant_id: p.tenant_id || "", name: p.name || "New Product",
      category: p.category || "OTHER", hs_code: p.hs_code || null, description: p.description || null,
      base_unit: p.base_unit || "MT", specifications: p.specifications || null,
      origin_country: p.origin_country || null, images: null, active: p.active ?? true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.productCatalog.push(newP); return newP;
  }
  async deleteProductCatalogEntry(id: string): Promise<void> {
    const idx = mock.productCatalog.findIndex((p) => p.id === id); if (idx >= 0) mock.productCatalog.splice(idx, 1);
  }

  // ---- supplier offers ----
  async listSupplierOffers(tenantId: string, params?: ListParams): Promise<ListResult<SupplierOffer>> {
    let items = mock.supplierOffers.filter((s) => s.tenant_id === tenantId);
    if (params?.search) items = items.filter((s) => matchesSearch(`${s.offer_number || ""} ${s.packaging || ""}`, params.search));
    if (params?.filters?.product_id) items = items.filter((s) => s.product_id === params.filters!.product_id);
    if (params?.filters?.supplier_id) items = items.filter((s) => s.supplier_id === params.filters!.supplier_id);
    if (params?.filters?.status) items = items.filter((s) => s.status === params.filters!.status);
    return paginate(items, params);
  }
  async getSupplierOffer(id: string): Promise<SupplierOffer | null> {
    return mock.supplierOffers.find((s) => s.id === id) || null;
  }
  async upsertSupplierOffer(s: Partial<SupplierOffer> & { id?: string }): Promise<SupplierOffer> {
    const existing = s.id ? mock.supplierOffers.find((x) => x.id === s.id) : null;
    if (existing) { Object.assign(existing, s, { updated_at: new Date().toISOString() }); return existing; }
    const newS: SupplierOffer = {
      id: s.id || mock.nid("so_"), tenant_id: s.tenant_id || "", product_id: s.product_id || "",
      supplier_id: s.supplier_id || "", offer_number: s.offer_number || null, status: s.status || "active",
      unit_price: s.unit_price ?? 0, currency: s.currency || "USD", min_order_qty: s.min_order_qty || null,
      price_valid_until: s.price_valid_until || null, packaging: s.packaging || null,
      packing_details: s.packing_details || null, loadability: s.loadability || null,
      specification_notes: s.specification_notes || null, origin_country: s.origin_country || null,
      incoterm: s.incoterm || "FOB", loading_port: s.loading_port || null, delivery_port: s.delivery_port || null,
      lead_time_days: s.lead_time_days || null, payment_terms: s.payment_terms || null,
      inspection: s.inspection || null, certificate: s.certificate || null, notes: s.notes || null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.supplierOffers.push(newS); return newS;
  }
  async deleteSupplierOffer(id: string): Promise<void> {
    const idx = mock.supplierOffers.findIndex((s) => s.id === id); if (idx >= 0) mock.supplierOffers.splice(idx, 1);
  }

  // ---- trade calculations ----
  async listTradeCalculations(tenantId: string, params?: ListParams): Promise<ListResult<TradeCalculation>> {
    let items = mock.tradeCalculations.filter((t) => t.tenant_id === tenantId);
    if (params?.search) items = items.filter((t) => matchesSearch(t.name, params.search));
    return paginate(items, params);
  }
  async getTradeCalculation(id: string): Promise<TradeCalculation | null> {
    return mock.tradeCalculations.find((t) => t.id === id) || null;
  }
  async upsertTradeCalculation(t: Partial<TradeCalculation> & { id?: string }): Promise<TradeCalculation> {
    const existing = t.id ? mock.tradeCalculations.find((x) => x.id === t.id) : null;
    if (existing) { Object.assign(existing, t, { updated_at: new Date().toISOString() }); return existing; }
    const newT: TradeCalculation = {
      id: t.id || mock.nid("tc_"), tenant_id: t.tenant_id || "", name: t.name || "New Calculation",
      product_id: t.product_id || null, supplier_offer_id: t.supplier_offer_id || null,
      supplier_id: t.supplier_id || null, buyer_id: t.buyer_id || null,
      quantity: t.quantity ?? 0, unit: t.unit || "MT", num_containers: t.num_containers ?? 1,
      container_type: t.container_type || null,
      buy_price_per_unit: t.buy_price_per_unit ?? 0, buy_currency: t.buy_currency || "USD", buy_incoterm: t.buy_incoterm || "FOB",
      sell_price_per_unit: t.sell_price_per_unit ?? 0, sell_currency: t.sell_currency || "USD", sell_incoterm: t.sell_incoterm || "CIF",
      transport_mode: t.transport_mode || "SEA", loading_port: t.loading_port || null, delivery_port: t.delivery_port || null,
      exchange_rate: t.exchange_rate ?? 1, cost_lines: t.cost_lines || [],
      total_buy_cost: t.total_buy_cost ?? 0, total_landed_cost: t.total_landed_cost ?? 0,
      total_sell_revenue: t.total_sell_revenue ?? 0, gross_margin: t.gross_margin ?? 0, margin_percent: t.margin_percent ?? 0,
      created_by: t.created_by || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.tradeCalculations.push(newT); return newT;
  }
  async deleteTradeCalculation(id: string): Promise<void> {
    const idx = mock.tradeCalculations.findIndex((t) => t.id === id); if (idx >= 0) mock.tradeCalculations.splice(idx, 1);
  }

  // ---- portal access ----
  async getPortalAccessByPartner(partnerId: string): Promise<PortalAccess | null> {
    return mock.portalAccess.find((p) => p.partner_id === partnerId) || null;
  }
  // AUDIT16 — portal rows created through the API layer (portal-access
  // POST, KYC automation) store portal_email ENCRYPTED + portal_email_hmac.
  // Equality lookups must match via the HMAC token too, or those rows are
  // unfindable (login/duplicate-check silently broken in mock/dev flows).
  // Mirrors the SupabaseStore lookup strategy (see its 2126-2319 block).
  private matchPortalEmail(p: PortalAccess, email: string): boolean {
    if (p.portal_email === email) return true;
    const hmac = (p as any).portal_email_hmac as string | undefined;
    return !!hmac && hmac === hmacField(email);
  }
  async getPortalAccessByEmail(tenantId: string, email: string): Promise<PortalAccess | null> {
    return mock.portalAccess.find((p) => p.tenant_id === tenantId && this.matchPortalEmail(p, email)) || null;
  }
  async getPortalAccessById(id: string): Promise<PortalAccess | null> {
    return mock.portalAccess.find((p) => p.id === id) || null;
  }
  async listPortalAccess(tenantId: string): Promise<PortalAccess[]> {
    return mock.portalAccess.filter((p) => p.tenant_id === tenantId);
  }
  async upsertPortalAccess(p: Partial<PortalAccess> & { id?: string }): Promise<PortalAccess> {
    const existing = p.id ? mock.portalAccess.find((x) => x.id === p.id) : null;
    if (existing) { Object.assign(existing, p, { updated_at: new Date().toISOString() }); return existing; }
    const tier = p.tier || "standard";
    const newP: PortalAccess = {
      id: p.id || mock.nid("pa_"), partner_id: p.partner_id || "", tenant_id: p.tenant_id || "",
      tier,
      can_view_offers: p.can_view_offers ?? true, can_view_documents: p.can_view_documents ?? true,
      can_view_catalog: p.can_view_catalog ?? true, can_view_invoices: p.can_view_invoices ?? false,
      can_view_profile: p.can_view_profile ?? true, can_view_company_info: p.can_view_company_info ?? true,
      can_submit_rfq: p.can_submit_rfq ?? true, can_download_pdf: p.can_download_pdf ?? true,
      exempt_kyc: p.exempt_kyc ?? (tier === "premium"),
      exempt_document_upload: p.exempt_document_upload ?? (tier === "premium"),
      exempt_location_share: p.exempt_location_share ?? (tier === "premium"),
      // GPS verification — populated by /api/portal/log-location when
      // source === "browser". Optional on PortalAccess; defaults to null
      // for newly-created rows until the client shares location.
      gps_verified_at: p.gps_verified_at ?? null,
      status: p.status || "pending_approval", approved_by: p.approved_by || null,
      approved_at: p.approved_at || null, invited_at: p.invited_at || null,
      welcome_email_sent: p.welcome_email_sent ?? false,
      // AUDIT16 — persist the HMAC search token on CREATE (the explicit
      // field list used to drop it, breaking lookups for encrypted rows).
      portal_email: p.portal_email || null, portal_email_hmac: (p as any).portal_email_hmac ?? null,
      password_hash: p.password_hash || null,
      must_set_password: p.must_set_password ?? true, last_login_at: null, last_login_ip: null,
      failed_attempts: 0, locked_until: null, token_version: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.portalAccess.push(newP); return newP;
  }
  async deletePortalAccess(id: string): Promise<void> {
    const idx = mock.portalAccess.findIndex((p) => p.id === id); if (idx >= 0) mock.portalAccess.splice(idx, 1);
  }
  async verifyPortalCredentials(tenantId: string, email: string, password: string): Promise<PortalAccess | null> {
    const pa = mock.portalAccess.find((p) => p.tenant_id === tenantId && this.matchPortalEmail(p, email) && p.password_hash);
    if (!pa) return null;
    if (pa.status !== "active") return null;
    if (pa.password_hash === mock.mockHash(password)) {
      pa.last_login_at = new Date().toISOString();
      return pa;
    }
    return null;
  }

  async verifyPortalCredentialsByEmail(email: string, password: string): Promise<PortalAccess | null> {
    const pa = mock.portalAccess.find((p) => this.matchPortalEmail(p, email) && p.password_hash);
    if (!pa) return null;
    if (pa.status !== "active") return null;
    if (pa.password_hash === mock.mockHash(password)) {
      pa.last_login_at = new Date().toISOString();
      return pa;
    }
    return null;
  }
  async getPortalAccessByEmailAnyTenant(email: string): Promise<PortalAccess | null> {
    return mock.portalAccess.find((p) => this.matchPortalEmail(p, email)) || null;
  }
  async listPortalAccessByEmail(email: string): Promise<PortalAccess[]> {
    return mock.portalAccess.filter((p) => this.matchPortalEmail(p, email));
  }

  // ---- document templates ----
  async listDocumentTemplates(tenantId: string): Promise<DocumentTemplate[]> {
    return mock.documentTemplates.filter((t) => t.tenant_id === tenantId);
  }
  async getDocumentTemplate(id: string): Promise<DocumentTemplate | null> {
    return mock.documentTemplates.find((t) => t.id === id) || null;
  }
  async getDefaultDocumentTemplate(tenantId: string, type: string): Promise<DocumentTemplate | null> {
    const existing =
      mock.documentTemplates.find((t) => t.tenant_id === tenantId && t.type === type && t.is_default) || null;
    if (existing) return existing;
    // Fall back to any default template of any type.
    const anyDefault =
      mock.documentTemplates.find((t) => t.tenant_id === tenantId && t.is_default) || null;
    if (anyDefault) return anyDefault;
    // Auto-create starter templates when the tenant has none at all.
    try {
      const allTemplates = mock.documentTemplates.filter((t) => t.tenant_id === tenantId);
      if (allTemplates.length === 0) {
        await ensureStarterTemplates(tenantId, this);
        return (
          mock.documentTemplates.find((t) => t.tenant_id === tenantId && t.type === type && t.is_default) ||
          mock.documentTemplates.find((t) => t.tenant_id === tenantId && t.is_default) ||
          null
        );
      }
    } catch (autoErr) {
      console.warn("[getDefaultDocumentTemplate] Starter auto-create error:", autoErr);
    }
    return null;
  }
  async upsertDocumentTemplate(t: Partial<DocumentTemplate> & { id?: string }): Promise<DocumentTemplate> {
    const existing = t.id ? mock.documentTemplates.find((x) => x.id === t.id) : null;
    // audit20 / 20-b — mirror the prisma/supabase stores: keep the "one
    // default per (tenant, type)" invariant. Without this, repeated "set as
    // default" saves stacked multiple is_default=true rows, and the default
    // lookup silently returned whichever duplicate came first. The row being
    // promoted (t.id) is never cleared.
    if (t.is_default === true) {
      const tenantId = t.tenant_id ?? existing?.tenant_id;
      const type = t.type ?? existing?.type;
      if (tenantId && type) {
        for (const row of mock.documentTemplates) {
          if (row.tenant_id === tenantId && row.type === type && row.is_default && row.id !== t.id) {
            row.is_default = false;
          }
        }
      }
    }
    if (existing) { Object.assign(existing, t, { updated_at: new Date().toISOString() }); return existing; }
    const newT: DocumentTemplate = {
      id: t.id || mock.nid("dt_"), tenant_id: t.tenant_id || "", name: t.name || "New Template",
      type: t.type || "generic", is_default: t.is_default ?? false,
      page_size: t.page_size || "A4",
      page_margin_top: t.page_margin_top ?? 25, page_margin_bottom: t.page_margin_bottom ?? 25,
      page_margin_left: t.page_margin_left ?? 20, page_margin_right: t.page_margin_right ?? 20,
      header_enabled: t.header_enabled ?? true, header_height: t.header_height ?? 20,
      header_content: t.header_content || "", header_show_logo: t.header_show_logo ?? true,
      header_show_company_name: t.header_show_company_name ?? true, header_show_contact: t.header_show_contact ?? true,
      footer_enabled: t.footer_enabled ?? true, footer_height: t.footer_height ?? 15,
      footer_content: t.footer_content || "", footer_show_page_number: t.footer_show_page_number ?? true,
      footer_show_bank_details: t.footer_show_bank_details ?? true, footer_show_tax_id: t.footer_show_tax_id ?? true,
      body_font_family: t.body_font_family || "Inter", body_font_size: t.body_font_size ?? 11, body_line_height: t.body_line_height ?? 1.5,
      primary_color: t.primary_color || "#0f766e", accent_color: t.accent_color || "#0d9488",
      table_header_bg: t.table_header_bg || "#0f766e", table_header_color: t.table_header_color || "#ffffff",
      table_border_color: t.table_border_color || "#e5e7eb", table_stripe: t.table_stripe ?? true,
      // Linked branding assets — audit20 / 20-b: these were silently dropped
      // on CREATE here (the update path kept them via Object.assign, the
      // real stores persisted them), so mock-backed flows lost the
      // letterhead/seal link + bank-account selection on every first save.
      letterhead_id: t.letterhead_id ?? null, seal_id: t.seal_id ?? null,
      seal_enabled: t.seal_enabled ?? true,
      selected_bank_accounts: t.selected_bank_accounts ?? null,
      // audit22 "Template Studio" — extended styling + visual layout blobs
      style_json: t.style_json ?? null, layout_json: t.layout_json ?? null,
      created_by: t.created_by || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.documentTemplates.push(newT); return newT;
  }
  async deleteDocumentTemplate(id: string): Promise<void> {
    const idx = mock.documentTemplates.findIndex((t) => t.id === id); if (idx >= 0) mock.documentTemplates.splice(idx, 1);
  }

  // ---- document verification ----
  async createDocumentVerification(v: any): Promise<DocumentVerification> {
    const newV: DocumentVerification = {
      ...v, id: mock.nid("dv_"), verification_count: 0, last_verified_at: null, last_verified_ip: null,
      status: (v.status as any) || "active", created_at: new Date().toISOString(),
    };
    mock.documentVerifications.push(newV); return newV;
  }
  async getDocumentVerificationByCode(code: string): Promise<DocumentVerification | null> {
    return mock.documentVerifications.find((v) => v.verification_code === code) || null;
  }
  async getDocumentVerificationByDoc(tenantId: string, docType: string, docId: string): Promise<DocumentVerification | null> {
    return mock.documentVerifications.find((v) => v.tenant_id === tenantId && v.document_type === docType && v.document_id === docId) || null;
  }
  async updateDocumentVerificationHash(id: string, pdfHash: string, pdfSize: number): Promise<DocumentVerification | null> {
    const v = mock.documentVerifications.find((x) => x.id === id);
    if (!v) return null;
    (v as any).pdf_hash = pdfHash;
    (v as any).pdf_size = pdfSize;
    return v;
  }
  async logVerification(log: Omit<VerificationLog, "id" | "verified_at">): Promise<VerificationLog> {
    // increment verification count
    const v = mock.documentVerifications.find((x) => x.id === log.verification_id);
    if (v) { v.verification_count += 1; v.last_verified_at = new Date().toISOString(); v.last_verified_ip = log.ip; }
    return { ...log, id: mock.nid("vl_"), verified_at: new Date().toISOString() };
  }
  async listVerificationLogs(_verificationId: string): Promise<VerificationLog[]> {
    return [];
  }

  // ---- KYC submissions ----
  async listKycSubmissions(tenantId: string, params?: ListParams): Promise<ListResult<KycSubmission>> {
    let items = mock.kycSubmissions.filter((k) => k.tenant_id === tenantId);
    if (params?.search) items = items.filter((k) => matchesSearch(`${k.legal_name || ""} ${k.contact_name || ""}`, params.search));
    if (params?.filters?.status) items = items.filter((k) => k.status === params.filters!.status);
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return paginate(items, params);
  }
  async getKycSubmission(id: string): Promise<KycSubmission | null> {
    return mock.kycSubmissions.find((k) => k.id === id) || null;
  }
  async getKycSubmissionByPartner(partnerId: string): Promise<KycSubmission | null> {
    return mock.kycSubmissions.find((k) => k.partner_id === partnerId) || null;
  }
  async upsertKycSubmission(s: Partial<KycSubmission> & { id?: string }): Promise<KycSubmission> {
    const existing = s.id ? mock.kycSubmissions.find((x) => x.id === s.id) : null;
    if (existing) { Object.assign(existing, s, { updated_at: new Date().toISOString() }); return existing; }
    const newS: KycSubmission = {
      id: s.id || mock.nid("kyc_"), tenant_id: s.tenant_id || "", partner_id: s.partner_id || "",
      portal_access_id: s.portal_access_id || null, status: s.status || "draft",
      entity_type: s.entity_type || "company",
      legal_name: s.legal_name || null, trade_name: s.trade_name || null,
      registration_number: s.registration_number || null, tax_id: s.tax_id || null,
      vat_number: s.vat_number || null, company_website: s.company_website || null,
      address_line: s.address_line || null, city: s.city || null, state: s.state || null,
      postal_code: s.postal_code || null, country: s.country || null,
      contact_name: s.contact_name || null, contact_email: s.contact_email || null,
      contact_phone: s.contact_phone || null, contact_position: s.contact_position || null,
      owner_name: s.owner_name || null, owner_id_type: s.owner_id_type || null,
      owner_id_number: s.owner_id_number || null, owner_nationality: s.owner_nationality || null,
      owner_dob: s.owner_dob || null, owner_address: s.owner_address || null,
      business_activity: s.business_activity || null, expected_monthly_volume: s.expected_monthly_volume || null,
      source_of_funds: s.source_of_funds || null,
      bank_name: s.bank_name || null, bank_account: s.bank_account || null,
      bank_iban: s.bank_iban || null, bank_swift: s.bank_swift || null,
      documents: s.documents || [],
      reviewed_by: null, reviewed_at: null, review_notes: null, rejection_reason: null,
      auto_transferred: false, submitted_at: s.submitted_at || null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.kycSubmissions.push(newS); return newS;
  }
  async deleteKycSubmission(id: string): Promise<void> {
    const idx = mock.kycSubmissions.findIndex((k) => k.id === id); if (idx >= 0) mock.kycSubmissions.splice(idx, 1);
  }
  async addKycDocument(doc: Omit<KycDocument, "id" | "uploaded_at">): Promise<KycDocument> {
    const newD: KycDocument = { ...doc, id: mock.nid("kd_"), uploaded_at: new Date().toISOString() };
    const sub = mock.kycSubmissions.find((k) => k.id === doc.submission_id);
    if (sub) sub.documents.push(newD);
    return newD;
  }
  async removeKycDocument(id: string): Promise<void> {
    for (const sub of mock.kycSubmissions) {
      const idx = sub.documents.findIndex((d) => d.id === id);
      if (idx >= 0) { sub.documents.splice(idx, 1); return; }
    }
  }

  // KEY AUTOMATION: approve KYC + auto-transfer data to partner record
  async approveKycAndTransfer(submissionId: string, reviewedBy: string): Promise<{ submission: KycSubmission; partner: Partner }> {
    const sub = mock.kycSubmissions.find((k) => k.id === submissionId);
    if (!sub) throw new Error("KYC submission not found");

    // Mark submission as approved
    sub.status = "approved";
    sub.reviewed_by = reviewedBy;
    sub.reviewed_at = new Date().toISOString();
    sub.auto_transferred = true;
    sub.updated_at = new Date().toISOString();

    // Auto-transfer data to partner record
    const partner = mock.partners.find((p) => p.id === sub.partner_id);
    if (partner) {
      partner.entity_type = sub.entity_type;
      if (sub.legal_name) partner.name = sub.legal_name;
      if (sub.registration_number) partner.registration_number = sub.registration_number;
      if (sub.address_line) partner.address_line = sub.address_line;
      if (sub.city) partner.city = sub.city;
      if (sub.state) partner.state = sub.state;
      if (sub.postal_code) partner.postal_code = sub.postal_code;
      if (sub.country) partner.country = sub.country;
      if (sub.contact_name) partner.contact_name = sub.contact_name;
      // AUDIT16 / P0-3 — encrypt PII on transfer, mirroring SupabaseStore
      // (the partners API layer encrypts on every write; this store path
      // used to be the only plaintext one). Idempotent: a re-approve of the
      // SAME value keeps the existing ciphertext (no churn).
      const sameValue = (current: unknown, plain: string) => {
        if (typeof current !== "string" || !current) return false;
        return isEncrypted(current) ? decryptField(current) === plain : current === plain;
      };
      if (sub.contact_email && !sameValue(partner.contact_email, sub.contact_email)) {
        partner.contact_email = isEncrypted(sub.contact_email) ? sub.contact_email : encryptField(sub.contact_email);
      }
      if (sub.contact_phone && !sameValue(partner.contact_phone, sub.contact_phone)) {
        partner.contact_phone = isEncrypted(sub.contact_phone) ? sub.contact_phone : encryptField(sub.contact_phone);
      }
      if (sub.tax_id && !sameValue(partner.tax_id, sub.tax_id)) {
        partner.tax_id_hmac = hmacField(sub.tax_id);
        partner.tax_id = isEncrypted(sub.tax_id) ? sub.tax_id : encryptField(sub.tax_id);
      }
      if (sub.vat_number && !sameValue(partner.vat_number, sub.vat_number)) {
        partner.vat_number_hmac = hmacField(sub.vat_number);
        partner.vat_number = isEncrypted(sub.vat_number) ? sub.vat_number : encryptField(sub.vat_number);
      }
      if (sub.bank_name) partner.bank_name = sub.bank_name;
      if (sub.bank_account) partner.bank_account = sub.bank_account;
      if (sub.bank_iban) partner.bank_iban = sub.bank_iban;
      if (sub.bank_swift) partner.bank_swift = sub.bank_swift;
      partner.kyc_status = "approved";
      partner.kyc_reviewed_by = reviewedBy;
      partner.kyc_reviewed_at = new Date().toISOString();
      partner.updated_at = new Date().toISOString();
    }

    return { submission: sub, partner: partner as Partner };
  }

  // ---- portal RFQs ----
  async listPortalRfqs(tenantId: string, params?: ListParams): Promise<ListResult<PortalRfq>> {
    let items = mock.portalRfqs.filter((r) => r.tenant_id === tenantId);
    if (params?.search) items = items.filter((r) => matchesSearch(`${r.number} ${r.product_name}`, params.search));
    if (params?.filters?.status) items = items.filter((r) => r.status === params.filters!.status);
    if (params?.filters?.partner_id) items = items.filter((r) => r.partner_id === params.filters!.partner_id);
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return paginate(items, params);
  }
  async listPortalRfqsByPartner(partnerId: string): Promise<PortalRfq[]> {
    return mock.portalRfqs.filter((r) => r.partner_id === partnerId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async getPortalRfq(id: string): Promise<PortalRfq | null> {
    return mock.portalRfqs.find((r) => r.id === id) || null;
  }
  async upsertPortalRfq(r: Partial<PortalRfq> & { id?: string }): Promise<PortalRfq> {
    const existing = r.id ? mock.portalRfqs.find((x) => x.id === r.id) : null;
    if (existing) { Object.assign(existing, r, { updated_at: new Date().toISOString() }); return existing; }
    const num = `RFQ-2026-${String(mock.portalRfqs.length + 1).padStart(3, "0")}`;
    const newR: PortalRfq = {
      id: r.id || mock.nid("rfq_"), tenant_id: r.tenant_id || "", partner_id: r.partner_id || "",
      portal_access_id: r.portal_access_id || null, number: r.number || num, status: r.status || "pending",
      product_name: r.product_name || "", product_description: r.product_description || null,
      category: r.category || null, quantity: r.quantity ?? 0, unit: r.unit || "MT",
      target_price: r.target_price || null, currency: r.currency || "USD",
      delivery_country: r.delivery_country || null, delivery_port: r.delivery_port || null,
      delivery_date: r.delivery_date || null, incoterm: r.incoterm || null,
      specifications: r.specifications || null, notes: r.notes || null,
      linked_offer_id: null, linked_demand_id: null, admin_notes: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    mock.portalRfqs.push(newR); return newR;
  }
  async deletePortalRfq(id: string): Promise<void> {
    const idx = mock.portalRfqs.findIndex((r) => r.id === id); if (idx >= 0) mock.portalRfqs.splice(idx, 1);
  }

  // ---- feature flags ----
  async getFeatureFlags(tenantId: string): Promise<TenantFeatureFlags | null> {
    const existing = mock.featureFlags.find((f) => f.tenant_id === tenantId);
    if (existing) return existing;
    // Auto-create default flags if not exist
    return this.upsertFeatureFlags({ tenant_id: tenantId });
  }
  async upsertFeatureFlags(f: Partial<TenantFeatureFlags> & { tenant_id: string }): Promise<TenantFeatureFlags> {
    const existing = mock.featureFlags.find((x) => x.tenant_id === f.tenant_id);
    if (existing) {
      Object.assign(existing, f, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newF: TenantFeatureFlags = {
      id: mock.nid("ff_"), tenant_id: f.tenant_id,
      module_crm: f.module_crm ?? true,
      module_trade: f.module_trade ?? true,
      module_finance: f.module_finance ?? true,
      module_inventory: f.module_inventory ?? true,
      module_portal: f.module_portal ?? true,
      module_logistics: f.module_logistics ?? true,
      module_kyc: f.module_kyc ?? true,
      module_document_templates: f.module_document_templates ?? true,
      module_document_verification: f.module_document_verification ?? true,
      module_vault: f.module_vault ?? true,
      module_api_keys: f.module_api_keys ?? true,
      module_webhooks: f.module_webhooks ?? true,
      module_mail_queue: f.module_mail_queue ?? true,
      module_security: f.module_security ?? true,
      max_partners: f.max_partners ?? 0,
      max_users: f.max_users ?? 25,
      max_monthly_documents: f.max_monthly_documents ?? 0,
      beta_ai_assistant: f.beta_ai_assistant ?? false,
      beta_advanced_analytics: f.beta_advanced_analytics ?? false,
      updated_by: f.updated_by || null,
      updated_at: new Date().toISOString(),
    };
    mock.featureFlags.push(newF);
    return newF;
  }

  // ---- notifications ----
  async listNotifications(tenantId: string, userId?: string, unreadOnly?: boolean, limit?: number): Promise<Notification[]> {
    let items = mock.notifications.filter((n) => n.tenant_id === tenantId);
    if (userId) items = items.filter((n) => n.user_id === null || n.user_id === userId);
    if (unreadOnly) items = items.filter((n) => !n.read);
    return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async listNotificationsByPartner(tenantId: string, partnerId: string, limit?: number): Promise<Notification[]> {
    const PORTAL_SAFE_TYPES = new Set([
      "kyc_submitted", "kyc_approved", "kyc_rejected",
      "rfq_received", "rfq_quoted",
      "offer_sent", "offer_accepted", "offer_rejected", "offer_expired",
      "invoice_sent", "invoice_overdue", "invoice_paid",
      "proforma_sent",
      // BUILD-LOI-PORTAL — LOI sent to this partner.
      "loi_sent",
      "document_shared",
      "portal_access_requested", "portal_access_approved", "portal_invite_sent",
      "portal_message",
      // Marketplace (Phase 2) — negotiation rooms + offer notifications
      "marketplace_response_received",
      "marketplace_response_accepted",
      "marketplace_response_rejected",
      "marketplace_message_received",
    ]);
    // 2b2-F3 — push the limit into the query (mock: slice the in-memory list).
    const effectiveLimit = Math.min(Math.max(limit ?? 200, 1), 200);
    return mock.notifications
      .filter((n) => n.tenant_id === tenantId && n.partner_id === partnerId && PORTAL_SAFE_TYPES.has(n.type))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, effectiveLimit);
  }
  async createNotification(n: Omit<Notification, "id" | "created_at" | "read" | "read_at">): Promise<Notification> {
    const newN: Notification = {
      ...n, id: mock.nid("ntf_"), read: false, read_at: null, created_at: new Date().toISOString(),
    };
    mock.notifications.unshift(newN);
    return newN;
  }
  /**
   * 8c-10 — dedup probe (mock impl). Mirrors SupabaseStore.findRecentNotification:
   * scans the in-memory `mock.notifications` list for the most-recent row
   * matching (tenant, partner, type, entityType?, entityId?) whose
   * `created_at` falls within `windowMs` of now. Returns null when no
   * such row exists OR when the lookup throws (defensive — never block
   * the caller's insert on a degraded mock).
   */
  async findRecentNotification(
    tenantId: string,
    partnerId: string,
    type: NotificationType,
    entityType: string | null,
    entityId: string | null,
    windowMs: number,
  ): Promise<Notification | null> {
    try {
      const cutoff = Date.now() - windowMs;
      // In-memory scan; mock list is small so the linear walk is fine.
      // Sort by created_at desc (already the canonical mock ordering) and
      // return the first match within the recency window.
      const sorted = [...mock.notifications].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      for (const n of sorted) {
        if (n.tenant_id !== tenantId) continue;
        if (n.partner_id !== partnerId) continue;
        if (n.type !== type) continue;
        if (entityType && n.entity_type !== entityType) continue;
        if (entityId && n.entity_id !== entityId) continue;
        const createdMs = Date.parse(n.created_at);
        if (!Number.isFinite(createdMs)) continue;
        if (createdMs >= cutoff) return n;
        // The list is sorted desc by created_at — once we hit a row
        // older than the cutoff, all subsequent rows are also older.
        break;
      }
      return null;
    } catch (e) {
      console.warn("[MockStore.findRecentNotification] lookup failed:", e);
      return null;
    }
  }
  async markNotificationRead(id: string, tenantId: string): Promise<void> {
    // CRITICAL FIX (audit A3): add tenant filter to prevent cross-tenant
    // notification reads.
    const n = mock.notifications.find((x) => x.id === id && x.tenant_id === tenantId);
    if (n && !n.read) { n.read = true; n.read_at = new Date().toISOString(); }
  }
  async markAllNotificationsRead(tenantId: string, userId: string): Promise<void> {
    mock.notifications.forEach((n) => {
      if (n.tenant_id === tenantId && (n.user_id === null || n.user_id === userId) && !n.read) {
        n.read = true; n.read_at = new Date().toISOString();
      }
    });
  }
  /**
   * 2b2-F2 — bulk "mark all as read" for a portal partner. Mock impl
   * filters in-memory (no DB). Mirrors the supabase store's
   * tenant+partner+portal-safe-type scope so test fixtures behave the
   * same as production.
   */
  async markAllNotificationsReadForPartner(tenantId: string, partnerId: string): Promise<number> {
    const PORTAL_SAFE_TYPES = new Set([
      "kyc_submitted", "kyc_approved", "kyc_rejected",
      "rfq_received", "rfq_quoted",
      "offer_sent", "offer_accepted", "offer_rejected", "offer_expired",
      "invoice_sent", "invoice_overdue", "invoice_paid",
      "proforma_sent",
      // BUILD-LOI-PORTAL — LOI sent to this partner.
      "loi_sent",
      "document_shared",
      "portal_access_requested", "portal_access_approved", "portal_invite_sent",
      "portal_message",
      "marketplace_response_received",
      "marketplace_response_accepted",
      "marketplace_response_rejected",
      "marketplace_message_received",
    ]);
    let updated = 0;
    mock.notifications.forEach((n) => {
      if (
        n.tenant_id === tenantId &&
        n.partner_id === partnerId &&
        PORTAL_SAFE_TYPES.has(n.type) &&
        !n.read
      ) {
        n.read = true;
        n.read_at = new Date().toISOString();
        updated += 1;
      }
    });
    return updated;
  }
  async deleteNotification(id: string): Promise<void> {
    const idx = mock.notifications.findIndex((n) => n.id === id);
    if (idx >= 0) mock.notifications.splice(idx, 1);
  }
  async getUnreadCount(tenantId: string, userId: string): Promise<number> {
    return mock.notifications.filter((n) => n.tenant_id === tenantId && !n.read && (n.user_id === null || n.user_id === userId)).length;
  }
  /**
   * AUDIT2-LOGIC-UX M1 — TOTAL unread count for a portal partner. Mock
   * implementation just filters the in-memory list (parity with
   * listNotificationsByPartner's portal-safe-type filter is approximated
   * by the partner_id filter — the mock store doesn't enforce portal-safe
   * types).
   */
  async getUnreadCountByPartner(tenantId: string, partnerId: string): Promise<number> {
    return mock.notifications.filter(
      (n) => n.tenant_id === tenantId && n.partner_id === partnerId && !n.read,
    ).length;
  }
  async getNotificationById(id: string): Promise<Notification | null> {
    return mock.notifications.find((n) => n.id === id) || null;
  }

  // ---- commission agents ----
  async listCommissionAgents(tenantId: string, params?: ListParams): Promise<ListResult<CommissionAgent>> {
    let items = mock.commissionAgents.filter((a) => a.tenant_id === tenantId);
    if (params?.search) {
      items = items.filter((a) => {
        const partner = mock.partners.find((p) => p.id === a.partner_id);
        return matchesSearch(`${partner?.name || ""} ${a.notes || ""}`, params.search);
      });
    }
    if (params?.filters?.active !== undefined) items = items.filter((a) => String(a.active) === params.filters!.active);
    return paginate(items, params);
  }
  async getCommissionAgent(id: string): Promise<CommissionAgent | null> {
    return mock.commissionAgents.find((a) => a.id === id) || null;
  }
  async getCommissionAgentByPartner(partnerId: string): Promise<CommissionAgent | null> {
    return mock.commissionAgents.find((a) => a.partner_id === partnerId) || null;
  }
  async upsertCommissionAgent(a: Partial<CommissionAgent> & { id?: string }): Promise<CommissionAgent> {
    const existing = a.id ? mock.commissionAgents.find((x) => x.id === a.id) : null;
    if (existing) {
      Object.assign(existing, a, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newA: CommissionAgent = {
      id: a.id || mock.nid("ca_"),
      tenant_id: a.tenant_id || "",
      partner_id: a.partner_id || "",
      commission_type: a.commission_type || "profit_percent",
      commission_rate: a.commission_rate ?? 0,
      commission_per_unit: a.commission_per_unit ?? 0,
      commission_custom_formula: a.commission_custom_formula || null,
      commission_currency: a.commission_currency || "USD",
      is_default: a.is_default ?? false,
      active: a.active ?? true,
      notes: a.notes || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.commissionAgents.push(newA);
    return newA;
  }
  async deleteCommissionAgent(id: string): Promise<void> {
    const idx = mock.commissionAgents.findIndex((a) => a.id === id);
    if (idx >= 0) mock.commissionAgents.splice(idx, 1);
  }

  // ---- deal commissions ----
  async listDealCommissions(tenantId: string, params?: ListParams): Promise<ListResult<DealCommission>> {
    let items = mock.dealCommissions.filter((c) => c.tenant_id === tenantId);
    if (params?.search) {
      items = items.filter((c) => matchesSearch(`${c.deal_id} ${c.status} ${c.payout_reference || ""}`, params.search));
    }
    if (params?.filters?.status) items = items.filter((c) => c.status === params.filters!.status);
    if (params?.filters?.agent_id) items = items.filter((c) => c.agent_id === params.filters!.agent_id);
    return paginate(items, params);
  }
  async listDealCommissionsByDeal(dealId: string): Promise<DealCommission[]> {
    return mock.dealCommissions.filter((c) => c.deal_id === dealId);
  }
  async listDealCommissionsByAgent(agentId: string): Promise<DealCommission[]> {
    return mock.dealCommissions.filter((c) => c.agent_id === agentId);
  }
  async getDealCommission(id: string): Promise<DealCommission | null> {
    return mock.dealCommissions.find((c) => c.id === id) || null;
  }
  async upsertDealCommission(c: Partial<DealCommission> & { id?: string }): Promise<DealCommission> {
    const existing = c.id ? mock.dealCommissions.find((x) => x.id === c.id) : null;
    if (existing) {
      Object.assign(existing, c, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newC: DealCommission = {
      id: c.id || mock.nid("dc_"),
      tenant_id: c.tenant_id || "",
      deal_id: c.deal_id || "",
      agent_id: c.agent_id || "",
      partner_id: c.partner_id || "",
      commission_type: c.commission_type || "profit_percent",
      commission_rate: c.commission_rate ?? 0,
      commission_per_unit: c.commission_per_unit ?? 0,
      commission_custom_formula: c.commission_custom_formula || null,
      commission_currency: c.commission_currency || "USD",
      deal_value: c.deal_value ?? 0,
      deal_profit: c.deal_profit ?? 0,
      deal_quantity: c.deal_quantity ?? 0,
      deal_unit: c.deal_unit || "pcs",
      calculated_commission: c.calculated_commission ?? 0,
      status: c.status || "pending",
      approved_by: c.approved_by || null,
      approved_at: c.approved_at || null,
      paid_at: c.paid_at || null,
      payout_reference: c.payout_reference || null,
      notes: c.notes || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.dealCommissions.push(newC);
    return newC;
  }
  async deleteDealCommission(id: string): Promise<void> {
    const idx = mock.dealCommissions.findIndex((c) => c.id === id);
    if (idx >= 0) mock.dealCommissions.splice(idx, 1);
  }
  async approveDealCommission(id: string, approvedBy: string): Promise<DealCommission> {
    const c = mock.dealCommissions.find((x) => x.id === id);
    if (!c) throw new Error(`DealCommission ${id} not found`);
    c.status = "approved";
    c.approved_by = approvedBy;
    c.approved_at = new Date().toISOString();
    c.updated_at = new Date().toISOString();
    return c;
  }
  async markDealCommissionPaid(id: string, payoutReference?: string): Promise<DealCommission> {
    const c = mock.dealCommissions.find((x) => x.id === id);
    if (!c) throw new Error(`DealCommission ${id} not found`);
    c.status = "paid";
    c.paid_at = new Date().toISOString();
    if (payoutReference) c.payout_reference = payoutReference;
    c.updated_at = new Date().toISOString();
    return c;
  }

  // ---- commission payouts ----
  async listCommissionPayouts(tenantId: string, params?: ListParams): Promise<ListResult<CommissionPayout>> {
    let items = mock.commissionPayouts.filter((p) => p.tenant_id === tenantId);
    if (params?.search) {
      items = items.filter((p) => matchesSearch(`${p.payment_reference || ""} ${p.status}`, params.search));
    }
    if (params?.filters?.status) items = items.filter((p) => p.status === params.filters!.status);
    return paginate(items, params);
  }
  async getCommissionPayout(id: string): Promise<CommissionPayout | null> {
    return mock.commissionPayouts.find((p) => p.id === id) || null;
  }
  async upsertCommissionPayout(p: Partial<CommissionPayout> & { id?: string }): Promise<CommissionPayout> {
    const existing = p.id ? mock.commissionPayouts.find((x) => x.id === p.id) : null;
    if (existing) {
      Object.assign(existing, p, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newP: CommissionPayout = {
      id: p.id || mock.nid("cp_"),
      tenant_id: p.tenant_id || "",
      agent_id: p.agent_id || "",
      partner_id: p.partner_id || "",
      total_amount: p.total_amount ?? 0,
      currency: p.currency || "USD",
      commission_ids: p.commission_ids || [],
      payment_method: p.payment_method || null,
      payment_reference: p.payment_reference || null,
      paid_at: p.paid_at || null,
      status: p.status || "pending",
      notes: p.notes || null,
      created_by: p.created_by || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mock.commissionPayouts.push(newP);
    return newP;
  }
  async deleteCommissionPayout(id: string): Promise<void> {
    const idx = mock.commissionPayouts.findIndex((p) => p.id === id);
    if (idx >= 0) mock.commissionPayouts.splice(idx, 1);
  }
  /**
   * Mock-store implementation of the atomic commission-payout creation.
   * Mock has no Postgres RPC, so we fall back to the non-atomic pattern
   * (upsert + loop mark-paid). Mock is for dev only — production uses
   * SupabaseStore which calls the real `create_commission_payout` RPC.
   */
  async createCommissionPayoutAtomic(
    payout: Partial<CommissionPayout> & { commission_ids: string[] },
    commissionIds: string[],
  ): Promise<CommissionPayout> {
    const created = await this.upsertCommissionPayout(payout);
    if (created.status === "completed") {
      for (const commissionId of commissionIds) {
        try {
          await this.markDealCommissionPaid(commissionId, created.id);
        } catch (e) {
          console.warn(`[mock createCommissionPayoutAtomic] markDealCommissionPaid failed for ${commissionId}:`, e);
        }
      }
    }
    return created;
  }

  // ---- commission summaries ----
  async getCommissionSummaries(tenantId: string): Promise<CommissionSummary[]> {
    const agents = mock.commissionAgents.filter((a) => a.tenant_id === tenantId && a.active);
    return agents.map((agent) => {
      const commissions = mock.dealCommissions.filter((c) => c.agent_id === agent.id && c.tenant_id === tenantId);
      const partner = mock.partners.find((p) => p.id === agent.partner_id);
      const totalCommission = commissions.reduce((sum, c) => sum + c.calculated_commission, 0);
      const paidCommission = commissions.filter((c) => c.status === "paid").reduce((sum, c) => sum + c.calculated_commission, 0);
      const pendingCommission = commissions.filter((c) => c.status === "pending" || c.status === "approved").reduce((sum, c) => sum + c.calculated_commission, 0);
      return {
        agent_id: agent.id,
        partner_id: agent.partner_id,
        partner_name: partner?.name || "Unknown",
        total_deals: commissions.length,
        total_commission: totalCommission,
        paid_commission: paidCommission,
        pending_commission: pendingCommission,
        currency: agent.commission_currency,
      };
    });
  }

  async calculateCommission(agentId: string, dealValue: number, dealProfit: number, dealQuantity: number, dealUnit: string, dealCurrency: string): Promise<number> {
    // AUDIT18 (parity with SupabaseStore, audit P1-4/P1-5): the mock
    // implementation had drifted from the production one — it lacked the
    // FX conversion to the agent's commission_currency AND the
    // no-negative-commission guard, so dev/test computed different
    // commissions than production (negative commissions on loss deals).
    const agent = mock.commissionAgents.find((a) => a.id === agentId);
    if (!agent) return 0;
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
        // Rate fetch failed — best effort in the deal's currency.
      }
    }
    switch (agent.commission_type) {
      case "profit_percent":
        return Math.max(0, convertedDealProfit) * (agent.commission_rate / 100);
      case "revenue_percent":
        return convertedDealValue * (agent.commission_rate / 100);
      case "fixed":
        return agent.commission_rate;
      case "per_unit":
        return (agent.commission_per_unit || 0) * dealQuantity;
      case "custom":
        return agent.commission_rate; // fallback, custom formula would need manual calculation
      default:
        return 0;
    }
  }

  // ================================================================
  // ERP / Accounting
  // ================================================================

  // ---- Chart of Accounts ----
  async listErpAccounts(tenantId: string, params?: ListParams): Promise<ListResult<ErpAccount>> {
    let items = [...this.erpAccounts.values()].filter((a) => a.tenant_id === tenantId);
    if (params?.search) {
      const q = params.search.toLowerCase();
      items = items.filter((a) => a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q));
    }
    if (params?.filters) {
      for (const [k, v] of Object.entries(params.filters)) {
        if (v !== undefined) items = items.filter((a) => String((a as Record<string, unknown>)[k]) === v);
      }
    }
    return paginate(items, params);
  }

  async getErpAccount(id: string): Promise<ErpAccount | null> {
    return this.erpAccounts.get(id) || null;
  }

  async upsertErpAccount(a: Partial<ErpAccount> & { id?: string }): Promise<ErpAccount> {
    const existing = a.id ? this.erpAccounts.get(a.id) : undefined;
    if (existing) {
      Object.assign(existing, a, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newA: ErpAccount = {
      id: a.id || mock.nid("acc_"),
      tenant_id: a.tenant_id || "",
      code: a.code || "",
      name: a.name || "",
      name_en: a.name_en || null,
      account_type: a.account_type || "asset",
      account_category: a.account_category || null,
      parent_id: a.parent_id || null,
      is_active: a.is_active ?? true,
      is_system: a.is_system ?? false,
      standard: a.standard || null,
      tax_code: a.tax_code || null,
      description: a.description || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpAccounts.set(newA.id, newA);
    return newA;
  }

  async deleteErpAccount(id: string): Promise<void> {
    this.erpAccounts.delete(id);
  }

  // ---- Fiscal Periods ----
  async listFiscalPeriods(tenantId: string, params?: ListParams): Promise<ListResult<FiscalPeriod>> {
    let items = [...this.fiscalPeriods.values()].filter((p) => p.tenant_id === tenantId);
    if (params?.search) {
      const q = params.search.toLowerCase();
      items = items.filter((p) => p.name.toLowerCase().includes(q));
    }
    return paginate(items, params);
  }

  async getFiscalPeriod(id: string): Promise<FiscalPeriod | null> {
    return this.fiscalPeriods.get(id) || null;
  }

  async upsertFiscalPeriod(p: Partial<FiscalPeriod> & { id?: string }): Promise<FiscalPeriod> {
    const existing = p.id ? this.fiscalPeriods.get(p.id) : undefined;
    if (existing) {
      Object.assign(existing, p, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newP: FiscalPeriod = {
      id: p.id || mock.nid("fp_"),
      tenant_id: p.tenant_id || "",
      name: p.name || "",
      start_date: p.start_date || "",
      end_date: p.end_date || "",
      period_type: p.period_type || "monthly",
      status: p.status || "open",
      fiscal_year: p.fiscal_year || new Date().getFullYear(),
      closed_by: p.closed_by || null,
      closed_at: p.closed_at || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.fiscalPeriods.set(newP.id, newP);
    return newP;
  }

  async closeFiscalPeriod(id: string, closedBy: string): Promise<FiscalPeriod> {
    const fp = this.fiscalPeriods.get(id);
    if (!fp) throw new Error(`FiscalPeriod ${id} not found`);
    fp.status = "closed";
    fp.closed_by = closedBy;
    fp.closed_at = new Date().toISOString();
    fp.updated_at = new Date().toISOString();
    return fp;
  }

  // ---- Journal Entries ----
  async listErpJournalEntries(tenantId: string, params?: ListParams): Promise<ListResult<ErpJournalEntry>> {
    let items = [...this.erpJournalEntries.values()].filter((e) => e.tenant_id === tenantId);
    if (params?.search) {
      const q = params.search.toLowerCase();
      items = items.filter((e) => e.entry_number.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
    }
    if (params?.filters) {
      for (const [k, v] of Object.entries(params.filters)) {
        if (v !== undefined) items = items.filter((e) => String((e as Record<string, unknown>)[k]) === v);
      }
    }
    // Attach lines
    items = items.map((e) => ({ ...e, lines: [...this.erpJournalLines.values()].filter((l) => l.journal_entry_id === e.id) }));
    return paginate(items, params);
  }

  async getErpJournalEntry(id: string): Promise<ErpJournalEntry | null> {
    const entry = this.erpJournalEntries.get(id);
    if (!entry) return null;
    return { ...entry, lines: [...this.erpJournalLines.values()].filter((l) => l.journal_entry_id === id) };
  }

  async upsertErpJournalEntry(e: Omit<Partial<ErpJournalEntry>, "lines"> & { id?: string; lines?: Partial<ErpJournalLine & { id?: string }>[] }): Promise<ErpJournalEntry> {
    const existing = e.id ? this.erpJournalEntries.get(e.id) : undefined;
    if (existing) {
      Object.assign(existing, e, { updated_at: new Date().toISOString() });
      // Update lines if provided
      if (e.lines) {
        // Remove old lines
        for (const [lid, line] of this.erpJournalLines) {
          if (line.journal_entry_id === existing.id) this.erpJournalLines.delete(lid);
        }
        // Add new lines
        let lineNum = 0;
        for (const l of e.lines) {
          lineNum++;
          const newL: ErpJournalLine = {
            id: l.id || mock.nid("jl_"),
            journal_entry_id: existing.id,
            account_id: l.account_id || "",
            line_number: l.line_number ?? lineNum,
            description: l.description || null,
            debit: l.debit ?? 0,
            credit: l.credit ?? 0,
            currency: l.currency || existing.currency,
            partner_id: l.partner_id || null,
            cost_center_id: l.cost_center_id || null,
            created_at: new Date().toISOString(),
          };
          this.erpJournalLines.set(newL.id, newL);
        }
        // Recalculate totals
        const allLines = [...this.erpJournalLines.values()].filter((l) => l.journal_entry_id === existing.id);
        existing.debit_total = allLines.reduce((s, l) => s + l.debit, 0);
        existing.credit_total = allLines.reduce((s, l) => s + l.credit, 0);
      }
      return existing;
    }
    this.journalEntryCounter++;
    const newE: ErpJournalEntry = {
      id: e.id || mock.nid("je_"),
      tenant_id: e.tenant_id || "",
      entry_number: e.entry_number || `JE-${String(this.journalEntryCounter).padStart(5, "0")}`,
      date: e.date || new Date().toISOString().slice(0, 10),
      description: e.description || "",
      reference_type: e.reference_type || null,
      reference_id: e.reference_id || null,
      fiscal_period_id: e.fiscal_period_id || null,
      status: e.status || "draft",
      source_type: e.source_type || "manual",
      debit_total: 0,
      credit_total: 0,
      currency: e.currency || "EUR",
      exchange_rate: e.exchange_rate ?? 1,
      notes: e.notes || null,
      created_by: e.created_by || "",
      posted_by: e.posted_by || null,
      posted_at: e.posted_at || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpJournalEntries.set(newE.id, newE);
    // Add lines if provided
    if (e.lines) {
      let lineNum = 0;
      for (const l of e.lines) {
        lineNum++;
        const newL: ErpJournalLine = {
          id: l.id || mock.nid("jl_"),
          journal_entry_id: newE.id,
          account_id: l.account_id || "",
          line_number: l.line_number ?? lineNum,
          description: l.description || null,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
          currency: l.currency || newE.currency,
          partner_id: l.partner_id || null,
          cost_center_id: l.cost_center_id || null,
          created_at: new Date().toISOString(),
        };
        this.erpJournalLines.set(newL.id, newL);
      }
      const allLines = [...this.erpJournalLines.values()].filter((l) => l.journal_entry_id === newE.id);
      newE.debit_total = allLines.reduce((s, l) => s + l.debit, 0);
      newE.credit_total = allLines.reduce((s, l) => s + l.credit, 0);
    }
    return newE;
  }

  async postErpJournalEntry(id: string, postedBy: string): Promise<ErpJournalEntry> {
    const entry = this.erpJournalEntries.get(id);
    if (!entry) throw new Error(`JournalEntry ${id} not found`);
    entry.status = "posted";
    entry.posted_by = postedBy;
    entry.posted_at = new Date().toISOString();
    entry.updated_at = new Date().toISOString();
    return entry;
  }

  async reverseErpJournalEntry(id: string, reversedBy: string): Promise<ErpJournalEntry> {
    const entry = this.erpJournalEntries.get(id);
    if (!entry) throw new Error(`JournalEntry ${id} not found`);
    entry.status = "reversed";
    entry.updated_at = new Date().toISOString();
    // Create a reversal entry
    const lines = [...this.erpJournalLines.values()].filter((l) => l.journal_entry_id === id);
    this.journalEntryCounter++;
    const reversal: ErpJournalEntry = {
      id: mock.nid("je_"),
      tenant_id: entry.tenant_id,
      entry_number: `JE-${String(this.journalEntryCounter).padStart(5, "0")}`,
      date: new Date().toISOString().slice(0, 10),
      description: `Reversal of ${entry.entry_number}`,
      reference_type: "manual",
      reference_id: id,
      fiscal_period_id: entry.fiscal_period_id,
      status: "posted",
      source_type: "auto",
      debit_total: entry.credit_total,
      credit_total: entry.debit_total,
      currency: entry.currency,
      exchange_rate: entry.exchange_rate,
      notes: `Reversed by ${reversedBy}`,
      created_by: reversedBy,
      posted_by: reversedBy,
      posted_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpJournalEntries.set(reversal.id, reversal);
    // Create reversal lines (swap debit/credit)
    let lineNum = 0;
    for (const l of lines) {
      lineNum++;
      const rl: ErpJournalLine = {
        id: mock.nid("jl_"),
        journal_entry_id: reversal.id,
        account_id: l.account_id,
        line_number: lineNum,
        description: l.description ? `Reversal: ${l.description}` : "Reversal",
        debit: l.credit, // swap
        credit: l.debit, // swap
        currency: l.currency,
        partner_id: l.partner_id,
        cost_center_id: l.cost_center_id,
        created_at: new Date().toISOString(),
      };
      this.erpJournalLines.set(rl.id, rl);
    }
    return entry;
  }

  async deleteErpJournalEntry(id: string): Promise<void> {
    this.erpJournalEntries.delete(id);
    // Remove associated lines
    for (const [lid, line] of this.erpJournalLines) {
      if (line.journal_entry_id === id) this.erpJournalLines.delete(lid);
    }
  }

  // E-2 (multi-currency ERP) — mock implementation of the
  // create_fx_revaluation RPC. Produces a draft revaluation entry
  // (is_revaluation = true) with one balanced line-pair per adjustment.
  // Mirrors the SQL in supabase/migrations/038_multi_currency_erp.sql.
  // Used only when DB_BACKEND=mock (dev sandbox). Production routes
  // through SupabaseStore.createFxRevaluation → the RPC.
  async createFxRevaluation(
    tenantId: string,
    revalDate: string,
    baseCurrency: string,
    adjustments: FxRevaluationAdjustment[],
    createdBy: string,
  ): Promise<FxRevaluationResult> {
    this.journalEntryCounter++;
    const entryId = `je_reval_${this.journalEntryCounter}`;
    const entryNumber = `REVAL-${revalDate.replace(/-/g, "")}-${String(this.journalEntryCounter).padStart(4, "0")}`;
    const newE: ErpJournalEntry = {
      id: entryId,
      tenant_id: tenantId,
      entry_number: entryNumber,
      date: revalDate,
      description: `FX Revaluation as of ${revalDate}`,
      reference_type: "manual",
      reference_id: null,
      fiscal_period_id: null,
      status: "draft",
      source_type: "auto",
      debit_total: 0,
      credit_total: 0,
      currency: baseCurrency,
      exchange_rate: 1,
      base_currency: baseCurrency,
      is_revaluation: true,
      revaluation_of: null,
      notes: "Auto-generated by createFxRevaluation (mock)",
      created_by: createdBy,
      posted_by: null,
      posted_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpJournalEntries.set(entryId, newE);

    let totalDebitBase = 0;
    let totalCreditBase = 0;
    let lineNo = 0;
    for (const adj of adjustments || []) {
      const baseOld = (adj.balance_foreign || 0) * (adj.fx_rate_old || 1);
      const baseNew = (adj.balance_foreign || 0) * (adj.fx_rate_new || 1);
      const delta = baseNew - baseOld;
      let debitBase = 0;
      let creditBase = 0;
      if (delta >= 0) {
        if ((adj.balance_foreign || 0) >= 0) { debitBase = delta; creditBase = 0; }
        else { debitBase = 0; creditBase = delta; }
      } else {
        if ((adj.balance_foreign || 0) >= 0) { debitBase = 0; creditBase = -delta; }
        else { debitBase = -delta; creditBase = 0; }
      }
      lineNo++;
      const l1: ErpJournalLine = {
        id: mock.nid("jl_"),
        journal_entry_id: entryId,
        account_id: adj.account_id,
        line_number: lineNo,
        description: adj.description || `FX revaluation ${adj.currency}`,
        debit: 0, credit: 0,
        currency: adj.currency,
        fx_rate: adj.fx_rate_new,
        debit_base: debitBase,
        credit_base: creditBase,
        partner_id: null, cost_center_id: null,
        created_at: new Date().toISOString(),
      };
      this.erpJournalLines.set(l1.id, l1);
      lineNo++;
      const l2: ErpJournalLine = {
        id: mock.nid("jl_"),
        journal_entry_id: entryId,
        account_id: adj.gain_loss_account_id,
        line_number: lineNo,
        description: `FX gain/loss — ${adj.currency}`,
        debit: 0, credit: 0,
        currency: baseCurrency,
        fx_rate: 1,
        debit_base: creditBase,
        credit_base: debitBase,
        partner_id: null, cost_center_id: null,
        created_at: new Date().toISOString(),
      };
      this.erpJournalLines.set(l2.id, l2);
      totalDebitBase += debitBase + creditBase;
      totalCreditBase += creditBase + debitBase;
    }
    newE.debit_total = totalDebitBase;
    newE.credit_total = totalCreditBase;
    return {
      id: entryId,
      entry_number: entryNumber,
      line_count: adjustments.length * 2,
      total_debit_base: totalDebitBase,
      total_credit_base: totalCreditBase,
    };
  }

  // ---- Cost Centers ----
  async listErpCostCenters(tenantId: string, params?: ListParams): Promise<ListResult<ErpCostCenter>> {
    let items = [...this.erpCostCenters.values()].filter((c) => c.tenant_id === tenantId);
    if (params?.search) {
      const q = params.search.toLowerCase();
      items = items.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
    }
    return paginate(items, params);
  }

  async upsertErpCostCenter(c: Partial<ErpCostCenter> & { id?: string }): Promise<ErpCostCenter> {
    const existing = c.id ? this.erpCostCenters.get(c.id) : undefined;
    if (existing) {
      Object.assign(existing, c, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newC: ErpCostCenter = {
      id: c.id || mock.nid("cc_"),
      tenant_id: c.tenant_id || "",
      code: c.code || "",
      name: c.name || "",
      parent_id: c.parent_id || null,
      is_active: c.is_active ?? true,
      description: c.description || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpCostCenters.set(newC.id, newC);
    return newC;
  }

  async deleteErpCostCenter(id: string): Promise<void> {
    this.erpCostCenters.delete(id);
  }

  // ---- Bank Accounts ----
  async listErpBankAccounts(tenantId: string): Promise<ErpBankAccount[]> {
    return [...this.erpBankAccounts.values()].filter((b) => b.tenant_id === tenantId);
  }

  async upsertErpBankAccount(b: Partial<ErpBankAccount> & { id?: string }): Promise<ErpBankAccount> {
    const existing = b.id ? this.erpBankAccounts.get(b.id) : undefined;
    if (existing) {
      Object.assign(existing, b, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newB: ErpBankAccount = {
      id: b.id || mock.nid("ba_"),
      tenant_id: b.tenant_id || "",
      account_id: b.account_id || "",
      bank_name: b.bank_name || "",
      account_number: b.account_number || "",
      iban: b.iban || null,
      swift_bic: b.swift_bic || null,
      currency: b.currency || "EUR",
      balance: b.balance ?? 0,
      is_active: b.is_active ?? true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpBankAccounts.set(newB.id, newB);
    return newB;
  }

  async deleteErpBankAccount(id: string): Promise<void> {
    this.erpBankAccounts.delete(id);
  }

  // ---- Bank Transactions ----
  async listErpBankTransactions(tenantId: string, bankAccountId?: string, params?: ListParams): Promise<ListResult<ErpBankTransaction>> {
    let items = [...this.erpBankTransactions.values()].filter((t) => t.tenant_id === tenantId);
    if (bankAccountId) {
      items = items.filter((t) => t.bank_account_id === bankAccountId);
    }
    if (params?.search) {
      const q = params.search.toLowerCase();
      items = items.filter((t) => (t.description || "").toLowerCase().includes(q) || (t.reference || "").toLowerCase().includes(q));
    }
    return paginate(items, params);
  }

  async upsertErpBankTransaction(t: Partial<ErpBankTransaction> & { id?: string }): Promise<ErpBankTransaction> {
    const existing = t.id ? this.erpBankTransactions.get(t.id) : undefined;
    if (existing) {
      Object.assign(existing, t);
      return existing;
    }
    const newT: ErpBankTransaction = {
      id: t.id || mock.nid("bt_"),
      tenant_id: t.tenant_id || "",
      bank_account_id: t.bank_account_id || "",
      date: t.date || new Date().toISOString().slice(0, 10),
      amount: t.amount ?? 0,
      transaction_type: t.transaction_type || "credit",
      description: t.description || null,
      reference: t.reference || null,
      counterparty: t.counterparty || null,
      counterparty_account: t.counterparty_account || null,
      is_reconciled: t.is_reconciled ?? false,
      reconciled_with: t.reconciled_with || null,
      journal_entry_id: t.journal_entry_id || null,
      created_at: new Date().toISOString(),
    };
    this.erpBankTransactions.set(newT.id, newT);
    return newT;
  }

  async reconcileBankTransaction(id: string, journalEntryId: string): Promise<ErpBankTransaction> {
    const tx = this.erpBankTransactions.get(id);
    if (!tx) throw new Error(`BankTransaction ${id} not found`);
    tx.is_reconciled = true;
    tx.reconciled_with = journalEntryId;
    tx.journal_entry_id = journalEntryId;
    return tx;
  }

  // ---- ERP Settings ----
  async getErpSettings(tenantId: string): Promise<ErpSetting | null> {
    for (const s of this.erpSettings.values()) {
      if (s.tenant_id === tenantId) return s;
    }
    return null;
  }

  async upsertErpSettings(s: Partial<ErpSetting> & { id?: string; tenant_id: string }): Promise<ErpSetting> {
    const existing = await this.getErpSettings(s.tenant_id);
    if (existing) {
      Object.assign(existing, s, { updated_at: new Date().toISOString() });
      return existing;
    }
    const newS: ErpSetting = {
      id: s.id || mock.nid("es_"),
      tenant_id: s.tenant_id,
      accounting_standard: s.accounting_standard || "eu",
      fiscal_year_start: s.fiscal_year_start || "01-01",
      fiscal_year_end: s.fiscal_year_end || "12-31",
      default_currency: s.default_currency || "EUR",
      vat_enabled: s.vat_enabled ?? true,
      vat_rate: s.vat_rate ?? 20,
      vat_return_period: s.vat_return_period || "quarterly",
      auto_post_journal: s.auto_post_journal ?? false,
      revenue_account_id: s.revenue_account_id || null,
      expense_account_id: s.expense_account_id || null,
      receivable_account_id: s.receivable_account_id || null,
      payable_account_id: s.payable_account_id || null,
      vat_account_id: s.vat_account_id || null,
      bank_charges_account_id: s.bank_charges_account_id || null,
      cash_account_id: s.cash_account_id || null,
      retention_account_id: s.retention_account_id || null,
      round_off_account_id: s.round_off_account_id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.erpSettings.set(newS.id, newS);
    return newS;
  }

  // ---- ERP Reports ----
  async getTrialBalance(tenantId: string, asOfDate: string): Promise<TrialBalance> {
    const accounts = [...this.erpAccounts.values()].filter((a) => a.tenant_id === tenantId);
    const postedEntries = [...this.erpJournalEntries.values()].filter(
      (e) => e.tenant_id === tenantId && e.status === "posted" && e.date <= asOfDate
    );
    const postedEntryIds = new Set(postedEntries.map((e) => e.id));
    const allLines = [...this.erpJournalLines.values()].filter((l) => postedEntryIds.has(l.journal_entry_id));

    const items: TrialBalanceItem[] = accounts.map((acc) => {
      const accLines = allLines.filter((l) => l.account_id === acc.id);
      const debitTotal = accLines.reduce((s, l) => s + l.debit, 0);
      const creditTotal = accLines.reduce((s, l) => s + l.credit, 0);
      return {
        account_id: acc.id,
        account_code: acc.code,
        account_name: acc.name,
        account_type: acc.account_type,
        debit_total: debitTotal,
        credit_total: creditTotal,
        balance: debitTotal - creditTotal,
      };
    });

    const totalDebit = items.reduce((s, i) => s + i.debit_total, 0);
    const totalCredit = items.reduce((s, i) => s + i.credit_total, 0);
    return { items, total_debit: totalDebit, total_credit: totalCredit, as_of_date: asOfDate };
  }

  async getBalanceSheet(tenantId: string, asOfDate: string): Promise<BalanceSheet> {
    const tb = await this.getTrialBalance(tenantId, asOfDate);
    const assets: BalanceSheetItem[] = [];
    const liabilities: BalanceSheetItem[] = [];
    const equity: BalanceSheetItem[] = [];

    for (const item of tb.items) {
      const bsItem: BalanceSheetItem = { account_code: item.account_code, account_name: item.account_name, amount: item.balance };
      if (item.account_type === "asset") assets.push(bsItem);
      else if (item.account_type === "liability") liabilities.push(bsItem);
      else if (item.account_type === "equity") equity.push(bsItem);
    }

    const totalAssets = assets.reduce((s, i) => s + i.amount, 0);
    const totalLiabilities = liabilities.reduce((s, i) => s + i.amount, 0);
    const totalEquity = equity.reduce((s, i) => s + i.amount, 0);
    return { assets, liabilities, equity, total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity, as_of_date: asOfDate };
  }

  async getProfitAndLoss(tenantId: string, periodStart: string, periodEnd: string): Promise<ProfitAndLoss> {
    const accounts = [...this.erpAccounts.values()].filter((a) => a.tenant_id === tenantId);
    const postedEntries = [...this.erpJournalEntries.values()].filter(
      (e) => e.tenant_id === tenantId && e.status === "posted" && e.date >= periodStart && e.date <= periodEnd
    );
    const postedEntryIds = new Set(postedEntries.map((e) => e.id));
    const allLines = [...this.erpJournalLines.values()].filter((l) => postedEntryIds.has(l.journal_entry_id));

    const revenue: BalanceSheetItem[] = [];
    const expenses: BalanceSheetItem[] = [];

    for (const acc of accounts) {
      const accLines = allLines.filter((l) => l.account_id === acc.id);
      const debitTotal = accLines.reduce((s, l) => s + l.debit, 0);
      const creditTotal = accLines.reduce((s, l) => s + l.credit, 0);
      const balance = creditTotal - debitTotal; // revenue is credit-normal
      if (acc.account_type === "revenue" && balance !== 0) {
        revenue.push({ account_code: acc.code, account_name: acc.name, amount: balance });
      } else if (acc.account_type === "expense" && balance !== 0) {
        expenses.push({ account_code: acc.code, account_name: acc.name, amount: debitTotal - creditTotal }); // expense is debit-normal
      }
    }

    const totalRevenue = revenue.reduce((s, i) => s + i.amount, 0);
    const totalExpenses = expenses.reduce((s, i) => s + i.amount, 0);
    return { revenue, expenses, total_revenue: totalRevenue, total_expenses: totalExpenses, net_profit: totalRevenue - totalExpenses, period_start: periodStart, period_end: periodEnd };
  }

  async getGeneralLedger(tenantId: string, accountId: string, dateFrom?: string, dateTo?: string): Promise<GeneralLedger> {
    const account = this.erpAccounts.get(accountId);
    const accountCode = account?.code || "";
    const accountName = account?.name || "";

    let postedEntries = [...this.erpJournalEntries.values()].filter(
      (e) => e.tenant_id === tenantId && e.status === "posted"
    );
    if (dateFrom) postedEntries = postedEntries.filter((e) => e.date >= dateFrom);
    if (dateTo) postedEntries = postedEntries.filter((e) => e.date <= dateTo);
    const postedEntryIds = new Set(postedEntries.map((e) => e.id));
    const accLines = [...this.erpJournalLines.values()].filter(
      (l) => postedEntryIds.has(l.journal_entry_id) && l.account_id === accountId
    );

    // Sort by date then entry number
    const entryMap = new Map<string, ErpJournalEntry>();
    for (const e of postedEntries) entryMap.set(e.id, e);
    const sortedLines = accLines.sort((a, b) => {
      const ea = entryMap.get(a.journal_entry_id);
      const eb = entryMap.get(b.journal_entry_id);
      const da = ea?.date || "";
      const db = eb?.date || "";
      return da < db ? -1 : da > db ? 1 : 0;
    });

    let runningBalance = 0;
    const entries: GeneralLedgerEntry[] = sortedLines.map((l) => {
      const je = entryMap.get(l.journal_entry_id);
      runningBalance += l.debit - l.credit;
      return {
        journal_entry_id: l.journal_entry_id,
        entry_number: je?.entry_number || "",
        date: je?.date || "",
        description: je?.description || "",
        debit: l.debit,
        credit: l.credit,
        balance: runningBalance,
        reference_type: je?.reference_type || null,
        reference_id: je?.reference_id || null,
      };
    });

    const totalDebit = accLines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = accLines.reduce((s, l) => s + l.credit, 0);
    return {
      account_id: accountId,
      account_code: accountCode,
      account_name: accountName,
      entries,
      opening_balance: 0,
      closing_balance: runningBalance,
      total_debit: totalDebit,
      total_credit: totalCredit,
    };
  }

  // ---- Auto-journal from business events ----
  async autoJournalFromInvoice(invoiceId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null> {
    const invoice = mock.invoices.find((i) => i.id === invoiceId);
    if (!invoice) return null;
    const settings = await this.getErpSettings(tenantId);
    const receivableAccountId = settings?.receivable_account_id || "acc_receivable";
    const revenueAccountId = settings?.revenue_account_id || "acc_revenue";
    const vatAccountId = settings?.vat_account_id || "acc_vat";
    const vatRate = settings?.vat_enabled ? (settings?.vat_rate ?? 0) / 100 : 0;
    const subtotal = invoice.total_amount / (1 + vatRate);
    const vatAmount = invoice.total_amount - subtotal;

    const lines: Partial<ErpJournalLine & { id?: string }>[] = [
      { account_id: receivableAccountId, debit: invoice.total_amount, credit: 0, description: `Invoice ${invoice.invoice_number} - Receivable` },
      { account_id: revenueAccountId, debit: 0, credit: subtotal, description: `Invoice ${invoice.invoice_number} - Revenue` },
    ];
    if (vatAmount > 0) {
      lines.push({ account_id: vatAccountId, debit: 0, credit: vatAmount, description: `Invoice ${invoice.invoice_number} - VAT` });
    }

    return this.upsertErpJournalEntry({
      tenant_id: tenantId,
      date: invoice.issue_date || new Date().toISOString().slice(0, 10),
      description: `Auto-journal for Invoice ${invoice.invoice_number}`,
      reference_type: "invoice",
      reference_id: invoiceId,
      status: settings?.auto_post_journal ? "posted" : "draft",
      source_type: "auto",
      currency: invoice.currency || "EUR",
      created_by: userId,
      lines,
    });
  }

  async autoJournalFromDeal(dealId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null> {
    const deal = mock.deals.find((d) => d.id === dealId);
    if (!deal) return null;
    const settings = await this.getErpSettings(tenantId);
    const revenueAccountId = settings?.revenue_account_id || "acc_revenue";
    const receivableAccountId = settings?.receivable_account_id || "acc_receivable";

    const lines: Partial<ErpJournalLine & { id?: string }>[] = [
      { account_id: receivableAccountId, debit: deal.value || 0, credit: 0, description: `Deal ${deal.title} - Receivable` },
      { account_id: revenueAccountId, debit: 0, credit: deal.value || 0, description: `Deal ${deal.title} - Revenue` },
    ];

    return this.upsertErpJournalEntry({
      tenant_id: tenantId,
      date: new Date().toISOString().slice(0, 10),
      description: `Auto-journal for Deal ${deal.title}`,
      reference_type: "deal",
      reference_id: dealId,
      status: settings?.auto_post_journal ? "posted" : "draft",
      source_type: "auto",
      currency: deal.currency || "EUR",
      created_by: userId,
      lines,
    });
  }

  async autoJournalFromCommission(commissionId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null> {
    const commission = mock.dealCommissions.find((c) => c.id === commissionId);
    if (!commission) return null;
    const settings = await this.getErpSettings(tenantId);
    const expenseAccountId = settings?.expense_account_id || "acc_expense";
    const payableAccountId = settings?.payable_account_id || "acc_payable";

    const lines: Partial<ErpJournalLine & { id?: string }>[] = [
      { account_id: expenseAccountId, debit: commission.calculated_commission, credit: 0, description: `Commission ${commissionId} - Expense` },
      { account_id: payableAccountId, debit: 0, credit: commission.calculated_commission, description: `Commission ${commissionId} - Payable` },
    ];

    return this.upsertErpJournalEntry({
      tenant_id: tenantId,
      date: new Date().toISOString().slice(0, 10),
      description: `Auto-journal for Commission ${commissionId}`,
      reference_type: "commission",
      reference_id: commissionId,
      status: settings?.auto_post_journal ? "posted" : "draft",
      source_type: "auto",
      currency: commission.commission_currency || "EUR",
      created_by: userId,
      lines,
    });
  }

  // ---- user preferences ----
  private userPreferences = new Map<string, UserPreference>();

  async getUserPreference(userId: string, key: string): Promise<UserPreference | null> {
    return this.userPreferences.get(`${userId}:${key}`) || null;
  }

  async setUserPreference(userId: string, key: string, value: unknown): Promise<UserPreference> {
    const pref: UserPreference = {
      id: `up_${userId}_${key}`,
      user_id: userId,
      preference_key: key,
      preference_value: typeof value === "string" ? value : JSON.stringify(value),
      updated_at: new Date().toISOString(),
    };
    this.userPreferences.set(`${userId}:${key}`, pref);
    return pref;
  }

  async deleteUserPreference(_userId: string, _key: string): Promise<void> {}

  async listUserPreferences(userId: string): Promise<UserPreference[]> {
    return Array.from(this.userPreferences.values())
      .filter((p) => p.user_id === userId)
      .sort((a, b) => a.preference_key.localeCompare(b.preference_key));
  }

  // P1 (VAT compliance) / task C-4 Fix 1: MockStore has no Postgres
  // SEQUENCE, so the atomic `create_doc_with_number` RPC is N/A. Fall
  // back to the legacy two-step pattern (nextDocNumber + upsert) — the
  // mock store is only used in tests/preview, never in production, so a
  // gap on failure is acceptable.
  async createDocWithNumber(
    docType: "offer" | "invoice" | "proforma" | "demand" | "rfq",
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { nextDocNumber, formatDocNumber } = await import("@/lib/api/doc-number");
    // FIX-PRODUCTS-DOCS / Fix 3 — pass the payload's tenant_id so
    // nextDocNumber uses the per-tenant RPC (migration 063). MockStore is
    // dev/preview only, but we keep the per-tenant shape consistent with
    // SupabaseStore. The tenantId is optional — undefined falls back to
    // the global RPC path (which is fine for MockStore since there is no
    // SEQUENCE; nextDocNumber returns null and we drop to the fallback
    // below).
    const tenantId = (payload as any).tenant_id as string | undefined;
    let number = await nextDocNumber(docType, tenantId);
    if (!number) {
      // MockStore fallback: derive a simple sequential number from the
      // existing mock data length. Matches the legacy `listX().total + 1`
      // pattern the routes used before this fix.
      const year = new Date().getFullYear();
      const seq = Math.floor(Math.random() * 10000) + 1;
      number = formatDocNumber(docType, year, seq);
    }
    const body = { ...payload, number };
    switch (docType) {
      case "offer":
        return this.upsertOffer(body as any) as unknown as Record<string, unknown>;
      case "invoice":
        return this.upsertInvoice(body as any) as unknown as Record<string, unknown>;
      case "proforma":
        return this.upsertProforma(body as any) as unknown as Record<string, unknown>;
      case "demand":
        return this.upsertDemand(body as any) as unknown as Record<string, unknown>;
      case "rfq":
        return this.upsertPortalRfq(body as any) as unknown as Record<string, unknown>;
      default:
        throw new Error(`createDocWithNumber: unsupported doc_type '${docType}'`);
    }
  }
}
