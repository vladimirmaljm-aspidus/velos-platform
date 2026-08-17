import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthOrApiKey,
  resolveTenantId,
  hasPermission,
  audit,
  sanitizeError,
  type AuthContext,
  type ApiKeyAuthContext,
} from "@/lib/api/helpers";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { triggerWebhooks } from "@/lib/webhooks/deliver";

export const runtime = "nodejs";

function getAuthUser(auth: AuthContext | ApiKeyAuthContext) {
  if ("user" in auth) return auth.user;
  return { id: `api:${auth.apiKeyId}`, username: auth.apiKeyName, tenant_id: auth.tenantId };
}

type InvoiceBulkAction = "send" | "mark_paid" | "mark_sent" | "cancel" | "delete";

interface ResultRow {
  id: string;
  success: boolean;
  error?: string;
  status?: string;
}

/**
 * POST /api/invoices/bulk
 * Body: { ids: string[], action: "send" | "mark_paid" | "mark_sent" | "cancel" | "delete" }
 *
 * Mirrors /api/offers/bulk but for invoices. The actions exposed here are
 * the safe subset that does NOT require an email round-trip (use
 * /api/invoices/[id]/send for that). "send" here is a status-only promotion
 * to "sent" (no email); the list-view bulk action bar treats the
 * per-row "send" (with email) as a separate action.
 *
 * Caps:
 *  - Max 100 IDs per call.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuthOrApiKey(req);
    if (auth instanceof NextResponse) return auth;

    if ("apiKeyId" in auth && !hasPermission(auth.permissions, "invoices:write")) {
      return NextResponse.json({ error: "Insufficient permissions." }, { status: 403 });
    }
    { const { requirePermission } = await import("@/lib/permissions/can");
      if (!("apiKeyId" in auth)) { const _d = requirePermission(auth, "invoices.update"); if (_d) return _d; } }
    // Feature gate (module_finance)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _tid = ("apiKeyId" in auth) ? auth.tenantId : auth.tenantId;
      const _isSA = !("apiKeyId" in auth) && auth.isSuperAdmin;
      const _f = await requireFeature(_tid, "module_finance", _isSA); if (_f) return _f; }

    const tid = resolveTenantId(auth, req);

    let body: { ids?: unknown; action?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const ids = body.ids;
    const action = body.action as InvoiceBulkAction | undefined;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No IDs provided." }, { status: 400 });
    }
    if (ids.length > 100) {
      return NextResponse.json({ error: "Maximum 100 items per bulk operation." }, { status: 400 });
    }
    const validActions: InvoiceBulkAction[] = ["send", "mark_paid", "mark_sent", "cancel", "delete"];
    if (!action || !validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${validActions.join(", ")}.` },
        { status: 400 },
      );
    }

    // Map action → target status.
    const statusForAction: Record<Exclude<InvoiceBulkAction, "delete">, string> = {
      send: "sent",
      mark_sent: "sent",
      mark_paid: "paid",
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
        const invoice = await auth.store.getInvoice(id);
        if (!invoice) {
          results.push({ id, success: false, error: "Not found." });
          continue;
        }
        if (tid && invoice.tenant_id !== tid) {
          results.push({ id, success: false, error: "Not found." });
          continue;
        }

        if (action === "delete") {
          // Status guard: only draft/cancelled invoices can be hard-deleted
          // (parity with DELETE /api/invoices/[id]).
          if (invoice.status && !["draft", "cancelled"].includes(invoice.status)) {
            results.push({
              id,
              success: false,
              error: `Cannot delete a record in status '${invoice.status}'.`,
            });
            continue;
          }
          await auth.store.deleteInvoice(id);
          results.push({ id, success: true });
          succeededIds.push(id);
          continue;
        }

        const newStatus = statusForAction[action];
        const currentStatus = (invoice.status || "draft") as string;

        if (currentStatus === newStatus) {
          results.push({ id, success: true, status: currentStatus });
          succeededIds.push(id);
          continue;
        }

        // State-machine enforcement (super-admin bypass — session auth only).
        const isSuperAdmin = !("apiKeyId" in auth) && auth.isSuperAdmin;
        if (!isSuperAdmin) {
          const t = validateStatusTransition("invoice", currentStatus, newStatus);
          if (!t.valid) {
            results.push({ id, success: false, error: t.error });
            continue;
          }
        }

        const patch: Record<string, unknown> = { id, status: newStatus };
        if ((action === "send" || action === "mark_sent") && !invoice.sent_at) {
          patch.sent_at = new Date().toISOString();
        }
        if (action === "mark_paid" && !invoice.paid_at) {
          patch.paid_at = new Date().toISOString();
        }

        const updated = await auth.store.upsertInvoice(patch as Parameters<typeof auth.store.upsertInvoice>[0]);
        results.push({ id, success: true, status: updated.status });
        succeededIds.push(id);

        void triggerWebhooks(
          auth.store,
          invoice.tenant_id,
          "invoice.updated",
          "invoice",
          id,
          updated as unknown as Record<string, unknown>,
        ).catch((e) => console.error("[invoices.bulk] webhook trigger failed:", e));
      } catch (e) {
        results.push({
          id,
          success: false,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    await audit(
      auth.store,
      getAuthUser(auth),
      req,
      `invoices.bulk_${action}`,
      "invoices",
      succeededIds.join(","),
      { action, count: ids.length, successCount: succeededIds.length },
    );

    return NextResponse.json({
      results,
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
    });
  } catch (e) {
    console.error("[invoices.bulk]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
