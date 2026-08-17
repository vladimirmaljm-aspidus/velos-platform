import { describe, it, expect } from "vitest";
import { toCSV, parseCSV, csvResponse, parseExportParams } from "@/lib/export/csv";
import { NextRequest } from "next/server";

// ── toCSV ──────────────────────────────────────────────────────────────────

describe("csv-utils — toCSV", () => {
  it("serialises simple flat rows with a header", () => {
    const rows = [
      { id: 1, name: "Alice", age: 30 },
      { id: 2, name: "Bob", age: 25 },
    ];
    const csv = toCSV(rows);
    expect(csv).toBe("id,name,age\n1,Alice,30\n2,Bob,25");
  });

  it("uses an explicit `columns` order when provided", () => {
    const rows = [{ id: 1, name: "Alice", age: 30 }];
    const csv = toCSV(rows, ["name", "id"]);
    expect(csv).toBe("name,id\nAlice,1");
  });

  it("returns the empty string for an empty rows array", () => {
    expect(toCSV([])).toBe("");
  });

  it("quotes values that contain a comma", () => {
    const rows = [{ id: 1, name: "Smith, John", age: 30 }];
    const csv = toCSV(rows);
    expect(csv).toContain('"Smith, John"');
    expect(csv).toBe('id,name,age\n1,"Smith, John",30');
  });

  it("quotes values that contain a double-quote (and escapes the quote by doubling it)", () => {
    // RFC 4180 §2.7: a quote inside a quoted field is escaped by prepending
    // another quote (so `"` becomes `""`).
    const rows = [{ id: 1, note: 'She said "hi"' }];
    const csv = toCSV(rows);
    expect(csv).toContain('"She said ""hi"""');
    expect(csv).toBe('id,note\n1,"She said ""hi"""');
  });

  it("quotes values that contain a newline", () => {
    const rows = [{ id: 1, description: "line1\nline2" }];
    const csv = toCSV(rows);
    expect(csv).toContain('"line1\nline2"');
  });

  it("quotes values that contain a carriage return", () => {
    const rows = [{ id: 1, description: "line1\rline2" }];
    const csv = toCSV(rows);
    expect(csv).toContain('"line1\rline2"');
  });

  it("serialises null and undefined as empty strings (no quotes)", () => {
    const rows = [{ id: 1, name: null as string | null, age: undefined as number | undefined }];
    const csv = toCSV(rows);
    // Both null and undefined → empty field between commas.
    expect(csv).toBe("id,name,age\n1,,");
  });

  it("serialises booleans as 'true' / 'false'", () => {
    const rows = [{ id: 1, active: true, archived: false }];
    const csv = toCSV(rows);
    expect(csv).toBe("id,active,archived\n1,true,false");
  });

  it("serialises numbers verbatim (integers + floats)", () => {
    const rows = [{ id: 1, qty: 42, price: 19.99 }];
    expect(toCSV(rows)).toBe("id,qty,price\n1,42,19.99");
  });

  it("serialises object values as JSON (with quoting when they contain commas)", () => {
    const rows = [{ id: 1, meta: { a: 1, b: 2 } }];
    const csv = toCSV(rows);
    // JSON.stringify({"a":1,"b":2}) → {"a":1,"b":2} — contains commas + quotes
    // → must be wrapped + the inner quotes doubled.
    expect(csv).toBe('id,meta\n1,"{""a"":1,""b"":2}"');
  });

  it("serialises arrays as JSON", () => {
    const rows = [{ id: 1, tags: ["a", "b", "c"] }];
    const csv = toCSV(rows);
    // ["a","b","c"] contains commas + quotes → wrapped + escaped.
    expect(csv).toBe('id,tags\n1,"[""a"",""b"",""c""]"');
  });

  it("escapes a value containing both commas AND quotes simultaneously", () => {
    const rows = [{ id: 1, note: 'Hello, "World"' }];
    const csv = toCSV(rows);
    expect(csv).toBe('id,note\n1,"Hello, ""World"""');
  });
});

// ── parseCSV ───────────────────────────────────────────────────────────────

