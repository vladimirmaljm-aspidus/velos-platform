// Data store interface + factory.
// The app talks to this interface; the concrete implementation is either
// SupabaseStore (production Supabase, default), MockStore (in-memory, empty),
// or PrismaStore (Prisma + SQLite, legacy).

import {
  User, Partner, Product, Deal, Offer, Demand, SharedDocument,
  AuditLog, Setting, UserTask, InventoryMovement, EntityNote,
  DashboardInsights, DashboardCharts,
  Invoice, Proforma, LetterOfIntent, DocumentRegisterEntry, DocumentRevision,
  VaultSecret, ApiKey, Webhook, WebhookDelivery, WebhookPayload,
  SecuritySession, LoginHistoryEntry, KnownIp, TrustedDevice,
  MailQueueEntry,
  Tenant, ProductCatalogEntry, SupplierOffer, TradeCalculation,
  PortalAccess, DocumentTemplate, DocumentVerification, VerificationLog,
  TenantLetterhead, TenantSeal,
  KycSubmission, KycDocument, PortalRfq,
  TenantFeatureFlags,
  Notification, NotificationType,
  CommissionAgent, DealCommission, CommissionPayout, CommissionSummary,
  ErpAccount, FiscalPeriod, ErpJournalEntry, ErpJournalLine,
  ErpCostCenter, ErpBankAccount, ErpBankTransaction, ErpSetting,
  TrialBalance, BalanceSheet, ProfitAndLoss, GeneralLedger,
  FxRevaluationAdjustment, FxRevaluationResult,
  UserPreference,
} from "@/lib/supabase/types";

