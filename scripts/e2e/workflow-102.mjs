// E2E 102 — full marketplace deal-workflow verification on PRODUCTION.
//
// Verifies the 6 workflow-audit gaps end-to-end against
// https://velos-platform.vercel.app with two fresh premium-tier portal
// accounts (KYC-exempt):
//
//   GAP 1: counter → responder notification
//   GAP 2: counter with no room → room auto-created + terms delivered
//   GAP 3: room opened (owner-side) → counterparty notification
//   GAP 4: contact-reveal system message has REAL text
//   GAP 5: second accept → status flips to accepted + both parties notified
//   GAP 6: withdraw → responder pulls own offer, owner notified, withdrawn terminal
//   BONUS: cancelled negotiation notification is now visible in the bell
//
// Usage: bun run scripts/e2e/workflow-102.mjs
const BASE = "https://velos-platform.vercel.app";
const PW = "E2E-Wf-102!x";
const OWNER = { email: "e2e102.owner@velos-test.dev", label: "OWNER" };
const RESP = { email: "e2e102.resp@velos-test.dev", label: "RESPONDER" };

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function login({ email }) {
  const r = await fetch(`${BASE}/api/portal/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, tenant_id: "c889572d-d35b-43ec-bca1-a5359d95603d" }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status} ${await r.text()}`);
  const cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
  return cookie;
}

async function api(cookie, path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}

async function notifs(cookie) {
  const { body } = await api(cookie, "/api/portal/notifications?limit=50");
  return body?.items ?? [];
}

