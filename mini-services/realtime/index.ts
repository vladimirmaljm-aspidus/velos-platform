/**
 * VELOS Realtime — Socket.IO gateway mini-service.
 * ----------------------------------------------------------------------------
 * Replaces the 30-second polling the useRealtime hook falls back to. One
 * long-lived WS connection per browser tab pushes live events:
 *
 *   • message:new        — new marketplace/portal message
 *   • offer:updated      — offer status changed
 *   • invoice:paid       — invoice payment recorded
 *   • portal:activity    — portal client activity (RFQ submitted, etc.)
 *   • notification:new    — generic new notification
 *   • signup:request      — new signup request (super_admins only)
 *
 * Port: 3001 (matches the default in `src/hooks/use-realtime.ts`).
 * Accessed via the sandbox gateway with `?XTransformPort=3001`.
 *
 * Auth model
 * ----------
 * 1. **Cookie (preferred, same-origin / first-party WS):** the browser sends
 *    the `crm_session` cookie (httpOnly, set by `src/lib/auth/session.ts` on
 *    admin login). We verify the JWT signature with the SAME secret the
 *    Next.js app uses (`JWT_SECRET_KEY` falling back to `SECRET_KEY`), then
 *    extract `sub` (user id), `tenant_id`, and `role` directly from the
 *    JWT payload — no DB round-trip needed.
 *
 * 2. **Handshake `auth.token` (cross-origin fallback):** the useRealtime
 *    hook passes `{ userId, tenantId }` in the Socket.IO `auth` handshake.
 *    When cross-origin (the SPA on `velos-platform.vercel.app` connecting to
 *    the sandbox URL) the cookie is NOT forwarded by the browser (the
 *    `crm_session` cookie is `sameSite: lax`), so we fall back to the
 *    handshake payload. We then verify the user exists + is active in
 *    Supabase via the service-role key, and read the authoritative
 *    `tenant_id` and `role` from the row — never trust the client-supplied
 *    tenant_id/role on its own. If Supabase is not configured (no
 *    `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`) we accept the handshake
 *    payload as-is (dev-only mode; logged at warn).
 *
 * Either path produces `{ userId, tenantId, role }` and joins:
 *   • `tenant:<tenantId>` — every event broadcast to this room
 *   • `super_admins` — only when role === "super_admin"
 *
 * Rooms are the entire multi-tenant isolation story — events emitted to
 * `tenant:A` are NEVER visible to sockets in `tenant:B` because Socket.IO
 * fans out per-room and a socket can only be in a room it joined.
 *
 * HTTP endpoints
 * -------------
 *   GET  /health           → { ok: true }
 *   POST /emit             → broadcast to a tenant room
 *        Body: { event, tenantId?, data, superAdmins? }
 *        Auth: `Authorization: Bearer <CRON_TOKEN>` (shared secret,
 *        same value used by /api/cron/* — see `src/lib/api/cron-auth.ts`).
 *        Constant-time compare to prevent timing attacks.
 *
 * Env (all optional for `/health`; auth needs them to actually admit sockets):
 *   • PORT (default 3001)
 *   • CRON_TOKEN (default "velos-realtime-dev" — DEV ONLY, set in prod)
 *   • JWT_SECRET_KEY (preferred) or SECRET_KEY (fallback) — must match the
 *     Next.js app's session signing key for cookie-based auth to work
 *   • SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — for handshake-payload auth
 *     and optional session-revocation cross-check
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { jwtVerify } from "jose";
import { timingSafeEqual } from "crypto";

const PORT = Number(process.env.PORT ?? 3001);
// Audit 2d-F3 / 2e-F6 fix: remove the "velos-realtime-dev" fallback. A
// publicly-known default token meant anyone reaching /emit via the gateway
// (?XTransformPort=3001) could broadcast events to any tenant room. Fail
// loudly at boot if the token is missing — the operator must set CRON_TOKEN
// in every environment (including sandbox). Generate with:
//   openssl rand -hex 32
const CRON_TOKEN_ENV = process.env.CRON_TOKEN;
if (!CRON_TOKEN_ENV || CRON_TOKEN_ENV.length < 16) {
  console.error(
    "[realtime] CRON_TOKEN env var is missing or too short (min 16 chars). " +
      "Refusing to start — set CRON_TOKEN to a random string (openssl rand -hex 32). " +
      "The previous default 'velos-realtime-dev' was a publicly-known token (audit 2d-F3/2e-F6).",
  );
  process.exit(1);
}
const CRON_TOKEN: string = CRON_TOKEN_ENV;

// JWT verification — must match the Next.js app's session signing secret.
// `JWT_SECRET_KEY` is preferred (vault key separation, see `.env.example`);
// `SECRET_KEY` is the legacy single-secret fallback.
function getJwtSecret(): Uint8Array | null {
  const s = process.env.JWT_SECRET_KEY || process.env.SECRET_KEY;
  if (!s || s.length < 32) return null;
  return new TextEncoder().encode(s);
}

// Supabase service-role client — used for the handshake-payload auth path
// (cross-origin WS where the cookie isn't forwarded) and for the optional
// session-revocation cross-check. `null` when env vars are missing.
let supabase: SupabaseClient | null = null;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
} else {
  console.warn(
    "[realtime] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — " +
      "handshake-payload auth and session-revocation cross-check are " +
      "disabled. Cookie-based auth still works if JWT_SECRET_KEY is set.",
  );
}

// ── HTTP server (health + /emit) ───────────────────────────────────────────
const httpServer = createServer();

// Per-connection CORS for Socket.IO is set on the SocketIOServer options
// below; the raw HTTP server only needs to handle /health + /emit.
function setCORS(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (Buffer.concat(chunks).length > maxBytes) {
      throw new Error("Body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseCookie(cookieHeader: string, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      const v = part.slice(eq + 1).trim();
      return v ? v : null;
    }
  }
  return null;
}

// Constant-time compare — same shape as `src/lib/api/cron-auth.ts` so the
// /emit endpoint is not vulnerable to timing-attack token recovery.
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// ── HTTP request handler ──────────────────────────────────────────────────
httpServer.on("request", async (req, res) => {
  setCORS(res);

  // CORS preflight — Socket.IO handles its own, but the raw /emit + /health
  // endpoints see plain browser fetches when the SPA calls /emit directly
  // (which it never does in production; only the Next.js server calls /emit
  // with the CRON_TOKEN). Allow it anyway for dev inspection.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url?.split("?")[0] ?? "";

  // Health check — always returns 200, even before any socket connects.
  if (req.method === "GET" && path === "/health") {
    sendJSON(res, 200, {
      ok: true,
      service: "velos-realtime",
      port: PORT,
      sockets: io.engine.clientsCount,
      supabase: !!supabase,
      jwt: !!getJwtSecret(),
    });
    return;
  }

  // /emit — internal, called by Next.js API routes to push events.
  // Auth: `Authorization: Bearer <CRON_TOKEN>` (constant-time compare).
  if (req.method === "POST" && path === "/emit") {
    const auth = req.headers.authorization || "";
    const presented = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";
    if (!presented || !safeCompare(presented, CRON_TOKEN)) {
      sendJSON(res, 401, { error: "Unauthorized" });
      return;
    }

    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJSON(res, 400, { error: "Bad request" });
      return;
    }

    const { event, tenantId, data, superAdmins } = body || {};
    if (!event || typeof event !== "string") {
      sendJSON(res, 400, { error: "Missing event" });
      return;
    }

    let targets = 0;
    if (tenantId && typeof tenantId === "string") {
      io.to(`tenant:${tenantId}`).emit(event, data ?? {});
      targets += io.sockets.adapter.rooms.get(`tenant:${tenantId}`)?.size ?? 0;
    }
    if (superAdmins) {
      io.to("super_admins").emit(event, data ?? {});
      targets += io.sockets.adapter.rooms.get("super_admins")?.size ?? 0;
    }

    sendJSON(res, 200, { ok: true, targets });
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
});

// ── Socket.IO server ──────────────────────────────────────────────────────
const io = new SocketIOServer(httpServer, {
  // Browser connects from a different origin (velos-platform.vercel.app →
  // sandbox URL). Open CORS so the upgrade handshake always succeeds; auth
  // is enforced by the middleware below, not by CORS origin checks.
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Websocket-only — we don't want the long-polling fallback spamming the
  // sandbox gateway. The useRealtime hook also pins this to ["websocket"].
  transports: ["websocket"],
  // Allow large auth tokens in the handshake (the JWT cookie can be ~1KB).
  maxHttpBufferSize: 1e6,
});

// Session payload shape — mirrors `src/lib/auth/session.ts` SessionPayload.
// Only the fields we actually read are listed; the JWT may carry more.
interface SessionPayload {
  sub: string;
  username?: string;
  role?: string;
  token_version?: number;
  tenant_id?: string | null;
  expires_at?: number;
  last_activity_at?: number;
}

interface SocketData {
  userId: string;
  tenantId: string | null;
  role: string;
}

// Verify a `crm_session` JWT and return the payload (or null on any failure).
// Uses the same secret as the Next.js app so a token issued by the API is
// valid here, and vice-versa.
async function verifySessionJwt(token: string): Promise<SessionPayload | null> {
  const secret = getJwtSecret();
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

// Look up a user in Supabase to confirm they exist + read the authoritative
// tenant_id and role. Used by the handshake-payload auth path so we never
// trust a client-supplied tenant_id/role without verification.
async function lookupUser(
  userId: string,
): Promise<{ tenant_id: string | null; role: string } | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("users")
      .select("tenant_id, role, status")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return null;
    // Reject disabled/deleted users — the JWT may be valid but the account
    // may have been disabled server-side since issue.
    if ((data as any).status && (data as any).status !== "active") return null;
    return { tenant_id: (data as any).tenant_id ?? null, role: (data as any).role ?? "staff" };
  } catch {
    return null;
  }
}

// Optional cross-check: confirm the session row exists in Supabase and is
// not revoked. Belt-and-suspenders on top of JWT verification (the JWT
// signature is the primary auth; this catches a stolen-but-revoked token).
// Failures here are non-fatal — the JWT already proved identity.
async function sessionNotRevoked(token: string): Promise<boolean> {
  if (!supabase) return true;
  try {
    const { data, error } = await supabase
      .from("sessions")
      .select("revoked, expires_at")
      .eq("token", token)
      .maybeSingle();
    if (error || !data) return true; // session row may have aged out — accept
    if ((data as any).revoked) return false;
    if ((data as any).expires_at && new Date((data as any).expires_at) < new Date()) return false;
    return true;
  } catch {
    return true;
  }
}

// ── Auth middleware ────────────────────────────────────────────────────────
// Runs on every new socket. Rejects unauthenticated connections by passing
// an Error to `next()` — Socket.IO responds with `connect_error` and the
// client falls back to polling (see useRealtime hook).
io.use(async (socket: Socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || "";
  const sessionToken = parseCookie(cookieHeader, "crm_session");
  const authPayload = (socket.handshake.auth as any)?.token ?? null;

  let identity: SocketData | null = null;

  // Path 1 — cookie JWT (preferred, same-origin).
  if (sessionToken) {
    const payload = await verifySessionJwt(sessionToken);
    if (payload?.sub) {
      // Optional revocation cross-check — non-fatal on failure.
      const notRevoked = await sessionNotRevoked(sessionToken).catch(() => true);
      if (notRevoked) {
        identity = {
          userId: payload.sub,
          tenantId: payload.tenant_id ?? null,
          role: payload.role ?? "staff",
        };
      }
    }
  }

  // Path 2 — handshake payload (cross-origin fallback). Verify against
  // Supabase so we don't trust a client-supplied tenant_id/role.
  if (!identity && authPayload?.userId) {
    const looked = await lookupUser(authPayload.userId);
    if (looked) {
      identity = {
        userId: String(authPayload.userId),
        tenantId: looked.tenant_id,
        role: looked.role,
      };
    }
    // Audit 2d-F3 / 2e-F6 fix: removed the `else if (!supabase)` dev-mode
    // fallback that accepted client-supplied userId/tenantId without
    // Supabase verification. The exact bypass payload was:
    //   io(url, { transports: ["websocket"],
    //            auth: { token: { userId, tenantId } } })
    // which let an attacker join any tenant room and receive that tenant's
    // events. If Supabase is not configured, cross-origin handshakes are
    // now rejected — cookie-based auth still works for same-origin
    // connections (the production Vercel→sandbox path).
  }

  if (!identity) {
    return next(new Error("Unauthenticated"));
  }

  socket.data = identity;

  // Join per-tenant room — every event for this tenant is broadcast here.
  // super_admin has tenant_id = null (platform-level), so they get their
  // own room (`tenant:super_admin`) and the cross-tenant `super_admins`
  // room for signup:request etc. Tenant admins go in their tenant room.
  if (identity.tenantId) {
    void socket.join(`tenant:${identity.tenantId}`);
  } else {
    void socket.join("tenant:super_admin");
  }
  if (identity.role === "super_admin") {
    void socket.join("super_admins");
  }

  next();
});

// ── Connection lifecycle logging ──────────────────────────────────────────
io.on("connection", (socket: Socket) => {
  const d = socket.data as SocketData;
  console.log(
    `[realtime] connected userId=${d.userId} tenantId=${d.tenantId ?? "-"} ` +
      `role=${d.role} (total: ${io.engine.clientsCount})`,
  );

  socket.on("disconnect", (reason) => {
    console.log(
      `[realtime] disconnected userId=${d.userId} reason=${reason} ` +
        `(total: ${io.engine.clientsCount})`,
    );
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[realtime] listening on http://0.0.0.0:${PORT}`);
  console.log(
    `[realtime] accessible via gateway at /?XTransformPort=${PORT}`,
  );
});

// Graceful shutdown — close the HTTP server first so new connections are
// refused, then disconnect every socket with a 1s grace period.
function shutdown(signal: string): void {
  console.log(`[realtime] ${signal} received, shutting down...`);
  io.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
  // Hard exit after 5s if graceful close hangs.
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
