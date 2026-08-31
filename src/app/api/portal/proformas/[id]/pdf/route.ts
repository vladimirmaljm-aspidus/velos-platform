import { makePortalPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/portal/proformas/[id]/pdf — see @/lib/pdf/route-factory for the
// canonical portal PDF pipeline (rate limit → portal session → tier gate →
// KYC gate → GPS gate → ownership check → generatePdf(no new verification)
// → mark viewed → uniform filename).
export const GET = makePortalPdfRoute({
  docType: "proforma",
  label: "Proforma",
  viewedTable: "proformas",
  logTag: "portal.proforma.pdf",
});
