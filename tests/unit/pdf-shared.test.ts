import { describe, it, expect } from "vitest";
import {
  mmToPoints,
  fmtQty,
  fmtMoney,
  fmtValue,
  fmtWeight,
  fmtDateIso,
  sumRows,
  amountInWords,
  lightenHex,
  mapFont,
  boldVariant,
  countryName,
  joinAddressParts,
  remainingAddressParts,
  tradeWatermarkText,
  marketplaceWatermarkText,
  logisticsWatermarkText,
} from "@/lib/pdf/shared";

// 13-A: unit tests for the shared PDF helper module (audit12 dedup).
// audit13: joinAddressParts / remainingAddressParts / mapFont("Times-Roman") /
// boldVariant("Times-Roman") blocks below.
// Every helper that previously lived as a private copy in templates.tsx /
// packing-list.ts / marketplace/document-pdf.ts is now exported from
// @/lib/pdf/shared.ts — these tests pin the canonical behaviour so the
// three PDF template families can't drift apart again.

describe("mmToPoints", () => {
  it("converts millimetres to PDF points (1 mm = 2.83465 pt)", () => {
    expect(mmToPoints(1)).toBeCloseTo(2.83465, 5);
    expect(mmToPoints(20)).toBeCloseTo(56.693, 2);
    expect(mmToPoints(0)).toBe(0);
  });
});

describe("fmtMoney", () => {
  it("formats with exactly 2 decimals and thousands separators", () => {
    expect(fmtMoney(171000, "USD")).toBe("$171,000.00");
    expect(fmtMoney(1.15, "EUR")).toBe("€1.15");
    expect(fmtMoney(1000000, "USD")).toBe("$1,000,000.00");
  });
  it("falls back to 0.00 for null/undefined/NaN", () => {
    expect(fmtMoney(null)).toBe("$0.00");
    expect(fmtMoney(undefined)).toBe("$0.00");
    expect(fmtMoney(NaN)).toBe("$0.00");
  });
  it("falls back to '<value> <CODE>' for an invalid currency code", () => {
    // Node's Intl may either throw (→ manual fallback) or warn-and-format
    // ("XXL 5.00") depending on the ICU build — accept both, but NEVER a
    // crash and never a bare number without the currency code.
    const out = fmtMoney(5, "XXL");
    expect(out.includes("XXL")).toBe(true);
    expect(out).toMatch(/5\.00/);
  });
});

describe("fmtValue", () => {
  it("em-dashes null/undefined/empty", () => {
    expect(fmtValue(null)).toBe("—");
    expect(fmtValue(undefined)).toBe("—");
    expect(fmtValue("")).toBe("—");
  });
  it("stringifies everything else", () => {
    expect(fmtValue(42)).toBe("42");
    expect(fmtValue("abc")).toBe("abc");
    expect(fmtValue(0)).toBe("0");
  });
});

describe("fmtQty", () => {
  it("formats quantities with thousands separators, max 2 decimals", () => {
    expect(fmtQty(25000)).toBe("25,000");
    expect(fmtQty(0.5)).toBe("0.5");
    expect(fmtQty(1000000)).toBe("1,000,000");
  });
  it("em-dashes missing/unparseable values (human error tolerance)", () => {
    expect(fmtQty(null)).toBe("—");
    expect(fmtQty(undefined)).toBe("—");
    expect(fmtQty("")).toBe("—");
    expect(fmtQty("abc")).toBe("—");
  });
  it("accepts numeric strings", () => {
    expect(fmtQty("25000")).toBe("25,000");
  });
});

describe("fmtWeight", () => {
  it("formats weight with unit and max 2 decimals", () => {
    expect(fmtWeight(1234.5)).toBe("1,234.5 kg");
    expect(fmtWeight(0)).toBe("0 kg");
    expect(fmtWeight(null)).toBe("0 kg");
  });
});

