import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  parseCertificateOfAnalysis,
  parseProductSpecSheet,
  DocumentParserError,
  type CertificateOfAnalysis,
  type ProductSpecSheet,
  type DocumentMimeType,
} from "@/lib/marketplace/document-parser";
import { withApm } from "@/lib/monitoring/apm";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

// Vercel function timeout — the vision model can take 30-70s for PDFs.
// Default Hobby limit is 10s; this raises it to 60s (the Hobby max).
// Pro plan supports up to 300s. Text-based PDFs use the fast chat path
// (<10s) so they finish well within this limit.
export const maxDuration = 60;

// ─── Size caps ────────────────────────────────────────────────────────────
//
// Base64 expands binary by ~33%, so the cap on the encoded string is
// ~1.34× the binary cap. We add a small JSON-envelope headroom on top.
//
//   • Images: 5 MB binary   → 5 * 1024 * 1024 * 1.34 ≈ 7,025,627 → cap 7,000,000 chars
//   • PDFs:    8 MB binary  → 8 * 1024 * 1024 * 1.34 ≈ 11,241,006 → cap 11,000,000 chars
// (PDF cap reduced from 15 MB — text extraction handles large files, but
// the vision fallback for scanned PDFs needs smaller payloads to stay
// within the 60s function timeout.)
const IMAGE_MAX_BASE64_CHARS = 7_000_000;
const PDF_MAX_BASE64_CHARS = 11_000_000;

const IMAGE_MIMES = new Set<DocumentMimeType>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);
const PDF_MIME: DocumentMimeType = "application/pdf";

