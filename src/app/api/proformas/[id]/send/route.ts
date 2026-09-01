import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";
import { sendEmail, documentEmail } from "@/lib/email/service";
import { generatePdf } from "@/lib/pdf/generator";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";
// FIX-PRODUCTS-DOCS / Fix 5 — parity with offers send route: terminal-
// state guard + sent_at first-send guard + 5/15min rate limit. The
// previous proforma send route had NONE of these — a paid/expired/
// rejected proforma could be re-sent, sent_at was overwritten on every
// re-send (audit-trail corruption), and there was no backstop against
// a runaway re-send loop.
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// 60s minimum interval between sends to the SAME proforma. Matches the
// pattern from /api/offers/[id]/send/route.ts.
const PROFORMA_RESEND_MIN_INTERVAL_MS = 60 * 1000;

// Final / non-sendable proforma states. Sending a proforma in any of
// these would email a stale document (e.g. a paid proforma the client
// already settled, a cancelled/rejected proforma the client already
// saw rejected). Send is only meaningful from draft | sent | viewed.
const TERMINAL_PROFORMA_STATES = new Set([
  "cancelled", "expired", "rejected", "accepted", "paid",
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (proformas.send)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "proformas.send"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

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
  // AUDIT19 F10 / audit20 20-d2 — validate the optional override email before
  // it reaches sendEmail (parity with the offers send route, which already
  // runs this check). A malformed address becomes an SMTP 500 /
  // header-injection surface; the canonical validator rejects both early
  // and cheaply. The proformas send route previously read body?.email with
  // zero validation while offers rejected the same input with 400.
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
    // Fetch the proforma
    const proforma = await auth.store.getProforma(id);
    if (!proforma) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }
    // Tenant ownership check
    if (!auth.isSuperAdmin && proforma.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Proforma not found." }, { status: 404 });
    }

    // AUDIT18 (SoD parity): the "send" action IS the approval step for a
    // proforma (once sent, it is locked). Invoice and offer sends enforce
    // separation-of-duties via migration 040's created_by / owner_id; the
    // proforma send route was missed — a proforma's creator could send
    // (= approve) their own proforma. Migration 079 adds proformas.created_by
    // (backfilled from audit_logs); this check now mirrors the invoice route.
    // `created_by` is null on legacy rows → the check fails OPEN (does not
    // block), same semantics as invoices.
    {
      const sod = await assertNoSoDViolation(auth, (proforma as any).created_by, {
        create_perm: "proformas.create",
        approve_perm: "proformas.send",
      });
      if (sod) return sod;
    }

    // FIX-PRODUCTS-DOCS / Fix 5 (a) — terminal-state guard. Refuse to
    // send a proforma that's in a terminal / non-sendable state. Without
    // this an admin could re-send a paid proforma (which the client
    // already settled) or a cancelled / rejected / expired proforma —
    // the status stayed put but the PDF was still emailed, spamming
    // the recipient with a stale document. Super-admin bypasses so
    // they can correct bad data. Mirror /api/offers/[id]/send:82-87.
    if (!auth.isSuperAdmin && proforma.status && TERMINAL_PROFORMA_STATES.has(proforma.status)) {
      return NextResponse.json(
        { error: `Cannot send a ${proforma.status} proforma.` },
        { status: 400 },
      );
    }

    // FIX-PRODUCTS-DOCS / Fix 5 (b) — idempotency guard. If this proforma
    // was sent within the last PROFORMA_RESEND_MIN_INTERVAL_MS, refuse
    // to re-send (prevents the "spam re-send" bug where a double-click
    // or a stale UI effect fires the send twice in seconds). Super-admin
    // bypasses. Mirror /api/offers/[id]/send:96-110.
    if (!auth.isSuperAdmin && proforma.sent_at) {
      const lastSendMs = new Date(proforma.sent_at).getTime();
      const elapsedMs = Date.now() - lastSendMs;
      if (Number.isFinite(lastSendMs) && elapsedMs < PROFORMA_RESEND_MIN_INTERVAL_MS) {
        const retryAfterSec = Math.ceil((PROFORMA_RESEND_MIN_INTERVAL_MS - elapsedMs) / 1000);
        return NextResponse.json(
          {
            error: `This proforma was sent ${elapsedMs < 60_000 ? "just now" : Math.floor(elapsedMs / 1000) + "s ago"}. Please wait ${retryAfterSec}s before re-sending to avoid spamming the recipient.`,
            retry_after: retryAfterSec,
            already_sent: true,
          },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // FIX-PRODUCTS-DOCS / Fix 5 (c) — per-proforma-id rate limit (5 per
    // 15 min, defense-in-depth against runaway re-send loops). The
    // idempotency guard above is the primary defense; this is the
    // backstop (clock skew, concurrent races on sent_at). Super-admin
    // bypasses. Mirror /api/offers/[id]/send:118-127.
    if (!auth.isSuperAdmin) {
      const rl = await checkRateLimit(`proforma-send:${id}`, 5, 15 * 60 * 1000);
      if (!rl.allowed) {
        const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
        return NextResponse.json(
          { error: "Too many sends for this proforma recently. Please try again later.", retry_after: retryAfterSec },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // Fetch partner for email info / portal notification
    const partner = proforma.partner_id ? await auth.store.getPartner(proforma.partner_id) : null;

    // Resolve tenant (required for PDF generation and notification)
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) {
      return NextResponse.json({ error: "tenant_id query parameter is required for super-admin actions." }, { status: 400 });
    }

    // ─── Email send (optional) ───
    // If `email` is provided in the body, generate a PDF and email it to the
    // recipient. If `email` is missing, we skip the email step and only mark
    // the proforma as sent + push a portal notification.
    let emailResult: { success: boolean; skipped?: boolean; error?: string; queued?: boolean } = { success: true, skipped: true };
    if (toEmail) {
      const result = await generatePdf({ docType: "proforma", docId: id, tenantId });
      const pdfBuffer = Buffer.from(result.buffer);

      const { subject, html } = documentEmail({
        partnerName: partner?.name || "Client",
        docType: "proforma",
        docNumber: proforma.number || id,
        tenantName: (await auth.store.getTenant(tenantId))?.name || "VELOS Trade",
        amount: proforma.total != null ? String(proforma.total) : undefined,
        currency: proforma.currency || undefined,
        dueDate: proforma.valid_until || undefined,
      });

      emailResult = await sendEmail({
        to: toEmail,
        subject,
        html,
        tenantId,
        // AUDIT16 — entity reference for PDF regeneration on retry +
        // queued flag so we don't mark the proforma sent when the email
        // was only parked in the queue (no provider configured).
        entityType: "proforma",
        entityId: id,
        attachments: [{
          filename: `proforma-${proforma.number || id}.pdf`,
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
        // draft→sent via this send endpoint. Super-admins bypass.
        const newStatus = proforma.status === "draft" || !proforma.status ? "sent" : proforma.status;
        if (newStatus !== proforma.status && !auth.isSuperAdmin) {
          const t = validateStatusTransition("proforma", proforma.status || "draft", newStatus);
          if (!t.valid) {
            return NextResponse.json({ error: t.error }, { status: 400 });
          }
        }
        // FIX-PRODUCTS-DOCS / Fix 5 (b) — only set sent_at on FIRST send.
        // Previously the route wrote `sent_at: new Date().toISOString()`
        // unconditionally, overwriting the original send timestamp on
        // every re-send (audit-trail corruption). Mirror
        // /api/offers/[id]/send:187-189.
        const updateFields: any = { status: newStatus };
        if (!proforma.sent_at) {
          updateFields.sent_at = new Date().toISOString();
        }
        await auth.store.upsertProforma({ id, ...updateFields } as any);
      } catch (e) { console.warn("[proforma.send] status bump failed:", e); }
    }

    // ─── Portal notification ───
    // Notify the partner's portal client that a new proforma is available.
    // (AUDIT16: only when actually delivered.)
    if (delivered && proforma.partner_id) {
      try {
        await notify({
          tenantId: proforma.tenant_id,
          userId: null,
          partnerId: proforma.partner_id,
          type: "proforma_sent",
          title: `New proforma: ${proforma.number || id}`,
          message: proforma.subject || `Proforma ${proforma.number || id} has been sent to you`,
          entityType: "proforma",
          entityId: proforma.id,
          actionLabel: "View",
        });
      } catch (e) {
        console.error("[proforma.send] portal notification failed:", e);
        // Don't fail the send if notification fails
      }
    }

    await audit(auth.store, auth.user, req, "proforma.send_email", "proforma", id, { to: toEmail || "(portal only)" });

    // AUDIT17 / P2-3 — a queued email (no provider configured) is NOT a
    // delivery: return 409 with an actionable message (same semantics as
    // the LOI send route) instead of a bare 200 { queued: true } that the
    // views toasted as "The proforma sent".
    if (emailResult.queued) {
      return NextResponse.json(
        {
          error:
            "No email provider is configured for this tenant (Settings → Communications). " +
            "The proforma email is queued in the Mail Queue — configure a provider, then retry. " +
            "The proforma status stays draft.",
          queued: true,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(emailResult);
  } catch (e) {
    console.error("[proforma.send]", e);
    return NextResponse.json({ error: "Failed to send email." }, { status: 500 });
  }
}
