import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import {
  encryptSensitiveFields,
  decryptSensitiveFields,
  COMMS_SENSITIVE_KEYS,
  isEncrypted,
} from "@/lib/crypto/field-encryption";
// EMAIL-AUDIT / CRITICAL — from-email spoofing guard. The settings PUT
// route is the canonical write path for the `comms` blob, so we
// validate the from-email fields here at save time (defense-in-depth
// on top of the send-time rewrite in `getEmailConfig`). Importing
// `validateFromEmailStrict` keeps the validation logic in one place
// (`src/lib/email/service.ts`) so the save-time + send-time checks
// can't drift apart.
import { validateFromEmailStrict } from "@/lib/email/service";

export const runtime = "nodejs";

/**
 * Tenant settings (SMTP config, security policy, misc per-tenant options).
 *
 * Scoping:
 *   - Tenant admin → sees ONLY their own tenant's settings.
 *   - Super admin without ?tenant_id  → sees platform-level settings (tenant_id NULL).
 *   - Super admin with ?tenant_id=X   → sees that tenant's settings.
 *
 * Secrets: SMTP passwords, API tokens etc. live under `key = "comms"` and are
 * returned to admins for editing. Never expose this endpoint to non-admins.
 *
 * P0-3 (Feature 2 — field-level encryption): the `comms` blob carries
 * sensitive secrets (smtp_password, resend_api_key, postmark_server_token).
 * These are now encrypted at rest via `encryptField` (AES-256-GCM, scrypt-
 * derived key, `enc:`-prefixed wire format — see
 * `src/lib/crypto/field-encryption.ts`). The PUT path encrypts on write;
 * the GET path decrypts on read; the email service decrypts at use. Legacy
 * plaintext values pass through during the rollout — they get encrypted
 * on the next save. The `enc:` prefix is the marker.
 */

/**
 * Apply field-level encryption to the sensitive sub-keys of a settings
 * value before persisting. Currently scoped to the `comms` blob; future
 * blobs that carry secrets should add their own key set here.
 *
 * Defensive: only mutates the value when it is a non-null object AND the
 * key is `comms` — other settings keys (e.g. `security_policy`,
 * `feature_flags`) are passed through untouched so this is a no-op for
 * every existing non-comms settings write.
 */
function encryptSettingValue<T>(key: string | undefined, value: T): T {
  if (key !== "comms") return value;
  if (!value || typeof value !== "object") return value;
  // `value` may be a deeply-typed object the caller controls; cast through
  // `Record<string, unknown>` for the field-encryption helper, which only
  // touches the listed keys.
  return encryptSensitiveFields(
    value as unknown as Record<string, unknown>,
    COMMS_SENSITIVE_KEYS,
  ) as unknown as T;
}

/**
 * Decrypt the sensitive sub-keys of a settings value on the read path.
 * Mirror of `encryptSettingValue`; see that function for the rationale.
 *
 * On decrypt failure (wrong key / tampered ciphertext), the raw `enc:...`
 * blob is preserved — the admin UI can flag the field as "could not
 * decrypt" without losing the row.
 */