describe("csv-utils — parseCSV", () => {
  it("parses a simple header + rows CSV", () => {
    const csv = "id,name,age\n1,Alice,30\n2,Bob,25";
    const rows = parseCSV(csv);
    expect(rows).toEqual([
      { id: "1", name: "Alice", age: "30" },
      { id: "2", name: "Bob", age: "25" },
    ]);
  });

  it("returns [] for an empty string", () => {
    expect(parseCSV("")).toEqual([]);
  });

  it("returns [] for a header-only CSV (no data rows)", () => {
    expect(parseCSV("id,name\n")).toEqual([]);
  });

  it("unquotes values that were wrapped because of a comma", () => {
    const csv = 'id,name\n1,"Smith, John"';
    const rows = parseCSV(csv);
    expect(rows[0].name).toBe("Smith, John");
  });

  it("un-escapes doubled quotes inside a quoted field (RFC 4180 §2.7)", () => {
    const csv = 'id,note\n1,"She said ""hi"""';
    const rows = parseCSV(csv);
    expect(rows[0].note).toBe('She said "hi"');
  });

  it("treats a newline inside a quoted field as part of the value, NOT a row terminator", () => {
    const csv = 'id,description\n1,"line1\nline2"\n2,single';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toBe("line1\nline2");
    expect(rows[1].description).toBe("single");
  });

  it("strips a UTF-8 BOM if present (Excel exports often prepend one)", () => {
    const csvWithBom = "\uFEFFid,name\n1,Alice";
    const rows = parseCSV(csvWithBom);
    expect(rows[0]).toEqual({ id: "1", name: "Alice" });
    // BOM must NOT leak into the first header cell.
    expect(Object.keys(rows[0])[0]).toBe("id");
  });

  it("normalises \\r\\n and \\r line endings to \\n", () => {
    const csvCRLF = "id,name\r\n1,Alice\r\n2,Bob";
    const csvCR = "id,name\r1,Alice\r2,Bob";
    expect(parseCSV(csvCRLF)).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]);
    expect(parseCSV(csvCR)).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]);
  });

  it("skips empty body lines (trailing newline doesn't create a phantom row)", () => {
    const csv = "id,name\n1,Alice\n";
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
  });

  it("handles rows with fewer columns than the header (missing → empty string)", () => {
    const csv = "id,name,age\n1,Alice";
    const rows = parseCSV(csv);
    expect(rows[0]).toEqual({ id: "1", name: "Alice", age: "" });
  });

  it("handles rows with more columns than the header (extras are dropped)", () => {
    const csv = "id,name\n1,Alice,30,extra";
    const rows = parseCSV(csv);
    expect(rows[0]).toEqual({ id: "1", name: "Alice" });
  });
});

// ── Round-trip: toCSV → parseCSV ──────────────────────────────────────────

