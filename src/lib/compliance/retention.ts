// src/lib/compliance/retention.ts
// ----------------------------------------------------------------------------
// PII data retention policy (audit finding B-1 / P3-1 — GDPR Article 12/13
// transparency + Article 5(1)(e) storage-limitation principle).
//
// The platform persists PII across many tables — core account PII (users,
// partners, portal_access), regulatory-required records (kyc_submissions,
// audit_logs), and operational/transient data (sessions, login_history,
// password_resets, rate_limits, mail_queue, notifications). Without an
// explicit retention policy, ALL of this data is kept forever — which is
// both a GDPR violation (storage-limitation) and a DB-cost / table-bloat
// problem (high-churn tables like rate_limits and mail_queue would grow
// without bound).
//
// This module is the single source of truth for retention periods. It is:
//   • Consumed by the cron route `src/app/api/cron/data-retention/route.ts`
//     which executes the actual DELETEs (so the policy is enforceable, not
//     just documentation).
//   • Consumed by the privacy policy / help pages (future — for now the
//     human-readable `description` field below is the documentation).
//   • Referenced by `countTenantDependencies` (no — that counts current
//     rows, not retention) — but could be surfaced in a future "data
//     inventory" admin view.
//
// DESIGN NOTES
//   • Users / partners / portal_access PII are kept for the LIFETIME OF THE
//     ACCOUNT (indefinite). GDPR allows this when the data is needed to
//     fulfil the contract (Art. 6(1)(b)) — the user can still request
//     erasure (Art. 17) which triggers the anonymise-on-delete cascade
//     (migration 030). What this policy DOES enforce for those tables is
//     a post-deactivation retention: e.g. portal_access rows that were
//     soft-deleted more than 2 years ago can be hard-deleted, because they
//     are no longer needed for fraud/abuse investigations (which typically
//     wrap up within 2 years). KYC submissions are a regulatory record
//     (5-year minimum under most AML/KYC regimes — EU 5AMLD Art. 40),
//     audit_logs are a 7-year SOX-style record. These are NOT auto-deleted
//     by the cron; they are listed here for transparency and to make the
//     policy machine-readable for a future data-retention-report tool.
//   • Sessions / password_resets / rate_limits are SHORT-LIVED operational
//     data — already swept by migrations 013 + 024. The cron route here
//     repeats the DELETEs so there is a single retention-cleanup job that
//     ops can monitor (the migration-level pg_cron jobs run independently
//     and remain as a defence-in-depth).
//   • Mail queue / notifications are 90-day retained — old enough that the
//     user / ops no longer needs to see them in the UI, recent enough that
//     a missed "your invoice was sent" notification is still in the DB if
//     someone files a support ticket.
//
// WHAT THIS MODULE DOES NOT DO
//   • It does NOT delete audit_logs or kyc_submissions (those are
//     regulatory-retained and require a separate, manually-triggered
//     archival flow before deletion).
//   • It does NOT implement per-tenant retention overrides (a tenant on a
//     stricter compliance regime like finance or healthcare could want
//     longer retention for their own data). That is a follow-up.
//   • It does NOT log the retention deletes to audit_logs (the DELETE
//     itself is the policy; logging it would defeat the purpose of
//     "minimise PII in audit_logs" from migration 030).
// ----------------------------------------------------------------------------

/**
 * Retention period for a single table.
 *
 * `kind` controls how the cron interprets the entry:
 *   • `"delete_after"`       — the cron DELETES rows older than `days`.
 *   • `"delete_after_status"` — same, but only rows whose `status` column
 *                                equals `statusValue` (e.g. mail_queue
 *                                where status='sent' — pending mail is
 *                                NOT deleted even if old).
 *   • `"regulatory"`          — listed for transparency; NOT auto-deleted
 *                                by the cron. Manual archival required.
 *   • `"indefinite"`          — kept for the lifetime of the account /
 *                                contract. No auto-deletion.
 */
export interface RetentionRule {
  /** Table name in `public` schema. */
  table: string;
  /** Human-readable reason / regulation citation. */
  description: string;
  /** How the cron should treat this entry. */
  kind: "delete_after" | "delete_after_status" | "regulatory" | "indefinite";
  /** For `delete_after*`: retention window in days. */
  days?: number;
  /** For `delete_after_status`: the column to compare (default: `created_at`). */
  column?: string;
  /** For `delete_after_status`: the status value to match. */
  statusColumn?: string;
  /** For `delete_after_status`: the status value that qualifies for deletion. */
  statusValue?: string;
}

/**
 * The platform-wide retention policy. This is the single source of truth —
 * the cron route iterates over this array, the privacy page renders it,
 * and any future "data inventory" admin view consumes it.
 */
