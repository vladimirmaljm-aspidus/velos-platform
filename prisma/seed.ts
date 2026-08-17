// Seed script for local Prisma/SQLite development.
// Creates: 2 tenants, 1 super_admin, 1 tenant admin, 1 tenant user, sample data.
// Run: bun run prisma/seed.ts
//
// WARNING: Set ADMIN_PASSWORD, SEED_ADMIN_PASSWORD, and SEED_USER_PASSWORD env
// variables before seeding in any non-local environment. If they are not set,
// non-admin accounts get a random UUID password (printed once to stdout) so the
// seeded accounts cannot be logged into with a publicly-known password.

import { db } from "../src/lib/db";
import bcrypt from "bcryptjs";
import crypto from "crypto";

async function main() {
  console.log("→ Seeding database…");

  // ── 1. Tenants ────────────────────────────────────────────────────────
  const t1Existing = await db.tenant.findFirst({ where: { name: "VELOS Trade DOO" } });
  const tenant1 = t1Existing ?? await db.tenant.create({
    data: {
      name: "VELOS Trade DOO",
      legal_name: "VELOS Trade DOO Beograd",
      country: "RS",
      currency: "EUR",
      tax_id: "108504931",
      vat_number: "RS108504931",
      registration_number: "213123456",
      address_line: "Bulevar oslobođenja 12",
      city: "Beograd",
      postal_code: "11070",
      bank_name: "Banca Intesa",
      bank_iban: "RS35160005330001234567",
      bank_swift: "DBDBRSBG",
      primary_color: "#0f766e",
      plan: "enterprise",
      status: "active",
      max_users: 50,
    },
  });

  const t2Existing = await db.tenant.findFirst({ where: { name: "Demo Logistics GmbH" } });
  const tenant2 = t2Existing ?? await db.tenant.create({
    data: {
      name: "Demo Logistics GmbH",
      legal_name: "Demo Logistics GmbH Vienna",
      country: "AT",
      currency: "EUR",
      tax_id: "ATU12345678",
      vat_number: "ATU12345678",
      address_line: "Stephansplatz 1",
      city: "Vienna",
      postal_code: "1010",
      bank_name: "Erste Bank",
      bank_iban: "AT123456789012345678",
      bank_swift: "GIBAATWW",
      primary_color: "#1e40af",
      plan: "business",
      status: "active",
      max_users: 10,
    },
  });
  console.log("  ✓ Tenants:", tenant1.id, "|", tenant2.id);

  // ── 2. Users ──────────────────────────────────────────────────────────
  // WARNING: Change these passwords immediately after seeding in production!
  // Or set the env variables below before running seed.
  const superAdminPassword = process.env.ADMIN_PASSWORD || "ChangeMe!";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || crypto.randomUUID();
  const userPassword = process.env.SEED_USER_PASSWORD || crypto.randomUUID();

  const superAdminHash = await bcrypt.hash(superAdminPassword, 10);
  const adminHash = await bcrypt.hash(adminPassword, 10);
  const userHash = await bcrypt.hash(userPassword, 10);

  const superAdmin = (await db.user.findFirst({ where: { email: "vladimir@example.com" } })) ??
    await db.user.create({
      data: {
        tenant_id: tenant1.id,
        username: "vladimir",
        email: "vladimir@example.com",
        full_name: "Vladimir (Super Admin)",
        role: "super_admin",
        password_hash: superAdminHash,
        active: true,
        permissions: JSON.stringify(["*"]),
        token_version: 1,
      },
    });

  const tenantAdmin = (await db.user.findFirst({ where: { email: "admin@velos.trade" } })) ??
    await db.user.create({
      data: {
        tenant_id: tenant1.id,
        username: "admin",
        email: "admin@velos.trade",
        full_name: "Tenant Admin",
        role: "admin",
        password_hash: adminHash,
        active: true,
        permissions: JSON.stringify(["*"]),
        token_version: 1,
      },
    });

  const tenantUser = (await db.user.findFirst({ where: { email: "user@velos.trade" } })) ??
    await db.user.create({
      data: {
        tenant_id: tenant1.id,
        username: "user",
        email: "user@velos.trade",
        full_name: "Regular User",
        role: "user",
        password_hash: userHash,
        active: true,
        permissions: JSON.stringify(["partners:read", "offers:read", "products:read"]),
        token_version: 1,
      },
    });
  console.log("  ✓ Users:", superAdmin.id, "|", tenantAdmin.id, "|", tenantUser.id);

  // ── 3. Feature flags (enable all modules for tenant1) ─────────────────
  await db.tenantFeatureFlags.upsert({
    where: { tenant_id: tenant1.id },
    update: {},
    create: {
      tenant_id: tenant1.id,
      module_crm: true,
      module_trade: true,
      module_finance: true,
      module_inventory: true,
      module_portal: true,
      module_kyc: true,
      module_document_templates: true,
      module_document_verification: true,
      module_vault: true,
      module_api_keys: true,
      module_webhooks: true,
      module_mail_queue: true,
      module_security: true,
      max_users: 50,
      max_partners: 0,
      max_monthly_documents: 0,
      beta_ai_assistant: true,
      beta_advanced_analytics: true,
      updated_by: superAdmin.id,
    },
  });

  await db.tenantFeatureFlags.upsert({
    where: { tenant_id: tenant2.id },
    update: {},
    create: {
      tenant_id: tenant2.id,
      module_crm: true,
      module_finance: true,
      module_document_templates: true,
      module_security: true,
      max_users: 10,
      updated_by: superAdmin.id,
    },
  });

  // ── 4. ERP settings for tenant1 ───────────────────────────────────────
  await db.erpSetting.upsert({
    where: { tenant_id: tenant1.id },
    update: {},
    create: {
      tenant_id: tenant1.id,
      accounting_standard: "eu",
      default_currency: "EUR",
      vat_enabled: true,
      vat_rate: 20.0,
      auto_post_journal: false,
    },
  });

  // ── 5. Sample document template (offer) for tenant1 ───────────────────
  const existingTpl = await db.documentTemplate.findFirst({
    where: { tenant_id: tenant1.id, name: "Default Offer Template" },
  });
  if (!existingTpl) {
    await db.documentTemplate.create({
      data: {
        tenant_id: tenant1.id,
        name: "Default Offer Template",
        type: "offer",
        is_default: true,
        page_size: "A4",
        page_margin_top: 20,
        page_margin_bottom: 20,
        page_margin_left: 18,
        page_margin_right: 18,
        header_enabled: true,
        header_height: 24,
        header_content: "{{company_name}}\n{{company_address}} · {{company_email}} · {{company_phone}}",
        header_show_logo: true,
        header_show_company_name: true,
        header_show_contact: true,
        footer_enabled: true,
        footer_height: 18,
        footer_content: "{{company_bank}} — IBAN: {{company_iban}} — SWIFT: {{company_swift}}",
        footer_show_page_number: true,
        footer_show_bank_details: true,
        footer_show_tax_id: true,
        body_font_family: "Inter, system-ui, sans-serif",
        body_font_size: 11,
        body_line_height: 1.5,
        primary_color: "#0f766e",
        accent_color: "#0d9488",
        table_header_bg: "#0f766e",
        table_header_color: "#ffffff",
        table_border_color: "#e2e8f0",
        table_stripe: true,
        created_by: superAdmin.id,
      },
    });
    console.log("  ✓ Sample offer template created");
  }

  console.log("\n✅ Seed complete.\n");
  console.log("Login credentials:");
  if (process.env.ADMIN_PASSWORD) {
    console.log("  Super admin : vladimir / (from $ADMIN_PASSWORD)");
  } else {
    console.log("  Super admin : vladimir / ChangeMe!  ⚠️  Set $ADMIN_PASSWORD and reseed for production.");
  }
  if (process.env.SEED_ADMIN_PASSWORD) {
    console.log("  Tenant admin: admin    / (from $SEED_ADMIN_PASSWORD)");
  } else {
    console.log("  Tenant admin: admin    / " + adminPassword);
  }
  if (process.env.SEED_USER_PASSWORD) {
    console.log("  Tenant user : user     / (from $SEED_USER_PASSWORD)");
  } else {
    console.log("  Tenant user : user     / " + userPassword);
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
