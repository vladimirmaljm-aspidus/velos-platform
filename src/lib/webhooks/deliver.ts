// Webhook delivery module — signs payloads, creates delivery records, and
// performs the actual HTTP POST to the registered endpoint.
//
// Used by API route handlers (offers, invoices, partners, …) via
// `triggerWebhooks()` and by the `/api/cron/webhook-retry` cron endpoint via
// `retryFailedDeliveries()`.
//
// Signing scheme: HMAC-SHA256 of the raw JSON body using the webhook's
// `secret`. Receivers verify by recomputing the HMAC and comparing with the
// `X-Webhook-Signature` header (constant-time via `verifySignature`).
//
// Retry policy: up to 5 attempts with exponential-ish backoff (60s, 2m, 5m,
// 15m, 30m). Failed deliveries are retried by the cron endpoint; the
// `next_attempt_at` column gates the next retry.
//
// PII SANITIZATION (P3 / task C-8): `triggerWebhooks()` calls
// `sanitizeWebhookPayload()` on the `data` field BEFORE persisting the
// delivery row and BEFORE signing + sending the HTTP POST. This strips
// sensitive fields (passwords, tokens, secrets, payment data) so they
// never leave the platform. The signed body therefore contains the
// sanitized payload — receivers cannot recover the stripped fields even
// if they have the webhook secret (the secret only verifies integrity, it
// doesn't decrypt anything). See `sanitizeWebhookPayload` doc for the
// exact field list.

import { createHmac, timingSafeEqual } from "crypto";
import type { Store } from "@/lib/data/store";
import type { Webhook, WebhookDelivery, WebhookPayload } from "@/lib/supabase/types";

// Per-attempt backoff schedule (milliseconds). After attempt N fails, the
// next retry is scheduled at `next_attempt_at = now + BACKOFF_MS[N]`.
// Index 0 is the backoff applied after the 1st failure, etc.
const BACKOFF_MS = [
  60_000,       // 1 min  (after attempt 1)
  120_000,      // 2 min  (after attempt 2)
  300_000,      // 5 min  (after attempt 3)
  900_000,      // 15 min (after attempt 4)
  1_800_000,    // 30 min (after attempt 5 — final, no more retries)
];

export const MAX_WEBHOOK_ATTEMPTS = 5;
export const WEBHOOK_HTTP_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = "VELOS-Webhooks/1.0";

// ── P3 / task C-8 — PII sanitization for webhook payloads ────────────────
// Webhook `data` payloads include full entity data, which may contain PII
// (customer names, emails, prices, internal IDs, etc.) or sensitive
// fields (passwords, tokens, secrets, payment data). Without sanitization,
// this data is sent to external URLs — a PII leak if the webhook endpoint
// is misconfigured (e.g. logged at the receiver, or pointed at a
// third-party integration).
//
// The list below is intentionally broad — we'd rather over-strip
// (breaking a webhook that legitimately needed a now-stripped field, which
// the receiver can fix by using a different field name) than under-strip
// (leaking PII). Substring matching (`.includes`) catches compound names
// like `portal_token`, `smtp_password`, `private_key_pem`, etc. without
// having to enumerate every variant.
//
// ADDING A NEW SENSITIVE FIELD: append the lowercase substring to the
// array. Do NOT add a field name that is a common business term — e.g.
// "name" or "email" — those are NOT stripped because they ARE the
// payload's purpose (the receiver signed up to know that offer X was
// sent to customer Y).
const PII_FIELD_MARKERS = [
  // Authentication / secrets
  "password",
  "password_hash",
  "passwd",
  "pwd",
  "token",
  "secret",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
  // Platform-internal auth fields
  "portal_token",
  "session_token",
  "refresh_token",
  "bearer",
  "authorization",
  // Email / SMTP infrastructure
  "smtp_password",
  "smtp_pass",
  "mail_password",
  // Payment / financial secrets (NOT prices — those are business data)
  "credit_card",
  "card_number",
  "cvv",
  "cvc",
  "iban_secret",
  // Vault / encryption keys
  "encryption_key",
  "master_key",
  "vault_key",
  // Personal identity numbers (country-specific — broad on purpose)
  "ssn",
  "national_id",
  "tax_id_secret",
];