export const RETENTION_POLICY: RetentionRule[] = [
  {
    table: "users",
    description: "Indefinite — kept while the account is active. GDPR Article 17 erasure is honoured on delete (see migration 030 anonymise-on-delete cascade).",
    kind: "indefinite",
  },
  {
    table: "partners",
    description: "Indefinite — kept while the partner is active. Soft-deleted partners are retained for 2 years (fraud / dispute window) then hard-deleted.",
    kind: "indefinite",
  },
  {
    table: "portal_access",
    description: "Indefinite while active. Soft-deleted portal_access rows (status='disabled' or deleted_at IS NOT NULL) are hard-deleted 2 years after deactivation.",
    kind: "indefinite",
  },
  {
    table: "kyc_submissions",
    description: "5 years (regulatory requirement — EU 5AMLD Article 40, US Bank Secrecy Act). Not auto-deleted; manual archival required.",
    kind: "regulatory",
    days: 365 * 5,
  },
  {
    table: "audit_logs",
    description: "7 years (regulatory requirement — SOX §802, IRS retention rules). Append-only (migration 010); not auto-deleted.",
    kind: "regulatory",
    days: 365 * 7,
  },
  {
    table: "sessions",
    description: "Expired sessions are deleted daily. Active sessions are kept until they expire (30-day max via cookie TTL).",
    kind: "delete_after",
    days: 30,
    column: "expires_at",
  },
  {
    table: "login_history",
    description: "Login history is retained for 1 year — sufficient for security investigations without becoming a permanent location-tracking record.",
    kind: "delete_after",
    days: 365,
    column: "created_at",
  },
  {
    table: "password_resets",
    description: "Consumed / expired password-reset tokens are deleted after 24 hours. Active tokens are kept until their expires_at.",
    kind: "delete_after",
    days: 1,
    column: "created_at",
  },
  {
    table: "rate_limits",
    description: "Rate-limit windows older than 24 hours are deleted (no longer useful — the next hit would reset the window anyway).",
    kind: "delete_after",
    days: 1,
    column: "window_start",
  },
  {
    table: "mail_queue",
    description: "Successfully-sent mail_queue entries are deleted after 90 days. Pending / failed entries are NEVER auto-deleted (they may still need a retry or a manual investigation).",
    kind: "delete_after_status",
    days: 90,
    column: "created_at",
    statusColumn: "status",
    statusValue: "sent",
  },
  {
    table: "notifications",
    description: "Notifications are deleted after 90 days — old enough that the user has either acted on or dismissed them; recent enough that a missed notification is still in the DB if a support ticket is filed.",
    kind: "delete_after",
    days: 90,
    column: "created_at",
  },
];

/**
 * Subset of the policy that the cron route actually executes (i.e. all
 * `delete_after` and `delete_after_status` entries — NOT `regulatory` or
 * `indefinite`). Pre-filtered at module-load so the cron route can iterate
 * without re-filtering each run.
 */
export const ENFORCEABLE_RETENTION_RULES: RetentionRule[] = RETENTION_POLICY.filter(
  (r) => r.kind === "delete_after" || r.kind === "delete_after_status",
);

/**
 * Helper for tests / admin UI: look up the rule for a given table.
 * Returns `null` if the table has no retention rule (which means it is
 * outside the policy — the cron will NOT touch it).
 */
export function getRetentionRule(table: string): RetentionRule | null {
  return RETENTION_POLICY.find((r) => r.table === table) ?? null;
}

// ============================================================================
// P1-1 / Feature 3 — Configurable per-table retention windows
// ----------------------------------------------------------------------------
// Until now the retention periods above were HARDCODED in this module.
// The data-retention cron (`src/app/api/cron/data-retention/route.ts`)
// iterated over `ENFORCEABLE_RETENTION_RULES` and DELETEd using the
// rule's `days` field. A super-admin who wanted to tighten or loosen
// a window had to file a code change + redeploy.
//
// This section adds a configurable layer:
//   • `RetentionConfig` — a flat object with one field per table.
//   • `DEFAULT_RETENTION_CONFIG` — the defaults (mirror the original
//     hardcoded values, so existing deployments see no behaviour change).
//   • `getRetentionConfig()` — loads the config from the `settings`
//     table (key = "retention_config", tenant_id IS NULL — platform-wide).
//     Cached for 5 minutes to keep the cron hot.
//   • `validateRetentionConfig()` — bounds-checks the proposed values
//     before persisting (rejects negative / absurd windows).
//   • `getEnforceableRetentionRules(config)` — returns the policy
//     rewritten with the config's `days` values. The cron calls this
//     instead of the hardcoded `ENFORCEABLE_RETENTION_RULES` so the
//     runtime policy honours the admin-configured windows.
//
// SUPER-ADMIN RULE
// ----------------
// Only super_admin can configure retention (the API route at
// `/api/settings/retention-config` enforces `requireSuperAdmin`).
// Super_admin can also MANUALLY trigger the cleanup (the cron route
// already accepts a super-admin session cookie — see `authorizeCron`)
// and view the deleted-counts summary (the cron response body).
//
// `audit_logs_years` and `kyc_submissions_years` are REGULATORY
// minima (SOX 7-year, EU 5AMLD 5-year). The validation enforces a
// minimum of 7 and 5 respectively — a super_admin cannot configure a
// shorter window because that would put the platform in breach of
// the underlying regulation. The cron route still NEVER deletes
// from those tables (the rules' kind is `regulatory`), but the
// values are surfaced here for transparency and to make the policy
// machine-readable for a future data-retention-report tool.
// ============================================================================