describe("fmtDateIso", () => {
  it("formats ISO dates as '06 Aug 2026' (en-GB day-first)", () => {
    expect(fmtDateIso("2026-08-06T00:00:00Z")).toMatch(/06 Aug 2026/);
  });
  it("em-dashes missing dates", () => {
    expect(fmtDateIso(null)).toBe("—");
    expect(fmtDateIso(undefined)).toBe("—");
  });
});

describe("sumRows", () => {
  it("sums with float artefacts rounded to 2 decimals", () => {
    expect(sumRows([{ v: 0.1 }, { v: 0.2 }], (r) => r.v)).toBe(0.3);
    expect(sumRows([], (r: any) => r.v)).toBe(0);
  });
});

describe("amountInWords", () => {
  it("converts a round trade amount", () => {
    expect(amountInWords(171000, "USD")).toBe(
      "SAY: One Hundred Seventy-One Thousand US DOLLARS ONLY",
    );
  });
  it("includes cents when present", () => {
    expect(amountInWords(100.5, "USD")).toBe("SAY: One Hundred US DOLLARS AND 50/100 ONLY");
  });
  it("handles zero", () => {
    expect(amountInWords(0, "EUR")).toBe("SAY: Zero EUROS ONLY");
  });
  it("handles negative amounts", () => {
    expect(amountInWords(-25, "USD")).toBe("SAY: NEGATIVE Twenty-Five US DOLLARS ONLY");
  });
  it("handles billions", () => {
    expect(amountInWords(2_000_000_000, "USD")).toContain("Two Billion");
  });
  it("handles non-finite values (corrupt data)", () => {
    // early-return path spells ZERO literally (corrupt-data guard)
    expect(amountInWords(NaN, "USD")).toBe("SAY: ZERO US DOLLARS ONLY");
    expect(amountInWords(Infinity, "USD")).toBe("SAY: ZERO US DOLLARS ONLY");
  });
  it("maps the common trade currencies", () => {
    expect(amountInWords(1, "AED")).toContain("UAE DIRHAMS");
    expect(amountInWords(1, "GBP")).toContain("POUNDS STERLING");
    expect(amountInWords(1, "CHF")).toContain("SWISS FRANCS");
    expect(amountInWords(1, "TRY")).toContain("TURKISH LIRA");
  });
  it("falls back to the raw code for unmapped currencies", () => {
    expect(amountInWords(1, "RSD")).toContain("RSD");
  });
});

describe("lightenHex", () => {
  it("amount=1 → pure white, amount=0 → original", () => {
    expect(lightenHex("#000000", 1)).toBe("#ffffff");
    expect(lightenHex("#123456", 0)).toBe("#123456");
  });
  it("blends towards white", () => {
    expect(lightenHex("#000000", 0.5)).toBe("#808080");
  });
  it("returns the input for malformed hex", () => {
    expect(lightenHex("nope", 0.5)).toBe("nope");
    expect(lightenHex("#12345", 0.5)).toBe("#12345");
  });
});

describe("mapFont", () => {
  // audit20: sans stacks now resolve to the registered Unicode "NotoSans"
  // family — the WinAnsi-only built-in Helvetica corrupted Cyrillic/Greek/
  // Serbian-Latin ĐČĆ glyphs in every PDF.
  it("maps CSS font stacks to PDF-safe families", () => {
    expect(mapFont("Inter, system-ui, sans-serif")).toBe("NotoSans");
    expect(mapFont("times")).toBe("Times-Roman");
    expect(mapFont("times-new-roman")).toBe("Times-Roman");
    expect(mapFont("courier")).toBe("Courier");
  });
  it("falls back for unknown/missing fonts", () => {
    expect(mapFont(null)).toBe("NotoSans");
    expect(mapFont("Comic Sans")).toBe("NotoSans");
    expect(mapFont(undefined, "Times-Roman")).toBe("Times-Roman");
  });
});

