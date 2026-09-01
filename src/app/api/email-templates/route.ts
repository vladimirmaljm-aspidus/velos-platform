/**
 * API Route — Email Templates
 * CRUD operations for email templates, persisted as document_templates rows.
 *
 * audit20 / 20-b — STORAGE MAPPING (the "squatting" fix):
 * The platform has no dedicated email_templates table, so this route has
 * always squatted `document_templates`. The old POST spread the raw email
 * fields (subject / html / category / variables / description) into the
 * store — none of them are document_templates columns. The supabase
 * smartUpsert strips ONE unknown column, then the NEXT unknown column
 * throws a PostgREST "column does not exist" 500 → EVERY save 500'd.
 * (On the mock store the extra keys were silently ignored, so the bug was
 * only reproducible against Supabase.)
 *
 * No table restructure (out of scope): the email fields are now persisted
 * inside the REAL `footer_content` column as a JSON wrapper:
 *   footer_content = JSON.stringify({ emailTemplate: { subject, html,
 *     category, variables, description } })
 * `footer_content` is free-form text on the PDF side (the visual editor
 * stores segment JSON + a `_qrConfig` sub-key there), so a distinct
 * `emailTemplate` sub-key coexists without clobbering either format.
 * GET unwraps it back into the EmailTemplate response shape; rows WITHOUT
 * the wrapper (real PDF templates) keep the AUDIT17/P3 honest mapping.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, getIp } from "@/lib/api/helpers";
import { sendEmail } from "@/lib/email/service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { isValidEmail } from "@/lib/validation/email";
import type { DocumentTemplate } from "@/lib/supabase/types";

export const runtime = "nodejs";

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  category: "transactional" | "marketing" | "notification" | "compliance";
  variables: string[];
  description: string;
  html: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// The email fields persisted inside footer_content's { emailTemplate } wrapper.
interface EmailTemplateData {
  subject: string;
  html: string;
  category: string;
  variables: string[];
  description: string;
}

const EMAIL_CATEGORIES = new Set([
  "transactional", "marketing", "notification", "compliance",
]);

// Default templates — used as fallback / seed data when DB has no templates
const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    id: "tpl-welcome",
    name: "Welcome Email",
    subject: "Welcome to {{tenantName}} Client Portal",
    category: "transactional",
    variables: ["tenantName", "partnerName", "portalEmail", "setupUrl", "tier"],
    description: "Sent when a new portal account is created for a partner.",
    isDefault: true,
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #0f766e, #115e59); color: white; padding: 30px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 24px;">Welcome to {{tenantName}}</h1>
    <p style="margin: 8px 0 0; opacity: 0.9;">Your client portal account is ready</p>
  </div>
  <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="color: #333; font-size: 15px;">Hello {{partnerName}},</p>
    <p style="color: #555; font-size: 14px; line-height: 1.6;">
      Your account has been created with <strong style="text-transform: capitalize;">{{tier}}</strong> tier access.
    </p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="{{setupUrl}}" style="background: #0f766e; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
        Set Up Your Password
      </a>
    </div>
  </div>
</div>`,
  },
  {
    id: "tpl-kyc",
    name: "KYC Status Notification",
    subject: "KYC {{status}} — {{tenantName}}",
    category: "compliance",
    variables: ["partnerName", "status", "tenantName", "reason"],
    description: "Sent when KYC verification status changes.",
    isDefault: true,
    createdAt: new Date(Date.now() - 25 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    html: `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 22px;">KYC {{status}}</h1>
  </div>
  <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="color: #333; font-size: 15px;">Hello {{partnerName}},</p>
    <p style="color: #555; font-size: 14px; line-height: 1.6;">
      Your KYC verification status has been updated to: <strong>{{status}}</strong>.
    </p>
  </div>
</div>`,
  },
  {
    id: "tpl-offer",
    name: "Offer Notification",
    subject: "New Offer from {{tenantName}} — {{offerNumber}}",
    category: "transactional",
    variables: ["partnerName", "tenantName", "offerNumber", "amount", "currency", "validUntil"],
    description: "Sent when a new offer is created for a partner.",
    isDefault: true,
    createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    html: `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #0f766e, #115e59); color: white; padding: 30px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 22px;">New Offer: {{offerNumber}}</h1>
    <p style="margin: 8px 0 0; opacity: 0.9;">{{currency}} {{amount}}</p>
  </div>
  <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="color: #333; font-size: 15px;">Hello {{partnerName}},</p>
    <p style="color: #555; font-size: 14px; line-height: 1.6;">
      A new offer <strong>{{offerNumber}}</strong> has been prepared for you.
    </p>
    <p style="color: #888; font-size: 12px; margin-top: 20px;">This offer is valid until {{validUntil}}.</p>
  </div>
</div>`,
  },
  {
    id: "tpl-invoice",
    name: "Invoice Notification",
    subject: "Invoice {{invoiceNumber}} from {{tenantName}}",
    category: "transactional",
    variables: ["partnerName", "tenantName", "invoiceNumber", "amount", "currency", "dueDate"],
    description: "Sent when a new invoice is issued.",
    isDefault: true,
    createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    html: `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #0f766e; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 22px;">Invoice {{invoiceNumber}}</h1>
    <p style="margin: 8px 0 0; opacity: 0.9;">{{currency}} {{amount}}</p>
  </div>
  <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="color: #333; font-size: 15px;">Hello {{partnerName}},</p>
    <p style="color: #555; font-size: 14px; line-height: 1.6;">
      Invoice <strong>{{invoiceNumber}}</strong> for <strong>{{currency}} {{amount}}</strong> has been issued.
    </p>
    <p style="color: #888; font-size: 12px; margin-top: 20px;">Payment due by {{dueDate}}.</p>
  </div>
</div>`,
  },
  {
    id: "tpl-reminder",
    name: "Payment Reminder",
    subject: "Payment Reminder — Invoice {{invoiceNumber}}",
    category: "notification",
    variables: ["partnerName", "invoiceNumber", "amount", "currency", "dueDate", "daysOverdue"],
    description: "Sent when an invoice is approaching or past due date.",
    isDefault: true,
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    html: `<div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #f59e0b; color: white; padding: 30px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 22px;">Payment Reminder</h1>
    <p style="margin: 8px 0 0; opacity: 0.9;">{{daysOverdue}} days overdue</p>
  </div>
  <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="color: #333; font-size: 15px;">Hello {{partnerName}},</p>
    <p style="color: #555; font-size: 14px; line-height: 1.6;">
      This is a reminder that invoice <strong>{{invoiceNumber}}</strong> for <strong>{{currency}} {{amount}}</strong> was due on {{dueDate}}.
    </p>
  </div>
</div>`,
  },
];

// ── audit20 / 20-b — footer_content emailTemplate wrapper helpers ──────
/**
 * Parse the { emailTemplate: {...} } wrapper out of a document_templates
 * footer_content. Returns null when footer_content is NOT wrapper JSON —
 * i.e. real PDF footer content (segment JSON, _qrConfig, plain text) or a
 * legacy row saved before this mapping existed. Non-wrapper content keeps
 * the legacy honest GET mapping and is never treated as an email template.
 */
