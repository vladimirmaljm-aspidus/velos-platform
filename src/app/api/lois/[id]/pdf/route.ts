import { makeAdminPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/lois/[id]/pdf — renders the LOI via the same generatePdf system
// (memorandum header + logo, footer with QR + address + page numbers,
// verification code, signature blocks).
//
// audit12 uniformity fixes vs the pre-factory copy:
//   • per-IP rate limit added (was the ONLY admin PDF route without one)
//   • API-key auth (Bearer asp_…) added, matching every other admin route
//   • uniform filename pattern `${tenant}_LOI_${number}_${partner}.pdf`
//     (was bare `LOI-${number}.pdf`)
//   • uniform audit action "loi.pdf" (was "loi.pdf_downloaded")
//   • uniform ?mode=inline|attachment support + X-Verification-Code header
//     on every admin PDF response (was LOI-only)
// No feature gate: /api/lois list/create routes are not module-gated either,
// so the PDF route must not introduce one (a gated PDF + ungated CRUD would
// lock tenants out of downloads while still allowing document creation).
export const GET = makeAdminPdfRoute({
  docType: "loi",
  label: "LOI",
  permission: "lois",
  apiKeyPermission: "lois:read",
  logTag: "pdf.loi",
});