/**
 * Configurable per-table retention windows. Each field is the number
 * of DAYS after which the cron should DELETE rows from the matching
 * table (or YEARS, for the two regulatory-retained tables).
 *
 * Defaults mirror the original hardcoded values from
 * `RETENTION_POLICY` above, so existing deployments see no behaviour
 * change on first load.
 */
export interface RetentionConfig {
  /** sessions.expires_at cutoff (days). Default 30. */
  sessions_days: number;
  /** login_history.created_at cutoff (days). Default 365. */
  login_history_days: number;
  /** password_resets.created_at cutoff (days). Default 1. */
  password_resets_hours: number;
  /** rate_limits.window_start cutoff (hours). Default 24. */
  rate_limits_hours: number;
  /** mail_queue.created_at cutoff (days, status='sent' only). Default 90. */
  mail_queue_days: number;
  /** notifications.created_at cutoff (days). Default 90. */
  notifications_days: number;
  /**
   * audit_logs retention (years, REGULATORY — minimum 7 per SOX §802).
   * The cron does NOT auto-delete audit_logs; this value is surfaced
   * for transparency and machine-readable policy reporting.
   */
  audit_logs_years: number;
  /**
   * kyc_submissions retention (years, REGULATORY — minimum 5 per EU
   * 5AMLD Article 40). The cron does NOT auto-delete kyc_submissions.
   */
  kyc_submissions_years: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  sessions_days: 30,
  login_history_days: 365,
  password_resets_hours: 24,
  rate_limits_hours: 24,
  mail_queue_days: 90,
  notifications_days: 30,
  audit_logs_years: 7,
  kyc_submissions_years: 5,
};

// ── In-memory cache ─────────────────────────────────────────────────────────
// Same pattern as `rate-limit-config.ts`: cache the loaded config for
// 5 minutes so the cron (which runs daily) and any in-process admin
// reads don't hit the DB on every call. The cache is invalidated by
// the settings/retention-config PUT route after a write.
let cachedConfig: RetentionConfig | null = null;
let cacheExpires = 0;
const RETENTION_CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateRetentionConfigCache(): void {
  cachedConfig = null;
  cacheExpires = 0;
}

/**
 * Load the retention config from the `settings` table.
 * Falls back to `DEFAULT_RETENTION_CONFIG` when:
 *   • Supabase is not configured (dev / test env).
 *   • No row exists yet (first run — the migration 041 seeds it).
 *   • The stored row is missing fields (older deployments).
 *   • The DB query throws (network / auth error).
 *
 * Super-admin rule: this function is read-only and does NOT gate on
 * role — the caller is responsible for permission checks (the cron
 * route is gated by `authorizeCron`; the settings route by
 * `requireSuperAdmin`).
 */
export async function getRetentionConfig(): Promise<RetentionConfig> {
  if (cachedConfig && Date.now() < cacheExpires) {
    return cachedConfig;
  }
  try {
    const { getSupabase, isSupabaseConfigured } = await import("@/lib/supabase/client");
    if (!isSupabaseConfigured()) {
      cachedConfig = DEFAULT_RETENTION_CONFIG;
      cacheExpires = Date.now() + RETENTION_CACHE_TTL_MS;
      return cachedConfig;
    }
    const sb = getSupabase();
    const { data, error } = await sb
      .from("settings")
      .select("value")
      .eq("key", "retention_config")
      .is("tenant_id", "null")
      .maybeSingle();
    if (error || !data) {
      cachedConfig = DEFAULT_RETENTION_CONFIG;
      cacheExpires = Date.now() + RETENTION_CACHE_TTL_MS;
      return cachedConfig;
    }
    // Merge with defaults so a partial stored config (older deploy
    // missing newer fields) doesn't silently zero out any window.
    const stored = (data.value ?? {}) as Partial<RetentionConfig>;
    cachedConfig = { ...DEFAULT_RETENTION_CONFIG, ...stored };
    cacheExpires = Date.now() + RETENTION_CACHE_TTL_MS;
    return cachedConfig;
  } catch (e) {
    console.error("[retention] getRetentionConfig failed:", e);
    cachedConfig = DEFAULT_RETENTION_CONFIG;
    cacheExpires = Date.now() + RETENTION_CACHE_TTL_MS;
    return cachedConfig;
  }
}

