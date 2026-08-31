import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * GET /api/integrations/wits?reporter=AE&partner=RS&hsCode=1801
 *
 * Trade Advisor — checks Free Trade Agreements, tariff rates, and regulations
 * between an origin country (partner) and a destination country (reporter).
 *
 * Returns:
 *   - Applicable FTAs with full descriptions
 *   - Tariff rates (MFN + preferential)
 *   - VAT / GST rates
 *   - Smart recommendations
 *   - Glossary of all trade terms used (so non-experts understand)
 *   - Required documents for customs clearance
 *
 * No external API — all data is embedded (always works, always fast).
 */

// ── Glossary of trade terms ────────────────────────────────────────────
const GLOSSARY: Record<string, { term: string; full: string; explanation: string }> = {
  MFN: {
    term: "MFN",
    full: "Most Favored Nation",
    explanation: "The standard tariff rate a country charges on imports from WTO members that it doesn't have a special trade agreement with. This is the 'default' duty rate — if no FTA applies, you pay this.",
  },
  FTA: {
    term: "FTA",
    full: "Free Trade Agreement",
    explanation: "A treaty between two or more countries that reduces or eliminates tariffs on goods traded between them. If an FTA applies, you may pay 0% or a reduced duty instead of the MFN rate.",
  },
  CIF: {
    term: "CIF",
    full: "Cost, Insurance, Freight",
    explanation: "The total value of goods including the purchase price, insurance, and shipping costs up to the destination port. Customs duty is usually calculated as a percentage of the CIF value.",
  },
  VAT: {
    term: "VAT",
    full: "Value Added Tax",
    explanation: "A consumption tax charged on imported goods, similar to sales tax. It's calculated on (CIF value + customs duty). Even if duty is 0% under an FTA, VAT usually still applies.",
  },
  GST: {
    term: "GST",
    full: "Goods and Services Tax",
    explanation: "Similar to VAT — used in some countries (India, Australia, Canada) instead of VAT. Calculated on the total value including duty.",
  },
  HS: {
    term: "HS Code",
    full: "Harmonized System Code",
    explanation: "An internationally standardized 6-10 digit code that classifies traded products. Customs authorities use it to determine the applicable tariff rate. Example: 180100 = Cocoa beans.",
  },
  COO: {
    term: "Certificate of Origin",
    full: "Certificate of Origin (COO)",
    explanation: "A document that proves where goods were manufactured. Required to claim preferential tariff rates under an FTA. Issued by chambers of commerce or customs authorities.",
  },
  CU: {
    term: "Customs Union",
    full: "Customs Union",
    explanation: "A group of countries that have eliminated tariffs between themselves AND adopted a common external tariff for imports from outside the group. Example: EU, GCC, EAEU.",
  },
  BTA: {
    term: "Bilateral Trade Agreement",
    full: "Bilateral Trade Agreement",
    explanation: "A trade agreement between exactly two countries (as opposed to a multilateral agreement between many countries).",
  },
  AHTN: {
    term: "AHTN",
    full: "ASEAN Harmonized Tariff Nomenclature",
    explanation: "The tariff classification system used by ASEAN countries. Based on HS codes but with regional subdivisions.",
  },
};

// ── FTA Database ───────────────────────────────────────────────────────
interface FTA {
  name: string;
  members: string[];
  type: string;
  typeCode: "CU" | "FTA" | "BTA";
  description: string;
  effectiveDate: string;
  tariffReduction: string;
  notes: string;
}