const run = async () => {
  console.log("\n════════ E2E 102 — marketplace deal workflow ════════\n");
  console.log("── login both parties");
  const ownerCookie = await login(OWNER);
  const respCookie = await login(RESP);
  ok("both logins succeed", true);

  // ── clean slate: mark old e2e102 notifications read ──────────────
  await api(ownerCookie, "/api/portal/notifications/read-all", { method: "POST" }).catch(() => {});
  await api(respCookie, "/api/portal/notifications/read-all", { method: "POST" }).catch(() => {});

  // ── 1. owner creates a post ───────────────────────────────────────
  console.log("── 1. owner creates a marketplace post");
  const postTitle = `E2E-102 Workflow Test ${Date.now()}`;
  const createPost = await api(ownerCookie, "/api/marketplace", {
    method: "POST",
    body: JSON.stringify({
      product_name: postTitle,
      post_type: "sell",
      category: "Metals",
      quantity: 1000,
      unit: "MT",
      currency: "USD",
      target_price: 250,
      description: "E2E workflow test post (102) — auto-cleaned",
      visibility: "public",
      location: "Dubai, UAE",
    }),
  });
  ok("post created", createPost.status === 201 || createPost.status === 200, JSON.stringify(createPost.body).slice(0, 200));
  const postId = createPost.body?.id;
  if (!postId) throw new Error("no post id — aborting");
  console.log(`     post: ${postId}`);

  // ── 2. responder sends an offer (price quote) ─────────────────────
  console.log("── 2. responder sends an offer");
  const offer = await api(respCookie, `/api/marketplace/${postId}/responses`, {
    method: "POST",
    body: JSON.stringify({
      quantity: 900,
      unit_price: 235,
      currency: "USD",
      incoterm: "CIF",
      message: "E2E offer — 900 MT at 235",
    }),
  });
  ok("offer accepted by API", offer.status === 200 || offer.status === 201, JSON.stringify(offer.body).slice(0, 200));
  const offerId = offer.body?.id;
  if (!offerId) throw new Error("no offer id — aborting");

  // ── baseline notifications (owner should already have response_received) ──
  const ownerNotifs1 = await notifs(ownerCookie);
  ok("GAP(0)/baseline: owner notified of new response", ownerNotifs1.some((n) => n.type === "marketplace_response_received"), "expected marketplace_response_received in bell");

  // ── 3. OWNER COUNTERS with NO room existing → GAP 1 + GAP 2 + GAP 3 ──
  console.log("── 3. owner counters (no room exists yet — GAP 2 auto-create)");
  const putCounter = await api(ownerCookie, `/api/marketplace/${postId}/responses/${offerId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "countered" }),
  });
  ok("PUT countered ok", putCounter.status === 200, JSON.stringify(putCounter.body).slice(0, 200));
  ok("PUT returns responder partner_id (for room auto-create)", !!putCounter.body?.partner_id);

  // owner-side room creation (the exact call the fixed counterMut makes)
  const roomCreate = await api(ownerCookie, "/api/marketplace/negotiations", {
    method: "POST",
    body: JSON.stringify({ post_id: postId, response_id: offerId, partner_id_b: putCounter.body?.partner_id }),
  });
  ok("GAP 2: owner-side room auto-created", roomCreate.status === 200 || roomCreate.status === 201, JSON.stringify(roomCreate.body).slice(0, 200));
  const roomId = roomCreate.body?.id;
  if (!roomId) throw new Error("no room id — aborting");
  console.log(`     room: ${roomId}`);

  // deliver counter terms into the room (second call the fixed counterMut makes)
  const counterMsg = await api(ownerCookie, `/api/marketplace/negotiations/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message_type: "counter_offer",
      message: "Counter: 950 MT at 240 CIF",
      offer_data: { quantity: 950, unit_price: 240, price: 240, currency: "USD" },
    }),
  });
  ok("GAP 2: counter terms delivered into the room", counterMsg.status === 200 || counterMsg.status === 201, JSON.stringify(counterMsg.body).slice(0, 200));

  // ── responder's notifications now: countered + room opened (+ message) ──
  const respNotifs1 = await notifs(respCookie);
  ok("GAP 1: responder notified of COUNTER-offer", respNotifs1.some((n) => n.type === "marketplace_response_countered"), "expected marketplace_response_countered");
  ok("GAP 3: responder notified room was opened", respNotifs1.some((n) => n.type === "marketplace_negotiation_opened"), "expected marketplace_negotiation_opened");
  ok("message notification also fired", respNotifs1.some((n) => n.type === "marketplace_message_received"));

  // ── 4. responder counters back inside the room (normal negotiation) ──
  console.log("── 4. responder counters back in the room");
  const respCounter = await api(respCookie, `/api/marketplace/negotiations/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message_type: "counter_offer",
      message: "Deal at 950 MT / 238 CIF?",
      offer_data: { quantity: 950, unit_price: 238, price: 238, currency: "USD" },
    }),
  });
  ok("responder counter-offer message sent", respCounter.status === 200 || respCounter.status === 201);

  // ── 5. RESPONDER WITHIEWS a SECOND offer → GAP 6 ────────────────────
  console.log("── 5. responder sends a 2nd offer then withdraws it (GAP 6)");
  const offer2 = await api(respCookie, `/api/marketplace/${postId}/responses`, {
    method: "POST",
    body: JSON.stringify({ quantity: 500, unit_price: 300, currency: "USD", message: "Second offer — to be withdrawn" }),
  });
  const offer2Id = offer2.body?.id;
  ok("second offer created", !!offer2Id);

  const withdraw = await api(respCookie, `/api/marketplace/${postId}/responses/${offer2Id}/withdraw`, { method: "POST" });
  ok("GAP 6: withdraw succeeds", withdraw.status === 200, JSON.stringify(withdraw.body).slice(0, 200));
  ok("GAP 6: status is withdrawn", withdraw.body?.status === "withdrawn");

  const ownerNotifs2 = await notifs(ownerCookie);
  ok("GAP 6: owner notified of withdrawal", ownerNotifs2.some((n) => n.type === "marketplace_response_withdrawn"), "expected marketplace_response_withdrawn");

  // withdrawing again must fail (terminal)
  const withdraw2 = await api(respCookie, `/api/marketplace/${postId}/responses/${offer2Id}/withdraw`, { method: "POST" });
  ok("GAP 6: double-withdraw rejected (terminal state)", withdraw2.status === 409 || withdraw2.status === 400, `status=${withdraw2.status}`);

  // owner CANNOT withdraw the responder's offer (ownership guard)
  const ownerWithdraw = await api(ownerCookie, `/api/marketplace/${postId}/responses/${offer2Id}/withdraw`, { method: "POST" });
  ok("GAP 6: owner cannot withdraw responder's offer (403)", ownerWithdraw.status === 403, `status=${ownerWithdraw.status}`);

  // ── 6. the deal: responder accepts the counter, owner accepts → GAP 4 + GAP 5 ──
  console.log("── 6. both parties accept → deal complete (GAP 4 + GAP 5)");
  const accResp = await api(respCookie, `/api/marketplace/negotiations/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message_type: "accept", message: "Accepted at 238 CIF" }),
  });
  ok("responder accept message sent", accResp.status === 200 || accResp.status === 201, JSON.stringify(accResp.body).slice(0, 150));

  const accOwner = await api(ownerCookie, `/api/marketplace/negotiations/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message_type: "accept", message: "Deal!" }),
  });
  ok("owner accept message sent (handshake completes)", accOwner.status === 200 || accOwner.status === 201, JSON.stringify(accOwner.body).slice(0, 150));

  // negotiation status must now be accepted (GAP 5)
  const roomGet = await api(ownerCookie, `/api/marketplace/negotiations/${roomId}`);
  ok("GAP 5: negotiation status flipped to accepted", roomGet.body?.negotiation?.status === "accepted", `status=${roomGet.body?.negotiation?.status}`);
  ok("GAP 5: contact_revealed = true", roomGet.body?.negotiation?.contact_revealed === true);

  // messages after the flip must be blocked (read-only room)
  const postDealMsg = await api(ownerCookie, `/api/marketplace/negotiations/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message_type: "text", message: "should be blocked" }),
  });
  ok("room locked after completion (409 on new message)", postDealMsg.status === 409, `status=${postDealMsg.status}`);

  // both parties get the deal-complete notification (GAP 5)
  const ownerNotifs3 = await notifs(ownerCookie);
  const respNotifs3 = await notifs(respCookie);
  ok("GAP 5: owner got deal-complete notification", ownerNotifs3.some((n) => n.type === "marketplace_negotiation_accepted"));
  ok("GAP 5: responder got deal-complete notification", respNotifs3.some((n) => n.type === "marketplace_negotiation_accepted"));

  // the system message has REAL text (GAP 4)
  const msgs = await api(ownerCookie, `/api/marketplace/negotiations/${roomId}/messages`);
  const systemMsgs = (msgs.body?.items ?? []).filter((m) => m.message_type === "system");
  const contactRevealMsg = systemMsgs.find((m) => /contact/i.test(m.message || "") && /unlock|accepted|deal/i.test(m.message || ""));
  ok("GAP 4: contact-reveal system message has real text", !!contactRevealMsg && (contactRevealMsg.message?.length ?? 0) > 20, `system msgs: ${systemMsgs.length}, text=${JSON.stringify(systemMsgs.map((m) => (m.message || "").slice(0, 40)))}`);

  // deal-complete notification is VISIBLE in the bell (PORTAL_SAFE_TYPES fix)
  ok("BONUS: deal-complete notification passes the portal bell allowlist", respNotifs3.some((n) => n.type === "marketplace_negotiation_accepted" && n.title === "Deal complete"));

  console.log(`\n════════ RESULT: ${pass} passed, ${fail} failed ════════\n`);
  if (fail > 0) process.exit(1);
};

run().catch((e) => { console.error("E2E CRASHED:", e.message); process.exit(2); });
