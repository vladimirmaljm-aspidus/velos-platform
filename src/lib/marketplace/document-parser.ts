// Marketplace Phase 5 — VLM document parsing.
//
// Two entry points:
//
//   • parseCertificateOfAnalysis(fileBase64, mimeType?)
//       Extracts structured data from a Certificate of Analysis (photo OR
//       PDF): product, batch/lot, manufacture + expiry dates, grade,
//       origin, certifications, storage, packaging, and a list of test
//       parameters (name, value, unit, spec/limit) plus a confidence
//       indicator (`high` | `medium` | `low`) and a list of fields the
//       model was uncertain about.
//
//   • parseProductSpecSheet(fileBase64, mimeType?)
//       Extracts structured data from a product specification sheet
//       (photo OR PDF): product name, SKU, HS code, category, brand,
//       physical + chemical properties, packaging, shelf life, storage,
//       origin, certifications, logistics (container capacity for
//       20ft/40ft), and applications — returned as a key/value
//       specifications map plus the same confidence metadata.
//
// Both functions use the z-ai-web-dev-sdk vision model
// (zai.chat.completions.createVision) to analyse the supplied file and
// return STRICT JSON. The vision model is asked to emit a JSON document
// only; we then defensively parse the response — stripping ```json
// fences, isolating the first {...} or [...] block, and finally falling
// back to an empty structured shape so the API route can return a 200
// with `parameters: []` rather than a 500.
//
// IMAGE vs PDF
//   The Z.AI vision API exposes two content blocks:
//     • `image_url` for raster images (png / jpeg / webp) — data URL
//       prefix `data:image/<ext>;base64,...`.
//     • `file_url` for documents (pdf / txt / docx / xlsx / pptx) —
//       data URL prefix `data:application/pdf;base64,...`.
//   The public functions take an explicit `mimeType` and dispatch on
//   it. When the MIME is omitted, the parser falls back to image/png
//   (the previous behaviour) so existing image callers keep working.
//
// ENVIRONMENT REQUIREMENT
//   The SDK auto-loads `./.z-ai-config` or `~/.z-ai-config`. On
//   serverless runtimes (Vercel) the shared `getZaiClient()` helper
//   falls back to ZAI_BASE_URL + ZAI_API_KEY env vars. The parse
//   functions catch any thrown error and rethrow a `DocumentParserError`
//   so the API route can map it onto a 503 ("AI service unavailable")
//   response — the user sees a friendly message instead of a stack trace.
//
// SECURITY NOTE
//   The file data is sent to the AI provider as a base64 data URL. The
//   caller (the API route) is responsible for verifying the file size
//   (≤5 MB images / ≤15 MB PDFs after base64 encoding) and the MIME
//   type BEFORE calling these functions — see the validation in
//   src/app/api/marketplace/parse-document/route.ts. We never persist
//   the raw file data; the API route keeps the base64 in-memory only
//   for the duration of the VLM call.

import ZAI from "z-ai-web-dev-sdk";
import { getZaiClient } from "@/lib/ai/zai-client";

// ─── Public shapes ────────────────────────────────────────────────────────

export type DocumentMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/jpg"
  | "image/webp"
  | "application/pdf";

/**
 * Coarser category — `image` (raster, sent as `image_url`) vs `document`
 * (PDF / Word, sent as `file_url`). Derived from the MIME type.
 */
export type DocumentKind = "image" | "document";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface CoAParameter {
  name: string;
  value: string;
  /** Unit of measurement (e.g. "%", "mg/kg", "°C"). Empty when N/A. */
  unit?: string;
  /** Spec / limit / acceptable range stated on the CoA. Empty when N/A. */
  spec?: string;
  /** Pass / Fail / Conforms when the CoA states it. Empty when N/A. */
  result?: string;
}