const FTA_DATABASE: FTA[] = [
  {
    name: "GCC (Gulf Cooperation Council)",
    members: ["SA", "AE", "BH", "KW", "QA", "OM"],
    type: "Customs Union",
    typeCode: "CU",
    description: "Free trade between Gulf states with a common external tariff of 5% on most goods. Food, medicine, and basic essentials are often 0%.",
    effectiveDate: "2003-01-01",
    tariffReduction: "0% duty between GCC members",
    notes: "No customs duty on goods moving between GCC countries. Common 5% external tariff for non-GCC imports.",
  },
  {
    name: "EU Single Market",
    members: ["DE", "FR", "IT", "NL", "BE", "ES", "PT", "IE", "AT", "FI", "GR", "LU", "SI", "SK", "EE", "LV", "LT", "CY", "MT", "HR", "BG", "RO", "PL", "CZ", "HU", "DK", "SE"],
    type: "Customs Union + Single Market",
    typeCode: "CU",
    description: "Free movement of goods between EU member states. Common external tariff (CET) for imports from outside the EU. VAT applies but varies by country.",
    effectiveDate: "1993-01-01",
    tariffReduction: "0% duty between EU members",
    notes: "No customs checks between EU countries. Non-EU imports pay EU CET (average 5.5% for industrial goods, higher for agricultural).",
  },
  {
    name: "USMCA (formerly NAFTA)",
    members: ["US", "CA", "MX"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "Free trade between USA, Canada, and Mexico. Replaced NAFTA in July 2020. Most goods qualify for 0% duty if they meet Rules of Origin.",
    effectiveDate: "2020-07-01",
    tariffReduction: "0% duty on goods meeting Rules of Origin (typically 50-75% regional value content)",
    notes: "Requires USMCA Certification of Origin. Specific rules per product category. Automotive has local content requirements.",
  },
  {
    name: "Mercosur",
    members: ["BR", "AR", "UY", "PY"],
    type: "Customs Union",
    typeCode: "CU",
    description: "Free trade between South American nations with a common external tariff (CET). Average CET is 12-14%.",
    effectiveDate: "1991-11-29",
    tariffReduction: "0% duty between Mercosur members",
    notes: "Some products are on exception lists with higher tariffs. Venezuela (suspended member) not included.",
  },
  {
    name: "ASEAN Free Trade Area (AFTA)",
    members: ["SG", "MY", "TH", "ID", "PH", "VN", "BN", "KH", "LA", "MM"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "Free trade between Southeast Asian nations. Tariffs reduced to 0-5% on most goods under the Common Effective Preferential Tariff (CEPT) scheme.",
    effectiveDate: "1992-01-28",
    tariffReduction: "0-5% duty on CEPT-eligible goods",
    notes: "Requires Form D (Certificate of Origin). Some sensitive products are excluded.",
  },
  {
    name: "CEFTA (Central European Free Trade Agreement)",
    members: ["RS", "AL", "BA", "MK", "ME", "MD", "XK"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "Free trade between Central European and Balkan nations. Eliminates tariffs on most industrial and agricultural goods.",
    effectiveDate: "2006-07-01",
    tariffReduction: "0% duty on most goods between CEFTA members",
    notes: "Serbia, Bosnia, Montenegro, North Macedonia, Albania, Moldova, and Kosovo are members. Requires EUR.1 or invoice declaration.",
  },
  {
    name: "GAFTA (Greater Arab Free Trade Area)",
    members: ["SA", "AE", "EG", "JO", "SY", "LB", "IQ", "KW", "QA", "BH", "OM", "LY", "SD", "YE", "PS", "MA", "TN", "DJ", "MR"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "Free trade between Arab League nations. Gradual tariff reduction — most goods now at 0% duty between members.",
    effectiveDate: "2005-01-01",
    tariffReduction: "0% duty on most goods between GAFTA members",
    notes: "Requires Certificate of Origin. Some products on negative list. Syria partially suspended.",
  },
  {
    name: "Turkey-EU Customs Union",
    members: ["TR", "DE", "FR", "IT", "NL", "BE", "ES", "PT", "IE", "AT", "FI", "GR", "LU", "SI", "SK", "EE", "LV", "LT", "CY", "MT", "HR", "BG", "RO", "PL", "CZ", "HU", "DK", "SE"],
    type: "Customs Union",
    typeCode: "CU",
    description: "Turkey has a customs union with the EU for industrial goods and processed agricultural products. 0% duty on most industrial goods.",
    effectiveDate: "1996-01-01",
    tariffReduction: "0% duty on industrial goods between Turkey and EU",
    notes: "Only covers industrial goods (HS Chapters 25-97) and some processed agricultural products. Raw agricultural products are excluded.",
  },
  {
    name: "EAEU (Eurasian Economic Union)",
    members: ["RU", "BY", "KZ", "AM", "KG"],
    type: "Customs Union",
    typeCode: "CU",
    description: "Free trade and common external tariff between Russia, Belarus, Kazakhstan, Armenia, and Kyrgyzstan.",
    effectiveDate: "2015-01-01",
    tariffReduction: "0% duty between EAEU members",
    notes: "Common external tariff applies to non-EAEU imports. Belarus has some specific exemptions.",
  },
  {
    name: "SADC (Southern African Development Community)",
    members: ["ZA", "BW", "LS", "NA", "SZ", "MZ", "ZM", "ZW", "MW", "TZ", "CD", "MG", "MU", "SC"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "Free trade between Southern African nations. 85% of tariff lines at 0% duty between members.",
    effectiveDate: "2008-01-01",
    tariffReduction: "0% duty on most goods (85% of tariff lines)",
    notes: "Some sensitive products have phase-down schedules. Requires SADC Certificate of Origin.",
  },
  {
    name: "AfCFTA (African Continental Free Trade Area)",
    members: ["EG", "ZA", "NG", "KE", "GH", "CI", "CM", "ET", "TZ", "MA", "SN", "AO", "MZ", "ZW", "ZM", "UG", "RW", "SD", "LY", "TN", "DZ"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "World's largest free trade area by number of countries (54). Gradual tariff elimination: 90% of tariff lines to 0%, 7% sensitive products phased, 3% excluded.",
    effectiveDate: "2021-01-01",
    tariffReduction: "0% on 90% of tariff lines (phased over 5-10 years)",
    notes: "Implementation is ongoing — not all countries have ratified. Check bilateral status.",
  },
  {
    name: "RCEP (Regional Comprehensive Economic Partnership)",
    members: ["CN", "JP", "KR", "AU", "NZ", "SG", "MY", "TH", "ID", "PH", "VN", "BN", "KH", "LA", "MM"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "World's largest trade bloc by GDP. Covers 15 Asia-Pacific countries. Gradual tariff reduction over 20 years.",
    effectiveDate: "2022-01-01",
    tariffReduction: "0% on up to 90% of tariff lines (phased over 20 years)",
    notes: "Uses cumulative Rules of Origin — components from any RCEP member count toward the threshold. Requires RCEP Certificate of Origin.",
  },
  {
    name: "CPTPP (Comprehensive and Progressive Trans-Pacific Partnership)",
    members: ["JP", "AU", "NZ", "CA", "SG", "MY", "VN", "BN", "MX", "CL", "PE"],
    type: "Free Trade Agreement",
    typeCode: "FTA",
    description: "High-standard trade agreement covering 11 Pacific Rim countries. Eliminates 95%+ of tariffs between members.",
    effectiveDate: "2018-12-30",
    tariffReduction: "0% on 95%+ of tariff lines (most immediately, rest phased)",
    notes: "UK has applied to join. Requires CPTPP Certificate of Origin.",
  },
];

// ── Tariff rates by country (detailed) ────────────────────────────────
interface TariffInfo {
  averageMFN: number;
  vat: number;
  vatName: string;
  notes: string;
  foodExemptions: string;
  documentationRequired: string[];
}

const TARIFF_RATES: Record<string, TariffInfo> = {
  AE: {
    averageMFN: 5, vat: 5, vatName: "VAT",
    notes: "GCC common external tariff (CET). 5% on most goods. Customs duty calculated on CIF value. VAT (5%) applies on (CIF + duty).",
    foodExemptions: "0% duty on: rice, wheat, flour, sugar, cooking oil, livestock, fish, dairy, tea, coffee, spices, fresh produce.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading / Airway Bill", "Certificate of Origin (for FTA claims)", "Health Certificate (food products)"],
  },
  SA: {
    averageMFN: 5, vat: 15, vatName: "VAT",
    notes: "GCC common external tariff. 15% VAT since July 2020. Duty on CIF value, VAT on (CIF + duty).",
    foodExemptions: "0% duty on many food items. 15% VAT applies to all imports.",
    documentationRequired: ["Commercial Invoice (attested by chamber)", "Packing List", "Bill of Lading", "Certificate of Origin", "SASO Certificate (for regulated products)"],
  },
  RS: {
    averageMFN: 6, vat: 20, vatName: "VAT (PDV)",
    notes: "CEFTA member — 0% duty with Balkan countries. MFN rate ~6% average for non-FTA countries. 20% VAT (PDV) on (CIF + duty).",
    foodExemptions: "0% duty on many agricultural products within CEFTA. Reduced VAT (10%) on some food items.",
    documentationRequired: ["Commercial Invoice", "Packing List", "CMR (road) / Bill of Lading (sea)", "EUR.1 Certificate (for CEFTA preference)", "Phytosanitary Certificate (plants)"],
  },
  EU: {
    averageMFN: 5, vat: 21, vatName: "VAT (varies by country)",
    notes: "EU common external tariff (CET). Average 5.5% for industrial, higher for agricultural. VAT varies 17-27% by member state. Duty on CIF, VAT on (CIF + duty).",
    foodExemptions: "Many agricultural products have high tariffs or quotas. Check TARIC database for specific HS codes.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "Certificate of Origin", "S申报 (ENS)", "Phytosanitary Certificate (food)", "CE Marking (electronics)"],
  },
  TR: {
    averageMFN: 8, vat: 20, vatName: "KDV (VAT)",
    notes: "Customs Union with EU for industrial goods (0% duty). MFN ~8% for non-EU industrial. 20% KDV (VAT) on (CIF + duty). Agricultural products NOT covered by CU.",
    foodExemptions: "Agricultural products have separate tariffs. Check Turkey's tariff schedule.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading / CMR", "A.TR Certificate (for EU customs union)", "Certificate of Origin (non-EU)", "Turkish Standards Certificate (TSE)"],
  },
  CN: {
    averageMFN: 8, vat: 13, vatName: "VAT",
    notes: "MFN average ~8%. RCEP member (preferential rates for Asian partners). 13% VAT on (CIF + duty + consumption tax if applicable).",
    foodExemptions: "0% duty on many food and agricultural imports. Some items require import licenses.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "Certificate of Origin", "China CCC Certificate (electronics)", "Import License (restricted items)"],
  },
  IN: {
    averageMFN: 15, vat: 18, vatName: "GST",
    notes: "Higher tariffs to protect domestic industry. MFN average ~15%. 18% GST on (CIF + duty + cess). Social welfare surcharge (10% of duty) also applies.",
    foodExemptions: "0% or low duty on essential food items (rice, wheat, pulses). 5% GST on essential goods.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "Certificate of Origin", "BIS Certificate (electronics)", "FSSAI License (food)"],
  },
  US: {
    averageMFN: 3, vat: 0, vatName: "Sales Tax (state-level, not federal)",
    notes: "Low average MFN tariff (~3%). No federal VAT — sales tax varies by state (0-10%). USMCA member (0% with CA/MX if rules met).",
    foodExemptions: "Many food items at 0% duty. Some agricultural products have high tariffs or quotas (sugar, dairy).",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "USMCA Certification (CA/MX)", "FDA Prior Notice (food)", "FCC Declaration (electronics)"],
  },
  GB: {
    averageMFN: 5, vat: 20, vatName: "VAT",
    notes: "Post-Brexit UK Global Tariff (UKGT). Similar to EU CET but with simplifications. 20% VAT on (CIF + duty).",
    foodExemptions: "0% duty on many food items. Check UKGT schedule for specifics.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "Certificate of Origin", "EORI Number", "Health Certificate (food)"],
  },
  BR: {
    averageMFN: 12, vat: 18, vatName: "ICMS (state tax)",
    notes: "Mercosur CET (~12% average). High tariffs on many goods. ICMS (state VAT) 17-19% varies by state. PIS/COFINS federal taxes also apply.",
    foodExemptions: "0% duty on some essential food items within Mercosur. Check TEC schedule.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "Certificate of Origin", "Import License (LI) for some products", "ANVISA Registration (food/health)"],
  },
  EG: {
    averageMFN: 20, vat: 14, vatName: "VAT",
    notes: "High MFN tariffs (~20% average). GAFTA member (0% with Arab nations). 14% VAT on (CIF + duty).",
    foodExemptions: "0% duty on some basic food items. VAT exemptions for essential goods.",
    documentationRequired: ["Commercial Invoice (legalized)", "Packing List", "Bill of Lading", "Certificate of Origin", "GOEIC Registration", "Inspection Certificate"],
  },
  SN: {
    averageMFN: 12, vat: 18, vatName: "VAT (TVA)",
    notes: "ECOWAS CET (~12% average). AfCFTA member. 18% TVA on (CIF + duty).",
    foodExemptions: "0% duty on some food products within ECOWAS.",
    documentationRequired: ["Commercial Invoice", "Packing List", "Bill of Lading", "Certificate of Origin", "Bureau Veritas Inspection (PVOC)"],
  },
};

// ── Required documents by document type ───────────────────────────────
const DOCUMENT_INFO: Record<string, { name: string; description: string; where: string }> = {
  "Commercial Invoice": { name: "Commercial Invoice", description: "The bill for the goods from seller to buyer. Must show value, currency, HS codes, and Incoterms.", where: "Issued by the seller/exporter." },
  "Packing List": { name: "Packing List", description: "Detailed list of contents, weights, dimensions, and packaging types for each shipment.", where: "Issued by the seller/exporter." },
  "Bill of Lading": { name: "Bill of Lading (B/L)", description: "Transport document for sea freight. Serves as receipt, contract of carriage, and document of title.", where: "Issued by the shipping line/carrier." },
  "Certificate of Origin": { name: "Certificate of Origin (COO)", description: "Proves where goods were manufactured. Required to claim preferential tariff rates under FTAs.", where: "Issued by Chamber of Commerce or customs authority." },
  "EUR.1": { name: "EUR.1 Certificate", description: "Specific Certificate of Origin used for EU and CEFTA preferential trade.", where: "Issued by customs authority of the exporting country." },
  "A.TR": { name: "A.TR Certificate", description: "Movement certificate for Turkey-EU Customs Union. Proves goods are in free circulation.", where: "Issued by customs authority." },
};

export async function GET(req: NextRequest) {
  try {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (integrations.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "integrations.read"); if (_d) return _d; } /* requirePermission wired */


  const url = new URL(req.url);
  const reporter = (url.searchParams.get("reporter") || "").toUpperCase();
  const partner = (url.searchParams.get("partner") || "").toUpperCase();
  const hsCode = url.searchParams.get("hsCode");

  if (!reporter && !partner) {
    return NextResponse.json({ error: "Provide reporter (destination) and/or partner (origin) country codes." }, { status: 400 });
  }

  // Find applicable FTAs
  const applicableFTAs = FTA_DATABASE.filter((fta) => {
    if (reporter && partner) {
      return fta.members.includes(reporter) && fta.members.includes(partner);
    }
    if (reporter) return fta.members.includes(reporter);
    if (partner) return fta.members.includes(partner);
    return false;
  });

  // Get tariff info
  const tariff = TARIFF_RATES[reporter] || null;

  // Determine which glossary terms are relevant
  const relevantTerms: string[] = ["MFN", "FTA", "CIF", "VAT", "HS", "COO"];
  if (tariff?.vatName?.includes("GST")) relevantTerms.push("GST");
  if (applicableFTAs.some((f) => f.typeCode === "CU")) relevantTerms.push("CU");
  if (applicableFTAs.some((f) => f.members.includes("TR"))) relevantTerms.push("AHTN");

  // Build advisor response
  const advisor: any = {
    reporter,
    partner,
    reporterName: reporter,
    partnerName: partner,
    hsCode: hsCode || null,
    checkedAt: new Date().toISOString(),

    freeTradeAgreements: applicableFTAs.map((fta) => ({
      name: fta.name,
      type: fta.type,
      typeCode: fta.typeCode,
      typeExplanation: GLOSSARY[fta.typeCode]?.explanation || fta.type,
      description: fta.description,
      effectiveDate: fta.effectiveDate,
      tariffReduction: fta.tariffReduction,
      notes: fta.notes,
      members: fta.members,
    })),

    tariff: tariff ? {
      mfnRate: tariff.averageMFN,
      mfnExplanation: `Most Favored Nation rate — the standard duty rate. ${tariff.averageMFN}% of CIF value.`,
      vat: tariff.vat,
      vatName: tariff.vatName,
      vatExplanation: `${tariff.vat}% ${tariff.vatName} calculated on (CIF value + customs duty). Even if duty is 0% under FTA, VAT still applies.`,
      notes: tariff.notes,
      foodExemptions: tariff.foodExemptions,
      hasFTA: applicableFTAs.length > 0,
      estimatedDuty: applicableFTAs.length > 0
        ? `0% or reduced (FTA applies — preferential tariff instead of ${tariff.averageMFN}% MFN)`
        : `${tariff.averageMFN}% (MFN rate — no FTA applies)`,
      estimatedTotalTax: applicableFTAs.length > 0
        ? `Duty: 0% + ${tariff.vatName}: ${tariff.vat}% = Total tax ~${tariff.vat}% of CIF`
        : `Duty: ${tariff.averageMFN}% + ${tariff.vatName}: ${tariff.vat}% = Total tax ~${Math.round((1 + tariff.averageMFN / 100) * tariff.vat + tariff.averageMFN)}% of CIF`,
    } : null,

    recommendations: [] as string[],
    requiredDocuments: tariff?.documentationRequired || [],
    documentDetails: (tariff?.documentationRequired || []).map((d) => {
      const info = DOCUMENT_INFO[d];
      return info || { name: d, description: "", where: "" };
    }),

    glossary: relevantTerms.map((code) => GLOSSARY[code]).filter(Boolean),
  };

  // Generate smart recommendations
  if (applicableFTAs.length > 0) {
    advisor.recommendations.push(
      `✅ ${applicableFTAs.length} Free Trade Agreement(s) found between ${reporter} and ${partner}.`
    );
    for (const fta of applicableFTAs) {
      advisor.recommendations.push(
        `   📋 ${fta.name}: ${fta.tariffReduction}. Effective since ${fta.effectiveDate}.`
      );
    }
    advisor.recommendations.push(
      `🔑 To claim the preferential (reduced/zero) tariff, you MUST include a Certificate of Origin (COO) with your shipment. Without it, customs will charge the full MFN rate.`
    );
  } else if (reporter && partner) {
    advisor.recommendations.push(
      `⚠️ No Free Trade Agreement found between ${reporter} and ${partner}. The standard MFN (Most Favored Nation) tariff rate will apply.`
    );
  }

  if (tariff) {
    const totalTax = applicableFTAs.length > 0
      ? `~${tariff.vat}% (${tariff.vatName} only, duty waived under FTA)`
      : `~${Math.round((1 + tariff.averageMFN / 100) * tariff.vat + tariff.averageMFN)}% (duty + ${tariff.vatName})`;
    advisor.recommendations.push(
      `💰 Estimated total import cost: ${totalTax} of CIF value (Cost + Insurance + Freight).`
    );
    advisor.recommendations.push(
      `🥗 Food exemptions: ${tariff.foodExemptions}`
    );
  }

  if (hsCode) {
    advisor.recommendations.push(
      `📌 HS Code ${hsCode}: Check the destination country's official tariff schedule for the exact duty rate on this specific product. The rates shown here are averages.`
    );
  }

  advisor.recommendations.push(
    `📋 Required documents for customs clearance in ${reporter}: ${(tariff?.documentationRequired || []).join(", ")}.`
  );

  return NextResponse.json(advisor);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
