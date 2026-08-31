import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";
import { sendEmail, documentEmail } from "@/lib/email/service";
import { generatePdf } from "@/lib/pdf/generator";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";
// AUDIT2-LOGIC-UX H10 — rate-limit + idempotency + state guard for
// invoice send. Previously an admin could re-send an already-paid /
// cancelled invoice (the email would fire even though the status was
// terminal) and overwrite sent_at on every re-send (losing the
// original send timestamp). Now: (1) state guard — refuse send for
// paid / cancelled; (2) per-(invoice-id) 60s idempotency; (3) per-
// (invoice-id) 5-per-15-min rate limit; (4) only stamp sent_at on the
// FIRST successful send (parity with the offer send route).
import { checkRateLimit } from "@/lib/security/rate-limiter";

export const runtime = "nodejs";

// 60s minimum interval between sends to the SAME invoice. Matches the
// pattern from /api/portal-access/[id]/invite — generous for a legit
// "I want to re-send" intent, tight enough to stop a runaway loop.
const INVOICE_RESEND_MIN_INTERVAL_MS = 60 * 1000;

// Final / non-sendable invoice states. Sending an invoice in any of
// these would email a stale document to the partner — a paid invoice
// (already settled, the partner has the receipt), or a cancelled one
// (voided, no longer owed). Send is only meaningful from draft | sent
// | viewed | partial | overdue.
const TERMINAL_INVOICE_STATES = new Set(["paid", "cancelled"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (invoices.send)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "invoices.send"); if (_d) return _d; } /* requirePermission wired */
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

  try {
    // Fetch the invoice
    const invoice = await auth.store.getInvoice(id);
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }
    // Tenant ownership check
    if (!auth.isSuperAdmin && invoice.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    }

    // ── P1-1 / Feature 2: Separation-of-Duties check ─────────────────
    // The "send" action IS the approval step for an invoice (once sent,
    // the invoice is locked). The creator (`invoice.created_by`, added
    // by migration 040) cannot approve their own invoice unless they
    // are a super_admin. `assertNoSoDViolation` short-circuits for
    // super_admin before consulting the SoD rules.
    // Note: `created_by` is null on legacy rows (pre-migration-040);
    // the SoD check fails OPEN in that case (does not block).
    {
      const sod = await assertNoSoDViolation(auth, (invoice as any).created_by, {
        create_perm: "invoices.create",
        approve_perm: "invoices.send",
      });
      if (sod) return sod;
    }

    // AUDIT2-LOGIC-UX H10 — state guard. Refuse to send an invoice that's
    // in a terminal / non-sendable state. Previously an admin could
    // re-send a paid invoice (already settled, partner has the receipt)
    // or a cancelled one (voided, no longer owed) — the status stayed
    // put but the PDF was still emailed, spamming the recipient with a
    // stale document. Super-admin bypasses so they can correct bad data.
    if (!auth.isSuperAdmin && invoice.status && TERMINAL_INVOICE_STATES.has(invoice.status)) {
      return NextResponse.json(
        { error: `Cannot send a ${invoice.status} invoice.` },
        { status: 400 },
      );
    }

    // AUDIT2-LOGIC-UX H10 — idempotency guard. If this invoice was sent
    // within the last INVOICE_RESEND_MIN_INTERVAL_MS, refuse to re-send.
    // Per-(invoice-id) (not per-recipient) — the audit log shows a
    // single "send_email" event regardless of recipient. Super-admin
    // bypasses.
    if (!auth.isSuperAdmin && invoice.sent_at) {
      const lastSendMs = new Date(invoice.sent_at).getTime();
      const elapsedMs = Date.now() - lastSendMs;
      if (Number.isFinite(lastSendMs) && elapsedMs < INVOICE_RESEND_MIN_INTERVAL_MS) {
        const retryAfterSec = Math.ceil((INVOICE_RESEND_MIN_INTERVAL_MS - elapsedMs) / 1000);
        return NextResponse.json(
          {
            error: `This invoice was sent ${elapsedMs < 60_000 ? "just now" : Math.floor(elapsedMs / 1000) + "s ago"}. Please wait ${retryAfterSec}s before re-sending to avoid spamming the recipient.`,
            retry_after: retryAfterSec,
            already_sent: true,
          },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // AUDIT2-LOGIC-UX H10 — per-invoice-id rate limit (defense-in-depth).
    // 5 sends per 15 min per invoice. Idempotency guard is primary;
    // this is the backstop. Super-admin bypasses.
    if (!auth.isSuperAdmin) {
      const rl = await checkRateLimit(`invoice-send:${id}`, 5, 15 * 60 * 1000);
      if (!rl.allowed) {
        const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
        return NextResponse.json(
          { error: "Too many sends for this invoice recently. Please try again later.", retry_after: retryAfterSec },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // Fetch partner for email info / portal notification
    const partner = invoice.partner_id ? await auth.store.getPartner(invoice.partner_id) : null;

    // Resolve tenant (required for PDF generation and notification)
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) {
      return NextResponse.json({ error: "tenant_id query parameter is required for super-admin actions." }, { status: 400 });
    }

    // ─── Email send (optional) ───
    // If `email` is provided in the body, generate a PDF and email it to the
    // recipient. If `email` is missing, we skip the email step and only mark
    // the invoice as sent + push a portal notification.
    let emailResult: { success: boolean; skipped?: boolean; error?: string; queued?: boolean } = { success: true, skipped: true };
    if (toEmail) {
      const result = await generatePdf({ docType: "invoice", docId: id, tenantId });
      const pdfBuffer = Buffer.from(result.buffer);

      const { subject, html } = documentEmail({
        partnerName: partner?.name || "Client",
        docType: "invoice",
        docNumber: invoice.number || id,
        tenantName: (await auth.store.getTenant(tenantId))?.name || "VELOS Trade",
        amount: invoice.total != null ? String(invoice.total) : undefined,
        currency: invoice.currency || undefined,
        dueDate: invoice.due_date || undefined,
      });

      emailResult = await sendEmail({
        to: toEmail,
        subject,
        html,
        tenantId,
        // AUDIT16 — persist the entity reference on the mail_queue row so
        // the Retry endpoint can regenerate the PDF attachment, and the
        // queued flag tells us below whether it was actually delivered.
        entityType: "invoice",
        entityId: id,
        attachments: [{
          filename: `invoice-${invoice.number || id}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        }],
      });
    }

    // Promote status draft→sent and stamp sent_at (only on first successful send).
    // AUDIT16 — a queued email (no provider configured) is NOT a delivery:
    // don't flip the invoice to "sent" / stamp sent_at / notify the portal
    // that the invoice went out. Previously the dev-queue path returned
    // success:true and the invoice was marked sent even though the client
    // never received anything.
    const delivered = emailResult.success && !emailResult.queued;
    if (delivered) {
      try {
        // Validate the status transition (Re-Audit-2 N4) — only allow
        // draft→sent via this send endpoint. Other transitions (e.g.
        // partial→paid) require the record-payment / PUT routes. Super-admins
        // bypass.
        const newStatus = invoice.status === "draft" || !invoice.status ? "sent" : invoice.status;
        if (newStatus !== invoice.status && !auth.isSuperAdmin) {
          const t = validateStatusTransition("invoice", invoice.status || "draft", newStatus);
          if (!t.valid) {
            return NextResponse.json({ error: t.error }, { status: 400 });
          }
        }
        // AUDIT2-LOGIC-UX H10 — only stamp sent_at on FIRST successful send.
        // The previous line unconditionally wrote `sent_at: now` on every
        // re-send, overwriting the original send timestamp and making the
        // "Sent N days ago" badge in the UI jump back to "Sent just now"
        // every time the admin re-sent. Parity with the offer send route
        // (line 114 there: `if (!offer.sent_at) updateFields.sent_at = ...`).
        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = { id, status: newStatus };
        if (!invoice.sent_at) {
          patch.sent_at = nowIso;
        }
        await auth.store.upsertInvoice(patch as any);
      } catch (e) { console.warn("[invoice.send] status bump failed:", e); }
    }

    // ─── Portal notification ───
    // Notify the partner's portal client that a new invoice is available.
    // (AUDIT16: only when actually delivered — see `delivered` above.)
    if (delivered && invoice.partner_id) {
      try {
        await notify({
          tenantId: invoice.tenant_id,
          userId: null,
          partnerId: invoice.partner_id,
          type: "invoice_sent",
          title: `New invoice: ${invoice.number || id}`,
          message: invoice.subject || `Invoice ${invoice.number || id} has been sent to you`,
          entityType: "invoice",
          entityId: invoice.id,
          actionLabel: "View",
        });
      } catch (e) {
        console.error("[invoice.send] portal notification failed:", e);
        // Don't fail the send if notification fails
      }
    }

    await audit(auth.store, auth.user, req, "invoice.send_email", "invoice", id, { to: toEmail || "(portal only)" });

    return NextResponse.json(emailResult);
  } catch (e) {
    console.error("[invoice.send]", e);
    return NextResponse.json({ error: "Failed to send email." }, { status: 500 });
  }
}
