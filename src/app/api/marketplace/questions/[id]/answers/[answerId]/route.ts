import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { acceptAnswer, upvoteAnswer } from "@/lib/data/marketplace-community-store";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string; answerId: string }>;
}

// PUT /api/marketplace/questions/[id]/answers/[answerId] — accept or upvote.
// Body: { accept?: true, upvote?: true }
//   • accept: flips the answer's is_accepted flag (question-author only).
//   • upvote: increments the answer's upvotes by 1.
async function _put(req: NextRequest, ctx: RouteCtx) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id: _questionId, answerId } = await ctx.params;
  void _questionId; // validated by the store's acceptAnswer call

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const wantAccept = body.accept === true;
  const wantUpvote = body.upvote === true;
  if (!wantAccept && !wantUpvote) {
    return NextResponse.json({ error: "Body must include { accept: true } or { upvote: true }." }, { status: 400 });
  }
  if (wantAccept && wantUpvote) {
    return NextResponse.json({ error: "Cannot accept and upvote in the same call." }, { status: 400 });
  }

  try {
    if (wantAccept) {
      const updated = await acceptAnswer(answerId, access.partner_id);
      if (!updated) {
        return NextResponse.json({ error: "Answer not found." }, { status: 404 });
      }
      try {
        const store = await getStore();
        await audit(
          store,
          { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
          req,
          "marketplace.answer_accepted",
          "marketplace_answers",
          updated.id,
          {},
        );
      } catch (e) {
        console.error("[marketplace.community.answers.accept] audit failed:", e);
      }
      return NextResponse.json(updated);
    }

    // upvote path
    const updated = await upvoteAnswer(answerId);
    if (!updated) {
      return NextResponse.json({ error: "Answer not found." }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[marketplace.community.answers.patch]", e);
    const msg = e?.message || "Failed to update answer.";
    const status = /authorised/i.test(msg) ? 403 : /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export const PUT = withApm(_put, "PUT /api/marketplace/questions/[id]/answers/[answerId]");
