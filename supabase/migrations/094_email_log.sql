-- 094_email_log.sql — EMAIL AUDIT LOG + duplicate-send prevention
--
-- Purpose (owner request, task 41):
--   1. AUDIT of every outbound email attempt: recipient, subject, the EXACT
--      HTML/text that was sent, provider, provider message id, status and
--      error — the admin "Email Log" view reads this table.
--   2. DUPLICATE-SEND GUARD: before sending, the email service checks for a
--      recent successful/unconfirmed row with the same (tenant, to, subject)
--      and REFUSES the send. The owner's production complaint was: an email
--      send errors, then the same email is delivered to the recipient
--      multiple times minutes later — recipients think they are being
--      spammed. The mail_queue RETRY mechanism that caused this is removed;
--      this table replaces it as an append-only audit (no retry surface).
--
-- Status vocabulary (written server-side only):
--   sent    — provider confirmed delivery (HTTP 2xx / SMTP 250)
--   unknown — provider did NOT confirm in time (timeout / aborted request).
--             The message MAY have been delivered; a re-send within the
--             dedup window is blocked to prevent duplicates.
--   failed  — provider definitively rejected (auth error, 4xx/5xx, bad
--             address, no provider configured). Safe to re-send manually.
--
-- Idempotent: safe to re-run. Optional-table contract: every read/write in
-- the API layer is wrapped and degrades silently when the table is absent
-- (email sending itself never depends on this table being present).

CREATE TABLE IF NOT EXISTS public.email_log (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  to_email      TEXT NOT NULL,
  from_email    TEXT,
  subject       TEXT,
  -- The EXACT body that was handed to the provider (audit requirement:
  -- "tacan tekst koji je poslat").
  body_html     TEXT,
  body_text     TEXT,
  status        TEXT NOT NULL,
  provider      TEXT,
  message_id    TEXT,
  error         TEXT,
  -- Optional business-document reference (offer / invoice / proforma / loi).
  entity_type   TEXT,
  entity_id     TEXT,
  created_by    TEXT,
  ip            TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_log_tenant_time
  ON public.email_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_status
  ON public.email_log (status);
-- Serves the duplicate-send guard lookup:
--   (to_email, subject, created_at) WHERE status IN ('sent','unknown')
CREATE INDEX IF NOT EXISTS idx_email_log_dedup
  ON public.email_log (to_email, subject, created_at DESC)
  WHERE status IN ('sent', 'unknown');

COMMENT ON TABLE public.email_log IS
  'Append-only audit of every outbound email attempt (exact body text) + duplicate-send guard source. No retry surface — re-sends happen from the document send actions. Written server-side only.';

-- RLS: deny all client access (service role bypasses). The body columns
-- contain full email content — same protection level as audit_logs.
ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

-- 091 follow-up: portal_events shipped WITHOUT RLS enabled — the only
-- public-schema table in that migration family still readable by the anon
-- role. Close that gap here (service-role writes are unaffected).
ALTER TABLE public.portal_events ENABLE ROW LEVEL SECURITY;
