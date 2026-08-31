import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey, resolveTenantId, hasPermission, audit, sanitizeError, type AuthContext, type ApiKeyAuthContext, getAuthUser } from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { triggerWebhooks } from "@/lib/webhooks/deliver";

export const runtime = "nodejs";

type OfferBulkAction = "send" | "accept" | "reject" | "cancel" | "delete";

interface ResultRow {
  id: string;
  success: boolean;
  error?: string;
  status?: string;
}

/**
 * POST /api/offers/bulk
 * Body: { ids: string[], action: "send" | "accept" | "reject" | "cancel" | "delete", data?: {} }
 *
 * Applies the same action to every specified offer ID. Designed for the
 * list-view bulk action bar — the client passes the selected row IDs and a
 * single action label, the route loops over them server-side so the user
 * gets one round-trip instead of N.
 *
 * Safety:
 *  - Tenant ownership is verified per-row (a cross-tenant ID is silently
 *    skipped — it does NOT count toward the success tally).
 *  - Status transitions go through `validateStatusTransition` so the state
 *    machine is enforced (e.g. you can't bulk-accept an expired offer).
 *  - Super-admins bypass the state machine (parity with PUT /api/offers/[id]).
 *  - Hard-delete reuses the same status guard as DELETE /api/offers/[id]:
 *    only draft/cancelled/rejected offers can be hard-deleted.
 *
 * Caps:
 *  - Max 100 IDs per call (prevents a single bulk operation from saturating
 *    the event loop / DB pool).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    // Permission gate — the create/update/delete permission set covers the
    // actions we expose here. We check the broadest one ("offers:write") for
    // API keys; for session users the role-based permission catalog already
    // gates this route via requirePermission.
    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "offers:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "offers.update"); if (_d) return _d; } }
    // Feature gate (module_trade) — bulk ops are still trade-module actions.
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const _f = await requireFeature(_tid, "module_trade", _isSA); if (_f) return _f; }

    const tid = resolveTenantId(auth, req);

    let body: { ids?: unknown; action?: unknown; data?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const ids = body.ids;
    const action = body.action as OfferBulkAction | undefined;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No IDs provided." }, { status: 400 });
    }
    if (ids.length > 100) {
      return NextResponse.json({ error: "Maximum 100 items per bulk operation." }, { status: 400 });
    }
    const validActions: OfferBulkAction[] = ["send", "accept", "reject", "cancel", "delete"];
    if (!action || !validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(", ")}.` },
        { status: 400 },
      );
    }

    // Map action → target status (for status-mutating actions).
    const statusForAction: Record<Exclude<OfferBulkAction, "delete">, string> = {
      send: "sent",
      accept: "accepted",
      reject: "rejected",
      cancel: "cancelled",
    };

    const results: ResultRow[] = [];
    const succeededIds: string[] = [];

    for (const id of ids) {
      if (typeof id !== "string" || !id.trim()) {
        results.push({ id: String(id), success: false, error: "Invalid id." });
        continue;
      }
      try {
        const offer = await auth.store.getOffer(id);
        // Tenant ownership: skip silently if missing OR owned by another tenant.
        // Skipping (rather than 4xx) keeps the bulk operation resilient — one
        // bad ID in a selection of 50 should not abort the other 49.
        if (!offer) {
          results.push({ id, success: false, error: "Not found." });
          continue;
        }
        if (tid && offer.tenant_id !== tid) {
          results.push({ id, success: false, error: "Not found." });
          continue;
        }

        if (action === "delete") {
          // Reuse the same status guard as DELETE /api/offers/[id]: only
          // draft/cancelled/rejected offers can be hard-deleted.
          if (offer.status && !["draft", "cancelled", "rejected"].includes(offer.status)) {
            results.push({
              id,
              success: false,
              error: `Cannot delete a record in status '${offer.status}'.`,
            });
            continue;
          }
          // Void commissions tied to this offer's deal before hard-delete.
          try {
            if ((offer as { deal_id?: string | null }).deal_id) {
              const { cascadeCommissionOnDelete } = await import("@/lib/api/commission-cascade");
              await cascadeCommissionOnDelete(
                (offer as { deal_id: string }).deal_id,
                offer.tenant_id,
                `offer ${id} bulk-deleted`,
              );
            }
          } catch (e) {
            console.warn("[offers.bulk] commission cascade failed:", e);
          }
          await auth.store.deleteOffer(id);
          results.push({ id, success: true });
          succeededIds.push(id);
          continue;
        }

        // Status-mutating actions (send/accept/reject/cancel).
        const newStatus = statusForAction[action];
        const currentStatus = (offer.status || "draft") as string;

        // No-op if already in target status — still counts as success.
        if (currentStatus === newStatus) {
          results.push({ id, success: true, status: currentStatus });
          succeededIds.push(id);
          continue;
        }

        // State-machine enforcement (super-admin bypass — session auth only).
        const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
        if (!isSuperAdmin) {
          const t = validateStatusTransition("offer", currentStatus, newStatus);
          if (!t.valid) {
            results.push({ id, success: false, error: t.error });
            continue;
          }
        }

        const patch: Record<string, unknown> = { id, status: newStatus };
        // Stamp sent_at on first send (parity with /api/offers/[id]/send —
        // don't overwrite the original send timestamp on re-sends).
        if (action === "send" && !offer.sent_at) {
          patch.sent_at = new Date().toISOString();
        }

        const updated = await auth.store.upsertOffer(patch as Parameters<typeof auth.store.upsertOffer>[0]);
        results.push({ id, success: true, status: updated.status });
        succeededIds.push(id);

        // Inventory cascade on bulk-accept (parity with PUT /api/offers/[id]).
        if (action === "accept") {
          try {
            const { deductStockForOffer } = await import("@/lib/api/inventory-cascade");
            const updatedAsRecord = updated as unknown as { items?: unknown[]; number?: string | null; partner_id?: string | null; id?: string };
            const itemsRaw = Array.isArray(updatedAsRecord.items)
              ? (updatedAsRecord.items as Array<Record<string, unknown>>)
              : [];
            // Coerce to the shape DeductStockOpts expects. Only `product_id`
            // and `quantity` are read by deductStockForOffer, so a minimal
            // cast is enough — unknown columns are ignored.
            const items = itemsRaw.map((it) => ({
              product_id: (it?.product_id as string | null | undefined) ?? null,
              quantity: (it?.quantity as number | string | null | undefined) ?? null,
            }));
            await deductStockForOffer({
              tenantId: offer.tenant_id,
              offerId: String(updatedAsRecord.id || id),
              offerNumber: updatedAsRecord.number || null,
              partnerId: updatedAsRecord.partner_id || offer.partner_id || null,
              items,
              source: "admin",
            });
          } catch (e) {
            console.error("[offers.bulk] inventory cascade failed:", e);
          }
          try {
            const updatedAsRecord2 = updated as unknown as { deal_id?: string | null };
            if (updatedAsRecord2.deal_id) {
              const { createCommissionOnOfferAccepted } = await import("@/lib/api/commission-cascade");
              void createCommissionOnOfferAccepted(
                auth.store,
                updatedAsRecord2.deal_id,
                offer.tenant_id,
              ).catch(() => {});
            }
          } catch (e) {
            console.warn("[offers.bulk] commission auto-create failed:", e);
          }
        }

        // Fire webhook fire-and-forget so a slow receiver doesn't block the loop.
        void triggerWebhooks(
          auth.store,
          offer.tenant_id,
          "offer.updated",
          "offer",
          id,
          updated as unknown as Record<string, unknown>,
        ).catch((e) => console.error("[offers.bulk] webhook trigger failed:", e));
      } catch (e) {
        results.push({
          id,
          success: false,
          error: sanitizeError(e),
        });
      }
    }

    // Single audit entry for the bulk operation — per-row audit entries
    // would balloon the audit log size by 100x for a typical bulk send.
    await audit(
      auth.store,
      getAuthUser(auth),
      req,
      `offers.bulk_${action}`,
      "offers",
      succeededIds.join(","),
      { action, count: ids.length, successCount: succeededIds.length },
    );

    return NextResponse.json({
      results,
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
    });
  } catch (e) {
    console.error("[offers.bulk]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
