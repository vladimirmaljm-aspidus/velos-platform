import type { Offer, OfferLineItem, Partner, Tenant } from "@/lib/supabase/types";

/**
 * Data completeness checker for the velosReady offer creation form.
 *
 * The user asked (in Serbian): "moramo imati jedan automaatizovani sistem koji
 * ce u toku kreiranja ponude da jasno pokaze koje podatke nemamo originalno
 * povucene iz podataka o ponudi koju smo dobili od snabdevaca kako bi tacno
 * znali sta treba mi da uredimo ili da u buduce dopunimo za proizvode".
 *
 * Translation: "We need an automated system that during offer creation clearly
 * shows which data we don't have originally pulled from the supplier offer
 * data, so we know exactly what we need to fix or supplement for products in
 * the future."
 *
 * This module exposes a single pure function `checkOfferCompleteness` that,
 * given the current offer form state, line items, the selected partner, the
 * tenant (company) record and an optional map of supplier-offer context per
 * item, returns a structured report listing every missing field along with
 * a severity, a human-readable message and a suggestion. The UI component
 * `src/components/common/completeness-checker.tsx` renders the report in real
 * time as the user fills in the form.
 */

export type CompletenessSeverity = "critical" | "warning" | "info";
export type CompletenessLocation = "offer" | "item" | "partner" | "tenant";

export interface CompletenessIssue {
  field: string;
  label: string;
  severity: CompletenessSeverity;
  location: CompletenessLocation;
  itemIndex?: number;
  message: string;
  suggestion?: string;
}

export interface CompletenessReport {
  issues: CompletenessIssue[];
  criticalCount: number;
  warningCount: number;
  completenessScore: number; // 0-100
  filledFields: number;
  totalFields: number;
}

/**
 * Loose shape of the supplier-offer context that the offer form already
 * fetches via `/api/automation/product-context`. We only read a handful of
 * fields off it (hs_code, origin_country, packaging, incoterm, lead_time_days,
 * payment_terms, loading_port) to drive the suggestions, so an `any` payload
 * is acceptable here — the upstream `ProductContext` type is much richer.
 */
export type SupplierOfferContext = Record<number, any>;

/**
 * Check offer data completeness.
 * Returns a list of issues + a completeness score.
 */
export function checkOfferCompleteness(
  offer: Partial<Offer>,
  items: OfferLineItem[],
  partner: Partner | null,
  tenant: Tenant | null,
  supplierOffersContext?: SupplierOfferContext, // productContextMap
): CompletenessReport {
  const issues: CompletenessIssue[] = [];
  let filledFields = 0;
  let totalFields = 0;

  // ── Offer-level required fields ──
  const offerFields: Array<{ field: string; label: string; severity: CompletenessSeverity }> = [
    { field: "number", label: "Offer Number", severity: "critical" },
    { field: "subject", label: "Subject", severity: "warning" },
    { field: "partner_id", label: "Buyer", severity: "critical" },
    { field: "currency", label: "Currency", severity: "critical" },
    { field: "valid_until", label: "Valid Until Date", severity: "critical" },
    { field: "incoterm", label: "Incoterm", severity: "critical" },
    { field: "payment_terms", label: "Payment Terms", severity: "critical" },
    { field: "pol", label: "Loading Port (POL)", severity: "warning" },
    { field: "pod", label: "Discharge Port (POD)", severity: "warning" },
    { field: "lead_time", label: "Lead Time", severity: "warning" },
    { field: "packaging", label: "Packaging", severity: "warning" },
    { field: "bank_details", label: "Bank Details", severity: "warning" },
    { field: "terms", label: "Terms & Conditions", severity: "info" },
    { field: "notes", label: "Offer Text", severity: "info" },
  ];

  for (const f of offerFields) {
    totalFields++;
    const value = (offer as any)[f.field];
    if (value && String(value).trim()) {
      filledFields++;
    } else {
      issues.push({
        field: f.field,
        label: f.label,
        severity: f.severity,
        location: "offer",
        message: `Missing: ${f.label}`,
        suggestion: getOfferFieldSuggestion(f.field),
      });
    }
  }

  // ── Item-level required fields ──
  if (items.length === 0) {
    issues.push({
      field: "items",
      label: "Line Items",
      severity: "critical",
      location: "item",
      message: "No products added to this offer",
      suggestion: "Add at least one product",
    });
    totalFields++;
  } else {
    items.forEach((item, idx) => {
      const itemFields: Array<{ field: string; label: string; severity: CompletenessSeverity }> = [
        { field: "product_name", label: "Product Name", severity: "critical" },
        { field: "hs_code", label: "HS Code", severity: "warning" },
        { field: "quantity", label: "Quantity", severity: "critical" },
        { field: "unit", label: "Unit", severity: "critical" },
        { field: "unit_price", label: "Unit Price", severity: "critical" },
        { field: "origin_country", label: "Origin Country", severity: "warning" },
        { field: "specifications", label: "Specifications", severity: "info" },
        { field: "packaging", label: "Packaging", severity: "info" },
      ];

      for (const f of itemFields) {
        totalFields++;
        const value = (item as any)[f.field];
        if (
          value &&
          (typeof value === "object"
            ? Object.keys(value).length > 0
            : String(value).trim())
        ) {
          filledFields++;
        } else {
          issues.push({
            field: f.field,
            label: f.label,
            severity: f.severity,
            location: "item",
            itemIndex: idx,
            message: `Item ${idx + 1}: Missing ${f.label}`,
            suggestion: getItemFieldSuggestion(
              f.field,
              idx,
              supplierOffersContext?.[idx],
            ),
          });
        }
      }
    });
  }

  // ── Partner-level fields ──
  if (partner) {
    const partnerFields: Array<{ field: string; label: string; severity: CompletenessSeverity }> = [
      { field: "address_line", label: "Address", severity: "warning" },
      { field: "city", label: "City", severity: "warning" },
      { field: "country", label: "Country", severity: "warning" },
      { field: "tax_id", label: "Tax ID", severity: "info" },
      { field: "vat_number", label: "VAT Number", severity: "info" },
    ];

    for (const f of partnerFields) {
      totalFields++;
      const value = (partner as any)[f.field];
      if (value && String(value).trim()) {
        filledFields++;
      } else {
        issues.push({
          field: f.field,
          label: f.label,
          severity: f.severity,
          location: "partner",
          message: `Buyer: Missing ${f.label}`,
          suggestion: `Update partner record to add ${f.label}`,
        });
      }
    }
  }

  // ── Tenant-level fields ──
  if (tenant) {
    const tenantFields: Array<{ field: string; label: string; severity: CompletenessSeverity }> = [
      { field: "legal_name", label: "Legal Name", severity: "critical" },
      { field: "address_line", label: "Address", severity: "warning" },
      { field: "registration_number", label: "Registration Number", severity: "warning" },
      { field: "vat_number", label: "VAT Number", severity: "info" },
      { field: "bank_name", label: "Bank Name", severity: "warning" },
      { field: "bank_iban", label: "Bank IBAN", severity: "warning" },
      { field: "bank_swift", label: "Bank SWIFT", severity: "warning" },
    ];

    for (const f of tenantFields) {
      totalFields++;
      const value = (tenant as any)[f.field];
      if (value && String(value).trim()) {
        filledFields++;
      } else {
        issues.push({
          field: f.field,
          label: f.label,
          severity: f.severity,
          location: "tenant",
          message: `Company: Missing ${f.label}`,
          suggestion: `Update tenant settings to add ${f.label}`,
        });
      }
    }
  }

  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const completenessScore =
    totalFields > 0 ? Math.round((filledFields / totalFields) * 100) : 0;

  return {
    issues,
    criticalCount,
    warningCount,
    completenessScore,
    filledFields,
    totalFields,
  };
}

