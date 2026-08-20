// PrismaStore — legacy implementation of the Store interface using Prisma/SQLite.
// NOTE: This store is DEPRECATED. The production runtime uses SupabaseStore
// (DB_BACKEND=supabase). This file is kept for dev/legacy reference and the
// Prisma schema has drifted from the multi-tenant types in supabase/types.ts.
// Type errors are suppressed intentionally to keep the legacy file importable.
// @ts-nocheck

import { Store, ListParams, ListResult } from "./store";
import { db } from "@/lib/db";
import { ensureStarterTemplates } from "./starter-templates";
import {
  User, Partner, Product, Deal, Offer, Demand, SharedDocument,
  AuditLog, Setting, UserTask, InventoryMovement, EntityNote,
  DashboardInsights, DashboardCharts, DealStage,
  Invoice, Proforma, DocumentRegisterEntry, DocumentRevision,
  VaultSecret, ApiKey, Webhook,
  SecuritySession, LoginHistoryEntry, KnownIp, TrustedDevice,
  MailQueueEntry,
  Tenant, ProductCatalogEntry, SupplierOffer, TradeCalculation,
  PortalAccess, DocumentTemplate, DocumentVerification, VerificationLog,
  TenantLetterhead, TenantSeal,
  KycSubmission, KycDocument, PortalRfq,
  TenantFeatureFlags,
  Notification,
  ErpAccount, FiscalPeriod, ErpJournalEntry, ErpJournalLine,
  ErpCostCenter, ErpBankAccount, ErpBankTransaction, ErpSetting,
  TrialBalance, BalanceSheet, ProfitAndLoss, GeneralLedger,
  UserPreference,
  CommissionPayout,
} from "@/lib/supabase/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJSON<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val) as T; } catch { return fallback; }
}

function stringifyJSON(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return JSON.stringify(val);
}

function dateToISO(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") return d;
  return d.toISOString();
}

function dateToISOOrNow(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  if (typeof d === "string") return d;
  return d.toISOString();
}