export interface ListParams {
  search?: string;
  limit?: number;
  offset?: number;
  filters?: Record<string, string | undefined>;
  // ADMIN-H12: server-side audit log filters. Previously the audit
  // endpoints fetched 5,000 rows and filtered in memory, which fails
  // on tenants with more than 5k audit entries (silent truncation +
  // wrong counts). These fields are honoured by SupabaseStore.listAudit
  // (and the in-memory fallbacks in MockStore / PrismaStore). Other
  // list methods ignore them — they only consume `search` + `filters`.
  action?: string;
  username?: string;
  entity_type?: string;
  date_from?: string;
  date_to?: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export interface Store {
  // auth
  getUserByUsername(username: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  listUsers(tenantId: string): Promise<User[]>;
  upsertUser(u: Partial<User> & { id?: string }): Promise<User>;
  deleteUser(id: string): Promise<void>;
  // GDPR Article 17 — anonymise PII in audit_logs (username, ip, user_agent)
  // for the given user_id BEFORE the user row is deleted. Returns the number
  // of audit_logs rows anonymised. Implemented via a SECURITY DEFINER RPC
  // (migration 030) that temporarily disables the append-only trigger from
  // migration 010. Stores without a backing audit_logs table (mock, prisma)
  // return 0 as a no-op so callers can invoke this unconditionally during
  // the user-deletion cascade.
  anonymizeUserAuditLogs(userId: string): Promise<number>;
  updateUserLastLogin(id: string, ip: string): Promise<void>;
  bumpUserTokenVersion(id: string): Promise<number>;

  // partners
  listPartners(tenantId: string, params?: ListParams): Promise<ListResult<Partner>>;
  getPartner(id: string): Promise<Partner | null>;
  upsertPartner(p: Partial<Partner> & { id?: string }): Promise<Partner>;
  deletePartner(id: string): Promise<void>;

  // products
  listProducts(tenantId: string, params?: ListParams): Promise<ListResult<Product>>;
  getProduct(id: string): Promise<Product | null>;
  upsertProduct(p: Partial<Product> & { id?: string }): Promise<Product>;
  deleteProduct(id: string): Promise<void>;

  // deals
  listDeals(tenantId: string, params?: ListParams): Promise<ListResult<Deal>>;
  getDeal(id: string): Promise<Deal | null>;
  upsertDeal(d: Partial<Deal> & { id?: string }): Promise<Deal>;
  deleteDeal(id: string): Promise<void>;

  // offers
  listOffers(tenantId: string, params?: ListParams): Promise<ListResult<Offer>>;
  getOffer(id: string): Promise<Offer | null>;
  upsertOffer(o: Partial<Offer> & { id?: string }): Promise<Offer>;
  deleteOffer(id: string): Promise<void>;

  // demands
  listDemands(tenantId: string, params?: ListParams): Promise<ListResult<Demand>>;
  getDemand(id: string): Promise<Demand | null>;
  upsertDemand(d: Partial<Demand> & { id?: string }): Promise<Demand>;
  deleteDemand(id: string): Promise<void>;

  // invoices
  listInvoices(tenantId: string, params?: ListParams): Promise<ListResult<Invoice>>;
  getInvoice(id: string): Promise<Invoice | null>;
  upsertInvoice(i: Partial<Invoice> & { id?: string }): Promise<Invoice>;
  deleteInvoice(id: string): Promise<void>;

  // proformas
  listProformas(tenantId: string, params?: ListParams): Promise<ListResult<Proforma>>;
  getProforma(id: string): Promise<Proforma | null>;
  upsertProforma(p: Partial<Proforma> & { id?: string }): Promise<Proforma>;
  deleteProforma(id: string): Promise<void>;

  // letters of intent (LOI)
  listLois(tenantId: string, params?: ListParams): Promise<ListResult<LetterOfIntent>>;
  getLoi(id: string): Promise<LetterOfIntent | null>;
  upsertLoi(l: Partial<LetterOfIntent> & { id?: string }): Promise<LetterOfIntent>;
  deleteLoi(id: string): Promise<void>;

  // shared documents
  listDocuments(tenantId: string, params?: ListParams): Promise<ListResult<SharedDocument>>;
  getDocument(id: string): Promise<SharedDocument | null>;
  upsertDocument(d: Partial<SharedDocument> & { id?: string }): Promise<SharedDocument>;
  deleteDocument(id: string): Promise<void>;

  // document register (V1/V2/V3)
  listDocumentRegister(tenantId: string, params?: ListParams): Promise<ListResult<DocumentRegisterEntry>>;
  upsertDocumentRegisterEntry(e: Partial<DocumentRegisterEntry> & { id?: string }): Promise<DocumentRegisterEntry>;
  listDocumentRevisions(tenantId: string, documentId: string): Promise<DocumentRevision[]>;
  addDocumentRevision(r: Partial<DocumentRevision> & { id?: string }): Promise<DocumentRevision>;
  deleteDocumentRegisterEntry(id: string): Promise<void>;
  /**
   * Fetch a single document_register row by id (with tenant_id scoping when
   * the caller is tenant-scoped). Replaces the list-all-then-find pattern
   * (audit 2g-F17) which O(n)-scanned the tenant's rows on every GET/PUT/DELETE.
   */
  getDocumentRegisterEntry(id: string, tenantId?: string): Promise<DocumentRegisterEntry | null>;
  /**
   * Return the highest `version` for (tenantId, referenceId, type) — used by
   * the PDF generator's nextVersion = max+1 logic (audit 2g-F1 round 4).
   * Returns 0 when no rows exist for the (tenant, reference, type) tuple.
   */
  getMaxDocumentRegisterVersion(tenantId: string, referenceId: string, type: string): Promise<number>;

  // audit
  listAudit(tenantId: string, params?: ListParams): Promise<ListResult<AuditLog>>;
  appendAudit(entry: Omit<AuditLog, "id" | "created_at">): Promise<AuditLog>;

  // settings
  getSetting<T = unknown>(key: string, tenantId?: string | null): Promise<T | null>;
  setSetting(key: string, value: unknown, tenantId?: string | null): Promise<void>;
  getAllSettings(tenantId?: string | null): Promise<Setting[]>;

  // tasks
  listTasks(tenantId: string, userId?: string): Promise<UserTask[]>;
  upsertTask(t: Partial<UserTask> & { id?: string }): Promise<UserTask>;
  deleteTask(id: string): Promise<void>;

  // notes
  listNotes(tenantId: string, entityType: string, entityId: string): Promise<EntityNote[]>;
  upsertNote(n: Partial<EntityNote> & { id?: string }): Promise<EntityNote>;
  deleteNote(id: string): Promise<void>;

  // inventory
  listInventory(tenantId: string, partnerId: string): Promise<InventoryMovement[]>;
  listAllInventory(tenantId: string, params?: ListParams): Promise<ListResult<InventoryMovement>>;
  /**
   * FIX-MARKET-UI / FIX 4 — returns products whose `stock` is at or below
   * their `reorder_level`, paginated. Used by the inventory view's
   * "Low Stock" mode (separate from movements).
   */
  listLowStockProducts(tenantId: string, params?: ListParams): Promise<ListResult<Product>>;
  addInventoryMovement(m: Partial<InventoryMovement> & { id?: string }): Promise<InventoryMovement>;

  // vault
  listVault(tenantId: string, params?: ListParams): Promise<ListResult<VaultSecret>>;
  upsertVaultSecret(s: Partial<VaultSecret> & { id?: string }): Promise<VaultSecret>;
  deleteVaultSecret(id: string): Promise<void>;

  // api keys
  listApiKeys(tenantId: string): Promise<ApiKey[]>;
  upsertApiKey(k: Partial<ApiKey> & { id?: string }): Promise<ApiKey>;
  deleteApiKey(id: string): Promise<void>;
  authenticateApiKey(rawKey: string): Promise<{ apiKey: ApiKey; tenantId: string } | null>;
  updateApiKeyLastUsed(id: string, ip: string): Promise<void>;

  // webhooks
  listWebhooks(tenantId: string): Promise<Webhook[]>;
  upsertWebhook(w: Partial<Webhook> & { id?: string }): Promise<Webhook>;
  deleteWebhook(id: string): Promise<void>;
  getWebhookById(id: string, tenantId?: string): Promise<Webhook | null>;

  // webhook deliveries (outbound delivery log + retry queue)
  createWebhookDelivery(d: {
    webhook_id: string;
    tenant_id: string;
    event: string;
    payload: WebhookPayload;
    status?: string;
    attempts?: number;
  }): Promise<WebhookDelivery>;
  updateWebhookDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void>;
  listWebhookDeliveries(tenantId: string, webhookId?: string, limit?: number): Promise<WebhookDelivery[]>;
  listFailedWebhookDeliveries(limit?: number): Promise<WebhookDelivery[]>;
  getWebhookDelivery(id: string): Promise<WebhookDelivery | null>;

  // security
  listSessions(tenantId: string, userId?: string): Promise<SecuritySession[]>;
  /**
   * Revoke a security-session row.
   *
   * `opts.bumpToken` (default true) also bumps the owner's token_version,
   * invalidating ALL of their live JWTs — the secure default for an
   * explicit admin/rotate revocation. Callers evicting sessions as part of
   * the concurrent-session LRU cap MUST pass { bumpToken: false } — evicting
   * the OLDEST session must not log the user out of EVERY device (that was
   * the root cause of the long-running "random client logouts" bug).
   */
  revokeSession(id: string, opts?: { bumpToken?: boolean }): Promise<void>;
  listLoginHistory(tenantId: string, userId?: string, limit?: number): Promise<LoginHistoryEntry[]>;
  listKnownIps(tenantId: string, userId?: string): Promise<KnownIp[]>;
  trustIp(id: string, trusted: boolean): Promise<void>;
  forgetIp(id: string): Promise<void>;
  listTrustedDevices(tenantId: string, userId?: string): Promise<TrustedDevice[]>;
  revokeTrustedDevice(id: string): Promise<void>;

  // mail queue
  listMailQueue(tenantId: string, params?: ListParams): Promise<ListResult<MailQueueEntry>>;
  upsertMailQueueEntry(m: Partial<MailQueueEntry> & { id?: string }): Promise<MailQueueEntry>;
  deleteMailQueueEntry(id: string): Promise<void>;

  // ---- tenants (multi-tenancy) ----
  listTenants(): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant | null>;
  upsertTenant(t: Partial<Tenant> & { id?: string }): Promise<Tenant>;
  deleteTenant(id: string): Promise<void>;
  // P3 / task C-8 — atomic tenant status transition. The previous
  // suspend/cancel path in `PUT /api/tenants/[id]` did a non-atomic
  // read-modify-write (fetch current tenant → check status → upsert with
  // new status). Two concurrent PUT requests could both observe the same
  // `oldStatus`, both compute `nowSuspending=true`, and both call
  // upsertTenant — leading to a race on the status field and a double
  // invocation of the session-kill cascade.
  //
  // `atomicTenantStatusTransition` performs the status change as a single
  // SQL UPDATE … WHERE id=? AND status IN (fromStatuses), which Postgres
  // serialises — only one of two concurrent calls actually flips the row,
  // the other gets `null` back and skips the cascade. The optional
  // `patch` is merged into the same UPDATE so callers can change other
  // fields (e.g. updated_at) atomically with the status flip.
  //
  // Returns the updated tenant, or `null` if the tenant was not in any of
  // `fromStatuses` (or does not exist). Stores without a backing SQL
  // backend (mock, prisma) implement an equivalent check + update inside
  // their own data layer so the atomicity guarantee holds there too.
  atomicTenantStatusTransition(
    tenantId: string,
    fromStatuses: string[],
    toStatus: string,
    patch?: Partial<Tenant>,
  ): Promise<Tenant | null>;
  // AUDIT19 / F4 — atomic DOCUMENT status transition (generic version of
  // atomicTenantStatusTransition for offers / invoices / proformas / lois).
  // Single SQL UPDATE … WHERE id=? AND status IN (fromStatuses): Postgres
  // serialises the row lock, so two concurrent accepts (admin PUT + portal
  // respond, or a double-click) cannot BOTH flip the row and double-fire
  // the commission / inventory cascades. The loser gets `null` and the
  // route turns that into a 409. Mock/prisma stores implement a check +
  // update equivalent so the guarantee holds there too.
  atomicDocStatusTransition(
    table: "offers" | "invoices" | "proformas" | "lois",
    id: string,
    fromStatuses: string[],
    toStatus: string,
    patch?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  // P0 / task C-1 — safe tenant deletion. The live DB has very few FK
  // CASCADE constraints (migration 021 comment), so a naive deleteTenant
  // orphans every dependent row. `countTenantDependencies` returns a
  // per-table row count + total for the DELETE route's confirm gate;
  // `deleteTenantCascade` walks the same tables in dependency order and
  // then deletes the tenant row last. Stores whose backend already
  // cascades (prisma) return 0 / no-op so callers can invoke them
  // unconditionally.
  countTenantDependencies(
    tenantId: string,
  ): Promise<Record<string, number> & { total: number }>;
  deleteTenantCascade(tenantId: string): Promise<void>;
  // P0 / task C-1 — safe user deletion. Same orphan problem as tenants.
  // Called by the users DELETE route AFTER `anonymizeUserAuditLogs`
  // (which strips PII from the append-only audit_logs — migration 030).
  deleteUserCascade(userId: string): Promise<void>;

  // ---- product catalog ----
  listProductCatalog(tenantId: string, params?: ListParams): Promise<ListResult<ProductCatalogEntry>>;
  getProductCatalogEntry(id: string): Promise<ProductCatalogEntry | null>;
  upsertProductCatalogEntry(p: Partial<ProductCatalogEntry> & { id?: string }): Promise<ProductCatalogEntry>;
  deleteProductCatalogEntry(id: string): Promise<void>;

  // ---- supplier offers ----
  listSupplierOffers(tenantId: string, params?: ListParams): Promise<ListResult<SupplierOffer>>;
  getSupplierOffer(id: string): Promise<SupplierOffer | null>;
  upsertSupplierOffer(s: Partial<SupplierOffer> & { id?: string }): Promise<SupplierOffer>;
  deleteSupplierOffer(id: string): Promise<void>;

  // ---- trade calculations ----
  listTradeCalculations(tenantId: string, params?: ListParams): Promise<ListResult<TradeCalculation>>;
  getTradeCalculation(id: string): Promise<TradeCalculation | null>;
  upsertTradeCalculation(t: Partial<TradeCalculation> & { id?: string }): Promise<TradeCalculation>;
  deleteTradeCalculation(id: string): Promise<void>;

  // ---- portal access ----
  getPortalAccessByPartner(partnerId: string): Promise<PortalAccess | null>;
  getPortalAccessByEmail(tenantId: string, email: string): Promise<PortalAccess | null>;
  getPortalAccessById(id: string): Promise<PortalAccess | null>;
  listPortalAccess(tenantId: string): Promise<PortalAccess[]>;
  upsertPortalAccess(p: Partial<PortalAccess> & { id?: string }): Promise<PortalAccess>;
  deletePortalAccess(id: string): Promise<void>;
  verifyPortalCredentials(tenantId: string, email: string, password: string): Promise<PortalAccess | null>;
  verifyPortalCredentialsByEmail(email: string, password: string): Promise<PortalAccess | null>;
  getPortalAccessByEmailAnyTenant(email: string): Promise<PortalAccess | null>;
  /** Find all portal access rows matching an email across all tenants (for multi-tenant discrimination). */
  listPortalAccessByEmail(email: string): Promise<PortalAccess[]>;

  // ---- document templates ----
  listDocumentTemplates(tenantId: string): Promise<DocumentTemplate[]>;
  getDocumentTemplate(id: string): Promise<DocumentTemplate | null>;
  getDefaultDocumentTemplate(tenantId: string, type: string): Promise<DocumentTemplate | null>;
  upsertDocumentTemplate(t: Partial<DocumentTemplate> & { id?: string }): Promise<DocumentTemplate>;
  deleteDocumentTemplate(id: string): Promise<void>;

  // ---- tenant letterheads (memorandum firme) ----
  listLetterheads(tenantId: string): Promise<TenantLetterhead[]>;
  getLetterhead(id: string): Promise<TenantLetterhead | null>;
  getDefaultLetterhead(tenantId: string): Promise<TenantLetterhead | null>;
  upsertLetterhead(l: Partial<TenantLetterhead> & { id?: string; tenant_id: string }): Promise<TenantLetterhead>;
  deleteLetterhead(id: string): Promise<void>;

  // ---- tenant seals (zigled) ----
  listSeals(tenantId: string): Promise<TenantSeal[]>;
  getSeal(id: string): Promise<TenantSeal | null>;
  getDefaultSeal(tenantId: string): Promise<TenantSeal | null>;
  upsertSeal(s: Partial<TenantSeal> & { id?: string; tenant_id: string }): Promise<TenantSeal>;
  deleteSeal(id: string): Promise<void>;

  // ---- security (write methods) ----
  // AUDIT18: tenant_id added — auth routes always passed it (cast `as any`);
  // PrismaStore requires it (schema NOT NULL) → local/Prisma login failed at
  // securitySession.create() before the JWT was ever minted.
  createSession(s: { user_id: string; tenant_id?: string; ip?: string | null; user_agent?: string | null; country?: string | null; expires_at: string; current?: boolean }): Promise<SecuritySession>;
  revokeSessionById(id: string): Promise<void>;
  touchSession(id: string): Promise<void>;
  recordLoginHistory(e: { user_id: string; username: string; ip?: string | null; user_agent?: string | null; country?: string | null; success: boolean; reason?: string | null }): Promise<LoginHistoryEntry>;
  upsertKnownIp(ip: { user_id: string; tenant_id?: string; ip: string; country?: string | null; trusted?: boolean }): Promise<KnownIp>;
  // AUDIT18: tenant_id added to the signature — the auth login routes have
  // always passed it (cast `as any` because the interface lacked it), and
  // PrismaStore.create() requires it (schema NOT NULL) → every local/Prisma
  // login failed to persist trusted devices.
  upsertTrustedDevice(d: { user_id: string; tenant_id?: string; device_name: string; fingerprint: string; ip?: string | null }): Promise<TrustedDevice>;
  revokeTrustedDeviceById(id: string): Promise<void>;

  // ---- document verification ----
  createDocumentVerification(v: Omit<DocumentVerification, "id" | "created_at" | "verification_count" | "last_verified_at" | "last_verified_ip" | "status"> & { status?: string }): Promise<DocumentVerification>;
  getDocumentVerificationByCode(code: string): Promise<DocumentVerification | null>;
  /**
   * Refresh the stored pdf_hash + pdf_size on an existing verification record
   * after the PDF is regenerated (audit 2h-F3 round 4). Without this, regenerated
   * PDFs fail the forensic-equality check at /api/document-verify/forensic — the
   * stored hash is the *first* render's hash, not the current PDF's.
   * Returns the updated row, or null if the row was deleted concurrently.
   */
  updateDocumentVerificationHash(id: string, pdfHash: string, pdfSize: number): Promise<DocumentVerification | null>;
  getDocumentVerificationByDoc(tenantId: string, docType: string, docId: string): Promise<DocumentVerification | null>;
  logVerification(log: Omit<VerificationLog, "id" | "verified_at">): Promise<VerificationLog>;
  listVerificationLogs(verificationId: string): Promise<VerificationLog[]>;

  // ---- KYC submissions ----
  listKycSubmissions(tenantId: string, params?: ListParams): Promise<ListResult<KycSubmission>>;
  getKycSubmission(id: string): Promise<KycSubmission | null>;
  getKycSubmissionByPartner(partnerId: string): Promise<KycSubmission | null>;
  upsertKycSubmission(s: Partial<KycSubmission> & { id?: string }): Promise<KycSubmission>;
  deleteKycSubmission(id: string): Promise<void>;
  addKycDocument(doc: Omit<KycDocument, "id" | "uploaded_at">): Promise<KycDocument>;
  removeKycDocument(id: string): Promise<void>;
  approveKycAndTransfer(submissionId: string, reviewedBy: string): Promise<{ submission: KycSubmission; partner: Partner }>;

  // ---- portal RFQs ----
  listPortalRfqs(tenantId: string, params?: ListParams): Promise<ListResult<PortalRfq>>;
  listPortalRfqsByPartner(partnerId: string): Promise<PortalRfq[]>;
  getPortalRfq(id: string): Promise<PortalRfq | null>;
  upsertPortalRfq(r: Partial<PortalRfq> & { id?: string }): Promise<PortalRfq>;
  deletePortalRfq(id: string): Promise<void>;

  // ---- feature flags ----
  getFeatureFlags(tenantId: string): Promise<TenantFeatureFlags | null>;
  upsertFeatureFlags(f: Partial<TenantFeatureFlags> & { id?: string; tenant_id: string }): Promise<TenantFeatureFlags>;

  // ---- notifications ----
  listNotifications(tenantId: string, userId?: string, unreadOnly?: boolean, limit?: number): Promise<Notification[]>;
  /**
   * 2b2-F3 — added the optional `limit` param. Previously the store
   * fetched EVERY notification for the partner then the route sliced
   * in JS — for a partner with thousands of historical notifications,
   * this returned the entire table on every poll. Pushing the limit
   * into the DB query caps the wire payload. Defaults to 200 when
   * omitted (the previous JS slice defaulted to "all").
   */
  listNotificationsByPartner(tenantId: string, partnerId: string, limit?: number): Promise<Notification[]>;
  /**
   * AUDIT2-LOGIC-UX M1 — return the TOTAL unread count for a portal
   * partner (no `limit` slice). The portal /notifications route computes
   * `unread_count` from this instead of from the sliced items, so a
   * partner with 50 unread + ?limit=20 sees "50" on the bell badge (not
   * the slice-length 20).
   */
  getUnreadCountByPartner(tenantId: string, partnerId: string): Promise<number>;
  createNotification(n: Omit<Notification, "id" | "created_at" | "read" | "read_at">): Promise<Notification>;
  /**
   * 8c-10 — dedup probe. Returns the most-recent notification matching the
   * (tenant, partner, type, entityType, entityId) tuple, OR null when no
   * such notification exists within the supplied `windowMs` lookback.
   *
   * Used by notify() (in src/lib/notif/helper.ts) to collapse high-frequency
   * notification storms — e.g. a partner sending 100 marketplace negotiation
   * messages in 60s produces ONE bell-badge entry per 5-min window instead
   * of 100 separate "New marketplace message" rows.
   *
   * The lookup is best-effort: implementations MUST NOT throw on a missing
   * index / connection error — they should return null so the caller falls
   * through to the original insert path (a notification is never silently
   * dropped because the dedup probe failed). SupabaseStore does this by
   * catching the underlying error and returning null; MockStore and
   * PrismaStore mirror the same shape.
   *
   * When `entityType` or `entityId` is null, the filter treats them as
   * "match any value" (i.e. only the non-null filters apply). This lets
   * callers dedup on (partner, type) alone when the event has no entity
   * (rare — most events do, but the signature tolerates both shapes).
   */
  findRecentNotification(
    tenantId: string,
    partnerId: string,
    type: NotificationType,
    entityType: string | null,
    entityId: string | null,
    windowMs: number,
  ): Promise<Notification | null>;
  markNotificationRead(id: string, tenantId: string): Promise<void>;
  markAllNotificationsRead(tenantId: string, userId: string): Promise<void>;
  /**
   * 2b2-F2 — bulk "mark all as read" for a portal partner. Single
   * UPDATE statement scoped by (tenant_id, partner_id, type IN
   * PORTAL_SAFE_TYPES, read = false) — replaces the previous N×PUT
   * pattern where the frontend fired N parallel PUTs and each PUT
   * internally scanned ALL partner notifications.
   *
   * Returns the count of rows actually updated (for audit + UI feedback).
   * Implementations MUST scope by both tenant_id AND partner_id AND
   * the portal-safe-type whitelist (defense-in-depth — even if a
   * partner_id is somehow reused across tenants, the tenant filter
   * blocks cross-tenant writes; the type filter blocks internal-only
   * notification types from being touched by a portal call).
   */
  markAllNotificationsReadForPartner(tenantId: string, partnerId: string): Promise<number>;
  deleteNotification(id: string): Promise<void>;
  getUnreadCount(tenantId: string, userId: string): Promise<number>;
  getNotificationById(id: string): Promise<Notification | null>;

  // user preferences
  getUserPreference(userId: string, key: string): Promise<UserPreference | null>;
  setUserPreference(userId: string, key: string, value: unknown): Promise<UserPreference>;
  deleteUserPreference(userId: string, key: string): Promise<void>;
  listUserPreferences(userId: string): Promise<UserPreference[]>;

  // dashboard
  getInsights(tenantId?: string): Promise<DashboardInsights>;

  /**
   * Aggregated analytics datasets for the dashboard charts (task D-2).
   *
   * Returns five pre-aggregated series in a single round-trip:
   *   • salesData         — monthly revenue (paid invoices) for the last 12 months
   *   • topProducts        — top N products by offer line-item revenue
   *   • offerStatus        — count + aggregate value grouped by OfferStatus
   *   • marginByCategory   — volume-weighted avg margin % by Product.category
   *   • paymentTrend       — monthly payments received (paid_at bucket)
   *
   * Implementations should keep the wire payload small — only the columns
   * needed for aggregation should be selected (mirrors the getInsights()
   * pattern of `select("id, status, total, ...")` rather than `select("*")`).
   *
   * `tenantId` is optional — when null/undefined, the call is super-admin /
   * platform-scoped and the implementation should aggregate across ALL
   * tenants (mirrors getInsights).
   *
   * `period` is an opaque string (currently only "12m" is honoured; any
   * other value falls back to 12 months). It is echoed back in the
   * response so the client can key its cache correctly.
   *
   * `topN` defaults to 5 — caps the TopProducts series.
   */
  getDashboardCharts(
    tenantId: string | null | undefined,
    period?: string,
    topN?: number,
  ): Promise<DashboardCharts>;

  // ---- commission agents ----
  listCommissionAgents(tenantId: string, params?: ListParams): Promise<ListResult<CommissionAgent>>;
  getCommissionAgent(id: string): Promise<CommissionAgent | null>;
  getCommissionAgentByPartner(partnerId: string): Promise<CommissionAgent | null>;
  upsertCommissionAgent(a: Partial<CommissionAgent> & { id?: string }): Promise<CommissionAgent>;
  deleteCommissionAgent(id: string): Promise<void>;

  // ---- deal commissions ----
  listDealCommissions(tenantId: string, params?: ListParams): Promise<ListResult<DealCommission>>;
  listDealCommissionsByDeal(dealId: string): Promise<DealCommission[]>;
  listDealCommissionsByAgent(agentId: string): Promise<DealCommission[]>;
  getDealCommission(id: string): Promise<DealCommission | null>;
  upsertDealCommission(c: Partial<DealCommission> & { id?: string }): Promise<DealCommission>;
  deleteDealCommission(id: string): Promise<void>;
  approveDealCommission(id: string, approvedBy: string): Promise<DealCommission>;
  markDealCommissionPaid(id: string, payoutReference?: string): Promise<DealCommission>;

  // ---- commission payouts ----
  listCommissionPayouts(tenantId: string, params?: ListParams): Promise<ListResult<CommissionPayout>>;
  getCommissionPayout(id: string): Promise<CommissionPayout | null>;
  upsertCommissionPayout(p: Partial<CommissionPayout> & { id?: string }): Promise<CommissionPayout>;
  deleteCommissionPayout(id: string): Promise<void>;
  /**
   * Atomic commission-payout creation: inserts the payout row AND marks the
   * linked DealCommissions as 'paid' in a single Postgres transaction (via
   * the `create_commission_payout` RPC from migration 002). Replaces the
   * previous non-atomic pattern of `upsertCommissionPayout` + a JS loop of
   * `markDealCommissionPaid` — if the loop failed mid-way, the payout row
   * existed but only some commissions were marked paid (audit B-1 P3 / C-3).
   *
   * The bulk mark-paid ONLY runs when `payout.status === 'completed'`. For
   * 'pending' / 'cancelled' payouts, only the payout row is inserted (the
   * approval gate in the route handler still runs first).
   *
   * Returns the inserted payout row. The count of commissions marked paid
   * is logged via console.info for observability.
   */
  createCommissionPayoutAtomic(
    payout: Partial<CommissionPayout> & { commission_ids: string[] },
    commissionIds: string[],
  ): Promise<CommissionPayout>;

  // ---- commission summaries ----
  getCommissionSummaries(tenantId: string): Promise<CommissionSummary[]>;
  calculateCommission(agentId: string, dealValue: number, dealProfit: number, dealQuantity: number, dealUnit: string, currency: string): Promise<number>;

  // ---- ERP / Accounting ----
  // Chart of Accounts
  listErpAccounts(tenantId: string, params?: ListParams): Promise<ListResult<ErpAccount>>;
  getErpAccount(id: string): Promise<ErpAccount | null>;
  upsertErpAccount(a: Partial<ErpAccount> & { id?: string }): Promise<ErpAccount>;
  deleteErpAccount(id: string): Promise<void>;

  // Fiscal Periods
  listFiscalPeriods(tenantId: string, params?: ListParams): Promise<ListResult<FiscalPeriod>>;
  getFiscalPeriod(id: string): Promise<FiscalPeriod | null>;
  upsertFiscalPeriod(p: Partial<FiscalPeriod> & { id?: string }): Promise<FiscalPeriod>;
  closeFiscalPeriod(id: string, closedBy: string): Promise<FiscalPeriod>;

  // Journal Entries
  listErpJournalEntries(tenantId: string, params?: ListParams): Promise<ListResult<ErpJournalEntry>>;
  getErpJournalEntry(id: string): Promise<ErpJournalEntry | null>;
  upsertErpJournalEntry(e: Omit<Partial<ErpJournalEntry>, "lines"> & { id?: string; lines?: Partial<ErpJournalLine & { id?: string }>[] }): Promise<ErpJournalEntry>;
  postErpJournalEntry(id: string, postedBy: string): Promise<ErpJournalEntry>;
  reverseErpJournalEntry(id: string, reversedBy: string): Promise<ErpJournalEntry>;
  deleteErpJournalEntry(id: string): Promise<void>;

  // E-2 (multi-currency ERP) — generate an FX revaluation entry for the
  // given as-of date. The store method routes to the
  // `create_fx_revaluation(text, date, text, jsonb, text)` RPC, which
  // creates a draft revaluation journal entry (is_revaluation = true)
  // with one balanced line-pair per adjustment. The caller computes the
  // adjustments (account_id, currency, fx_rate_old, fx_rate_new,
  // balance_foreign, gain_loss_account_id) externally — typically from
  // open AR/AP balances and the latest rates fetched via
  // /api/exchange-rates.
  createFxRevaluation(
    tenantId: string,
    revalDate: string,
    baseCurrency: string,
    adjustments: FxRevaluationAdjustment[],
    createdBy: string,
  ): Promise<FxRevaluationResult>;

  // Cost Centers
  listErpCostCenters(tenantId: string, params?: ListParams): Promise<ListResult<ErpCostCenter>>;
  upsertErpCostCenter(c: Partial<ErpCostCenter> & { id?: string }): Promise<ErpCostCenter>;
  deleteErpCostCenter(id: string): Promise<void>;

  // Bank Accounts
  listErpBankAccounts(tenantId: string): Promise<ErpBankAccount[]>;
  upsertErpBankAccount(b: Partial<ErpBankAccount> & { id?: string }): Promise<ErpBankAccount>;
  deleteErpBankAccount(id: string): Promise<void>;

  // Bank Transactions
  listErpBankTransactions(tenantId: string, bankAccountId?: string, params?: ListParams): Promise<ListResult<ErpBankTransaction>>;
  upsertErpBankTransaction(t: Partial<ErpBankTransaction> & { id?: string }): Promise<ErpBankTransaction>;
  reconcileBankTransaction(id: string, journalEntryId: string): Promise<ErpBankTransaction>;

  // ERP Settings
  getErpSettings(tenantId: string): Promise<ErpSetting | null>;
  upsertErpSettings(s: Partial<ErpSetting> & { id?: string; tenant_id: string }): Promise<ErpSetting>;

  // ERP Reports
  getTrialBalance(tenantId: string, asOfDate: string): Promise<TrialBalance>;
  getBalanceSheet(tenantId: string, asOfDate: string): Promise<BalanceSheet>;
  getProfitAndLoss(tenantId: string, periodStart: string, periodEnd: string): Promise<ProfitAndLoss>;
  getGeneralLedger(tenantId: string, accountId: string, dateFrom?: string, dateTo?: string): Promise<GeneralLedger>;

  // Auto-create journal entries from business events
  autoJournalFromInvoice(invoiceId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null>;
  autoJournalFromDeal(dealId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null>;
  autoJournalFromCommission(commissionId: string, tenantId: string, userId: string): Promise<ErpJournalEntry | null>;

  // ---- Atomic document creation with auto-generated sequence number ----
  // P1 (VAT compliance) / task C-4 Fix 1: generates the document number
  // INSIDE the same DB operation as the record creation, so the sequence
  // value is allocated only when the INSERT is actually attempted. This
  // minimises VAT-sequence gaps that occur when the legacy two-step
  // pattern (nextDocNumber() → upsertX()) fails between the nextval() and
  // the INSERT. Returns the inserted row. The SupabaseStore implementation
  // delegates to the `create_doc_with_number` RPC (migration 032); the
  // mock/prisma backends fall back to the legacy two-step pattern (they
  // have no SEQUENCE object).
  createDocWithNumber(
    docType: "offer" | "invoice" | "proforma" | "demand" | "rfq",
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

let _impl: Store | null = null;

export async function getStore(): Promise<Store> {
  if (_impl) return _impl;

  // Production always uses SupabaseStore. PrismaStore and MockStore are legacy
  // and kept only for backward compatibility — they can be re-enabled by
  // setting DB_BACKEND=prisma or DB_BACKEND=mock (not recommended for production).
  const backend = process.env.DB_BACKEND;

  if (backend === "prisma") {
    console.warn("[store] DB_BACKEND=prisma is DEPRECATED. PrismaStore has known tenant isolation bugs. Use DB_BACKEND=supabase.");
    const { PrismaStore } = await import("./prisma-store");
    _impl = new PrismaStore() as unknown as Store;
  } else if (backend === "mock") {
    console.warn("[store] DB_BACKEND=mock has no seed data. Use only for testing.");
    const { MockStore } = await import("./mock-store");
    _impl = new MockStore() as unknown as Store;
  } else {
    const { SupabaseStore } = await import("./supabase-store");
    _impl = new SupabaseStore() as unknown as Store;
  }
  return _impl;
}

export function getStoreSync(): Store | null {
  return _impl;
}
