import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

/**
 * POST /api/realtime/ticket — mint a short-lived HMAC-signed WS ticket.
 *
 * Audit H3 (4-b): the realtime mini-service's cross-origin handshake used to
 * trust a client-asserted `userId`, so anyone with a known user UUID could
 * join that tenant's Socket.IO room and receive its events. With a shared
 * `WS_TICKET_SECRET`, the service now REQUIRES a ticket minted by this route
 * (session-authenticated) for cross-origin connections:
 *
 *   ticket = base64url(userId + ":" + exp + ":" + hmac)
 *   hmac   = base64url(HMAC-SHA256(WS_TICKET_SECRET, userId + ":" + exp))
 *
 * The verification side lives in mini-services/realtime/index.ts
 * (`verifyWsTicket`) — kept in sync manually because the mini-service is a
 * separate deployable and cannot import from src/.
 *
 * The ticket only proves WHO the caller is; the mini-service re-resolves the
 * authoritative tenant_id/role from the users row, so the ticket carries no
 * tenant data to forge. TTL is deliberately long-ish (60 min): Socket.IO
 * re-runs the handshake on every reconnect, and a reconnect after a network
 * blip must not strand the tab on the 30s polling fallback — the
 * use-realtime hook also tears down + re-mints when the service reports an
 * expired ticket. When `WS_TICKET_SECRET` is unset on the app side, we
 * return 501 and the client falls back to the legacy handshake (the service
 * keeps the legacy path only while ITS secret is also unset).
 */
const TICKET_TTL_SEC = 60 * 60; // 1 hour

export async function POST(req: NextRequest) {
  try {
    // `req` passed through → requireAuth enforces the Origin/CSRF check on
    // this mutating POST (P2-18 convention used by the other POST routes).
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;

    const secret = process.env.WS_TICKET_SECRET;
    if (!secret || secret.length < 32) {
      // Not configured — the realtime service is in legacy-handshake mode
      // too. Tell the client (it falls back to the old auth handshake);
      // log loudly server-side so ops set BOTH sides' env together.
      console.warn(
        "[realtime-ticket] WS_TICKET_SECRET is not set (or < 32 chars) — " +
          "ticket minting disabled. Set it on BOTH the Next.js app and the " +
          "realtime mini-service to enable signed cross-origin WS auth (audit H3).",
      );
      return NextResponse.json(
        { error: "Realtime tickets are not configured." },
        { status: 501, headers: { "Cache-Control": "no-store" } },
      );
    }

    const userId = auth.user.id;
    const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
    const payload = `${userId}:${exp}`;
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    const ticket = Buffer.from(`${payload}:${sig}`).toString("base64url");

    return NextResponse.json(
      { ticket, expires_at: exp },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
