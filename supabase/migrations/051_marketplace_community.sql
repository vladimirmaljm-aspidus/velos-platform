-- Marketplace Phase 10 — community features.
--
-- Backs the four community surfaces in src/app/portal/marketplace/community:
--   • marketplace_groups             — industry / commodity groups
--   • marketplace_group_members      — membership roster (partner × group)
--   • marketplace_questions          — Q&A threads
--   • marketplace_answers            — answers under a question, with upvotes
--                                      and the "accepted answer" flag
--   • marketplace_events             — events calendar (conferences, webinars,
--                                      trade shows, auctions, meetings, workshops)
--   • marketplace_event_registrations— per-partner registration ledger
--   • marketplace_blog_posts         — blog feed (draft / published / archived)
--
-- SECURITY MODEL
--   • partner_id is the canonical key for "who". It is stamped from the
--     auth context by the API route (the store never trusts a body-supplied
--     partner_id) — same convention as marketplace_posts.
--   • Group privacy: a private group is still LISTABLE (name + description +
--     member count are public) but its Q&A threads are gated behind group
--     membership. Public groups are fully open.
--   • Event registrations are unique per (event_id, partner_id) so a partner
--     cannot double-register.
--   • Blog posts are stamped by author_partner_id; the published_at column
--     is set when status flips to `published`.

-- ─── Community groups ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT,
  member_count INTEGER DEFAULT 0,
  is_private BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES marketplace_groups(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL,
  role TEXT DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, partner_id)
);

-- ─── Q&A ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES marketplace_groups(id) ON DELETE SET NULL,
  partner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  tags JSONB DEFAULT '[]',
  views_count INTEGER DEFAULT 0,
  answers_count INTEGER DEFAULT 0,
  is_answered BOOLEAN DEFAULT false,
  accepted_answer_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES marketplace_questions(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  is_accepted BOOLEAN DEFAULT false,
  upvotes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Events calendar ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  event_type TEXT CHECK (event_type IN ('conference', 'webinar', 'trade_show', 'auction', 'meeting', 'workshop')),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  location TEXT,
  is_online BOOLEAN DEFAULT false,
  meeting_url TEXT,
  organizer_partner_id TEXT,
  attendees_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES marketplace_events(id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id, partner_id)
);

-- ─── Blog ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  excerpt TEXT,
  cover_image_url TEXT,
  tags JSONB DEFAULT '[]',
  author_partner_id TEXT,
  status TEXT DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  views_count INTEGER DEFAULT 0,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mg_slug ON marketplace_groups(slug);
CREATE INDEX IF NOT EXISTS idx_mgm_group ON marketplace_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_mq_group ON marketplace_questions(group_id);
CREATE INDEX IF NOT EXISTS idx_ma_question ON marketplace_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_me_date ON marketplace_events(start_date);
CREATE INDEX IF NOT EXISTS idx_mbp_slug ON marketplace_blog_posts(slug);
