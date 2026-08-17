import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit } from "@/lib/api/helpers";
import { sendEmail, documentEmail } from "@/lib/email/service";
import { generatePdf } from "@/lib/pdf/generator";
import { notify } from "@/lib/notif/helper";
import { validateStatusTransition } from "@/lib/api/status-validator";

export const runtime = "nodejs";

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
    let emailResult: { success: boolean; skipped?: boolean; error?: string } = { success: true, skipped: true };
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
        attachments: [{
          filename: `proforma-${proforma.number || id}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        }],
      });
    }

    // Promote status draft→sent and stamp sent_at (only on first successful send).
    if (emailResult.success) {
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
        await auth.store.upsertProforma({ id, status: newStatus, sent_at: new Date().toISOString() } as any);
      } catch (e) { console.warn("[proforma.send] status bump failed:", e); }
    }

    // ─── Portal notification ───
    // Notify the partner's portal client that a new proforma is available.
    if (emailResult.success && proforma.partner_id) {
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

    return NextResponse.json(emailResult);
  } catch (e) {
    console.error("[proforma.send]", e);
    return NextResponse.json({ error: "Failed to send email." }, { status: 500 });
  }
}
