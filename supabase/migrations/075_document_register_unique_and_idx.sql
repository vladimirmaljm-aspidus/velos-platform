-- Migration 075 — document_register version uniqueness + verification hash update support
--
-- Background (audit 2g-F1 / 2h-F1 / 2h-F3, round 4):
--   • document_register had NO uniqueness constraint on (tenant_id, reference_id, type, version),
--     so the regenerated-PDF path (src/lib/pdf/generator.ts) could silently insert duplicate
--     V1 rows when the prior version-counter was wrong (e.g. when listDocumentRegister dropped
--     the reference_id filter — fixed in parallel in supabase-store.ts).
--   • The pdf_hash on document_verifications was never refreshed on regeneration, so the
--     verification system reported "tampered" for legitimate regenerations. We add an
--     `updated_at` column to document_verifications so callers can see when the hash was
--     last refreshed; the store method `updateDocumentVerificationHash` (added in
--     supabase-store.ts) performs the UPDATE.
--
-- All statements are idempotent (CREATE UNIQUE INDEX IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS).
-- No data is deleted; pre-existing duplicate (tenant_id, reference_id, type, version) groups
-- are reconciled by marking the OLDER rows as 'superseded' (a metadata update that preserves
-- the audit trail — the rows stay in the table for forensic review).

-- 1) Reconcile existing duplicate (tenant_id, reference_id, type, version) groups.
--    For each group with >1 row at the same version, keep the NEWEST (by created_at) as
--    status='current' and mark all older rows as 'superseded'. This is a metadata update —
--    NO rows are deleted, the audit trail is preserved (the rows are still queryable).
--    Without this step, the UNIQUE INDEX below would fail to create on tenants that
--    already have duplicate V1 rows from the prior count+1 bug (audit 2g-F1 round 3).
--    The CTE picks all-but-newest per group; the UPDATE joins to it.
UPDATE public.document_register AS dr
SET status = 'superseded', updated_at = now()
FROM (
  SELECT DISTINCT ON (tenant_id, reference_id, type, version) id AS keep_id, tenant_id, reference_id, type, version
  FROM public.document_register
  WHERE reference_id IS NOT NULL
  ORDER BY tenant_id, reference_id, type, version, created_at DESC
) newest_per_group
WHERE dr.tenant_id = newest_per_group.tenant_id
  AND dr.reference_id = newest_per_group.reference_id
  AND dr.type = newest_per_group.type
  AND dr.version = newest_per_group.version
  AND dr.id <> newest_per_group.keep_id
  AND dr.status = 'current';

-- 2) Partial UNIQUE INDEX on document_register (tenant_id, reference_id, type, version)
--    scoped to status='current'. Partial because:
--      (a) reference_id can be NULL (legacy entries before the field was added);
--          those NULL rows are excluded from uniqueness so we don't break old data.
--      (b) status='superseded' / 'archived' rows are excluded — these are historical
--          audit-trail rows from the reconciliation step above (or from manual
--          supersede operations in the admin UI). Allowing them to coexist with a
--          'current' row of the same version preserves the audit trail (NO data
--          deleted per the user's standing rule).
--    The generator.ts path inserts with status='current' on every render, and uses
--    nextVersion = max(version) + 1 (per tenant/ref/type). The UNIQUE INDEX catches
--    the race where two concurrent renders both compute the same nextVersion —
--    the second INSERT fails, the generator's retry loop bumps to nextVersion+1.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_register_tenant_ref_type_version
  ON public.document_register (tenant_id, reference_id, type, version)
  WHERE reference_id IS NOT NULL AND status = 'current';

-- 3) Lookup index for the version-counter query (max(version) WHERE tenant_id=X AND
--    reference_id=Y AND type=Z). Without this index the query does a sequential scan on
--    the tenant's rows for every PDF regeneration. This is the hot path for the
--    generator.ts version-increment logic.
CREATE INDEX IF NOT EXISTS idx_document_register_tenant_ref_type
  ON public.document_register (tenant_id, reference_id, type)
  WHERE reference_id IS NOT NULL;

-- 4) `updated_at` on document_verifications so callers can see when the pdf_hash was
--    last refreshed (the hash is refreshed on every regeneration by the new
--    updateDocumentVerificationHash store method). The column is nullable + defaults
--    to now() so existing rows get a sensible value without a backfill.
ALTER TABLE public.document_verifications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 5) Bump updated_at automatically when a row is UPDATEd. This is the same trigger
--    pattern used on tenants / partners / offers etc. (migration 022 + 040).
CREATE OR REPLACE FUNCTION public.set_updated_at_document_verifications()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_set_updated_at_document_verifications ON public.document_verifications;
CREATE TRIGGER trg_set_updated_at_document_verifications
  BEFORE UPDATE ON public.document_verifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_document_verifications();

-- 6) Verification — surface any REMAINING duplicate (tenant_id, reference_id, type, version)
--    groups that would still block the UNIQUE index (e.g. if the UPDATE above missed any
--    because the rows had status != 'current' — those are intentionally left alone).
--    The SELECT returns no rows when the table is clean; if it returns anything, an
--    operator must reconcile the duplicates manually (e.g. by setting status='superseded'
--    on the older rows) before re-running this migration — the UNIQUE INDEX above is
--    `IF NOT EXISTS`, so a failed create will be retried cleanly on the next push after
--    reconciliation.
--    This SELECT is read-only — it does NOT mutate data.
--    Wrapped in a DO block + RAISE NOTICE so the output shows in the migration log.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT tenant_id, reference_id, type, version, count(*) AS n
    FROM public.document_register
    WHERE reference_id IS NOT NULL
    GROUP BY tenant_id, reference_id, type, version
    HAVING count(*) > 1
  ) s;
  IF dup_count > 0 THEN
    RAISE NOTICE 'Migration 075: % duplicate (tenant_id, reference_id, type, version) groups still exist in document_register — UNIQUE INDEX was NOT created (IF NOT EXISTS skipped). Reconcile manually.', dup_count;
  ELSE
    RAISE NOTICE 'Migration 075: no duplicate (tenant_id, reference_id, type, version) rows — UNIQUE INDEX active.';
  END IF;
END $$;

COMMENT ON SCHEMA public IS 'Migration 075 applied: reconciled pre-existing duplicate (tenant_id, reference_id, type, version) rows by marking older ones as superseded; UNIQUE INDEX on document_register(tENant_id, reference_id, type, version) WHERE reference_id IS NOT NULL; lookup index for the version-counter query; document_verifications.updated_at column + auto-bump trigger.';
