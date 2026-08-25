-- 057_marketplace_post_questions.sql
-- Adds `post_id` column to `marketplace_questions` so a question can be
-- attached to a specific marketplace post (post-detail Q&A surface).
--
-- Mirrors the existing `group_id` pattern: NULL = general community
-- question, non-NULL = scoped to a single post. We do NOT add a FK
-- constraint to marketplace_posts because cross-tenant posts exist on
-- the same table (service_role bypasses RLS); enforcing a FK here would
-- couple community questions to post lifecycle (cascade delete) which is
-- a behaviour change — instead, the API layer resolves the post and
-- validates tenant ownership before insert (see
-- /api/marketplace/questions POST handler).

ALTER TABLE marketplace_questions
  ADD COLUMN IF NOT EXISTS post_id UUID;

CREATE INDEX IF NOT EXISTS idx_mq_post ON marketplace_questions(post_id);

-- Backfill is N/A — the column is added with NULL default. Existing
-- rows keep `post_id = NULL` (they remain general community questions).
