import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";
import { sendEmail, documentEmail } from "@/lib/email/service";
import { generatePdf } from "@/lib/pdf/generator";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";
// AUDIT2-LOGIC-UX H10 — rate-limit + idempotency for offer send. Previously
// an admin could re-send an already-accepted/cancelled/expired/rejected
// offer (the email would fire even though the status was terminal) and
// spam the recipient. Now: (1) state guard — refuse send for terminal
// states; (2) per-(offer-id) 60s idempotency — refuse re-sends inside the
// window; (3) per-(offer-id) 5-per-15-min rate limit as the backstop.
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// 60s minimum interval between sends to the SAME offer. Matches the
// pattern from /api/portal-access/[id]/invite — generous for a legit
// "I want to re-send" intent, tight enough to stop a runaway loop.
const OFFER_RESEND_MIN_INTERVAL_MS = 60 * 1000;

// Final / non-sendable offer states. Sending an offer in any of these
// would email a stale document to the partner (e.g. a cancelled offer
// the partner already saw rejected, an accepted offer that's already
// been converted to a deal/invoice). Send is only meaningful from
// draft | sent | viewed | countered.
const TERMINAL_OFFER_STATES = new Set(["cancelled", "expired", "rejected", "accepted"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (offers.send)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "offers.send"); if (_d) return _d; } /* requirePermission wired */

  if (auth.user.role !== "admin" && auth.user.role !== "super_admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const { id } = await params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // Body is optional — empty body means "send to portal only, no email"
  }
  const toEmail: string | undefined = body?.email;
  // AUDIT19 / F10 — validate the optional override email before it reaches
  // sendEmail (parity with settings/test-smtp which already runs this
  // check). A malformed address becomes an SMTP 500 / header-injection
  // surface; the canonical validator rejects both early and cheaply.
  if (toEmail !== undefined) {
    if (typeof toEmail !== "string" || toEmail === "") {
      return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
    }
    const { isValidEmail } = await import("@/lib/validation/email");
    if (!isValidEmail(toEmail)) {
      return NextResponse.json({ error: `Invalid email address: ${toEmail}` }, { status: 400 });
    }
  }

  try {
    // Fetch the offer
    const offer = await auth.store.getOffer(id);
    if (!offer) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }
    // Tenant ownership check
    if (!auth.isSuperAdmin && offer.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    }

    // ── P1-1 / Feature 2: Separation-of-Duties check ─────────────────
    // The "send" action IS the approval step for an offer (once sent,
    // the offer is locked). The creator (`offer.owner_id`) cannot
    // approve their own offer unless they are a super_admin.
    // `assertNoSoDViolation` short-circuits for super_admin (never
    // blocked) before consulting the SoD rules.
    {
      const sod = await assertNoSoDViolation(auth, offer.owner_id, {
        create_perm: "offers.create",
        approve_perm: "offers.send",
      });
      if (sod) return sod;
    }

    // AUDIT2-LOGIC-UX H10 — state guard. Refuse to send an offer that's
    // in a terminal / non-sendable state. Previously an admin could
    // re-send an accepted offer (which the partner already converted to
    // a deal/invoice) or a cancelled / rejected / expired offer — the
    // status stayed put but the PDF was still emailed, spamming the
    // recipient with a stale document. Super-admin bypasses so they can
    // correct bad data.
    if (!auth.isSuperAdmin && offer.status && TERMINAL_OFFER_STATES.has(offer.status)) {
      return NextResponse.json(
        { error: `Cannot send a ${offer.status} offer.` },
        { status: 400 },
      );
    }

    // AUDIT2-LOGIC-UX H10 — idempotency guard. If this offer was sent
    // within the last OFFER_RESEND_MIN_INTERVAL_MS, refuse to re-send
    // (prevents the "spam re-send" bug where a double-click or a stale
    // UI effect fires the send twice in seconds). The guard is per
    // offer-id (not per-recipient) — the audit log shows a single
    // "send_email" event regardless of recipient, so it's safe to
    // deduplicate at the offer level. Super-admin bypasses.
    if (!auth.isSuperAdmin && offer.sent_at) {
      const lastSendMs = new Date(offer.sent_at).getTime();
      const elapsedMs = Date.now() - lastSendMs;
      if (Number.isFinite(lastSendMs) && elapsedMs < OFFER_RESEND_MIN_INTERVAL_MS) {
        const retryAfterSec = Math.ceil((OFFER_RESEND_MIN_INTERVAL_MS - elapsedMs) / 1000);
        return NextResponse.json(
          {
            error: `This offer was sent ${elapsedMs < 60_000 ? "just now" : Math.floor(elapsedMs / 1000) + "s ago"}. Please wait ${retryAfterSec}s before re-sending to avoid spamming the recipient.`,
            retry_after: retryAfterSec,
            already_sent: true,
          },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // AUDIT2-LOGIC-UX H10 — per-offer-id rate limit (defense-in-depth).
    // 5 sends per 15 min per offer. The idempotency guard above is the
    // primary defense; this is the backstop (clock skew, concurrent
    // races on sent_at). Super-admin bypasses (the rate limiter is
    // per-IP/per-key globally — we skip the check for super_admin so
    // they can correct bad data without tripping the cap).
    if (!auth.isSuperAdmin) {
      const rl = await checkRateLimit(`offer-send:${id}`, 5, 15 * 60 * 1000);
      if (!rl.allowed) {
        const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
        return NextResponse.json(
          { error: "Too many sends for this offer recently. Please try again later.", retry_after: retryAfterSec },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // Fetch partner for email info / portal notification
    const partner = offer.partner_id ? await auth.store.getPartner(offer.partner_id) : null;

    // Resolve tenant (required for PDF generation and notification)
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) {
      return NextResponse.json({ error: "tenant_id query parameter is required for super-admin actions." }, { status: 400 });
    }

    // ─── Email send (optional) ───
    // If `email` is provided in the body, generate a PDF and email it to the
    // recipient. If `email` is missing, we skip the email step and only mark
    // the offer as sent + push a portal notification.
    let emailResult: { success: boolean; skipped?: boolean; error?: string; queued?: boolean } = { success: true, skipped: true };
    if (toEmail) {
      const result = await generatePdf({ docType: "offer", docId: id, tenantId });
      const pdfBuffer = Buffer.from(result.buffer);

      const { subject, html } = documentEmail({
        partnerName: partner?.name || "Client",
        docType: "offer",
        docNumber: offer.number || id,
        tenantName: (await auth.store.getTenant(tenantId))?.name || "VELOS Trade",
        amount: offer.total != null ? String(offer.total) : undefined,
        currency: offer.currency || undefined,
        dueDate: offer.valid_until || undefined,
      });

      emailResult = await sendEmail({
        to: toEmail,
        subject,
        html,
        tenantId,
        // AUDIT16 — entity reference for PDF regeneration on retry +
        // queued flag so we don't mark the offer sent when the email was
        // only parked in the queue (no provider configured).
        entityType: "offer",
        entityId: id,
        attachments: [{
          filename: `offer-${offer.number || id}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        }],
      });
    }

    // Promote status draft→sent and stamp sent_at (only on first successful send).
    // AUDIT16 — queued ≠ delivered (see invoice send route for rationale).
    const delivered = emailResult.success && !emailResult.queued;
    if (delivered) {
      try {
        // Validate the status transition (Re-Audit-2 N4) — only allow
        // draft→sent. Other states (e.g. accepted) are not allowed via this
        // send endpoint — the user must use the PUT /api/offers/[id] route
        // to move to other states. Super-admins bypass.
        const newStatus = offer.status === "draft" || !offer.status ? "sent" : offer.status;
        if (newStatus !== offer.status && !auth.isSuperAdmin) {
          const t = validateStatusTransition("offer", offer.status || "draft", newStatus);
          if (!t.valid) {
            return NextResponse.json({ error: t.error }, { status: 400 });
          }
        }
        // CRITICAL FIX (audit P2-6): only set sent_at on FIRST send — don't
        // overwrite the original send timestamp on subsequent re-sends.
        const updateFields: any = { status: newStatus };
        if (!offer.sent_at) {
          updateFields.sent_at = new Date().toISOString();
        }
        await auth.store.upsertOffer({ id, ...updateFields } as any);
      } catch (e) { console.warn("[offer.send] status bump failed:", e); }
    }

    // ─── Portal notification ───
    // Notify the partner's portal client that a new offer is available.
    // (AUDIT16: only when actually delivered.)
    if (delivered && offer.partner_id) {
      try {
        await notify({
          tenantId: offer.tenant_id,
          userId: null,
          partnerId: offer.partner_id,
          type: "offer_sent",
          title: `New offer: ${offer.number || id}`,
          message: offer.subject || `Offer ${offer.number || id} has been sent to you`,
          entityType: "offer",
          entityId: offer.id,
          actionLabel: "View",
        });
      } catch (e) {
        console.error("[offer.send] portal notification failed:", e);
        // Don't fail the send if notification fails
      }
    }

    await audit(auth.store, auth.user, req, "offer.send_email", "offer", id, { to: toEmail || "(portal only)" });

    // AUDIT17 / P2-3 — a queued email (no provider configured) is NOT a
    // delivery: return 409 with an actionable message (same semantics as
    // the LOI send route) instead of a bare 200 { queued: true } that the
    // views toasted as "The offer sent".
    if (emailResult.queued) {
      return NextResponse.json(
        {
          error:
            "No email provider is configured for this tenant (Settings → Communications). " +
            "The offer email is queued in the Mail Queue — configure a provider, then retry. " +
            "The offer status stays draft.",
          queued: true,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(emailResult);
  } catch (e) {
    console.error("[offer.send]", e);
    return NextResponse.json({ error: "Failed to send email." }, { status: 500 });
  }
}
