-- 095_template_blocks_versions_lock.sql
-- ============================================================================
-- DOCUMENT STUDIO SYNC (audit35) — porting the sandbox Document Template
-- Studio into the production platform. Three production-grade capabilities:
--
--  1. AUTHORED TEMPLATE BODIES (block model)
--     document_templates.content_json — a strict block list (headings,
--     rich paragraphs, lists, info fields, line-item tables, quotes,
--     dividers, spacers, page breaks, images, signature blocks). NULL =
--     the template keeps the classic fixed-section flow (100% backward
--     compatible — all 7 existing templates are untouched).
--     The FRAME stays memorandum-owned: blocks render INSIDE the memo
--     frame only. content_json can never influence page setup, header,
--     footer, QR or page numbers.
--
--  2. TEMPLATE VERSIONING (publish / restore)
--     template_versions — an append-only snapshot per published version.
--     PUT/POST with publish=true snapshots the whole template; POST on
--     /api/document-templates/[id]/versions restores a snapshot as a NEW
--     version (auto-backup of the current state first). Reproducibility:
--     what a document looked like can always be re-rendered.
--
--  3. MEMORANDUM GLOBAL LOCK (hard guarantee)
--     memorandum_settings.locked — default TRUE. While locked, the
--     memorandum API refuses ANY frame edit (unlock ritual required:
--     type-to-confirm phrase "MEMORANDUM"). The renderer already reads
--     the frame from memorandum_settings ONLY (migration 090 + tests);
--     the flag closes the API hole so nothing can ever change "by
--     mistake" — not via the UI, not via a crafted PUT.
--     document_templates page_*/header_*/footer_* columns are now REJECTED
--     by the payload sanitizer (they were dead weight since audit33).
-- ============================================================================

-- 1. Block-authored template bodies ------------------------------------------
ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS content_json JSONB;

COMMENT ON COLUMN document_templates.content_json IS
  'Document Studio block body: {version:1, blocks:[...]}. NULL = classic fixed sections. Normalized by src/lib/utils/doc-blocks.ts (strict allowlist, no remote URLs, <=96KB).';

-- 2. Template version snapshots ----------------------------------------------
CREATE TABLE IF NOT EXISTS template_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  template_id  text NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  name         text NOT NULL,
  snapshot     jsonb NOT NULL,
  changelog    text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE INDEX IF NOT EXISTS template_versions_tenant_idx
  ON template_versions (tenant_id, template_id, created_at DESC);

-- Service-role only (matches doc_number_allocations / app tables pattern).
ALTER TABLE template_versions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE template_versions IS
  'Append-only publish snapshots for document templates. Restore = write snapshot back + new version entry (current state auto-snapshotted first).';

-- 3. Memorandum global lock ---------------------------------------------------
ALTER TABLE memorandum_settings
  ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT TRUE;

UPDATE memorandum_settings SET locked = TRUE WHERE locked IS NULL;

ALTER TABLE memorandum_settings
  DROP CONSTRAINT IF EXISTS memo_locked_bool_chk;
ALTER TABLE memorandum_settings
  ADD CONSTRAINT memo_locked_bool_chk CHECK (locked IS NULL OR locked IN (TRUE, FALSE));

COMMENT ON COLUMN memorandum_settings.locked IS
  'Global memorandum lock (audit35). TRUE = the frame (page/header/footer/QR) is frozen on EVERY document; edits require the unlock ritual (type MEMORANDUM). Renderer reads the frame from memorandum_settings only.';

-- 4. Prisma schema parity note ------------------------------------------------
-- prisma/schema.prisma gains DocumentTemplate.content_json (Json?) and the
-- TemplateVersion model in the same commit (PrismaStore parity; production
-- runs SupabaseStore).

-- ----------------------------------------------------------------------------
-- Verification (run in Studio after applying):
--   SELECT locked FROM memorandum_settings;                       -- all TRUE
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='document_templates' AND column_name='content_json';
--   SELECT count(*) FROM template_versions;                       -- 0
-- ----------------------------------------------------------------------------