/**
 * POST /api/marketplace/parse-document — OCR + VLM extraction of a
 * Certificate of Analysis or product spec sheet (photo OR PDF).
 *
 * Request body (JSON):
 *   {
 *     type:       "coa" | "spec_sheet",
 *     fileBase64: string,           // base64-encoded file (bare OR data: URL)
 *     mimeType?:  string,           // "image/png" | "image/jpeg" | "image/webp"
 *                                   // | "application/pdf" — auto-detected
 *                                   //   from the data: prefix when omitted
 *     imageBase64?: string,         // DEPRECATED alias for fileBase64
 *   }
 *
 * Response (200):
 *   For type="coa":
 *     { result: CertificateOfAnalysis }
 *   For type="spec_sheet":
 *     { result: ProductSpecSheet }
 *
 * Response (400) — bad request: missing file / unsupported type / file
 *   exceeds the size cap (5 MB image, 15 MB PDF).
 * Response (401) — not authenticated (portal session required).
 * Response (503) — the AI vision service is not configured or unreachable.
 *   The user is shown a friendly message via the document-scanner UI.
 *
 * Auth: any active portal session may upload a document for parsing —
 * the result is returned to the caller only and is NOT persisted. The
 * "Fill Form" button on the document-scanner component takes the
 * returned structured data and populates the create-post form; nothing
 * is sent to the database unless the user clicks Publish.
 *
 * SIZE LIMIT
 *   Images are capped at ~5 MB and PDFs at ~15 MB after base64
 *   encoding. Larger payloads are rejected with a 400 BEFORE invoking
 *   the VLM — the model would reject them anyway, and we don't want
 *   to charge for a failed inference call.
 */
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : "";
  // `fileBase64` is the new canonical field; `imageBase64` is kept as
  // a legacy alias so older mobile clients that haven't been refreshed
  // keep working. Prefer `fileBase64` when both are present.
  const fileBase64 =
    typeof b.fileBase64 === "string" && b.fileBase64.length > 0
      ? b.fileBase64
      : typeof b.imageBase64 === "string"
        ? b.imageBase64
        : "";
  const mimeTypeRaw = typeof b.mimeType === "string" ? b.mimeType.toLowerCase() : "";

  if (type !== "coa" && type !== "spec_sheet") {
    return NextResponse.json(
      { error: "Invalid `type` — must be 'coa' or 'spec_sheet'." },
      { status: 400 },
    );
  }
  if (!fileBase64) {
    return NextResponse.json(
      { error: "Missing `fileBase64` field." },
      { status: 400 },
    );
  }

  // ── Resolve the MIME type. ───────────────────────────────────────
  //   1. Caller-supplied `mimeType`.
  //   2. Data URL prefix on the base64 string.
  //   3. Default `image/png` (the legacy behaviour).
  let mimeType: DocumentMimeType = "image/png";
  if (mimeTypeRaw === "application/pdf") {
    mimeType = PDF_MIME;
  } else if (mimeTypeRaw === "image/png" || mimeTypeRaw === "image/jpeg" || mimeTypeRaw === "image/jpg" || mimeTypeRaw === "image/webp") {
    mimeType = mimeTypeRaw as DocumentMimeType;
  } else if (fileBase64.startsWith("data:application/pdf;base64,")) {
    mimeType = PDF_MIME;
  } else if (fileBase64.startsWith("data:image/jpeg;base64,")) {
    mimeType = "image/jpeg";
  } else if (fileBase64.startsWith("data:image/webp;base64,")) {
    mimeType = "image/webp";
  }

  const isPdf = mimeType === PDF_MIME;
  if (!IMAGE_MIMES.has(mimeType) && !isPdf) {
    return NextResponse.json(
      { error: "Unsupported file type — only PNG, JPEG, WebP, or PDF are accepted." },
      { status: 400 },
    );
  }

  // Size cap — base64 length, with the data: prefix already counted
  // (we strip it inside the parser, but a cap on the raw payload
  // protects the request body parser).
  const cap = isPdf ? PDF_MAX_BASE64_CHARS : IMAGE_MAX_BASE64_CHARS;
  if (fileBase64.length > cap) {
    return NextResponse.json(
      {
        error: isPdf
          ? "PDF is too large (must be ≤ 15 MB after base64 encoding)."
          : "Image is too large (must be ≤ 5 MB after base64 encoding).",
      },
      { status: 400 },
    );
  }

  try {
    let result: CertificateOfAnalysis | ProductSpecSheet;
    if (type === "coa") {
      result = await parseCertificateOfAnalysis(fileBase64, mimeType);
    } else {
      result = await parseProductSpecSheet(fileBase64, mimeType);
    }

    // Audit-log the parse so ops can see OCR usage + flag suspicious
    // patterns (e.g. a partner parsing 50 docs in 10 minutes — possible
    // abuse of the VLM quota). The file itself is NOT logged (PII /
    // quota cost) — only the result shape + parse type + mime.
    try {
      const store = await getStore();
      await audit(
        store,
        {
          id: undefined,
          username: access.portal_email || `portal:${access.id}`,
          tenant_id: access.tenant_id,
        },
        req,
        "marketplace.document_parsed",
        "marketplace_post",
        undefined,
        {
          parse_type: type,
          mime_type: mimeType,
          parameters_count:
            type === "coa"
              ? (result as CertificateOfAnalysis).parameters.length
              : Object.keys((result as ProductSpecSheet).specifications).length,
          confidence:
            (result as { confidence?: string }).confidence ?? "unknown",
        },
      );
    } catch (e) {
      console.error("[marketplace.parse-document] audit failed:", e);
    }

    return NextResponse.json({ result });
  } catch (e: unknown) {
    if (e instanceof DocumentParserError) {
      // AI service not configured / call failed — 503 so the UI shows the
      // friendly "AI service unavailable" message.
      console.error("[marketplace.parse-document] parser error:", e.message);
      return NextResponse.json(
        { error: e.message || "AI vision service is unavailable." },
        { status: 503 },
      );
    }
    console.error("[marketplace.parse-document] unexpected:", e);
    return NextResponse.json(
      { error: "Failed to parse document." },
      { status: 500 },
    );
  }
}

export const POST = withApm(_post, "POST /api/marketplace/parse-document");
