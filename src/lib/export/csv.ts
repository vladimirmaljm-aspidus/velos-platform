import { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Generic CSV export helper.
 * Converts an array of objects into a CSV string with proper escaping.
 */
export function toCSV(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns || Object.keys(rows[0]);

  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const s = typeof val === "object" ? JSON.stringify(val) : String(val);
    // Escape quotes by doubling, wrap in quotes if contains comma/quote/newline
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = cols.map(escape).join(",");
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(",")).join("\n");
  return `${header}\n${body}`;
}

/**
 * Send a CSV download response with proper headers.
 */
export function csvResponse(filename: string, csv: string): NextResponse {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": Buffer.byteLength(csv, "utf-8").toString(),
    },
  });
}

/**
 * Parse export query params — which columns to include, format.
 */
export function parseExportParams(req: NextRequest): {
  columns: string[] | null;
  format: "csv" | "xlsx";
} {
  const url = new URL(req.url);
  const colsParam = url.searchParams.get("columns");
  const columns = colsParam ? colsParam.split(",").map((c) => c.trim()).filter(Boolean) : null;
  const format = (url.searchParams.get("format") as "csv" | "xlsx") || "csv";
  return { columns, format };
}

/**
 * Parse a CSV string back into an array of row objects keyed by the header
 * row. Mirrors the semantics of the private parser in `/api/import`:
 *  - Strips a leading UTF-8 BOM if present (Excel exports often prepend one).
 *  - Normalises `\r\n` / `\r` line endings to `\n`.
 *  - A newline inside a quoted field does NOT end the record (RFC 4180 §2.6).
 *  - Empty body lines are skipped.
 *  - Doubled quotes inside a quoted field decode to a literal quote.
 *
 * Exported primarily for test symmetry with `toCSV` (round-trip), and to give
 * the rest of the codebase a single canonical CSV parser if other import
 * surfaces ever need it.
 */
export function parseCSV(csv: string): Record<string, string>[] {
  if (!csv) return [];
  // Strip BOM if present (Excel exports often start with one).
  const cleaned = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  // Normalise line endings — handle \r\n and \r.
  const normalised = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = splitCSVLines(normalised);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, ""));
  if (headers.length === 0) return [];

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = values[j] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Split a CSV document into logical lines. Handles quoted newlines — a
 * newline inside a quoted field does NOT end the record.
 */
function splitCSVLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      // Doubled quote inside a quoted field = literal quote, not a closer.
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
    } else if (char === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
