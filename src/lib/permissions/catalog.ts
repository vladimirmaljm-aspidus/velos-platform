/**
 * Canonical permission catalog for the VELOS platform.
 *
 * Format: `resource.action` (dot-separated), e.g. `partners.read`, `erp.post`.
 *
 * Permissions are grouped by module. Any permission NOT listed here is
 * considered unknown and will be rejected by `can()` unless the user is a
 * super_admin (which bypasses all checks).
 *
 * IMPORTANT distinction:
 *   - Tenant-scoped permissions:  every `role === "admin"` implicitly gets them
 *     within their own tenant (see `can.ts`). `user` role gets them only when
 *     explicitly granted in `users.permissions`.
 *   - Platform-scoped permissions (prefix `platform.`): ONLY super_admin.
 *     Tenant admins can never get them, no matter what is in their
 *     `permissions` array.
 *
 * This file is the source-of-truth: every `requirePermission()` call in an
 * API route should reference a symbol defined here.
 */

// ─── CRM / Core ─────────────────────────────────────────────────────────────
export const PARTNERS = {
  READ: "partners.read",
  CREATE: "partners.create",
  UPDATE: "partners.update",
  DELETE: "partners.delete",
  EXPORT: "partners.export",
} as const;

export const PRODUCTS = {
  READ: "products.read",
  CREATE: "products.create",
  UPDATE: "products.update",
  DELETE: "products.delete",
  EXPORT: "products.export",
} as const;

export const DEALS = {
  READ: "deals.read",
  CREATE: "deals.create",
  UPDATE: "deals.update",
  DELETE: "deals.delete",
} as const;

export const OFFERS = {
  READ: "offers.read",
  CREATE: "offers.create",
  UPDATE: "offers.update",
  DELETE: "offers.delete",
  SEND: "offers.send",
  EXPORT: "offers.export",
} as const;

export const DEMANDS = {
  READ: "demands.read",
  CREATE: "demands.create",
  UPDATE: "demands.update",
  DELETE: "demands.delete",
} as const;

export const INVOICES = {
  READ: "invoices.read",
  CREATE: "invoices.create",
  UPDATE: "invoices.update",
  DELETE: "invoices.delete",
  SEND: "invoices.send",
  EXPORT: "invoices.export",
} as const;

export const PROFORMAS = {
  READ: "proformas.read",
  CREATE: "proformas.create",
  UPDATE: "proformas.update",
  DELETE: "proformas.delete",
  SEND: "proformas.send",
} as const;

export const DOCUMENTS = {
  READ: "documents.read",
  CREATE: "documents.create",
  UPDATE: "documents.update",
  DELETE: "documents.delete",
} as const;

export const DOCUMENT_REGISTER = {
  READ: "document-register.read",
  CREATE: "document-register.create",
  UPDATE: "document-register.update",
  DELETE: "document-register.delete",
} as const;

export const DOCUMENT_TEMPLATES = {
  READ: "document-templates.read",
  CREATE: "document-templates.create",
  UPDATE: "document-templates.update",
  DELETE: "document-templates.delete",
} as const;

export const DOCUMENT_VERIFY = {
  READ: "document-verify.read",
} as const;

export const TASKS = {
  READ: "tasks.read",
  CREATE: "tasks.create",
  UPDATE: "tasks.update",
  DELETE: "tasks.delete",
} as const;

export const NOTES = {
  READ: "notes.read",
  CREATE: "notes.create",
  UPDATE: "notes.update",
  DELETE: "notes.delete",
} as const;

export const CALENDAR = {
  READ: "calendar.read",
  CREATE: "calendar.create",
  UPDATE: "calendar.update",
  DELETE: "calendar.delete",
} as const;

// ─── Inventory / Trade ──────────────────────────────────────────────────────
export const INVENTORY = {
  READ: "inventory.read",
  CREATE: "inventory.create",
  UPDATE: "inventory.update",
  DELETE: "inventory.delete",
} as const;

export const PRODUCT_CATALOG = {
  READ: "product-catalog.read",
  CREATE: "product-catalog.create",
  UPDATE: "product-catalog.update",
  DELETE: "product-catalog.delete",
} as const;

export const SUPPLIER_OFFERS = {
  READ: "supplier-offers.read",
  CREATE: "supplier-offers.create",
  UPDATE: "supplier-offers.update",
  DELETE: "supplier-offers.delete",
} as const;

export const TRADE_CALCULATOR = {
  READ: "trade-calculator.read",
  CREATE: "trade-calculator.create",
  UPDATE: "trade-calculator.update",
  DELETE: "trade-calculator.delete",
} as const;

