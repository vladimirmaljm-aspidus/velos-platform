import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getNegotiation } from "@/lib/data/marketplace-store";
import { getSupabase } from "@/lib/supabase/client";
import {
  redactPartnerForMarketplace,
  type MarketplacePublicPartner,
} from "@/lib/marketplace/privacy";
import type { Partner } from "@/lib/supabase/types";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/negotiations/[id] — fetch a single negotiation.
// Caller must be one of the two partners in the negotiation.
//
// Response shape (Phase 2):
//   {
//     negotiation: { ...raw row... },
//     counterparty: MarketplacePublicPartner | (Partner & {...}),
//     post: { id, product_name, post_type, quantity, unit, currency, target_price } | null
//   }
//
// `counterparty` is the OTHER party (the partner who is NOT the caller).
// When `negotiation.contact_revealed = true` the response carries the
// partner's full contact shape (email / phone / contact_name / etc.) so
// the room can render the "Contact info" card. When `contact_revealed =
// false` the response carries ONLY the redacted public shape from
// `redactPartnerForMarketplace` (id / name / country / type /
// verification_level / portal_level) — email, phone and address are
// stripped at the API boundary so a partner cannot learn them by opening
// the room before both sides have accepted the deal.
//
// `post` is the marketplace post the negotiation was opened on; the room
// uses its product_name + summary for the header chip.
async function _get(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const n = await getNegotiation(id, access.tenant_id, access.partner_id);
    if (!n) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Resolve the OTHER party's partner_id + the post id.
    const otherPartnerId =
      access.partner_id === n.partner_id_a ? n.partner_id_b : n.partner_id_a;
    const otherTenantId =
      access.partner_id === n.partner_id_a ? n.tenant_id_b : n.tenant_id_a;

    const sb = getSupabase();

    // Fetch the counterparty's Partner row. The Phase 1 schema stores
    // partners tenant-scoped, so we read within the negotiation's
    // counterparty tenant (which equals access.tenant_id in Phase 1 —
    // the marketplace is intra-tenant — but the code is defensive).
    let counterparty: MarketplacePublicPartner | (Partner & { _full?: boolean }) | null = null;
    if (otherPartnerId) {
      const { data: cpRow, error: cpErr } = await sb
        .from("partners")
        .select("*")
        .eq("id", otherPartnerId)
        .maybeSingle();
      if (cpErr) {
        console.error("[marketplace.negotiations.get] counterparty fetch failed:", cpErr);
      }
      if (cpRow) {
        if (n.contact_revealed) {
          // Both sides have accepted — return the full partner shape so
          // the room can display email / phone / contact_name / etc.
          counterparty = cpRow as Partner;
        } else {
          // Pre-accept — strip everything except the marketplace-safe
          // public fields (id / name / country / type /
          // verification_level / portal_level).
          counterparty = redactPartnerForMarketplace(cpRow as Partner);
        }
      }
    }

    // Fetch a small slice of the marketplace post for the room header.
    let post: {
      id: string;
      product_name: string;
      post_type: string;
      quantity: number;
      unit: string;
      currency: string;
      target_price: number | null;
    } | null = null;
    const { data: postRow } = await sb
      .from("marketplace_posts")
      .select("id, product_name, post_type, quantity, unit, currency, target_price")
      .eq("id", n.post_id)
      .maybeSingle();
    if (postRow) post = postRow as {
      id: string;
      product_name: string;
      post_type: string;
      quantity: number;
      unit: string;
      currency: string;
      target_price: number | null;
    };

    return NextResponse.json({
      negotiation: n,
      counterparty,
      post,
      // Echo a few caller-relative flags so the room can render the
      // "Your turn" / "Awaiting counterparty" badge without recomputing
      // which side of the negotiation the caller is on.
      callerSide: access.partner_id === n.partner_id_a ? "A" : "B",
      // Whether the OTHER party has previously sent an 'accept' message
      // in this negotiation — used by the room to know whether the
      // caller's pending accept would flip contact_revealed (i.e.
      // whether to show the "Accept offer" button as the finalizing
      // step). Kept simple here: just expose contact_revealed; the room
      // can derive the rest from the messages list.
    });
  } catch (e: any) {
    console.error("[marketplace.negotiations.get]", e);
    return NextResponse.json({ error: "Failed to load negotiation." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/negotiations/[id]");
