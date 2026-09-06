import { getSupabase } from "@/lib/supabase/client";

/**
 * Email audit log — append-only record of EVERY outbound email attempt.
 *
 * Scope (owner request, task 41):
 *   The production complaint: "I send an email, it errors, and minutes later
 *   the SAME email is delivered to the recipient multiple times." The old
 *   mail_queue + retry surface caused that. It is REMOVED. This table is its
 *   honest replacement:
 *
 *     1. AUDIT — every attempt stores the EXACT text (HTML + plain) that was
 *        handed to the provider, the recipient, subject, provider, provider
 *        message id, status and error. The admin "Email Log" view reads it.
 *     2. DUPLICATE GUARD — before sending, the service checks for a recent
 *        'sent' OR 'unknown' row with the same (tenant, to, subject) and
 *        refuses the send. 'unknown' (provider timeout — message MAY have
 *        been delivered) blocks re-sends exactly like 'sent', because a
 *        timeout is not a failure proof and re-sending is how the owner got
 *        spammed recipients in the first place.
 *
 *   There is NO retry endpoint, NO worker, NO queue semantics anywhere on
 *   this table. Re-sends happen only from the document send actions
 *   (LOI / offer / proforma / invoice / invite), guarded by the window below.
 *
 * OPTIONAL-TABLE CONTRACT: migration 094 may not be applied yet (or the
 * lookup may error). Writes are best-effort and never throw; reads degrade
 * to "no rows" — email sending itself NEVER depends on this table.
 */

export type EmailLogStatus = "sent" | "failed" | "unknown";