describe("boldVariant", () => {
  // audit13: the OLD test asserted "Times-Roman" → "Times-Roman-Bold" — an
  // INVALID react-pdf font that never rendered. The correct Times bold family
  // is "Times-Bold". Stale invariant updated to the corrected behaviour.
  it("maps every built-in base family to its VALID bold variant", () => {
    // audit20: Helvetica→NotoSans-Bold (Unicode); Times/Courier keep built-ins
    expect(boldVariant("Helvetica")).toBe("NotoSans-Bold");
    expect(boldVariant("NotoSans")).toBe("NotoSans-Bold");
    expect(boldVariant("Times-Roman")).toBe("Times-Bold");
    expect(boldVariant("Courier")).toBe("Courier-Bold");
  });
  it("leaves already-bold families untouched and resolves oblique variants", () => {
    expect(boldVariant("NotoSans-Bold")).toBe("NotoSans-Bold");
    expect(boldVariant("Times-Bold")).toBe("Times-Bold");
    // -Oblique now resolves to the correct BoldOblique (previously produced
    // the invalid "Helvetica-Oblique-Bold")
    expect(boldVariant("Helvetica-Oblique")).toBe("NotoSans-BoldOblique");
    expect(boldVariant("NotoSans-Oblique")).toBe("NotoSans-BoldOblique");
    expect(boldVariant("Times-Italic")).toBe("Times-BoldItalic");
  });
});

describe("countryName", () => {
  it("resolves ISO alpha-2 codes to full names", () => {
    expect(countryName("AE")).toBe("United Arab Emirates");
    expect(countryName("et")).toBe("Ethiopia");
    expect(countryName("DE")).toBe("Germany");
  });
  it("em-dashes missing values, passes through unknown codes", () => {
    expect(countryName(null)).toBe("—");
    expect(countryName(undefined)).toBe("—");
    expect(countryName("XX")).toBe("XX");
  });
  it("audit13: full-name input passes through AS WRITTEN (was SHOUTED)", () => {
    // Partner rows sometimes store country as a full name — "Argentina".
    // The old implementation uppercased everything → "ARGENTINA" in every
    // party box. Full names now pass through unchanged; bare codes (≤3 chars)
    // still uppercase by convention.
    expect(countryName("Argentina")).toBe("Argentina");
    expect(countryName("United Kingdom")).toBe("United Kingdom");
    expect(countryName("ae")).toBe("United Arab Emirates");
    expect(countryName("et")).toBe("Ethiopia");
  });
});

describe("watermark status resolvers", () => {
  it("trade: DRAFT/PAID/VOID/CANCELLED/OVERDUE earn watermarks", () => {
    expect(tradeWatermarkText("draft")).toBe("DRAFT");
    expect(tradeWatermarkText("PAID")).toBe("PAID");
    expect(tradeWatermarkText("cancelled")).toBe("CANCELLED");
    expect(tradeWatermarkText("overdue")).toBe("OVERDUE");
    expect(tradeWatermarkText("sent")).toBe(""); // trade statuses that don't stamp
    expect(tradeWatermarkText(null)).toBe("");
    expect(tradeWatermarkText("")).toBe("");
  });
  it("trade: priceUnconfirmed overrides the status", () => {
    expect(tradeWatermarkText("paid", true)).toBe("PRICE NOT CONFIRMED");
    expect(tradeWatermarkText(null, true)).toBe("PRICE NOT CONFIRMED");
  });
  it("marketplace: DRAFT/REJECTED/SENT/SIGNED earn watermarks", () => {
    expect(marketplaceWatermarkText("draft")).toBe("DRAFT");
    expect(marketplaceWatermarkText("rejected")).toBe("REJECTED");
    expect(marketplaceWatermarkText("SIGNED")).toBe("SIGNED");
    expect(marketplaceWatermarkText("generated")).toBe("");
    expect(marketplaceWatermarkText(null)).toBe("");
  });
  it("logistics: derives status from pickup/delivery dates", () => {
    const now = Date.UTC(2026, 8, 1); // 1 Sep 2026
    expect(logisticsWatermarkText("2026-06-01", "2026-07-01", now)).toBe("DELIVERED");
    expect(logisticsWatermarkText("2026-06-01", "2027-07-01", now)).toBe("IN TRANSIT");
    expect(logisticsWatermarkText("2026-12-01", "2027-01-01", now)).toBe("SCHEDULED");
    expect(logisticsWatermarkText(null, null, now)).toBe("DRAFT");
    expect(logisticsWatermarkText("garbage", null, now)).toBe("DRAFT");
  });
});

