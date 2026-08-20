import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  parseCertificateOfAnalysis,
  parseProductSpecSheet,
  DocumentParserError,
  type CertificateOfAnalysis,
  type ProductSpecSheet,
} from "@/lib/marketplace/document-parser";
import { withApm } from "@/lib/monitoring/apm";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";

export const runtime = "nodejs";

/**
 * POST /api/marketplace/parse-document — OCR + VLM extraction of a
 * Certificate of Analysis or product spec sheet photo.
 *
 * Request body (JSON):
 *   {
 *     type: "coa" | "spec_sheet",
 *     imageBase64: string,    // base64-encoded image data (no data: prefix needed)
 *   }
 *
 * Response (200):
 *   For type="coa":
 *     { result: CertificateOfAnalysis }
 *   For type="spec_sheet":
 *     { result: ProductSpecSheet }
 *
 * Response (400) — bad request: missing image / unsupported type / image
 *   exceeds the 5 MB cap.
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
 *   The base64 payload is capped at 7,000,000 characters (~5 MB after
 *   base64 encoding, leaving headroom for the JSON envelope). Larger
 *   payloads are rejected with a 400 BEFORE invoking the VLM — the
 *   model would reject them anyway, and we don't want to charge for a
 *   failed inference call.
 */
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const type = typeof body?.type === "string" ? body.type : "";
  const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";

  if (type !== "coa" && type !== "spec_sheet") {
    return NextResponse.json(
      { error: "Invalid `type` — must be 'coa' or 'spec_sheet'." },
      { status: 400 },
    );
  }
  if (!imageBase64) {
    return NextResponse.json(
      { error: "Missing `imageBase64` field." },
      { status: 400 },
    );
  }
  // 5 MB cap (≈ 6.7M base64 chars) — reject BEFORE invoking the VLM.
  if (imageBase64.length > 7_000_000) {
    return NextResponse.json(
      { error: "Image is too large (must be ≤ 5 MB after base64 encoding)." },
      { status: 400 },
    );
  }

  try {
    let result: CertificateOfAnalysis | ProductSpecSheet;
    if (type === "coa") {
      result = await parseCertificateOfAnalysis(imageBase64);
    } else {
      result = await parseProductSpecSheet(imageBase64);
    }

    // Audit-log the parse so ops can see OCR usage + flag suspicious
    // patterns (e.g. a partner parsing 50 docs in 10 minutes — possible
    // abuse of the VLM quota). The image itself is NOT logged (PII /
    // quota cost) — only the result shape + parse type.
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
          parameters_count:
            type === "coa"
              ? (result as CertificateOfAnalysis).parameters.length
              : Object.keys((result as ProductSpecSheet).specifications).length,
        },
      );
    } catch (e) {
      console.error("[marketplace.parse-document] audit failed:", e);
    }

    return NextResponse.json({ result });
  } catch (e: any) {
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
