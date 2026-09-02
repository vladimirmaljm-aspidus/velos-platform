import { makePortalPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/portal/lois/[id]/pdf — see @/lib/pdf/route-factory for the
// canonical portal PDF pipeline (rate limit → portal session → tier gate →
// KYC gate → GPS gate → ownership check → generatePdf(no new verification)
// → mark viewed → uniform filename).
//
// BUILD-LOI-PORTAL — the portal LOI module's download button. The factory
// already supports docType "loi" (the admin route uses it); the only
// addition was widening `viewedTable` to include "lois".
export const GET = makePortalPdfRoute({
  docType: "loi",
  label: "LOI",
  viewedTable: "lois",
  logTag: "portal.loi.pdf",
});