// ─── ERP / Accounting ───────────────────────────────────────────────────────
export const ERP = {
  READ: "erp.read",
  CREATE: "erp.create",
  UPDATE: "erp.update",
  DELETE: "erp.delete",
  POST: "erp.post",
  REVERSE: "erp.reverse",
  RECONCILE: "erp.reconcile",
  CLOSE_PERIOD: "erp.close_period",
  MANAGE_SETTINGS: "erp.manage_settings",
} as const;

// ─── Commissions ────────────────────────────────────────────────────────────
export const COMMISSIONS = {
  READ: "commissions.read",
  CREATE: "commissions.create",
  UPDATE: "commissions.update",
  DELETE: "commissions.delete",
  CALCULATE: "commissions.calculate",
  PAYOUT: "commissions.payout",
} as const;

// ─── Portal (admin-side management of client portal) ────────────────────────
export const PORTAL = {
  READ: "portal.read",
  INVITE: "portal.invite",
  MANAGE: "portal.manage",
  MESSAGE: "portal.message",
  RFQ_READ: "portal.rfq_read",
  RFQ_UPDATE: "portal.rfq_update",
  // Fine-grained admin actions on a portal_access row
  CHANGE_EMAIL: "portal.change_email",
  CHANGE_TIER: "portal.change_tier",
  RESET_PASSWORD: "portal.reset_password",
  SUSPEND: "portal.suspend",
  REVOKE: "portal.revoke",
} as const;

// ─── Portal Uploads (admin view of client-uploaded documents) ───────────────
export const PORTAL_UPLOADS = {
  READ: "portal-uploads.read",
  DOWNLOAD: "portal-uploads.download",
  DELETE: "portal-uploads.delete",
} as const;

// ─── Logistics (freight quote requests submitted through the portal) ────────
export const LOGISTICS = {
  READ: "logistics.read",
  CREATE: "logistics.create",     // admin can manually create/edit rows
  UPDATE: "logistics.update",     // status / notes / dates
  DELETE: "logistics.delete",
  QUOTE: "logistics.quote",       // enter/change price + transit + notes
  CONVERT: "logistics.convert",   // convert to Offer
} as const;

// ─── KYC ────────────────────────────────────────────────────────────────────
export const KYC = {
  READ: "kyc.read",
  APPROVE: "kyc.approve",
  REJECT: "kyc.reject",
  RESUBMIT: "kyc.resubmit",
  UPDATE: "kyc.update",
} as const;

// ─── Administration ─────────────────────────────────────────────────────────
export const USERS = {
  READ: "users.read",
  CREATE: "users.create",
  UPDATE: "users.update",
  DELETE: "users.delete",
} as const;

export const SETTINGS = {
  READ: "settings.read",
  UPDATE: "settings.update",
  TEST: "settings.test",
} as const;

export const AUDIT = {
  READ: "audit.read",
} as const;

// ─── Per-tenant role overrides (P1-1 / Feature 1) ───────────────────────────
// Super-admins can edit any tenant's overrides; tenant admins can edit
// their OWN tenant's overrides via the admin API. Both require these
// permissions (admin role gets them implicitly via the implicit-grant
// path in `can()` — only `super_admin` and tenant `admin` reach the
// override admin route at all).
export const TENANT_ROLES = {
  READ: "tenant-roles.read",
  UPDATE: "tenant-roles.update",
  DELETE: "tenant-roles.delete",
} as const;

export const SECURITY = {
  READ: "security.read",
  UPDATE: "security.update",
  DELETE: "security.delete",
} as const;

export const VAULT = {
  READ: "vault.read",
  CREATE: "vault.create",
  UPDATE: "vault.update",
  DELETE: "vault.delete",
} as const;

export const API_KEYS = {
  READ: "api-keys.read",
  CREATE: "api-keys.create",
  UPDATE: "api-keys.update",
  DELETE: "api-keys.delete",
} as const;

export const WEBHOOKS = {
  READ: "webhooks.read",
  CREATE: "webhooks.create",
  UPDATE: "webhooks.update",
  DELETE: "webhooks.delete",
} as const;

export const MAIL_QUEUE = {
  READ: "mail-queue.read",
  UPDATE: "mail-queue.update",
  DELETE: "mail-queue.delete",
} as const;

export const EMAIL_TEMPLATES = {
  READ: "email-templates.read",
  CREATE: "email-templates.create",
  UPDATE: "email-templates.update",
  DELETE: "email-templates.delete",
} as const;

export const LETTERHEADS = {
  READ: "letterheads.read",
  CREATE: "letterheads.create",
  UPDATE: "letterheads.update",
  DELETE: "letterheads.delete",
} as const;