describe("csv-utils — toCSV / parseCSV round-trip", () => {
  it("round-trips simple flat data", () => {
    const original = [
      { id: 1, name: "Alice", email: "alice@example.com" },
      { id: 2, name: "Bob", email: "bob@example.com" },
      { id: 3, name: "Carol", email: "carol@example.com" },
    ];
    const csv = toCSV(original);
    const parsed = parseCSV(csv);
    // parseCSV returns string values; compare against the stringified originals.
    expect(parsed).toEqual(original.map((r) => ({
      id: String(r.id),
      name: r.name,
      email: r.email,
    })));
  });

  it("round-trips values that contain commas (quoted on export, unquoted on import)", () => {
    const original = [
      { id: 1, name: "Smith, John", city: "New York" },
      { id: 2, name: "Doe, Jane", city: "London" },
    ];
    const csv = toCSV(original);
    const parsed = parseCSV(csv);
    expect(parsed[0].name).toBe("Smith, John");
    expect(parsed[1].name).toBe("Doe, Jane");
  });

  it("round-trips values that contain double-quotes", () => {
    const original = [
      { id: 1, note: 'She said "hi"' },
      { id: 2, note: 'He replied "bye"' },
    ];
    const csv = toCSV(original);
    const parsed = parseCSV(csv);
    expect(parsed[0].note).toBe('She said "hi"');
    expect(parsed[1].note).toBe('He replied "bye"');
  });

  it("round-trips empty / null values (no quoting either direction)", () => {
    const original = [
      { id: 1, name: "Alice", middle: null as string | null, age: 30 },
      { id: 2, name: "", middle: "M", age: null as number | null },
    ];
    const csv = toCSV(original);
    const parsed = parseCSV(csv);
    expect(parsed[0]).toEqual({ id: "1", name: "Alice", middle: "", age: "30" });
    expect(parsed[1]).toEqual({ id: "2", name: "", middle: "M", age: "" });
  });

  it("round-trips a multi-line value (newline inside a quoted field)", () => {
    const original = [{ id: 1, description: "line1\nline2\nline3" }];
    const csv = toCSV(original);
    const parsed = parseCSV(csv);
    expect(parsed[0].description).toBe("line1\nline2\nline3");
  });

  it("round-trips a realistic product export", () => {
    const original = [
      { sku: "WIDGET-001", name: "Steel Widget", price: 19.99, currency: "USD", active: true },
      { sku: "GADGET-002", name: 'Brass Gadget, "Pro"', price: 29.5, currency: "EUR", active: false },
      { sku: "GIZMO-003", name: "Copper Gizmo\n(multi-line description)", price: 5, currency: "GBP", active: true },
    ];
    const csv = toCSV(original);
    const parsed = parseCSV(csv);
    expect(parsed.map((r) => r.sku)).toEqual(["WIDGET-001", "GADGET-002", "GIZMO-003"]);
    expect(parsed[1].name).toBe('Brass Gadget, "Pro"');
    expect(parsed[2].name).toBe("Copper Gizmo\n(multi-line description)");
    expect(parsed[0].price).toBe("19.99");
    expect(parsed[0].active).toBe("true");
  });
});

// ── csvResponse ────────────────────────────────────────────────────────────

describe("csv-utils — csvResponse", () => {
  it("sets Content-Type, Content-Disposition, and Content-Length headers", async () => {
    const res = csvResponse("offers.csv", "id,name\n1,Alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="offers.csv"');
    // Content-Length is the UTF-8 byte count, not the string length — important
    // when the CSV contains multibyte characters.
    expect(res.headers.get("Content-Length")).toBe(String(Buffer.byteLength("id,name\n1,Alice", "utf-8")));
    expect(await res.text()).toBe("id,name\n1,Alice");
  });

  it("Content-Length reflects UTF-8 byte count, not JS string length", async () => {
    // "é" is 2 bytes in UTF-8 but 1 char in JS.
    const csv = "id,name\n1,Café";
    const res = csvResponse("test.csv", csv);
    expect(res.headers.get("Content-Length")).toBe(String(Buffer.byteLength(csv, "utf-8")));
    expect(Number(res.headers.get("Content-Length"))).toBe(csv.length + 1);
  });
});

// ── parseExportParams ──────────────────────────────────────────────────────

describe("csv-utils — parseExportParams", () => {
  function req(url: string) {
    return new NextRequest(new Request(url));
  }

  it("returns columns=null + format=csv when no params are provided", () => {
    const { columns, format } = parseExportParams(req("http://localhost/api/export"));
    expect(columns).toBeNull();
    expect(format).toBe("csv");
  });

  it("parses a comma-separated columns list", () => {
    const { columns } = parseExportParams(req("http://localhost/api/export?columns=id,name,email"));
    expect(columns).toEqual(["id", "name", "email"]);
  });

  it("trims whitespace and drops empty column entries", () => {
    const { columns } = parseExportParams(req("http://localhost/api/export?columns=id,%20,name,%20"));
    expect(columns).toEqual(["id", "name"]);
  });

  it("honours an explicit format=xlsx param", () => {
    const { format } = parseExportParams(req("http://localhost/api/export?format=xlsx"));
    expect(format).toBe("xlsx");
  });
});
