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
 */
export async function markDocumentViewed(
  table: "offers" | "invoices" | "proformas",
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
    if (!(existing as any).viewed_at) {
      patch.viewed_at = new Date().toISOString();
      if ((existing as any).status === "sent") {
        patch.status = "viewed";
      }
    }
    await sb.from(table).update(patch).eq("id", id).eq("tenant_id", tenantId);
  } catch (e) {
    console.warn(`[mark-viewed:${table}]`, e);
  }
}
