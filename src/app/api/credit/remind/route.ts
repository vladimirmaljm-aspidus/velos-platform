import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, sanitizeError, getAuthUser } from "@/lib/api/helpers";
import { withApm } from "@/lib/monitoring/apm";
// FIX-PRODUCTS-DOCS / Fix 4 — XSS prevention on free-text fields. Reminder
// notes render in the collections queue history, so escape <, >, ", ' here.
import { sanitizeFields } from "@/lib/security/sanitize-input";

export const runtime = "nodejs";

async function _post(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.update) — recording a dunning reminder /
    // collection note is a finance write on the invoice's collections state.
    // Anyone who may edit invoices may log collections activity.
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.update"); if (_d) return _d; } } /* requirePermission wired */
    // Feature gate (module_finance)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; } /* requireFeature wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // ── Validation ────────────────────────────────────────────────────────
    if (!body.partner_id || typeof body.partner_id !== "string") {
      return NextResponse.json({ error: "Missing required field(s): partner_id." }, { status: 400 });
    }
    const kind = body.kind === "note" ? "note" : body.kind === "reminder" ? "reminder" : null;
    if (!kind) {
      return NextResponse.json({ error: "kind must be 'reminder' or 'note'." }, { status: 400 });
    }
    const stage = Number(body.stage ?? 1);
    if (!Number.isInteger(stage) || stage < 1 || stage > 3) {
      return NextResponse.json({ error: "stage must be an integer between 1 and 3." }, { status: 400 });
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      return NextResponse.json({ error: "note must be a string." }, { status: 400 });
    }

    // The partner must belong to the caller's tenant (parity with the
    // invoices POST partner check — audit P1-12).
    const partner = await auth.store.getPartner(body.partner_id);
    if (!partner || partner.tenant_id !== tid) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }

    // Optional invoice link — when present it must belong to the same tenant
    // AND the same partner (a reminder for someone else's invoice is a data
    // integrity smell, not a collections action).
    if (body.invoice_id) {
      const invoice = await auth.store.getInvoice(body.invoice_id);
      if (!invoice || invoice.tenant_id !== tid) {
        return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
      }
      if (invoice.partner_id !== body.partner_id) {
        return NextResponse.json({ error: "Invoice does not belong to the given partner." }, { status: 400 });
      }
    }

    body = sanitizeFields(body, ["note"]);

    const row = await auth.store.insertCollectionReminder({
      tenant_id: tid,
      partner_id: body.partner_id,
      invoice_id: body.invoice_id || null,
      stage: kind === "note" ? 1 : stage, // stage is meaningless for notes — store the ladder default
      kind,
      note: body.note || null,
      sent_by: "user" in auth ? auth.user.id : null,
    });

    await audit(
      auth.store,
      getAuthUser(auth),
      req,
      kind === "note" ? "credit.note" : "credit.remind",
      body.invoice_id ? "invoice" : "partner",
      body.invoice_id || body.partner_id,
      {
        partner_id: body.partner_id,
        invoice_id: body.invoice_id || null,
        stage: kind === "note" ? null : stage,
        kind,
        has_note: !!body.note,
      },
    );

    return NextResponse.json(row);
  } catch (error: any) {
    console.error("[credit.remind]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// ── APM wrappers (task D-8) ──────────────────────────────────────────────
export const POST = withApm(_post, "POST /api/credit/remind");
