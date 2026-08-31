import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  VALID_CERT_TYPES,
  addSustainabilityCert,
  listSustainabilityCerts,
} from "@/lib/data/marketplace-esg-store";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";
import type { CertType } from "@/lib/supabase/marketplace-esg-types";

export const runtime = "nodejs";

const VALID_CERTS_LIST: CertType[] = [
  "fsc", "rspo", "msc", "iso14001", "iso45001", "iso50001",
  "sa8000", "fairtrade", "organic", "global_gap",
  "rainforest_alliance", "carbon_neutral", "b_corp",
];

// GET /api/marketplace/esg/certs?partnerId=... — list a company's
// sustainability certifications. Public to any authenticated partner
// (certs are a public trust signal on the company profile, same as the
// ESG score).
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const partnerId = url.searchParams.get("partnerId");
    if (!partnerId || typeof partnerId !== "string") {
      return NextResponse.json({ error: "partnerId is required." }, { status: 400 });
    }
    const items = await listSustainabilityCerts(partnerId);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error("[marketplace.esg.certs.list]", e);
    return NextResponse.json({ error: "Failed to load certifications." }, { status: 500 });
  }
}

// POST /api/marketplace/esg/certs — add a sustainability certification to
// the caller's own company. partner_id is stamped from the auth context;
// the body's partner_id (if any) is ignored. New certs start
// `verified = false` — verification is a separate super-admin-only step.
//
// Body:
//   { cert_type, cert_number?, cert_issuer?, valid_from?, valid_until?,
//     document_url? }
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!VALID_CERT_TYPES.has(body.cert_type) || !VALID_CERTS_LIST.includes(body.cert_type)) {
    return NextResponse.json({ error: "Invalid or missing cert_type." }, { status: 400 });
  }
  if (body.cert_number !== undefined && body.cert_number !== null && (typeof body.cert_number !== "string" || body.cert_number.length > 200)) {
    return NextResponse.json({ error: "cert_number must be ≤ 200 chars." }, { status: 400 });
  }
  if (body.cert_issuer !== undefined && body.cert_issuer !== null && (typeof body.cert_issuer !== "string" || body.cert_issuer.length > 200)) {
    return NextResponse.json({ error: "cert_issuer must be ≤ 200 chars." }, { status: 400 });
  }
  if (body.valid_from !== undefined && body.valid_from !== null && (typeof body.valid_from !== "string" || Number.isNaN(Date.parse(body.valid_from)))) {
    return NextResponse.json({ error: "valid_from must be an ISO 8601 date." }, { status: 400 });
  }
  if (body.valid_until !== undefined && body.valid_until !== null && (typeof body.valid_until !== "string" || Number.isNaN(Date.parse(body.valid_until)))) {
    return NextResponse.json({ error: "valid_until must be an ISO 8601 date." }, { status: 400 });
  }
  if (body.valid_from && body.valid_until && Date.parse(body.valid_until) < Date.parse(body.valid_from)) {
    return NextResponse.json({ error: "valid_until must be on or after valid_from." }, { status: 400 });
  }
  if (body.document_url !== undefined && body.document_url !== null && (typeof body.document_url !== "string" || body.document_url.length > 1000)) {
    return NextResponse.json({ error: "document_url must be ≤ 1000 chars." }, { status: 400 });
  }

  try {
    const created = await addSustainabilityCert(access.partner_id, {
      cert_type: body.cert_type,
      cert_number: body.cert_number ?? undefined,
      cert_issuer: body.cert_issuer ?? undefined,
      valid_from: body.valid_from ?? undefined,
      valid_until: body.valid_until ?? undefined,
      document_url: body.document_url ?? undefined,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.sustainability_cert_added",
        "marketplace_sustainability_certs",
        created.id,
        { cert_type: created.cert_type, verified: created.verified },
      );
    } catch (e) {
      console.error("[marketplace.esg.certs.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.esg.certs.create]", e);
    const msg = sanitizeError(e);
    const status = /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/esg/certs");
export const POST = withApm(_post, "POST /api/marketplace/esg/certs");