// ─── audit13: address dedup (joinAddressParts / remainingAddressParts) ──────

describe("joinAddressParts — production duplication scenario", () => {
  // EXACT production data for the ASPIDUS DMCC tenant: the free-text
  // address_line already ends with "Dubai, UAE" while city/country fields
  // repeat it. The old naive concat rendered
  // "…, Dubai, UAE, Dubai, United Arab Emirates" in every PDF footer.
  it("does NOT append city/country already contained in the address line", () => {
    const out = joinAddressParts("GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE", {
      city: "Dubai",
      country: "AE",
    });
    expect(out).toBe("GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE");
  });

  it("aliases count: UAE covers United Arab Emirates and vice versa", () => {
    expect(
      joinAddressParts("IFZA Business Park, Building A2, Dubai Silicon Oasis, UAE", {
        city: "Dubai",
        country: "AE",
      }),
    ).toBe("IFZA Business Park, Building A2, Dubai Silicon Oasis, UAE");
    expect(
      joinAddressParts("1 Prime Street, United Arab Emirates", { city: "Abu Dhabi", country: "AE" }),
    ).toBe("1 Prime Street, United Arab Emirates, Abu Dhabi");
  });

  it("dotted country forms (U.A.E.) dedup too", () => {
    expect(joinAddressParts("Tower X, Dubai, U.A.E.", { city: "Dubai", country: "AE" })).toBe(
      "Tower X, Dubai, U.A.E.",
    );
  });

  it("appends city/country when genuinely missing", () => {
    expect(joinAddressParts("Saif Zone, Block C, Warehouse 12", { city: "Sharjah", country: "AE" })).toBe(
      "Saif Zone, Block C, Warehouse 12, Sharjah, United Arab Emirates",
    );
  });

  it("appends postal code when missing, dedups when present", () => {
    expect(joinAddressParts("Bole Road", { postal: "1000", city: "Addis Ababa", country: "ET" })).toBe(
      "Bole Road, 1000, Addis Ababa, Ethiopia",
    );
    expect(joinAddressParts("Bole Road, 1000", { postal: "1000", city: "Addis Ababa", country: "ET" })).toBe(
      "Bole Road, 1000, Addis Ababa, Ethiopia",
    );
  });

  it("country given as a full name passthrough + reverse alias dedup", () => {
    // Partner rows store country as a full name sometimes (e.g. "Argentina").
    expect(joinAddressParts("Av. Corrientes 1234, Buenos Aires, Argentina", { city: "Buenos Aires", country: "Argentina" })).toBe(
      "Av. Corrientes 1234, Buenos Aires, Argentina",
    );
    expect(joinAddressParts("Street 5", { city: "London", country: "United Kingdom" })).toBe(
      "Street 5, London, United Kingdom",
    );
    // "UK" in the line covers country "GB"
    expect(joinAddressParts("10 Downing Street, London, UK", { city: "London", country: "GB" })).toBe(
      "10 Downing Street, London, UK",
    );
    // "USA" in the line covers country "US"
    expect(joinAddressParts("1600 Penn Ave, Washington DC, USA", { city: "Washington", country: "US" })).toBe(
      "1600 Penn Ave, Washington DC, USA",
    );
  });

  it("empty inputs → empty string (footer renders nothing, not ', , ')", () => {
    expect(joinAddressParts(null, {})).toBe("");
    expect(joinAddressParts(undefined, { city: null, country: undefined })).toBe("");
  });

  it("city-only line still appends the country", () => {
    expect(joinAddressParts("Main Street", { city: "Dubai", country: "AE" })).toBe(
      "Main Street, Dubai, United Arab Emirates",
    );
  });

  it("word boundary — 'Dubai' in 'Dubai Silicon Oasis' dedups city 'Dubai'", () => {
    // Partner: address "IFZA Business Park, Building A2, Dubai Silicon
    // Oasis" + city "Dubai" — city must not be appended a second time.
    const out = joinAddressParts("IFZA Business Park, Building A2, Dubai Silicon Oasis", {
      city: "Dubai",
      country: "AE",
    });
    expect(out).toBe("IFZA Business Park, Building A2, Dubai Silicon Oasis, United Arab Emirates");
  });

  it("case-insensitive matching", () => {
    expect(joinAddressParts("dubai marina, uae", { city: "Dubai", country: "AE" })).toBe("dubai marina, uae");
  });
});

