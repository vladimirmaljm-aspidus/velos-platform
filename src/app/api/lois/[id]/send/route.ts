import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, getIp } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { sendEmail } from "@/lib/email/service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { decryptField, isEncrypted } from "@/lib/crypto/field-encryption";
import { escapeHtml } from "@/lib/security/escape-html";

export const runtime = "nodejs";

/**
 * AUDIT16 — escape user-provided values interpolated into the email HTML
 * (tenant/partner names, LOI subject/terms/notes). Every other template
 * in email/service.ts escapes; this route built raw HTML — a partner name
 * like "<img src=x onerror=...>" would execute in the recipient's inbox.
 */

/**
 * POST /api/lois/[id]/send — send the LOI via email to the partner.
 * Gates: status must be draft or sent (allow re-send). 60s idempotency +
 * 5/15min rate limit. Sets sent_at on first send only (don't overwrite on
 * re-send). Updates status to "sent". Registers in document_register.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // AUDIT18 (security parity): this route previously had NO permission gate,
  // NO feature gate, and NO admin-role check — any authenticated tenant
  // `user` (even one with zero granted permissions) could email LOIs to
  // partners, while invoice/offer/proforma sends all enforce
  // <doc>.send + module_finance + admin role. Same three gates now.
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "lois.send");
    if (_d) return _d;
  }
  {
    const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin);
    if (_f) return _f;
  }
  if (auth.user.role !== "admin" && auth.user.role !== "super_admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const { id } = await params;
  const store = await getStore();
  try {
    const loi = await store.getLoi(id);
    if (!loi) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && loi.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // State guard: only draft or sent can be sent (re-send allowed)
    if (!["draft", "sent"].includes(loi.status)) {
      return NextResponse.json(
        { error: `Cannot send an LOI with status ${loi.status}.` },
        { status: 400 },
      );
    }

    // 60s idempotency guard — super-admin bypasses (invoice/offer parity)
    if (!auth.isSuperAdmin && loi.sent_at) {
      const elapsedMs = Date.now() - new Date(loi.sent_at).getTime();
      if (elapsedMs < 60_000) {
        const retryAfterSec = Math.ceil((60_000 - elapsedMs) / 1000);
        return NextResponse.json(
          { error: `An LOI was sent ${Math.floor(elapsedMs / 1000)}s ago. Please wait ${retryAfterSec}s before re-sending.`, already_sent: true, retry_after: retryAfterSec },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
        );
      }
    }

    // 5/15min rate limit (defense in depth) — super-admin bypasses
    // (invoice/offer/proforma send parity; previously super_admin WAS
    // rate-limited here, inconsistently with every other document send).
    const rl = auth.isSuperAdmin
      ? null
      : await checkRateLimit(`loi-send:${id}`, 5, 15 * 60 * 1000);
    if (rl && !rl.allowed) {
      const retryAfterSec = Math.ceil((rl.retryAfter ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "Too many sends. Please try again later.", retry_after: retryAfterSec },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // Fetch partner + tenant for the email
    const partner = await store.getPartner(loi.partner_id);
    const tenant = await store.getTenant(loi.tenant_id);
    if (!partner) return NextResponse.json({ error: "Partner not found." }, { status: 400 });

    // AUDIT16 — guard the recipient address: decryptField returns the raw
    // blob on failure (rotated key); refuse to "send" to an enc: ciphertext
    // (the audit15/16 bug class) with a clear admin-facing error instead.
    const partnerEmailRaw = decryptField(partner.email || partner.contact_email || "");
    const partnerEmail = partnerEmailRaw && !isEncrypted(partnerEmailRaw) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(partnerEmailRaw)
      ? partnerEmailRaw
      : "";
    if (!partnerEmail) {
      return NextResponse.json(
        { error: "This partner has no readable email address (stored encrypted and undecryptable, or missing). Fix the partner's contact email and try again." },
        { status: 422 },
      );
    }

    // Build the LOI email HTML
    const fmtMoney = (n: number, cur: string) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n || 0);
    const fmtDate = (d: string) =>
      d ? new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d)) : "—";

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:32px 20px;">
        <div style="background:#0f766e;color:white;padding:24px 28px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;font-size:18px;font-weight:600;">Letter of Intent — ${escapeHtml(loi.number)}</h1>
          <p style="margin:6px 0 0;opacity:0.9;font-size:13px;">${escapeHtml(tenant?.name || "VELOS")}</p>
        </div>
        <div style="background:white;padding:28px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
          <p style="color:#333;font-size:14px;">Dear ${escapeHtml(partner.name)},</p>
          <p style="color:#555;font-size:14px;line-height:1.6;">We hereby express our intent to purchase the following goods under the terms stated below.</p>
          <table style="width:100%;border-collapse:collapse;margin:24px 0;font-size:13px;">
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Subject</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0;">${escapeHtml(loi.subject)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Product</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0;">${escapeHtml(loi.product_name)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Quantity</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${escapeHtml(loi.quantity)} ${escapeHtml(loi.unit)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Unit Price</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${fmtMoney(loi.unit_price, loi.currency)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Total Value</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f0f0;">${fmtMoney(loi.total_value, loi.currency)}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Delivery Terms</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${escapeHtml(loi.delivery_terms || "—")}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Delivery Date</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${fmtDate(loi.delivery_date || "")}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Payment Terms</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${escapeHtml(loi.payment_terms || "—")}</td></tr>
            <tr><td style="padding:8px 0;color:#666;border-bottom:1px solid #f0f0f0;">Valid Until</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">${fmtDate(loi.validity_until)}</td></tr>
          </table>
          ${loi.terms_text ? `<p style="color:#555;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(loi.terms_text)}</p>` : ""}
          ${loi.notes ? `<p style="color:#777;font-size:12px;line-height:1.5;">Notes: ${escapeHtml(loi.notes)}</p>` : ""}
          <p style="color:#555;font-size:14px;line-height:1.6;margin-top:24px;">This Letter of Intent is non-binding and serves as a formal expression of our intent to proceed with the purchase under the stated terms. We look forward to your response by ${fmtDate(loi.validity_until)}.</p>
          <p style="color:#555;font-size:14px;margin-top:24px;">Regards,<br/><strong>${escapeHtml(loi.buyer_name)}</strong></p>
        </div>
      </div>
    `;

    const result = await sendEmail({
      to: partnerEmail,
      subject: `Letter of Intent — ${loi.number} — ${loi.subject}`,
      html,
      tenantId: loi.tenant_id,
      // AUDIT16 — entity reference so the mail-queue Retry endpoint can
      // regenerate the LOI PDF attachment (migration 077).
      entityType: "loi",
      entityId: id,
    });

    // AUDIT16 — only flip the LOI to "sent" (and stamp sent_at) when the
    // email was actually DELIVERED. Previously this ran unconditionally —
    // a failed send (or a queued-with-no-provider send) still marked the
    // LOI as sent and stamped sent_at, which then BLOCKED re-sending for
    // 60s via the idempotency guard while the client never got anything.
    const delivered = result.success && !result.queued;
    if (delivered) {
      const nowIso = new Date().toISOString();
      await store.upsertLoi({
        id: loi.id,
        status: "sent",
        sent_at: loi.sent_at || nowIso, // don't overwrite on re-send
      } as any);
    }

    // Register in document_register
    // 2g-F12 fix (round 4, hardened): the PDF download route (via
    // src/lib/pdf/generator.ts) already creates a document_register entry
    // with reference_id=loi.id + type='loi'. Sending the LOI here would
    // INSERT a DUPLICATE entry (same reference_id, version 1, created twice).
    // The 2h-F1 fix (round 4) makes listDocumentRegister honour the
    // `reference_id` filter server-side (was silently dropped before), so
    // the dedup check now actually finds the prior entry. We use a tight
    // limit (10) because we only care whether ANY entry exists — we don't
    // need the full version history for the dedup decision.
    try {
      const existingReg = await store.listDocumentRegister(loi.tenant_id, {
        limit: 10,
        filters: { reference_id: loi.id, type: "loi" },
      });
      const alreadyRegistered = existingReg.items.length > 0;
      if (!alreadyRegistered) {
        await store.upsertDocumentRegisterEntry({
          tenant_id: loi.tenant_id,
          number: loi.number,
          type: "loi" as any,
          version: 1,
          reference_id: loi.id,
          partner_id: loi.partner_id,
          title: loi.subject,
          status: "current",
          created_by: auth.user.id,
        } as any);
      }
    } catch (e) {
      console.warn("[loi.send] document_register insert failed:", e);
    }

    await audit(auth.store, auth.user, req, "loi.send", "loi", id, {
      number: loi.number,
      partner_email: partnerEmail,
      sent: delivered,
    });

    if (!delivered) {
      if (result.queued) {
        return NextResponse.json(
          { error: "No email provider is configured for this tenant (Settings → Communications). The LOI email is queued — configure a provider, then retry from the Mail Queue. The LOI status stays draft." },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "Email failed to send. Queued for retry.", details: result.error },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, sent: true });
  } catch (e: any) {
    console.error("[lois.send]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
