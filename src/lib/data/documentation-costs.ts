/**
 * Standard trade documentation costs.
 * Based on DP World, ICC, and World Bank trade facilitation data.
 * These are typically fixed fees per document.
 */

export type DocumentationCategory =
  | "shipping"
  | "certification"
  | "inspection"
  | "legalization"
  | "other";

export type DocumentationBasis = "fixed" | "per_copy" | "per_page";

export interface DocumentationCostItem {
  id: string;
  label: string;
  description: string;
  basis: DocumentationBasis;
  defaultValue: number; // USD
  category: DocumentationCategory;
  typicallyRequired: boolean; // true = most shipments need it
}

export const DOCUMENTATION_COSTS: DocumentationCostItem[] = [
  // ─── Shipping documents ───
  {
    id: "bill_of_lading",
    label: "Bill of Lading (B/L)",
    description: "Original B/L issuance fee",
    basis: "fixed",
    defaultValue: 50,
    category: "shipping",
    typicallyRequired: true,
  },
  {
    id: "bl_copies",
    label: "B/L Copies",
    description: "Extra copies of B/L (usually 3-5 needed)",
    basis: "per_copy",
    defaultValue: 15,
    category: "shipping",
    typicallyRequired: true,
  },
  {
    id: "freight_invoice",
    label: "Freight Invoice",
    description: "Freight forwarder's invoice fee",
    basis: "fixed",
    defaultValue: 25,
    category: "shipping",
    typicallyRequired: true,
  },

  // ─── Certification ───
  {
    id: "phytosanitary_cert",
    label: "Phytosanitary Certificate",
    description:
      "Plant health certificate (required for agricultural products)",
    basis: "fixed",
    defaultValue: 60,
    category: "certification",
    typicallyRequired: false,
  },
  {
    id: "cert_of_origin",
    label: "Certificate of Origin",
    description: "Official CoO from Chamber of Commerce",
    basis: "fixed",
    defaultValue: 50,
    category: "certification",
    typicallyRequired: true,
  },
  {
    id: "health_certificate",
    label: "Health/Veterinary Certificate",
    description: "Health certificate for food/animal products",
    basis: "fixed",
    defaultValue: 75,
    category: "certification",
    typicallyRequired: false,
  },
  {
    id: "fumigation_cert",
    label: "Fumigation Certificate",
    description: "Certificate of fumigation treatment",
    basis: "fixed",
    defaultValue: 100,
    category: "certification",
    typicallyRequired: false,
  },

  // ─── Inspection ───
  {
    id: "inspection_fee",
    label: "Pre-shipment Inspection",
    description: "SGS/Intertek/BV inspection at loading port",
    basis: "fixed",
    defaultValue: 300,
    category: "inspection",
    typicallyRequired: true,
  },
  {
    id: "weight_survey",
    label: "Weight/Quantity Survey",
    description: "Independent weight verification",
    basis: "fixed",
    defaultValue: 200,
    category: "inspection",
    typicallyRequired: false,
  },
  {
    id: "quality_analysis",
    label: "Quality/COA Analysis",
    description:
      "Laboratory quality analysis (Certificate of Analysis)",
    basis: "fixed",
    defaultValue: 250,
    category: "inspection",
    typicallyRequired: false,
  },

  // ─── Legalization ───
  {
    id: "consular_legalization",
    label: "Consular Legalization",
    description:
      "Document legalization at embassy/consulate (required by some countries)",
    basis: "fixed",
    defaultValue: 150,
    category: "legalization",
    typicallyRequired: false,
  },
  {
    id: "chamber_certification",
    label: "Chamber Certification",
    description: "Chamber of Commerce document certification",
    basis: "fixed",
    defaultValue: 40,
    category: "legalization",
    typicallyRequired: true,
  },

  // ─── Other ───
  {
    id: "packing_list",
    label: "Packing List Preparation",
    description: "Professional packing list preparation",
    basis: "fixed",
    defaultValue: 25,
    category: "other",
    typicallyRequired: true,
  },
  {
    id: "customs_declaration",
    label: "Customs Declaration Fee",
    description: "Customs broker fee for export/import declaration",
    basis: "fixed",
    defaultValue: 100,
    category: "other",
    typicallyRequired: true,
  },
  {
    id: "terminal_handling",
    label: "THC (Terminal Handling Charge)",
    description:
      "Port terminal handling charge per container/shipment",
    basis: "fixed",
    defaultValue: 150,
    category: "other",
    typicallyRequired: true,
  },
];

export interface DocumentationCostResult {
  id: string;
  label: string;
  amount: number;
  description: string;
}

/**
 * Get default documentation costs (typically required ones).
 * Used to pre-select items when the dialog opens.
 */
export function getDefaultDocumentationCosts(): DocumentationCostItem[] {
  return DOCUMENTATION_COSTS.filter((d) => d.typicallyRequired);
}

/**
 * Default IDs of typically-required documents.
 */
export function getDefaultDocumentationIds(): string[] {
  return getDefaultDocumentationCosts().map((d) => d.id);
}

/**
 * Calculate documentation costs for the selected documents.
 *
 * @param selected     Array of documentation IDs to include
 * @param customValues Optional overrides keyed by documentation id
 * @param numContainers For THC scaling (per-container cost). 0/1 = single fee.
 */
export function calculateDocumentationCosts(
  selected: string[],
  customValues?: Record<string, number>,
  numContainers?: number,
): DocumentationCostResult[] {
  const results: DocumentationCostResult[] = [];

  for (const doc of DOCUMENTATION_COSTS) {
    if (!selected.includes(doc.id)) continue;

    const value = customValues?.[doc.id] ?? doc.defaultValue;
    let amount = value;

    if (doc.basis === "per_copy") {
      // Assume 5 copies per default — user can override the per-copy rate.
      amount = value * 5;
    }

    // THC scales with containers (default 1 if not set)
    if (doc.id === "terminal_handling" && numContainers && numContainers > 1) {
      amount = value * numContainers;
    }

    results.push({
      id: doc.id,
      label: doc.label,
      amount: Math.round(amount * 100) / 100,
      description: doc.description,
    });
  }

  return results;
}
