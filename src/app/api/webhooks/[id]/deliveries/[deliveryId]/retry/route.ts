import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { signPayload, MAX_WEBHOOK_ATTEMPTS } from "@/lib/webhooks/deliver";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/[id]/deliveries/[deliveryId]/retry
 *
 * Manually re-attempt a failed webhook delivery. Triggered by the "Retry"
 * button in the webhooks UI's delivery history dialog.
 *
 * Behaviour:
 *   • Fetches the delivery row (scoped by webhook_id + tenant_id for tenant
 *     ownership).
 *   • Refuses to retry a delivery that's already "delivered" (idempotency —
 *     the receiver already saw this event).
 *   • Refuses to retry a delivery that has hit MAX_WEBHOOK_ATTEMPTS (5) —
 *     permanently failed deliveries need to be re-triggered from the
 *     source event, not retried blindly.
 *   • Re-signs the ORIGINAL payload (deterministic — same payload + same
 *     secret → same signature) so the receiver can dedupe by delivery.id.
 *   • Performs the HTTP POST and updates the delivery row.
 *
 * Auth: requires `webhooks.update` permission (admin-only, parity with the
 * mail-queue retry route which uses mail-queue.update).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; deliveryId: string }> },
) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (webhooks.update)
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "webhooks.update");
      if (_d) return _d;
    }
    // Feature gate (module_webhooks)
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_webhooks", auth.isSuperAdmin);
      if (_f) return _f;
    }

    // FIX-FUNC-5: resolve tenant via resolveTenantId so super-admins acting
    // under ?tenant_id=xxx can retry a tenant's webhook delivery. The
    // previous `if (!auth.tenantId)` returned 400 for super-admins (whose
    // own tenantId is null).
    const tid = resolveTenantId(auth, req);
    if (!tid) {
      return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
    }

    const { id: webhookId, deliveryId } = await params;

    // Tenant ownership: confirm the webhook belongs to this tenant before
    // touching any of its deliveries.
    const webhook = await auth.store.getWebhookById(webhookId, tid);
    if (!webhook) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const delivery = await auth.store.getWebhookDelivery(deliveryId);
    if (!delivery || delivery.webhook_id !== webhookId) {
      return NextResponse.json({ error: "Delivery not found." }, { status: 404 });
    }
    if (delivery.tenant_id !== tid) {
      // Defense-in-depth — should be unreachable because getWebhookById
      // already enforced tenant scope, but we double-check.
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    if (delivery.status === "delivered") {
      return NextResponse.json(
        { error: "This delivery already succeeded — no retry needed." },
        { status: 409 },
      );
    }
    if ((delivery.attempts ?? 0) >= MAX_WEBHOOK_ATTEMPTS) {
      return NextResponse.json(
        {
          error: `Maximum retry attempts (${MAX_WEBHOOK_ATTEMPTS}) reached. Re-trigger the event to create a new delivery.`,
        },
        { status: 409 },
      );
    }

    // Re-sign the ORIGINAL payload (deterministic — same payload + same
    // secret → same signature). The receiver can dedupe by delivery.id.
    const body = JSON.stringify(delivery.payload);
    const signature = signPayload(body, webhook.secret);
    const nextAttempt = (delivery.attempts ?? 0) + 1;

    // 9b-N2: re-validate the webhook URL before fetch. The cron retry
    // path (lib/webhooks/deliver.ts:332) re-validates to close DNS
    // rebinding between create-time and delivery-time — but the manual
    // retry path skipped the same re-check. A webhook created with a
    // benign hostname can be DNS-rebinded to 169.254.169.254 (AWS
    // metadata) by the time the admin clicks "Retry", leaking the
    // signed payload + tenant_id to an internal service.
    const { assertSafeWebhookUrl } = await import("@/lib/webhooks/url-validation");
    const urlCheck = await assertSafeWebhookUrl(webhook.url);
    if (!urlCheck.ok) {
      return NextResponse.json(
        { error: `URL re-validation failed: ${urlCheck.error}` },
        { status: 400 },
      );
    }

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let delivered = false;
    let errorMessage: string | null = null;

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": delivery.event,
          "X-Webhook-Signature": signature,
          "X-Webhook-Delivery": delivery.id,
          "User-Agent": "VELOS-Webhooks/1.0",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = response.status;
      responseBody = (await response.text().catch(() => "")).slice(0, 2000);
      delivered = response.ok;
    } catch (e: any) {
      errorMessage = e?.message || String(e) || "Unknown fetch error";
    }

    const now = new Date();
    const isFinalAttempt = nextAttempt >= MAX_WEBHOOK_ATTEMPTS;
    const backoffMs = [60_000, 120_000, 300_000, 900_000, 1_800_000][
      Math.min(nextAttempt - 1, 4)
    ];
    const nextAttemptAt =
      delivered || isFinalAttempt ? null : new Date(now.getTime() + backoffMs).toISOString();

    await auth.store.updateWebhookDelivery(delivery.id, {
      status: delivered ? "delivered" : "failed",
      attempts: nextAttempt,
      response_status: responseStatus,
      response_body: errorMessage
        ? `Error: ${errorMessage}`.slice(0, 2000)
        : responseBody,
      delivered_at: delivered ? now.toISOString() : null,
      next_attempt_at: nextAttemptAt,
    });

    // Mirror last_status onto the webhook row so the card summary updates.
    await auth.store.upsertWebhook({
      id: webhook.id,
      tenant_id: webhook.tenant_id ?? undefined,
      last_triggered_at: now.toISOString(),
      last_status: responseStatus,
    } as any);

    try {
      await audit(
        auth.store,
        auth.user,
        req,
        "webhook.delivery_retry",
        "webhook_delivery",
        delivery.id,
        {
          webhook_id: webhook.id,
          event: delivery.event,
          attempt: nextAttempt,
          success: delivered,
          response_status: responseStatus,
        },
      );
    } catch (auditErr) {
      console.error("[webhook retry] audit failed:", auditErr);
    }

    return NextResponse.json({
      ok: true,
      delivered,
      attempts: nextAttempt,
      response_status: responseStatus,
    });
  } catch (error: any) {
    console.error("[webhook retry]", error);
    return NextResponse.json(
      { error: sanitizeError(error) || "Internal server error" },
      { status: 500 },
    );
  }
}
