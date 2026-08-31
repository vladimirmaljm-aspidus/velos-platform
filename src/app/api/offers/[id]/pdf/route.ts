import { makeAdminPdfRoute } from "@/lib/pdf/route-factory";

export const runtime = "nodejs";

// GET /api/offers/[id]/pdf — see @/lib/pdf/route-factory for the canonical
// admin PDF pipeline. audit12: now gated by module_trade (matching
// /api/offers list/create routes — the pre-factory copy was missing the
// feature gate) and rate-limited + API-key-authed like every other route.
export const GET = makeAdminPdfRoute({
  docType: "offer",
  label: "Offer",
  permission: "offers",
  apiKeyPermission: "offers:read",
  feature: "module_trade",
  logTag: "pdf.offer",
});
