-- 037_fulltext_search.sql
-- ============================================================================
-- FULL-TEXT SEARCH (tsvector + GIN) — task D-1.
--
-- Background
-- ----------
-- The global search endpoint (`/api/search`) and the list endpoints
-- (`listProducts`, `listPartners`, `listOffers`, `listInvoices`,
-- `listDeals`) all used `ILIKE '%query%'` filters. ILIKE cannot use a
-- btree index — Postgres has to seq-scan the whole table on every call.
-- For tenants with thousands of rows per table this scaled linearly
-- with table size and dominated p95 latency on the search route
-- (which previously ALSO fetched up to 1000 rows per entity and did the
-- substring match in Node.js memory).
--
-- This migration replaces ILIKE with weighted tsvector columns +
-- GIN indexes. `to_tsvector('english', ...)` normalises tokens
-- (case-folds, stems, drops stop-words) and `setweight(..., 'A'|'B'|'C')`
-- lets `ts_rank_cd` rank matches by which field they hit. A GIN index
-- on the tsvector makes `WHERE search_vector @@ plainto_tsquery('english', q)`
-- O(log n) instead of O(n).
--
-- Weighting scheme (matches the field priority implied by the legacy
-- ILIKE filters + the spec):
--   • products: name(A), sku(A), description(B), category(B), brand(C), hs_code(C)
--   • partners: name(A), email(B), contact_name(B), phone(C)
--   • offers:   number(A), subject(B), notes(C)
--   • invoices: number(A), notes(C)
--   • deals:    title(A), description(B)
--
-- IMPORTANT — column-name correction vs. the task spec
-- ----------------------------------------------------
-- The task spec (D-1) referenced `offers.offer_number` and
-- `invoices.invoice_number`. Neither column exists in the live
-- `aspidusReady` schema — both tables use a single `number` column
-- (see `src/lib/supabase/types.ts:Offer.number` and `Invoice.number`).
-- Running the spec SQL verbatim would have errored with
-- `column "offer_number" does not exist`. This migration uses the
-- actual `number` column for both tables.
--
-- Maintenance triggers
-- --------------------
-- A `BEFORE INSERT OR UPDATE` trigger on each table keeps the
-- `search_vector` column in sync with the source columns, so the
-- index stays correct without any application code change.
--
-- Idempotency
-- -----------
-- All `ALTER TABLE`, `CREATE INDEX`, `CREATE TRIGGER`, `CREATE FUNCTION`
-- statements use `IF NOT EXISTS` / `OR REPLACE` so this migration is
-- safe to run multiple times (locally, in CI, on the live DB).
--
-- Live DB application
-- -------------------
-- Applied to the live Supabase project (nwmwdsslgozqwuufjudj) via the
-- Supabase Management API `POST /v1/projects/.../database/query`
-- endpoint during task D-1. The API executes as the `postgres` role,
-- which has CREATE PRIVILEGE on the public schema, so the ALTER TABLE /
-- CREATE INDEX / CREATE TRIGGER / CREATE FUNCTION all succeed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PRODUCTS — name, sku, description, category, brand, hs_code
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_vector tsvector;

UPDATE products SET search_vector =
  setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(sku, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(brand, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(hs_code, '')), 'C');

CREATE INDEX IF NOT EXISTS products_search_idx
  ON products USING GIN (search_vector);

CREATE OR REPLACE FUNCTION products_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.sku, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.brand, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.hs_code, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_search_vector_trigger ON products;
CREATE TRIGGER products_search_vector_trigger
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();

-- ---------------------------------------------------------------------------
-- 2. PARTNERS — name, email, contact_name, phone
-- ---------------------------------------------------------------------------
ALTER TABLE partners ADD COLUMN IF NOT EXISTS search_vector tsvector;

UPDATE partners SET search_vector =
  setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(email, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(contact_name, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(phone, '')), 'C');

CREATE INDEX IF NOT EXISTS partners_search_idx
  ON partners USING GIN (search_vector);

CREATE OR REPLACE FUNCTION partners_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.email, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.contact_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.phone, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS partners_search_vector_trigger ON partners;
CREATE TRIGGER partners_search_vector_trigger
  BEFORE INSERT OR UPDATE ON partners
  FOR EACH ROW EXECUTE FUNCTION partners_search_vector_update();

-- ---------------------------------------------------------------------------
-- 3. OFFERS — number, subject, notes
--    (spec said `offer_number`; that column does NOT exist — offers use `number`)
-- ---------------------------------------------------------------------------
ALTER TABLE offers ADD COLUMN IF NOT EXISTS search_vector tsvector;

UPDATE offers SET search_vector =
  setweight(to_tsvector('english', coalesce(number, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(subject, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(notes, '')), 'C');

CREATE INDEX IF NOT EXISTS offers_search_idx
  ON offers USING GIN (search_vector);

CREATE OR REPLACE FUNCTION offers_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.number, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.subject, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.notes, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS offers_search_vector_trigger ON offers;
CREATE TRIGGER offers_search_vector_trigger
  BEFORE INSERT OR UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_search_vector_update();

-- ---------------------------------------------------------------------------
-- 4. INVOICES — number, notes
--    (spec said `invoice_number`; that column does NOT exist — invoices use `number`)
-- ---------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS search_vector tsvector;

UPDATE invoices SET search_vector =
  setweight(to_tsvector('english', coalesce(number, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(notes, '')), 'C');

CREATE INDEX IF NOT EXISTS invoices_search_idx
  ON invoices USING GIN (search_vector);

CREATE OR REPLACE FUNCTION invoices_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.number, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.notes, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_search_vector_trigger ON invoices;
CREATE TRIGGER invoices_search_vector_trigger
  BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_search_vector_update();

-- ---------------------------------------------------------------------------
-- 5. DEALS — title, description
-- ---------------------------------------------------------------------------
ALTER TABLE deals ADD COLUMN IF NOT EXISTS search_vector tsvector;

UPDATE deals SET search_vector =
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B');

CREATE INDEX IF NOT EXISTS deals_search_idx
  ON deals USING GIN (search_vector);

CREATE OR REPLACE FUNCTION deals_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deals_search_vector_trigger ON deals;
CREATE TRIGGER deals_search_vector_trigger
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deals_search_vector_update();
