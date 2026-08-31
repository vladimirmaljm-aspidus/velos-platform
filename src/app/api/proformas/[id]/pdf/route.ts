import { makeAdminPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/proformas/[id]/pdf — see @/lib/pdf/route-factory for the canonical
// admin PDF pipeline (rate limit → auth → permission → feature gate →
// tenant-safe fetch → generatePdf → audit → uniform filename).
export const GET = makeAdminPdfRoute({
  docType: "proforma",
  label: "Proforma",
  permission: "proformas",
  apiKeyPermission: "proformas:read",
  feature: "module_finance",
  logTag: "pdf.proforma",
});
