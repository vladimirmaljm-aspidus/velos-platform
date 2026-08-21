import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { createQuestion, listQuestions } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/questions — list questions.
// Optional query: ?group_id=&tag=&search=&unanswered=1&limit=50&offset=0
async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const url = new URL(req.url);
    const group_id = url.searchParams.get("group_id") || undefined;
    const tag = url.searchParams.get("tag") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const unanswered = url.searchParams.get("unanswered") === "1";
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");
    const items = await listQuestions(access.partner_id, {
      group_id,
      tag,
      search,
      unanswered,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return NextResponse.json(items);
  } catch (e: any) {
    console.error("[marketplace.community.questions.list]", e);
    return NextResponse.json({ error: "Failed to load questions." }, { status: 500 });
  }
}

// POST /api/marketplace/questions — create a question.
// Body: { title, body?, tags?, group_id? }
async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.title !== "string" || body.title.length < 3 || body.title.length > 200) {
    return NextResponse.json({ error: "title must be 3–200 chars." }, { status: 400 });
  }
  if (body.body !== undefined && body.body !== null && (typeof body.body !== "string" || body.body.length > 10_000)) {
    return NextResponse.json({ error: "body must be ≤ 10000 chars." }, { status: 400 });
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t: any) => typeof t !== "string" || t.length < 1 || t.length > 40)) {
      return NextResponse.json({ error: "each tag must be 1–40 chars." }, { status: 400 });
    }
    if (body.tags.length > 20) {
      return NextResponse.json({ error: "at most 20 tags allowed." }, { status: 400 });
    }
  }
  if (body.group_id !== undefined && body.group_id !== null && typeof body.group_id !== "string") {
    return NextResponse.json({ error: "group_id must be a string." }, { status: 400 });
  }

  try {
    const created = await createQuestion(access.partner_id, {
      title: body.title,
      body: body.body ?? undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      group_id: body.group_id ?? undefined,
    });
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.question_created",
        "marketplace_questions",
        created.id,
        { title: created.title },
      );
    } catch (e) {
      console.error("[marketplace.community.questions.create] audit failed:", e);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (e: any) {
    console.error("[marketplace.community.questions.create]", e);
    const msg = e?.message || "Failed to create question.";
    const status = /authorised|member/i.test(msg) ? 403
      : /invalid|must be/i.test(msg) ? 400
      : /not found/i.test(msg) ? 404
      : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/questions");
export const POST = withApm(_post, "POST /api/marketplace/questions");
