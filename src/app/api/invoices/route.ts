import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, type AuthContext, type ApiKeyAuthContext, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

async function _get(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.read"); if (_d) return _d; } } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listInvoices(tid!, { search, filters: { partner_id, status }, limit, offset });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    if (shouldFilter && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((i) => i.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

async function _post(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (invoices.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.create"); if (_d) return _d; } } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
    const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const body = await req.json();
    body.tenant_id = tid!;
    // P1-1 / Feature 2 (SoD): record the invoice's creator so the
    // PUT route's separation-of-duties check can compare creator vs.
    // approver. Always overwrite whatever the client sent — a malicious
    // body could try to spoof `created_by` to bypass SoD. For API-key
    // callers we leave it NULL (API keys don't have a user id; the
    // SoD check fails open in that case, which is acceptable because
    // API-key callers are admin-controlled).
    if ("user" in auth) {
      body.created_by = auth.user.id;
    } else {
      body.created_by = null;
    }
    if (!body.id) {
      const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", isSA);
      if (denied) return denied;
    }

    // CRITICAL FIX (audit P1-12): partner_id must belong to the caller's
    // tenant. Without this a super-admin (tid resolves to their own tenant)
    // or an API key could attach an invoice to a partner owned by another
    // tenant by passing that partner's UUID.
    if (body.partner_id) {
      const partner = await auth.store.getPartner(body.partner_id);
      if (partner && partner.tenant_id !== tid) {
        return NextResponse.json({ error: "Partner not found." }, { status: 404 });
      }
    }

    // CRITICAL FIX: require at least 1 line item — an invoice with 0 items
    // and total=0 is meaningless and breaks the payment flow.
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: "At least one line item is required." },
        { status: 400 },
      );
    }

    // CRITICAL FIX (audit P1-11): recompute totals from line items — never trust
    // client-supplied totals (parity with PUT routes and offers POST).
    if (Array.isArray(body.items) && body.items.length > 0) {
      let subtotal = 0, discountTotal = 0, taxTotal = 0;
      for (const it of body.items) {
        const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
        const disc = line * (Number(it.discount) || 0) / 100;
        const net = line - disc;
        const tax = net * (Number(it.tax_rate) || 0) / 100;
        subtotal += line;
        discountTotal += disc;
        taxTotal += tax;
        it.total = Math.round((net + tax) * 100) / 100;
      }
      body.subtotal = Math.round(subtotal * 100) / 100;
      body.discount_total = Math.round(discountTotal * 100) / 100;
      body.tax_total = Math.round(taxTotal * 100) / 100;
      body.total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;
    }

    // Auto-generate document number if not provided (e.g. manual "Create" click).
    // P1 (VAT compliance) / task C-4 Fix 1: use the atomic
    // `createDocWithNumber` path which calls `nextval()` and INSERTs the
    // row in a single Postgres function call (migration 032 RPC), so the
    // sequence value is allocated only when the INSERT is actually
    // attempted — minimising VAT-sequence gaps that the legacy two-step
    // pattern (nextDocNumber() → upsertInvoice()) produced whenever the
    // upsert failed after nextval().
    //   Format: INV-<year>-<NNNN>  (4-digit sequence)
    // When the client supplied an explicit `number` (rare, e.g. an admin
    // overriding the auto-gen), or when updating an existing record
    // (body.id present), we skip the atomic path and use the regular
    // upsertInvoice so the client's number is respected.
    const useAtomicCreate = !body.id && !body.number;

    let created;
    if (useAtomicCreate) {
      // Atomic path: nextval() + INSERT in a single RPC. Removes the
      // unique-collision retry loop (the legacy loop bumped `body.number`
      // by +1 on collision, which could collide with the next legitimate
      // nextval() and burn another sequence value — cascading gaps).
      try {
        created = await auth.store.createDocWithNumber("invoice", body as Record<string, unknown>) as any;
      } catch (e: any) {
        console.error("[invoices.post] atomic create failed:", e);
        return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
      }
    } else {
      try {
        created = await auth.store.upsertInvoice(body);
      } catch (e: any) {
        // Legacy retry-on-collision removed: the atomic path above handles
        // the auto-number case; this branch only runs when the client
        // supplied an explicit `number` or `id`, in which case a unique
        // collision is a genuine conflict that should surface as a 500
        // (not be silently retried with a bumped number).
        console.error("[invoices.post] upsert failed:", e);
        return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
      }
    }
    await audit(auth.store, getAuthUser(auth), req, body.id ? "invoice.update" : "invoice.create", "invoice", created.id, { number: created.number });

    // ── F-4: fire outbound webhooks (invoice.created / invoice.updated) ────
    // Fire-and-forget — webhook delivery failures must NEVER block the
    // invoice mutation. We pass the AFTER snapshot (created) so receivers
    // get the persisted state including the auto-generated number.
    void triggerWebhooks(
      auth.store,
      tid!,
      body.id ? "invoice.updated" : "invoice.created",
      "invoice",
      created.id,
      created as unknown as Record<string, unknown>,
    ).catch((e) => console.error("[invoices.post] webhook trigger failed:", e));

    return NextResponse.json(created);
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// ── APM wrappers (task D-8) ──────────────────────────────────────────────
// Wraps GET/POST with response-time, slow-request, and error-rate metrics.
// See src/lib/monitoring/apm.ts for the buffer + dashboard wiring.
export const GET = withApm(_get, "GET /api/invoices");
export const POST = withApm(_post, "POST /api/invoices");
