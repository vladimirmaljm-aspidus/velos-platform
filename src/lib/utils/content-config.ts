/**
 * Content config utilities for document templates.
 * 
 * These functions are shared between the client-side content editor
 * (src/components/common/template-content-editor.tsx) and the server-side
 * PDF generator (src/lib/pdf/templates.tsx).
 * 
 * They MUST NOT have "use client" — they're imported by server code.
 */

export interface ContentSegment {
  id: string;
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  alignment: "left" | "center" | "right";
}

export interface ContentConfig {
  segments: ContentSegment[];
}

export interface PlaceholderData {
  company_name?: string | null;
  company_legal_name?: string | null;
  company_address?: string | null;
  company_city?: string | null;
  company_country?: string | null;
  company_postal_code?: string | null;
  company_reg?: string | null;
  company_vat?: string | null;
  company_tax_id?: string | null;
  company_phone?: string | null;
  company_email?: string | null;
  company_website?: string | null;
  bank_name?: string | null;
  bank_iban?: string | null;
  bank_swift?: string | null;
  doc_number?: string | null;
  doc_date?: string | null;
  valid_until?: string | null;
  due_date?: string | null;
  partner_name?: string | null;
  partner_address?: string | null;
  partner_city?: string | null;
  partner_country?: string | null;
  total?: string | null;
  currency?: string | null;
  page_number?: number;
  total_pages?: number;
}

/**
 * Parse a content config JSON string into a ContentConfig object.
 * Handles:
 * - null/empty → empty config
 * - JSON with segments array → parsed config
 * - Plain text string → wrapped as a single segment (backwards compat)
 */
export function parseContentConfig(content: string | null | undefined): ContentConfig {
  if (!content) return { segments: [] };
  
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.segments)) {
      return parsed as ContentConfig;
    }
  } catch {
    // Not valid JSON — treat as plain text
  }
  
  // Legacy plain text — wrap as a single segment
  return {
    segments: [{
      id: "legacy-1",
      text: content,
      fontSize: 9,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left" as const,
    }],
  };
}

/**
 * Substitute placeholders in a text string with actual data.
 * Placeholders are in the format {placeholder_name}.
 * 
 * {page_number} and {total_pages} are left unchanged if not provided
 * (they're filled at PDF render time by react-pdf's <Text render> callback).
 */
export function substitutePlaceholders(text: string, data: PlaceholderData): string {
  let result = text;
  
  const replacements: Record<string, string> = {
    "{company_name}": data.company_name || "",
    "{company_legal_name}": data.company_legal_name || data.company_name || "",
    "{company_address}": data.company_address || "",
    "{company_city}": data.company_city || "",
    "{company_country}": data.company_country || "",
    "{company_postal_code}": data.company_postal_code || "",
    "{company_reg}": data.company_reg || "",
    "{company_registration_number}": data.company_reg || "",
    "{company_vat}": data.company_vat || "",
    "{company_vat_number}": data.company_vat || "",
    "{company_tax_id}": data.company_tax_id || "",
    "{company_phone}": data.company_phone || "",
    "{company_email}": data.company_email || "",
    "{company_website}": data.company_website || "",
    "{bank_name}": data.bank_name || "",
    "{bank_iban}": data.bank_iban || "",
    "{bank_swift}": data.bank_swift || "",
    "{doc_number}": data.doc_number || "",
    "{doc_date}": data.doc_date || "",
    "{valid_until}": data.valid_until || "",
    "{due_date}": data.due_date || "",
    "{partner_name}": data.partner_name || "",
    "{partner_address}": data.partner_address || "",
    "{partner_city}": data.partner_city || "",
    "{partner_country}": data.partner_country || "",
    "{total}": data.total || "",
    "{currency}": data.currency || "",
  };
  
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  
  // {page_number} and {total_pages} are left for react-pdf's render callback
  // Only replace if we have actual values (for live preview)
  if (data.page_number != null) {
    result = result.split("{page_number}").join(String(data.page_number));
  }
  if (data.total_pages != null) {
    result = result.split("{total_pages}").join(String(data.total_pages));
  }
  
  return result;
}

/**
 * Check if a text contains page-number placeholders that need
 * react-pdf's render callback (not static substitution).
 */
export function hasPagePlaceholders(text: string): boolean {
  return text.includes("{page_number}") || text.includes("{total_pages}");
}

// Default content JSON for new templates
export const DEFAULT_HEADER_CONTENT_JSON = JSON.stringify({
  segments: [
    {
      id: "h1",
      text: "{company_name}",
      fontSize: 14,
      bold: true,
      italic: false,
      color: "#0d9488",
      alignment: "left",
    },
    {
      id: "h2",
      text: "{company_address}, {company_city}, {company_country}",
      fontSize: 8,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left",
    },
    {
      id: "h3",
      text: "Reg#: {company_reg} · VAT: {company_vat}",
      fontSize: 7.5,
      bold: false,
      italic: false,
      color: "#888888",
      alignment: "left",
    },
  ],
});

export const DEFAULT_FOOTER_CONTENT_JSON = JSON.stringify({
  segments: [
    {
      id: "f1",
      text: "{company_name} · Reg#: {company_reg} · Page {page_number} of {total_pages}",
      fontSize: 7.5,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left",
    },
  ],
});
