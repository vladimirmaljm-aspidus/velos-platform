import { makePortalPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/portal/invoices/[id]/pdf — see @/lib/pdf/route-factory for the
// canonical portal PDF pipeline (rate limit → portal session → tier gate →
// KYC gate → GPS gate → ownership check → generatePdf(no new verification)
// → mark viewed → uniform filename).
export const GET = makePortalPdfRoute({
  docType: "invoice",
  label: "Invoice",
  viewedTable: "invoices",
  logTag: "portal.invoice.pdf",
});
