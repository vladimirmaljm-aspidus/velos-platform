// TypeScript types matching the Supabase schema (supabase_v23_1.sql)
// These mirror the tables in your Supabase project.

export type UserRole = "super_admin" | "admin" | "user";
export type PartnerType = "supplier" | "buyer" | "both" | "agent" | "logistics" | "customs" | "bank" | "inspector";
export type DealStage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
export type OfferStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "countered";
export type DemandStatus = "open" | "quoted" | "closed";
export type KycStatus = "not_submitted" | "pending" | "approved" | "rejected";

export interface User {
  id: string;
  tenant_id: string | null; // null = super-admin (platform level)
  username: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  permissions: string[] | null;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: boolean;
  /**
   * SHA-256 hex strings for the 10 one-time recovery codes issued at 2FA
   * enrollment (migration 040). Hashed at the application layer
   * (src/lib/auth/totp.ts `hashRecoveryCode`) so a DB read alone can't
   * recover usable codes. NULL when 2FA is not active. A code is removed
   * from the array when consumed (single-use).
   */
  recovery_codes: string[] | null;
  locked_until: string | null;
  failed_attempts: number;
  last_login_at: string | null;
  last_login_ip: string | null;
  last_login_country: string | null;
  must_change_password: boolean;
  token_version: number;
  signature: string | null;
  notif_prefs: Record<string, unknown> | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Partner {
  id: string;
  tenant_id: string;
  name: string;
  entity_type: PartnerEntityType;
  type: PartnerType;
  email: string | null;
  phone: string | null;
  website: string | null;
  tax_id: string | null;
  vat_number?: string | null;
  registration_number?: string | null;
  // Address
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null; // ISO 3166-1 alpha-2
  // Contact person
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  // Bank
  bank_name: string | null;
  bank_account: string | null;
  bank_swift: string | null;
  bank_iban?: string | null;
  // Trade
  preferred_currency?: string | null;
  preferred_incoterm?: string | null;
  preferred_payment_terms?: string | null;
  // Commission Agent
  is_commissioner?: boolean; // if true, this partner is also a commission agent
  // CRM
  status: "active" | "inactive" | "blacklisted";
  risk_score: number;
  notes: string | null;
  tags: string[] | null;
  // Portal
  portal_enabled: boolean;
  portal_token: string | null;
  portal_level: "none" | "viewer" | "buyer";
  kyc_status: KycStatus;
  kyc_data: Record<string, unknown> | null;
  kyc_reviewed_by: string | null;
  kyc_reviewed_at: string | null;
  // Additional DB fields
  activities?: Record<string, unknown> | null;
  industry?: string | null;
  lead_source?: string | null;
  linked_company_id?: string | null;
  old_id?: string | null;
  portal_permissions?: Record<string, unknown> | null;
  portal_visible_products?: string[] | null;
  rating?: number | null;
  social?: Record<string, unknown> | null;
  whatsapp?: string | null;
  // Meta
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  tenant_id?: string | null;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  price: number;
  currency: string;
  cost: number | null;
  stock: number;
  reorder_level: number;
  active: boolean;
  attributes: Record<string, unknown> | null;
  brand?: string | null;
  coa_params?: Record<string, unknown> | null;
  detailed_spec?: string | null;
  hs_code?: string | null;
  image_url?: string | null;
  inventory?: Record<string, unknown> | null;
  logistics?: Record<string, unknown> | null;
  old_id?: string | null;
  shelf_life?: string | null;
  tags?: string[] | null;
  /** When true, this product is exposed to portal clients under Catalog. */
  show_in_catalog?: boolean;
  /**
   * ISO alpha-2 country of origin. NOTE: the `products` table does NOT have an
   * `origin_country` column yet — this field is populated from
   * `attributes.origin_country` by `productToCatalogShape` until the column is
   * added via migration. Treat as read-only / best-effort.
   */
  origin_country?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Deal {
  id: string;
  tenant_id: string;
  title: string;
  partner_id: string;
  owner_id: string | null;
  stage: DealStage;
  value: number;
  currency: string;
  expected_close: string | null;
  probability: number;
  description: string | null;
  lost_reason: string | null;
  // Commission agent for this deal
  commission_agent_id: string | null; // → CommissionAgent
  // Cost tracking (for profit calculation)
  buy_cost: number; // total cost of goods for this deal
  quantity: number; // quantity sold
  unit: string; // unit of measure
  // Additional DB fields
  associates?: string[] | null;
  /** Bank charges/fees associated with this deal (numeric in DB). */
  bank_costs?: number | null;
  /** Optional commission amount override; if absent, commission is derived
   *  from the linked CommissionAgent's rate via /api/commission-calculate. */
  commission_amount?: number | null;
  buyer_id?: string | null;
  buyer_paid_on?: string | null;
  contract_id?: string | null;
  /** JSONB array of arbitrary cost lines, e.g. `[{ label: "Shipping", amount: 500 }]`. */
  costs?: Array<{ label?: string | null; amount?: number | null }> | Record<string, unknown> | null;
  delivery_date?: string | null;
  delivery_location?: string | null;
  documents?: string[] | null;
  exchange_rate?: number | null;
  incoterm?: string | null;
  old_id?: string | null;
  payment_account_id?: string | null;
  payment_dates?: Record<string, unknown> | null;
  product_id?: string | null;
  purchase_currency?: string | null;
  purchase_price?: number | null;
  selling_currency?: string | null;
  selling_price?: number | null;
  supplier_bank_details?: Record<string, unknown> | null;
  supplier_id?: string | null;
  supplier_paid_on?: string | null;
  // Meta
  created_at: string;
  updated_at: string;
}

export interface OfferLineItem {
  product_id: string;
  product_name: string;
  sku: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount: number;
  tax_rate: number;
  total: number;
  // Trade metadata carried onto the line so PDFs and downstream conversions
  // (offer → proforma → invoice) don't need to re-lookup Products.
  hs_code?: string | null;
  description?: string | null;
  detailed_spec?: string | null;
  brand?: string | null;
  origin_country?: string | null;
  specifications?: Array<{ name: string; value: string }> | Record<string, string> | null;
  /** Per-line buy cost (per unit) used for margin display. Optional —
   *  legacy line items created before this field will not have it. */
  cost?: number | null;
}

export interface Offer {
  id: string;
  tenant_id: string;
  number: string;
  deal_id: string | null;
  partner_id: string;
  owner_id: string | null;
  status: OfferStatus;
  subject: string;
  currency: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  notes: string | null;
  terms: string | null;
  valid_until: string | null;
  sent_at: string | null;
  responded_at: string | null;
  items: OfferLineItem[];
  // Trade / import fields
  offer_no: string | null;
  bank_details: string | null;
  pol: string | null;
  pod: string | null;
  vessel: string | null;
  container_no: string | null;
  lead_time: string | null;
  packaging: string | null;
  payment_terms: string | null;
  tax_clause: string | null;
  incoterm: string | null;
  selling_price: number | null;
  // Additional DB fields
  admin_reviewed_by_client?: boolean | null;
  client_accepted_at?: string | null;
  client_note?: string | null;
  client_signature?: string | null;
  /**
   * FIX-MARKET-UI / FIX 3 — counter-offer history. Array of
   * {amount, currency, message, partner_id, created_at} entries, newest
   * first. Null/empty on offers that have never been countered.
   */
  counter_offers?: Array<{
    amount: number;
    currency: string;
    message?: string | null;
    partner_id?: string | null;
    created_at: string;
  }> | null;
  document_id?: string | null;
  old_id?: string | null;
  payment_bank_idx?: number | null;
  pdf_file_url?: string | null;
  pdf_generated_at?: string | null;
  product_id?: string | null;
  quantity?: number | null;
  services?: Record<string, unknown> | null;
  unit?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DemandItem {
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string;
  target_price: number | null;
  notes: string | null;
}

export interface Demand {
  id: string;
  tenant_id: string;
  number: string;
  partner_id: string;
  status: DemandStatus;
  subject: string;
  description: string | null;
  requested_delivery: string | null;
  currency: string;
  items: DemandItem[];
  // Trade / import fields
  product_id: string | null;
  product_name: string | null;
  target_price: number | null;
  is_new_product: boolean;
  source: string | null;
  auto_hints: string | null;
  buyer_bank: string | null;
  destination: string | null;
  needed_by: string | null;
  payment_terms: string | null;
  buyer_id: string | null;
  end_buyer: string | null;
  logistics_agent: string | null;
  logistics_agent_contact: string | null;
  old_id: string | null;
  requestor: string | null;
  created_at: string;
  updated_at: string;
}

export interface SharedDocument {
  id: string;
  tenant_id: string;
  partner_id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  category: "contract" | "invoice" | "spec" | "other";
  uploaded_by: string | null;
  visible_to_partner: boolean;
  created_at: string;
}

export interface AuditLog {
  id: string;
  tenant_id?: string | null;
  user_id: string | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface Setting {
  tenant_id?: string | null;
  key: string;
  value: unknown;
  updated_at: string;
}

export interface Session {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  token: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  last_used_at: string | null;
}

export interface UserTask {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  done: boolean;
  due_date: string | null;
  entity_type: string | null;
  entity_id: string | null;
  priority: "low" | "medium" | "high" | "urgent";
  created_at: string;
}

export interface InventoryMovement {
  id: string;
  tenant_id?: string | null;
  partner_id: string;
  product_id: string;
  delta: number;
  reason: string;
  reference: string | null;
  created_at: string;
}

export interface EntityNote {
  id: string;
  tenant_id?: string | null;
  entity_type: string;
  entity_id: string;
  content: string;
  pinned: boolean;
  created_by: string | null;
  created_at: string;
}

export interface DashboardInsights {
  kpis: {
    partners_total: number;
    partners_active: number;
    deals_open: number;
    deals_won_value: number;
    pipeline_value: number;
    offers_pending: number;
    low_stock_count: number;
    invoices_outstanding: number;
    inventory_movements_30d: number;
  };
  deals_by_stage: { stage: DealStage; count: number; value: number }[];
  offers_last_30d: { date: string; count: number }[];
  revenue_last_30d: { date: string; value: number }[];
  recent_activity: AuditLog[];
  top_partners: { id: string; name: string; deal_value: number }[];
  low_stock_products: { id: string; name: string; sku: string; stock: number; reorder_level: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard analytics charts (task D-2)
// Aggregated datasets powering the five analytics charts on the dashboard:
//   1. SalesTrendChart       — `salesData`     (monthly revenue, last 12 months)
//   2. TopProductsChart      — `topProducts`   (top N products by offer revenue)
//   3. OfferStatusChart      — `offerStatus`   (count by OfferStatus)
//   4. MarginByCategoryChart — `marginByCategory` (avg profit margin by Product.category)
//   5. PaymentTrendChart     — `paymentTrend`  (monthly payments received)
//
// All series are pre-aggregated server-side so the client only renders.
// `period` is an opaque string echoed back for cache-keying — currently only
// "12m" is implemented; unknown values fall back to 12 months.
// ─────────────────────────────────────────────────────────────────────────────
export interface DashboardChartPoint {
  label: string;
  value: number;
}
export interface DashboardSalesPoint {
  /** ISO month bucket, e.g. "2026-01" */
  month: string;
  /** Short display label, e.g. "Jan 2026" (locale-neutral, pre-formatted server-side) */
  label: string;
  /** Revenue recognised in this month (sum of paid-invoice totals) */
  revenue: number;
  /** Number of paid invoices in this month */
  count: number;
}
export interface DashboardTopProduct {
  product_id: string;
  name: string;
  sku: string;
  /** Sum of line-item totals across all offers (any status) */
  revenue: number;
  /** Number of offer line-items this product appears on */
  count: number;
}
export interface DashboardOfferStatusSlice {
  status: OfferStatus;
  count: number;
  /** Aggregate offer `total` for this status, for tooltip context */
  value: number;
}
export interface DashboardMarginByCategory {
  /** Product.category (or "Uncategorised" when null) */
  category: string;
  /** Volume-weighted average margin % across products in this category */
  marginPct: number;
  /** Number of products in this category (for tooltip context) */
  productCount: number;
}
export interface DashboardPaymentPoint {
  /** ISO month bucket, e.g. "2026-01" */
  month: string;
  label: string;
  /** Sum of `invoices.total` where `paid_at` falls in this month */
  payments: number;
  count: number;
}
export interface DashboardCharts {
  period: string;
  salesData: DashboardSalesPoint[];
  topProducts: DashboardTopProduct[];
  offerStatus: DashboardOfferStatusSlice[];
  marginByCategory: DashboardMarginByCategory[];
  paymentTrend: DashboardPaymentPoint[];
}

// ---------- Invoices ----------
export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "cancelled";

export interface Invoice {
  id: string;
  tenant_id: string;
  number: string;
  offer_id: string | null;
  partner_id: string;
  status: InvoiceStatus;
  subject: string;
  currency: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  issue_date: string;
  due_date: string;
  sent_at: string | null;
  paid_at: string | null;
  notes: string | null;
  items: OfferLineItem[];
  // ── Trade / shipping fields (F-FINAL / P1) ───────────────────────────
  // These columns exist on the live `invoices` table (migration 007 +
  // supabase-schema-full.sql) but were missing from this interface —
  // every PDF render and offer→invoice automation that read them had
  // to cast through `any`. Typing them here keeps the trade-calculator
  // → offer → invoice flow type-safe end to end.
  pol: string | null;              // port of loading
  pod: string | null;              // port of discharge
  vessel: string | null;
  container_no: string | null;
  lead_time: number | null;
  packaging: string | null;
  payment_terms: string | null;
  incoterm: string | null;
  origin_country: string | null;
  // P1-1 / Feature 2 (SoD): the user who created the invoice. Backfilled
  // from audit_logs by migration 040; populated on insert by POST
  // /api/invoices. NULL on legacy rows — the SoD check fails open
  // (does not block) when this is NULL.
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Proformas ----------
// Status flow: draft → sent → accepted → paid (or expired/rejected at any point).
// "accepted" is the client's confirmation of the proforma; it unlocks
// invoice creation. Existing proformas with status "sent" remain valid —
// the create-invoice automation accepts either "accepted" or "sent".
//
// AUDIT2-LOGIC-UX H1 — "rejected" added as a proper terminal status. The
// portal respond route sets this when a client actively rejects a
// proforma (was previously collapsed into "expired", conflating an active
// rejection with a timeout). The state machine in status-validator.ts
// allows sent|viewed → rejected.
export type ProformaStatus = "draft" | "sent" | "viewed" | "accepted" | "paid" | "expired" | "rejected";

export interface Proforma {
  id: string;
  tenant_id: string;
  number: string;
  offer_id: string | null;
  partner_id: string;
  status: ProformaStatus;
  subject: string;
  currency: string;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  issue_date: string;
  valid_until: string;
  sent_at: string | null;
  paid_at: string | null;
  notes: string | null;
  items: OfferLineItem[];
  // ── Trade / shipping fields (F-FINAL / P1) ───────────────────────────
  // Parity with Invoice — same 9 fields, same nullability. The PDF
  // template reads these off the doc object via `as any` casts; typing
  // them here lets us drop those casts and catch regressions at compile
  // time.
  pol: string | null;              // port of loading
  pod: string | null;              // port of discharge
  vessel: string | null;
  container_no: string | null;
  lead_time: number | null;
  packaging: string | null;
  payment_terms: string | null;
  incoterm: string | null;
  origin_country: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Letter of Intent (LOI) ----------
export type LoiStatus = "draft" | "sent" | "accepted" | "rejected" | "expired" | "cancelled";

export interface LetterOfIntent {
  id: string;
  tenant_id: string;
  number: string;                    // e.g. LOI-2026-001
  partner_id: string;                // the seller partner (recipient of the LOI)
  buyer_name: string;                 // the buyer's legal name (issuing party)
  buyer_address: string | null;
  buyer_contact: string | null;       // contact person + email/phone
  subject: string;
  product_name: string;
  product_description: string | null;
  hs_code: string | null;
  origin_country: string | null;      // ISO alpha-2
  quantity: number;                   // quantity to purchase
  unit: string;                       // MT, KG, L, etc.
  unit_price: number;                 // price per unit
  currency: string;
  total_value: number;                // quantity * unit_price (server-computed)
  delivery_terms: string | null;      // incoterm + delivery location
  delivery_date: string | null;       // ISO date
  payment_terms: string | null;
  validity_until: string;             // ISO date — LOI is valid until this date
  status: LoiStatus;
  notes: string | null;
  terms_text: string | null;           // the full LOI body text (legal paragraphs)
  sent_at: string | null;
  responded_at: string | null;
  created_by: string | null;
  deal_id: string | null;              // optional link to a deal
  offer_id: string | null;             // optional link to an offer
  /** Optional link to a product in the tenant's catalog. When set, the LOI
   *  product_name/description/hs_code/origin_country/unit/unit_price were
   *  auto-populated from this product at creation time. */
  product_id?: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Document Register (V1/V2/V3 versioning) ----------
export type DocumentType = "offer" | "invoice" | "proforma" | "contract" | "spec" | "loi" | "other";

export interface DocumentRegisterEntry {
  id: string;
  tenant_id?: string | null;
  number: string; // e.g. OF-2026-001-V2
  type: DocumentType;
  version: number; // 1, 2, 3...
  reference_id: string | null; // offer_id / invoice_id etc.
  partner_id: string | null;
  title: string;
  status: "current" | "superseded" | "archived";
  created_by: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  // ── FIX-TENANT-DOC: file-upload + verification + linking extensions ──
  // The live `document_register` table has only the columns above; we did
  // NOT add new DB columns (the task allowed us to skip migration if too
  // complex). Instead, these fields are persisted inside the `metadata`
  // JSONB column by the API routes, and surfaced here as optional fields
  // so the UI can read them as if they were columns. The API layer is the
  // single place that reads/writes `metadata.<key>` ↔ these fields.
  /** Public URL of the uploaded file in the `documents` Supabase Storage
   *  bucket. Null for legacy rows created before the upload feature. */
  file_url?: string | null;
  /** Original client-supplied filename (kept for display only — the
   *  stored-path extension is derived from the server-verified MIME type
   *  via `uploadFile`, NOT the client filename, to prevent
   *  `evil.aspx` / `evil.htm` path pollution). */
  file_name?: string | null;
  /** Verification workflow state. New uploads default to "pending"; an
   *  admin flips it to "verified" or "rejected". Legacy rows (created
   *  before this feature) are treated as "verified" for backward-compat
   *  by the UI (the metadata key simply being absent). */
  verification_status?: "pending" | "verified" | "rejected";
  /** User id of the admin who verified / rejected the document. */
  verified_by?: string | null;
  /** ISO timestamp of the verify / reject action. */
  verified_at?: string | null;
  /** Reason captured when an admin rejects the document. Null when
   *  verification_status is "pending" or "verified". */
  reject_reason?: string | null;
  /** Optional link to an existing deal (CRM). */
  linked_deal_id?: string | null;
  /** Optional link to an existing invoice (Finance). */
  linked_invoice_id?: string | null;
  /** Optional link to an existing offer (Finance). */
  linked_offer_id?: string | null;
}

export interface DocumentRevision {
  id: string;
  tenant_id: string;
  document_id: string;
  version: number;
  change_note: string;
  created_by: string | null;
  created_at: string;
}

// ---------- Vault (encrypted secrets) ----------
export interface VaultSecret {
  id: string;
  tenant_id?: string | null;
  key: string;
  description: string | null;
  encrypted_value: string;
  /**
   * Encryption key version used for `encrypted_value`. NULL = legacy row
   * (use wire-format detection via `parseKeyVersion()` in vault-crypto.ts).
   * Added by migration 035 (audit P2-3 / task C-7) — purely informational;
   * the wire format is the source of truth at decrypt time.
   */
  key_version?: string | null;
  category: "api" | "smtp" | "database" | "payment" | "other";
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- API Keys ----------
export interface ApiKey {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string; // first 8 chars shown
  key_hash: string; // full hash, never returned to client
  permissions: string[];
  last_used_at: string | null;
  last_used_ip: string | null;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  /**
   * Phase 12 — OPTIONAL partner binding. When set, the key is scoped to
   * this partner (a marketplace API key created by a portal partner via
   * /api/marketplace/api-keys). When NULL, the key is tenant-level (the
   * original Phase-N API keys created by tenant admins via /api/api-keys).
   * The column was added by migration 053; pre-existing rows are NULL.
   */
  partner_id?: string | null;
}

// ---------- Webhooks ----------
export interface Webhook {
  id: string;
  tenant_id?: string | null;
  name: string;
  url: string;
  events: string[]; // e.g. ["offer.sent", "deal.won"]
  secret: string; // for signing payloads
  last_triggered_at: string | null;
  last_status: number | null; // HTTP status
  active: boolean;
  created_at: string;
}

// ---------- Webhook Deliveries ----------
// Each row represents a single attempt to deliver a webhook payload to a
// registered endpoint. Created by `triggerWebhooks()` in
// src/lib/webhooks/deliver.ts; retried by /api/cron/webhook-retry.
export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  tenant_id: string;
  event: string;
  payload: WebhookPayload;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  response_status: number | null;
  response_body: string | null;
  delivered_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

export interface WebhookPayload {
  event: string;
  entity_type: string;
  entity_id: string;
  tenant_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// ---------- Security (sessions, login history, IPs, devices) ----------
export interface SecuritySession {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  token?: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked: boolean;
  current: boolean;
}

export interface LoginHistoryEntry {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  username: string;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  success: boolean;
  reason: string | null;
  created_at: string;
}

export interface KnownIp {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  ip: string;
  country: string | null;
  first_seen: string;
  last_seen: string;
  trusted: boolean;
}

export interface TrustedDevice {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  device_name: string;
  fingerprint: string;
  ip: string | null;
  last_used: string;
  revoked: boolean;
  created_at: string;
}

// ---------- Mail Queue ----------
export type MailStatus = "queued" | "sending" | "sent" | "failed";

export interface MailQueueEntry {
  id: string;
  tenant_id?: string | null;
  to_email: string;
  subject: string;
  body: string;
  status: MailStatus;
  attempts: number;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

// ============================================================
// Multi-tenancy
// ============================================================
export interface Tenant {
  id: string;
  name: string;
  legal_name: string | null;
  country: string | null; // ISO 3166-1 alpha-2
  currency: string; // default currency
  tax_id: string | null;
  vat_number: string | null;
  registration_number: string | null;
  address_line: string | null;
  city: string | null;
  postal_code: string | null;
  // Contact (shown in PDF footer + portal)
  email: string | null;
  phone: string | null;
  website: string | null;
  // Bank details (for invoices)
  bank_name: string | null;
  bank_accounts: string | null;
  bank_iban: string | null;
  bank_swift: string | null;
  // Branding
  logo_url: string | null;
  primary_color: string | null;
  // Subscription
  plan: "trial" | "starter" | "business" | "enterprise" | "custom";
  /**
   * Tenant lifecycle status.
   *
   * `pending_approval` is the gating state for self-registered trial
   * tenants (FEAT-1 / Trial approval system): `POST /api/auth/register`
   * creates a tenant with `status = "pending_approval"` so the signup
   * is invisible to the user until a super_admin approves it via
   * `/api/super-admin/signup-requests/[id]/approve`. The approve flow
   * flips the status to `trial` and sets `trial_ends_at = now + 14d`.
   * The login route refuses to issue a session for any user whose
   * tenant is still in `pending_approval`.
   */
  status: "pending_approval" | "active" | "trial" | "suspended" | "cancelled";
  max_users: number;
  // Subscription details (live DB columns — CRIT-1)
  subscription_start?: string | null; // timestamptz
  subscription_end?: string | null; // timestamptz
  trial_ends_at?: string | null; // timestamptz
  billing_cycle?: string | null; // monthly | yearly
  amount_paid?: number | null; // numeric
  currency_paid?: string | null; // ISO 4217
  trial_days?: number | null; // int
  // Meta
  created_at: string;
  updated_at: string;
}

// ============================================================
// Product Catalog (base products) + Supplier Offers (variants)
// ============================================================
export interface ProductCatalogEntry {
  id: string;
  tenant_id: string;
  name: string;
  category: string; // see PRODUCT_CATEGORIES
  hs_code: string | null; // Harmonized System code
  description: string | null;
  base_unit: string; // see UNITS_OF_MEASURE
  // Specifications can be either an array of {name,value} pairs (current
  // Supabase data) or a Record<string,string> (legacy). UI code must
  // normalize both shapes — see portal-catalog.tsx for the helper pattern.
  specifications: Array<{ name: string; value: string }> | Record<string, string> | null;
  origin_country: string | null; // ISO alpha-2
  images: string[] | null;
  active: boolean;
  // Additional DB fields
  brand?: string | null;
  coa_params?: Record<string, unknown> | null;
  detailed_spec?: string | null;
  image_url?: string | null;
  inventory?: Record<string, unknown> | null;
  logistics?: Record<string, unknown> | null;
  old_id?: string | null;
  shelf_life?: string | null;
  sku?: string | null;
  tags?: string[] | null;
  created_at: string;
  updated_at: string;
}

export type SupplierOfferStatus = "active" | "expired" | "on_hold" | "consumed";

export interface SupplierOffer {
  id: string;
  tenant_id: string;
  product_id: string; // → ProductCatalogEntry
  supplier_id: string; // → Partner (type supplier)
  // Identification
  offer_number: string | null; // supplier's own ref
  status: SupplierOfferStatus;
  // Pricing
  unit_price: number;
  currency: string;
  min_order_qty: number | null;
  price_valid_until: string | null;
  // Product details (override base product if this supplier differs)
  packaging: string | null; // e.g. "50 kg PP bags", "1 MT big bag", "25 kg carton"
  packing_details: string | null; // e.g. "palletized, stretch-wrapped"
  loadability: string | null; // e.g. "28 MT per 40' HC container"
  specification_notes: string | null; // deviations from base spec
  origin_country: string | null;
  // Trade terms
  incoterm: string; // EXW, FOB, CIF, etc.
  loading_port: string | null;
  delivery_port: string | null;
  lead_time_days: number | null;
  payment_terms: string | null;
  // Quality
  inspection: string | null; // e.g. "SGS", "Bureau Veritas"
  certificate: string | null; // e.g. "ISO 22000", "Halal", "Organic"
  // Meta
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Trade Cost Calculation (landed cost + margin)
// ============================================================
export interface TradeCostLine {
  type: string; // see TRADE_COST_TYPES
  label: string;
  basis: "unit" | "percent" | "fixed" | "per_container";
  value: number; // amount or percentage
  currency: string; // currency of this line's `value` / `amount`
  amount: number; // computed amount in this line's currency (legacy field — kept for back-compat)
  // ── Multi-currency conversion (added 2026-08) ──
  // fx_rate: rate to convert `amount` from `currency` → buy_currency
  //          (1 when line.currency === calc.buy_currency).
  //          User-overridable; defaults to live rate on currency change.
  // converted_amount: amount * fx_rate (cached, in buy_currency).
  //                    Always set server-side; clients may omit on input.
  fx_rate?: number;
  converted_amount?: number;
}

export interface TradeCalculation {
  id: string;
  tenant_id: string;
  name: string;
  // Source
  product_id: string | null;
  supplier_offer_id: string | null;
  supplier_id: string | null;
  buyer_id: string | null;
  // Quantities
  quantity: number;
  unit: string;
  num_containers: number;
  container_type: string | null;
  // Buy side
  buy_price_per_unit: number;
  buy_currency: string;
  buy_incoterm: string;
  // Sell side
  sell_price_per_unit: number;
  sell_currency: string;
  sell_incoterm: string;
  // Transport
  transport_mode: string;
  loading_port: string | null;
  delivery_port: string | null;
  // Exchange rate (if buy/sell currencies differ)
  exchange_rate: number; // sell_currency per buy_currency
  // Cost lines (freight, insurance, customs, etc.)
  cost_lines: TradeCostLine[];
  // Results (computed)
  total_buy_cost: number;
  total_landed_cost: number;
  total_sell_revenue: number;
  gross_margin: number;
  margin_percent: number;
  // Commission tracking (optional — when set, offers created from this
  // calculation auto-track a commission obligation on accept; see Fix 2 chain
  // in POST /api/offers and offer-preview route).
  commission_agent_id?: string | null;
  commission_type?: string | null;
  commission_rate?: number | null;

  // Meta
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Extended offer line item with trade context
export interface TradeOfferLineItem extends OfferLineItem {
  product_catalog_id: string | null;
  supplier_offer_id: string | null;
  supplier_name: string | null;
  origin_country: string | null;
  hs_code: string | null;
  incoterm: string | null;
}

// ============================================================
// Partner entity type (individual vs company)
// ============================================================
export type PartnerEntityType = "company" | "individual";

// Portal access tiers — from most restricted to full
/**
 * Portal access tiers — 4 levels.
 *
 * - `premium`   — VIP clients. KYC verification is optional (light review only),
 *                 document upload optional, geolocation NOT required. Full
 *                 feature access including PDF downloads and RFQ submission.
 * - `business`  — Trusted regular clients. Full KYC required, document upload
 *                 required, geolocation required. Full feature access.
 * - `standard`  — Standard clients. Full KYC + documents + geolocation.
 *                 Can view offers/documents/catalog and submit RFQs but
 *                 cannot download PDFs.
 * - `basic`     — Entry-level / trial clients. Full KYC + documents +
 *                 geolocation. Read-only access to catalog and own offers
 *                 (no RFQ submission, no PDF download).
 *
 * `limited` is kept as a legacy alias for backward compatibility with rows
 * created before this enum was expanded — new code should map it to `basic`.
 */
export type PortalTier = "premium" | "business" | "standard" | "basic" | "limited";

// ============================================================
// Portal access configuration (per-partner)
// ============================================================
export interface PortalAccess {
  id: string;
  partner_id: string;
  tenant_id: string;
  tier: PortalTier;
  // Feature flags controlled by admin
  can_view_offers: boolean;
  can_view_documents: boolean;
  can_view_catalog: boolean;
  can_view_invoices: boolean;
  can_view_profile: boolean;
  can_view_company_info: boolean;
  can_submit_rfq: boolean;
  can_download_pdf: boolean;
  // Compliance exemptions (premium clients)
  exempt_kyc: boolean;
  exempt_document_upload: boolean;
  exempt_location_share: boolean;
  // Onboarding status
  status: "pending_approval" | "approved" | "invited" | "active" | "suspended" | "revoked";
  approved_by: string | null;
  approved_at: string | null;
  invited_at: string | null;
  welcome_email_sent: boolean;
  // Access credentials
  portal_email: string | null;
  password_hash: string | null;
  must_set_password: boolean;
  last_login_at: string | null;
  last_login_ip: string | null;
  /**
   * Country of the most recent successful login (resolved from last_login_ip
   * via ipapi.co). Optional because the underlying column is added by
   * migration `005_portal_access_last_login_country.sql` and may not yet
   * exist on every deployment — the store layer falls back gracefully.
   */
  last_login_country?: string | null;
  /**
   * ISO timestamp of the most recent precise GPS verification shared by the
   * portal client (POST /api/portal/log-location with `source === "browser"`).
   * Used by `requireGpsVerified()` to gate portal data endpoints — a portal
   * user with a valid session cookie must share location within the last 24h
   * or be premium / exempt_location_share.
   *
   * Optional because the underlying column is added by migration
   * `015_portal_access_gps_verified_at.sql` and may not yet exist on every
   * deployment — the store layer falls back gracefully.
   */
  gps_verified_at?: string | null;
  /**
   * Per-client language preference (en/sr/tr/de/ru).
   * Optional — added by migration 019. Defaults to 'en' in the DB.
   * Set by the portal language selector, restored on login.
   */
  locale?: string | null;
  created_at: string;
  updated_at: string;
  // Brute-force protection + session revocation on password change
  failed_attempts: number;
  locked_until: string | null;
  token_version: number;
}

// ============================================================
// Document Template (memorandum layout)
// ============================================================
export interface DocumentTemplate {
  id: string;
  tenant_id: string;
  name: string;
  type: "offer" | "invoice" | "proforma" | "contract" | "generic";
  is_default: boolean;
  // Page layout
  page_size: "A4" | "Letter";
  page_margin_top: number; // mm
  page_margin_bottom: number;
  page_margin_left: number;
  page_margin_right: number;
  // Header
  header_enabled: boolean;
  header_height: number; // mm
  header_content: string; // rich text / markdown
  header_show_logo: boolean;
  header_show_company_name: boolean;
  header_show_contact: boolean;
  // Footer
  footer_enabled: boolean;
  footer_height: number;
  footer_content: string;
  footer_show_page_number: boolean;
  footer_show_bank_details: boolean;
  footer_show_tax_id: boolean;
  // Body styling
  body_font_family: string;
  body_font_size: number;
  body_line_height: number;
  primary_color: string; // hex
  accent_color: string;
  // Table styling
  table_header_bg: string;
  table_header_color: string;
  table_border_color: string;
  table_stripe: boolean;
  // Linked branding assets
  letterhead_id: string | null;
  seal_id: string | null;
  seal_enabled: boolean;
  letterhead?: TenantLetterhead | null;
  seal?: TenantSeal | null;
  /** Which bank accounts to show in PDF (indexes into tenant.bank_accounts array).
   *  null/empty = show all accounts. [0,2] = show only 1st and 3rd accounts. */
  selected_bank_accounts?: number[] | null;
  // ── QR code placement ─────────────────────────────────────────────
  // NOTE: these fields are NOT real DB columns. They live inside
  // `footer_content` as a `_qrConfig` JSON sub-key (see
  // src/components/views/document-templates-view.tsx → handleSave). They're
  // declared on the type so the PDF renderer + visual editor can read/write
  // them with type safety.
  /** QR code placement. Default: "footer-right". */
  qr_position?: string | null; // "footer-right" | "footer-left" | "footer-center" | "none"
  /** QR code size in mm. Default: 15. */
  qr_size_mm?: number | null;
  /** QR code opacity 0..1. Default: 1.0. */
  qr_opacity?: number | null;
  // Metadata
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// TenantLetterhead — Memorandum firme (company letterhead)
// ============================================================
export interface TenantLetterhead {
  id: string;
  tenant_id: string;
  name: string;
  is_default: boolean;
  // Company identity
  company_name: string | null;
  company_legal_name: string | null;
  company_address_line: string | null;
  company_city: string | null;
  company_postal_code: string | null;
  company_country: string | null;
  company_email: string | null;
  company_phone: string | null;
  company_website: string | null;
  company_vat_number: string | null;
  company_tax_id: string | null;
  company_registration_number: string | null;
  // Bank details
  bank_name: string | null;
  bank_iban: string | null;
  bank_swift: string | null;
  bank_account_holder: string | null;
  // Logo
  logo_url: string | null;
  logo_position: "left" | "center" | "right";
  logo_width_mm: number;
  logo_height_mm: number;
  logo_lock_aspect: boolean;
  // Branding colors
  primary_color: string;
  accent_color: string;
  text_color: string;
  muted_text_color: string;
  // Page layout
  page_size: "A4" | "Letter";
  margin_top_mm: number;
  margin_bottom_mm: number;
  margin_left_mm: number;
  margin_right_mm: number;
  header_height_mm: number;
  footer_height_mm: number;
  // Header layout
  header_layout: string;
  header_show_logo: boolean;
  header_show_company_name: boolean;
  header_show_contact: boolean;
  header_show_vat: boolean;
  header_divider: boolean;
  header_divider_color: string;
  header_custom_html: string | null;
  // Footer layout
  footer_layout: string;
  footer_show_bank_details: boolean;
  footer_show_contact: boolean;
  footer_show_tax_id: boolean;
  footer_show_page_number: boolean;
  footer_divider: boolean;
  footer_divider_color: string;
  footer_custom_html: string | null;
  footer_text: string | null;
  // Watermark
  watermark_enabled: boolean;
  watermark_text: string | null;
  watermark_color: string;
  watermark_opacity: number;
  watermark_rotation: number;
  // Typography
  body_font_family: string;
  body_font_size_pt: number;
  heading_font_family: string;
  heading_font_size_pt: number;
  // Metadata
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// TenantSeal — Zigled (company seal / stamp)
// ============================================================
export interface TenantSeal {
  id: string;
  tenant_id: string;
  name: string;
  is_default: boolean;
  // Seal image
  image_url: string;
  image_width_mm: number;
  image_height_mm: number;
  image_format: "png" | "jpg" | "svg";
  // Placement
  position: "bottom-right" | "bottom-left" | "bottom-center" | "top-right" | "top-left" | "top-center";
  offset_x_mm: number;
  offset_y_mm: number;
  opacity: number;
  rotation_deg: number;
  // Apply to types
  apply_to_types: string; // JSON array string
  // Signature
  signature_enabled: boolean;
  signature_label: string | null;
  signature_name: string | null;
  // Metadata
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// MemorandumSettings — per-tenant header/footer/body configuration
// ============================================================
// NOTE: the canonical MemorandumSettings interface is defined at the bottom
// of this file (matches supabase/migrations/003_memorandum_settings.sql).
// The PDF generator + renderer read it via `import { MemorandumSettings }`.

// ============================================================
// Document verification (QR + hash forensics)
// ============================================================
export interface DocumentVerification {
  id: string;
  tenant_id: string;
  document_type: "offer" | "invoice" | "proforma" | "loi";
  document_id: string;
  document_number: string;
  verification_code: string; // unique, embedded in QR
  pdf_hash: string; // SHA-256 of original PDF bytes
  pdf_size: number;
  issued_to_partner_id: string | null;
  issued_at: string;
  // Verification tracking
  verification_count: number;
  last_verified_at: string | null;
  last_verified_ip: string | null;
  // Status
  status: "active" | "revoked" | "superseded";
  created_at: string;
}

export interface VerificationLog {
  id: string;
  verification_id: string;
  code: string;
  verified_at: string;
  ip: string | null;
  user_agent: string | null;
  result: "valid" | "invalid" | "revoked" | "modified";
  details: string | null;
}

// ============================================================
// KYC (Know Your Customer) — full compliance workflow
// ============================================================
export type KycSubmissionStatus = "draft" | "submitted" | "under_review" | "approved" | "rejected" | "resubmit";
export type KycDocumentType =
  | "passport"
  | "id_card"
  | "company_registration"
  | "tax_certificate"
  | "vat_certificate"
  | "bank_statement"
  | "utility_bill"
  | "beneficial_owner_declaration"
  | "trade_license"
  | "chamber_of_commerce"
  | "other";

export interface KycDocument {
  id: string;
  submission_id: string;
  type: KycDocumentType;
  filename: string;
  storage_path: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  // Optional fields for backward compat with view components
  file_path?: string | null;
  url?: string | null;
  status?: string;
}

export interface KycSubmission {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  status: KycSubmissionStatus;

  // Entity type
  entity_type: PartnerEntityType;

  // Company / Individual data
  legal_name: string | null;
  trade_name: string | null;
  registration_number: string | null;
  tax_id: string | null;
  vat_number: string | null;
  company_website: string | null;

  // Address
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;

  // Contact person
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_position: string | null;

  // Beneficial owner (for AML)
  owner_name: string | null;
  owner_id_type: string | null; // passport, id_card
  owner_id_number: string | null;
  owner_nationality: string | null;
  owner_dob: string | null;
  owner_address: string | null;

  // Business details
  business_activity: string | null;
  expected_monthly_volume: string | null;
  source_of_funds: string | null;

  // Bank
  bank_name: string | null;
  bank_account: string | null;
  bank_iban: string | null;
  bank_swift: string | null;

  // Documents (metadata — actual files in storage)
  documents: KycDocument[];

  // Review
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  rejection_reason: string | null;
  auto_transferred: boolean; // true if data was auto-transferred to partner record on approval

  // Meta
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Portal RFQ — client requests a product not in catalog
// ============================================================
export type PortalRfqStatus = "pending" | "quoted" | "accepted" | "declined" | "expired";

export interface PortalRfq {
  id: string;
  tenant_id: string;
  partner_id: string;
  portal_access_id: string | null;
  number: string; // RFQ-2026-XXX
  status: PortalRfqStatus;

  // What the client wants
  product_name: string;
  product_description: string | null;
  category: string | null; // from PRODUCT_CATEGORIES
  quantity: number;
  unit: string;
  target_price: number | null;
  currency: string;

  // Delivery
  delivery_country: string | null;
  delivery_port: string | null;
  delivery_date: string | null;
  incoterm: string | null;

  // Additional
  specifications: string | null;
  notes: string | null;

  // Extended intake (used to price the offer accurately)
  target_market: string | null;          // e.g. "construction", "automotive", "food"
  end_use: string | null;                // free-text description of how the product will be used
  payment_method: string | null;         // "wire" | "lc" | "escrow" | "cash" | "other"
  payment_terms: string | null;          // free-text: "net 30", "lc at sight", …
  delivery_schedule: string | null;      // "one_time" | "monthly" | "quarterly" | "annually"
  per_shipment_qty: number | null;       // for recurring
  shipments_per_period: number | null;
  contract_duration_months: number | null;
  urgency: string | null;                // "flexible" | "normal" | "urgent"
  packaging_requirements: string | null;
  certifications_required: string | null;
  quality_standard: string | null;

  // Buyer identity
  buyer_type: "self" | "third_party" | null;
  third_party_company_name: string | null;
  third_party_business_type: string | null;
  third_party_country: string | null;
  third_party_contact_email: string | null;
  third_party_contact_phone: string | null;
  third_party_tax_id: string | null;
  third_party_website: string | null;

  // Trace back to catalog / entry channel
  product_id: string | null;
  source: string | null;                 // "catalog" | "form" | "chat" | "email"

  // Admin response
  linked_offer_id: string | null;
  linked_demand_id: string | null;
  admin_notes: string | null;

  // Meta
  created_at: string;
  updated_at: string;
}

// ============================================================
// Feature Flags per Tenant
// ============================================================
export interface TenantFeatureFlags {
  id: string;
  tenant_id: string;
  // Module toggles
  module_crm: boolean;
  module_trade: boolean; // product catalog + supplier offers + trade calculator
  module_finance: boolean; // invoices + proformas
  module_inventory: boolean;
  module_portal: boolean; // client portal
  module_logistics: boolean; // freight quote requests + packing lists
  module_kyc: boolean; // KYC verification
  module_document_templates: boolean;
  module_document_verification: boolean; // QR + forensic
  module_vault: boolean;
  module_api_keys: boolean;
  module_webhooks: boolean;
  module_mail_queue: boolean;
  module_security: boolean; // security center
  // Feature limits
  max_partners: number; // 0 = unlimited
  max_users: number;
  max_monthly_documents: number; // 0 = unlimited
  // Beta features
  beta_ai_assistant: boolean;
  beta_advanced_analytics: boolean;
  // Meta
  updated_by: string | null;
  updated_at: string;
}

// ============================================================
// Notifications — in-app + email triggers
// ============================================================
export type NotificationType =
  | "kyc_submitted"
  | "kyc_approved"
  | "kyc_rejected"
  | "rfq_received"
  | "rfq_quoted"
  | "offer_sent"
  | "offer_accepted"
  | "offer_rejected"
  | "offer_expired"
  // FIX-MARKET-UI / FIX 3 — portal client countered an offer.
  | "offer_countered"
  | "invoice_sent"
  | "invoice_overdue"
  | "invoice_paid"
  | "proforma_sent"
  | "proforma_accepted"
  | "proforma_rejected"
  // BUILD-LOI — Letter of Intent lifecycle events. Mirrors the
  // offer_sent / proforma_sent / invoice_sent pattern so the partner's
  // portal bell surfaces LOI send/accept/reject the same way it does for
  // other outbound documents.
  | "loi_sent"
  | "loi_accepted"
  | "loi_rejected"
  | "document_shared"
  | "portal_access_requested"
  | "portal_access_approved"
  | "portal_invite_sent"
  | "task_assigned"
  | "task_due_soon"
  | "low_stock_alert"
  | "system_message"
  | "portal_message"
  | "email_failed"
  // Marketplace (Phase 2 — negotiation rooms + notifications)
  | "marketplace_response_received" // post owner received a new offer/response
  | "marketplace_response_accepted" // responder's offer was accepted by the post owner
  | "marketplace_response_rejected" // responder's offer was rejected by the post owner
  | "marketplace_message_received" // other party sent a message in a negotiation room
  // FEAT-1 / Trial approval system — fires when a new tenant self-registers
  // with status="pending_approval". Tied to the pending tenant's tenant_id
  // (the only tenant_id available at signup time — super_admins have
  // tenant_id = NULL in the users table so they cannot receive in-app
  // notifications via the regular /api/notifications route; the
  // signup-requests queue is the polling surface for super_admins).
  // An email is also sent to every super_admin via `notifySuperAdmins`
  // (best-effort).
  | "signup_request"

export interface Notification {
  id: string;
  tenant_id: string;
  user_id: string | null; // null = broadcast to all tenant users
  partner_id: string | null; // null = not partner-specific; for portal notifications
  type: NotificationType;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  read: boolean;
  read_at: string | null;
  // Metadata for action buttons
  action_url: string | null;
  action_label: string | null;
  created_at: string;
}

// ============================================================
// Commission Agents (Komisionari)
// ============================================================

/**
 * How the commission is calculated:
 * - "profit_percent"  → % of deal profit (sell_price - buy_cost)
 * - "revenue_percent" → % of deal revenue (total sell value)
 * - "fixed"           → fixed amount per deal
 * - "per_unit"        → fixed amount per unit of measure sold
 * - "custom"          → custom formula (stored in commission_custom_formula)
 */
export type CommissionType = "profit_percent" | "revenue_percent" | "fixed" | "per_unit" | "custom";

export type CommissionStatus = "pending" | "approved" | "paid" | "cancelled";

/**
 * Commission agent — a partner who introduces clients and earns a commission.
 * Any Partner can be marked as a commission agent via the `is_commissioner` flag.
 * The commission settings are stored here for easy reference.
 */
export interface CommissionAgent {
  id: string;
  tenant_id: string;
  partner_id: string; // → Partner (the person/firm who is the commission agent)
  // Commission settings
  commission_type: CommissionType;
  commission_rate: number; // percentage (e.g. 5 = 5%) or fixed amount
  commission_per_unit: number; // amount per unit when type = "per_unit"
  commission_custom_formula: string | null; // custom formula description when type = "custom"
  commission_currency: string; // currency for fixed/per_unit amounts
  // Default settings — can be overridden per deal
  is_default: boolean; // if true, auto-apply to new deals with this partner
  // Status
  active: boolean;
  notes: string | null;
  // Meta
  created_at: string;
  updated_at: string;
}

/**
 * Deal commission — links a specific deal to a commission agent with
 * the commission calculation details for that deal.
 */
export interface DealCommission {
  id: string;
  tenant_id: string;
  deal_id: string; // → Deal
  agent_id: string; // → CommissionAgent
  partner_id: string; // → Partner (the commission agent's partner record)
  // Commission calculation
  commission_type: CommissionType;
  commission_rate: number; // the rate used for this specific deal
  commission_per_unit: number; // per-unit rate used
  commission_custom_formula: string | null;
  commission_currency: string;
  // Calculated amounts
  deal_value: number; // total deal value at time of commission calculation
  deal_profit: number; // profit (revenue - cost) at time of calculation
  deal_quantity: number; // quantity of units sold
  deal_unit: string; // unit of measure
  calculated_commission: number; // the final commission amount
  // Status
  status: CommissionStatus;
  approved_by: string | null;
  approved_at: string | null;
  paid_at: string | null;
  payout_reference: string | null; // payment reference / receipt number
  notes: string | null;
  // Meta
  created_at: string;
  updated_at: string;
}

/**
 * Commission payout — tracks payments made to commission agents.
 * One payout can cover multiple deal commissions.
 */
export interface CommissionPayout {
  id: string;
  tenant_id: string;
  agent_id: string; // → CommissionAgent
  partner_id: string; // → Partner (the commission agent's partner record)
  // Payout details
  total_amount: number;
  currency: string;
  commission_ids: string[]; // → DealCommission IDs included in this payout
  // Payment info
  payment_method: string | null; // "bank_transfer", "cash", etc.
  payment_reference: string | null;
  paid_at: string | null;
  status: "pending" | "completed" | "cancelled";
  notes: string | null;
  // Meta
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Commission summary for an agent — computed aggregate.
 */
export interface CommissionSummary {
  agent_id: string;
  partner_id: string;
  partner_name: string;
  total_deals: number;
  total_commission: number;
  paid_commission: number;
  pending_commission: number;
  currency: string;
}

// ─── ERP / Accounting ────────────────────────────────────────────────────

export interface ErpAccount {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  name_en: string | null;
  account_type: string; // asset, liability, equity, revenue, expense
  account_category: string | null; // current_asset, fixed_asset, current_liability, etc.
  parent_id: string | null;
  is_active: boolean;
  is_system: boolean;
  standard: string | null; // eu, uae
  tax_code: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  // computed
  children?: ErpAccount[]; // virtual (joined)
  parent?: ErpAccount; // virtual (joined)
}

export interface FiscalPeriod {
  id: string;
  tenant_id: string;
  name: string;
  start_date: string;
  end_date: string;
  period_type: string; // monthly, quarterly, yearly
  status: string; // open, closed, locked
  fiscal_year: number;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErpJournalEntry {
  id: string;
  tenant_id: string;
  entry_number: string;
  date: string;
  description: string;
  reference_type: string | null; // deal, invoice, proforma, commission, manual, bank
  reference_id: string | null;
  fiscal_period_id: string | null;
  status: string; // draft, posted, reversed, cancelled
  source_type: string | null; // auto, manual
  debit_total: number;
  credit_total: number;
  currency: string;
  exchange_rate: number;
  // E-2 (multi-currency ERP): base currency + FX revaluation metadata.
  // base_currency is the tenant's reporting currency (e.g. USD); the
  // per-line currency/fx_rate/debit_base/credit_base columns on
  // ErpJournalLine express each line in its own currency AND its base
  // equivalent. is_revaluation + revaluation_of mark entries produced
  // by the create_fx_revaluation(...) RPC so reports can identify them
  // and exclude/include them as accounting policy requires.
  base_currency?: string | null;
  is_revaluation?: boolean | null;
  revaluation_of?: string | null; // UUID-as-text of the originating entry
  notes: string | null;
  created_by: string;
  posted_by: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
  // virtual (joined)
  lines?: ErpJournalLine[];
}

export interface ErpJournalLine {
  id: string;
  tenant_id?: string | null;
  journal_entry_id: string;
  account_id: string;
  line_number: number;
  description: string | null;
  debit: number;
  credit: number;
  currency: string;
  // E-2 (multi-currency ERP): per-line FX conversion. fx_rate is the
  // rate used to convert `debit`/`credit` (foreign) into `debit_base`
  // / `credit_base` (base currency). For lines in the base currency,
  // fx_rate = 1 and debit_base = debit, credit_base = credit. For
  // revaluation adjustments that have no meaningful foreign amount,
  // debit/credit stay 0 and the base amounts carry the adjustment.
  fx_rate?: number | null;
  debit_base?: number | null;
  credit_base?: number | null;
  partner_id: string | null;
  cost_center_id: string | null;
  created_at: string;
  // virtual (joined)
  account?: ErpAccount;
  partner?: Partner;
}

// E-2 (multi-currency ERP) — input passed to `create_fx_revaluation`.
// One per open foreign-currency balance (account) whose rate has moved
// since the original posting.
export interface FxRevaluationAdjustment {
  account_id: string;          // erp_accounts.id of the foreign-currency account
  currency: string;            // ISO 4217 code of the foreign currency
  fx_rate_old: number;         // rate at the original posting (or last reval)
  fx_rate_new: number;         // current rate at the reval date
  balance_foreign: number;    // signed open balance in the foreign currency
                               //   +debit balance (asset like AR/Bank)
                               //   -credit balance (liability like AP)
  gain_loss_account_id: string; // erp_accounts.id of the FX P&L account
  description?: string;
}

// E-2 (multi-currency ERP) — return shape of `create_fx_revaluation`.
// Matches the JSONB returned by the RPC.
export interface FxRevaluationResult {
  id: string;                  // new erp_journal_entries.id
  entry_number: string;        // e.g. REVAL-20250817-0001
  line_count: number;          // number of lines created (2 × adjustments)
  total_debit_base: number;    // sum of debit_base across lines (== total_credit_base)
  total_credit_base: number;
}

export interface ErpCostCenter {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  parent_id: string | null;
  is_active: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
  children?: ErpCostCenter[]; // virtual (joined)
  parent?: ErpCostCenter; // virtual (joined)
}

export interface ErpBankAccount {
  id: string;
  tenant_id: string;
  account_id: string;
  bank_name: string;
  account_number: string;
  iban: string | null;
  swift_bic: string | null;
  currency: string;
  balance: number;
  is_active: boolean;
  // Additional DB fields
  linked_company_bank_idx?: number | null;
  old_id?: string | null;
  created_at: string;
  updated_at: string;
  // virtual (joined)
  account?: ErpAccount;
  transactions?: ErpBankTransaction[];
}

export interface ErpBankTransaction {
  id: string;
  tenant_id: string;
  bank_account_id: string;
  date: string;
  amount: number;
  transaction_type: string; // debit, credit
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  counterparty_account: string | null;
  is_reconciled: boolean;
  reconciled_with: string | null;
  journal_entry_id: string | null;
  // Additional DB fields
  category?: string | null;
  deal_id?: string | null;
  invoice_number?: string | null;
  is_auto_generated?: boolean | null;
  old_id?: string | null;
  updated_at?: string;
  created_at: string;
  // virtual (joined)
  bank_account?: ErpBankAccount;
  journal_entry?: ErpJournalEntry;
}

export interface ErpSetting {
  id: string;
  tenant_id: string;
  accounting_standard: string; // eu, uae
  fiscal_year_start: string; // MM-DD
  fiscal_year_end: string; // MM-DD
  default_currency: string;
  vat_enabled: boolean;
  vat_rate: number;
  vat_return_period: string; // monthly, quarterly, yearly
  auto_post_journal: boolean;
  revenue_account_id: string | null;
  expense_account_id: string | null;
  receivable_account_id: string | null;
  payable_account_id: string | null;
  vat_account_id: string | null;
  bank_charges_account_id: string | null;
  cash_account_id: string | null;
  retention_account_id: string | null;
  round_off_account_id: string | null;
  created_at: string;
  updated_at: string;
}

// ERP Report types
export interface TrialBalanceItem {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  debit_total: number;
  credit_total: number;
  balance: number;
  // E-2 (multi-currency ERP): base-currency equivalents. When the journal
  // has multi-currency lines, `debit_total`/`credit_total`/`balance` reflect
  // the foreign amounts (kept for backward compat with existing report
  // consumers) while `debit_total_base`/`credit_total_base`/`balance_base`
  // reflect the base-currency aggregated amounts that actually balance.
  debit_total_base?: number;
  credit_total_base?: number;
  balance_base?: number;
}

export interface TrialBalance {
  items: TrialBalanceItem[];
  total_debit: number;
  total_credit: number;
  as_of_date: string;
  // E-2 (multi-currency ERP): base-currency totals. Should always equal
  // each other (double-entry in the base currency).
  total_debit_base?: number;
  total_credit_base?: number;
  base_currency?: string;
}

export interface BalanceSheetItem {
  account_code: string;
  account_name: string;
  amount: number;
  // E-2 (multi-currency ERP): base-currency equivalent. Falls back to
  // `amount` for entries with no multi-currency lines.
  amount_base?: number;
  children?: BalanceSheetItem[];
}

export interface BalanceSheet {
  assets: BalanceSheetItem[];
  liabilities: BalanceSheetItem[];
  equity: BalanceSheetItem[];
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
  as_of_date: string;
  // E-2 (multi-currency ERP): base-currency totals.
  total_assets_base?: number;
  total_liabilities_base?: number;
  total_equity_base?: number;
  base_currency?: string;
}

export interface ProfitAndLoss {
  revenue: BalanceSheetItem[];
  expenses: BalanceSheetItem[];
  total_revenue: number;
  total_expenses: number;
  net_profit: number;
  period_start: string;
  period_end: string;
  // E-2 (multi-currency ERP): base-currency totals.
  total_revenue_base?: number;
  total_expenses_base?: number;
  net_profit_base?: number;
  base_currency?: string;
}

export interface GeneralLedgerEntry {
  journal_entry_id: string;
  entry_number: string;
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  reference_type: string | null;
  reference_id: string | null;
  // E-2 (multi-currency ERP): base-currency equivalents.
  debit_base?: number;
  credit_base?: number;
  balance_base?: number;
  currency?: string;
}

export interface GeneralLedger {
  account_id: string;
  account_code: string;
  account_name: string;
  entries: GeneralLedgerEntry[];
  opening_balance: number;
  closing_balance: number;
  total_debit: number;
  total_credit: number;
  // E-2 (multi-currency ERP): base-currency equivalents.
  opening_balance_base?: number;
  closing_balance_base?: number;
  total_debit_base?: number;
  total_credit_base?: number;
  base_currency?: string;
}

export interface UserPreference {
  id: string;
  user_id: string;
  preference_key: string;
  preference_value: string;
  updated_at: string;
}

// ============================================================
// Partner Connections (graph edges between partners)
// ============================================================
export interface PartnerConnection {
  id: string;
  tenant_id: string;
  source_id: string;
  target_id: string;
  relation_type: string | null;
  notes: string | null;
  created_at: string;
}

// ============================================================
// Recurring Expenses
// ============================================================
export interface RecurringExpense {
  id: string;
  tenant_id: string;
  account_id: string;
  description: string;
  category: string | null;
  amount: number;
  currency: string;
  day_of_month: number;
  start_date: string | null;
  last_applied: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Memorandum Settings (per-tenant PDF header/footer config)
// ------------------------------------------------------------
// One row per tenant (UNIQUE(tenant_id)). The GET
// /api/memorandum-settings endpoint auto-creates a row with
// all defaults on first fetch, so tenants never have to "save"
// before they can preview. The PDF generator reads these to
// render the memorandum (header + footer) on every page.
// ============================================================
export interface MemorandumSettings {
  id: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;

  // Header
  header_enabled: boolean;
  header_height_mm: number;
  header_bg_color: string;

  // Header left (company name)
  header_left_font_family: string;
  header_left_font_size: number;
  header_left_font_color: string;
  header_left_font_bold: boolean;

  // Header right (logo)
  logo_enabled: boolean;
  logo_max_width_mm: number;
  logo_max_height_mm: number;
  logo_position_x_mm: number;
  logo_position_y_mm: number;
  logo_fit_mode: string;

  // Footer
  footer_enabled: boolean;
  footer_height_mm: number;
  footer_bg_color: string;

  // Footer left (QR)
  qr_enabled: boolean;
  qr_size_mm: number;
  qr_position_x_mm: number;
  qr_position_y_mm: number;

  // Footer center (address)
  footer_center_font_family: string;
  footer_center_font_size: number;
  footer_center_font_color: string;
  footer_center_alignment: string;

  // Footer right (page number)
  footer_right_font_family: string;
  footer_right_font_size: number;
  footer_right_font_color: string;

  // Column widths (percentages — should sum to 100)
  footer_left_width_pct: number;
  footer_center_width_pct: number;
  footer_right_width_pct: number;

  // Body
  body_font_family: string;
  body_font_size: number;
  body_line_height: number;
  body_text_color: string;
  primary_color: string;
}
