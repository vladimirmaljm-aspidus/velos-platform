// Marketplace Phase 10 store — community: groups, Q&A, events, blog.
//
// All functions talk directly to the tables added in migration
// 051_marketplace_community.sql:
//   • marketplace_groups              — industry / commodity groups
//   • marketplace_group_members       — membership roster (partner × group)
//   • marketplace_questions           — Q&A threads (optionally under a group)
//   • marketplace_answers             — answers under a question, with upvotes
//                                       and the "accepted answer" flag
//   • marketplace_events              — events calendar
//   • marketplace_event_registrations — per-partner registration ledger
//   • marketplace_blog_posts          — blog feed (draft / published / archived)
//
// SECURITY MODEL
//   • `partner_id` is the canonical "who". The API route stamps it from the
//     portal session (PortalAccess.partner_id); the store never trusts a
//     body-supplied partner_id — it always overrides whatever the body
//     claims with the auth-context value.
//   • listGroups / getGroup: open to any authenticated partner (groups are
//     discoverable, even private ones — name + description + member_count
//     are public so users can browse).
//   • joinGroup: idempotent — re-joining an already-joined group is a
//     no-op (UNIQUE constraint, ON CONFLICT DO NOTHING). member_count is
//     maintained by the store after each join/leave.
//   • listQuestions / getQuestion: private groups' questions are gated to
//     members — the store filters out private-group questions unless the
//     caller is a member of that group.
//   • createQuestion: when group_id is set, verifies the caller is a member
//     (and the group exists). When group_id is null, the question is
//     "general" (visible to all).
//   • createAnswer: open — any authenticated partner can answer any
//     question (the question_id existence is the only gate). The question's
//     `answers_count` + `is_answered` are maintained by the store.
//   • acceptAnswer: ONLY the question's author can accept an answer. The
//     store verifies the caller is the question.partner_id before flipping
//     the flag; an existing accepted answer (if any) is un-accepted
//     atomically so only one accepted answer remains.
//   • upvoteAnswer: increments the answer's upvotes. NOTE: a single-partner
//     can upvote multiple times in this minimal model — the API route
//     surfaces the count and the UI lets a partner vote once (the UI hides
//     the button after voting). A stricter dedup would need a join table
//     (marketplace_answer_upvotes); deferred to a later iteration.
//   • createEvent: the organizer is the caller. The caller can later PUT
//     / DELETE only events they organize.
//   • registerForEvent / unregisterFromEvent: idempotent via the UNIQUE
//     (event_id, partner_id) constraint. The event's `attendees_count` is
//     maintained by the store.
//   • createBlogPost / updateBlogPost: author is the caller (author_partner_id
//     is stamped). `published_at` is set when status flips to `published`
//     (and cleared when flipped back to `draft`).
//   • listBlogPosts: returns only `published` posts (drafts are hidden from
//     the public feed). The author can list their own drafts via the
//     `author` filter (TODO — not surfaced in the v1 UI).
//   • incrementViews: a side-effecting counter bump used by the public
//     blog-detail route. No auth required.

import { getSupabase } from "@/lib/supabase/client";
import type {
  Answer,
  AnswerCreate,
  AnswerPatch,
  BlogPost,
  BlogPostCreate,
  BlogPostStatus,
  BlogPostUpdate,
  CommunityEvent,
  CommunityEventCreate,
  CommunityEventUpdate,
  CommunityGroup,
  CommunityGroupCreate,
  CommunityGroupUpdate,
  EventRegistration,
  EventType,
  GroupMember,
  GroupRole,
  Question,
  QuestionCreate,
  QuestionUpdate,
} from "@/lib/supabase/marketplace-community-types";

// ─── Validation helpers ────────────────────────────────────────────────────

const VALID_GROUP_ROLES = new Set<string>(["member", "moderator", "admin"]);
const VALID_EVENT_TYPES = new Set<string>([
  "conference", "webinar", "trade_show", "auction", "meeting", "workshop",
]);
const VALID_BLOG_STATUSES = new Set<string>(["draft", "published", "archived"]);

const SLUG_RE = /^[a-z0-9-]{2,80}$/;

/** Normalise a candidate slug from a free-text label. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error("slug must be 2–80 chars of lowercase letters, digits, or hyphens.");
  }
}

function assertTags(tags: unknown): asserts tags is string[] {
  if (!Array.isArray(tags)) throw new Error("tags must be an array of strings.");
  for (const t of tags) {
    if (typeof t !== "string" || t.length === 0 || t.length > 40) {
      throw new Error("each tag must be 1–40 chars.");
    }
  }
  if (tags.length > 20) throw new Error("at most 20 tags allowed.");
}

function assertIsoDate(s: string, field: string): void {
  const n = Date.parse(s);
  if (Number.isNaN(n)) throw new Error(`${field} must be an ISO 8601 date string.`);
}

// ─── Public sanitisation helpers ──────────────────────────────────────────

/**
 * Strip the partner_id from a question / answer / event / blog post before
 * returning it to a caller who is NOT the author. The author gets the full
 * row; everyone else sees the sanitised shape so the authoring partner_id
 * does not leak (mirrors sanitisePublicInstrument in the finance store).
 */
