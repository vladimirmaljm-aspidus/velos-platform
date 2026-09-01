import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
import { sendEmail, resolveQueueToAddress } from "@/lib/email/service";

export const runtime = "nodejs";

/**
 * POST /api/mail-queue/[id]/retry
 *
 * Manually re-attempt sending a queued or failed mail_queue entry. Triggered by
 * an admin via the "Retry" button in the Mail Queue view.
 *
 * AUDIT16 fixes applied here (see also migration 077 + sendEmail opts):
 *   1. TO-ADDRESS DECRYPT — rows queued by the pre-audit15/16 bugs stored the
 *      `enc:` ciphertext as to_email (every provider rejects it, so the retry
 *      failed forever). The stored address now runs through decryptField
 *      (no-op on plaintext); if it is still `enc:` after that (rotated key)
 *      the retry is refused with a clear, actionable error instead of
 *      silently failing again.
 *   2. NO DUPLICATE ROWS — queueEntryId is passed into sendEmail, so a failed
 *      retry UPDATES this row (attempts/error) rather than ALSO inserting a
 *      brand-new failed row (the old catch in sendEmail always inserted).
 *   3. ATTACHMENT REGENERATION — for rows carrying entity_type/entity_id
 *      (document emails), the PDF is regenerated fresh and re-attached.
 *      Previously a retried document email re-sent
 *      "Please find attached your invoice…" with NO attachment (buffers are
 *      never persisted). Legacy rows without the reference keep the old
 *      body-only behaviour.
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
      return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
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

    // ── AUDIT16 / fix 1 — resolve a usable To: address ────────────────────
    // Pre-audit15/16 rows may hold the `enc:` ciphertext (queued by the
    // encrypted-To bugs). Decrypt (no-op for plaintext) and refuse clearly
    // if the row is undecryptable — retrying a garbage address forever was
    // the exact "email keeps failing with correct settings" symptom.
    const { to: toAddress, usable: toUsable } = resolveQueueToAddress((entry as any).to_email);
    if (!toUsable) {
      const badAddrMsg =
        "This queued email's recipient address is unreadable (it was stored encrypted and cannot be decrypted with the current key). " +
        "Fix the contact's email address (Partners / Portal Access) and send the email again — this queue row cannot be retried.";
      let badUpdate = sb
        .from("mail_queue")
        .update({ status: "failed", error: badAddrMsg })
        .eq("id", id);
      if (!auth.isSuperAdmin && tid) badUpdate = badUpdate.eq("tenant_id", tid);
      await badUpdate;
      return NextResponse.json({ error: badAddrMsg }, { status: 422 });
    }

    // ── AUDIT16 / fix 3 — regenerate the PDF attachment when the row
    // references a business document (migration 077 columns). ──────────────
    let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
    const entityType = ((entry as any).entity_type as string | null | undefined) || undefined;
    const entityId = ((entry as any).entity_id as string | null | undefined) || undefined;
    if (entityType && entityId) {
      const docTypes = new Set(["offer", "invoice", "proforma", "loi"]);
      if (docTypes.has(entityType)) {
        try {
          const { generatePdf } = await import("@/lib/pdf/generator");
          const tenantIdForPdf = (entry as any).tenant_id || tid;
          if (!tenantIdForPdf || tenantIdForPdf === "SYSTEM") {
            return NextResponse.json(
              { error: "Cannot regenerate the attachment: this queue row has no tenant owner. Re-send the document from its detail page instead." },
              { status: 422 },
            );
          }

          // ── audit20 / 20-d2 — tenant re-check BEFORE regenerating ──────
          // generatePdf fetches the document by id ONLY (no tenant
          // scoping) and brands it with the passed tenantId — so a queue
          // row whose tenant_id drifts from the actual document owner (a
          // stale/mismatched row) would silently render tenant-A branding
          // over tenant-B's document and email it out. Fetch the document
          // ourselves and verify ownership first. Store fetch ERRORS
          // (missing method, store outage) degrade to the legacy
          // no-attachment retry — the same semantics as the generatePdf
          // failure path below — instead of blocking the retry, because
          // generatePdf would hit the same store error anyway.
          let doc: { tenant_id?: string | null } | null = null;
          let docFetchFailed = false;
          try {
            if (entityType === "offer") doc = (await auth.store.getOffer(entityId)) ?? null;
            else if (entityType === "invoice") doc = (await auth.store.getInvoice(entityId)) ?? null;
            else if (entityType === "proforma") doc = (await auth.store.getProforma(entityId)) ?? null;
            else doc = (await auth.store.getLoi(entityId)) ?? null;
          } catch (docErr: any) {
            docFetchFailed = true;
            console.error("[mail-queue retry] document fetch failed — skipping attachment regeneration:", docErr);
          }

          if (!docFetchFailed) {
            if (!doc) {
              return NextResponse.json(
                {
                  error:
                    "Cannot regenerate the attachment: the document no longer exists (it may have been deleted since the email was queued). " +
                    "Re-send or update the email from the document's detail page instead.",
                },
                { status: 422 },
              );
            }
            if (doc.tenant_id !== tenantIdForPdf) {
              // No tenant ids in the message — just the actionable fact.
              return NextResponse.json(
                {
                  error:
                    "Document tenant mismatch — cannot regenerate the attachment. " +
                    "This queue row and its document belong to different tenants; re-send the document from its detail page instead.",
                },
                { status: 422 },
              );
            }
            const result = await generatePdf({ docType: entityType as any, docId: entityId, tenantId: tenantIdForPdf });
            attachments = [{
              filename: `${entityType}-${entityId}.pdf`,
              content: Buffer.from(result.buffer),
              contentType: "application/pdf",
            }];
          }
        } catch (pdfErr: any) {
          // The document may have been deleted since the email was queued —
          // retry WITHOUT the attachment rather than hard-failing (matches
          // the legacy body-only behaviour), but tell the admin.
          console.error("[mail-queue retry] PDF regeneration failed:", pdfErr);
        }
      }
    }

    // Try to resend.
    try {
      const result = await sendEmail({
        to: toAddress,
        subject: (entry as any).subject,
        html: (entry as any).body,
        tenantId: (entry as any).tenant_id || tid,
        // AUDIT16 / fix 2 — failures update THIS row (attempts/error),
        // they no longer insert a duplicate failed row.
        queueEntryId: id,
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        attachments,
      });

      if (!result.success) {
        // sendEmail() already updated the queue entry (status/error, and
        // re-broadcast the failure notification) — surface the error.
        // AUDIT17 / P2-2: sendEmail no longer writes the attempts counter
        // for retry rows (it reset it to 1) — bump it here, mirroring the
        // throw path below, so the UI shows the real attempt count.
        const nextAttempts = (Number((entry as any).attempts) || 0) + 1;
        let failedUpdate = sb
          .from("mail_queue")
          .update({
            status: "failed",
            attempts: nextAttempts,
            error: result.error || "Retry failed.",
          })
          .eq("id", id);
        if (!auth.isSuperAdmin && tid) {
          failedUpdate = failedUpdate.eq("tenant_id", tid);
        }
        await failedUpdate;
        return NextResponse.json({ error: result.error || "Retry failed." }, { status: 500 });
      }

      // Queued again (still no provider configured) — do NOT mark sent.
      if (result.queued) {
        return NextResponse.json(
          {
            ok: false,
            queued: true,
            error:
              "No email provider is configured for this tenant (Settings → Communications). The email stays queued — configure a provider, then retry.",
          },
          { status: 409 },
        );
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
          to: toAddress,
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
      // AUDIT16: sendEmail's own catch ALSO updated this row (queueEntryId),
      // so this is now a safety net rather than the primary writer.
      const nextAttempts = (Number((entry as any).attempts) || 0) + 1;
      let failedUpdate = sb
        .from("mail_queue")
        .update({
          status: "failed",
          attempts: nextAttempts,
          error: sanitizeError(e),
        })
        .eq("id", id);
      if (!auth.isSuperAdmin && tid) {
        failedUpdate = failedUpdate.eq("tenant_id", tid);
      }
      await failedUpdate;

      return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
    }
  } catch (error: any) {
    console.error("[mail-queue retry]", error);
    return NextResponse.json({ error: sanitizeError(error) || "Internal server error" }, { status: 500 });
  }
}
