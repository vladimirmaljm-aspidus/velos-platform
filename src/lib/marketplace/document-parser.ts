// Marketplace Phase 5 — OCR / VLM document parsing.
//
// Two entry points:
//
//   • parseCertificateOfAnalysis(imageBase64)
//       Extracts structured data from a Certificate of Analysis photo:
//       product name, batch number, issue date, and a list of
//       { name, value } parameter rows (e.g. "Purity: 99.8%").
//
//   • parseProductSpecSheet(imageBase64)
//       Extracts structured data from a product specification sheet:
//       product name, category, and a key/value specifications map.
//
// Both functions use the z-ai-web-dev-sdk vision model
// (zai.chat.completions.createVision) to analyse the supplied image and
// return STRICT JSON. The vision model is asked to emit a JSON document
// only; we then defensively parse the response — wrapping any thrown
// JSON.parse error and falling back to an empty structured shape so the
// API route can return a 200 with `parameters: []` rather than a 500.
//
// ENVIRONMENT REQUIREMENT
//   The SDK auto-loads `./.z-ai-config` or `~/.z-ai-config`. When that
//   file is missing, ZAI.create() throws. The parse functions catch that
//   and throw a `DocumentParserError` so the API route can map it onto a
//   503 ("AI service unavailable") response — the user sees a friendly
//   message instead of a stack trace.
//
// SECURITY NOTE
//   The image data is sent to the AI provider as a base64 data URL. The
//   caller (the API route) is responsible for verifying the file size
//   (≤5 MB) and the MIME type (image/png | image/jpeg | image/webp) BEFORE
//   calling these functions — see the upload-validate helper in
//   src/lib/upload/verify-file.ts. We never persist the raw image data;
//   the API route keeps the base64 in-memory only for the duration of the
//   VLM call.

import ZAI from "z-ai-web-dev-sdk";
import { getZaiClient } from "@/lib/ai/zai-client";

// ─── Public shapes ────────────────────────────────────────────────────────

export interface CoAParameter {
  name: string;
  value: string;
}

export interface CertificateOfAnalysis {
  parameters: CoAParameter[];
  product: string;
  batch: string;
  date: string;
}