export interface CertificateOfAnalysis {
  parameters: CoAParameter[];
  product: string;
  batch: string;
  date: string;
  /** ISO date the product was manufactured. */
  manufactureDate?: string;
  /** ISO expiry / re-test date. */
  expiryDate?: string;
  /** Manufacturer / issuing lab name. */
  manufacturer?: string;
  /** Grade (e.g. "Food", "Pharma USP", "Industrial"). */
  grade?: string;
  /** Country / region of origin. */
  origin?: string;
  /** Certifications listed (ISO, Halal, Organic, Kosher, …). */
  certifications?: string[];
  /** Storage conditions. */
  storage?: string;
  /** Packaging description. */
  packaging?: string;
  /** VLM self-assessed confidence. */
  confidence?: ConfidenceLevel;
  /** Fields the model could not read with high certainty. */
  uncertainFields?: string[];
}

export interface ProductSpecSheet {
  productName: string;
  specifications: Record<string, string>;
  category: string;
  /** Optional convenience fields surfaced to the create-post form. */
  sku?: string;
  hsCode?: string;
  brand?: string;
  originCountry?: string;
  shelfLife?: string;
  storage?: string;
  certifications?: string[];
  /** Container capacity (e.g. "20ft: 24 MT; 40ft: 28 MT"). */
  containerCapacity?: string;
  applications?: string[];
  /** VLM self-assessed confidence. */
  confidence?: ConfidenceLevel;
  /** Fields the model could not read with high certainty. */
  uncertainFields?: string[];
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class DocumentParserError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "DocumentParserError";
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Strip a `data:<mime>;base64,` prefix from a string. The API route
 * accepts either a bare base64 string or a data URL — both end up as
 * the raw base64 bytes fed into the vision model's image_url.url /
 * file_url.url field.
 */
function stripDataUrlPrefix(s: string): string {
  const idx = s.indexOf(";base64,");
  if (idx >= 0 && s.startsWith("data:")) {
    return s.slice(idx + 8);
  }
  return s;
}

/**
 * Detect the MIME type from a data URL prefix. Returns null when the
 * string is bare base64 (no `data:` prefix).
 */
function detectMimeFromDataUrl(s: string): string | null {
  if (!s.startsWith("data:")) return null;
  const end = s.indexOf(";");
  if (end <= 5) return null;
  return s.slice(5, end).toLowerCase();
}

/**
 * Resolve the MIME type. Priority:
 *   1. Caller-supplied `mimeType` argument.
 *   2. Data URL prefix on the base64 string.
 *   3. Default `image/png` (preserves backward compatibility for
 *      callers that send bare base64 + no MIME).
 */
function resolveMime(
  base64: string,
  mimeType: DocumentMimeType | undefined,
): DocumentMimeType {
  if (mimeType) return mimeType;
  const detected = detectMimeFromDataUrl(base64);
  if (detected === "application/pdf") return "application/pdf";
  if (detected === "image/jpeg" || detected === "image/jpg") return "image/jpeg";
  if (detected === "image/webp") return "image/webp";
  return "image/png";
}

/**
 * Coarse category used to pick the right Z.AI content block.
 */
export function kindFromMime(mime: DocumentMimeType): DocumentKind {
  return mime === "application/pdf" ? "document" : "image";
}

/**
 * Build the data URL the vision API expects. PDFs use the `file_url`
 * content block with `data:application/pdf;base64,...`; images use
 * `image_url` with `data:image/<ext>;base64,...`.
 */
function buildVisionContentBlock(
  base64Raw: string,
  mime: DocumentMimeType,
):
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file_url"; file_url: { url: string } } {
  const clean = stripDataUrlPrefix(base64Raw);
  if (mime === "application/pdf") {
    return {
      type: "file_url",
      file_url: { url: `data:application/pdf;base64,${clean}` },
    };
  }
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${clean}` },
  };
}

/**
 * Extract a JSON object/array from the vision model's free-text
 * response. The model is instructed to return JSON only, but
 * real-world VLM output occasionally wraps it in prose or in
 * triple-backtick code fences. We try in order:
 *   1. Plain `JSON.parse` on the trimmed text.
 *   2. Strip triple-backtick ```json ... ``` fences and retry.
 *   3. Strip a leading/trailing wrapper line (e.g. "Here is the
 *      JSON:\n{...}") by isolating the first `{` or `[` to the
 *      matching last `}` or `]`.
 *
 * Returns null when no JSON object/array can be extracted.
 */
function extractJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();

  // 1. Plain parse.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // 2. Strip triple-backtick code fences (```json ... ``` or ``` ... ```).
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fall through */
    }
  }

  // 2b. Single opening fence with no closing fence — some models emit
  //     ```json\n{...} without the trailing ``` when the response is
  //     truncated mid-stream. Strip everything up to and including
  //     the opening fence, then try to parse the remainder.
  const openingFence = trimmed.match(/```(?:json)?\s*([\s\S]+)/i);
  if (openingFence) {
    try {
      return JSON.parse(openingFence[1].trim());
    } catch {
      /* fall through */
    }
  }

  // 3. Find the first { or [ and the matching last } or ].
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace >= 0) {
    const open = trimmed[firstBrace];
    const close = open === "{" ? "}" : "]";
    const lastClose = trimmed.lastIndexOf(close);
    if (lastClose > firstBrace) {
      const slice = trimmed.slice(firstBrace, lastClose + 1);
      try {
        return JSON.parse(slice);
      } catch {
        /* fall through */
      }
    }
  }

  return null;
}

