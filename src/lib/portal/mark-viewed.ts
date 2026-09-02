import { getSupabase } from "@/lib/supabase/client";
// AUDIT16 — viewerEmail arrives as the portal_access.portal_email value,
// which is encrypted at rest (enc: prefix). Every call site passed the
// raw value, so viewed_by_email was silently corrupted with ciphertext on
// every portal document view. Decrypt centrally here (no-op on plaintext).
import { decryptField } from "@/lib/crypto/field-encryption";

/**
 * Record that a portal client viewed a document. Updates:
 *   - viewed_at (set ONCE on first view; subsequent views do not overwrite)
 *   - viewed_by_email (portal_access email, DECRYPTED)
 *   - view_count (+1 on every view)
 *   - status "sent" → "viewed" (only on first view)
 *
 * Fire-and-forget: never blocks or throws. If the columns don't exist
 * (older schema), it silently no-ops.
 *
 * BUILD-LOI-PORTAL — "lois" is included for the portal LOI module. NOTE:
 * the LOI state machine (status-validator.ts) has NO "viewed" status
 * (draft | sent | accepted | rejected | expired | cancelled), so viewing
 * an LOI keeps its status at "sent" — only the tracking columns update.
 */
export async function markDocumentViewed(
  table: "offers" | "invoices" | "proformas" | "lois",
  id: string,
  tenantId: string,
  viewerEmail: string | null,
): Promise<void> {
  // AUDIT16 — store the plaintext email (falls back to the raw value if
  // decryption fails, e.g. rotated key).
  const email =
    viewerEmail && viewerEmail.startsWith("enc:")
      ? decryptField(viewerEmail) || viewerEmail
      : viewerEmail;
  try {
    const sb = getSupabase();
    const { data: existing } = await sb
      .from(table)
      .select("view_count, status, viewed_at")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!existing) return;

    // Always increment view_count + update viewed_by_email.
    // Only set viewed_at on FIRST view (when it's currently null).
    const patch: Record<string, unknown> = {
      viewed_by_email: email || null,
      view_count: ((existing as any).view_count || 0) + 1,
    };
    // Only set viewed_at + promote status on the very first view.
    // (BUILD-LOI-PORTAL) lois has no "viewed" status in its state machine,
    // so the status promotion is skipped for that table — the LOI stays
    // "sent" until the partner accepts / rejects / it expires.
    if (!(existing as any).viewed_at) {
      patch.viewed_at = new Date().toISOString();
      if (table !== "lois" && (existing as any).status === "sent") {
        patch.status = "viewed";
      }
    }
    await sb.from(table).update(patch).eq("id", id).eq("tenant_id", tenantId);
  } catch (e) {
    console.warn(`[mark-viewed:${table}]`, e);
  }
}