function matchesSearch(haystack: string, needle?: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ─── User row mapper ────────────────────────────────────────────────────────

function mapUserRow(r: any): User {
  return {
    ...r,
    permissions: parseJSON<string[]>(r.permissions, []),
    notif_prefs: parseJSON<Record<string, unknown>>(r.notif_prefs, null),
    // recovery_codes is stored as TEXT (JSON array) in SQLite — parse it
    // back to a string[] so callers see the same shape as Supabase.
    recovery_codes: parseJSON<string[]>(r.recovery_codes, null),
    locked_until: dateToISO(r.locked_until),
    last_login_at: dateToISO(r.last_login_at),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapPartnerRow(r: any): Partner {
  return {
    ...r,
    tags: parseJSON<string[]>(r.tags, []),
    kyc_data: parseJSON<Record<string, unknown>>(r.kyc_data, null),
    kyc_reviewed_at: dateToISO(r.kyc_reviewed_at),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapProductRow(r: any): Product {
  return {
    ...r,
    attributes: parseJSON<Record<string, unknown>>(r.attributes, null),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapDealRow(r: any): Deal {
  return {
    ...r,
    tags: parseJSON<string[]>(r.tags, []),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
    expected_close: dateToISO(r.expected_close),
    closed_at: dateToISO(r.closed_at),
  };
}

function mapOfferRow(r: any): Offer {
  return {
    ...r,
    items: parseJSON<Offer["items"]>(r.items, []),
    terms: parseJSON<Record<string, unknown>>(r.terms, null),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
    valid_until: dateToISO(r.valid_until),
    sent_at: dateToISO(r.sent_at),
    accepted_at: dateToISO(r.accepted_at),
    rejected_at: dateToISO(r.rejected_at),
    // Trade / import fields (defaults for existing rows)
    offer_no: r.offer_no ?? null,
    bank_details: r.bank_details ?? null,
    pol: r.pol ?? null,
    pod: r.pod ?? null,
    vessel: r.vessel ?? null,
    container_no: r.container_no ?? null,
    lead_time: r.lead_time ?? null,
    packaging: r.packaging ?? null,
    payment_terms: r.payment_terms ?? null,
    tax_clause: r.tax_clause ?? null,
    incoterm: r.incoterm ?? null,
    selling_price: r.selling_price ?? null,
  };
}

function mapDemandRow(r: any): Demand {
  return {
    ...r,
    items: parseJSON<Demand["items"]>(r.items, []),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
    closed_at: dateToISO(r.closed_at),
    // Trade / import fields (defaults for existing rows)
    product_id: r.product_id ?? null,
    product_name: r.product_name ?? null,
    target_price: r.target_price ?? null,
    is_new_product: r.is_new_product ?? false,
    source: r.source ?? null,
    auto_hints: r.auto_hints ?? null,
    buyer_bank: r.buyer_bank ?? null,
    destination: r.destination ?? null,
    needed_by: dateToISO(r.needed_by),
    payment_terms: r.payment_terms ?? null,
  };
}

function mapInvoiceRow(r: any): Invoice {
  return {
    ...r,
    items: parseJSON<Invoice["items"]>(r.items, []),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
    due_date: dateToISO(r.due_date),
    paid_at: dateToISO(r.paid_at),
    sent_at: dateToISO(r.sent_at),
  };
}

function mapProformaRow(r: any): Proforma {
  return {
    ...r,
    items: parseJSON<Proforma["items"]>(r.items, []),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
    valid_until: dateToISO(r.valid_until),
    paid_at: dateToISO(r.paid_at),
  };
}

function mapAuditLogRow(r: any): AuditLog {
  return {
    ...r,
    details: parseJSON<Record<string, unknown>>(r.details, null),
    created_at: dateToISOOrNow(r.created_at),
  };
}

function mapUserTaskRow(r: any): UserTask {
  return {
    ...r,
    due_date: dateToISO(r.due_date),
    completed_at: dateToISO(r.completed_at),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapDocumentRegisterRow(r: any): DocumentRegisterEntry {
  return {
    ...r,
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapRevisionRow(r: any): DocumentRevision {
  return {
    ...r,
    created_at: dateToISOOrNow(r.created_at),
  };
}

function mapSupplierOfferRow(r: any): SupplierOffer {
  return {
    ...r,
    specifications: parseJSON<Record<string, unknown>>(r.specifications, null),
    valid_until: dateToISO(r.valid_until),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapTradeCalcRow(r: any): TradeCalculation {
  return {
    ...r,
    cost_lines: parseJSON<TradeCalculation["cost_lines"]>(r.cost_lines, []),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapPortalAccessRow(r: any): PortalAccess {
  return {
    ...r,
    invited_at: dateToISO(r.invited_at),
    last_login: dateToISO(r.last_login),
    locked_until: dateToISO(r.locked_until),
    gps_verified_at: dateToISO(r.gps_verified_at),
    failed_attempts: r.failed_attempts ?? 0,
    token_version: r.token_version ?? 1,
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapKycRow(r: any): KycSubmission {
  return {
    ...r,
    data: parseJSON<Record<string, unknown>>(r.data, null),
    reviewed_at: dateToISO(r.reviewed_at),
    submitted_at: dateToISO(r.submitted_at),
    created_at: dateToISOOrNow(r.created_at),
    updated_at: dateToISOOrNow(r.updated_at),
  };
}

function mapNotificationRow(r: any): Notification {
  return {
    ...r,
    data: parseJSON<Record<string, unknown>>(r.data, null),
    read_at: dateToISO(r.read_at),
    created_at: dateToISOOrNow(r.created_at),
  };
}

// ─── PrismaStore ────────────────────────────────────────────────────────────

export class PrismaStore implements Store {

  // ─── Auth ───────────────────────────────────────────────────────────────

  async getUserByUsername(username: string): Promise<User | null> {
    // username is not @unique in the schema (tenants may share usernames),
    // so use findFirst instead of findUnique to avoid a Prisma validation error.
    const r = await db.user.findFirst({ where: { username } });
    return r ? mapUserRow(r) : null;
  }

  async getUserById(id: string): Promise<User | null> {
    const r = await db.user.findUnique({ where: { id } });
    return r ? mapUserRow(r) : null;
  }

  async listUsers(_tenantId: string): Promise<User[]> {
    const rows = await db.user.findMany({ orderBy: { created_at: "desc" } });
    return rows.map(mapUserRow);
  }

  async upsertUser(u: Partial<User> & { id?: string }): Promise<User> {
    // Only set fields that are explicitly provided. Previously this method
    // always wrote every column (defaulting missing ones to "" / null / 0),
    // which clobbered password_hash when callers did partial updates like
    // { id, failed_attempts, locked_until }. Now undefined fields are skipped.
    const data: Record<string, unknown> = {};
    if (u.username !== undefined) data.username = u.username;
    if (u.email !== undefined) data.email = u.email;
    if (u.full_name !== undefined) data.full_name = u.full_name;
    if (u.role !== undefined) data.role = u.role;
    if (u.permissions !== undefined) data.permissions = stringifyJSON(u.permissions);
    if (u.password_hash !== undefined) data.password_hash = u.password_hash;
    if (u.totp_secret !== undefined) data.totp_secret = u.totp_secret;
    if (u.totp_enabled !== undefined) data.totp_enabled = u.totp_enabled;
    // recovery_codes (string[] | null) is persisted as TEXT (JSON array) —
    // SQLite has no native JSON column type. stringifyJSON(null) returns
    // null, which clears the column on disable / recovery.
    if (u.recovery_codes !== undefined) data.recovery_codes = stringifyJSON(u.recovery_codes);
    if (u.locked_until !== undefined) data.locked_until = u.locked_until ? new Date(u.locked_until) : null;
    if (u.failed_attempts !== undefined) data.failed_attempts = u.failed_attempts;
    if (u.last_login_at !== undefined) data.last_login_at = u.last_login_at ? new Date(u.last_login_at) : null;
    if (u.last_login_ip !== undefined) data.last_login_ip = u.last_login_ip;
    if (u.last_login_country !== undefined) data.last_login_country = u.last_login_country;
    if (u.must_change_password !== undefined) data.must_change_password = u.must_change_password;
    if (u.token_version !== undefined) data.token_version = u.token_version;
    if (u.signature !== undefined) data.signature = u.signature;
    if (u.notif_prefs !== undefined) data.notif_prefs = stringifyJSON(u.notif_prefs);
    if (u.active !== undefined) data.active = u.active;
    if (u.tenant_id !== undefined) data.tenant_id = u.tenant_id;

    let r;
    if (u.id) {
      r = await db.user.update({ where: { id: u.id }, data });
    } else {
      r = await db.user.create({ data });
    }
    return mapUserRow(r);
  }

  async deleteUser(id: string): Promise<void> {
    await db.user.delete({ where: { id } });
  }

  // GDPR Article 17 — no-op in the prisma store (no audit_logs table mapped
  // in the prisma schema). Returns 0 so the user-deletion cascade can invoke
  // this unconditionally across all store implementations. If/when the prisma
  // schema gains an audit_logs model, this should issue the same pseudonymising
  // UPDATE as the Supabase store (or call the same RPC if the prisma backend
  // is pointed at the same Postgres DB).
  async anonymizeUserAuditLogs(_userId: string): Promise<number> {
    return 0;
  }

  async updateUserLastLogin(id: string, ip: string): Promise<void> {
    await db.user.update({
      where: { id },
      data: { last_login_at: new Date(), last_login_ip: ip },
    });
  }

  async bumpUserTokenVersion(id: string): Promise<number> {
    const u = await db.user.update({
      where: { id },
      data: { token_version: { increment: 1 } },
    });
    return u.token_version;
  }

  // ─── Partners ───────────────────────────────────────────────────────────

  async listPartners(_tenantId: string, params?: ListParams): Promise<ListResult<Partner>> {
    let where: any = {};
    if (params?.filters?.status) where.status = params.filters.status;
    if (params?.filters?.type) where.type = params.filters.type;
    if (params?.search) {
      where.OR = [
        { name: { contains: params.search } },
        { email: { contains: params.search } },
        { contact_name: { contains: params.search } },
      ];
    }
    const total = await db.partner.count({ where });
    const rows = await db.partner.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapPartnerRow), total };
  }

  async getPartner(id: string): Promise<Partner | null> {
    const r = await db.partner.findUnique({ where: { id } });
    return r ? mapPartnerRow(r) : null;
  }

  async upsertPartner(p: Partial<Partner> & { id?: string }): Promise<Partner> {
    const data: any = {
      tenant_id: p.tenant_id ?? "",
      name: p.name ?? "",
      entity_type: p.entity_type ?? "company",
      type: p.type ?? "both",
      email: p.email ?? null,
      phone: p.phone ?? null,
      website: p.website ?? null,
      tax_id: p.tax_id ?? null,
      vat_number: p.vat_number ?? null,
      registration_number: p.registration_number ?? null,
      address_line: p.address_line ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      postal_code: p.postal_code ?? null,
      country: p.country ?? null,
      contact_name: p.contact_name ?? null,
      contact_email: p.contact_email ?? null,
      contact_phone: p.contact_phone ?? null,
      bank_name: p.bank_name ?? null,
      bank_account: p.bank_account ?? null,
      bank_swift: p.bank_swift ?? null,
      bank_iban: p.bank_iban ?? null,
      preferred_currency: p.preferred_currency ?? null,
      preferred_incoterm: p.preferred_incoterm ?? null,
      preferred_payment_terms: p.preferred_payment_terms ?? null,
      status: p.status ?? "active",
      risk_score: p.risk_score ?? 0,
      notes: p.notes ?? null,
      tags: stringifyJSON(p.tags),
      portal_enabled: p.portal_enabled ?? false,
      portal_token: p.portal_token ?? null,
      portal_level: p.portal_level ?? "none",
      kyc_status: p.kyc_status ?? "not_submitted",
      kyc_data: stringifyJSON(p.kyc_data),
      kyc_reviewed_by: p.kyc_reviewed_by ?? null,
      kyc_reviewed_at: p.kyc_reviewed_at ? new Date(p.kyc_reviewed_at) : null,
    };
    let r;
    if (p.id) {
      r = await db.partner.update({ where: { id: p.id }, data });
    } else {
      r = await db.partner.create({ data });
    }
    return mapPartnerRow(r);
  }

  async deletePartner(id: string): Promise<void> {
    await db.partner.delete({ where: { id } });
  }

  // ─── Products ───────────────────────────────────────────────────────────

  async listProducts(_tenantId: string, params?: ListParams): Promise<ListResult<Product>> {
    let where: any = {};
    if (params?.search) {
      where.OR = [
        { name: { contains: params.search } },
        { sku: { contains: params.search } },
      ];
    }
    const total = await db.product.count({ where });
    const rows = await db.product.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapProductRow), total };
  }

  async getProduct(id: string): Promise<Product | null> {
    const r = await db.product.findUnique({ where: { id } });
    return r ? mapProductRow(r) : null;
  }

  async upsertProduct(p: Partial<Product> & { id?: string }): Promise<Product> {
    const data: any = {
      sku: p.sku ?? "",
      name: p.name ?? "",
      description: p.description ?? null,
      category: p.category ?? null,
      unit: p.unit ?? "pcs",
      price: p.price ?? 0,
      currency: p.currency ?? "EUR",
      cost: p.cost ?? null,
      stock: p.stock ?? 0,
      reorder_level: p.reorder_level ?? 0,
      active: p.active ?? true,
      attributes: stringifyJSON(p.attributes),
    };
    let r;
    if (p.id) {
      r = await db.product.update({ where: { id: p.id }, data });
    } else {
      r = await db.product.create({ data });
    }
    return mapProductRow(r);
  }

  async deleteProduct(id: string): Promise<void> {
    await db.product.delete({ where: { id } });
  }

  // ─── Deals ──────────────────────────────────────────────────────────────

  async listDeals(_tenantId: string, params?: ListParams): Promise<ListResult<Deal>> {
    let where: any = {};
    if (params?.filters?.stage) where.stage = params.filters.stage;
    if (params?.search) {
      where.OR = [
        { title: { contains: params.search } },
      ];
    }
    const total = await db.deal.count({ where });
    const rows = await db.deal.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapDealRow), total };
  }

  async getDeal(id: string): Promise<Deal | null> {
    const r = await db.deal.findUnique({ where: { id } });
    return r ? mapDealRow(r) : null;
  }

  async upsertDeal(d: Partial<Deal> & { id?: string }): Promise<Deal> {
    const data: any = {
      tenant_id: d.tenant_id ?? "",
      partner_id: d.partner_id ?? "",
      owner_id: d.owner_id ?? "",
      title: d.title ?? "",
      stage: d.stage ?? "lead",
      value: d.value ?? 0,
      currency: d.currency ?? "EUR",
      probability: d.probability ?? 0,
      expected_close: d.expected_close ? new Date(d.expected_close) : null,
      closed_at: d.closed_at ? new Date(d.closed_at) : null,
      description: d.description ?? null,
      tags: stringifyJSON(d.tags),
    };
    let r;
    if (d.id) {
      r = await db.deal.update({ where: { id: d.id }, data });
    } else {
      r = await db.deal.create({ data });
    }
    return mapDealRow(r);
  }

  async deleteDeal(id: string): Promise<void> {
    await db.deal.delete({ where: { id } });
  }

  // ─── Offers ─────────────────────────────────────────────────────────────

  async listOffers(_tenantId: string, params?: ListParams): Promise<ListResult<Offer>> {
    let where: any = {};
    if (params?.filters?.partner_id) where.partner_id = params.filters.partner_id;
    if (params?.filters?.status) where.status = params.filters.status;
    if (params?.search) {
      where.OR = [
        { number: { contains: params.search } },
        { title: { contains: params.search } },
      ];
    }
    const total = await db.offer.count({ where });
    const rows = await db.offer.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapOfferRow), total };
  }

  async getOffer(id: string): Promise<Offer | null> {
    const r = await db.offer.findUnique({ where: { id } });
    return r ? mapOfferRow(r) : null;
  }

  async upsertOffer(o: Partial<Offer> & { id?: string }): Promise<Offer> {
    const data: any = {
      tenant_id: o.tenant_id ?? "",
      partner_id: o.partner_id ?? "",
      owner_id: o.owner_id ?? "",
      number: o.number ?? "",
      title: o.title ?? null,
      status: o.status ?? "draft",
      subtotal: o.subtotal ?? 0,
      discount_total: o.discount_total ?? 0,
      tax_total: o.tax_total ?? 0,
      total: o.total ?? 0,
      currency: o.currency ?? "EUR",
      items: stringifyJSON(o.items) ?? "[]",
      terms: stringifyJSON(o.terms),
      valid_until: o.valid_until ? new Date(o.valid_until) : null,
      sent_at: o.sent_at ? new Date(o.sent_at) : null,
      accepted_at: o.accepted_at ? new Date(o.accepted_at) : null,
      rejected_at: o.rejected_at ? new Date(o.rejected_at) : null,
      notes: o.notes ?? null,
      // Trade / import fields
      offer_no: o.offer_no ?? null,
      bank_details: o.bank_details ?? null,
      pol: o.pol ?? null,
      pod: o.pod ?? null,
      vessel: o.vessel ?? null,
      container_no: o.container_no ?? null,
      lead_time: o.lead_time ?? null,
      packaging: o.packaging ?? null,
      payment_terms: o.payment_terms ?? null,
      tax_clause: o.tax_clause ?? null,
      incoterm: o.incoterm ?? null,
      selling_price: o.selling_price ?? null,
    };
    let r;
    if (o.id) {
      r = await db.offer.update({ where: { id: o.id }, data });
    } else {
      r = await db.offer.create({ data });
    }
    return mapOfferRow(r);
  }

  async deleteOffer(id: string): Promise<void> {
    await db.offer.delete({ where: { id } });
  }

  // ─── Demands ────────────────────────────────────────────────────────────

  async listDemands(_tenantId: string, params?: ListParams): Promise<ListResult<Demand>> {
    let where: any = {};
    if (params?.filters?.status) where.status = params.filters.status;
    if (params?.search) {
      where.OR = [
        { number: { contains: params.search } },
        { subject: { contains: params.search } },
      ];
    }
    const total = await db.demand.count({ where });
    const rows = await db.demand.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapDemandRow), total };
  }

  async getDemand(id: string): Promise<Demand | null> {
    const r = await db.demand.findUnique({ where: { id } });
    return r ? mapDemandRow(r) : null;
  }

  async upsertDemand(d: Partial<Demand> & { id?: string }): Promise<Demand> {
    const data: any = {
      tenant_id: d.tenant_id ?? "",
      partner_id: d.partner_id ?? "",
      number: d.number ?? "",
      subject: d.subject ?? "",
      status: d.status ?? "open",
      priority: d.priority ?? "medium",
      description: d.description ?? null,
      requested_delivery: d.requested_delivery ? new Date(d.requested_delivery) : null,
      currency: d.currency ?? "EUR",
      items: stringifyJSON(d.items) ?? "[]",
      // Trade / import fields
      product_id: d.product_id ?? null,
      product_name: d.product_name ?? null,
      target_price: d.target_price ?? null,
      is_new_product: d.is_new_product ?? false,
      source: d.source ?? null,
      auto_hints: d.auto_hints ?? null,
      buyer_bank: d.buyer_bank ?? null,
      destination: d.destination ?? null,
      needed_by: d.needed_by ? new Date(d.needed_by) : null,
      payment_terms: d.payment_terms ?? null,
    };
    let r;
    if (d.id) {
      r = await db.demand.update({ where: { id: d.id }, data });
    } else {
      r = await db.demand.create({ data });
    }
    return mapDemandRow(r);
  }

  async deleteDemand(id: string): Promise<void> {
    await db.demand.delete({ where: { id } });
  }

  // ─── Invoices ───────────────────────────────────────────────────────────

  async listInvoices(tenantId: string, params?: ListParams): Promise<ListResult<Invoice>> {
    let where: any = { tenant_id: tenantId };
    if (params?.filters?.status) where.status = params.filters.status;
    if (params?.filters?.partner_id) where.partner_id = params.filters.partner_id;
    if (params?.search) {
      where.OR = [
        { number: { contains: params.search } },
      ];
    }
    const total = await db.invoice.count({ where });
    const rows = await db.invoice.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapInvoiceRow), total };
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const r = await db.invoice.findUnique({ where: { id } });
    return r ? mapInvoiceRow(r) : null;
  }

  async upsertInvoice(i: Partial<Invoice> & { id?: string }): Promise<Invoice> {
    const data: any = {
      tenant_id: i.tenant_id ?? "",
      partner_id: i.partner_id ?? "",
      offer_id: i.offer_id ?? null,
      number: i.number ?? "",
      status: i.status ?? "draft",
      subtotal: i.subtotal ?? 0,
      discount_total: i.discount_total ?? 0,
      tax_total: i.tax_total ?? 0,
      total: i.total ?? 0,
      currency: i.currency ?? "EUR",
      items: stringifyJSON(i.items) ?? "[]",
      due_date: i.due_date ? new Date(i.due_date) : null,
      paid_at: i.paid_at ? new Date(i.paid_at) : null,
      sent_at: i.sent_at ? new Date(i.sent_at) : null,
      notes: i.notes ?? null,
      payment_terms: i.payment_terms ?? null,
    };
    let r;
    if (i.id) {
      r = await db.invoice.update({ where: { id: i.id }, data });
    } else {
      r = await db.invoice.create({ data });
    }
    return mapInvoiceRow(r);
  }

  async deleteInvoice(id: string): Promise<void> {
    await db.invoice.delete({ where: { id } });
  }

  // ─── Proformas ──────────────────────────────────────────────────────────

  async listProformas(tenantId: string, params?: ListParams): Promise<ListResult<Proforma>> {
    let where: any = { tenant_id: tenantId };
    if (params?.filters?.status) where.status = params.filters.status;
    if (params?.search) {
      where.OR = [
        { number: { contains: params.search } },
      ];
    }
    const total = await db.proforma.count({ where });
    const rows = await db.proforma.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapProformaRow), total };
  }

  async getProforma(id: string): Promise<Proforma | null> {
    const r = await db.proforma.findUnique({ where: { id } });
    return r ? mapProformaRow(r) : null;
  }

  async upsertProforma(p: Partial<Proforma> & { id?: string }): Promise<Proforma> {
    const data: any = {
      tenant_id: p.tenant_id ?? "",
      partner_id: p.partner_id ?? "",
      offer_id: p.offer_id ?? null,
      number: p.number ?? "",
      status: p.status ?? "draft",
      subtotal: p.subtotal ?? 0,
      discount_total: p.discount_total ?? 0,
      tax_total: p.tax_total ?? 0,
      total: p.total ?? 0,
      currency: p.currency ?? "EUR",
      items: stringifyJSON(p.items) ?? "[]",
      valid_until: p.valid_until ? new Date(p.valid_until) : null,
      paid_at: p.paid_at ? new Date(p.paid_at) : null,
      payment_terms: p.payment_terms ?? "net30",
      notes: p.notes ?? null,
    };
    let r;
    if (p.id) {
      r = await db.proforma.update({ where: { id: p.id }, data });
    } else {
      r = await db.proforma.create({ data });
    }
    return mapProformaRow(r);
  }

  async deleteProforma(id: string): Promise<void> {
    await db.proforma.delete({ where: { id } });
  }

  // ─── Shared Documents ───────────────────────────────────────────────────

  async listDocuments(_tenantId: string, params?: ListParams): Promise<ListResult<SharedDocument>> {
    let where: any = {};
    if (params?.search) {
      where.OR = [
        { filename: { contains: params.search } },
      ];
    }
    const total = await db.sharedDocument.count({ where });
    const rows = await db.sharedDocument.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at) })), total };
  }
  async getDocument(id: string): Promise<SharedDocument | null> {
    const row = await db.sharedDocument.findUnique({ where: { id } });
    return row ? ({ ...row, created_at: dateToISOOrNow(row.created_at) } as SharedDocument) : null;
  }

  async upsertDocument(d: Partial<SharedDocument> & { id?: string }): Promise<SharedDocument> {
    const data: any = {
      tenant_id: d.tenant_id ?? "",
      partner_id: d.partner_id ?? null,
      uploaded_by: d.uploaded_by ?? null,
      filename: d.filename ?? "",
      file_type: d.file_type ?? null,
      file_size: d.file_size ?? null,
      url: d.url ?? null,
      category: d.category ?? null,
      visibility: d.visibility ?? "private",
      description: d.description ?? null,
    };
    let r;
    if (d.id) {
      r = await db.sharedDocument.update({ where: { id: d.id }, data });
    } else {
      r = await db.sharedDocument.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at) };
  }

  async deleteDocument(id: string): Promise<void> {
    await db.sharedDocument.delete({ where: { id } });
  }

  // ─── Document Register ──────────────────────────────────────────────────

  async listDocumentRegister(_tenantId: string, params?: ListParams): Promise<ListResult<DocumentRegisterEntry>> {
    let where: any = {};
    if (params?.search) {
      where.OR = [
        { title: { contains: params.search } },
        { doc_type: { contains: params.search } },
      ];
    }
    const total = await db.documentRegisterEntry.count({ where });
    const rows = await db.documentRegisterEntry.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapDocumentRegisterRow), total };
  }

  async upsertDocumentRegisterEntry(e: Partial<DocumentRegisterEntry> & { id?: string }): Promise<DocumentRegisterEntry> {
    const data: any = {
      tenant_id: e.tenant_id ?? "",
      partner_id: e.partner_id ?? null,
      doc_type: e.doc_type ?? "offer",
      source_id: e.source_id ?? null,
      title: e.title ?? "",
      version: e.version ?? 1,
      status: e.status ?? "current",
      file_url: e.file_url ?? null,
      created_by: e.created_by ?? null,
    };
    let r;
    if (e.id) {
      r = await db.documentRegisterEntry.update({ where: { id: e.id }, data });
    } else {
      r = await db.documentRegisterEntry.create({ data });
    }
    return mapDocumentRegisterRow(r);
  }

  async listDocumentRevisions(documentId: string): Promise<DocumentRevision[]> {
    const rows = await db.documentRevision.findMany({
      where: { document_id: documentId },
      orderBy: { created_at: "desc" },
    });
    return rows.map(mapRevisionRow);
  }

  async addDocumentRevision(r: Partial<DocumentRevision> & { id?: string }): Promise<DocumentRevision> {
    const row = await db.documentRevision.create({
      data: {
        document_id: r.document_id ?? "",
        version: r.version ?? 1,
        file_url: r.file_url ?? null,
        change_summary: r.change_summary ?? null,
        created_by: r.created_by ?? null,
      },
    });
    return mapRevisionRow(row);
  }

  async deleteDocumentRegisterEntry(id: string): Promise<void> {
    await db.documentRegisterEntry.delete({ where: { id } });
  }

  // ─── Audit ──────────────────────────────────────────────────────────────

  async listAudit(_tenantId: string, params?: ListParams): Promise<ListResult<AuditLog>> {
    let where: any = {};
    if (params?.search) {
      where.OR = [
        { action: { contains: params.search } },
        { username: { contains: params.search } },
      ];
    }
    const total = await db.auditLog.count({ where });
    const rows = await db.auditLog.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapAuditLogRow), total };
  }

  async appendAudit(entry: Omit<AuditLog, "id" | "created_at">): Promise<AuditLog> {
    const r = await db.auditLog.create({
      data: {
        user_id: entry.user_id ?? null,
        username: entry.username ?? null,
        action: entry.action,
        entity_type: entry.entity_type ?? null,
        entity_id: entry.entity_id ?? null,
        details: stringifyJSON(entry.details),
        ip: entry.ip ?? null,
        user_agent: entry.user_agent ?? null,
      },
    });
    return mapAuditLogRow(r);
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  async getSetting<T = unknown>(key: string, tenantId: string | null = null): Promise<T | null> {
    // Prisma schema might not have tenant_id in the composite key. Best-effort:
    // include it in the key name so tenants don't collide. Callers that need
    // real DB-level scoping should be on SupabaseStore.
    const scopedKey = tenantId ? `${tenantId}::${key}` : key;
    const r = await db.setting.findUnique({ where: { key: scopedKey } });
    if (!r) return null;
    try { return JSON.parse(r.value as string) as T; } catch { return r.value as unknown as T; }
  }

  async setSetting(key: string, value: unknown, tenantId: string | null = null): Promise<void> {
    const val = typeof value === "string" ? value : JSON.stringify(value);
    const scopedKey = tenantId ? `${tenantId}::${key}` : key;
    await db.setting.upsert({
      where: { key: scopedKey },
      update: { value: val },
      create: { key: scopedKey, value: val },
    });
  }

  async getAllSettings(tenantId: string | null = null): Promise<Setting[]> {
    const prefix = tenantId ? `${tenantId}::` : null;
    const rows = await db.setting.findMany({
      where: prefix ? { key: { startsWith: prefix } } : {},
    });
    return rows
      .filter((r: any) => (prefix ? true : !r.key.includes("::")))
      .map((r: any) => ({
        ...r,
        key: prefix ? r.key.slice(prefix.length) : r.key,
        tenant_id: tenantId,
        created_at: dateToISOOrNow(r.created_at),
        updated_at: dateToISOOrNow(r.updated_at),
      }));
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  async listTasks(_tenantId: string, userId?: string): Promise<UserTask[]> {
    const where: any = userId ? { assigned_to: userId } : {};
    const rows = await db.userTask.findMany({ where, orderBy: { created_at: "desc" } });
    return rows.map(mapUserTaskRow);
  }

  async upsertTask(t: Partial<UserTask> & { id?: string }): Promise<UserTask> {
    const data: any = {
      tenant_id: t.tenant_id ?? "",
      title: t.title ?? "",
      description: t.description ?? null,
      assigned_to: t.assigned_to ?? null,
      priority: t.priority ?? "medium",
      status: t.status ?? "pending",
      due_date: t.due_date ? new Date(t.due_date) : null,
      completed_at: t.completed_at ? new Date(t.completed_at) : null,
      entity_type: t.entity_type ?? null,
      entity_id: t.entity_id ?? null,
    };
    let r;
    if (t.id) {
      r = await db.userTask.update({ where: { id: t.id }, data });
    } else {
      r = await db.userTask.create({ data });
    }
    return mapUserTaskRow(r);
  }

  async deleteTask(id: string): Promise<void> {
    await db.userTask.delete({ where: { id } });
  }

  // ─── Notes ──────────────────────────────────────────────────────────────

  async listNotes(_tenantId: string, entityType: string, entityId: string): Promise<EntityNote[]> {
    const rows = await db.entityNote.findMany({
      where: { entity_type: entityType, entity_id: entityId },
      orderBy: { created_at: "desc" },
    });
    return rows.map((r: any) => ({
      ...r,
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
    }));
  }

  async upsertNote(n: Partial<EntityNote> & { id?: string }): Promise<EntityNote> {
    const data: any = {
      entity_type: n.entity_type ?? "",
      entity_id: n.entity_id ?? "",
      user_id: n.user_id ?? null,
      content: n.content ?? "",
    };
    let r;
    if (n.id) {
      r = await db.entityNote.update({ where: { id: n.id }, data });
    } else {
      r = await db.entityNote.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteNote(id: string): Promise<void> {
    await db.entityNote.delete({ where: { id } });
  }

  // ─── Inventory ──────────────────────────────────────────────────────────

  async listInventory(_tenantId: string, partnerId: string): Promise<InventoryMovement[]> {
    const rows = await db.inventoryMovement.findMany({
      where: { partner_id: partnerId },
      orderBy: { created_at: "desc" },
    });
    return rows.map((r: any) => ({
      ...r,
      created_at: dateToISOOrNow(r.created_at),
    }));
  }

  async listAllInventory(_tenantId: string, params?: ListParams): Promise<ListResult<InventoryMovement>> {
    let where: any = {};
    const total = await db.inventoryMovement.count({ where });
    const rows = await db.inventoryMovement.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at) })), total };
  }

  async addInventoryMovement(m: Partial<InventoryMovement> & { id?: string }): Promise<InventoryMovement> {
    const r = await db.inventoryMovement.create({
      data: {
        tenant_id: m.tenant_id ?? "",
        product_id: m.product_id ?? "",
        partner_id: m.partner_id ?? "",
        type: m.type ?? "inbound",
        quantity: m.quantity ?? 0,
        delta: m.delta ?? 0,
        reference: m.reference ?? null,
        notes: m.notes ?? null,
      },
    });
    return { ...r, created_at: dateToISOOrNow(r.created_at) };
  }

  // ─── Vault ──────────────────────────────────────────────────────────────

  async listVault(_tenantId: string, params?: ListParams): Promise<ListResult<VaultSecret>> {
    let where: any = {};
    if (params?.search) {
      where.OR = [{ name: { contains: params.search } }];
    }
    const total = await db.vaultSecret.count({ where });
    const rows = await db.vaultSecret.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) })), total };
  }

  async upsertVaultSecret(s: Partial<VaultSecret> & { id?: string }): Promise<VaultSecret> {
    const data: any = {
      tenant_id: s.tenant_id ?? "",
      name: s.name ?? "",
      type: s.type ?? "other",
      value_encrypted: s.value_encrypted ?? "",
      metadata: s.metadata ?? null,
    };
    let r;
    if (s.id) {
      r = await db.vaultSecret.update({ where: { id: s.id }, data });
    } else {
      r = await db.vaultSecret.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteVaultSecret(id: string): Promise<void> {
    await db.vaultSecret.delete({ where: { id } });
  }

  // ─── API Keys ───────────────────────────────────────────────────────────

  async listApiKeys(_tenantId: string): Promise<ApiKey[]> {
    const rows = await db.apiKey.findMany({ orderBy: { created_at: "desc" } });
    return rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) }));
  }

  async upsertApiKey(k: Partial<ApiKey> & { id?: string }): Promise<ApiKey> {
    const data: any = {
      tenant_id: k.tenant_id ?? "",
      name: k.name ?? "",
      key_hash: k.key_hash ?? "",
      prefix: k.prefix ?? "",
      permissions: stringifyJSON(k.permissions),
      last_used_at: k.last_used_at ? new Date(k.last_used_at) : null,
      expires_at: k.expires_at ? new Date(k.expires_at) : null,
      active: k.active ?? true,
    };
    let r;
    if (k.id) {
      r = await db.apiKey.update({ where: { id: k.id }, data });
    } else {
      r = await db.apiKey.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteApiKey(id: string): Promise<void> {
    await db.apiKey.delete({ where: { id } });
  }
  async authenticateApiKey(_rawKey: string): Promise<{ apiKey: ApiKey; tenantId: string } | null> { return null; }
  async updateApiKeyLastUsed(_id: string, _ip: string): Promise<void> {}

  // ─── Webhooks ───────────────────────────────────────────────────────────

  async listWebhooks(_tenantId: string): Promise<Webhook[]> {
    const rows = await db.webhook.findMany({ orderBy: { created_at: "desc" } });
    return rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) }));
  }

  async upsertWebhook(w: Partial<Webhook> & { id?: string }): Promise<Webhook> {
    const data: any = {
      tenant_id: w.tenant_id ?? "",
      name: w.name ?? "",
      url: w.url ?? "",
      events: stringifyJSON(w.events) ?? "[]",
      secret: w.secret ?? null,
      active: w.active ?? true,
      last_triggered_at: w.last_triggered_at ? new Date(w.last_triggered_at) : null,
    };
    let r;
    if (w.id) {
      r = await db.webhook.update({ where: { id: w.id }, data });
    } else {
      r = await db.webhook.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteWebhook(id: string): Promise<void> {
    await db.webhook.delete({ where: { id } });
  }
  async getWebhookById(id: string, _tenantId?: string): Promise<Webhook | null> {
    const r: any = await db.webhook.findUnique({ where: { id } });
    if (!r) return null;
    return { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  // ─── Webhook deliveries (legacy stubs — PrismaStore is deprecated) ──────
  // Production uses SupabaseStore. These throw so any caller accidentally
  // hitting the legacy path fails loudly instead of silently dropping
  // deliveries.
  async createWebhookDelivery(_d: any): Promise<any> {
    throw new Error("PrismaStore does not support webhook deliveries — use DB_BACKEND=supabase");
  }
  async updateWebhookDelivery(_id: string, _patch: any): Promise<void> {
    throw new Error("PrismaStore does not support webhook deliveries — use DB_BACKEND=supabase");
  }
  async listWebhookDeliveries(_tenantId: string, _webhookId?: string, _limit?: number): Promise<any[]> {
    return [];
  }
  async listFailedWebhookDeliveries(_limit?: number): Promise<any[]> {
    return [];
  }
  async getWebhookDelivery(_id: string): Promise<any | null> {
    return null;
  }

  // ─── Security ───────────────────────────────────────────────────────────

  async listSessions(_tenantId: string, userId?: string): Promise<SecuritySession[]> {
    const where: any = userId ? { user_id: userId } : {};
    const rows = await db.securitySession.findMany({ where, orderBy: { created_at: "desc" } });
    return rows.map((r: any) => ({
      ...r,
      last_used_at: dateToISO(r.last_used_at),
      expires_at: dateToISO(r.expires_at),
      created_at: dateToISOOrNow(r.created_at),
    }));
  }

  async revokeSession(id: string): Promise<void> {
    await db.securitySession.update({ where: { id }, data: { revoked: true, current: false } });
  }

  async revokeSessionById(id: string): Promise<void> {
    await db.securitySession.update({ where: { id }, data: { revoked: true, current: false } });
  }

  async createSession(s: { user_id: string; ip?: string | null; user_agent?: string | null; country?: string | null; expires_at: string; current?: boolean }): Promise<SecuritySession> {
    // If current=true, unset any other current sessions for this user first
    if (s.current) {
      await db.securitySession.updateMany({ where: { user_id: s.user_id, current: true }, data: { current: false } });
    }
    const r = await db.securitySession.create({
      data: {
        user_id: s.user_id,
        ip: s.ip ?? null,
        user_agent: s.user_agent ?? null,
        country: s.country ?? null,
        expires_at: new Date(s.expires_at),
        current: s.current ?? false,
        revoked: false,
        last_used_at: new Date(),
      },
    });
    return { ...r, last_used_at: dateToISO(r.last_used_at), expires_at: dateToISO(r.expires_at), created_at: dateToISOOrNow(r.created_at) };
  }

  async touchSession(id: string): Promise<void> {
    try {
      await db.securitySession.update({ where: { id }, data: { last_used_at: new Date() } });
    } catch { /* session may not exist — ignore */ }
  }

  async listLoginHistory(_tenantId: string, userId?: string, limit?: number): Promise<LoginHistoryEntry[]> {
    const where: any = userId ? { user_id: userId } : {};
    const rows = await db.loginHistoryEntry.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit ?? 50,
    });
    return rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at) }));
  }

  async recordLoginHistory(e: { user_id: string; username: string; ip?: string | null; user_agent?: string | null; country?: string | null; success: boolean; reason?: string | null }): Promise<LoginHistoryEntry> {
    const r = await db.loginHistoryEntry.create({
      data: {
        user_id: e.user_id,
        username: e.username,
        ip: e.ip ?? null,
        user_agent: e.user_agent ?? null,
        country: e.country ?? null,
        success: e.success,
        reason: e.reason ?? null,
      },
    });
    return { ...r, created_at: dateToISOOrNow(r.created_at) };
  }

  async listKnownIps(_tenantId: string, userId?: string): Promise<KnownIp[]> {
    const where: any = userId ? { user_id: userId } : {};
    const rows = await db.knownIp.findMany({ where, orderBy: { last_seen: "desc" } });
    return rows.map((r: any) => ({ ...r, first_seen: dateToISOOrNow(r.first_seen), last_seen: dateToISOOrNow(r.last_seen) }));
  }

  async trustIp(id: string, trusted: boolean): Promise<void> {
    await db.knownIp.update({ where: { id }, data: { trusted } });
  }

  async forgetIp(id: string): Promise<void> {
    await db.knownIp.delete({ where: { id } });
  }

  async upsertKnownIp(ip: { user_id: string; ip: string; country?: string | null; trusted?: boolean }): Promise<KnownIp> {
    // Find existing by user_id + ip
    const existing = await db.knownIp.findFirst({ where: { user_id: ip.user_id, ip: ip.ip } });
    if (existing) {
      const r = await db.knownIp.update({
        where: { id: existing.id },
        data: {
          last_seen: new Date(),
          country: ip.country ?? existing.country,
          trusted: ip.trusted ?? existing.trusted,
        },
      });
      return { ...r, first_seen: dateToISOOrNow(r.first_seen), last_seen: dateToISOOrNow(r.last_seen) };
    }
    const r = await db.knownIp.create({
      data: {
        user_id: ip.user_id,
        ip: ip.ip,
        country: ip.country ?? null,
        trusted: ip.trusted ?? false,
      },
    });
    return { ...r, first_seen: dateToISOOrNow(r.first_seen), last_seen: dateToISOOrNow(r.last_seen) };
  }

  async listTrustedDevices(_tenantId: string, userId?: string): Promise<TrustedDevice[]> {
    const where: any = userId ? { user_id: userId } : {};
    const rows = await db.trustedDevice.findMany({ where, orderBy: { created_at: "desc" } });
    return rows.map((r: any) => ({ ...r, last_used: dateToISOOrNow(r.last_used), created_at: dateToISOOrNow(r.created_at) }));
  }

  async revokeTrustedDevice(id: string): Promise<void> {
    await db.trustedDevice.update({ where: { id }, data: { revoked: true } });
  }

  async revokeTrustedDeviceById(id: string): Promise<void> {
    await db.trustedDevice.update({ where: { id }, data: { revoked: true } });
  }

  async upsertTrustedDevice(d: { user_id: string; device_name: string; fingerprint: string; ip?: string | null }): Promise<TrustedDevice> {
    const existing = await db.trustedDevice.findFirst({ where: { user_id: d.user_id, fingerprint: d.fingerprint } });
    if (existing) {
      const r = await db.trustedDevice.update({
        where: { id: existing.id },
        data: { last_used: new Date(), ip: d.ip ?? existing.ip, device_name: d.device_name || existing.device_name },
      });
      return { ...r, last_used: dateToISOOrNow(r.last_used), created_at: dateToISOOrNow(r.created_at) };
    }
    const r = await db.trustedDevice.create({
      data: {
        user_id: d.user_id,
        device_name: d.device_name,
        fingerprint: d.fingerprint,
        ip: d.ip ?? null,
      },
    });
    return { ...r, last_used: dateToISOOrNow(r.last_used), created_at: dateToISOOrNow(r.created_at) };
  }

  // ─── Mail Queue ─────────────────────────────────────────────────────────

  async listMailQueue(_tenantId: string, params?: ListParams): Promise<ListResult<MailQueueEntry>> {
    let where: any = {};
    if (params?.search) {
      where.OR = [{ to: { contains: params.search } }, { subject: { contains: params.search } }];
    }
    const total = await db.mailQueueEntry.count({ where });
    const rows = await db.mailQueueEntry.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at), sent_at: dateToISO(r.sent_at), updated_at: dateToISOOrNow(r.updated_at) })), total };
  }

  async upsertMailQueueEntry(m: Partial<MailQueueEntry> & { id?: string }): Promise<MailQueueEntry> {
    const data: any = {
      tenant_id: m.tenant_id ?? "",
      to: m.to ?? "",
      subject: m.subject ?? "",
      body: m.body ?? null,
      template: m.template ?? null,
      template_data: stringifyJSON(m.template_data),
      status: m.status ?? "queued",
      provider: m.provider ?? null,
      provider_id: m.provider_id ?? null,
      error: m.error ?? null,
      sent_at: m.sent_at ? new Date(m.sent_at) : null,
    };
    let r;
    if (m.id) {
      r = await db.mailQueueEntry.update({ where: { id: m.id }, data });
    } else {
      r = await db.mailQueueEntry.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at), sent_at: dateToISO(r.sent_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteMailQueueEntry(id: string): Promise<void> {
    await db.mailQueueEntry.delete({ where: { id } });
  }

  // ─── Tenants ────────────────────────────────────────────────────────────

  async listTenants(): Promise<Tenant[]> {
    const rows = await db.tenant.findMany({ orderBy: { created_at: "desc" } });
    return rows.map((r: any) => ({ ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) }));
  }

  async getTenant(id: string): Promise<Tenant | null> {
    const r = await db.tenant.findUnique({ where: { id } });
    return r ? { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) } : null;
  }

  async upsertTenant(t: Partial<Tenant> & { id?: string }): Promise<Tenant> {
    const data: any = {
      name: t.name ?? "",
      legal_name: t.legal_name ?? null,
      country: t.country ?? null,
      currency: t.currency ?? "EUR",
      tax_id: t.tax_id ?? null,
      vat_number: t.vat_number ?? null,
      registration_number: t.registration_number ?? null,
      address_line: t.address_line ?? null,
      city: t.city ?? null,
      postal_code: t.postal_code ?? null,
      bank_name: t.bank_name ?? null,
      bank_iban: t.bank_iban ?? null,
      bank_swift: t.bank_swift ?? null,
      logo_url: t.logo_url ?? null,
      primary_color: t.primary_color ?? null,
      plan: t.plan ?? "trial",
      status: t.status ?? "active",
      max_users: t.max_users ?? 5,
    };
    let r;
    if (t.id) {
      r = await db.tenant.update({ where: { id: t.id }, data });
    } else {
      r = await db.tenant.create({ data });
    }
    return { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteTenant(id: string): Promise<void> {
    await db.tenant.delete({ where: { id } });
  }
  // P3 / task C-8 — atomic tenant status transition. Prisma's
  // `updateMany({ where: { id, status: { in: fromStatuses } }, data })`
  // returns `{ count }` — count=1 means the transition happened, count=0
  // means the tenant was not in any of `fromStatuses` (or doesn't exist).
  // We then re-fetch the row to return the full updated object. The
  // updateMany + the row lock Prisma acquires make this atomic w.r.t.
  // concurrent calls — only one of two concurrent calls will get count=1.
  async atomicTenantStatusTransition(
    tenantId: string,
    fromStatuses: string[],
    toStatus: string,
    patch?: Partial<Tenant>,
  ): Promise<Tenant | null> {
    if (!tenantId || !fromStatuses || fromStatuses.length === 0) return null;
    const data: any = { status: toStatus, updated_at: new Date() };
    if (patch) {
      const { id: _id, tenant_id: _tid, created_at: _ca, updated_at: _ua, status: _s, ...rest } = patch as any;
      void _id; void _tid; void _ca; void _ua; void _s;
      Object.assign(data, rest);
    }
    const result = await db.tenant.updateMany({
      where: { id: tenantId, status: { in: fromStatuses } },
      data,
    });
    if (result.count === 0) return null;
    const r = await db.tenant.findUnique({ where: { id: tenantId } });
    return r ? { ...r, created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) } : null;
  }
  // P0 / task C-1 — prisma-store stubs. The prisma schema's relational
  // `User` / `Tenant` models already cascade via Prisma's `onDelete:
  // Cascade` rules (set in schema.prisma), so the app-layer cascade is a
  // no-op here. Returning 0 / void lets the tenant / user DELETE routes
  // call these unconditionally across all store implementations.
  async countTenantDependencies(
    _tenantId: string,
  ): Promise<Record<string, number> & { total: number }> {
    return { total: 0 };
  }
  async deleteTenantCascade(_tenantId: string): Promise<void> {}
  async deleteUserCascade(_userId: string): Promise<void> {}

  // ─── Product Catalog ────────────────────────────────────────────────────

  async listProductCatalog(tenantId: string, params?: ListParams): Promise<ListResult<ProductCatalogEntry>> {
    let where: any = { tenant_id: tenantId };
    if (params?.search) {
      where.OR = [
        { name: { contains: params.search } },
        { hs_code: { contains: params.search } },
      ];
    }
    const total = await db.productCatalogEntry.count({ where });
    const rows = await db.productCatalogEntry.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map((r: any) => ({ ...r, specifications: parseJSON(r.specifications, null), created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) })), total };
  }

  async getProductCatalogEntry(id: string): Promise<ProductCatalogEntry | null> {
    const r = await db.productCatalogEntry.findUnique({ where: { id } });
    return r ? { ...r, specifications: parseJSON(r.specifications, null), created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) } : null;
  }

  async upsertProductCatalogEntry(p: Partial<ProductCatalogEntry> & { id?: string }): Promise<ProductCatalogEntry> {
    const data: any = {
      tenant_id: p.tenant_id ?? "",
      name: p.name ?? "",
      hs_code: p.hs_code ?? null,
      category: p.category ?? null,
      origin_country: p.origin_country ?? null,
      unit: p.unit ?? "MT",
      base_price: p.base_price ?? 0,
      currency: p.currency ?? "USD",
      specifications: stringifyJSON(p.specifications),
      active: p.active ?? true,
    };
    let r;
    if (p.id) {
      r = await db.productCatalogEntry.update({ where: { id: p.id }, data });
    } else {
      r = await db.productCatalogEntry.create({ data });
    }
    return { ...r, specifications: parseJSON(r.specifications, null), created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deleteProductCatalogEntry(id: string): Promise<void> {
    await db.productCatalogEntry.delete({ where: { id } });
  }

  // ─── Supplier Offers ────────────────────────────────────────────────────

  async listSupplierOffers(tenantId: string, params?: ListParams): Promise<ListResult<SupplierOffer>> {
    let where: any = { tenant_id: tenantId };
    if (params?.search) {
      where.OR = [{ name: { contains: params.search } }];
    }
    const total = await db.supplierOffer.count({ where });
    const rows = await db.supplierOffer.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapSupplierOfferRow), total };
  }

  async getSupplierOffer(id: string): Promise<SupplierOffer | null> {
    const r = await db.supplierOffer.findUnique({ where: { id } });
    return r ? mapSupplierOfferRow(r) : null;
  }

  async upsertSupplierOffer(s: Partial<SupplierOffer> & { id?: string }): Promise<SupplierOffer> {
    const data: any = {
      tenant_id: s.tenant_id ?? "",
      supplier_id: s.supplier_id ?? "",
      product_catalog_id: s.product_catalog_id ?? null,
      name: s.name ?? "",
      price: s.price ?? 0,
      currency: s.currency ?? "USD",
      min_quantity: s.min_quantity ?? 0,
      available_quantity: s.available_quantity ?? null,
      lead_time_days: s.lead_time_days ?? null,
      origin_country: s.origin_country ?? null,
      incoterm: s.incoterm ?? null,
      specifications: stringifyJSON(s.specifications),
      valid_until: s.valid_until ? new Date(s.valid_until) : null,
      status: s.status ?? "active",
    };
    let r;
    if (s.id) {
      r = await db.supplierOffer.update({ where: { id: s.id }, data });
    } else {
      r = await db.supplierOffer.create({ data });
    }
    return mapSupplierOfferRow(r);
  }

  async deleteSupplierOffer(id: string): Promise<void> {
    await db.supplierOffer.delete({ where: { id } });
  }

  // ─── Trade Calculations ─────────────────────────────────────────────────

  async listTradeCalculations(tenantId: string, params?: ListParams): Promise<ListResult<TradeCalculation>> {
    let where: any = { tenant_id: tenantId };
    if (params?.search) {
      where.OR = [{ name: { contains: params.search } }];
    }
    const total = await db.tradeCalculation.count({ where });
    const rows = await db.tradeCalculation.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapTradeCalcRow), total };
  }

  async getTradeCalculation(id: string): Promise<TradeCalculation | null> {
    const r = await db.tradeCalculation.findUnique({ where: { id } });
    return r ? mapTradeCalcRow(r) : null;
  }

  async upsertTradeCalculation(t: Partial<TradeCalculation> & { id?: string }): Promise<TradeCalculation> {
    // Field names MUST match the TradeCalculation Prisma model (prisma/schema.prisma).
    // The previous version wrote to non-existent columns (product_catalog_id,
    // unit_price, currency, incoterm, total_cost, cost_per_unit) — silently
    // dropping every real field on dev (SQLite) builds. Audit finding 1b.
    const data: any = {
      tenant_id: t.tenant_id ?? "",
      name: t.name ?? "",
      product_id: t.product_id ?? null,
      supplier_offer_id: t.supplier_offer_id ?? null,
      supplier_id: t.supplier_id ?? null,
      buyer_id: t.buyer_id ?? null,
      quantity: t.quantity ?? 0,
      unit: t.unit ?? "MT",
      num_containers: t.num_containers ?? 1,
      container_type: t.container_type ?? null,
      buy_price_per_unit: t.buy_price_per_unit ?? 0,
      buy_currency: t.buy_currency ?? "USD",
      buy_incoterm: t.buy_incoterm ?? "FOB",
      sell_price_per_unit: t.sell_price_per_unit ?? 0,
      sell_currency: t.sell_currency ?? "USD",
      sell_incoterm: t.sell_incoterm ?? "CIF",
      transport_mode: t.transport_mode ?? "sea",
      loading_port: t.loading_port ?? null,
      delivery_port: t.delivery_port ?? null,
      exchange_rate: t.exchange_rate ?? 1.0,
      cost_lines: stringifyJSON(t.cost_lines) ?? "[]",
      total_buy_cost: t.total_buy_cost ?? 0,
      total_landed_cost: t.total_landed_cost ?? 0,
      total_sell_revenue: t.total_sell_revenue ?? 0,
      gross_margin: t.gross_margin ?? 0,
      margin_percent: t.margin_percent ?? 0,
      commission_agent_id: t.commission_agent_id ?? null,
      commission_type: t.commission_type ?? null,
      commission_rate: t.commission_rate ?? 0,
      created_by: t.created_by ?? null,
    };
    let r;
    if (t.id) {
      r = await db.tradeCalculation.update({ where: { id: t.id }, data });
    } else {
      r = await db.tradeCalculation.create({ data });
    }
    return mapTradeCalcRow(r);
  }

  async deleteTradeCalculation(id: string): Promise<void> {
    await db.tradeCalculation.delete({ where: { id } });
  }

  // ─── Portal Access ──────────────────────────────────────────────────────

  async getPortalAccessByPartner(partnerId: string): Promise<PortalAccess | null> {
    const r = await db.portalAccess.findFirst({ where: { partner_id: partnerId } });
    return r ? mapPortalAccessRow(r) : null;
  }

  async getPortalAccessByEmail(tenantId: string, email: string): Promise<PortalAccess | null> {
    const r = await db.portalAccess.findFirst({ where: { tenant_id: tenantId, portal_email: email } });
    return r ? mapPortalAccessRow(r) : null;
  }

  async getPortalAccessById(id: string): Promise<PortalAccess | null> {
    const r = await db.portalAccess.findUnique({ where: { id } });
    return r ? mapPortalAccessRow(r) : null;
  }

  async listPortalAccess(tenantId: string): Promise<PortalAccess[]> {
    const rows = await db.portalAccess.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: "desc" },
    });
    return rows.map(mapPortalAccessRow);
  }

  async upsertPortalAccess(p: Partial<PortalAccess> & { id?: string }): Promise<PortalAccess> {
    const data: any = {
      tenant_id: p.tenant_id ?? "",
      partner_id: p.partner_id ?? "",
      tier: p.tier ?? "standard",
      // Feature flags
      can_view_offers: p.can_view_offers ?? false,
      can_view_documents: p.can_view_documents ?? false,
      can_view_catalog: p.can_view_catalog ?? false,
      can_view_invoices: p.can_view_invoices ?? false,
      can_view_profile: p.can_view_profile ?? true,
      can_view_company_info: p.can_view_company_info ?? false,
      can_submit_rfq: p.can_submit_rfq ?? false,
      can_download_pdf: p.can_download_pdf ?? false,
      // Compliance exemptions
      exempt_kyc: p.exempt_kyc ?? false,
      exempt_document_upload: p.exempt_document_upload ?? false,
      exempt_location_share: p.exempt_location_share ?? false,
      // Onboarding status
      status: p.status ?? "pending_approval",
      approved_by: p.approved_by ?? null,
      approved_at: p.approved_at ? new Date(p.approved_at) : null,
      invited_at: p.invited_at ? new Date(p.invited_at) : null,
      welcome_email_sent: p.welcome_email_sent ?? false,
      // Access credentials
      portal_email: p.portal_email ?? null,
      password_hash: p.password_hash ?? null,
      must_set_password: p.must_set_password ?? true,
      // Last login
      last_login_at: p.last_login_at ? new Date(p.last_login_at) : null,
      last_login_ip: p.last_login_ip ?? null,
      // GPS verification (migration 015_portal_access_gps_verified_at.sql).
      // When the column hasn't been applied yet, prisma throws on update —
      // the caller in /api/portal/log-location already wraps this in a
      // try/catch so the upsert failure is non-fatal and the audit log
      // entry (which always succeeds) still records the location share.
      gps_verified_at: p.gps_verified_at ? new Date(p.gps_verified_at) : null,
      // Security
      locked_until: p.locked_until ? new Date(p.locked_until) : null,
      failed_attempts: p.failed_attempts ?? 0,
      token_version: p.token_version ?? 1,
    };
    let r;
    if (p.id) {
      // Only update fields that are explicitly provided (not undefined)
      const cleanData: any = {};
      for (const [k, v] of Object.entries(data)) {
        if ((p as any)[k] !== undefined) cleanData[k] = v;
      }
      r = await db.portalAccess.update({ where: { id: p.id }, data: cleanData });
    } else {
      r = await db.portalAccess.create({ data });
    }
    return mapPortalAccessRow(r);
  }

  async deletePortalAccess(id: string): Promise<void> {
    await db.portalAccess.delete({ where: { id } });
  }

  async verifyPortalCredentials(tenantId: string, email: string, password: string): Promise<PortalAccess | null> {
    const r = await db.portalAccess.findFirst({ where: { tenant_id: tenantId, portal_email: email } });
    if (!r) return null;
    if (!r.password_hash) return null;
    const { verifyPassword } = await import("@/lib/auth/password");
    const ok = await verifyPassword(password, r.password_hash);
    return ok ? mapPortalAccessRow(r) : null;
  }

  async verifyPortalCredentialsByEmail(email: string, password: string): Promise<PortalAccess | null> {
    const r = await db.portalAccess.findFirst({ where: { portal_email: email } });
    if (!r) return null;
    if (!r.password_hash) return null;
    if (r.status !== "active") return null;
    const { verifyPassword } = await import("@/lib/auth/password");
    const ok = await verifyPassword(password, r.password_hash);
    return ok ? mapPortalAccessRow(r) : null;
  }
  async getPortalAccessByEmailAnyTenant(email: string): Promise<PortalAccess | null> {
    const r = await db.portalAccess.findFirst({ where: { portal_email: email } });
    return r ? mapPortalAccessRow(r) : null;
  }
  async listPortalAccessByEmail(email: string): Promise<PortalAccess[]> {
    const rows = await db.portalAccess.findMany({ where: { portal_email: email } });
    return rows.map(mapPortalAccessRow);
  }

  // ─── Document Templates ─────────────────────────────────────────────────

  async listDocumentTemplates(tenantId: string): Promise<DocumentTemplate[]> {
    const rows = await db.documentTemplate.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: "desc" },
      include: { letterhead: true, seal: true },
    });
    return rows.map((r: any) => ({
      ...r,
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
      letterhead: r.letterhead ? this._mapLetterhead(r.letterhead) : null,
      seal: r.seal ? this._mapSeal(r.seal) : null,
    }));
  }

  async getDocumentTemplate(id: string): Promise<DocumentTemplate | null> {
    const r = await db.documentTemplate.findUnique({ where: { id }, include: { letterhead: true, seal: true } });
    if (!r) return null;
    return {
      ...r,
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
      letterhead: r.letterhead ? this._mapLetterhead(r.letterhead) : null,
      seal: r.seal ? this._mapSeal(r.seal) : null,
    };
  }

  async getDefaultDocumentTemplate(tenantId: string, type: string): Promise<DocumentTemplate | null> {
    const r = await db.documentTemplate.findFirst({
      where: { tenant_id: tenantId, type, is_default: true },
      include: { letterhead: true, seal: true },
    });
    if (r) {
      return {
        ...r,
        created_at: dateToISOOrNow(r.created_at),
        updated_at: dateToISOOrNow(r.updated_at),
        letterhead: r.letterhead ? this._mapLetterhead(r.letterhead) : null,
        seal: r.seal ? this._mapSeal(r.seal) : null,
      };
    }
    // Fall back to any default template of any type — a tenant might have
    // created a single "all-documents" template instead of per-type ones.
    const anyDefault = await db.documentTemplate.findFirst({
      where: { tenant_id: tenantId, is_default: true },
      orderBy: { created_at: "desc" },
      include: { letterhead: true, seal: true },
    });
    if (anyDefault) {
      return {
        ...anyDefault,
        created_at: dateToISOOrNow(anyDefault.created_at),
        updated_at: dateToISOOrNow(anyDefault.updated_at),
        letterhead: anyDefault.letterhead ? this._mapLetterhead(anyDefault.letterhead) : null,
        seal: anyDefault.seal ? this._mapSeal(anyDefault.seal) : null,
      };
    }
    // Auto-create starter templates when the tenant has none at all — gives
    // new tenants a professional default for every document type without
    // requiring them to visit the Templates view first. Idempotent.
    try {
      const allTemplates = await this.listDocumentTemplates(tenantId);
      if (allTemplates.length === 0) {
        await ensureStarterTemplates(tenantId, this);
        const seeded = await db.documentTemplate.findFirst({
          where: { tenant_id: tenantId, type, is_default: true },
          include: { letterhead: true, seal: true },
        });
        if (seeded) {
          return {
            ...seeded,
            created_at: dateToISOOrNow(seeded.created_at),
            updated_at: dateToISOOrNow(seeded.updated_at),
            letterhead: seeded.letterhead ? this._mapLetterhead(seeded.letterhead) : null,
            seal: seeded.seal ? this._mapSeal(seeded.seal) : null,
          };
        }
      }
    } catch (autoErr) {
      console.warn("[getDefaultDocumentTemplate] Starter auto-create error:", autoErr);
    }
    return null;
  }

  async upsertDocumentTemplate(t: Partial<DocumentTemplate> & { id?: string }): Promise<DocumentTemplate> {
    // If setting as default, unset other defaults of the same type for this tenant
    if (t.is_default && t.tenant_id && t.type && !t.id) {
      await db.documentTemplate.updateMany({
        where: { tenant_id: t.tenant_id, type: t.type, is_default: true },
        data: { is_default: false },
      });
    } else if (t.is_default && t.id) {
      const existing = await db.documentTemplate.findUnique({ where: { id: t.id } });
      if (existing) {
        await db.documentTemplate.updateMany({
          where: { tenant_id: existing.tenant_id, type: existing.type, is_default: true, id: { not: t.id } },
          data: { is_default: false },
        });
      }
    }

    const data: any = {
      tenant_id: t.tenant_id,
      name: t.name,
      type: t.type,
      is_default: t.is_default,
      created_by: t.created_by,
      // Page layout
      page_size: t.page_size,
      page_margin_top: t.page_margin_top,
      page_margin_bottom: t.page_margin_bottom,
      page_margin_left: t.page_margin_left,
      page_margin_right: t.page_margin_right,
      // Header
      header_enabled: t.header_enabled,
      header_height: t.header_height,
      header_content: t.header_content,
      header_show_logo: t.header_show_logo,
      header_show_company_name: t.header_show_company_name,
      header_show_contact: t.header_show_contact,
      // Footer
      footer_enabled: t.footer_enabled,
      footer_height: t.footer_height,
      footer_content: t.footer_content,
      footer_show_page_number: t.footer_show_page_number,
      footer_show_bank_details: t.footer_show_bank_details,
      footer_show_tax_id: t.footer_show_tax_id,
      // Body styling
      body_font_family: t.body_font_family,
      body_font_size: t.body_font_size,
      body_line_height: t.body_line_height,
      primary_color: t.primary_color,
      accent_color: t.accent_color,
      // Table styling
      table_header_bg: t.table_header_bg,
      table_header_color: t.table_header_color,
      table_border_color: t.table_border_color,
      table_stripe: t.table_stripe,
      // Branding links
      letterhead_id: t.letterhead_id === undefined ? undefined : t.letterhead_id,
      seal_id: t.seal_id === undefined ? undefined : t.seal_id,
      seal_enabled: t.seal_enabled,
    };
    // Strip undefined values so Prisma doesn't overwrite with null on update
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

    let r;
    if (t.id) {
      r = await db.documentTemplate.update({ where: { id: t.id }, data, include: { letterhead: true, seal: true } });
    } else {
      r = await db.documentTemplate.create({ data, include: { letterhead: true, seal: true } });
    }
    return {
      ...r,
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
      letterhead: r.letterhead ? this._mapLetterhead(r.letterhead) : null,
      seal: r.seal ? this._mapSeal(r.seal) : null,
    };
  }

  async deleteDocumentTemplate(id: string): Promise<void> {
    await db.documentTemplate.delete({ where: { id } });
  }

  // ─── Tenant Letterheads (Memorandum firme) ──────────────────────────────

  _mapLetterhead(r: any): TenantLetterhead {
    return {
      ...r,
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
    };
  }

  async listLetterheads(tenantId: string): Promise<TenantLetterhead[]> {
    const rows = await db.tenantLetterhead.findMany({
      where: { tenant_id: tenantId },
      orderBy: [{ is_default: "desc" }, { created_at: "desc" }],
    });
    return rows.map((r: any) => this._mapLetterhead(r));
  }

  async getLetterhead(id: string): Promise<TenantLetterhead | null> {
    const r = await db.tenantLetterhead.findUnique({ where: { id } });
    return r ? this._mapLetterhead(r) : null;
  }

  async getDefaultLetterhead(tenantId: string): Promise<TenantLetterhead | null> {
    const r = await db.tenantLetterhead.findFirst({
      where: { tenant_id: tenantId, is_default: true },
    });
    return r ? this._mapLetterhead(r) : null;
  }

  async upsertLetterhead(l: Partial<TenantLetterhead> & { id?: string; tenant_id: string }): Promise<TenantLetterhead> {
    // If setting as default, unset other defaults for this tenant
    if (l.is_default) {
      await db.tenantLetterhead.updateMany({
        where: { tenant_id: l.tenant_id, is_default: true, id: l.id ? { not: l.id } : undefined },
        data: { is_default: false },
      });
    }
    const data: any = {
      tenant_id: l.tenant_id,
      name: l.name,
      is_default: l.is_default,
      company_name: l.company_name,
      company_legal_name: l.company_legal_name,
      company_address_line: l.company_address_line,
      company_city: l.company_city,
      company_postal_code: l.company_postal_code,
      company_country: l.company_country,
      company_email: l.company_email,
      company_phone: l.company_phone,
      company_website: l.company_website,
      company_vat_number: l.company_vat_number,
      company_tax_id: l.company_tax_id,
      company_registration_number: l.company_registration_number,
      bank_name: l.bank_name,
      bank_iban: l.bank_iban,
      bank_swift: l.bank_swift,
      bank_account_holder: l.bank_account_holder,
      logo_url: l.logo_url,
      logo_position: l.logo_position,
      logo_width_mm: l.logo_width_mm,
      logo_height_mm: l.logo_height_mm,
      logo_lock_aspect: l.logo_lock_aspect,
      primary_color: l.primary_color,
      accent_color: l.accent_color,
      text_color: l.text_color,
      muted_text_color: l.muted_text_color,
      page_size: l.page_size,
      margin_top_mm: l.margin_top_mm,
      margin_bottom_mm: l.margin_bottom_mm,
      margin_left_mm: l.margin_left_mm,
      margin_right_mm: l.margin_right_mm,
      header_height_mm: l.header_height_mm,
      footer_height_mm: l.footer_height_mm,
      header_layout: l.header_layout,
      header_show_logo: l.header_show_logo,
      header_show_company_name: l.header_show_company_name,
      header_show_contact: l.header_show_contact,
      header_show_vat: l.header_show_vat,
      header_divider: l.header_divider,
      header_divider_color: l.header_divider_color,
      header_custom_html: l.header_custom_html,
      footer_layout: l.footer_layout,
      footer_show_bank_details: l.footer_show_bank_details,
      footer_show_contact: l.footer_show_contact,
      footer_show_tax_id: l.footer_show_tax_id,
      footer_show_page_number: l.footer_show_page_number,
      footer_divider: l.footer_divider,
      footer_divider_color: l.footer_divider_color,
      footer_custom_html: l.footer_custom_html,
      footer_text: l.footer_text,
      watermark_enabled: l.watermark_enabled,
      watermark_text: l.watermark_text,
      watermark_color: l.watermark_color,
      watermark_opacity: l.watermark_opacity,
      watermark_rotation: l.watermark_rotation,
      body_font_family: l.body_font_family,
      body_font_size_pt: l.body_font_size_pt,
      heading_font_family: l.heading_font_family,
      heading_font_size_pt: l.heading_font_size_pt,
      created_by: l.created_by,
    };
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

    let r;
    if (l.id) {
      r = await db.tenantLetterhead.update({ where: { id: l.id }, data });
    } else {
      r = await db.tenantLetterhead.create({ data });
    }
    return this._mapLetterhead(r);
  }

  async deleteLetterhead(id: string): Promise<void> {
    // Unlink templates that reference this letterhead, then delete
    await db.documentTemplate.updateMany({ where: { letterhead_id: id }, data: { letterhead_id: null } });
    await db.tenantLetterhead.delete({ where: { id } });
  }

  // ─── Tenant Seals (Zigled) ──────────────────────────────────────────────

  _mapSeal(r: any): TenantSeal {
    return {
      ...r,
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
    };
  }

  async listSeals(tenantId: string): Promise<TenantSeal[]> {
    const rows = await db.tenantSeal.findMany({
      where: { tenant_id: tenantId },
      orderBy: [{ is_default: "desc" }, { created_at: "desc" }],
    });
    return rows.map((r: any) => this._mapSeal(r));
  }

  async getSeal(id: string): Promise<TenantSeal | null> {
    const r = await db.tenantSeal.findUnique({ where: { id } });
    return r ? this._mapSeal(r) : null;
  }

  async getDefaultSeal(tenantId: string): Promise<TenantSeal | null> {
    const r = await db.tenantSeal.findFirst({
      where: { tenant_id: tenantId, is_default: true },
    });
    return r ? this._mapSeal(r) : null;
  }

  async upsertSeal(s: Partial<TenantSeal> & { id?: string; tenant_id: string }): Promise<TenantSeal> {
    if (s.is_default) {
      await db.tenantSeal.updateMany({
        where: { tenant_id: s.tenant_id, is_default: true, id: s.id ? { not: s.id } : undefined },
        data: { is_default: false },
      });
    }
    const data: any = {
      tenant_id: s.tenant_id,
      name: s.name,
      is_default: s.is_default,
      image_url: s.image_url,
      image_width_mm: s.image_width_mm,
      image_height_mm: s.image_height_mm,
      image_format: s.image_format,
      position: s.position,
      offset_x_mm: s.offset_x_mm,
      offset_y_mm: s.offset_y_mm,
      opacity: s.opacity,
      rotation_deg: s.rotation_deg,
      apply_to_types: s.apply_to_types,
      signature_enabled: s.signature_enabled,
      signature_label: s.signature_label,
      signature_name: s.signature_name,
      created_by: s.created_by,
    };
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

    let r;
    if (s.id) {
      r = await db.tenantSeal.update({ where: { id: s.id }, data });
    } else {
      r = await db.tenantSeal.create({ data });
    }
    return this._mapSeal(r);
  }

  async deleteSeal(id: string): Promise<void> {
    await db.documentTemplate.updateMany({ where: { seal_id: id }, data: { seal_id: null } });
    await db.tenantSeal.delete({ where: { id } });
  }

  // ─── Document Verification ──────────────────────────────────────────────

  async createDocumentVerification(v: Omit<DocumentVerification, "id" | "created_at" | "verification_count" | "last_verified_at" | "last_verified_ip" | "status"> & { status?: string }): Promise<DocumentVerification> {
    const r = await db.documentVerification.create({
      data: {
        tenant_id: v.tenant_id ?? "",
        partner_id: v.partner_id ?? null,
        doc_type: v.doc_type ?? "offer",
        doc_id: v.doc_id ?? "",
        verification_code: v.verification_code ?? "",
        status: v.status ?? "active",
        qr_code_url: v.qr_code_url ?? null,
      },
    });
    return { ...r, created_at: dateToISOOrNow(r.created_at), last_verified_at: null, last_verified_ip: null, verification_count: 0 };
  }

  async getDocumentVerificationByCode(code: string): Promise<DocumentVerification | null> {
    const r = await db.documentVerification.findFirst({ where: { verification_code: code } });
    return r ? { ...r, created_at: dateToISOOrNow(r.created_at), last_verified_at: dateToISO(r.last_verified_at), last_verified_ip: r.last_verified_ip } : null;
  }

  async getDocumentVerificationByDoc(tenantId: string, docType: string, docId: string): Promise<DocumentVerification | null> {
    const r = await db.documentVerification.findFirst({
      where: { tenant_id: tenantId, doc_type: docType, doc_id: docId },
    });
    return r ? { ...r, created_at: dateToISOOrNow(r.created_at), last_verified_at: dateToISO(r.last_verified_at), last_verified_ip: r.last_verified_ip } : null;
  }

  async logVerification(log: Omit<VerificationLog, "id" | "verified_at">): Promise<VerificationLog> {
    const r = await db.verificationLog.create({
      data: {
        verification_id: log.verification_id ?? "",
        ip: log.ip ?? null,
        user_agent: log.user_agent ?? null,
      },
    });
    return { ...r, verified_at: dateToISOOrNow(r.verified_at) };
  }

  async listVerificationLogs(verificationId: string): Promise<VerificationLog[]> {
    const rows = await db.verificationLog.findMany({
      where: { verification_id: verificationId },
      orderBy: { verified_at: "desc" },
    });
    return rows.map((r: any) => ({ ...r, verified_at: dateToISOOrNow(r.verified_at) }));
  }

  // ─── KYC ────────────────────────────────────────────────────────────────

  async listKycSubmissions(tenantId: string, params?: ListParams): Promise<ListResult<KycSubmission>> {
    let where: any = { tenant_id: tenantId };
    if (params?.search) {
      where.OR = [{ partner_id: { contains: params.search } }];
    }
    const total = await db.kycSubmission.count({ where });
    const rows = await db.kycSubmission.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map(mapKycRow), total };
  }

  async getKycSubmission(id: string): Promise<KycSubmission | null> {
    const r = await db.kycSubmission.findUnique({ where: { id } });
    return r ? mapKycRow(r) : null;
  }

  async getKycSubmissionByPartner(partnerId: string): Promise<KycSubmission | null> {
    const r = await db.kycSubmission.findFirst({ where: { partner_id: partnerId } });
    return r ? mapKycRow(r) : null;
  }

  async upsertKycSubmission(s: Partial<KycSubmission> & { id?: string }): Promise<KycSubmission> {
    const data: any = {
      tenant_id: s.tenant_id ?? "",
      partner_id: s.partner_id ?? "",
      status: s.status ?? "not_submitted",
      data: stringifyJSON(s.data),
      reviewed_by: s.reviewed_by ?? null,
      reviewed_at: s.reviewed_at ? new Date(s.reviewed_at) : null,
      notes: s.notes ?? null,
      submitted_at: s.submitted_at ? new Date(s.submitted_at) : null,
    };
    let r;
    if (s.id) {
      r = await db.kycSubmission.update({ where: { id: s.id }, data });
    } else {
      r = await db.kycSubmission.create({ data });
    }
    return mapKycRow(r);
  }

  async deleteKycSubmission(id: string): Promise<void> {
    await db.kycSubmission.delete({ where: { id } });
  }

  async addKycDocument(doc: Omit<KycDocument, "id" | "uploaded_at">): Promise<KycDocument> {
    const r = await db.kycDocument.create({
      data: {
        submission_id: doc.submission_id ?? "",
        type: doc.type ?? "registration",
        file_url: doc.file_url ?? "",
        file_name: doc.file_name ?? null,
        status: doc.status ?? "pending",
      },
    });
    return { ...r, uploaded_at: dateToISOOrNow(r.uploaded_at) };
  }

  async removeKycDocument(id: string): Promise<void> {
    await db.kycDocument.delete({ where: { id } });
  }

  async approveKycAndTransfer(submissionId: string, reviewedBy: string): Promise<{ submission: KycSubmission; partner: Partner }> {
    const submission = await this.upsertKycSubmission({
      id: submissionId,
      status: "approved",
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    });
    const sub = await db.kycSubmission.findUnique({ where: { id: submissionId } });
    const partner = sub ? await this.upsertPartner({
      id: sub.partner_id,
      kyc_status: "approved",
      kyc_reviewed_by: reviewedBy,
      kyc_reviewed_at: new Date().toISOString(),
    }) : null;
    if (!partner) throw new Error("Partner not found for KYC submission");
    return { submission, partner };
  }

  // ─── Portal RFQs ────────────────────────────────────────────────────────

  async listPortalRfqs(tenantId: string, params?: ListParams): Promise<ListResult<PortalRfq>> {
    let where: any = { tenant_id: tenantId };
    const total = await db.portalRfq.count({ where });
    const rows = await db.portalRfq.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params?.offset ?? 0,
      take: params?.limit ?? 50,
    });
    return { items: rows.map((r: any) => ({
      ...r,
      items: parseJSON(r.items, []),
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
    })), total };
  }

  async listPortalRfqsByPartner(partnerId: string): Promise<PortalRfq[]> {
    const rows = await db.portalRfq.findMany({
      where: { partner_id: partnerId },
      orderBy: { created_at: "desc" },
    });
    return rows.map((r: any) => ({
      ...r,
      items: parseJSON(r.items, []),
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
    }));
  }

  async getPortalRfq(id: string): Promise<PortalRfq | null> {
    const r = await db.portalRfq.findUnique({ where: { id } });
    return r ? { ...r, items: parseJSON(r.items, []), created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) } : null;
  }

  async upsertPortalRfq(rfq: Partial<PortalRfq> & { id?: string }): Promise<PortalRfq> {
    const data: any = {
      tenant_id: rfq.tenant_id ?? "",
      partner_id: rfq.partner_id ?? "",
      title: rfq.title ?? null,
      status: rfq.status ?? "pending",
      items: stringifyJSON(rfq.items) ?? "[]",
      notes: rfq.notes ?? null,
      delivery_address: rfq.delivery_address ?? null,
      desired_delivery_date: rfq.desired_delivery_date ? new Date(rfq.desired_delivery_date) : null,
    };
    let r;
    if (rfq.id) {
      r = await db.portalRfq.update({ where: { id: rfq.id }, data });
    } else {
      r = await db.portalRfq.create({ data });
    }
    return { ...r, items: parseJSON(r.items, []), created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  async deletePortalRfq(id: string): Promise<void> {
    await db.portalRfq.delete({ where: { id } });
  }

  // ─── Feature Flags ──────────────────────────────────────────────────────

  async getFeatureFlags(tenantId: string): Promise<TenantFeatureFlags | null> {
    const r = await db.tenantFeatureFlags.findFirst({ where: { tenant_id: tenantId } });
    return r ? {
      ...r,
      flags: parseJSON(r.flags, {}),
      created_at: dateToISOOrNow(r.created_at),
      updated_at: dateToISOOrNow(r.updated_at),
    } : null;
  }

  async upsertFeatureFlags(f: Partial<TenantFeatureFlags> & { id?: string; tenant_id: string }): Promise<TenantFeatureFlags> {
    const existing = await db.tenantFeatureFlags.findFirst({ where: { tenant_id: f.tenant_id } });
    const data: any = {
      tenant_id: f.tenant_id,
      flags: stringifyJSON(f.flags) ?? "{}",
      updated_by: f.updated_by ?? null,
    };
    let r;
    if (existing) {
      r = await db.tenantFeatureFlags.update({ where: { id: existing.id }, data });
    } else {
      r = await db.tenantFeatureFlags.create({ data });
    }
    return { ...r, flags: parseJSON(r.flags, {}), created_at: dateToISOOrNow(r.created_at), updated_at: dateToISOOrNow(r.updated_at) };
  }

  // ─── Notifications ──────────────────────────────────────────────────────

  async listNotifications(tenantId: string, userId?: string, unreadOnly?: boolean): Promise<Notification[]> {
    const where: any = { tenant_id: tenantId };
    if (userId) where.user_id = userId;
    if (unreadOnly) where.read = false;
    const rows = await db.notification.findMany({ where, orderBy: { created_at: "desc" } });
    return rows.map(mapNotificationRow);
  }

  async listNotificationsByPartner(tenantId: string, partnerId: string): Promise<Notification[]> {
    const rows = await db.notification.findMany({
      where: {
        tenant_id: tenantId,
        partner_id: partnerId,
        type: {
          in: [
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
          ],
        },
      },
      orderBy: { created_at: "desc" },
    });
    return rows.map(mapNotificationRow);
  }

  async createNotification(n: Omit<Notification, "id" | "created_at" | "read" | "read_at">): Promise<Notification> {
    const r = await db.notification.create({
      data: {
        tenant_id: n.tenant_id ?? "",
        user_id: n.user_id ?? null,
        type: n.type ?? "info",
        title: n.title ?? "",
        message: n.message ?? "",
        data: stringifyJSON(n.data),
        read: false,
      },
    });
    return mapNotificationRow(r);
  }

  async markNotificationRead(id: string, tenantId: string): Promise<void> {
    // CRITICAL FIX (audit A3): add tenant filter to prevent cross-tenant
    // notification reads. updateMany (rather than update) lets us add the
    // tenant_id to the WHERE clause without requiring a compound unique key.
    await db.notification.updateMany({
      where: { id, tenant_id: tenantId },
      data: { read: true, read_at: new Date() },
    });
  }

  async markAllNotificationsRead(tenantId: string, userId: string): Promise<void> {
    await db.notification.updateMany({
      where: { tenant_id: tenantId, user_id: userId, read: false },
      data: { read: true, read_at: new Date() },
    });
  }

  async deleteNotification(id: string): Promise<void> {
    await db.notification.delete({ where: { id } });
  }

  async getUnreadCount(tenantId: string, userId: string): Promise<number> {
    return db.notification.count({
      where: { tenant_id: tenantId, OR: [{ user_id: userId }, { user_id: null }], read: false },
    });
  }
  async getNotificationById(id: string): Promise<Notification | null> {
    const r = await db.notification.findUnique({ where: { id } });
    return r as unknown as Notification | null;
  }

  // ─── Dashboard ──────────────────────────────────────────────────────────

  async getInsights(tenantId?: string): Promise<DashboardInsights> {
    // Compute dashboard insights from the database
    // Note: Deal and Offer don't have direct tenant_id — filter through Partner relation.
    // Invoice and Partner have direct tenant_id.
    const dealFilter = tenantId ? { partner: { tenant_id: tenantId } } : {};
    const offerFilter = tenantId ? { partner: { tenant_id: tenantId } } : {};
    const invoiceFilter = tenantId ? { tenant_id: tenantId } : {};
    const partnerFilter = tenantId ? { tenant_id: tenantId } : {};
    const [dealCount, activeDeals, wonDeals, lostDeals, offerCount, pendingOffers, invoiceCount, overdueInvoices, partnerCount, productCount, recentAudit] = await Promise.all([
      db.deal.count({ where: dealFilter }),
      db.deal.count({ where: { stage: { in: ["lead", "qualified", "proposal", "negotiation"] }, ...dealFilter } }),
      db.deal.count({ where: { stage: "won", ...dealFilter } }),
      db.deal.count({ where: { stage: "lost", ...dealFilter } }),
      db.offer.count({ where: offerFilter }),
      db.offer.count({ where: { status: { in: ["draft", "sent"] }, ...offerFilter } }),
      db.invoice.count({ where: invoiceFilter }),
      db.invoice.count({ where: { status: "overdue", ...invoiceFilter } }),
      db.partner.count({ where: partnerFilter }),
      db.product.count({}),
      db.auditLog.findMany({
        where: tenantId ? {} : {},
        orderBy: { created_at: "desc" },
        take: 5,
      }),
    ]);

    // Get total deal value
    const deals = await db.deal.findMany({ where: dealFilter });
    const totalDealValue = deals.reduce((sum, d) => sum + (d.value || 0), 0);
    const wonValue = deals.filter(d => d.stage === "won").reduce((sum, d) => sum + (d.value || 0), 0);

    // Get offers with totals
    const offers = await db.offer.findMany({ where: offerFilter });
    const totalOfferValue = offers.reduce((sum, o) => sum + (o.total || 0), 0);

    // Get invoices
    const invoices = await db.invoice.findMany({ where: invoiceFilter });
    const totalInvoiceValue = invoices.reduce((sum, i) => sum + (i.total || 0), 0);
    const paidInvoiceValue = invoices.filter(i => i.status === "paid").reduce((sum, i) => sum + (i.total || 0), 0);

    // Stage distribution
    const stageDistribution: Record<string, number> = {};
    for (const d of deals) {
      stageDistribution[d.stage] = (stageDistribution[d.stage] || 0) + 1;
    }

    // Deal pipeline — ensure all stages present (matches DashboardInsights.deals_by_stage)
    const order: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
    const deals_by_stage = order.map((stage) => ({
      stage,
      count: stageDistribution[stage] || 0,
      value: deals.filter(d => d.stage === stage).reduce((s, d) => s + (d.value || 0), 0),
    }));

    return {
      kpis: {
        partners_total: partnerCount,
        partners_active: partnerCount,
        deals_open: activeDeals,
        deals_won_value: wonValue,
        pipeline_value: totalDealValue - wonValue,
        offers_pending: pendingOffers,
        low_stock_count: 0,
        invoices_outstanding: invoiceCount,
        inventory_movements_30d: 0,
      },
      deals_by_stage,
      offers_last_30d: [],
      revenue_last_30d: [],
      recent_activity: recentAudit.map(mapAuditLogRow),
      top_partners: [],
      low_stock_products: [],
    } as DashboardInsights;
  }

  // ── Dashboard analytics charts (task D-2) ───────────────────────────────
  // PrismaStore is the DEPRECATED legacy backend (DB_BACKEND=prisma). The
  // Prisma schema has drifted from the multi-tenant types in
  // supabase/types.ts, so a full aggregation would need bespoke Prisma
  // queries. To keep the dashboard charts renderable in legacy mode
  // without investing in prisma-specific aggregation, we return a
  // zero-filled payload with the same trailing-12-month bucket layout
  // that SupabaseStore produces. Production uses SupabaseStore — this
  // stub only needs to not crash.
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
    } as DashboardCharts;
  }

  // ─── ERP stubs (not yet implemented for Prisma) ──────────────────────────
  async listErpAccounts(_tenantId: string, _params?: ListParams): Promise<ListResult<ErpAccount>> { return { items: [], total: 0 }; }
  async getErpAccount(_id: string): Promise<ErpAccount | null> { return null; }
  async upsertErpAccount(_a: Partial<ErpAccount> & { id?: string }): Promise<ErpAccount> { throw new Error("Not implemented"); }
  async deleteErpAccount(_id: string): Promise<void> { throw new Error("Not implemented"); }
  async listFiscalPeriods(_tenantId: string, _params?: ListParams): Promise<ListResult<FiscalPeriod>> { return { items: [], total: 0 }; }
  async getFiscalPeriod(_id: string): Promise<FiscalPeriod | null> { return null; }
  async upsertFiscalPeriod(_p: Partial<FiscalPeriod> & { id?: string }): Promise<FiscalPeriod> { throw new Error("Not implemented"); }
  async closeFiscalPeriod(_id: string, _closedBy: string): Promise<FiscalPeriod> { throw new Error("Not implemented"); }
  async listErpJournalEntries(_tenantId: string, _params?: ListParams): Promise<ListResult<ErpJournalEntry>> { return { items: [], total: 0 }; }
  async getErpJournalEntry(_id: string): Promise<ErpJournalEntry | null> { return null; }
  async upsertErpJournalEntry(_e: Omit<Partial<ErpJournalEntry>, "lines"> & { id?: string; lines?: Partial<ErpJournalLine & { id?: string }>[] }): Promise<ErpJournalEntry> { throw new Error("Not implemented"); }
  async postErpJournalEntry(_id: string, _postedBy: string): Promise<ErpJournalEntry> { throw new Error("Not implemented"); }
  async reverseErpJournalEntry(_id: string, _reversedBy: string): Promise<ErpJournalEntry> { throw new Error("Not implemented"); }
  async deleteErpJournalEntry(_id: string): Promise<void> { throw new Error("Not implemented"); }
  async listErpCostCenters(_tenantId: string, _params?: ListParams): Promise<ListResult<ErpCostCenter>> { return { items: [], total: 0 }; }
  async upsertErpCostCenter(_c: Partial<ErpCostCenter> & { id?: string }): Promise<ErpCostCenter> { throw new Error("Not implemented"); }
  async deleteErpCostCenter(_id: string): Promise<void> { throw new Error("Not implemented"); }
  async listErpBankAccounts(_tenantId: string): Promise<ErpBankAccount[]> { return []; }
  async upsertErpBankAccount(_b: Partial<ErpBankAccount> & { id?: string }): Promise<ErpBankAccount> { throw new Error("Not implemented"); }
  async deleteErpBankAccount(_id: string): Promise<void> { throw new Error("Not implemented"); }
  async listErpBankTransactions(_tenantId: string, _bankAccountId?: string, _params?: ListParams): Promise<ListResult<ErpBankTransaction>> { return { items: [], total: 0 }; }
  async upsertErpBankTransaction(_t: Partial<ErpBankTransaction> & { id?: string }): Promise<ErpBankTransaction> { throw new Error("Not implemented"); }
  async reconcileBankTransaction(_id: string, _journalEntryId: string): Promise<ErpBankTransaction> { throw new Error("Not implemented"); }
  async getErpSettings(_tenantId: string): Promise<ErpSetting | null> { return null; }
  async upsertErpSettings(_s: Partial<ErpSetting> & { id?: string; tenant_id: string }): Promise<ErpSetting> { throw new Error("Not implemented"); }
  async getTrialBalance(_tenantId: string, _asOfDate: string): Promise<TrialBalance> { return { items: [], total_debit: 0, total_credit: 0, as_of_date: _asOfDate }; }
  async getBalanceSheet(_tenantId: string, _asOfDate: string): Promise<BalanceSheet> { return { assets: [], liabilities: [], equity: [], total_assets: 0, total_liabilities: 0, total_equity: 0, as_of_date: _asOfDate }; }
  async getProfitAndLoss(_tenantId: string, _periodStart: string, _periodEnd: string): Promise<ProfitAndLoss> { return { revenue: [], expenses: [], total_revenue: 0, total_expenses: 0, net_profit: 0, period_start: _periodStart, period_end: _periodEnd }; }
  async getGeneralLedger(_tenantId: string, _accountId: string, _dateFrom?: string, _dateTo?: string): Promise<GeneralLedger> { return { account_id: _accountId, account_code: "", account_name: "", entries: [], opening_balance: 0, closing_balance: 0, total_debit: 0, total_credit: 0 }; }
  async autoJournalFromInvoice(_invoiceId: string, _tenantId: string, _userId: string): Promise<ErpJournalEntry | null> { return null; }
  async autoJournalFromDeal(_dealId: string, _tenantId: string, _userId: string): Promise<ErpJournalEntry | null> { return null; }
  async autoJournalFromCommission(_commissionId: string, _tenantId: string, _userId: string): Promise<ErpJournalEntry | null> { return null; }
  // PrismaStore does not implement commission payouts (legacy backend).
  // Production uses SupabaseStore which calls the `create_commission_payout`
  // RPC for atomic payout creation. These stubs satisfy the Store interface.
  async createCommissionPayoutAtomic(
    _payout: Partial<CommissionPayout> & { commission_ids: string[] },
    _commissionIds: string[],
  ): Promise<CommissionPayout> { throw new Error("Not implemented"); }

  // P1 (VAT compliance) / task C-4 Fix 1: PrismaStore is a legacy backend
  // and does not implement the atomic `create_doc_with_number` RPC. The
  // mock/supabase backends cover the live paths; PrismaStore callers get
  // an explicit "Not implemented" so they fail fast rather than silently
  // degrading to the non-atomic two-step pattern.
  async createDocWithNumber(
    _docType: "offer" | "invoice" | "proforma" | "demand" | "rfq",
    _payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> { throw new Error("Not implemented"); }

  // ─── User Preferences ──────────────────────────────────────────────────
  async getUserPreference(userId: string, key: string): Promise<UserPreference | null> {
    const row = await db.userPreference.findUnique({ where: { user_id_preference_key: { user_id: userId, preference_key: key } } });
    if (!row) return null;
    return { ...row, preference_value: row.preference_value, updated_at: dateToISOOrNow(row.updated_at) };
  }

  async setUserPreference(userId: string, key: string, value: unknown): Promise<UserPreference> {
    const serialized = JSON.stringify(value);
    const row = await db.userPreference.upsert({
      where: { user_id_preference_key: { user_id: userId, preference_key: key } },
      update: { preference_value: serialized },
      create: { user_id: userId, preference_key: key, preference_value: serialized },
    });
    return { ...row, preference_value: row.preference_value, updated_at: dateToISOOrNow(row.updated_at) };
  }

  async deleteUserPreference(_userId: string, _key: string): Promise<void> {}

  async listUserPreferences(userId: string): Promise<UserPreference[]> {
    const rows = await db.userPreference.findMany({ where: { user_id: userId } });
    return rows.map((r) => ({ ...r, preference_value: r.preference_value, updated_at: dateToISOOrNow(r.updated_at) }));
  }
}