/**
 * Lazily create the ZAI client. Wraps any thrown error in a
 * DocumentParserError so the caller's catch-all can map it onto a 503
 * without unwrapping the cause.
 *
 * The ZAI class has a private constructor — `new ZAI()` is not callable
 * from outside the SDK. The sanctioned factory is the static
 * `ZAI.create()` method, whose return type is `Promise<ZAI>`. We use
 * `Awaited<ReturnType<typeof ZAI.create>>` for the instance type so we
 * don't trip TS2344 on `InstanceType<typeof ZAI>` (which requires a
 * public constructor).
 */
async function getZai(): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  // Delegate to the shared client factory which tries the file-based
  // config first (local dev) and falls back to ZAI_BASE_URL + ZAI_API_KEY
  // env vars (Vercel/serverless).
  try {
    return await getZaiClient();
  } catch (e) {
    throw new DocumentParserError(
      "AI vision service is not configured — set ZAI_BASE_URL and ZAI_API_KEY env vars (or create a .z-ai-config file).",
      e,
    );
  }
}

/**
 * Run a single VLM extraction. Centralised so both public entry points
 * share the same retry-free, timeout-free call shape + the same error
 * wrapping.
 *
 * @param fileBase64 raw base64 OR a data URL (`data:<mime>;base64,...`)
 * @param mimeType  explicit MIME; auto-detected from the data URL when omitted
 * @param instruction the VLM prompt
 */