export const MEMORANDUM_SETTINGS = {
  READ: "memorandum_settings.read",
  UPDATE: "memorandum_settings.update",
} as const;

export const SEALS = {
  READ: "seals.read",
  CREATE: "seals.create",
  UPDATE: "seals.update",
  DELETE: "seals.delete",
} as const;

export const NOTIFICATIONS = {
  READ: "notifications.read",
  UPDATE: "notifications.update",
  DELETE: "notifications.delete",
} as const;

export const INTEGRATIONS = {
  READ: "integrations.read",
} as const;

export const DASHBOARD = {
  READ: "dashboard.read",
} as const;

export const SEARCH = {
  READ: "search.read",
} as const;

// ─── Platform-only (super_admin exclusive) ──────────────────────────────────
export const PLATFORM = {
  TENANTS_READ: "platform.tenants.read",
  TENANTS_WRITE: "platform.tenants.write",
  TENANTS_DELETE: "platform.tenants.delete",
  PLANS_READ: "platform.plans.read",
  PLANS_WRITE: "platform.plans.write",
  FEATURE_FLAGS_READ: "platform.feature_flags.read",
  FEATURE_FLAGS_WRITE: "platform.feature_flags.write",
  IMPERSONATE: "platform.impersonate",
  OVERVIEW: "platform.overview",
  MANAGE_USERS: "platform.users.manage",
} as const;

// ─── Portal client (portal-scoped, granted to portal_client role only) ──────
export const PORTAL_CLIENT = {
  READ_OWN_DOCS: "portal.read_own_docs",
  UPLOAD_KYC: "portal.upload_kyc",
  RFQ_CREATE: "portal.rfq_create",
  MESSAGE: "portal.message_send",
  PROFILE_UPDATE: "portal.profile_update",
} as const;

// ─── Aggregate every permission constant into a flat list ───────────────────
export const ALL_PERMISSIONS = [
  ...Object.values(PARTNERS),
  ...Object.values(PRODUCTS),
  ...Object.values(DEALS),
  ...Object.values(OFFERS),
  ...Object.values(DEMANDS),
  ...Object.values(INVOICES),
  ...Object.values(PROFORMAS),
  ...Object.values(DOCUMENTS),
  ...Object.values(DOCUMENT_REGISTER),
  ...Object.values(DOCUMENT_TEMPLATES),
  ...Object.values(DOCUMENT_VERIFY),
  ...Object.values(TASKS),
  ...Object.values(NOTES),
  ...Object.values(CALENDAR),
  ...Object.values(INVENTORY),
  ...Object.values(PRODUCT_CATALOG),
  ...Object.values(SUPPLIER_OFFERS),
  ...Object.values(TRADE_CALCULATOR),
  ...Object.values(ERP),
  ...Object.values(COMMISSIONS),
  ...Object.values(PORTAL),
  ...Object.values(PORTAL_UPLOADS),
  ...Object.values(LOGISTICS),
  ...Object.values(KYC),
  ...Object.values(USERS),
  ...Object.values(SETTINGS),
  ...Object.values(AUDIT),
  ...Object.values(TENANT_ROLES),
  ...Object.values(SECURITY),
  ...Object.values(VAULT),
  ...Object.values(API_KEYS),
  ...Object.values(WEBHOOKS),
  ...Object.values(MAIL_QUEUE),
  ...Object.values(EMAIL_TEMPLATES),
  ...Object.values(LETTERHEADS),
  ...Object.values(MEMORANDUM_SETTINGS),
  ...Object.values(SEALS),
  ...Object.values(NOTIFICATIONS),
  ...Object.values(INTEGRATIONS),
  ...Object.values(DASHBOARD),
  ...Object.values(SEARCH),
  ...Object.values(PLATFORM),
  ...Object.values(PORTAL_CLIENT),
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Non-platform, non-portal-client permissions (i.e. tenant-scoped). */
export const TENANT_PERMISSIONS: readonly string[] = ALL_PERMISSIONS.filter(
  (p) => !p.startsWith("platform.") && !isPortalClientPerm(p)
);

/** All platform.* permissions (super_admin only). */
export const PLATFORM_PERMISSIONS: readonly string[] = Object.values(PLATFORM);

/** Permissions granted to portal_client role. */
export const PORTAL_CLIENT_PERMISSIONS: readonly string[] = Object.values(PORTAL_CLIENT);

export function isPlatformPerm(p: string): boolean {
  return p.startsWith("platform.");
}

export function isPortalClientPerm(p: string): boolean {
  // portal.read_own_docs / upload_kyc / rfq_create / message_send / profile_update
  return (Object.values(PORTAL_CLIENT) as string[]).includes(p);
}
