import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";
import { sendEmail } from "@/lib/email/service";

export const runtime = "nodejs";

/**
 * POST /api/mail-queue/[id]/retry
 *
 * Manually re-attempt sending a queued or failed mail_queue entry. Triggered by
 * an admin via the "Retry" button in the Mail Queue view.
 *
 * Idempotency: this route does NOT auto-retry (per Re-Audit-2 N9 / rule 5).
 * Each call attempts one send. If the send fails again, the queue entry is
 * updated with the new error and attempts counter; an in-app notification is
 * re-broadcast by `sendEmail()`'s catch block so the admin sees the latest
 * failure in their notification dropdown.
 *
 * Auth: requires `mail-queue.update` permission (admin-only).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (mail-queue.update)
    {
      const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "mail-queue.update");
      if (_d) return _d;
    }
    // Feature gate (module_mail_queue)
    {
      const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_mail_queue", auth.isSuperAdmin);
      if (_f) return _f;
    }

    const { id } = await params;

    // Fetch the mail queue entry. We use the Supabase client directly so we
    // can scope by id + tenant_id in one call (the store's listMailQueue
    // returns all rows for super-admins; we want tenant ownership enforced
    // even when the store layer doesn't).
    const { getSupabase } = await import("@/lib/supabase/client");
    const sb = getSupabase();
    const tid = auth.tenantId;

    let q = sb.from("mail_queue").select("*").eq("id", id);
    if (!auth.isSuperAdmin && tid) {
      q = q.eq("tenant_id", tid);
    }
    const { data: entry, error } = await q.maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!entry) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Refuse to retry an entry that's already been sent successfully.
    if ((entry as any).status === "sent") {
      return NextResponse.json(
        { error: "This email was already sent successfully — no retry needed." },
        { status: 409 },
      );
    }

    // Try to resend.
    try {
      const result = await sendEmail({
        to: (entry as any).to_email,
        subject: (entry as any).subject,
        html: (entry as any).body,
        tenantId: (entry as any).tenant_id || tid,
      });

      if (!result.success) {
        // sendEmail() already updated the queue entry (attempts+1, new error)
        // and re-broadcast the failure notification — surface the error.
        return NextResponse.json({ error: result.error || "Retry failed." }, { status: 500 });
      }

      // Mark as sent in the queue (sendEmail may have already updated it for
      // providers that go through the success path; we double-check + bump
      // attempts for clarity).
      const nextAttempts = (Number((entry as any).attempts) || 0) + 1;
      // Defense-in-depth: scope the update by tenant_id so a concurrent tenant
      // swap can't retarget the row. (Audit finding M-4.)
      let sentUpdate = sb
        .from("mail_queue")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          attempts: nextAttempts,
          error: null,
        })
        .eq("id", id);
      if (!auth.isSuperAdmin && tid) {
        sentUpdate = sentUpdate.eq("tenant_id", tid);
      }
      await sentUpdate;

      try {
        await audit(auth.store, auth.user, req, "mail.retry_sent", "mail_queue", id, {
          to: (entry as any).to_email,
          subject: (entry as any).subject,
        });
      } catch (auditErr) {
        console.error("[mail-queue retry] audit failed:", auditErr);
      }

      return NextResponse.json({ ok: true });
    } catch (e: any) {
      // sendEmail threw — surface its error AND bump the queue entry's
      // attempts counter so the UI shows the latest retry attempt count.
      // Mark status as "failed" so the queue view shows the row as failed
      // (not silently stuck on "queued"). (Audit finding M-6.)
      const nextAttempts = (Number((entry as any).attempts) || 0) + 1;
      let failedUpdate = sb
        .from("mail_queue")
        .update({
          status: "failed",
          attempts: nextAttempts,
          error: e.message,
        })
        .eq("id", id);
      if (!auth.isSuperAdmin && tid) {
        failedUpdate = failedUpdate.eq("tenant_id", tid);
      }
      await failedUpdate;

      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  } catch (error: any) {
    console.error("[mail-queue retry]", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
