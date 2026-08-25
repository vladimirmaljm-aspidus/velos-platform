#!/usr/bin/env python3
"""Add ModuleInfoTooltip to view components.

For each view file, find the main PageHeader JSX block, insert a
ModuleInfoTooltip element right after its closing `/>`, and add the
import after the existing PageHeader import.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path("/home/z/my-project/src/components/views")

# (filename, tooltip_title, description, how_to_use, pageheader_line_number)
# pageheader_line_number is 1-based and points at the line containing the
# MAIN `<PageHeader` opening tag (the one inside the main `return (...)`
# block — not the no-access branch). For files where the only PageHeader
# is inside the no-access branch, `pageheader_line_number` is None and we
# instead target the main render's CardTitle via `cardtitle_line_number`.
TOOLTIPS = [
    # CRM
    ("partners-view.tsx", "Partners",
     "Manage your business partners — buyers, suppliers, agents, and logistics providers. Track deals, invoices, and communication history for each partner.",
     ["Click 'Add Partner' to create a new partner",
      "Use the search bar to find partners by name, tax ID, or email",
      "Click a partner row to view their 360° profile (deals, invoices, documents)",
      "Use bulk actions to export or delete multiple partners"],
     337, None),
    ("products-view.tsx", "Products",
     "Manage your product catalog — items you buy, sell, or trade. Track stock levels, prices, categories, and HS codes.",
     ["Click 'Add Product' to create a new product",
      "Set SKU, category, price, and HS code",
      "Track stock levels and reorder points",
      "Use bulk import/export for CSV",
      "Products appear in the portal catalog for clients to browse"],
     320, None),
    ("product-catalog-view.tsx", "Product Catalog",
     "Detailed product specifications, COA parameters, logistics capacities, and certifications. Used by the portal catalog and supplier offers.",
     ["Add products with full specifications (HS code, COA params, logistics)",
      "Products with specs appear in the client portal",
      "Link supplier offers to catalog entries"],
     206, None),
    ("deals-view.tsx", "Deals",
     "Track trade deals from draft to completion. Manage buyers, suppliers, products, quantities, prices, and commissions.",
     ["Create a deal from an accepted offer or manually",
      "Add line items (product, quantity, price)",
      "Track status: draft → quoted → won/lost",
      "Commissions are calculated automatically",
      "Convert deals to invoices when won"],
     290, None),
    ("offers-view.tsx", "Offers",
     "Manage offers sent to or received from partners. Track validity, accept/reject, and convert accepted offers to invoices.",
     ["Create an offer for a partner with line items",
      "Set validity period (valid_until date)",
      "Send offer via email to the partner",
      "Accept/reject received offers",
      "Accepted offers can be converted to invoices"],
     795, None),
    ("demands-view.tsx", "Demands",
     "Track incoming demand requests (RFQs) from clients. Convert demands to deals when you can fulfill them.",
     ["View demands submitted by portal clients",
      "Click 'Create Deal' to convert a demand into a trade deal",
      "Filter by status (open, quoted, closed)",
      "Import demands from portal RFQs"],
     212, None),
    ("commissions-view.tsx", "Commissions",
     "Manage commission agents and their payouts. Track commission per deal, approve payouts, and view summaries.",
     ["Add agents and set their commission rates",
      "Commissions are auto-calculated per deal",
      "Approve pending commissions before payout",
      "Record payouts (atomic — prevents double-payment)",
      "View summaries by agent or date range"],
     192, None),
    ("inventory-view.tsx", "Inventory",
     "Track stock movements (in/out), current stock levels, and low-stock alerts for your products.",
     ["View stock movements with color-coded deltas",
      "Filter by product or partner",
      "Stock auto-updates when offers are accepted",
      "Low-stock products are highlighted",
      "Stock cannot go negative (clamped at 0)"],
     164, None),
    # Finance
    ("invoices-view.tsx", "Invoices",
     "Create, send, and track invoices. Record payments, generate PDFs, and monitor overdue invoices.",
     ["Create an invoice from an accepted offer or manually",
      "Add line items, taxes, and totals",
      "Send via email to the client",
      "Record payments (partial or full)",
      "Download PDF",
      "Monitor overdue invoices"],
     420, None),
    ("proformas-view.tsx", "Proformas",
     "Create proforma invoices (preliminary documents sent before the final invoice). Convert to invoice when the deal closes.",
     ["Create a proforma for a client",
      "Set validity period",
      "Send via email",
      "Convert to invoice when the deal is confirmed",
      "Auto-marks as paid when the linked invoice is paid"],
     322, None),
    ("erp-view.tsx", "ERP / Accounting",
     "Full double-entry accounting system — chart of accounts, journal entries, bank transactions, and financial reports.",
     ["Set up your chart of accounts",
      "Create journal entries (debits = credits)",
      "Record bank transactions",
      "Generate reports: trial balance, P&L, balance sheet",
      "Run FX revaluation for multi-currency"],
     400, None),
    ("document-register-view.tsx", "Document Register",
     "Upload, organize, and verify trade documents (contracts, certificates, bills of lading). Link to deals, invoices, and partners.",
     ["Upload documents (PDF, images, docs)",
      "Link to deals, invoices, or offers",
      "Verify documents (pending → verified → rejected)",
      "Version control — superseded documents are archived",
      "Search and filter by type or status"],
     294, None),
    # Portal Management
    ("kyc-review-view.tsx", "KYC Review",
     "Review and approve/reject client KYC (Know Your Customer) submissions. Verify identity documents and business registrations.",
     ["Review submitted documents (ID, business registration)",
      "Approve if documents are valid",
      "Reject with a reason if documents are insufficient",
      "Clients are notified by email of the decision"],
     218, None),
    ("portal-rfqs-view.tsx", "Portal RFQs",
     "Review Request for Quote (RFQ) submissions from portal clients. Convert to demands or respond directly.",
     ["View RFQs submitted by portal clients",
      "Review product, quantity, target price, and deadline",
      "Convert to a demand or create an offer",
      "Respond to the client via the portal"],
     155, None),
    ("portal-uploads-view.tsx", "Portal Uploads",
     "View documents uploaded by portal clients (KYC docs, contracts, certificates). Organize by partner and category.",
     ["Browse uploads by partner or category",
      "View/download uploaded files",
      "Filter by category (KYC, RFQ, message, general)"],
     218, None),
    # Documents
    ("documents-view.tsx", "Documents",
     "Central document storage — upload, organize, and share documents with your team and clients.",
     ["Upload documents and organize by folder",
      "Share with team members or clients",
      "Set access permissions",
      "Search by name or content"],
     133, None),
    ("document-templates-view.tsx", "Document Templates",
     "Create reusable templates for invoices, proformas, letters, and contracts with variables and conditional sections.",
     ["Create a template with variables ({company_name}, {total})",
      "Add conditional sections (show/hide based on data)",
      "Multi-language support (en, sr, tr, de, ru)",
      "Preview with sample data",
      "Use templates when generating documents"],
     505, None),
    ("document-verification-view.tsx", "Document Verification",
     "Verify the authenticity of uploaded documents. AI-powered analysis of certificates and trade documents.",
     ["Upload a document for verification",
      "AI analyzes the document content",
      "Review the verification result",
      "Mark as verified or flagged"],
     58, None),
    # Communication
    ("mail-queue-view.tsx", "Mail Queue",
     "Monitor outbound email delivery across all tenants. Retry failed emails, cancel pending ones, and audit delivery.",
     ["View all outbound emails (cross-tenant for super admin)",
      "Filter by status (sent, failed, pending)",
      "Retry failed deliveries",
      "Cancel pending emails",
      "Click a row to view full email content"],
     177, None),
    ("email-templates-view.tsx", "Email Templates",
     "Customize the email templates sent for notifications (welcome, invoice, KYC, trial expiring, etc.).",
     ["Edit the HTML template for each notification type",
      "Use variables ({name}, {company}, {link})",
      "Preview the template with sample data",
      "Templates apply to all tenants (platform-level)"],
     217, None),
    ("webhooks-view.tsx", "Webhooks",
     "Configure outbound webhooks to notify external systems of platform events (offer accepted, invoice paid, etc.).",
     ["Create a webhook with a target URL",
      "Select events to subscribe to",
      "Webhooks are signed with HMAC-SHA256",
      "View delivery history and retry failed deliveries",
      "5 retry attempts with exponential backoff"],
     193, None),
    # Administration
    ("users-view.tsx", "Users",
     "Manage users in your tenant. Create accounts, assign roles, reset passwords, and manage 2FA.",
     ["Click 'Add User' to create a new account",
      "Assign role (user, admin)",
      "Reset password if a user forgets theirs",
      "Disable 2FA if a user is locked out",
      "Delete users (type-to-confirm for admins)"],
     184, None),
    ("settings-view.tsx", "Settings",
     "Configure your tenant settings — company profile, security policy, email (SMTP/Resend), integrations, and more.",
     ["Company tab: set your company name, logo, address",
      "Security tab: configure password policy, 2FA enforcement",
      "Communications tab: set up email (Resend or SMTP)",
      "Integrations tab: connect external services",
      "Super admin sees a scope banner (Platform vs Tenant)"],
     184, None),
    ("security-view.tsx", "Security",
     "View login history, active sessions, trusted devices, and known IPs. Revoke sessions and manage account security.",
     ["Review recent login attempts",
      "Revoke suspicious sessions",
      "Remove trusted devices",
      "View known IPs",
      "Configure 2FA from Settings"],
     204, None),
    ("vault-view.tsx", "Vault",
     "Securely store encrypted secrets (API keys, passwords, certificates) with audit-tracked access.",
     ["Add a secret with a key, value, and description",
      "Secrets are AES-256-GCM encrypted at rest",
      "Click the eye icon to reveal a value (auto-hides after 30s)",
      "Every reveal is audit-logged",
      "Secrets are tenant-scoped"],
     259, None),
    ("api-keys-view.tsx", "API Keys",
     "Create API keys for programmatic access to the platform. Scope permissions, set expiry, and monitor usage.",
     ["Create an API key with a name and scope",
      "Copy the key immediately (shown only once)",
      "Set an expiry date",
      "Revoke keys when no longer needed",
      "Use the key in the Authorization: Bearer header"],
     204, None),
    ("api-integrations-view.tsx", "API Integrations",
     "Connect external data services to enrich your trade platform (exchange rates, shipping, customs, etc.).",
     ["Browse available integrations",
      "Configure credentials for each integration",
      "Test the connection",
      "Integrations run in the background to update data"],
     380, None),
    ("audit-view.tsx", "Audit Logs",
     "View all actions taken in your tenant — who did what, when, and from where. Export for compliance.",
     ["Filter by action type, user, entity, or date range",
      "Search by keyword",
      "Export to CSV for compliance reports",
      "Logs are append-only (tamper-proof)"],
     165, None),
    # Platform (super admin)
    ("platform-dashboard-view.tsx", "Platform Dashboard",
     "Platform-wide overview — total tenants, users, posts, revenue, AI calls, and growth trends.",
     ["View KPIs across all tenants",
      "Monitor growth trends",
      "Quick-link to key admin actions"],
     54, None),
    ("super-admin-overview-view.tsx", "Tenants",
     "Manage all tenants on the platform. Create, edit, suspend, delete, and manage plans.",
     ["View all tenants with stats (users, partners, deals)",
      "Edit tenant details (name, plan, features)",
      "Suspend a tenant (blocks all users)",
      "Activate a suspended tenant",
      "Extend trial by 7 days",
      "Delete (type-to-confirm)",
      "Impersonate a tenant to see their view"],
     535, None),
    ("platform-users-view.tsx", "All Users",
     "Cross-tenant user management. Create, delete, reset passwords, change roles, and manage 2FA for any user.",
     ["View all users across all tenants",
      "Filter by role or tenant",
      "Create new users",
      "Reset passwords",
      "Change roles (user/admin/super_admin)",
      "Disable 2FA",
      "Delete (type-to-confirm for admins)"],
     None, 231),  # main render CardTitle at line 231
    ("platform-audit-view.tsx", "Platform Audit",
     "All audit logs across all tenants. Filter by tenant, action, user, entity, or date. Export to CSV.",
     ["Filter by tenant, action, user, entity, date range",
      "Search by keyword",
      "Export to CSV",
      "Logs are append-only (tamper-proof)"],
     None, 192),  # main render CardTitle at line 192
    ("platform-health-view.tsx", "System Health",
     "Monitor platform health — database, API latency, error rates, cron job status, and queue depths.",
     ["View DB health metrics",
      "Monitor API latency and error rates",
      "Check cron job status",
      "View queue depths (mail, webhooks)"],
     None, 76),  # main render CardTitle at line 76
    ("admin/performance-view.tsx", "Performance",
     "Application performance metrics — memory usage, response times, slow queries, and APM traces.",
     ["View memory and CPU usage",
      "Monitor response times",
      "Identify slow queries",
      "View APM traces for slow requests"],
     None, 277),  # main render CardTitle at line 277
    ("feature-flags-view.tsx", "Feature Flags",
     "Enable or disable features per tenant. Control which modules each tenant can access.",
     ["Toggle features on/off per tenant",
      "Set defaults for new tenants",
      "Changes take effect immediately (cache invalidated)",
      "Use to A/B test or gradually roll out features"],
     378, None),
    ("signup-requests-view.tsx", "Signup Requests",
     "Approve or reject new tenant signup requests. Only approved tenants can access the platform.",
     ["Review pending signup requests (company, contact, email)",
      "Approve to activate the tenant (14-day trial starts)",
      "Reject to delete the request + notify the user",
      "Badge count on sidebar shows pending requests"],
     162, None),
    ("super-admin-settings-view.tsx", "Platform Settings",
     "Platform-level configuration — branding (white-label), roles, security policy, data protection, and monitoring.",
     ["Configure platform branding (name, logo, colors, domain)",
      "Manage roles and permission overrides",
      "Set platform-wide security policy",
      "Configure data retention (GDPR)",
      "Set up monitoring and incident alerts"],
     78, None),
    # Other
    ("dashboard-view.tsx", "Dashboard",
     "Your tenant overview — KPIs, recent activity, quick actions, and charts.",
     ["View KPIs (partners, deals, invoices, revenue)",
      "See recent activity feed",
      "Quick actions (add partner, create invoice, etc.)",
      "Charts show trends over time"],
     None, None),  # special: h1 at line 290
    ("custom-dashboard-view.tsx", "Custom Dashboard",
     "Customize your dashboard with widgets. Drag and arrange to fit your workflow.",
     ["Add widgets from the widget library",
      "Drag to rearrange",
      "Remove widgets you don't need",
      "Your layout is saved automatically"],
     None, None),  # special: h1 at line 1100
    ("calendar-view.tsx", "Calendar",
     "View and manage your trade events — deal deadlines, invoice due dates, meetings, and reminders.",
     ["View events by month/week/day",
      "Click a date to add an event",
      "Color-coded by event type",
      "Syncs with deals and invoices"],
     120, None),
    ("quick-notes-view.tsx", "Quick Notes",
     "Jot down quick notes and reminders. Pin important notes for easy access.",
     ["Create a note with a title and body",
      "Pin notes to keep them on top",
      "Color-code notes by category",
      "Notes are private to you"],
     46, None),
    ("logistics-requests-view.tsx", "Logistics Requests",
     "Manage logistics requests — freight booking, customs clearance, container booking, and shipment tracking.",
     ["Create a logistics request (freight, customs, container)",
      "Track shipment status",
      "View shipment history",
      "Link to deals and invoices"],
     185, None),
    ("portal-locations-view.tsx", "Portal Locations",
     "View client GPS locations captured during portal logins (security audit).",
     ["View login locations on a map",
      "Filter by partner or date",
      "Flag suspicious locations",
      "Used for fraud prevention"],
     155, None),
]


def j(s):
    """JSON-encode a string for use as a JS string literal (double-quoted).
    Non-ASCII chars are kept literal (not escaped) for readability."""
    return json.dumps(s, ensure_ascii=False)


def build_tooltip_jsx(title, description, how_to_use, indent="      "):
    """Build the <ModuleInfoTooltip .../> JSX string with proper indentation."""
    title_s = j(title)
    desc_s = j(description)
    how_s = j(how_to_use)
    return (
        f"{indent}<ModuleInfoTooltip\n"
        f"{indent}  title={title_s}\n"
        f"{indent}  description={desc_s}\n"
        f"{indent}  howToUse={how_s}\n"
        f"{indent}/>"
    )


def find_closing_selfclose(lines, start_idx):
    """Given 0-based start_idx of an opening tag like `<PageHeader`,
    find the 0-based index of the line that ends with `/>` that closes
    that element. We track nested JSX by counting `<...` opens vs `/>`/`</>`
    closes on each line, ignoring comments and string contents.

    Simple heuristic: walk forward, count occurrences of `<TAG` (opening,
    excluding self-closing `<TAG .../>`) versus `</TAG>` and self-closing
    `/>`. We stop when depth reaches 0 right after a self-close or
    matching close tag.
    """
    # We track: when we see `<PageHeader` (or any `<Word`) that's not
    # immediately followed by `/>`, depth += 1. When we see `/>` on a line
    # or `</Word>`, depth -= 1.
    # But for simplicity in JSX with attributes spanning lines, we'll
    # count: depth starts at 1 (we just opened PageHeader).
    # For each line, find tokens that look like JSX opening tags
    # (`<Word`) and closing tokens (`/>` or `</Word>`).
    # This is a heuristic — for the views in this codebase it should
    # work because PageHeader's `actions` prop has nested JSX that
    # opens/closes cleanly per line.

    depth = 1  # we already opened PageHeader
    i = start_idx
    while i < len(lines):
        line = lines[i]
        # Strip line comments
        clean = re.sub(r"//.*$", "", line)
        clean = re.sub(r"/\*.*?\*/", "", clean)
        # Strip JSX expression containers content (heuristic: ignore
        # anything inside {...}) — too risky, skip.
        # Count tokens:
        # - self-closing `/>` (each reduces depth by 1)
        # - closing tags `</Word>` (each reduces depth by 1)
        # - opening tags `<Word` (each increases depth by 1) — note that
        #   this also matches `<Word ... />` self-closing on same line, but
        #   then the `/>` count subtracts it back, net 0 (correct).
        self_closes = len(re.findall(r"/>", clean))
        closing_tags = len(re.findall(r"</\w", clean))
        opens = len(re.findall(r"<\w", clean))
        if i == start_idx:
            # we already counted the PageHeader opening in depth=1
            opens -= 1
        delta = opens - self_closes - closing_tags
        depth += delta
        if depth <= 0:
            return i
        i += 1
    return None


def add_import(lines, import_line_text="import { ModuleInfoTooltip } from \"@/components/common/module-info-tooltip\";"):
    """Add the ModuleInfoTooltip import right after the existing
    `import { PageHeader } from \"@/components/common/page-header\";` line.
    Fallback: insert after any `@/components/common/` import.
    If already present, return unchanged.
    """
    for i, line in enumerate(lines):
        if "module-info-tooltip" in line:
            return lines  # already imported
    # Primary: look for PageHeader import
    for i, line in enumerate(lines):
        if "page-header" in line and "import" in line:
            return lines[:i + 1] + [import_line_text + "\n"] + lines[i + 1:]
    # Fallback: any @/components/common/ import
    for i, line in enumerate(lines):
        if "@/components/common/" in line and "import" in line:
            return lines[:i + 1] + [import_line_text + "\n"] + lines[i + 1:]
    raise RuntimeError("Could not find PageHeader import line")


def process_pageheader_view(filepath, start_line, tooltip_title, description, how_to_use):
    """Process a view where the main render has a PageHeader."""
    text = filepath.read_text()
    lines = text.split("\n")
    # Find the PageHeader opening line at 1-based start_line
    # (the grep gave us 1-based line numbers)
    idx = start_line - 1
    if "<PageHeader" not in lines[idx]:
        # Could be off by a line — search a small window
        for j in range(max(0, idx - 2), min(len(lines), idx + 3)):
            if "<PageHeader" in lines[j]:
                idx = j
                break
        else:
            raise RuntimeError(f"Could not find <PageHeader at line {start_line} in {filepath}")
    # Find closing `/>`
    end_idx = find_closing_selfclose(lines, idx)
    if end_idx is None:
        raise RuntimeError(f"Could not find closing /> for PageHeader in {filepath}")
    # Determine indent of the PageHeader opening line
    opening = lines[idx]
    indent = opening[:len(opening) - len(opening.lstrip())]
    tooltip_jsx = build_tooltip_jsx(tooltip_title, description, how_to_use, indent=indent)
    # Insert tooltip right after end_idx
    new_lines = lines[:end_idx + 1] + [tooltip_jsx] + lines[end_idx + 1:]
    # Add import
    new_lines = add_import(new_lines)
    filepath.write_text("\n".join(new_lines))


def process_cardtitle_view(filepath, cardtitle_line, tooltip_title, description, how_to_use):
    """Process a view where the main render has a CardTitle (no PageHeader).
    We insert the tooltip as a sibling inside the CardTitle's flex container.
    The CardTitle element looks like:
        <CardTitle className="flex items-center gap-2 text-base"><Icon /> Some Title</CardTitle>
    We transform it to:
        <CardTitle className="flex items-center gap-2 text-base"><Icon /> Some Title <ModuleInfoTooltip .../></CardTitle>
    """
    text = filepath.read_text()
    lines = text.split("\n")
    idx = cardtitle_line - 1
    if "<CardTitle" not in lines[idx]:
        for k in range(max(0, idx - 2), min(len(lines), idx + 3)):
            if "<CardTitle" in lines[k]:
                idx = k
                break
        else:
            raise RuntimeError(f"Could not find <CardTitle at line {cardtitle_line} in {filepath}")
    # The CardTitle might span multiple lines. Find the closing </CardTitle>
    # starting from idx.
    start_idx = idx
    end_idx = idx
    while end_idx < len(lines) and "</CardTitle>" not in lines[end_idx]:
        end_idx += 1
    if end_idx >= len(lines):
        raise RuntimeError(f"Could not find </CardTitle> in {filepath}")
    # Insert the tooltip JSX right before `</CardTitle>` on end_idx line.
    tooltip_inline = (
        f' <ModuleInfoTooltip title={j(tooltip_title)} '
        f'description={j(description)} '
        f'howToUse={j(how_to_use)} />'
    )
    lines[end_idx] = lines[end_idx].replace("</CardTitle>", f"{tooltip_inline}</CardTitle>", 1)
    new_lines = add_import(lines)
    filepath.write_text("\n".join(new_lines))


def process_h1_view(filepath, h1_line, tooltip_title, description, how_to_use, transform="flex"):
    """Process a view where the main render has an h1 (no PageHeader).
    We add `flex items-center gap-2` to the h1 className and insert the
    tooltip as the last child of the h1.
    """
    text = filepath.read_text()
    lines = text.split("\n")
    idx = h1_line - 1
    if "<h1" not in lines[idx]:
        for k in range(max(0, idx - 2), min(len(lines), idx + 3)):
            if "<h1" in lines[k]:
                idx = k
                break
        else:
            raise RuntimeError(f"Could not find <h1 at line {h1_line} in {filepath}")
    # The h1 might span multiple lines. We want to add the tooltip right
    # before the closing </h1>. Find the closing tag.
    end_idx = idx
    while "</h1>" not in lines[end_idx]:
        end_idx += 1
        if end_idx >= len(lines):
            raise RuntimeError(f"Could not find </h1> in {filepath}")
    # Add `flex items-center gap-2` to h1 className if not already flex
    h1_open = lines[idx]
    if "className=" in h1_open and "flex" not in h1_open:
        # add flex to className
        h1_open = re.sub(
            r'className="([^"]*)"',
            r'className="\1 flex items-center gap-2"',
            h1_open,
            count=1,
        )
        lines[idx] = h1_open
    elif "className=" not in h1_open:
        # add className
        h1_open = h1_open.replace("<h1", '<h1 className="flex items-center gap-2"', 1)
        lines[idx] = h1_open
    # Insert the tooltip right before </h1>
    closing_line = lines[end_idx]
    if "</h1>" in closing_line:
        tooltip_inline = (
            f' <ModuleInfoTooltip title={j(tooltip_title)} '
            f'description={j(description)} '
            f'howToUse={j(how_to_use)} />'
        )
        new_closing = closing_line.replace("</h1>", f"{tooltip_inline}</h1>", 1)
        lines[end_idx] = new_closing
    new_lines = add_import(lines)
    filepath.write_text("\n".join(new_lines))


def main():
    changed = []
    skipped = []
    for entry in TOOLTIPS:
        fname, title, desc, how, ph_line, ct_line = entry
        fpath = ROOT / fname
        if not fpath.exists():
            print(f"MISS: {fname} (file not found)")
            skipped.append(fname)
            continue
        # Idempotency check: skip if already processed
        if "module-info-tooltip" in fpath.read_text():
            print(f"SKIP: {fname} (already has ModuleInfoTooltip)")
            continue
        try:
            if ph_line is not None:
                process_pageheader_view(fpath, ph_line, title, desc, how)
            elif ct_line is not None:
                process_cardtitle_view(fpath, ct_line, title, desc, how)
            else:
                # h1 view — find the h1 line dynamically
                # special-case dashboard-view.tsx and custom-dashboard-view.tsx
                if fname == "dashboard-view.tsx":
                    process_h1_view(fpath, 290, title, desc, how)
                elif fname == "custom-dashboard-view.tsx":
                    process_h1_view(fpath, 1100, title, desc, how)
                else:
                    raise RuntimeError(f"Unknown h1 view: {fname}")
            changed.append(fname)
            print(f"OK:   {fname}")
        except Exception as e:
            print(f"ERR:  {fname}: {e}")
            skipped.append(fname)
    print()
    print(f"Changed {len(changed)} files, skipped {len(skipped)}")
    return 0 if not skipped else 1


if __name__ == "__main__":
    sys.exit(main())
