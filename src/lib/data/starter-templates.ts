import type { DocumentTemplate } from "@/lib/supabase/types";

/**
 * Professional starter templates for each document type.
 * Auto-created when a tenant has no templates yet — gives new tenants a
 * professional starting point they can customize or replace.
 *
 * Color palette (deliberate, distinct per document type):
 *  • Offer    — teal   (#0d9488) — trade / commerce
 *  • Invoice  — blue   (#1e40af) — financial / official
 *  • Proforma — purple (#7c3aed) — provisional / customs
 *
 * All templates use Helvetica — a PDF-safe core font that does not require
 * any font embedding and renders identically across PDF readers.
 */

export type StarterTemplateType = "offer" | "invoice" | "proforma" | "generic";

export interface StarterTemplate {
  name: string;
  type: StarterTemplateType;
  description: string;
  template: Partial<DocumentTemplate>;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    name: "Professional Offer Template",
    type: "offer",
    description: "Clean corporate offer with full trade terms, specifications, and bank details",
    template: {
      name: "Professional Offer",
      type: "offer",
      is_default: true,
      // Page layout — A4, generous margins for letterhead/seal breathing room
      page_size: "A4",
      page_margin_top: 20,
      page_margin_bottom: 20,
      page_margin_left: 15,
      page_margin_right: 15,
      // Header
      header_enabled: true,
      header_height: 30,
      header_content: "",
      header_show_logo: true,
      header_show_company_name: true,
      header_show_contact: true,
      // Footer — offers keep bank details inside the body, not the footer
      footer_enabled: true,
      footer_height: 20,
      footer_content: "",
      footer_show_page_number: true,
      footer_show_bank_details: false,
      footer_show_tax_id: true,
      // Body typography — Helvetica is PDF-safe (no font embedding needed)
      body_font_family: "Helvetica",
      body_font_size: 9,
      body_line_height: 1.4,
      // Branding colors — teal for trade
      primary_color: "#0d9488",
      accent_color: "#64748b",
      // Table styling
      table_header_bg: "#0d9488",
      table_header_color: "#ffffff",
      table_border_color: "#e2e8f0",
      table_stripe: true,
      // Linked branding assets — tenant wires these up later
      letterhead_id: null,
      seal_id: null,
      seal_enabled: true,
      selected_bank_accounts: null,
    },
  },
  {
    name: "Commercial Invoice Template",
    type: "invoice",
    description: "Standard commercial invoice for international trade",
    template: {
      name: "Commercial Invoice",
      type: "invoice",
      is_default: true,
      // Page layout
      page_size: "A4",
      page_margin_top: 20,
      page_margin_bottom: 20,
      page_margin_left: 15,
      page_margin_right: 15,
      // Header
      header_enabled: true,
      header_height: 30,
      header_content: "",
      header_show_logo: true,
      header_show_company_name: true,
      header_show_contact: true,
      // Footer — invoices show bank details in footer (payment reference)
      footer_enabled: true,
      footer_height: 20,
      footer_content: "",
      footer_show_page_number: true,
      footer_show_bank_details: true,
      footer_show_tax_id: true,
      // Body typography
      body_font_family: "Helvetica",
      body_font_size: 9,
      body_line_height: 1.4,
      // Branding colors — blue for financial documents
      primary_color: "#1e40af",
      accent_color: "#64748b",
      // Table styling
      table_header_bg: "#1e40af",
      table_header_color: "#ffffff",
      table_border_color: "#e2e8f0",
      table_stripe: true,
      // Linked branding assets
      letterhead_id: null,
      seal_id: null,
      seal_enabled: true,
      selected_bank_accounts: null,
    },
  },
  {
    name: "Proforma Invoice Template",
    type: "proforma",
    description: "Proforma invoice for customs and bank purposes",
    template: {
      name: "Proforma Invoice",
      type: "proforma",
      is_default: true,
      // Page layout
      page_size: "A4",
      page_margin_top: 20,
      page_margin_bottom: 20,
      page_margin_left: 15,
      page_margin_right: 15,
      // Header
      header_enabled: true,
      header_height: 30,
      header_content: "",
      header_show_logo: true,
      header_show_company_name: true,
      header_show_contact: true,
      // Footer — proforma disclaimer for customs/bank clarity
      footer_enabled: true,
      footer_height: 20,
      footer_content:
        "This proforma invoice is issued for customs/bank purposes only and is not a tax invoice.",
      footer_show_page_number: true,
      footer_show_bank_details: true,
      footer_show_tax_id: true,
      // Body typography
      body_font_family: "Helvetica",
      body_font_size: 9,
      body_line_height: 1.4,
      // Branding colors — purple to distinguish provisional documents
      primary_color: "#7c3aed",
      accent_color: "#64748b",
      // Table styling
      table_header_bg: "#7c3aed",
      table_header_color: "#ffffff",
      table_border_color: "#e2e8f0",
      table_stripe: true,
      // Linked branding assets
      letterhead_id: null,
      seal_id: null,
      seal_enabled: true,
      selected_bank_accounts: null,
    },
  },
];

/**
 * Auto-create starter templates for a tenant if they have none.
 * Called when the tenant first opens the Document Templates view.
 *
 * Idempotent: if the tenant already has ≥1 template, do nothing.
 */
export async function ensureStarterTemplates(
  tenantId: string,
  store: {
    listDocumentTemplates: (tid: string) => Promise<DocumentTemplate[]>;
    upsertDocumentTemplate: (
      t: Partial<DocumentTemplate> & { id?: string }
    ) => Promise<DocumentTemplate>;
  }
): Promise<void> {
  const existing = await store.listDocumentTemplates(tenantId);
  if (existing.length > 0) return; // already has templates — leave alone

  for (const starter of STARTER_TEMPLATES) {
    await store.upsertDocumentTemplate({
      ...starter.template,
      tenant_id: tenantId,
    });
  }
}
