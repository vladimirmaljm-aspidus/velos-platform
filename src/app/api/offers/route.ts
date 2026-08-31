import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, type AuthContext, type ApiKeyAuthContext, sanitizeError, getAuthUser } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";
// FIX-ALL-2 / Fix 1 — strip bank_details from offer responses for API-key callers.
import { redactOfferFields } from "@/lib/api/redact";
// FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields.
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { recomputeDocTotals } from "@/lib/utils/doc-totals";

export const runtime = "nodejs";

async function _get(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (offers.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.read"); if (_d) return _d; } } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:read")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listOffers(tid!, { search, limit, offset, filters: { partner_id, status } });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    const shouldFilter = "apiKeyId" in auth || !auth.isSuperAdmin;
    if (shouldFilter && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((o) => o.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    // FIX-ALL-2 / Fix 1 — strip `bank_details` from offer responses when
    // the caller is an API key. The field is a JSON blob with the seller's
    // settlement instructions (account number / SWIFT / IBAN / beneficiary)
    // surfaced on the offer PDF but NOT in the API contract. The helper
    // is a no-op for session-auth callers so the admin UI continues to
    // render the bank block.
    result.items = (redactOfferFields(result.items as any, auth) as any) || result.items;
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[offers GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

async function _post(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (offers.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.create"); if (_d) return _d; } } /* requirePermission wired */
    // Feature gate (module_trade) — prevents Trial tenants with module_trade=false
    // from using the API directly even though the UI hides the menu.
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; }

    const tid = resolveTenantId(auth, req);

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

  // FIX-ALL-2 / Fix 7 — validation BEFORE DB write. Audit Part D found
  // that POST /api/products {} returned "Database error Missing required
  // field." because Postgres hit the NOT NULL constraint. The same gap
  // exists on offers — `partner_id` and `items[]` are NOT NULL on the
  // offers table, and a missing partner_id surfaces as a foreign-key
  // violation. Validate the required shape here so we return a clean
  // 400 listing the missing fields, never reaching the DB.
  if (!body.id) {
    const missing: string[] = [];
    if (!body.partner_id) missing.push("partner_id");
    if (!Array.isArray(body.items) || body.items.length === 0) missing.push("items");
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing required field(s): ${missing.join(", ")}.` },
        { status: 400 },
      );
    }
    // Per-line validation: each item must have a product_id (or sku) and
    // a non-negative quantity / unit_price. A negative price would pass
    // the NOT NULL check but distort the totals computation downstream.
    for (let i = 0; i < body.items.length; i++) {
      const it = body.items[i];
      const qty = Number(it.quantity);
      const price = Number(it.unit_price);
      if (!Number.isFinite(qty) || qty < 0) {
        return NextResponse.json({ error: `items[${i}].quantity must be a non-negative number.` }, { status: 400 });
      }
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json({ error: `items[${i}].unit_price must be a non-negative number.` }, { status: 400 });
      }
      // AUDIT17 / F2 — range-validate percentage fields (0-100) so a 150%
      // discount / negative tax_rate can't produce a negative-total doc
      // (trivially "paid" per record_invoice_payment's tolerance check).
      const disc = Number(it.discount);
      if (Number.isFinite(disc) && (disc < 0 || disc > 100)) {
        return NextResponse.json({ error: `items[${i}].discount must be between 0 and 100.` }, { status: 400 });
      }
      const tr = Number(it.tax_rate);
      if (Number.isFinite(tr) && (tr < 0 || tr > 100)) {
        return NextResponse.json({ error: `items[${i}].tax_rate must be between 0 and 100.` }, { status: 400 });
      }
    }
  }

  // FIX-ALL-2 / Fix 6 — XSS prevention on free-text fields. Offers carry
  // a lot of free-text (subject, notes, line item descriptions, payment
  // terms, packaging, vessel/container, …) that the PDF generator pipes
  // through `dangerouslySetInnerHTML`. Escape `<`/`>`/`"`/`'` here so a
  // malicious name can't break out of the PDF template's HTML structure.
  body = sanitizeFields(body, [
    "subject",
    "notes",
    "payment_terms",
    "packaging",
    "vessel",
    "container_no",
    "pol",
    "pod",
    "incoterm",
    "lead_time",
    "delivery_terms",
    "valid_until_note",
    "shipping_terms",
  ]);
  if (Array.isArray(body.items)) {
    body.items = body.items.map((it: any) => sanitizeFields(it, [
      "description", "detailed_spec", "brand", "sku", "hs_code",
      "origin_country", "notes", "subject", "unit",
    ]));
  }

  // FIX-PRODUCTS-DOCS / Fix 6 — ISO 4217 currency validation. CURRENCY_CODES
  // is exported from @/lib/data/reference but no API route previously
  // imported it for server-side validation; a direct API caller could set
  // body.currency to any string ("FOO", "XXX", even an XSS payload that
  // later lands in a dangerouslySetInnerHTML PDF template) and it would
  // reach the DB. Reject unknown codes BEFORE the upsert. Skip when the
  // caller omits currency (the DB default / NOT NULL constraint surface
  // handles that path — both offers POST and PUT enforce a currency).
  if (body.currency !== undefined && body.currency !== null && body.currency !== "") {
    const { CURRENCY_CODES } = await import("@/lib/data/reference");
    if (!CURRENCY_CODES.includes(body.currency)) {
      return NextResponse.json(
        { error: `Invalid currency code: ${body.currency}. Must be one of: ${CURRENCY_CODES.join(", ")}.` },
        { status: 400 },
      );
    }
  }

  body.tenant_id = tid!;
  if (!body.owner_id && "user" in auth) body.owner_id = auth.user.id;

  // CRITICAL FIX (audit P1-5): validate partner_id belongs to caller's tenant.
  // Without this, a tenant-A user can create an offer referencing tenant-B's
  // partner — polluting downstream reports and commission calculations.
  if (body.partner_id) {
    const partner = await auth.store.getPartner(body.partner_id);
    if (partner && partner.tenant_id !== tid) {
      return NextResponse.json({ error: "Partner not found." }, { status: 404 });
    }
  }

  // FIX-PRODUCTS-DOCS / Fix 8 — when body.deal_id is provided, verify it
  // belongs to the caller's tenant. The auto-track-commission block
  // below uses `(created as any).deal_id` to insert a deal_commissions
  // row — if the caller supplied another tenant's deal_id, the
  // commission row would be created against that foreign deal. Skip
  // when deal_id is null/empty (offer is intentionally not linked to a
  // deal yet — the auto-track block below will create one when trade
  // calc metadata is present).
  if (body.deal_id) {
    const deal = await auth.store.getDeal(body.deal_id);
    if (!deal || deal.tenant_id !== tid) {
      return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    }
  }
  // ── Strip `_` prefixed metadata fields BEFORE upserting ──────────────
  // These are passed through by the offer form when the offer was pre-filled
  // from a Trade Calculator preview (Fix 1). They carry trade-calc-only
  // metadata (commission agent, buy price, margin…) used downstream by the
  // auto-track commission obligation block (Fix 2). They MUST be stripped
  // before `upsertOffer` because they're not real columns on the offers
  // table — leaving them in would make PostgREST reject the upsert with a
  // "column does not exist" error.
  const tradeCalcMeta = {
    _trade_calc_id: (body as any)._trade_calc_id || null,
    _commission_agent_id: (body as any)._commission_agent_id || null,
    _commission_type: (body as any)._commission_type || null,
    _commission_rate: Number((body as any)._commission_rate) || 0,
    _commission_amount: Number((body as any)._commission_amount) || 0,
    _buy_price_per_unit: Number((body as any)._buy_price_per_unit) || 0,
    _buy_currency: (body as any)._buy_currency || null,
    _landed_cost: Number((body as any)._landed_cost) || 0,
    _margin: Number((body as any)._margin) || 0,
  };
  for (const k of [
    "_trade_calc_id",
    "_commission_agent_id",
    "_commission_type",
    "_commission_rate",
    "_commission_amount",
    "_buy_price_per_unit",
    "_buy_currency",
    "_landed_cost",
    "_margin",
  ]) {
    delete (body as any)[k];
  }

  // Always recompute totals from items when items are provided — never trust
  // client-supplied totals (FLOW-7: previously skipped when body.total was
  // present, allowing tampered totals to disagree with line items).
  if (Array.isArray(body.items) && body.items.length > 0) {
      // AUDIT18 — canonical totals (lib/utils/doc-totals.ts): replaces the
      // inline quantity×price−disc+tax loop that was copy-pasted across 6
      // routes (and drifted from the client views' math on rounding).
      const totals = recomputeDocTotals(body.items);
      body.subtotal = totals.subtotal;
      body.discount_total = totals.discount_total;
      body.tax_total = totals.tax_total;
      body.total = totals.total;
    }
  if (!body.id) {
    const isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
    const { enforceQuota } = await import("@/lib/api/plan-limits");
    const denied = await enforceQuota(body.tenant_id, "monthly_documents", isSA);
    if (denied) return denied;
  }

  // Auto-generate document number if not provided (e.g. manual "Create" click).
  // P1 (VAT compliance) / task C-4 Fix 1: use the atomic
  // `createDocWithNumber` path which calls `nextval()` and INSERTs the row
  // in a single Postgres function call (migration 032 RPC), so the
  // sequence value is allocated only when the INSERT is actually
  // attempted — minimising VAT-sequence gaps that the legacy two-step
  // pattern (nextDocNumber() → upsertOffer()) produced whenever the
  // upsert failed after nextval().
  //   Format: OF-<year>-<NNNN>  (4-digit sequence)
  // When the client supplied an explicit `number` (rare, e.g. an admin
  // overriding the auto-gen), or when updating an existing record
  // (body.id present), we skip the atomic path and use the regular
  // upsertOffer so the client's number is respected.
  const useAtomicCreate = !body.id && !body.number;

  let created;
  if (useAtomicCreate) {
    // Atomic path: nextval() + INSERT in a single RPC. Removes the
    // unique-collision retry loop (the legacy loop bumped `body.number`
    // by +1 on collision, which could collide with the next legitimate
    // nextval() and burn another sequence value — cascading gaps).
    try {
      created = await auth.store.createDocWithNumber("offer", body as Record<string, unknown>) as any;
    } catch (e: any) {
      console.error("[offers.post] atomic create failed:", e);
      return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
    }
  } else {
    try {
      created = await auth.store.upsertOffer(body);
    } catch (e: any) {
      // Legacy retry-on-collision removed: the atomic path above handles
      // the auto-number case; this branch only runs when the client
      // supplied an explicit `number` or `id`, in which case a unique
      // collision is a genuine conflict that should surface as a 500
      // (not be silently retried with a bumped number).
      console.error("[offers.post] upsert failed:", e);
      return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
    }
  }
  await audit(auth.store, getAuthUser(auth), req, body.id ? "offer.update" : "offer.create", "offer", created.id, { number: created.number });

  // ── F-4: fire outbound webhooks (offer.created / offer.updated) ─────────
  // Fire-and-forget — webhook delivery failures must NEVER block the offer
  // mutation. `triggerWebhooks` already catches internally, but we double-
  // wrap with .catch() to be safe against any unexpected throw.
  void triggerWebhooks(
    auth.store,
    tid!,
    body.id ? "offer.updated" : "offer.created",
    "offer",
    created.id,
    created as unknown as Record<string, unknown>,
  ).catch((e) => console.error("[offers.post] webhook trigger failed:", e));

  // ── Fix 2: Auto-track commission obligation ─────────────────────────
  // When an offer is created from a trade calc that carried commission data
  // (agent_id + rate), automatically:
  //   1. Find or create a Deal linked to this offer
  //   2. Insert a `deal_commissions` row with status "pending" so the
  //      obligation is tracked from offer creation → invoice payment.
  //
  // Failures here MUST NOT fail the offer creation — we log + audit, and
  // the user can still create the commission manually from the deals view.
  if (!body.id && tradeCalcMeta._trade_calc_id && tradeCalcMeta._commission_agent_id) {
    try {
      const sb = getSupabase();

      // 1. Find or create a deal for this offer.
      let dealId: string | null = (created as any).deal_id || null;
      if (!dealId) {
        const dealRow = {
          tenant_id: tid,
          title: created.subject || `Deal for ${created.number}`,
          partner_id: created.partner_id,
          owner_id: "user" in auth ? auth.user.id : null,
          stage: "qualified",
          value: created.total,
          currency: created.currency,
          // Cost tracking — store buy cost so commission "profit_percent"
          // calculations work out of the box.
          buy_cost: tradeCalcMeta._landed_cost || 0,
          quantity: (created.items?.[0]?.quantity) || 0,
          unit: (created.items?.[0]?.unit) || "MT",
          commission_agent_id: tradeCalcMeta._commission_agent_id,
        };
        const { data: deal, error: dealErr } = await sb
          .from("deals")
          .insert(dealRow)
          .select()
          .maybeSingle();
        if (dealErr) throw dealErr;
        dealId = deal?.id || null;

        // Link offer to deal so future deal→commission flows can find it.
        if (dealId) {
          await sb.from("offers").update({ deal_id: dealId }).eq("id", created.id);
        }
      }

      // 2. Create pending commission record.
      if (dealId) {
        // Look up the agent's default settings so we can fall back when the
        // trade calc didn't carry an explicit rate / type.
        let commissionType = tradeCalcMeta._commission_type;
        let commissionRate = tradeCalcMeta._commission_rate;
        let commissionCurrency = created.currency || "USD";
        let commissionPerUnit = 0;
        let agentPartnerId: string | null = null;
        try {
          const { data: agent } = await sb
            .from("commission_agents")
            .select("*")
            .eq("id", tradeCalcMeta._commission_agent_id)
            .maybeSingle();
          if (agent) {
            commissionType = commissionType || agent.commission_type;
            commissionRate = commissionRate || Number(agent.commission_rate) || 0;
            commissionPerUnit = Number(agent.commission_per_unit) || 0;
            commissionCurrency = agent.commission_currency || commissionCurrency;
            agentPartnerId = agent.partner_id || null;
          }
        } catch { /* keep defaults */ }

        // Compute the commission amount. If the trade calc carried an
        // explicit `_commission_amount` (e.g. the calc UI computed it),
        // use it verbatim. Otherwise fall back to rate × base.
        const dealValue = Number(created.total) || 0;
        const dealProfit = Number(tradeCalcMeta._margin) || 0;
        // AUDIT17 / F10 — compute in the AGENT's commission currency via the
        // canonical store calculator (FX conversion + all type semantics).
        // The previous inline math multiplied the OFFER-currency total by the
        // rate and stored it with commission_currency=agent's — two paths for
        // the same deal produced different amounts (e.g. EUR offer 100k, 2%
        // USD agent, EUR/USD 1.10: inline $2,000 vs canonical $2,200).
        let calculatedCommission = tradeCalcMeta._commission_amount;
        if (!calculatedCommission && tradeCalcMeta._commission_agent_id) {
          try {
            calculatedCommission = await auth.store.calculateCommission(
              tradeCalcMeta._commission_agent_id,
              dealValue,
              dealProfit,
              Number((created.items?.[0]?.quantity)) || 0,
              (created.items?.[0]?.unit) || "MT",
              created.currency || "USD",
            );
          } catch (calcErr) {
            console.error("[offers.post] canonical commission calc failed, falling back to inline math:", calcErr);
          }
        }
        if (!calculatedCommission) {
          switch (commissionType) {
            case "profit_percent":
              calculatedCommission = (dealProfit * commissionRate) / 100;
              break;
            case "revenue_percent":
              calculatedCommission = (dealValue * commissionRate) / 100;
              break;
            case "per_unit":
              calculatedCommission = commissionPerUnit *
                (Number((created.items?.[0]?.quantity)) || 0);
              break;
            case "fixed":
              calculatedCommission = commissionRate;
              break;
            default:
              calculatedCommission = 0;
          }
        }

        const commissionRow = {
          tenant_id: tid,
          deal_id: dealId,
          agent_id: tradeCalcMeta._commission_agent_id,
          partner_id: agentPartnerId,
          commission_type: commissionType || "profit_percent",
          commission_rate: commissionRate,
          commission_per_unit: commissionPerUnit,
          commission_custom_formula: null,
          commission_currency: commissionCurrency,
          deal_value: dealValue,
          deal_profit: dealProfit,
          deal_quantity: Number((created.items?.[0]?.quantity)) || 0,
          deal_unit: (created.items?.[0]?.unit) || "MT",
          calculated_commission: Number(calculatedCommission) || 0,
          status: "pending",
          notes: `Auto-created from trade calculation ${tradeCalcMeta._trade_calc_id}`,
        };
        const { error: commErr } = await sb
          .from("deal_commissions")
          .insert(commissionRow);
        if (commErr) throw commErr;

        await audit(auth.store, getAuthUser(auth), req, "commission.obligation_created", "deal_commission", dealId, {
          agent_id: tradeCalcMeta._commission_agent_id,
          amount: calculatedCommission,
          trade_calc_id: tradeCalcMeta._trade_calc_id,
          offer_id: created.id,
          deal_id: dealId,
        });
      }
    } catch (e: any) {
      // Don't fail the offer creation — just log so ops can investigate.
      console.error("[offers.post] commission auto-track failed:", e);
    }
  }

  // FIX-ALL-2 / Fix 1 — strip `bank_details` from the create response
  // when the caller is an API key (parity with the GET list handler).
  const redactedCreated = redactOfferFields(created as any, auth);
  return NextResponse.json(redactedCreated);
  } catch (e: any) {
    console.error("[offers POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

// ── APM wrappers (task D-8) ──────────────────────────────────────────────
// Wraps GET/POST with response-time, slow-request, and error-rate metrics.
// See src/lib/monitoring/apm.ts for the buffer + dashboard wiring.
export const GET = withApm(_get, "GET /api/offers");
export const POST = withApm(_post, "POST /api/offers");