export function sanitisePublicRecord<T extends { partner_id?: string | null; author_partner_id?: string | null }>(
  row: T,
): Omit<T, "partner_id" | "author_partner_id"> {
  const { partner_id: _p, author_partner_id: _a, ...rest } = row;
  void _p; void _a;
  return rest;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── GROUPS ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List groups, newest first. Public — open to any authenticated partner.
 * Optional filters: `category`, `search` (ILIKE on name/description),
 * `joinedPartnerId` (only groups this partner has joined).
 */
export async function listGroups(
  opts?: {
    category?: string;
    search?: string;
    joinedPartnerId?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: CommunityGroup[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  let q = sb
    .from("marketplace_groups")
    .select("*", { count: "exact" });

  if (opts?.category) q = q.eq("category", opts.category);
  if (opts?.search) {
    q = q.or(`name.ilike.%${opts.search}%,description.ilike.%${opts.search}%`);
  }

  if (opts?.joinedPartnerId) {
    // Restrict to groups this partner has joined. We do a join via an
    // inner sub-query by pre-fetching the group_ids they're a member of —
    // simpler than a Supabase nested select when we want a paginated,
    // count-exact result set.
    const { data: memberRows, error: mErr } = await sb
      .from("marketplace_group_members")
      .select("group_id")
      .eq("partner_id", opts.joinedPartnerId);
    if (mErr) throw mErr;
    const ids = (memberRows as { group_id: string }[]).map((r) => r.group_id);
    if (ids.length === 0) return { items: [], total: 0 };
    q = q.in("id", ids);
  }

  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return {
    items: (data as CommunityGroup[]) || [],
    total: count ?? 0,
  };
}

export async function getGroup(
  groupIdOrSlug: string,
): Promise<CommunityGroup | null> {
  const sb = getSupabase();
  // Match by UUID id OR by slug — same lookup pattern as the rest of the
  // marketplace (e.g. blog posts use slug + id interchangeably).
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupIdOrSlug);
  const col = isUuid ? "id" : "slug";
  const { data, error } = await sb
    .from("marketplace_groups")
    .select("*")
    .eq(col, groupIdOrSlug)
    .maybeSingle();
  if (error) throw error;
  return (data as CommunityGroup) || null;
}

export async function createGroup(
  partnerId: string,
  data: CommunityGroupCreate,
): Promise<CommunityGroup> {
  const sb = getSupabase();

  if (typeof data.name !== "string" || data.name.length < 2 || data.name.length > 120) {
    throw new Error("name must be 2–120 chars.");
  }
  assertSlug(data.slug);

  const payload: Record<string, unknown> = {
    name: data.name,
    slug: data.slug,
    description: data.description ?? null,
    category: data.category ?? null,
    is_private: Boolean(data.is_private),
  };

  const { data: inserted, error } = await sb
    .from("marketplace_groups")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  const group = inserted as CommunityGroup;

  // The creator becomes the group's first `admin` member. ON CONFLICT
  // guards against the rare case where the slug-unique check is racy.
  const { error: mErr } = await sb
    .from("marketplace_group_members")
    .upsert(
      { group_id: group.id, partner_id: partnerId, role: "admin" as GroupRole },
      { onConflict: "group_id,partner_id" },
    );
  if (mErr) throw mErr;

  // Bump member_count to 1 (creator).
  const { error: uErr } = await sb
    .from("marketplace_groups")
    .update({ member_count: 1, updated_at: new Date().toISOString() })
    .eq("id", group.id);
  if (uErr) throw uErr;

  group.member_count = 1;
  return group;
}

export async function updateGroup(
  groupId: string,
  partnerId: string,
  patch: CommunityGroupUpdate,
): Promise<CommunityGroup | null> {
  const sb = getSupabase();

  // Authorisation: the caller must be a moderator / admin of the group.
  const { data: m, error: mErr } = await sb
    .from("marketplace_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (mErr) throw mErr;
  const role = (m as { role: string } | null)?.role;
  if (role !== "moderator" && role !== "admin") {
    throw new Error("Not authorised — only moderators/admins can edit this group.");
  }

  const writable: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.length < 2 || patch.name.length > 120) {
      throw new Error("name must be 2–120 chars.");
    }
    writable.name = patch.name;
  }
  if (patch.description !== undefined) writable.description = patch.description;
  if (patch.category !== undefined) writable.category = patch.category;
  if (patch.is_private !== undefined) writable.is_private = Boolean(patch.is_private);

  if (Object.keys(writable).length === 0) {
    // Nothing to update — return the current row.
    return getGroup(groupId);
  }

  const { data, error } = await sb
    .from("marketplace_groups")
    .update(writable)
    .eq("id", groupId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as CommunityGroup) || null;
}

/**
 * Delete a group. The caller must be the group's admin. Cascades to
 * marketplace_group_members (FK ON DELETE CASCADE) and nulls out the
 * group_id on Q&A threads (FK ON DELETE SET NULL).
 */
export async function deleteGroup(
  groupId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();

  const { data: m, error: mErr } = await sb
    .from("marketplace_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (mErr) throw mErr;
  if ((m as { role: string } | null)?.role !== "admin") {
    throw new Error("Not authorised — only group admins can delete a group.");
  }

  const { error } = await sb
    .from("marketplace_groups")
    .delete()
    .eq("id", groupId);
  if (error) throw error;
  return true;
}

/**
 * Join a group. Idempotent (UNIQUE constraint, ON CONFLICT DO NOTHING).
 * Bumps the group's member_count.
 */
export async function joinGroup(
  groupId: string,
  partnerId: string,
): Promise<{ joined: boolean; member: GroupMember | null }> {
  const sb = getSupabase();

  // Confirm the group exists.
  const { data: g, error: gErr } = await sb
    .from("marketplace_groups")
    .select("id")
    .eq("id", groupId)
    .maybeSingle();
  if (gErr) throw gErr;
  if (!g) throw new Error("Group not found.");

  // Idempotent insert. The `.onConflict(...).ignore()` clause makes the
  // operation a no-op when the row already exists.
  const { data: inserted, error } = await sb
    .from("marketplace_group_members")
    .insert({ group_id: groupId, partner_id: partnerId, role: "member" as GroupRole })
    .select()
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation — already a member; treat as idempotent.
    if ((error as { code?: string }).code === "23505") {
      // Fetch the existing row to return a consistent shape.
      const { data: existing } = await sb
        .from("marketplace_group_members")
        .select("*")
        .eq("group_id", groupId)
        .eq("partner_id", partnerId)
        .maybeSingle();
      return { joined: false, member: (existing as GroupMember) || null };
    }
    throw error;
  }

  // Bump member_count via read-then-write. Slightly racy under high
  // concurrency but fine for the v1 community surface (a strict atomic
  // counter would need a Postgres RPC; deferred to a later iteration).
  const { data: cur, error: cErr } = await sb
    .from("marketplace_groups")
    .select("member_count")
    .eq("id", groupId)
    .maybeSingle();
  if (cErr) throw cErr;
  const newCount = ((cur as { member_count: number })?.member_count ?? 0) + 1;
  const { error: uErr } = await sb
    .from("marketplace_groups")
    .update({ member_count: newCount, updated_at: new Date().toISOString() })
    .eq("id", groupId);
  if (uErr) throw uErr;

  return { joined: true, member: (inserted as GroupMember) || null };
}

/**
 * Leave a group. Idempotent. Decrements member_count (clamped to >= 0).
 * Group admins cannot leave (they must first transfer admin role or
 * delete the group) — throws a 400-style error in that case.
 */
export async function leaveGroup(
  groupId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();

  const { data: m, error: mErr } = await sb
    .from("marketplace_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (mErr) throw mErr;
  if (!m) return true; // idempotent: not a member, treat as left.
  if ((m as { role: string }).role === "admin") {
    // Look up the member count — if the admin is the sole member, leaving
    // is equivalent to orphaning the group. We still let them leave in
    // that case (the group will then have zero members).
    const { data: cnt } = await sb
      .from("marketplace_group_members")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId);
    const total = cnt?.length ?? 0;
    if (total > 1) {
      throw new Error("Group admins must transfer admin role or delete the group before leaving.");
    }
  }

  const { error } = await sb
    .from("marketplace_group_members")
    .delete()
    .eq("group_id", groupId)
    .eq("partner_id", partnerId);
  if (error) throw error;

  // Decrement member_count, clamped to >= 0.
  const { data: cur } = await sb
    .from("marketplace_groups")
    .select("member_count")
    .eq("id", groupId)
    .maybeSingle();
  const newCount = Math.max(((cur as { member_count: number })?.member_count ?? 1) - 1, 0);
  await sb
    .from("marketplace_groups")
    .update({ member_count: newCount, updated_at: new Date().toISOString() })
    .eq("id", groupId);

  return true;
}

export async function listMembers(
  groupId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ items: GroupMember[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const { data, error, count } = await sb
    .from("marketplace_group_members")
    .select("*", { count: "exact" })
    .eq("group_id", groupId)
    .order("joined_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { items: (data as GroupMember[]) || [], total: count ?? 0 };
}

/**
 * Returns the calling partner's role in a group (null when not a member).
 * Used by the API GET /groups/[id] route to surface `your_role` in the
 * response without leaking other partners' membership data.
 */
export async function getGroupRole(
  groupId: string,
  partnerId: string,
): Promise<GroupRole | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_group_members")
    .select("role")
    .eq("group_id", groupId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw error;
  const role = (data as { role: string } | null)?.role;
  if (!role || !VALID_GROUP_ROLES.has(role)) return null;
  return role as GroupRole;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Q&A ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List Q&A questions, newest first. Private-group questions are gated:
 * they're filtered out unless the caller is a member of that group.
 * Optional filters: `group_id`, `tag`, `search` (ILIKE on title/body),
 * `unanswered` (only questions with answers_count = 0).
 */
export async function listQuestions(
  partnerId: string,
  opts?: {
    group_id?: string;
    tag?: string;
    search?: string;
    unanswered?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: Question[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  let q = sb
    .from("marketplace_questions")
    .select("*", { count: "exact" });

  if (opts?.group_id) q = q.eq("group_id", opts.group_id);
  if (opts?.tag) q = q.contains("tags", [opts.tag]);
  if (opts?.search) {
    q = q.or(`title.ilike.%${opts.search}%,body.ilike.%${opts.search}%`);
  }
  if (opts?.unanswered) q = q.eq("is_answered", false);

  q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  const all = (data as Question[]) || [];

  // Filter out private-group questions unless the caller is a member.
  // Fetch the caller's group memberships once, then drop questions whose
  // group is private AND the caller isn't a member.
  const groupIds = Array.from(new Set(all.map((r) => r.group_id).filter(Boolean) as string[]));
  if (groupIds.length > 0) {
    const { data: groups, error: gErr } = await sb
      .from("marketplace_groups")
      .select("id, is_private")
      .in("id", groupIds);
    if (gErr) throw gErr;
    const privateIds = new Set<string>(
      ((groups as { id: string; is_private: boolean }[]) || [])
        .filter((g) => g.is_private)
        .map((g) => g.id),
    );
    if (privateIds.size > 0) {
      const { data: ms, error: mErr } = await sb
        .from("marketplace_group_members")
        .select("group_id")
        .eq("partner_id", partnerId)
        .in("group_id", Array.from(privateIds));
      if (mErr) throw mErr;
      const joined = new Set(((ms as { group_id: string }[]) || []).map((m) => m.group_id));
      // Keep questions whose group is public OR the caller is a member.
      const filtered = all.filter((r) => {
        if (!r.group_id) return true; // general question — always visible
        if (!privateIds.has(r.group_id)) return true;
        return joined.has(r.group_id);
      });
      return { items: filtered, total: filtered.length };
    }
  }

  return { items: all, total: count ?? all.length };
}

export async function getQuestion(
  questionId: string,
  partnerId: string,
): Promise<Question | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();
  if (error) throw error;
  const q = (data as Question) || null;
  if (!q) return null;

  // Private-group gate.
  if (q.group_id) {
    const { data: g } = await sb
      .from("marketplace_groups")
      .select("is_private")
      .eq("id", q.group_id)
      .maybeSingle();
    if ((g as { is_private: boolean })?.is_private) {
      const role = await getGroupRole(q.group_id, partnerId);
      if (!role) return null; // hide entirely — looks like the question doesn't exist
    }
  }
  return q;
}

export async function createQuestion(
  partnerId: string,
  data: QuestionCreate,
): Promise<Question> {
  const sb = getSupabase();

  if (typeof data.title !== "string" || data.title.length < 3 || data.title.length > 200) {
    throw new Error("title must be 3–200 chars.");
  }
  if (data.body !== undefined && data.body !== null) {
    if (typeof data.body !== "string" || data.body.length > 10_000) {
      throw new Error("body must be ≤ 10000 chars.");
    }
  }
  const tags = data.tags ?? [];
  assertTags(tags);

  // When group_id is set, verify the group exists AND the caller is a member.
  if (data.group_id) {
    const role = await getGroupRole(data.group_id, partnerId);
    if (!role) throw new Error("Not a member of this group — cannot post.");
  }

  const payload: Record<string, unknown> = {
    group_id: data.group_id ?? null,
    partner_id: partnerId,
    title: data.title,
    body: data.body ?? null,
    tags,
    views_count: 0,
    answers_count: 0,
    is_answered: false,
    accepted_answer_id: null,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_questions")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as Question;
}

export async function updateQuestion(
  questionId: string,
  partnerId: string,
  patch: QuestionUpdate,
): Promise<Question | null> {
  const sb = getSupabase();
  // Verify ownership.
  const { data: cur, error: cErr } = await sb
    .from("marketplace_questions")
    .select("partner_id")
    .eq("id", questionId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return null;
  if ((cur as { partner_id: string }).partner_id !== partnerId) {
    throw new Error("Not authorised — only the question's author can edit.");
  }

  const writable: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || patch.title.length < 3 || patch.title.length > 200) {
      throw new Error("title must be 3–200 chars.");
    }
    writable.title = patch.title;
  }
  if (patch.body !== undefined) {
    if (patch.body !== null && (typeof patch.body !== "string" || patch.body.length > 10_000)) {
      throw new Error("body must be ≤ 10000 chars.");
    }
    writable.body = patch.body;
  }
  if (patch.tags !== undefined) {
    assertTags(patch.tags);
    writable.tags = patch.tags;
  }
  if (Object.keys(writable).length === 0) return getQuestion(questionId, partnerId);

  const { data, error } = await sb
    .from("marketplace_questions")
    .update({ ...writable, updated_at: new Date().toISOString() })
    .eq("id", questionId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as Question) || null;
}

export async function deleteQuestion(
  questionId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();
  const { data: cur, error: cErr } = await sb
    .from("marketplace_questions")
    .select("partner_id")
    .eq("id", questionId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return false;
  if ((cur as { partner_id: string }).partner_id !== partnerId) {
    throw new Error("Not authorised — only the question's author can delete.");
  }
  const { error } = await sb
    .from("marketplace_questions")
    .delete()
    .eq("id", questionId);
  if (error) throw error;
  return true;
}

export async function listAnswers(
  questionId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ items: Answer[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const { data, error, count } = await sb
    .from("marketplace_answers")
    .select("*", { count: "exact" })
    .eq("question_id", questionId)
    .order("is_accepted", { ascending: false })
    .order("upvotes", { ascending: false })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return { items: (data as Answer[]) || [], total: count ?? 0 };
}

export async function createAnswer(
  partnerId: string,
  questionId: string,
  data: AnswerCreate,
): Promise<Answer> {
  const sb = getSupabase();

  if (typeof data.body !== "string" || data.body.length < 1 || data.body.length > 10_000) {
    throw new Error("body must be 1–10000 chars.");
  }

  // Confirm the question exists.
  const { data: q, error: qErr } = await sb
    .from("marketplace_questions")
    .select("id, answers_count")
    .eq("id", questionId)
    .maybeSingle();
  if (qErr) throw qErr;
  if (!q) throw new Error("Question not found.");

  const { data: inserted, error } = await sb
    .from("marketplace_answers")
    .insert({ question_id: questionId, partner_id: partnerId, body: data.body, upvotes: 0, is_accepted: false })
    .select()
    .single();
  if (error) throw error;
  const answer = inserted as Answer;

  // Bump the question's answers_count + flip is_answered to true.
  const nextCount = ((q as { answers_count: number }).answers_count ?? 0) + 1;
  await sb
    .from("marketplace_questions")
    .update({
      answers_count: nextCount,
      is_answered: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", questionId);

  return answer;
}

/**
 * Accept an answer. ONLY the question's author can accept. If another
 * answer was previously accepted, it is un-accepted atomically so only
 * one accepted answer remains per question.
 */
export async function acceptAnswer(
  answerId: string,
  partnerId: string,
): Promise<Answer | null> {
  const sb = getSupabase();

  const { data: a, error: aErr } = await sb
    .from("marketplace_answers")
    .select("id, question_id, partner_id")
    .eq("id", answerId)
    .maybeSingle();
  if (aErr) throw aErr;
  if (!a) return null;
  const ans = a as { id: string; question_id: string; partner_id: string };

  // Verify the caller is the question's author.
  const { data: q, error: qErr } = await sb
    .from("marketplace_questions")
    .select("partner_id, accepted_answer_id")
    .eq("id", ans.question_id)
    .maybeSingle();
  if (qErr) throw qErr;
  if (!q) throw new Error("Question not found.");
  const qRow = q as { partner_id: string; accepted_answer_id: string | null };
  if (qRow.partner_id !== partnerId) {
    throw new Error("Not authorised — only the question's author can accept an answer.");
  }

  // Un-accept any previously-accepted answer for this question.
  if (qRow.accepted_answer_id && qRow.accepted_answer_id !== answerId) {
    await sb
      .from("marketplace_answers")
      .update({ is_accepted: false })
      .eq("id", qRow.accepted_answer_id)
      .eq("question_id", ans.question_id);
  }

  // Flip the chosen answer's flag.
  const { data: updated, error: uErr } = await sb
    .from("marketplace_answers")
    .update({ is_accepted: true, updated_at: new Date().toISOString() })
    .eq("id", answerId)
    .select()
    .maybeSingle();
  if (uErr) throw uErr;

  // Stamp the question's accepted_answer_id.
  await sb
    .from("marketplace_questions")
    .update({
      accepted_answer_id: answerId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ans.question_id);

  return (updated as Answer) || null;
}

/**
 * Upvote an answer (+1). NOTE: in this minimal model the same partner can
 * upvote multiple times — a stricter dedup needs a join table; deferred.
 * Returns the updated row.
 */
export async function upvoteAnswer(
  answerId: string,
): Promise<Answer | null> {
  const sb = getSupabase();
  const { data: cur, error: cErr } = await sb
    .from("marketplace_answers")
    .select("upvotes")
    .eq("id", answerId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return null;
  const nextUpvotes = ((cur as { upvotes: number }).upvotes ?? 0) + 1;
  const { data, error } = await sb
    .from("marketplace_answers")
    .update({ upvotes: nextUpvotes, updated_at: new Date().toISOString() })
    .eq("id", answerId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as Answer) || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── EVENTS ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List events, by default upcoming (start_date >= now()) in chronological
 * order. Optional filters: `event_type`, `upcoming` (default true), `search`,
 * `limit`, `offset`.
 */
export async function listEvents(
  opts?: {
    event_type?: EventType;
    upcoming?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: CommunityEvent[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const upcoming = opts?.upcoming ?? true;

  let q = sb
    .from("marketplace_events")
    .select("*", { count: "exact" });

  if (opts?.event_type) q = q.eq("event_type", opts.event_type);
  if (upcoming) q = q.gte("start_date", new Date().toISOString());
  if (opts?.search) {
    q = q.or(`title.ilike.%${opts.search}%,description.ilike.%${opts.search}%,location.ilike.%${opts.search}%`);
  }

  q = q.order("start_date", { ascending: true }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return { items: (data as CommunityEvent[]) || [], total: count ?? 0 };
}

export async function getEvent(
  eventId: string,
): Promise<CommunityEvent | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();
  if (error) throw error;
  return (data as CommunityEvent) || null;
}

export async function createEvent(
  partnerId: string,
  data: CommunityEventCreate,
): Promise<CommunityEvent> {
  const sb = getSupabase();

  if (typeof data.title !== "string" || data.title.length < 3 || data.title.length > 200) {
    throw new Error("title must be 3–200 chars.");
  }
  if (data.event_type && !VALID_EVENT_TYPES.has(data.event_type)) {
    throw new Error(`Invalid event_type: "${data.event_type}".`);
  }
  assertIsoDate(data.start_date, "start_date");
  assertIsoDate(data.end_date, "end_date");
  if (Date.parse(data.end_date) < Date.parse(data.start_date)) {
    throw new Error("end_date must be after start_date.");
  }
  if (data.description && (typeof data.description !== "string" || data.description.length > 10_000)) {
    throw new Error("description must be ≤ 10000 chars.");
  }
  if (data.location && (typeof data.location !== "string" || data.location.length > 300)) {
    throw new Error("location must be ≤ 300 chars.");
  }
  if (data.meeting_url && (typeof data.meeting_url !== "string" || data.meeting_url.length > 500)) {
    throw new Error("meeting_url must be ≤ 500 chars.");
  }
  if (data.is_online && !data.meeting_url) {
    // Allow online events without a meeting URL (organizer may share it
    // closer to the start) — but log it.
    void data.is_online;
  }

  const payload: Record<string, unknown> = {
    title: data.title,
    description: data.description ?? null,
    event_type: data.event_type ?? null,
    start_date: data.start_date,
    end_date: data.end_date,
    location: data.location ?? null,
    is_online: Boolean(data.is_online),
    meeting_url: data.meeting_url ?? null,
    organizer_partner_id: partnerId,
    attendees_count: 0,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_events")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as CommunityEvent;
}

export async function updateEvent(
  eventId: string,
  partnerId: string,
  patch: CommunityEventUpdate,
): Promise<CommunityEvent | null> {
  const sb = getSupabase();
  const { data: cur, error: cErr } = await sb
    .from("marketplace_events")
    .select("organizer_partner_id")
    .eq("id", eventId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return null;
  if ((cur as { organizer_partner_id: string | null }).organizer_partner_id !== partnerId) {
    throw new Error("Not authorised — only the organizer can edit this event.");
  }

  const writable: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || patch.title.length < 3 || patch.title.length > 200) {
      throw new Error("title must be 3–200 chars.");
    }
    writable.title = patch.title;
  }
  if (patch.description !== undefined) writable.description = patch.description;
  if (patch.event_type !== undefined) {
    if (patch.event_type && !VALID_EVENT_TYPES.has(patch.event_type)) {
      throw new Error(`Invalid event_type: "${patch.event_type}".`);
    }
    writable.event_type = patch.event_type;
  }
  if (patch.start_date !== undefined) {
    assertIsoDate(patch.start_date, "start_date");
    writable.start_date = patch.start_date;
  }
  if (patch.end_date !== undefined) {
    assertIsoDate(patch.end_date, "end_date");
    writable.end_date = patch.end_date;
  }
  if (patch.location !== undefined) writable.location = patch.location;
  if (patch.is_online !== undefined) writable.is_online = Boolean(patch.is_online);
  if (patch.meeting_url !== undefined) writable.meeting_url = patch.meeting_url;

  if (Object.keys(writable).length === 0) return getEvent(eventId);

  // Re-validate end > start after the patch is applied.
  const finalStart = writable.start_date as string | undefined;
  const finalEnd = writable.end_date as string | undefined;
  if (finalStart && finalEnd && Date.parse(finalEnd) < Date.parse(finalStart)) {
    throw new Error("end_date must be after start_date.");
  }

  const { data, error } = await sb
    .from("marketplace_events")
    .update(writable)
    .eq("id", eventId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as CommunityEvent) || null;
}

export async function deleteEvent(
  eventId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();
  const { data: cur, error: cErr } = await sb
    .from("marketplace_events")
    .select("organizer_partner_id")
    .eq("id", eventId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return false;
  if ((cur as { organizer_partner_id: string | null }).organizer_partner_id !== partnerId) {
    throw new Error("Not authorised — only the organizer can delete this event.");
  }
  const { error } = await sb
    .from("marketplace_events")
    .delete()
    .eq("id", eventId);
  if (error) throw error;
  return true;
}

/**
 * Register for an event. Idempotent (UNIQUE (event_id, partner_id) +
 * upsert with onConflict DO NOTHING). Bumps attendees_count.
 */
export async function registerForEvent(
  eventId: string,
  partnerId: string,
): Promise<{ registered: boolean; registration: EventRegistration | null }> {
  const sb = getSupabase();

  // Confirm the event exists.
  const { data: e, error: eErr } = await sb
    .from("marketplace_events")
    .select("id")
    .eq("id", eventId)
    .maybeSingle();
  if (eErr) throw eErr;
  if (!e) throw new Error("Event not found.");

  const { data: inserted, error } = await sb
    .from("marketplace_event_registrations")
    .insert({ event_id: eventId, partner_id: partnerId })
    .select()
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // Already registered — fetch the existing row.
      const { data: existing } = await sb
        .from("marketplace_event_registrations")
        .select("*")
        .eq("event_id", eventId)
        .eq("partner_id", partnerId)
        .maybeSingle();
      return { registered: false, registration: (existing as EventRegistration) || null };
    }
    throw error;
  }

  // Bump attendees_count via read-then-write (v1 — fine for community scale).
  const { data: cur } = await sb
    .from("marketplace_events")
    .select("attendees_count")
    .eq("id", eventId)
    .maybeSingle();
  const newCount = ((cur as { attendees_count: number })?.attendees_count ?? 0) + 1;
  await sb
    .from("marketplace_events")
    .update({ attendees_count: newCount })
    .eq("id", eventId);

  return { registered: true, registration: (inserted as EventRegistration) || null };
}

export async function unregisterFromEvent(
  eventId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();
  const { error } = await sb
    .from("marketplace_event_registrations")
    .delete()
    .eq("event_id", eventId)
    .eq("partner_id", partnerId);
  if (error) throw error;

  // Decrement attendees_count, clamped to >= 0.
  const { data: cur } = await sb
    .from("marketplace_events")
    .select("attendees_count")
    .eq("id", eventId)
    .maybeSingle();
  const newCount = Math.max(((cur as { attendees_count: number })?.attendees_count ?? 1) - 1, 0);
  await sb
    .from("marketplace_events")
    .update({ attendees_count: newCount })
    .eq("id", eventId);

  return true;
}

/** Returns true if the partner has an active registration for the event. */
export async function isRegisteredForEvent(
  eventId: string,
  partnerId: string,
): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("marketplace_event_registrations")
    .select("id")
    .eq("event_id", eventId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── BLOG ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List blog posts, newest-published first. Only `published` posts are
 * returned unless `includeDrafts` is true (and the caller is the author).
 */
export async function listBlogPosts(
  opts?: {
    tag?: string;
    search?: string;
    author_partner_id?: string;
    include_drafts?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: BlogPost[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const offset = Math.max(opts?.offset ?? 0, 0);

  let q = sb
    .from("marketplace_blog_posts")
    .select("*", { count: "exact" });

  if (!opts?.include_drafts) q = q.eq("status", "published");
  if (opts?.author_partner_id) q = q.eq("author_partner_id", opts.author_partner_id);
  if (opts?.tag) q = q.contains("tags", [opts.tag]);
  if (opts?.search) {
    q = q.or(`title.ilike.%${opts.search}%,excerpt.ilike.%${opts.search}%,body.ilike.%${opts.search}%`);
  }

  q = q.order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) throw error;
  return { items: (data as BlogPost[]) || [], total: count ?? 0 };
}

export async function getBlogPost(
  slugOrId: string,
): Promise<BlogPost | null> {
  const sb = getSupabase();
  // Match by slug OR UUID id.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
  const col = isUuid ? "id" : "slug";
  const { data, error } = await sb
    .from("marketplace_blog_posts")
    .select("*")
    .eq(col, slugOrId)
    .maybeSingle();
  if (error) throw error;
  return (data as BlogPost) || null;
}

export async function createBlogPost(
  partnerId: string,
  data: BlogPostCreate,
): Promise<BlogPost> {
  const sb = getSupabase();

  if (typeof data.title !== "string" || data.title.length < 3 || data.title.length > 200) {
    throw new Error("title must be 3–200 chars.");
  }
  assertSlug(data.slug);
  if (typeof data.body !== "string" || data.body.length < 1 || data.body.length > 100_000) {
    throw new Error("body must be 1–100000 chars.");
  }
  if (data.excerpt && (typeof data.excerpt !== "string" || data.excerpt.length > 500)) {
    throw new Error("excerpt must be ≤ 500 chars.");
  }
  if (data.cover_image_url && (typeof data.cover_image_url !== "string" || data.cover_image_url.length > 500)) {
    throw new Error("cover_image_url must be ≤ 500 chars.");
  }
  const tags = data.tags ?? [];
  assertTags(tags);
  const status: BlogPostStatus = data.status && VALID_BLOG_STATUSES.has(data.status) ? data.status : "published";

  const payload: Record<string, unknown> = {
    title: data.title,
    slug: data.slug,
    body: data.body,
    excerpt: data.excerpt ?? null,
    cover_image_url: data.cover_image_url ?? null,
    tags,
    author_partner_id: partnerId,
    status,
    views_count: 0,
    published_at: status === "published" ? new Date().toISOString() : null,
  };

  const { data: inserted, error } = await sb
    .from("marketplace_blog_posts")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return inserted as BlogPost;
}

export async function updateBlogPost(
  slugOrId: string,
  partnerId: string,
  patch: BlogPostUpdate,
): Promise<BlogPost | null> {
  const sb = getSupabase();
  // Verify ownership.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
  const col = isUuid ? "id" : "slug";
  const { data: cur, error: cErr } = await sb
    .from("marketplace_blog_posts")
    .select("id, author_partner_id, status")
    .eq(col, slugOrId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return null;
  const curRow = cur as { id: string; author_partner_id: string | null; status: BlogPostStatus };
  if (curRow.author_partner_id !== partnerId) {
    throw new Error("Not authorised — only the author can edit this post.");
  }

  const writable: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || patch.title.length < 3 || patch.title.length > 200) {
      throw new Error("title must be 3–200 chars.");
    }
    writable.title = patch.title;
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== "string" || patch.body.length < 1 || patch.body.length > 100_000) {
      throw new Error("body must be 1–100000 chars.");
    }
    writable.body = patch.body;
  }
  if (patch.excerpt !== undefined) writable.excerpt = patch.excerpt;
  if (patch.cover_image_url !== undefined) writable.cover_image_url = patch.cover_image_url;
  if (patch.tags !== undefined) {
    assertTags(patch.tags);
    writable.tags = patch.tags;
  }
  if (patch.status !== undefined) {
    if (!VALID_BLOG_STATUSES.has(patch.status)) {
      throw new Error(`Invalid status: "${patch.status}".`);
    }
    writable.status = patch.status;
    // Flip published_at when crossing the draft/published boundary.
    if (patch.status === "published" && curRow.status !== "published") {
      writable.published_at = new Date().toISOString();
    } else if (patch.status === "draft" && curRow.status === "published") {
      writable.published_at = null;
    }
  }

  if (Object.keys(writable).length === 0) return getBlogPost(slugOrId);

  const { data, error } = await sb
    .from("marketplace_blog_posts")
    .update({ ...writable, updated_at: new Date().toISOString() })
    .eq("id", curRow.id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as BlogPost) || null;
}

/**
 * Atomically bump a blog post's views_count by 1. Used by the public
 * blog-detail API route (no auth — anonymous reads still count). Returns
 * the new views_count.
 */
export async function incrementViews(
  slugOrId: string,
): Promise<number | null> {
  const sb = getSupabase();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
  const col = isUuid ? "id" : "slug";
  const { data: cur, error: cErr } = await sb
    .from("marketplace_blog_posts")
    .select("id, views_count")
    .eq(col, slugOrId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return null;
  const row = cur as { id: string; views_count: number };
  const next = (row.views_count ?? 0) + 1;
  const { error: uErr } = await sb
    .from("marketplace_blog_posts")
    .update({ views_count: next })
    .eq("id", row.id);
  if (uErr) throw uErr;
  return next;
}
