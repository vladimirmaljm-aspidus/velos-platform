import { makeAdminPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/invoices/[id]/pdf — see @/lib/pdf/route-factory for the canonical
// admin PDF pipeline (rate limit → auth → permission → feature gate →
// tenant-safe fetch → generatePdf → audit → uniform filename).
export const GET = makeAdminPdfRoute({
  docType: "invoice",
  label: "Invoice",
  permission: "invoices",
  apiKeyPermission: "invoices:read",
  feature: "module_finance",
  logTag: "pdf.invoice",
});
