import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, audit } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

/**
 * Super-admin approves or rejects a plan-upgrade request.
 * On approve the tenant's plan is switched and a fresh subscription window
 * is stamped (12 months from now by default; caller can override).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSuperAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const decision = body.decision as "approve" | "reject";
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "decision must be 'approve' or 'reject'." }, { status: 400 });
  }

  const sb = getSupabase();
  const { data: current } = await sb.from("plan_upgrade_requests").select("*").eq("id", id).maybeSingle();
  if (!current) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if ((current as any).status !== "pending") {
    return NextResponse.json({ error: `Request already ${(current as any).status}.` }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await sb.from("plan_upgrade_requests").update({
    status: decision === "approve" ? "approved" : "rejected",
    reviewed_by: auth.user.id,
    reviewed_at: nowIso,
    admin_note: body.admin_note || null,
    updated_at: nowIso,
  }).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (decision === "approve") {
    const months = Number(body.months || 12);
    const end = new Date();
    end.setMonth(end.getMonth() + months);
    const { error: tenantErr } = await sb.from("tenants").update({
      plan: (current as any).requested_plan,
      status: "active",
      subscription_start: nowIso,
      subscription_end: end.toISOString(),
      trial_ends_at: null,
      updated_at: nowIso,
    }).eq("id", (current as any).tenant_id);
    if (tenantErr) {
      return NextResponse.json({ error: "Failed to update tenant plan: " + tenantErr.message }, { status: 500 });
    }

    // Bust the in-memory feature-flag cache so the tenant admin sees the
    // new modules right away without logging out.
    try {
      const { invalidateFeatureCache } = await import("@/lib/api/feature-guard");
      invalidateFeatureCache((current as any).tenant_id);
    } catch { /* non-critical */ }
  }

  // Notify the requester (in-app + email) — best-effort.
  try {
    const requesterId = (current as any).requested_by as string | null;
    if (requesterId) {
      const requester = await auth.store.getUserById(requesterId);
      if (requester?.email) {
        const tenant = await auth.store.getTenant((current as any).tenant_id);
        const baseUrl = process.env.APP_BASE_URL || "https://aspidus.onrender.com";
        const { sendEmail } = await import("@/lib/email/service");
        const approved = decision === "approve";
        const subject = approved
          ? `Your ${(current as any).requested_plan} plan is active`
          : `Plan upgrade request update`;
        const html = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
            <div style="background:${approved ? "#0f766e" : "#dc2626"};color:white;padding:24px;border-radius:12px 12px 0 0;">
              <h1 style="margin:0;font-size:20px;">${approved ? "Upgrade approved" : "Upgrade not approved"}</h1>
            </div>
            <div style="background:white;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
              <p>Hi ${requester.full_name || requester.username},</p>
              ${approved
                ? `<p>Your request to upgrade <strong>${tenant?.name || "your workspace"}</strong> to <strong>${(current as any).requested_plan}</strong> has been approved. The new plan is active immediately.</p>`
                : `<p>Your request to upgrade <strong>${tenant?.name || "your workspace"}</strong> to <strong>${(current as any).requested_plan}</strong> was not approved at this time.</p>`}
              ${body.admin_note ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:16px 0;"><p style="color:#374151;margin:0;font-size:13px;">${body.admin_note}</p></div>` : ""}
              <p style="margin-top:16px;"><a href="${baseUrl}" style="background:#0f766e;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Open VELOS</a></p>
            </div>
          </div>`;
        await sendEmail({ to: requester.email, subject, html, tenantId: (current as any).tenant_id });
      }
    }
    // Also drop an in-app notification for tenant admins
    await auth.store.createNotification({
      tenant_id: (current as any).tenant_id,
      user_id: requesterId,
      partner_id: null,
      type: (decision === "approve" ? "plan_approved" : "plan_rejected") as any,
      title: decision === "approve" ? `Plan upgraded to ${(current as any).requested_plan}` : "Plan upgrade request rejected",
      message: body.admin_note || null,
      entity_type: "plan_upgrade_request",
      entity_id: id,
      action_url: "/",
      action_label: "Open",
    } as any);
  } catch (e) { console.warn("[plan-upgrade.notify]", e); }

  await audit(auth.store, auth.user, req, `plan.${decision}`, "plan_upgrade_request", id, {
    tenant_id: (current as any).tenant_id,
    requested_plan: (current as any).requested_plan,
  });
  return NextResponse.json(updated);
}
