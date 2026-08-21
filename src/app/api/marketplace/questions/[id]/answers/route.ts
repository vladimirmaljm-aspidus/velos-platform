import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { createAnswer, listAnswers } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import { notifyMarketplaceAnswerPosted } from "@/lib/notif/helper";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/marketplace/questions/[id]/answers — list answers under a question.
// Accepted answer sorts first, then by upvotes desc, then by created_at asc.
async function _get(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listAnswers(id, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.community.answers.list]", e);
    return NextResponse.json({ error: "Failed to load answers." }, { status: 500 });
  }
}

// POST /api/marketplace/questions/[id]/answers — submit an answer.
// Body: { body }
async function _post(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.body !== "string" || body.body.length < 1 || body.body.length > 10_000) {
    return NextResponse.json({ error: "body must be 1–10000 chars." }, { status: 400 });
  }

  try {
    const created = await createAnswer(access.partner_id, id, { body: body.body });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.answer_created",
        "marketplace_answers",
        created.id,
        { question_id: id },
      );
    } catch (e) {
      console.error("[marketplace.community.answers.create] audit failed:", e);
    }
    // LOGIC-AUDIT-2 Fix 2: notify the question author that their question
    // got a new answer. Fire-and-forget — a notification failure must not
    // block the answerer's HTTP response (the answer is already saved).
    // Skip if the answerer IS the question author (self-answer case).
    try {
      const sb = getSupabase();
      const { data: qRow } = await sb
        .from("marketplace_questions")
        .select("partner_id, title")
        .eq("id", id)
        .maybeSingle();
      const q = qRow as { partner_id?: string; title?: string } | null;
      if (q?.partner_id && q.partner_id !== access.partner_id) {
        const store = await getStore();
        const answerer = await store.getPartner(access.partner_id);
        const answererName = answerer?.name || access.portal_email || "A member";
        await notifyMarketplaceAnswerPosted(
          access.tenant_id,
          q.partner_id,
          answererName,
          q.title || "(untitled question)",
          id,
        );
      }
    } catch (e) {
      console.error("[marketplace.community.answers.create] notify failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.community.answers.create]", e);
    const msg = e?.message || "Failed to create answer.";
    const status = /not found/i.test(msg) ? 404 : /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/questions/[id]/answers");
export const POST = withApm(_post, "POST /api/marketplace/questions/[id]/answers");