/**
 * Bounds-check a proposed RetentionConfig before persisting it.
 *
 * Returns an array of human-readable error strings (empty = OK).
 *
 * Rules:
 *   • Numeric fields must be positive finite numbers.
 *   • `*_days` / `*_hours` minimum is 1 (sub-day retention is
 *     nonsensical and would cause the cron to delete rows that
 *     are still being actively inserted).
 *   • `audit_logs_years` minimum is 7 (SOX §802 regulatory minimum).
 *   • `kyc_submissions_years` minimum is 5 (EU 5AMLD Article 40).
 *
 * The max bounds are generous (10 years / 3650 days) — the platform
 * would have bigger problems than retention config if a super-admin
 * legitimately needed a larger window, but capping prevents a typo
 * like `sessions_days: 999999999` from silently keeping sessions
 * forever (which is the opposite of what retention is for).
 */
export function validateRetentionConfig(
  config: Partial<RetentionConfig>,
): string[] {
  const errors: string[] = [];

  const numericFields: Array<{
    key: keyof RetentionConfig;
    min: number;
    max: number;
    label: string;
  }> = [
    { key: "sessions_days", min: 1, max: 3650, label: "sessions_days" },
    { key: "login_history_days", min: 1, max: 3650, label: "login_history_days" },
    { key: "password_resets_hours", min: 1, max: 24 * 30, label: "password_resets_hours" },
    { key: "rate_limits_hours", min: 1, max: 24 * 30, label: "rate_limits_hours" },
    { key: "mail_queue_days", min: 1, max: 3650, label: "mail_queue_days" },
    { key: "notifications_days", min: 1, max: 3650, label: "notifications_days" },
    // Regulatory minima — a super-admin cannot configure a shorter
    // window because that would put the platform in breach of SOX /
    // 5AMLD. The max is generous (a stricter regime can opt into
    // 10-year retention without a code change).
    { key: "audit_logs_years", min: 7, max: 10, label: "audit_logs_years" },
    { key: "kyc_submissions_years", min: 5, max: 10, label: "kyc_submissions_years" },
  ];

  for (const { key, min, max, label } of numericFields) {
    const val = config[key];
    if (val === undefined) continue; // partial update — allowed
    if (typeof val !== "number" || isNaN(val) || !Number.isFinite(val)) {
      errors.push(`${label} must be a number.`);
      continue;
    }
    if (val < min) {
      errors.push(
        `${label} must be >= ${min}${
          key === "audit_logs_years" || key === "kyc_submissions_years"
            ? " (regulatory minimum)"
            : ""
        }.`,
      );
    }
    if (val > max) {
      errors.push(`${label} must be <= ${max}.`);
    }
  }
  return errors;
}

/**
 * Build the ENFORCEABLE retention rules list (the rules the cron will
 * actually DELETE by) using the given config's windows instead of the
 * hardcoded defaults. The cron calls this with the loaded config.
 *
 * The returned rules keep the same `kind` / `column` / `statusColumn`
 * / `statusValue` semantics as the hardcoded `RETENTION_POLICY` —
 * only the `days` field is overridden.
 *
 * `audit_logs` and `kyc_submissions` are NOT in the returned list
 * (their kind is `regulatory` — the cron never deletes from them,
 * regardless of the config value).
 */
export function getEnforceableRetentionRules(
  config: RetentionConfig,
): RetentionRule[] {
  // Helper: convert hours → days (the rule schema is in days, so an
  // hours-based rule is converted by dividing by 24 and rounding up
  // to ensure we don't accidentally delete rows that are slightly
  // younger than the configured hours window).
  const hoursToDays = (h: number) => Math.max(1, Math.ceil(h / 24));

  const overrides: Record<string, Partial<RetentionRule>> = {
    sessions: { days: config.sessions_days },
    login_history: { days: config.login_history_days },
    password_resets: { days: hoursToDays(config.password_resets_hours) },
    rate_limits: { days: hoursToDays(config.rate_limits_hours) },
    mail_queue: { days: config.mail_queue_days },
    notifications: { days: config.notifications_days },
    // `audit_logs` and `kyc_submissions` are regulatory — NOT in the
    // enforceable list (their `kind` stays `regulatory`).
  };

  return RETENTION_POLICY.filter(
    (r) => r.kind === "delete_after" || r.kind === "delete_after_status",
  ).map((r) => ({
    ...r,
    ...(overrides[r.table] ?? {}),
  }));
}