export interface ProductSpecSheet {
  productName: string;
  specifications: Record<string, string>;
  category: string;
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
 * accepts either a bare base64 string or a data URL — both end up as the
 * raw base64 bytes fed into the vision model's image_url.url field.
 */
function stripDataUrlPrefix(s: string): string {
  const idx = s.indexOf(";base64,");
  if (idx >= 0 && s.startsWith("data:")) {
    return s.slice(idx + 8);
  }
  return s;
}

/**
 * Extract a JSON object from the vision model's free-text response.
 *
 * The model is instructed to return JSON only, but real-world VLM output
 * occasionally includes a leading `Here is the JSON:` sentence or wraps
 * the JSON in triple backticks. We:
 *   1. Try a plain JSON.parse on the trimmed text.
 *   2. Look for the first { or [ and last } or ] and try again on that
 *      substring.
 *   3. Strip triple-backtick code fences and retry.
 *
 * Returns null when no JSON object can be extracted.
 */
function extractJson(text: string): any | null {
  if (!text) return null;
  const trimmed = text.trim();

  // 1. Plain parse.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // 2. Strip triple-backtick code fences.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
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
 */
async function runVisionExtraction(
  imageBase64: string,
  instruction: string,
): Promise<any> {
  if (!imageBase64 || imageBase64.trim().length === 0) {
    throw new DocumentParserError("Image data is empty.");
  }

  // Reject obviously oversized payloads BEFORE invoking the VLM — the
  // vision model rejects >5MB images anyway, and rejecting here avoids
  // paying for a failed inference call.
  // 5 MB of base64 ≈ 6.67 MB binary → ~6.7e6 chars.
  if (imageBase64.length > 7_000_000) {
    throw new DocumentParserError(
      "Image is too large (must be ≤ 5 MB after base64 encoding).",
    );
  }

  const zai = await getZai();
  let raw: string;
  try {
    const result = await zai.chat.completions.createVision({
      // The SDK requires `model` on the vision body — `glm-4v` is the
      // default vision model exposed via the z-ai endpoint.
      model: "glm-4v",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: instruction,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${stripDataUrlPrefix(imageBase64)}`,
              },
            },
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
            .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
            .join("")
        : String(content ?? "");
  } catch (e: any) {
    throw new DocumentParserError(
      `AI vision call failed: ${e?.message || String(e)}`,
      e,
    );
  }

  const parsed = extractJson(raw);
  if (parsed === null) {
    throw new DocumentParserError(
      "AI vision response did not contain parseable JSON.",
    );
  }
  return parsed;
}

// ─── Public entry points ─────────────────────────────────────────────────

/**
 * Extract structured data from a Certificate of Analysis image.
 *
 * Returns a normalised shape (parameters[] + product + batch + date)
 * regardless of the exact key names the VLM picked. Missing fields
 * default to empty strings / empty arrays — the caller never crashes
 * on `undefined.field`.
 */
export async function parseCertificateOfAnalysis(
  imageBase64: string,
): Promise<CertificateOfAnalysis> {
  const instruction =
    "You are a B2B commodity trade compliance assistant. " +
    "Extract the structured data from this Certificate of Analysis image. " +
    "Return STRICT JSON only (no prose, no code fences) with these exact keys: " +
    '{"product": string, "batch": string, "date": string (ISO if possible), ' +
    '"parameters": Array<{ "name": string, "value": string }>} ' +
    "where `parameters` is the list of measured quality attributes (purity, " +
    "moisture, ash, foreign matter, etc.). Use the empty string for any " +
    "field you cannot read. Return ONLY the JSON.";

  const parsed = await runVisionExtraction(imageBase64, instruction);

  const parameters: CoAParameter[] = Array.isArray(parsed.parameters)
    ? parsed.parameters
        .map((p: any) => ({
          name: String(p?.name ?? p?.parameter ?? p?.test ?? "").trim(),
          value: String(p?.value ?? p?.result ?? p?.specification ?? "").trim(),
        }))
        .filter((p: CoAParameter) => p.name || p.value)
    : [];

  return {
    parameters,
    product: String(parsed.product ?? parsed.product_name ?? "").trim(),
    batch: String(parsed.batch ?? parsed.batch_number ?? parsed.lot ?? "").trim(),
    date: String(parsed.date ?? parsed.issue_date ?? parsed.issueDate ?? "").trim(),
  };
}

/**
 * Extract structured data from a product specification sheet image.
 *
 * Returns a normalised shape (productName + specifications{} + category)
 * regardless of the exact key names the VLM picked.
 */
export async function parseProductSpecSheet(
  imageBase64: string,
): Promise<ProductSpecSheet> {
  const instruction =
    "You are a B2B commodity trade catalogue assistant. " +
    "Extract the structured data from this product specification sheet image. " +
    "Return STRICT JSON only (no prose, no code fences) with these exact keys: " +
    '{"productName": string, "category": string (e.g. "Metals", "Agriculture", ' +
    '"Chemicals"), "specifications": Record<string, string>} where ' +
    "`specifications` maps each spec label to its value (e.g. " +
    '{ "Grade": "A", "Purity": "99.9%", "Origin": "Brazil" }). Use the empty ' +
    "string for any field you cannot read. Return ONLY the JSON.";

  const parsed = await runVisionExtraction(imageBase64, instruction);

  let specifications: Record<string, string> = {};
  const rawSpecs = parsed.specifications ?? parsed.specs ?? parsed.attributes ?? {};
  if (rawSpecs && typeof rawSpecs === "object" && !Array.isArray(rawSpecs)) {
    for (const [k, v] of Object.entries(rawSpecs)) {
      const key = String(k).trim();
      if (key) {
        specifications[key] = String(v ?? "").trim();
      }
    }
  } else if (Array.isArray(rawSpecs)) {
    // Some VLMs return specifications as an array of {label, value}.
    for (const item of rawSpecs) {
      const key = String(item?.label ?? item?.name ?? item?.key ?? "").trim();
      const value = String(item?.value ?? item?.val ?? "").trim();
      if (key) specifications[key] = value;
    }
  }

  return {
    productName: String(parsed.productName ?? parsed.product_name ?? parsed.product ?? "").trim(),
    specifications,
    category: String(parsed.category ?? parsed.product_category ?? "").trim(),
  };
}
