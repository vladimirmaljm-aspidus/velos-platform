// ─────────────────────────────────────────────────────────────────────────────
// PDF route factory (audit12 / uniformity).
//
// Before this module existed, the 7 offer/invoice/proforma/LOI PDF routes
// (4 admin + 3 portal) were near-identical 85-line copy-pastes with subtle
// drift — the LOI admin route had NO rate limit and NO API-key auth, the
// portal offers route didn't support ?mode=attachment, audit action names
// differed ("invoice.pdf" vs "loi.pdf_downloaded"), filename patterns
// differed, and the permission/feature gates were wired in a different
// order in every file. This factory is the single canonical implementation;
// each route file is now a ~10-line declaration.
//
// Uniform behaviour guaranteed for EVERY generated route:
//   Admin (offer/invoice/proforma/LOI):
//     • per-IP rate limit (30 renders / 60s) — PDF rendering is CPU-expensive
//     • requireAuthOrApiKey (cookie session OR Bearer asp_… API key)
//     • requirePermission(<perm>.read) for cookies / hasPermission(<perm>:read) for keys
//     • optional per-module feature gate (module_finance / module_trade)
//     • fetch doc FIRST → derive tenant_id (fixes super-admin cross-tenant PDFs)
//     • generatePdf + audit("<docType>.pdf") + uniform filename
//       `${tenantSafe}_${LABEL}_${docNum}_${partnerSafe}.pdf`
//     • ?mode=inline (default) | ?mode=attachment
//     • X-Verification-Code response header when a verification was issued
//   Portal (offer/invoice/proforma):
//     • per-IP rate limit (30 renders / 60s)
//     • portal session + can_download_pdf tier gate
//     • KYC gate + GPS gate
//     • tenant_id + partner_id ownership check (404 for foreign docs)
//     • generatePdf(createVerification: false) — portal NEVER issues verifications
//     • fire-and-forget markDocumentViewed
//     • ?mode=inline (default) | ?mode=attachment
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthOrApiKey,
  audit,
  sanitizeError,
  hasPermission,
  getIp,
  type AuthContext,
  getAuthUser,
  type ApiKeyAuthContext,
} from "@/lib/api/helpers";
import { generatePdf, type GeneratePdfResult } from "@/lib/pdf/generator";
import { safeFilename } from "@/lib/security/safe-filename";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export type TradeDocType = "offer" | "invoice" | "proforma" | "loi";