async function runVisionExtraction(
  fileBase64: string,
  mimeType: DocumentMimeType | undefined,
  instruction: string,
): Promise<Record<string, unknown>> {
  if (!fileBase64 || fileBase64.trim().length === 0) {
    throw new DocumentParserError("Document data is empty.");
  }

  const mime = resolveMime(fileBase64, mimeType);
  const kind = kindFromMime(mime);

  // Reject obviously oversized payloads BEFORE invoking the VLM — the
  // vision model rejects oversized inputs anyway, and rejecting here
  // avoids paying for a failed inference call. Caps are per-kind to
  // match the API route's validation:
  //   • images: 5 MB binary ≈ 6.67 MB base64 → 7_000_000 chars
  //   • PDFs:    15 MB binary ≈ 20 MB base64   → 21_000_000 chars
  const maxChars = kind === "document" ? 21_000_000 : 7_000_000;
  const cleanLen = stripDataUrlPrefix(fileBase64).length;
  if (cleanLen > maxChars) {
    throw new DocumentParserError(
      kind === "document"
        ? "PDF is too large (must be ≤ 15 MB after base64 encoding)."
        : "Image is too large (must be ≤ 5 MB after base64 encoding).",
    );
  }

  const zai = await getZai();
  let raw: string;
  try {
    const result = await zai.chat.completions.createVision({
      // The SDK requires `model` on the vision body — `glm-4v` is the
      // default GLM vision model exposed via the z-ai endpoint. Verified
      // against the live API (smoke-tested during AI-1).
      model: "glm-4v",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: instruction,
            },
            buildVisionContentBlock(fileBase64, mime),
          ],
        },
      ],
    });
    // The SDK returns the OpenAI-style shape: choices[0].message.content
    // can be either a string OR an array of content blocks. We coerce
    // both into a flat string for the JSON extractor.
    const content =
      result?.choices?.[0]?.message?.content ??
      result?.choices?.[0]?.delta?.content ??
      result?.content ??
      "";
    raw = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c: unknown) =>
              typeof c === "string" ? c : String((c as { text?: string })?.text ?? ""),
            )
            .join("")
        : String(content ?? "");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DocumentParserError(`AI vision call failed: ${msg}`, e);
  }

  const parsed = extractJson(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new DocumentParserError(
      "AI vision response did not contain parseable JSON.",
    );
  }
  return parsed as Record<string, unknown>;
}

// ─── Prompt strings ───────────────────────────────────────────────────────
//
// Centralised so they're easy to audit + so both photo + PDF callers
// share the exact same instructions.

const STRICT_JSON_PREAMBLE =
  "You are a B2B commodity-trade compliance assistant. " +
  "Read the supplied Certificate of Analysis / product spec sheet and " +
  "extract structured data with high precision. " +
  "Return STRICT JSON ONLY — no prose, no markdown, no ``` fences. " +
  "Use the empty string for any field you cannot read; do NOT invent values. " +
  "After the JSON, do not add any commentary. ";

const CONFIDENCE_INSTRUCTION =
  'Include a "confidence" field set to "high", "medium", or "low" reflecting ' +
  'how legible the document was overall. Include an "uncertain_fields" array ' +
  "listing the names of any field you could not read with high confidence " +
  "(empty array when everything was legible).";

const COA_INSTRUCTION =
  STRICT_JSON_PREAMBLE +
  "Extract from the Certificate of Analysis the following fields, " +
  "using the exact JSON keys shown: " +
  '{\n' +
  '  "product":            string,                // product / material name\n' +
  '  "batch":              string,                // batch / lot number\n' +
  '  "date":               string,                // issue date (ISO YYYY-MM-DD when possible)\n' +
  '  "manufactureDate":    string,                // mfg date (ISO when possible)\n' +
  '  "expiryDate":         string,                // expiry / re-test date (ISO when possible)\n' +
  '  "manufacturer":       string,                // manufacturer / issuing lab\n' +
  '  "grade":              string,                // grade (Food / Pharma USP / Industrial / …)\n' +
  '  "origin":             string,                // country / region of origin\n' +
  '  "certifications":     string[],               // ISO / Halal / Organic / Kosher / … (empty array when none)\n' +
  '  "storage":            string,                // storage conditions\n' +
  '  "packaging":          string,                // packaging description\n' +
  '  "parameters": [\n' +
  '    {\n' +
  '      "name":   string,                         // test name (e.g. "Purity", "Moisture", "Ash", "Heavy Metals Pb")\n' +
  '      "value":  string,                         // measured value as printed\n' +
  '      "unit":   string,                         // unit (e.g. "%", "mg/kg", "°C"); "" when N/A\n' +
  '      "spec":   string,                         // specification / limit (e.g. "≥ 99.5%", "≤ 0.1%")\n' +
  '      "result": string                          // "Pass" / "Fail" / "Conforms" / ""\n' +
  '    }\n' +
  '  ],\n' +
  '  "confidence":        "high" | "medium" | "low",\n' +
  '  "uncertain_fields":  string[]\n' +
  "}\n" +
  "Use the empty string for any scalar you cannot read; use the empty array " +
  "for arrays you cannot read. Return ONLY the JSON.";