function getOfferFieldSuggestion(field: string): string | undefined {
  const suggestions: Record<string, string> = {
    valid_until: "Set a validity period (e.g., 30 days from issue date)",
    incoterm: "Select the Incoterm (e.g., FOB, CIF, DAP)",
    payment_terms: "Select payment terms (e.g., 30% Advance, 70% on B/L)",
    pol: "Enter the loading port (e.g., Hamburg)",
    pod: "Enter the discharge port (e.g., Jebel Ali)",
    lead_time: "Enter delivery time (e.g., 14 days after order confirmation)",
    packaging: "Enter packaging details (e.g., 50kg PP bags on pallets)",
    bank_details: "Enter bank details for payment",
    terms: "Add standard terms & conditions",
    notes: "Add offer text / cover letter",
  };
  return suggestions[field];
}

function getItemFieldSuggestion(
  field: string,
  idx: number,
  supplierOffer?: any,
): string | undefined {
  const suggestions: Record<string, string> = {
    product_name: "Select a product or enter a custom name",
    hs_code: "Enter the HS code (10-digit) — check product catalog or supplier offer",
    quantity: "Enter the quantity",
    unit: "Select the unit of measure",
    unit_price: "Enter the unit price — check supplier offer for reference",
    origin_country: "Select the country of origin — check supplier offer",
    specifications: "Add specifications (quality, grade, analysis)",
    packaging: "Enter packaging details for this product",
  };

  // If we have supplier offer context, add specific suggestions so the user
  // knows whether the data exists upstream (in the supplier offer) or whether
  // they need to look it up from the product catalog.
  if (supplierOffer) {
    if (field === "hs_code") {
      if (supplierOffer.hs_code) {
        return `Available from supplier offer: ${supplierOffer.hs_code}`;
      }
      return "Not available in supplier offer — look up HS code from product catalog";
    }
    if (field === "origin_country" && supplierOffer.origin_country) {
      return `Available from supplier: ${supplierOffer.origin_country}`;
    }
    if (field === "unit_price" && supplierOffer.unit_price != null) {
      return `Supplier price: ${supplierOffer.unit_price} ${supplierOffer.currency || ""}`.trim();
    }
    if (field === "packaging" && supplierOffer.packaging) {
      return `Supplier packaging: ${supplierOffer.packaging}`;
    }
  }

  // `idx` is referenced here so the linter doesn't flag it as unused — and so
  // future per-item suggestions can be added without changing the signature.
  void idx;
  return suggestions[field];
}