function decryptSettingValue<T>(key: string | undefined, value: T): T {
  if (key !== "comms") return value;
  if (!value || typeof value !== "object") return value;
  return decryptSensitiveFields(
    value as unknown as Record<string, unknown>,
    COMMS_SENSITIVE_KEYS,
  ) as unknown as T;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (settings.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "settings.read"); if (_d) return _d; } /* requirePermission wired */


    // Determine scope
    let tenantId: string | null;
    if (auth.isSuperAdmin) {
      const url = new URL(req.url);
      const q = url.searchParams.get("tenant_id");
      tenantId = q && q !== "null" ? q : null; // super admin default = platform
    } else {
      tenantId = auth.tenantId; // regular admins locked to their tenant
      if (!tenantId) return NextResponse.json({ items: [] });
    }

    const url = new URL(req.url);
    const key = url.searchParams.get("key");
    if (key) {
      const value = await auth.store.getSetting(key, tenantId);
      // P0-3 Feature 2: decrypt sensitive comms sub-keys before exposing
      // to the admin UI so the field renders as plaintext (editable).
      const decrypted = decryptSettingValue(key, value);
      return NextResponse.json({ key, value: decrypted, tenant_id: tenantId });
    }
    const all = await auth.store.getAllSettings(tenantId);
    // Decrypt each comms entry's sensitive sub-keys in-place. Other
    // settings keys pass through `decryptSettingValue` untouched.
    // The cast through `unknown` first is required because the store's
    // return type is `Setting[]` (a narrow interface); we mutate the
    // `value` sub-field, which the `Setting` interface types loosely
    // enough that this is safe at runtime but needs the double-cast to
    // satisfy TypeScript's structural check.
    if (Array.isArray(all)) {
      for (const item of all as unknown as Array<Record<string, unknown>>) {
        const k = item?.key as string | undefined;
        if (k === "comms" && item && typeof item.value === "object") {
          item.value = decryptSettingValue(k, item.value);
        }
      }
    }
    return NextResponse.json({ items: all });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (auth instanceof NextResponse) return auth;
  // Permission gate (settings.update)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "settings.update"); if (_d) return _d; } /* requirePermission wired */


    let tenantId: string | null;
    if (auth.isSuperAdmin) {
      const url = new URL(req.url);
      const q = url.searchParams.get("tenant_id");
      tenantId = q && q !== "null" ? q : null;
    } else {
      tenantId = auth.tenantId;
      if (!tenantId) {
        return NextResponse.json({ error: "No tenant context." }, { status: 400 });
      }
    }

    const body = await req.json();
    const { key, value } = body;
    if (!key) return NextResponse.json({ error: "Missing key." }, { status: 400 });

    // EMAIL-AUDIT / CRITICAL — from-email spoofing guard at save time.
    // The `comms` blob carries up to three from-email fields:
    //   - `from_email`             (used by SMTP and as fallback for the
    //                              provider-specific from-emails)
    //   - `resend_from_email`      (Resend `from` header)
    //   - `postmark_from_email`    (Postmark `From` header)
    //
    // Each is validated against the platform allowlist
    // (`email_allowed_from_domains` platform setting, or env
    // `ALLOWED_FROM_DOMAINS`, or the default `["aspidus.onrender.com",
    // "resend.dev"]`). An invalid from-email returns a 400 with the
    // safe fallback so the admin sees the actual rewrite that would
    // happen at send time.
    //
    // NOTE: this check is skipped for the platform-level setting itself
    // (`tenantId === null`) so a super_admin can save the
    // `email_allowed_from_domains` blob without being gated by the
    // previous allowlist — they're the ones who edit the allowlist.
    if (key === "comms" && tenantId !== null && value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const candidates: Array<{ field: string; email: string }> = [];
      if (typeof v.from_email === "string" && v.from_email.trim()) {
        candidates.push({ field: "from_email", email: v.from_email });
      }
      if (typeof v.resend_from_email === "string" && v.resend_from_email.trim()) {
        candidates.push({ field: "resend_from_email", email: v.resend_from_email });
      }
      if (typeof v.postmark_from_email === "string" && v.postmark_from_email.trim()) {
        candidates.push({ field: "postmark_from_email", email: v.postmark_from_email });
      }
      // Sequential validation so the error message names the first
      // invalid field (so the admin knows which one to fix). The
      // platform-level allowlist is the same one `getEmailConfig`
      // consults at send time — they can't drift apart.
      for (const c of candidates) {
        const result = await validateFromEmailStrict(c.email);
        if (!result.valid) {
          return NextResponse.json(
            {
              error:
                `Email spoofing protection: the "${c.field}" value "${c.email}" ` +
                `uses a domain that is not on the platform's allowed from-domains list. ` +
                `Ask a super admin to add the domain to the platform setting ` +
                `"email_allowed_from_domains", or use a domain that is already ` +
                `allowed. The send would have been rewritten to "${result.fallback}".`,
            },
            { status: 400 },
          );
        }
      }
    }

    // P0-3 Feature 2: encrypt sensitive comms sub-keys before persisting.
    // `encryptSettingValue` is idempotent — re-saving a value the admin
    // loaded from GET (which decrypted it to plaintext) re-encrypts it
    // cleanly; re-saving a value that was already encrypted (e.g. a
    // partially-migrated blob) is a no-op thanks to the `enc:` prefix
    // check inside `encryptSensitiveFields`.
    const encryptedValue = encryptSettingValue(key, value);
    await auth.store.setSetting(key, encryptedValue, tenantId);
    await audit(auth.store, auth.user, req, "settings.update", "settings", key, {
      key,
      scope: tenantId ? "tenant" : "platform",
      // Log whether sensitive fields were (re)encrypted so the audit trail
      // distinguishes "admin changed SMTP host" from "admin rotated SMTP
      // password". The actual ciphertext is never logged.
      comms_fields_encrypted:
        key === "comms" && value && typeof value === "object"
          ? COMMS_SENSITIVE_KEYS.filter(
              (k) =>
                typeof (value as Record<string, unknown>)[k] === "string" &&
                (value as Record<string, unknown>)[k] !== "" &&
                !isEncrypted((value as Record<string, unknown>)[k]),
            )
          : [],
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