function parseEmailTemplateWrapper(footerContent: string | null | undefined): EmailTemplateData | null {
  if (!footerContent || typeof footerContent !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(footerContent);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const wrapper = (parsed as Record<string, unknown>).emailTemplate;
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return null;
    const w = wrapper as Record<string, unknown>;
    return {
      subject: typeof w.subject === "string" ? w.subject : "",
      html: typeof w.html === "string" ? w.html : "",
      category: typeof w.category === "string" ? w.category : "",
      variables: Array.isArray(w.variables)
        ? w.variables.filter((v): v is string => typeof v === "string")
        : [],
      description: typeof w.description === "string" ? w.description : "",
    };
  } catch {
    // Not JSON at all (plain-text footer / segment JSON without wrapper).
    return null;
  }
}

/** Coerce a stored category string back into the 4-value union. */
function coerceCategory(v: string): EmailTemplate["category"] {
  return EMAIL_CATEGORIES.has(v) ? (v as EmailTemplate["category"]) : "notification";
}

/** Serialize email fields into the footer_content wrapper JSON. */
function buildEmailWrapperJson(d: EmailTemplateData): string {
  return JSON.stringify({ emailTemplate: d });
}

/** Map a document_templates row to the API's EmailTemplate shape. */
function toEmailTemplateItem(t: DocumentTemplate): EmailTemplate {
  const createdAt = t.created_at || new Date().toISOString();
  const updatedAt = t.updated_at || new Date().toISOString();
  const wrapper = parseEmailTemplateWrapper(t.footer_content);
  if (wrapper) {
    // audit20 / 20-b — row saved through this route: the real email fields
    // round-trip back out of the footer_content wrapper.
    return {
      id: t.id,
      name: t.name,
      subject: wrapper.subject,
      category: coerceCategory(wrapper.category),
      variables: wrapper.variables,
      description: wrapper.description,
      html: wrapper.html,
      isDefault: t.is_default,
      createdAt,
      updatedAt,
    };
  }
  // AUDIT17 / P3 — honest mapping for rows WITHOUT the wrapper: these are
  // PDF document templates, not email bodies. The previous mapping read
  // unrelated columns (subject ← header_content, html ← body_font_family)
  // and rendered layout snippets as subjects/HTML; this keeps the fix
  // (type-based subject, empty html) for them.
  return {
    id: t.id,
    name: t.name,
    subject: `${t.type} document template`,
    category: mapTemplateType(t.type),
    variables: [],
    description: `${t.type} template — ${t.page_size}`,
    html: "",
    isDefault: t.is_default,
    createdAt,
    updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (email-templates.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "email-templates.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  try {
    const tenantId = resolveTenantId(auth, req);
    // Super-admin without ?tenant_id= must not silently fall back to the first
    // tenant (would leak / cross-show data). Return an empty templates list.
    if (!tenantId) {
      if (auth.isSuperAdmin) {
        return NextResponse.json({ templates: [], source: "empty" });
      }
      return NextResponse.json({ error: "No tenant context." }, { status: 400 });
    }

    // Fetch real templates from the database
    const dbTemplates = await auth.store.listDocumentTemplates(tenantId);

    if (dbTemplates.length > 0) {
      // audit20 / 20-b — rows saved through this POST carry the real email
      // fields in the footer_content emailTemplate wrapper (see POST);
      // non-wrapper rows keep the AUDIT17/P3 honest mapping.
      const templates: EmailTemplate[] = dbTemplates.map(toEmailTemplateItem);
      return NextResponse.json({ templates, source: "database" });
    }

    // No templates in DB yet — return defaults (these will be seeded on first POST)
    return NextResponse.json({ templates: DEFAULT_TEMPLATES, source: "defaults" });
  } catch (error) {
    console.error("[email-templates] GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch templates." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (email-templates.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "email-templates.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_document_templates)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_document_templates", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  try {
    const tenantId = resolveTenantId(auth, req);
    if (!tenantId) {
      return NextResponse.json({ error: "No tenant." }, { status: 400 });
    }

    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // ── audit20 / 20-b — test-send branch ──────────────────────────────
    // The frontend's "Test Send" button posts { action: "test-send",
    // templateId }. This used to fall through into the upsert path, which
    // (a) created a junk "Custom Template" row every click (name defaulted
    // because the payload had no name) and (b) STILL never sent an email,
    // while the UI toasted "Test sent". Handled explicitly now: lookup the
    // saved template, unwrap its emailTemplate, and send to the requesting
    // user. NEVER creates rows.
    if (body.action === "test-send") {
      // Rate limit (mirrors settings/test-email — send endpoints are spam
      // vectors even when self-addressed).
      const rl = await checkRateLimit(`email-template-test:${getIp(req)}`, 10, 10 * 60_000);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: "Too many test email requests. Please wait a few minutes." },
          { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfter ?? 600_000) / 1000)) } },
        );
      }
      const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
      if (!templateId) {
        return NextResponse.json({ error: "Missing templateId." }, { status: 400 });
      }
      const tpl = await auth.store.getDocumentTemplate(templateId);
      if (!tpl || (!auth.isSuperAdmin && tpl.tenant_id !== tenantId)) {
        // 404 without leaking whether the id exists in another tenant.
        return NextResponse.json(
          { error: "Template not found. Save the template first — test send works on saved templates." },
          { status: 404 },
        );
      }
      const wrapper = parseEmailTemplateWrapper(tpl.footer_content);
      if (!wrapper || !wrapper.html) {
        return NextResponse.json(
          { error: "Test send requires a saved template with an HTML body." },
          { status: 400 },
        );
      }
      const to = auth.user.email;
      if (!to || !isValidEmail(to)) {
        return NextResponse.json(
          { error: "Your account has no valid email address to receive the test." },
          { status: 400 },
        );
      }
      const subject = `[TEST] ${wrapper.subject || tpl.name}`;
      const result = await sendEmail({ to, subject, html: wrapper.html, tenantId });
      try {
        await audit(auth.store, auth.user, req, "email_template.test_send", "document_template", tpl.id, { to });
      } catch (e) { console.error("[audit]", e); }
      if (result.queued) {
        // AUDIT16 — queued means NOT delivered (no provider configured).
        // Report honestly instead of toasting a fake "Test sent".
        return NextResponse.json(
          { error: "No email provider is configured for this tenant (Settings → Communications). The test email is queued — configure a provider, then retry from the Mail Queue." },
          { status: 409 },
        );
      }
      if (!result.success) {
        return NextResponse.json(
          { error: "Test email failed to send.", details: result.error },
          { status: 500 },
        );
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // ── audit20 / 20-b — save path (create + update-by-id) ────────────
    // Map the email payload onto REAL document_templates columns only.
    // Every field is constructed explicitly (no ...body spread at all), so
    // unknown email keys can never reach the store — the previous spread
    // sent subject/html/category/variables/description, which smartUpsert
    // rejected one-by-one ("column does not exist") and 500'd every save.
    // AUDIT16 / HIGH-1 (kept): tenant_id / created_by are trusted values
    // from the auth context, never from the body; body.id is only honoured
    // as a plain string for the update-by-id flow.
    const bodyId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
    const emailData: EmailTemplateData = {
      subject: typeof body.subject === "string" ? body.subject : "",
      html: typeof body.html === "string" ? body.html : "",
      category: typeof body.category === "string" ? body.category : "",
      variables: Array.isArray(body.variables)
        ? body.variables.filter((v): v is string => typeof v === "string")
        : [],
      description: typeof body.description === "string" ? body.description : "",
    };
    const templateData: Partial<DocumentTemplate> & { id?: string } = {
      ...(bodyId ? { id: bodyId } : {}),
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Custom Template",
      type: "generic",
      is_default: false,
      footer_content: buildEmailWrapperJson(emailData),
      // Trusted keys — constructed here, never taken from the body.
      tenant_id: tenantId,
      created_by: auth.user.id,
      // NOTE: header_content is intentionally OMITTED (the column default
      // "" applies on INSERT). sanitizePayload in the supabase store
      // converts "" → null, and header_content is NOT NULL — sending an
      // explicit "" would 500 the INSERT with a not-null violation, the
      // exact failure mode this rewrite exists to eliminate.
    };

    const created = await auth.store.upsertDocumentTemplate(templateData);

    await audit(
      auth.store,
      auth.user,
      req,
      bodyId ? "email_template.update" : "email_template.create",
      "document_template",
      created.id,
      { name: created.name }
    );

    // Respond with the mapped EmailTemplate shape (same mapper as GET) so
    // the client's result.template?.id + freshly-saved email fields line up
    // with what the next GET returns.
    return NextResponse.json({ template: toEmailTemplateItem(created), success: true });
  } catch (error) {
    console.error("[email-templates] POST error:", error);
    return NextResponse.json(
      { error: "Failed to save template." },
      { status: 500 }
    );
  }
}

/** Map DocumentTemplate type to email template category */
function mapTemplateType(
  type: string
): "transactional" | "marketing" | "notification" | "compliance" {
  switch (type) {
    case "offer":
    case "invoice":
    case "proforma":
      return "transactional";
    case "contract":
      return "compliance";
    default:
      return "notification";
  }
}
