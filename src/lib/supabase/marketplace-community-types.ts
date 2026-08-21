// Marketplace Phase 10 — community types.
//
// Backs the tables added in migration 051_marketplace_community.sql:
//   • marketplace_groups              — industry / commodity groups
//   • marketplace_group_members        — membership roster (partner × group)
//   • marketplace_questions           — Q&A threads (optionally under a group)
//   • marketplace_answers             — answers under a question, with upvotes
//                                       and the "accepted answer" flag
//   • marketplace_events              — events calendar (conferences, webinars,
//                                       trade shows, auctions, meetings,
//                                       workshops)
//   • marketplace_event_registrations — per-partner registration ledger
//   • marketplace_blog_posts          — blog feed (draft / published / archived)
//
// SECURITY MODEL
//   • `partner_id` is the canonical "who" — same convention as
//     `marketplace_posts`. The API route stamps it from the auth context;
//     the store never trusts a body-supplied partner_id.
//   • Private groups are still LISTABLE (name / description / member_count
//     are public) so users can discover them, but their Q&A threads are
//     gated behind group membership (the Q&A store filters private groups
//     to members-only).
//   • Event registrations are unique per (event_id, partner_id) so a partner
//     cannot double-register.
//   • Blog posts use the same `slug` uniqueness as the rest of the
//     marketplace (auction / finance posts); drafts are hidden from the
//     public feed.

// ─── Group membership roles ────────────────────────────────────────────────

export type GroupRole = "member" | "moderator" | "admin";

export const GROUP_ROLE_LABEL_KEY: Record<GroupRole, string> = {
  member: "marketplace-community-group-role-member",
  moderator: "marketplace-community-group-role-moderator",
  admin: "marketplace-community-group-role-admin",
};

// ─── Event types ────────────────────────────────────────────────────────────

export type EventType =
  | "conference"
  | "webinar"
  | "trade_show"
  | "auction"
  | "meeting"
  | "workshop";

export const EVENT_TYPE_LABEL_KEY: Record<EventType, string> = {
  conference: "marketplace-community-event-type-conference",
  webinar: "marketplace-community-event-type-webinar",
  trade_show: "marketplace-community-event-type-trade-show",
  auction: "marketplace-community-event-type-auction",
  meeting: "marketplace-community-event-type-meeting",
  workshop: "marketplace-community-event-type-workshop",
};

// ─── Blog post status ──────────────────────────────────────────────────────

export type BlogPostStatus = "draft" | "published" | "archived";

export const BLOG_POST_STATUS_LABEL_KEY: Record<BlogPostStatus, string> = {
  draft: "marketplace-community-blog-status-draft",
  published: "marketplace-community-blog-status-published",
  archived: "marketplace-community-blog-status-archived",
};

// ─── marketplace_groups ────────────────────────────────────────────────────

export interface CommunityGroup {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  member_count: number;
  is_private: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommunityGroupCreate {
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  is_private?: boolean;
}

export interface CommunityGroupUpdate {
  name?: string;
  description?: string | null;
  category?: string | null;
  is_private?: boolean;
}

// ─── marketplace_group_members ─────────────────────────────────────────────

export interface GroupMember {
  id: string;
  group_id: string;
  partner_id: string;
  role: GroupRole;
  joined_at: string;
}

// ─── marketplace_questions ─────────────────────────────────────────────────

export interface Question {
  id: string;
  group_id: string | null;
  partner_id: string;
  title: string;
  body: string | null;
  tags: string[];
  views_count: number;
  answers_count: number;
  is_answered: boolean;
  accepted_answer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuestionCreate {
  group_id?: string | null;
  title: string;
  body?: string | null;
  tags?: string[];
}

export interface QuestionUpdate {
  title?: string;
  body?: string | null;
  tags?: string[];
}

// ─── marketplace_answers ────────────────────────────────────────────────────

export interface Answer {
  id: string;
  question_id: string;
  partner_id: string;
  body: string;
  is_accepted: boolean;
  upvotes: number;
  created_at: string;
  updated_at: string;
}

export interface AnswerCreate {
  body: string;
}

export interface AnswerPatch {
  // When true, flips the answer's is_accepted flag (and the question's
  // accepted_answer_id). When `upvote: true`, increments the answer's
  // upvotes by 1 (a partner can upvote at most once — enforced client-side
  // here; a stricter server-side dedup would need a join table).
  accept?: boolean;
  upvote?: boolean;
}

// ─── marketplace_events ────────────────────────────────────────────────────

export interface CommunityEvent {
  id: string;
  title: string;
  description: string | null;
  event_type: EventType | null;
  start_date: string;
  end_date: string;
  location: string | null;
  is_online: boolean;
  meeting_url: string | null;
  organizer_partner_id: string | null;
  attendees_count: number;
  created_at: string;
}

export interface CommunityEventCreate {
  title: string;
  description?: string | null;
  event_type?: EventType | null;
  start_date: string;
  end_date: string;
  location?: string | null;
  is_online?: boolean;
  meeting_url?: string | null;
}

export interface CommunityEventUpdate {
  title?: string;
  description?: string | null;
  event_type?: EventType | null;
  start_date?: string;
  end_date?: string;
  location?: string | null;
  is_online?: boolean;
  meeting_url?: string | null;
}

// ─── marketplace_event_registrations ───────────────────────────────────────

export interface EventRegistration {
  id: string;
  event_id: string;
  partner_id: string;
  registered_at: string;
}

// ─── marketplace_blog_posts ────────────────────────────────────────────────

export interface BlogPost {
  id: string;
  title: string;
  slug: string;
  body: string;
  excerpt: string | null;
  cover_image_url: string | null;
  tags: string[];
  author_partner_id: string | null;
  status: BlogPostStatus;
  views_count: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlogPostCreate {
  title: string;
  slug: string;
  body: string;
  excerpt?: string | null;
  cover_image_url?: string | null;
  tags?: string[];
  status?: BlogPostStatus;
}

export interface BlogPostUpdate {
  title?: string;
  body?: string;
  excerpt?: string | null;
  cover_image_url?: string | null;
  tags?: string[];
  status?: BlogPostStatus;
}
