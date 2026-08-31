import { makePortalPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/portal/offers/[id]/pdf — see @/lib/pdf/route-factory for the
// canonical portal PDF pipeline. audit12 uniformity fixes vs the
// pre-factory copy: the tier gate now runs BEFORE the doc fetch (matching
// invoices/proformas), and ?mode=attachment is now supported (was
// inline-only — invoices and proformas already supported attachment).
export const GET = makePortalPdfRoute({
  docType: "offer",
  label: "Offer",
  viewedTable: "offers",
  logTag: "portal.offer.pdf",
});
