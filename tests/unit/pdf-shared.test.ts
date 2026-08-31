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
  tradeWatermarkText,
  marketplaceWatermarkText,
  logisticsWatermarkText,
} from "@/lib/pdf/shared";

// 13-A: unit tests for the shared PDF helper module (audit12 dedup).
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
  it("maps CSS font stacks to PDF-safe families", () => {
    expect(mapFont("Inter, system-ui, sans-serif")).toBe("Helvetica");
    expect(mapFont("times")).toBe("Times-Roman");
    expect(mapFont("times-new-roman")).toBe("Times-Roman");
    expect(mapFont("courier")).toBe("Courier");
  });
  it("falls back for unknown/missing fonts", () => {
    expect(mapFont(null)).toBe("Helvetica");
    expect(mapFont("Comic Sans")).toBe("Helvetica");
    expect(mapFont(undefined, "Times-Roman")).toBe("Times-Roman");
  });
});

describe("boldVariant", () => {
  it("appends -Bold to plain families", () => {
    expect(boldVariant("Helvetica")).toBe("Helvetica-Bold");
    expect(boldVariant("Times-Roman")).toBe("Times-Roman-Bold");
  });
  it("leaves already-bold/italic families untouched", () => {
    expect(boldVariant("Helvetica-Bold")).toBe("Helvetica-Bold");
    expect(boldVariant("Helvetica-Italic")).toBe("Helvetica-Italic");
    // -Oblique is NOT detected as a styled variant — it gets -Bold appended
    expect(boldVariant("Helvetica-Oblique")).toBe("Helvetica-Oblique-Bold");
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