/** Duplicate-send guard window. See the module docstring. */
export const EMAIL_DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export interface EmailLogRow {
  id: string;
  tenant_id: string | null;
  to_email: string;
  from_email: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  status: EmailLogStatus;
  provider: string | null;
  message_id: string | null;
  error: string | null;
  entity_type: string | null;
  entity_id: string | null;
  created_by: string | null;
  ip: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface LogEmailAttemptInput {
  id?: string;
  tenantId?: string | null;
  to: string;
  fromEmail?: string | null;
  subject: string;
  bodyHtml: string;
  bodyText?: string | null;
  status: EmailLogStatus;
  provider: string | null;
  messageId?: string | null;
  error?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  createdBy?: string | null;
  ip?: string | null;
}

/**
 * Sanitize a search term for a PostgREST `.or(ilike.…)` filter: strip the
 * OR-clause metacharacters (comma, parens, backslash) so a search string
 * can never inject an extra filter expression, and escape the LIKE
 * wildcards (% _) so "50%" matches literally. Mirrors the pattern used by
 * the old mail-queue route (HACK-SIM Fix 2).
 */
function sanitizeSearch(raw: string): string | null {
  const cleaned = raw.replace(/[(),\\]/g, " ").trim();
  if (!cleaned) return null;
  return `%${cleaned.replace(/[%_]/g, (m) => "\\" + m)}%`;
}

const EMAIL_LOG_COLUMNS = [
  "id",
  "tenant_id",
  "to_email",
  "from_email",
  "subject",
  "body_html",
  "body_text",
  "status",
  "provider",
  "message_id",
  "error",
  "entity_type",
  "entity_id",
  "created_by",
  "ip",
  "sent_at",
  "created_at",
].join(", ");

function newLogId(): string {
  // crypto.randomUUID is available in the Node 18+ runtime on Vercel.
  try {
    return crypto.randomUUID();
  } catch {
    return `el-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Append ONE attempt row. Never throws; returns the row id (null when the
 * write was skipped — e.g. table not yet applied). Callers treat the id as
 * best-effort metadata.
 */
export async function logEmailAttempt(input: LogEmailAttemptInput): Promise<string | null> {
  const id = input.id ?? newLogId();
  try {
    const sb = getSupabase();
    const { error } = await sb.from("email_log").insert({
      id,
      tenant_id: input.tenantId ?? null,
      to_email: input.to,
      from_email: input.fromEmail ?? null,
      subject: input.subject,
      body_html: input.bodyHtml,
      body_text: input.bodyText ?? null,
      status: input.status,
      provider: input.provider,
      message_id: input.messageId ?? null,
      error: input.error ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      created_by: input.createdBy ?? null,
      ip: input.ip ?? null,
      sent_at: input.status === "sent" ? new Date().toISOString() : null,
    });
    if (error) {
      // Expected pre-migration-094 (42P01 undefined_table) — keep sending
      // emails even when the audit table is not there yet.
      console.debug("[email-log] insert skipped:", error.message);
      return null;
    }
    return id;
  } catch (e) {
    console.debug("[email-log] insert failed:", e);
    return null;
  }
}

/**
 * Duplicate-send guard: the most recent 'sent' or 'unknown' row for the same
 * (tenant, to, subject) within EMAIL_DEDUP_WINDOW_MS. Returns null when
 * nothing matches (or when the table is unavailable — the guard then fails
 * OPEN so a missing audit table can never block legitimate email).
 */
export async function findRecentEmailSend(opts: {
  tenantId?: string | null;
  to: string;
  subject: string;
  withinMs?: number;
}): Promise<EmailLogRow | null> {
  try {
    const sb = getSupabase();
    const since = new Date(Date.now() - (opts.withinMs ?? EMAIL_DEDUP_WINDOW_MS)).toISOString();
    let q = sb
      .from("email_log")
      .select(EMAIL_LOG_COLUMNS)
      .eq("to_email", opts.to)
      .eq("subject", opts.subject)
      .in("status", ["sent", "unknown"] as unknown as string[])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    if (opts.tenantId) {
      q = q.eq("tenant_id", opts.tenantId);
    }
    const { data, error } = await q.maybeSingle();
    if (error) {
      console.debug("[email-log] dedup lookup skipped:", error.message);
      return null;
    }
    return ((data as unknown as EmailLogRow) || null);
  } catch (e) {
    console.debug("[email-log] dedup lookup failed:", e);
    return null;
  }
}

/**
 * Read one full row (with bodies) for the detail view. Tenant-scoped unless
 * the caller is a super admin (scope=null = cross-tenant lookup).
 */
export async function getEmailLogRow(id: string, tenantId: string | null): Promise<EmailLogRow | null> {
  try {
    const sb = getSupabase();
    let q = sb.from("email_log").select(EMAIL_LOG_COLUMNS).eq("id", id);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q.maybeSingle();
    if (error) return null;
    return ((data as unknown as EmailLogRow) || null);
  } catch {
    return null;
  }
}

/**
 * List rows for the Email Log view (bodies EXCLUDED for payload size — the
 * detail endpoint returns them). Returns { items, total, stats }.
 */
export async function listEmailLog(opts: {
  tenantId: string | null; // null = cross-tenant (super admin, no tenant selected)
  search?: string;
  status?: string; // "sent" | "failed" | "unknown" | "all"
  limit?: number;
  offset?: number;
}): Promise<{ items: Omit<EmailLogRow, "body_html" | "body_text">[]; total: number; stats: EmailLogStats }> {
  const empty: { items: never[]; total: 0; stats: EmailLogStats } = {
    items: [],
    total: 0,
    stats: { sent24h: 0, failed24h: 0, unknown24h: 0 },
  };
  try {
    const sb = getSupabase();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);

    // LIST_COLUMNS = everything except the two body columns.
    const listColumns = EMAIL_LOG_COLUMNS.replace(", body_html", "").replace(", body_text", "");
    let q = sb.from("email_log").select(listColumns);
    if (opts.tenantId) q = q.eq("tenant_id", opts.tenantId);
    if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
    if (opts.search && opts.search.trim()) {
      const s = sanitizeSearch(opts.search);
      if (s) q = q.or(`to_email.ilike.${s},subject.ilike.${s}`);
    }
    q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    const { data, error } = await q;
    if (error) {
      console.debug("[email-log] list skipped:", error.message);
      return empty;
    }

    // Total count (same filters) + 24h stats (tenant-scoped, no text filters
    // — the KPI row describes the tenant's day, not the current filter).
    let cq = sb.from("email_log").select("id", { count: "exact", head: true });
    if (opts.tenantId) cq = cq.eq("tenant_id", opts.tenantId);
    if (opts.status && opts.status !== "all") cq = cq.eq("status", opts.status);
    if (opts.search && opts.search.trim()) {
      const s = sanitizeSearch(opts.search);
      if (s) cq = cq.or(`to_email.ilike.${s},subject.ilike.${s}`);
    }
    const { count } = await cq;

    const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    let sq = sb
      .from("email_log")
      .select("status")
      .gte("created_at", since24);
    if (opts.tenantId) sq = sq.eq("tenant_id", opts.tenantId);
    const { data: statsData } = await sq;

    const stats: EmailLogStats = { sent24h: 0, failed24h: 0, unknown24h: 0 };
    for (const row of ((statsData as unknown as { status: EmailLogStatus }[]) || [])) {
      if (row.status === "sent") stats.sent24h++;
      else if (row.status === "failed") stats.failed24h++;
      else if (row.status === "unknown") stats.unknown24h++;
    }

    return {
      items: ((data as unknown as Omit<EmailLogRow, "body_html" | "body_text">[]) || []),
      total: count ?? 0,
      stats,
    };
  } catch (e) {
    console.debug("[email-log] list failed:", e);
    return empty;
  }
}

export interface EmailLogStats {
  sent24h: number;
  failed24h: number;
  unknown24h: number;
}

/** Build the duplicate-blocked error message shown to the sending admin. */
export function duplicateBlockedMessage(dedupWindowMs: number): string {
  const mins = Math.max(1, Math.round(dedupWindowMs / 60000));
  return (
    `Not sent: an identical email (same recipient and subject) was already sent recently ` +
    `or its delivery could not be confirmed. To protect the recipient from duplicates, ` +
    `re-sending is blocked for ${mins} minutes. Check the Email Log (Administration) for the exact status.`
  );
}
