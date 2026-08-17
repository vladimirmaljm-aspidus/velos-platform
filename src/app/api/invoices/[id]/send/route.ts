import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";
import { sendEmail, documentEmail } from "@/lib/email/service";
import { generatePdf } from "@/lib/pdf/generator";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";
import { assertNoSoDViolation } from "@/lib/permissions/sod-matrix";

export const runtime = "nodejs";

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
    let emailResult: { success: boolean; skipped?: boolean; error?: string } = { success: true, skipped: true };
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
        attachments: [{
          filename: `invoice-${invoice.number || id}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        }],
      });
    }

    // Promote status draft→sent and stamp sent_at (only on first successful send).
    if (emailResult.success) {
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
        await auth.store.upsertInvoice({ id, status: newStatus, sent_at: new Date().toISOString() } as any);
      } catch (e) { console.warn("[invoice.send] status bump failed:", e); }
    }

    // ─── Portal notification ───
    // Notify the partner's portal client that a new invoice is available.
    if (emailResult.success && invoice.partner_id) {
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