/** Uniform filename segment: alphanumerics + dashes only. */
function filenameSegment(raw: string | null | undefined, fallback: string): string {
  return safeFilename(raw, fallback).replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Uniform per-IP rate limit check shared by all PDF routes. */
async function pdfRateLimit(scope: string, req: NextRequest): Promise<NextResponse | null> {
  const rl = await checkRateLimit(`${scope}:ip:${getIp(req)}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many PDF requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }
  return null;
}

/** Uniform PDF response (inline/attachment disposition + verification header). */
function pdfResponse(
  result: GeneratePdfResult,
  disposition: "inline" | "attachment",
  filename: string,
): NextResponse {
  const headers = new Headers();
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `${disposition}; filename="${filename}"`);
  headers.set("Content-Length", String(result.buffer.length));
  if (result.verificationCode) {
    headers.set("X-Verification-Code", result.verificationCode);
  }
  return new NextResponse(new Uint8Array(result.buffer), { status: 200, headers });
}


// ─── Admin PDF route factory ────────────────────────────────────────────────

export interface AdminPdfRouteConfig {
  docType: TradeDocType;
  /** Uppercase label used in the download filename (e.g. "Invoice"). */
  label: string;
  /** RBAC permission base for cookie sessions (e.g. "invoices" → invoices.read). */
  permission: string;
  /** API-key permission string (e.g. "invoices:read"). */
  apiKeyPermission: string;
  /** Optional feature gate (e.g. "module_finance"). Omit for ungated modules. */
  feature?: "module_trade" | "module_finance" | "module_logistics" | "module_portal";
  /** Log label used in console.error prefixes. */
  logTag: string;
}

/** Map of docType → store getter (avoids per-route switch duplication). */
async function fetchTradeDoc(
  store: NonNullable<Awaited<ReturnType<typeof import("@/lib/data/store").getStore>>>,
  docType: TradeDocType,
  id: string,
): Promise<{ id: string; number: string | null; tenant_id: string; partner_id: string | null } | null> {
  switch (docType) {
    case "offer":
      return (await store.getOffer(id)) as any;
    case "invoice":
      return (await store.getInvoice(id)) as any;
    case "proforma":
      return (await store.getProforma(id)) as any;
    case "loi":
      return (await store.getLoi(id)) as any;
  }
}

export function makeAdminPdfRoute(cfg: AdminPdfRouteConfig) {
  return async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // 9a-N3: per-IP rate limit — PDF rendering is CPU-expensive (react-pdf
    // renderToBuffer + logo fetch + SHA-256 hash + DB writes).
    const rl = await pdfRateLimit("pdf", req);
    if (rl) return rl;

    // F-FINAL: allow API key auth (Bearer asp_...) in addition to cookie
    // sessions — unblocks programmatic PDF generation (e.g. an integration
    // that archives PDFs to external storage).
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    // Permission gate — cookie sessions enforce via requirePermission,
    // API keys enforce via hasPermission.
    if (!("apiKeyId" in auth)) {
      const { requirePermission } = await import("@/lib/permissions/can");
      const denied = requirePermission(auth, `${cfg.permission}.read` as any);
      if (denied) return denied;
    }
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, cfg.apiKeyPermission)) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    // Optional feature gate (module_finance / module_trade / …).
    if (cfg.feature) {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const denied = await requireFeature(auth.tenantId, cfg.feature, !("apiKeyId" in auth) && auth.isSuperAdmin);
      if (denied) return denied;
    }

    const { id } = await params;

    try {
      // Fetch the document FIRST so we know which tenant it belongs to.
      // This fixes super-admin downloads: the document itself carries the
      // tenant_id, so super-admins don't need to pass ?tenant_id= explicitly
      // (a silent fallback to tenants[0] would return the wrong tenant's PDF).
      const doc = await fetchTradeDoc(auth.store, cfg.docType, id);
      if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });

      const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
      if (!isSuperAdmin && doc.tenant_id !== auth.tenantId) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }
      const tenantId = doc.tenant_id;

      const partner = doc.partner_id ? await auth.store.getPartner(doc.partner_id) : null;
      const tenant = await auth.store.getTenant(tenantId);

      const result = await generatePdf({ docType: cfg.docType, docId: id, tenantId });

      // Audit the download (uniform action name "<docType>.pdf").
      await audit(auth.store, getAuthUser(auth), req, `${cfg.docType}.pdf`, cfg.docType, id, {
        verification_code: result.verificationCode,
        size: result.buffer.length,
      });

      // 9a-N1: shared safeFilename — strips CRLF / quotes / control chars so
      // tenant.name / partner.name can't inject headers via the filename.
      const tenantName = filenameSegment(tenant?.name, "VELOS");
      const docNum = filenameSegment(doc.number, id);
      const partnerName = partner ? `_${filenameSegment(partner.name, "")}` : "";
      const filename = `${tenantName}_${cfg.label}_${docNum}${partnerName}.pdf`;

      const mode = req.nextUrl.searchParams.get("mode") === "attachment" ? "attachment" : "inline";
      return pdfResponse(result, mode, filename);
    } catch (e: any) {
      console.error(`[${cfg.logTag}]`, e);
      return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
    }
  };
}

// ─── Portal PDF route factory ───────────────────────────────────────────────

export interface PortalPdfRouteConfig {
  docType: TradeDocType;
  /** Label used in the download filename (e.g. "Invoice"). */
  label: string;
  /** markDocumentViewed table name ("offers" | "invoices" | "proformas" | "lois"). */
  viewedTable: "offers" | "invoices" | "proformas" | "lois";
  /** Log label used in console.error prefixes. */
  logTag: string;
}

export function makePortalPdfRoute(cfg: PortalPdfRouteConfig) {
  return async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
      // 9a-N3: per-IP rate limit — PDF rendering is CPU-expensive.
      const rl = await pdfRateLimit("pdf", req);
      if (rl) return rl;

      const { getPortalSessionAccess } = await import("@/lib/auth/portal-session");
      const access = await getPortalSessionAccess();
      if (!access) {
        return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
      }

      // Tier gate — the portal client's plan must allow PDF downloads.
      if (!access.can_download_pdf) {
        return NextResponse.json({ error: "PDF download not available for your tier." }, { status: 403 });
      }

      // KYC gate — a KYC-rejected partner must not download issued documents.
      const { requireKycApproved } = await import("@/lib/portal/kyc-gate");
      const kycBlock = await requireKycApproved(access);
      if (kycBlock) return kycBlock;

      // GPS gate (audit P0-5): must also apply to PDF download — otherwise a
      // portal client with a valid session but no shared GPS can curl the
      // PDF endpoint and bypass the client-side gate entirely.
      const { requireGpsVerified } = await import("@/lib/portal/require-gps");
      const gpsBlock = await requireGpsVerified(access);
      if (gpsBlock) return gpsBlock;

      const { getStore } = await import("@/lib/data/store");
      const store = await getStore();
      const { id } = await params;

      // Verify the document exists and belongs to this portal client.
      const doc = await fetchTradeDoc(store, cfg.docType, id);
      if (!doc) {
        return NextResponse.json({ error: `${cfg.label} not found.` }, { status: 404 });
      }

      // Tenant check (audit M-5): defense-in-depth — partner_id is globally
      // unique (uuid) but this guards against schema changes and store bugs.
      if (doc.tenant_id !== access.tenant_id) {
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      }

      // Ownership: the document's partner_id must match the portal access.
      if (doc.partner_id !== access.partner_id) {
        return NextResponse.json({ error: "Access denied." }, { status: 403 });
      }

      // Portal NEVER issues verifications (createVerification: false) — but
      // an EXISTING admin-issued verification QR is still rendered so scans
      // keep working across re-downloads.
      const result = await generatePdf({
        docType: cfg.docType,
        docId: id,
        tenantId: access.tenant_id,
        createVerification: false,
      });

      // Fire-and-forget: mark as viewed (status sent→viewed on first open).
      const { markDocumentViewed } = await import("@/lib/portal/mark-viewed");
      markDocumentViewed(cfg.viewedTable, id, access.tenant_id, access.portal_email).catch(() => {});

      const filename = `${cfg.label}-${safeFilename(doc.number, id)}.pdf`;
      const mode = req.nextUrl.searchParams.get("mode") === "attachment" ? "attachment" : "inline";
      return pdfResponse(result, mode, filename);
    } catch (e: any) {
      console.error(`[${cfg.logTag}]`, e);
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  };
}
