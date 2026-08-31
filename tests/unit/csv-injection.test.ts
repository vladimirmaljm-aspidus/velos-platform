import { describe, it, expect } from "vitest";
// 11-A-v2 / FIX-AUDIT2-CRIT / C3: pure-logic tests for `toCSV`'s CSV-
// injection neutralisation. The source (locked by prior agents)
// prepends a single-quote `'` to any cell that starts with one of the
// formula-trigger chars `= + - @ \t \r` — Excel / Sheets / LibreOffice
// treat a leading single-quote as "this cell is text, not a formula",
// so the trigger is no longer interpreted as a formula on import.
//
// These tests assert the neutralising prefix is present for each
// trigger character and absent for normal values.
import { toCSV } from "@/lib/export/csv";

describe("csv-injection — toCSV formula-neutralisation", () => {
  // ── `=` trigger (HYPERLINK) ───────────────────────────────────────────
  it("neutralises a cell starting with `=` (HYPERLINK formula)", () => {
    // A partner setting `name="=HYPERLINK(\"https://evil\")"` could
    // otherwise execute the HYPERLINK formula in an admin's spreadsheet
    // when they exported the partners CSV and double-clicked the cell.
    const csv = toCSV([{ name: '=HYPERLINK("https://evil")' }]);
    // The single-quote prefix `'` must appear immediately before the
    // original `=` trigger — that's the neutralising escape.
    expect(csv).toContain("'=");
    // The raw trigger must NOT appear at position 0 of the cell (i.e.
    // right after the `\n` row separator). The cell starts with `"'=`
    // (wrap-quote, single-quote prefix, `=` trigger) — the wrap-quote
    // for the embedded `"` is at pos 0, the single-quote prefix at pos 1.
    expect(csv).not.toMatch(/\n=HYPERLINK/);
  });

  // ── `+` trigger (SUM formula) ─────────────────────────────────────────
  it("neutralises a cell starting with `+` (SUM formula)", () => {
    const csv = toCSV([{ name: "+SUM(A1:A2)" }]);
    // The single-quote prefix must precede the `+` trigger.
    expect(csv).toContain("'+SUM");
    // The raw trigger must NOT appear at position 0 of the cell.
    expect(csv).not.toMatch(/\n\+SUM/);
  });

  // ── `-` trigger (arithmetic) ──────────────────────────────────────────
  it("neutralises a cell starting with `-` (arithmetic expression)", () => {
    const csv = toCSV([{ name: "-1+1" }]);
    // The single-quote prefix must precede the `-` trigger. The cell
    // here is short, no quote/comma/newline → no wrap, so the cell is
    // bare: `'-1+1`.
    expect(csv).toContain("'-1");
    expect(csv).not.toMatch(/\n-1/);
  });

  // ── `@` trigger (SUM formula) ──────────────────────────────────────────
  it("neutralises a cell starting with `@` (SUM formula)", () => {
    const csv = toCSV([{ name: "@SUM(A1)" }]);
    expect(csv).toContain("'@SUM");
    expect(csv).not.toMatch(/\n@SUM/);
  });

  // ── `\t` trigger (TAB-prefixed CMD pipe) ───────────────────────────────
  it("neutralises a cell starting with TAB (CMD pipe)", () => {
    // A leading `\t` is interpreted by some spreadsheet apps as a
    // formula trigger (the formula bar strips leading whitespace and
    // then sees the trigger). The single-quote prefix prevents that
    // interpretation. The source does NOT strip the tab — it prefixes
    // the cell with `'`, and the wrap regex `/[",\n\r]/` does NOT
    // match `\t`, so the cell is emitted bare: `'\tCMD|calc.exe`.
    const csv = toCSV([{ name: "\tCMD|calc.exe" }]);
    // The cell value starts with `'` (single-quote prefix), so the
    // original `\t` is no longer at position 0.
    expect(csv.startsWith("name\n'")).toBe(true);
    // The original raw `\tCMD` must NOT appear at the start of the cell
    // (i.e., right after the `\n` row separator). Instead, `'` appears.
    expect(csv).not.toMatch(/\n\tCMD/);
  });

  // ── normal value — no prefix added ────────────────────────────────────
  it("does NOT prefix a normal value", () => {
    // A normal value must NOT receive the single-quote prefix — that
    // would corrupt legitimate data (e.g., a partner literally named
    // "Alice" should round-trip as "Alice", not "'Alice").
    const csv = toCSV([{ name: "normal value" }]);
    expect(csv).toBe("name\nnormal value");
    // No `'` appears anywhere in the cell value.
    expect(csv).not.toContain("'normal");
    expect(csv).not.toContain("value'");
  });
});