const SPEC_SHEET_INSTRUCTION =
  STRICT_JSON_PREAMBLE +
  "Extract from the product specification sheet the following fields, " +
  "using the exact JSON keys shown: " +
  '{\n' +
  '  "productName":        string,                  // canonical product name\n' +
  '  "sku":                string,                  // SKU / item code\n' +
  '  "hsCode":             string,                  // HS / customs code\n' +
  '  "category":           string,                  // "Metals" | "Agriculture" | "Chemicals" | "Energy" | "Food" | …\n' +
  '  "brand":              string,\n' +
  '  "originCountry":      string,                  // country of origin\n' +
  '  "shelfLife":          string,                  // shelf life (e.g. "24 months")\n' +
  '  "storage":            string,                  // storage conditions\n' +
  '  "packaging":          string,                  // packaging type + size + weight\n' +
  '  "containerCapacity":  string,                  // loadable quantity per 20ft / 40ft container (e.g. "20ft: 24 MT; 40ft: 28 MT")\n' +
  '  "certifications":     string[],                // ISO / Halal / Organic / … (empty array when none)\n' +
  '  "applications":       string[],                // common applications / uses\n' +
  '  "specifications": {\n' +
  '    // map of EVERY physical + chemical spec label to its value as printed\n' +
  '    // — at minimum: Appearance, Color, Odor, Density, Moisture, Purity,\n' +
  '    //   Active Ingredient, pH, Solubility, Particle Size, Viscosity.\n' +
  '    // Use the spec label from the document as the key.\n' +
  '    "Appearance": "white crystalline powder",\n' +
  '    "Purity":     "99.9%",\n' +
  '    "pH":         "6.5 – 7.5",\n' +
  '    "...": "..."\n' +
  '  },\n' +
  '  "confidence":        "high" | "medium" | "low",\n' +
  '  "uncertain_fields":  string[]\n' +
  "}\n" +
  "Use the empty string for any scalar you cannot read; use the empty array " +
  "for arrays you cannot read. Return ONLY the JSON.";

// ─── Public entry points ─────────────────────────────────────────────────

/**
 * Coerce a value into a string, returning "" for null/undefined.
 */