/**
 * Returns true if the given field name matches any PII marker (case-
 * insensitive substring match). Used by `sanitizeWebhookPayload` to decide
 * whether to strip a field from a webhook payload before sending.
 *
 * Exported for tests so the marker list can be asserted against without
 * having to round-trip through the full sanitiser.
 */
export function isPiiField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return PII_FIELD_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Recursively strip PII / secret fields from a webhook payload.
 *
 * Behaviour:
 *   • Top-level + nested object keys are checked against `PII_FIELD_MARKERS`
 *     (substring match, case-insensitive). Matching keys are dropped
 *     entirely (their values are NOT sent).
 *   • Arrays are sanitised element-by-element (each element is passed back
 *     through this function).
 *   • Primitive values (string / number / boolean / null) are passed
 *     through unchanged.
 *   • The function is pure — it does NOT mutate the input. A shallow copy
 *     is made at each object level so the caller's `data` reference is
 *     untouched (the calling route may still need the unsanitised object
 *     for its own audit log).
 *
 * The returned object is what gets JSON-stringified, signed, persisted to
 * `webhook_deliveries.payload`, and POSTed to the receiver. The signed
 * body therefore contains the SANITISED payload — receivers cannot
 * recover the stripped fields even if they have the webhook secret.
 */
export function sanitizeWebhookPayload(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeWebhookPayload(item));
  }
  if (typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (isPiiField(key)) {
        // Strip — do NOT include the field at all (not even `null`, which
        // would leak the fact that the field exists).
        continue;
      }
      sanitized[key] = sanitizeWebhookPayload(value);
    }
    return sanitized;
  }
  // Primitive — pass through.
  return data;
}

/**
 * Sign a webhook payload string with HMAC-SHA256 using the webhook secret.
 * Returns a hex-encoded digest.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify a webhook signature (receiver-side verification).
 * Constant-time comparison prevents timing oracle attacks.
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = signPayload(payload, secret);
  // Length check first (timingSafeEqual requires equal-length buffers).
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Trigger webhooks for an event. Called from business logic (e.g. after offer
 * creation, invoice payment, partner creation).
 *
 * Behaviour:
 *   • Looks up all ACTIVE webhooks for `tenantId` whose `events` array
 *     contains `event` OR the wildcard `"*"`.
 *   • For each matching webhook: creates a delivery record (status="pending"),
 *     performs the HTTP POST, and updates the delivery with the result.
 *   • Updates the webhook's `last_triggered_at` / `last_status` columns so
 *     the UI shows the most recent delivery.
 *   • Errors from any single webhook do NOT affect the others — each is
 *     tried independently and failures are recorded, not thrown.
 *
 * This function is ASYNC and SHOULD be awaited (or `.catch()`-ed as
 * fire-and-forget) by callers. It never throws — all errors are caught and
 * logged so the calling route handler can't fail because of webhook delivery.
 */
export async function triggerWebhooks(
  store: Store,
  tenantId: string,
  event: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  // Defensive: never trigger webhooks without a tenant scope — that would
  // broadcast platform-internal events to every tenant's endpoints.
  if (!tenantId) {
    console.warn("[webhooks] triggerWebhooks called with empty tenantId — skipping");
    return;
  }

  let webhooks: Webhook[] = [];
  try {
    webhooks = await store.listWebhooks(tenantId);
  } catch (e) {
    console.error("[webhooks] listWebhooks failed:", e);
    return;
  }

  const matching = webhooks.filter(
    (w) => w.active && Array.isArray(w.events) && (w.events.includes(event) || w.events.includes("*")),
  );
  if (matching.length === 0) return;

  const payload: WebhookPayload = {
    event,
    entity_type: entityType,
    entity_id: entityId,
    tenant_id: tenantId,
    timestamp: new Date().toISOString(),
    // P3 / task C-8 — sanitize the payload before sending. This strips
    // PII / secret fields (passwords, tokens, api keys, payment data)
    // from the entity data so they never leave the platform. The
    // sanitiser is pure (does not mutate the caller's `data` reference)
    // and recursive (handles nested objects + arrays). See
    // `sanitizeWebhookPayload` doc for the field-marker list.
    //
    // The sanitised payload is what gets:
    //   1. Persisted to `webhook_deliveries.payload` (audit trail)
    //   2. JSON-stringified and signed with the webhook secret
    //   3. POSTed to the receiver
    // So the signed body contains the SANITISED payload — receivers
    // cannot recover the stripped fields even if they have the secret.
    data: sanitizeWebhookPayload(data) as Record<string, unknown>,
  };

  // Deliver sequentially (low traffic; avoids flooding remote endpoints if a
  // single event fan-outs to many webhooks). Each delivery is wrapped in its
  // own try/catch so one failure doesn't skip the rest.
  for (const webhook of matching) {
    try {
      await createAndDeliver(store, webhook, payload);
    } catch (e) {
      console.error(`[webhooks] delivery to ${webhook.url} (${webhook.id}) failed:`, e);
    }
  }
}

