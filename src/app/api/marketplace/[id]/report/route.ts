import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { createPostReport } from "@/lib/data/marketplace-store";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { withApm } from "@/lib/monitoring/apm";
import { audit, sanitizeError } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { sanitizeFields } from "@/lib/security/sanitize-input";

export const runtime = "nodejs";

// POST /api/marketplace/[id]/report — report a marketplace post.
//
// Body: { reason: "scam"|"counterfeit"|"wrong_category"|"prohibited"|
//                "misleading"|"other", details?: string }
//
// Available to EVERY authenticated portal tier — abuse reporting must not
// be gated behind tier/KYC (safety of the whole community beats the
// communication policy). Rate-limited and de-duplicated: one OPEN report
// per (reporter, post). A report never auto-changes post status —
// moderation stays admin-only.
async function _post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  // 5 reports per minute per partner — abuse of the abuse-report path.
  const rl = await checkRateLimit(`mkt:report:${access.partner_id}`, 5, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many reports in a short period. Please slow down." },
      { status: 429 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const reason = typeof body?.reason === "string" ? body.reason : "";
  const details = typeof body?.details === "string" ? body.details : undefined;
  if (!reason) {
    return NextResponse.json({ error: "reason is required." }, { status: 400 });
  }

  try {
    sanitizeFields({ details }, ["details"]);
    const created = await createPostReport(
      access.tenant_id,
      access.partner_id,
      id,
      reason,
      details,
    );
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.post_reported",
        "marketplace_post",
        id,
        { report_id: created.id, reason },
      );
    } catch (e) {
      console.error("[marketplace.report] audit failed:", e);
    }
    return NextResponse.json({ ok: true, report_id: created.id });
  } catch (e: any) {
    console.error("[marketplace.report]", e);
    const msg = sanitizeError(e);
    const status = /not found/i.test(msg)
      ? 404
      : /invalid report reason|already has an open report/i.test(msg)
        ? 409
        : 500;
    return NextResponse.json({ error: msg || "Failed to submit report." }, { status });
  }
}

export const POST = withApm(_post, "POST /api/marketplace/[id]/report");
