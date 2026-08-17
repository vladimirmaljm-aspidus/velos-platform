/**
 * API Route — Email Templates
 * CRUD operations for email/document templates.
 * GET: Lists templates from the database (via store.listDocumentTemplates).
 * POST: Creates or updates a template (via store.upsertDocumentTemplate).
 * Default templates are seeded on first use if none exist in the DB.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId } from "@/lib/api/helpers";

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
      // Return database templates mapped to the email template format
      const templates: EmailTemplate[] = dbTemplates.map((t) => ({
        id: t.id,
        name: t.name,
        subject: t.header_content || "",
        category: mapTemplateType(t.type),
        variables: [],
        description: `${t.type} template — ${t.page_size}`,
        html: t.body_font_family || "",
        isDefault: t.is_default,
        createdAt: t.created_at || new Date().toISOString(),
        updatedAt: t.updated_at || new Date().toISOString(),
      }));
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

    // Persist the template to the database via the store
    const templateData = {
      tenant_id: tenantId,
      name: body.name || "Custom Template",
      type: body.type || "generic",
      is_default: body.isDefault || false,
      created_by: auth.user.id,
      ...body,
    };

    const created = await auth.store.upsertDocumentTemplate(templateData);

    await audit(
      auth.store,
      auth.user,
      req,
      body.id ? "email_template.update" : "email_template.create",
      "document_template",
      created.id,
      { name: created.name }
    );

    return NextResponse.json({ template: created, success: true });
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