function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Coerce a value into a string array, returning [] for null/undefined.
 * Accepts either an array (of strings / objects with a `.name`) or a
 * comma-separated string.
 */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((item) => asString(typeof item === "string" ? item : (item as { name?: unknown })?.name ?? item))
      .filter((s) => s.length > 0);
  }
  if (typeof v === "string" && v.trim().length > 0) {
    return v
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Coerce a `confidence` value into the canonical 3-value union.
 * Defaults to undefined when the model omitted the field.
 */
function asConfidence(v: unknown): ConfidenceLevel | undefined {
  const s = asString(v).toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return undefined;
}

/**
 * Extract structured data from a Certificate of Analysis (image or PDF).
 *
 * Returns a normalised shape (parameters[] + product + batch + date +
 * optional compliance metadata + confidence metadata) regardless of
 * the exact key names the VLM picked. Missing fields default to empty
 * strings / empty arrays — the caller never crashes on
 * `undefined.field`.
 */
export async function parseCertificateOfAnalysis(
  fileBase64: string,
  mimeType?: DocumentMimeType,
): Promise<CertificateOfAnalysis> {
  const parsed = await runVisionExtraction(
    fileBase64,
    mimeType,
    COA_INSTRUCTION,
  );

  const parameters: CoAParameter[] = Array.isArray(parsed.parameters)
    ? (parsed.parameters as unknown[])
        .map((p: unknown) => {
          const obj = (p ?? {}) as Record<string, unknown>;
          return {
            name: asString(obj.name ?? obj.parameter ?? obj.test),
            value: asString(obj.value ?? obj.result ?? obj.specification),
            unit: asString(obj.unit) || undefined,
            spec: asString(obj.spec ?? obj.limit ?? obj.specification) || undefined,
            result: asString(obj.result ?? obj.pass_fail) || undefined,
          };
        })
        .filter((p: CoAParameter) => p.name || p.value)
    : [];

  return {
    parameters,
    product: asString(parsed.product ?? parsed.product_name),
    batch: asString(parsed.batch ?? parsed.batch_number ?? parsed.lot ?? parsed.lot_number),
    date: asString(parsed.date ?? parsed.issue_date ?? parsed.issueDate),
    manufactureDate: asString(parsed.manufactureDate ?? parsed.manufacture_date ?? parsed.mfg_date) || undefined,
    expiryDate: asString(parsed.expiryDate ?? parsed.expiry_date ?? parsed.expiration_date) || undefined,
    manufacturer: asString(parsed.manufacturer ?? parsed.issuer ?? parsed.lab) || undefined,
    grade: asString(parsed.grade) || undefined,
    origin: asString(parsed.origin ?? parsed.country ?? parsed.country_of_origin) || undefined,
    certifications: asStringArray(parsed.certifications ?? parsed.certs),
    storage: asString(parsed.storage ?? parsed.storage_conditions) || undefined,
    packaging: asString(parsed.packaging) || undefined,
    confidence: asConfidence(parsed.confidence),
    uncertainFields: asStringArray(parsed.uncertain_fields ?? parsed.uncertainFields),
  };
}

/**
 * Extract structured data from a product specification sheet (image or
 * PDF). Returns a normalised shape (productName + specifications{} +
 * category + optional trade metadata + confidence metadata) regardless
 * of the exact key names the VLM picked.
 */
export async function parseProductSpecSheet(
  fileBase64: string,
  mimeType?: DocumentMimeType,
): Promise<ProductSpecSheet> {
  const parsed = await runVisionExtraction(
    fileBase64,
    mimeType,
    SPEC_SHEET_INSTRUCTION,
  );

  let specifications: Record<string, string> = {};
  const rawSpecs =
    parsed.specifications ?? parsed.specs ?? parsed.attributes ?? {};
  if (rawSpecs && typeof rawSpecs === "object" && !Array.isArray(rawSpecs)) {
    for (const [k, v] of Object.entries(rawSpecs as Record<string, unknown>)) {
      const key = String(k).trim();
      if (key) {
        specifications[key] = asString(v);
      }
    }
  } else if (Array.isArray(rawSpecs)) {
    // Some VLMs return specifications as an array of {label, value}.
    for (const item of rawSpecs as unknown[]) {
      const obj = (item ?? {}) as Record<string, unknown>;
      const key = asString(obj.label ?? obj.name ?? obj.key);
      const value = asString(obj.value ?? obj.val);
      if (key) specifications[key] = value;
    }
  }

  return {
    productName: asString(parsed.productName ?? parsed.product_name ?? parsed.product),
    specifications,
    category: asString(parsed.category ?? parsed.product_category),
    sku: asString(parsed.sku ?? parsed.sku_code) || undefined,
    hsCode: asString(parsed.hsCode ?? parsed.hs_code ?? parsed.harmonized_code) || undefined,
    brand: asString(parsed.brand) || undefined,
    originCountry: asString(parsed.originCountry ?? parsed.origin_country ?? parsed.country) || undefined,
    shelfLife: asString(parsed.shelfLife ?? parsed.shelf_life) || undefined,
    storage: asString(parsed.storage ?? parsed.storage_conditions) || undefined,
    certifications: asStringArray(parsed.certifications ?? parsed.certs),
    containerCapacity: asString(parsed.containerCapacity ?? parsed.container_capacity) || undefined,
    applications: asStringArray(parsed.applications ?? parsed.uses),
    confidence: asConfidence(parsed.confidence),
    uncertainFields: asStringArray(parsed.uncertain_fields ?? parsed.uncertainFields),
  };
}
