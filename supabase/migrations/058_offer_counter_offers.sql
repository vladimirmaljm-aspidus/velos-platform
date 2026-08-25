-- 058_offer_counter_offers.sql
-- Adds the `counter_offers` JSONB column to `offers` so portal clients
-- can submit a counter offer (decision: "counter" in
-- /api/portal/offers/[id]/respond). Each counter appends a record to
-- the array — preserving the full negotiation history for the offer.
--
-- The offer's overall `status` becomes "countered" on the first counter;
-- subsequent accept/reject transitions are still allowed by the
-- status-validator (sent/viewed → countered; countered → accepted,
-- rejected, or countered again).
--
-- We do NOT add a CHECK constraint on `offers.status` — the column is
-- already free-text and the validator lives in
-- src/lib/api/status-validator.ts. Keeping the schema flexible lets
-- super-admins (who bypass the validator) correct any bad data.

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS counter_offers JSONB DEFAULT '[]'::jsonb;

-- Index is not needed — counter_offers is read inline with the offer row
-- and never queried directly. The column is small (max ~10 entries per
-- offer in practice) so the read cost is negligible.