describe("remainingAddressParts — two-line party boxes", () => {
  it("returns '' when the address line covers everything (render NO second line)", () => {
    expect(
      remainingAddressParts("GoldCrest Executive Tower, 1002-A, JLT Cluster C, Dubai, UAE", {
        city: "Dubai",
        country: "AE",
      }),
    ).toBe("");
  });

  it("returns only the missing parts, joined with ', '", () => {
    expect(
      remainingAddressParts("IFZA Business Park, Building A2, Dubai Silicon Oasis", {
        city: "Dubai",
        country: "AE",
      }),
    ).toBe("United Arab Emirates");
    expect(remainingAddressParts("Bole Road", { postal: "1000", city: "Addis Ababa", country: "ET" })).toBe(
      "1000, Addis Ababa, Ethiopia",
    );
  });

  it("null-safe", () => {
    expect(remainingAddressParts(null, {})).toBe("");
    expect(remainingAddressParts(undefined, { city: "Dubai" })).toBe("Dubai");
  });
});

// ─── audit13: memorandum font mapping ───────────────────────────────────────

describe("mapFont — react-pdf exact names (memorandum settings UI values)", () => {
  // The settings UI saves the exact react-pdf names: "Helvetica",
  // "Times-Roman", "Courier". The old map only knew CSS stack names, so
  // "Times-Roman" silently fell back to Helvetica — the memorandum header
  // rendered in the wrong font for every tenant that picked Times.
  it("maps the three UI values correctly", () => {
    expect(mapFont("Times-Roman")).toBe("Times-Roman");
    // audit20: "Helvetica" (the memo UI's sans value) → registered Unicode family
    expect(mapFont("Helvetica")).toBe("NotoSans");
    expect(mapFont("Courier")).toBe("Courier");
  });

  it("still maps CSS stack names", () => {
    expect(mapFont("'Times New Roman', Times, serif")).toBe("Times-Roman");
    expect(mapFont("Inter, system-ui, sans-serif")).toBe("NotoSans");
    expect(mapFont("Arial")).toBe("NotoSans");
    expect(mapFont("monospace")).toBe("Courier");
  });

  it("unknown → fallback", () => {
    expect(mapFont("Comic Sans")).toBe("NotoSans");
    expect(mapFont(null, "Times-Roman")).toBe("Times-Roman");
    expect(mapFont(undefined)).toBe("NotoSans");
  });
});

describe("boldVariant — valid react-pdf bold families", () => {
  it("Times-Roman bolds to Times-Bold (NOT the invalid 'Times-Roman-Bold')", () => {
    expect(boldVariant("Times-Roman")).toBe("Times-Bold");
    expect(boldVariant("Times-Italic")).toBe("Times-BoldItalic");
  });
  it("Helvetica / Courier variants", () => {
    // audit20: the sans family is NotoSans now
    expect(boldVariant("Helvetica")).toBe("NotoSans-Bold");
    expect(boldVariant("Helvetica-Oblique")).toBe("NotoSans-BoldOblique");
    expect(boldVariant("Courier")).toBe("Courier-Bold");
    expect(boldVariant("Courier-Oblique")).toBe("Courier-BoldOblique");
  });
  it("already-bold passthrough + empty fallback", () => {
    expect(boldVariant("Helvetica-Bold")).toBe("Helvetica-Bold");
    expect(boldVariant("NotoSans-Bold")).toBe("NotoSans-Bold");
    expect(boldVariant("Times-Bold")).toBe("Times-Bold");
    expect(boldVariant("")).toBe("NotoSans-Bold");
  });
});