/**
 * Create a delivery record and perform the initial HTTP POST.
 */
async function createAndDeliver(
  store: Store,
  webhook: Webhook,
  payload: WebhookPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhook.secret);

  // 1. Persist the delivery record as "pending" so we have an audit trail
  //    even if the HTTP call crashes the process.
  let delivery: WebhookDelivery;
  try {
    delivery = await store.createWebhookDelivery({
      webhook_id: webhook.id,
      tenant_id: payload.tenant_id,
      event: payload.event,
      payload,
      status: "pending",
      attempts: 0,
    });
  } catch (e) {
    // If we can't even create the delivery row, we can't track retries —
    // log and bail (the calling route must NOT fail because of this).
    console.error(`[webhooks] createWebhookDelivery failed for ${webhook.id}:`, e);
    return;
  }

  // 2. Perform the actual delivery.
  await attemptDelivery(store, webhook, delivery, body, signature, 1);
}

/**
 * Perform a single HTTP POST attempt for a delivery and update the row with
 * the result. Used by both the initial delivery (attempt=1) and the retry
 * path (attempt=N).
 */
async function attemptDelivery(
  store: Store,
  webhook: Webhook,
  delivery: WebhookDelivery,
  body: string,
  signature: string,
  attemptNumber: number,
): Promise<void> {
  const startedAt = Date.now();
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
        "User-Agent": WEBHOOK_USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_HTTP_TIMEOUT_MS),
    });
    responseStatus = response.status;
    responseBody = (await response.text().catch(() => "")).slice(0, 2000);
    delivered = response.ok; // 2xx → delivered
  } catch (e: any) {
    // Network error, DNS failure, timeout, etc.
    errorMessage = e?.message || String(e) || "Unknown fetch error";
  }

  const now = new Date();
  const isFinalAttempt = attemptNumber >= MAX_WEBHOOK_ATTEMPTS;
  const backoffIdx = Math.min(attemptNumber - 1, BACKOFF_MS.length - 1);
  const nextAttemptAt =
    delivered || isFinalAttempt
      ? null
      : new Date(now.getTime() + BACKOFF_MS[backoffIdx]).toISOString();

  const update: Partial<WebhookDelivery> = {
    status: delivered ? "delivered" : "failed",
    attempts: attemptNumber,
    response_status: responseStatus,
    response_body: errorMessage
      ? `Error: ${errorMessage}`.slice(0, 2000)
      : responseBody,
    delivered_at: delivered ? now.toISOString() : null,
    next_attempt_at: nextAttemptAt,
  };

  try {
    await store.updateWebhookDelivery(delivery.id, update);
  } catch (e) {
    // If we can't update the delivery row, we still delivered (or tried to)
    // — log and continue. The webhook itself may have succeeded.
    console.error(`[webhooks] updateWebhookDelivery failed for ${delivery.id}:`, e);
  }

  // Mirror last_triggered_at / last_status onto the webhook row so the UI
  // can show "Last triggered: 2s ago" + the status badge without joining
  // the deliveries table.
  try {
    await store.upsertWebhook({
      id: webhook.id,
      tenant_id: webhook.tenant_id ?? undefined,
      last_triggered_at: now.toISOString(),
      last_status: responseStatus,
    } as any);
  } catch (e) {
    // Non-fatal — delivery already logged.
    console.warn(`[webhooks] update webhooks.last_status failed for ${webhook.id}:`, e);
  }

  void startedAt; // (reserved for future slow-endpoint telemetry)
}

