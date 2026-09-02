import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError, getIp } from "@/lib/api/helpers";
import { sanitizeTemplatePayload } from "@/lib/api/template-payload";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { generatePdf } from "@/lib/pdf/generator";
import type { DocumentTemplate } from "@/lib/supabase/types";

export const runtime = "nodejs";

/**
 * POST /api/document-templates/preview — audit23 "live PDF preview".
 *
 * Renders a REAL document of the requested type (the tenant's most recent,
 * or an explicit docId) with the UNSAVED editor form as the template
 * override, so the admin sees exactly how the template would print BEFORE
 * saving it. This is the definitive answer to "do my template edits really
 * apply?" — the preview goes through the exact same generator the download
 * routes use (generatePdf + buildPdfDocument), just with the override.
 *
 * Guarantees:
 *  • auth + document-templates.read permission + module gate + admin role
 *  • per-IP rate limit (10 renders / 60s — previews are clicked ad-hoc
 *    while styling, and each render is CPU-expensive)
 *  • the payload passes the SAME sanitizer as the save route (shared
 *    template-payload.ts) — no drifting semantics between save & preview
 *  • createVerification: false — a preview NEVER writes verification rows
 *    or QR hashes; no audit trail pollution beyond one preview event
 *  • document ownership: fetched docs must belong to the resolved tenant
 */

const PREVIEW_DOC_TYPES = new Set(["offer", "invoice", "proforma", "loi"]);

export async function POST(req: NextRequest) {
  // Rate limit — preview rendering is CPU-expensive (react-pdf).
  const rl = await checkRateLimit(`tpl-preview:ip:${getIp(req)}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many preview requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 60_000) / 1000)) } },
    );
  }

  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (document-templates.read — previewing is a read-class action)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-templates.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ error: "No tenant." }, { status: 400 });

  let body: {
    docType?: unknown;
    docId?: unknown;
    template?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // ── docType ── the document family to render. contract/generic template
  // types have no dedicated documents — the editor maps those to a preview
  // docType on the client side before calling here.
  const docType = typeof body.docType === "string" ? body.docType : "";
  if (!PREVIEW_DOC_TYPES.has(docType)) {
    return NextResponse.json(
      { error: "Invalid docType. Allowed: offer, invoice, proforma, loi." },
      { status: 400 },
    );
  }

  // ── template payload ── same whitelist/clamps as the save route.
  if (!body.template || typeof body.template !== "object" || Array.isArray(body.template)) {
    return NextResponse.json({ error: "Missing template payload." }, { status: 400 });
  }
  let templateObj: Record<string, unknown>;
  try {
    templateObj = sanitizeTemplatePayload(body.template as Record<string, unknown>).sanitized;
  } catch (sanitizeErr) {
    return NextResponse.json(
      { error: sanitizeErr instanceof Error ? sanitizeErr.message : "Invalid template payload." },
      { status: 400 },
    );
  }
  // The renderer needs the identity fields the sanitizer strips; they are
  // synthesized locally (never persisted — this object exists only for the
  // render call).
  const templateOverride = {
    id: "preview",
    tenant_id: tenantId,
    name: typeof templateObj.name === "string" ? templateObj.name : "Preview",
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...templateObj,
  } as DocumentTemplate;

  // ── sample document ── explicit docId (ownership-checked) or the
  // tenant's most recent document of that type.
  let docId: string | null = null;
  let docNumber = "";
  if (typeof body.docId === "string" && body.docId.trim()) {
    const wanted = body.docId.trim();
    const fetched = await fetchDoc(auth.store as any, docType, wanted);
    if (!fetched || fetched.tenant_id !== tenantId) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
    docId = fetched.id;
    docNumber = fetched.number || "";
  } else {
    const latest = await listLatest(auth.store as any, docType, tenantId);
    if (!latest) {
      // Distinct sentinel — the editor shows "create a document of this
      // type first" instead of a generic failure.
      return NextResponse.json({ error: "NO_DOCUMENT" }, { status: 404 });
    }
    docId = latest.id;
    docNumber = latest.number || "";
  }

  try {
    const result = await generatePdf({
      docType: docType as "offer" | "invoice" | "proforma" | "loi",
      docId,
      tenantId,
      createVerification: false, // previews NEVER issue verifications
      templateOverride,
    });

    // One audit event per preview — enough to trace who styled what, without
    // polluting the document-level audit trail.
    audit(auth.store, auth.user, req, "doc_template.preview", "document_template", templateOverride.id, {
      docType,
      docId,
      docNumber,
      size: result.buffer.length,
    }).catch(() => {});

    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `inline; filename="template-preview-${docType}-${docNumber || docId}.pdf"`);
    headers.set("Content-Length", String(result.buffer.length));
    headers.set("X-Preview-Doc-Number", docNumber || docId);
    return new NextResponse(new Uint8Array(result.buffer), { status: 200, headers });
  } catch (e: any) {
    console.error("[doc-template-preview]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function fetchDoc(
  store: any,
  docType: string,
  id: string,
): Promise<{ id: string; number: string | null; tenant_id: string } | null> {
  switch (docType) {
    case "offer": return store.getOffer(id);
    case "invoice": return store.getInvoice(id);
    case "proforma": return store.getProforma(id);
    case "loi": return store.getLoi(id);
  }
  return null;
}

/** Most recent document of the type for the tenant (created_at desc). */
async function listLatest(
  store: any,
  docType: string,
  tenantId: string,
): Promise<{ id: string; number: string | null } | null> {
  const listers: Record<string, (tid: string, params?: { limit?: number }) => Promise<{ items: { id: string; number: string | null }[] }>> = {
    offer: (tid, p) => store.listOffers(tid, p),
    invoice: (tid, p) => store.listInvoices(tid, p),
    proforma: (tid, p) => store.listProformas(tid, p),
    loi: (tid, p) => store.listLois(tid, p),
  };
  const lister = listers[docType];
  if (!lister) return null;
  const res = await lister(tenantId, { limit: 1 });
  return res?.items?.[0] ?? null;
}
