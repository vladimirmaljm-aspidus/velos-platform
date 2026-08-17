// mock.ts — emptied for production. No demo data.
// All data comes from Supabase in production.
import {
  User, Partner, Product, Deal, Offer, Demand, SharedDocument,
  AuditLog, Setting, UserTask, InventoryMovement, EntityNote,
  DashboardInsights,
  Invoice, Proforma, DocumentRegisterEntry, DocumentRevision,
  VaultSecret, ApiKey, Webhook,
  SecuritySession, LoginHistoryEntry, KnownIp, TrustedDevice,
  MailQueueEntry,
  Tenant, ProductCatalogEntry, SupplierOffer, TradeCalculation,
  PortalAccess, DocumentTemplate, DocumentVerification,
  KycSubmission, PortalRfq,
  TenantFeatureFlags,
  Notification,
  CommissionAgent, DealCommission, CommissionPayout,
} from "@/lib/supabase/types";

// ---- id generator ----
export function nid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}`;
}

// ---- hash placeholder (mock only — real auth uses bcrypt) ----
export function mockHash(pw: string): string {
  return `mock$${Buffer.from(pw).toString("base64")}`;
}
export function mockVerify(pw: string, hash: string): boolean {
  return mockHash(pw) === hash;
}

// ---- All empty arrays — no demo data in production ----
export const users: User[] = [];
export const partners: Partner[] = [];
export const products: Product[] = [];
export const deals: Deal[] = [];
export const offers: Offer[] = [];
export const demands: Demand[] = [];
export const documents: SharedDocument[] = [];
export const auditLogs: AuditLog[] = [];
export const settings: Setting[] = [];
export const tasks: UserTask[] = [];
export const inventoryMovements: InventoryMovement[] = [];
export const notes: EntityNote[] = [];
export const tenants: Tenant[] = [];
export const invoices: Invoice[] = [];
export const proformas: Proforma[] = [];
export const documentRegister: DocumentRegisterEntry[] = [];
export const documentRevisions: DocumentRevision[] = [];
export const vaultSecrets: VaultSecret[] = [];
export const apiKeys: ApiKey[] = [];
export const webhooks: Webhook[] = [];
export const securitySessions: SecuritySession[] = [];
export const loginHistory: LoginHistoryEntry[] = [];
export const knownIps: KnownIp[] = [];
export const trustedDevices: TrustedDevice[] = [];
export const mailQueue: MailQueueEntry[] = [];
export const productCatalog: ProductCatalogEntry[] = [];
export const supplierOffers: SupplierOffer[] = [];
export const tradeCalculations: TradeCalculation[] = [];
export const portalAccess: PortalAccess[] = [];
export const documentTemplates: DocumentTemplate[] = [];
export const documentVerifications: DocumentVerification[] = [];
export const kycSubmissions: KycSubmission[] = [];
export const portalRfqs: PortalRfq[] = [];
export const featureFlags: TenantFeatureFlags[] = [];
export const notifications: Notification[] = [];
export const commissionAgents: CommissionAgent[] = [];
export const dealCommissions: DealCommission[] = [];
export const commissionPayouts: CommissionPayout[] = [];

export function computeInsights(): DashboardInsights {
  return {
    kpis: {
      partners_total: 0,
      partners_active: 0,
      deals_open: 0,
      deals_won_value: 0,
      pipeline_value: 0,
      offers_pending: 0,
      low_stock_count: 0,
      invoices_outstanding: 0,
      inventory_movements_30d: 0,
    },
    deals_by_stage: [],
    offers_last_30d: [],
    revenue_last_30d: [],
    recent_activity: [],
    top_partners: [],
    low_stock_products: [],
  };
}

// Backward compat alias
export const getInsights = computeInsights;