/**
 * Retry failed deliveries. Called by the `/api/cron/webhook-retry` cron
 * endpoint (every 5 minutes).
 *
 * Iterates over deliveries where status='failed', attempts < 5, and
 * (next_attempt_at IS NULL OR next_attempt_at <= now). Re-fetches the
 * webhook (it may have been disabled or deleted since the original
 * delivery), re-signs the original payload, and re-POSTs.
 *
 * Never throws — all errors are caught per-delivery.
 *
 * Returns a summary for the cron endpoint to log. The summary's
 * `delivered` counter is computed by RE-FETCHING each delivery row
 * after the retry attempt — `attemptDelivery` updates the row's
 * `status` to "delivered" on a 2xx response, so reading the row back
 * is the authoritative source of truth. (Previously the counter was
 * bumped only via a `void delivered;` placeholder and was always 0,
 * which made the audit log + cron dashboard misleading.)
 */
export async function retryFailedDeliveries(
  store: Store,
  limit = 50,
): Promise<{ retried: number; delivered: number; stillFailing: number; skipped: number }> {
  let failed: WebhookDelivery[] = [];
  try {
    failed = await store.listFailedWebhookDeliveries(limit);
  } catch (e) {
    console.error("[webhooks] listFailedWebhookDeliveries failed:", e);
    return { retried: 0, delivered: 0, stillFailing: 0, skipped: 0 };
  }

  let retried = 0;
  let delivered = 0;
  let stillFailing = 0;
  let skipped = 0;

  for (const delivery of failed) {
    retried++;
    // Re-fetch the webhook — it may have been deleted or deactivated since
    // the original delivery. In that case mark the delivery as permanently
    // failed and move on.
    let webhook: Webhook | null = null;
    try {
      webhook = await store.getWebhookById(delivery.webhook_id, delivery.tenant_id);
    } catch (e) {
      console.warn(`[webhooks] retry: getWebhookById failed for ${delivery.webhook_id}:`, e);
    }
    if (!webhook) {
      // Webhook was deleted — mark delivery as permanently failed (attempts
      // = MAX so it won't be retried again).
      try {
        await store.updateWebhookDelivery(delivery.id, {
          status: "failed",
          attempts: MAX_WEBHOOK_ATTEMPTS,
          next_attempt_at: null,
          response_body: (delivery.response_body || "") + "\n[retry] Webhook no longer exists — giving up.",
        });
      } catch { /* non-fatal */ }
      skipped++;
      continue;
    }
    if (!webhook.active) {
      // Webhook was deactivated — skip silently, but keep it retryable so
      // that if it's reactivated later, the backlog clears.
      skipped++;
      continue;
    }

    // Re-sign the ORIGINAL payload (deterministic: same payload + same
    // secret → same signature). The receiver sees a consistent signature
    // across retries, which is important for idempotency checks on their
    // side (e.g. deduplication by delivery.id).
    const body = JSON.stringify(delivery.payload);
    const signature = signPayload(body, webhook.secret);
    const nextAttempt = (delivery.attempts ?? 0) + 1;

    try {
      await attemptDelivery(store, webhook, delivery, body, signature, nextAttempt);
      // Re-fetch the delivery row to read the actual outcome. The
      // `attemptDelivery` helper updated `status` (delivered|failed),
      // `attempts`, `response_status`, `delivered_at`, and
      // `next_attempt_at`. The authoritative outcome is on the row.
      let outcome: WebhookDelivery | null = null;
      try {
        outcome = await store.getWebhookDelivery?.(delivery.id) ?? null;
      } catch (e) {
        // Helper may not implement getWebhookDelivery (older stores). Fall
        // back to the heuristic below — we lose accuracy but don't crash.
        console.warn(`[webhooks] retry: getWebhookDelivery(${delivery.id}) failed:`, e);
      }
      if (outcome?.status === "delivered") {
        delivered++;
      } else if (nextAttempt >= MAX_WEBHOOK_ATTEMPTS) {
        // Final attempt + still failed — count as permanently failing.
        stillFailing++;
      } else {
        // Non-final retry that didn't deliver (still in status=failed).
        stillFailing++;
      }
    } catch (e) {
      console.error(`[webhooks] retry attempt ${nextAttempt} for ${delivery.id} failed:`, e);
      stillFailing++;
    }
  }

  return { retried, delivered, stillFailing, skipped };
}
