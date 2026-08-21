import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { deleteQuestion, getQuestion, updateQuestion } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/marketplace/questions/[id] — fetch one question. Private-group
// questions are hidden from non-members (the store returns null).
async function _get(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const q = await getQuestion(id, access.partner_id);
    if (!q) {
      return NextResponse.json({ error: "Question not found." }, { status: 404 });
    }
    return NextResponse.json(q);
  } catch (e: any) {
    console.error("[marketplace.community.questions.get]", e);
    return NextResponse.json({ error: "Failed to load question." }, { status: 500 });
  }
}

// PUT /api/marketplace/questions/[id] — update the question (author only).
async function _put(req: NextRequest, ctx: RouteCtx) {
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

  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length < 3 || body.title.length > 200)) {
    return NextResponse.json({ error: "title must be 3–200 chars." }, { status: 400 });
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t: any) => typeof t !== "string" || t.length < 1 || t.length > 40)) {
      return NextResponse.json({ error: "each tag must be 1–40 chars." }, { status: 400 });
    }
  }

  try {
    const updated = await updateQuestion(id, access.partner_id, {
      title: body.title,
      body: body.body ?? undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Question not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.question_updated",
        "marketplace_questions",
        updated.id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.questions.update] audit failed:", e);
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.community.questions.update]", e);
    const msg = e?.message || "Failed to update question.";
    const status = /authorised/i.test(msg) ? 403 : /invalid|must be/i.test(msg) ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

// DELETE /api/marketplace/questions/[id] — author only. Cascades to answers.
async function _delete(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const ok = await deleteQuestion(id, access.partner_id);
    if (!ok) {
      return NextResponse.json({ error: "Question not found." }, { status: 404 });
    }
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.question_deleted",
        "marketplace_questions",
        id,
        {},
      );
    } catch (e) {
      console.error("[marketplace.community.questions.delete] audit failed:", e);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.community.questions.delete]", e);
    const msg = e?.message || "Failed to delete question.";
    const status = /authorised/i.test(msg) ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/questions/[id]");
export const PUT = withApm(_put, "PUT /api/marketplace/questions/[id]");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/questions/[id]");
