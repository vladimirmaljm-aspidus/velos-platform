/**
 * VELOS AI Relay — mini-service that bridges Vercel (external) to the
 * Z.AI internal API (only reachable from within Z.ai's infrastructure).
 *
 * Port: 3030 (accessed via the gateway with ?XTransformPort=3030)
 *
 * Endpoints:
 *   POST /chat   { messages, thinking? } → { text, usage }
 *   POST /vision { messages (with image_url/file_url content) } → { text, usage }
 *   POST /extract { text, instruction } → { text } (PDF text → chat for extraction)
 *   GET  /health → { status: "ok" }
 *
 * The Z.AI SDK reads /home/z/my-project/.z-ai-config (which has the
 * internal token) and calls internal-api.z.ai — which this sandbox CAN
 * reach. Vercel's serverless functions can't reach internal-api.z.ai
 * directly, so they call this relay instead via ZAI_RELAY_URL.
 *
 * CORS: open to all origins (the relay carries no secrets — the Z.AI
 * token stays server-side in .z-ai-config, never exposed to the client).
 *
 * AUTH (Audit 2e-F8 fix): all POST endpoints require
 *   `Authorization: Bearer <ZAI_RELAY_TOKEN>`
 * Without this, anyone reaching the relay via the gateway
 * (?XTransformPort=3030) got unauthenticated Z.AI API calls — the
 * operator paid the bill and the caller could extract structured data
 * (COA, spec sheets) from any uploaded document. Set ZAI_RELAY_TOKEN in
 * the relay's env (and on the Next.js side that calls /api/ai/relay-proxy)
 * to a random string (openssl rand -hex 32). The Next.js relay-proxy route
 * must send `Authorization: Bearer ${ZAI_RELAY_TOKEN}` instead of the
 * cosmetic `x-session-id` header it currently sends.
 */

import ZAI from "z-ai-web-dev-sdk";
import { createServer } from "http";
import { timingSafeEqual } from "crypto";

const PORT = 3030;
const PROJECT_ROOT = "/home/z/my-project";

let _zaiPromise: Promise<ZAI> | null = null;
async function getZai(): Promise<ZAI> {
  if (!_zaiPromise) {
    _zaiPromise = ZAI.create();
  }
  return _zaiPromise;
}

function setCORS(res: import("http").ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJSON(res: import("http").ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody(req: import("http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (Buffer.concat(chunks).length > 30 * 1024 * 1024) {
      throw new Error("Body too large (30MB limit)");
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handleChat(body: any): Promise<{ text: string; usage?: any }> {
  const zai = await getZai();
  const r = await zai.chat.completions.create({
    messages: body.messages,
    thinking: body.thinking ?? { type: "disabled" },
  });
  const content = r?.choices?.[0]?.message?.content ?? "";
  return {
    text: typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        : String(content ?? ""),
    usage: r?.usage,
  };
}

async function handleVision(body: any): Promise<{ text: string; usage?: any }> {
  const zai = await getZai();
  const r = await zai.chat.completions.createVision({
    model: "glm-4v",
    messages: body.messages,
    thinking: body.thinking ?? { type: "disabled" },
  } as any);
  const content = r?.choices?.[0]?.message?.content ?? r?.choices?.[0]?.delta?.content ?? "";
  return {
    text: typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        : String(content ?? ""),
    usage: r?.usage,
  };
}

async function handleExtract(body: any): Promise<{ text: string }> {
  // For PDF text extraction — just call chat with the text + instruction
  const zai = await getZai();
  const r = await zai.chat.completions.create({
    messages: [{
      role: "user",
      content: `${body.instruction}\n\n--- DOCUMENT TEXT (extracted from PDF) ---\n${body.text}`,
    }],
    thinking: { type: "disabled" },
  });
  const content = r?.choices?.[0]?.message?.content ?? "";
  return {
    text: typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        : String(content ?? ""),
  };
}

// ─── /parse-document endpoint (full PDF/image analysis) ─────────────────────
// Used by the browser (client-side) to bypass Vercel's network block.
// The browser sends the file (PDF or image) + type, the relay does:
//   1. If PDF: extract text via unpdf → send to chat model (fast path)
//   2. If image or scanned PDF: send to vision model
//   3. Return structured JSON

const COA_PROMPT = `You are a B2B commodity-trade compliance assistant. Extract ALL data from this Certificate of Analysis document. Return STRICT JSON only (no markdown fences, no prose). Fields:
{"product":"","batch":"","date":null,"manufactureDate":null,"expiryDate":null,"manufacturer":"","grade":"","origin":"","certifications":[],"storage":"","packaging":"","shelfLife":"","parameters":[{"name":"","value":"","unit":"","spec":"","result":""}],"confidence":"high|medium|low","uncertain_fields":[]}
Use null for unreadable fields. Do not invent data.`;

const SPEC_SHEET_PROMPT = `You are a B2B commodity-trade compliance assistant. Extract ALL data from this product specification sheet. Return STRICT JSON only (no markdown fences, no prose). Fields:
{"productName":"","sku":"","hsCode":"","category":"","brand":"","originCountry":"","shelfLife":"","storage":"","packaging":"","containerCapacity":{"cap20":null,"cap40":null},"certifications":[],"applications":[],"specifications":{"appearance":"","color":"","odor":"","density":"","moisture":"","purity":"","activeIngredient":"","pH":"","solubility":"","particleSize":"","viscosity":""},"confidence":"high|medium|low","uncertain_fields":[]}
Use null for unreadable fields. Do not invent data.`;

function stripDataUrlPrefix(s: string): string {
  const idx = s.indexOf(";base64,");
  if (idx >= 0 && s.startsWith("data:")) return s.slice(idx + 8);
  return s;
}

function extractJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const open = trimmed.match(/```(?:json)?\s*([\s\S]+)/i);
  if (open) { try { return JSON.parse(open[1].trim()); } catch {} }
  const first = trimmed.search(/[{[]/);
  if (first >= 0) {
    const ch = trimmed[first];
    const close = ch === "{" ? "}" : "]";
    const last = trimmed.lastIndexOf(close);
    if (last > first) { try { return JSON.parse(trimmed.slice(first, last + 1)); } catch {} }
  }
  return null;
}

async function handleParseDocument(body: any): Promise<{ result: unknown }> {
  const { type, fileBase64, mimeType } = body;
  if (!fileBase64) throw new Error("Missing fileBase64");
  if (type !== "coa" && type !== "spec_sheet") throw new Error("Invalid type (must be coa or spec_sheet)");

  const instruction = type === "coa" ? COA_PROMPT : SPEC_SHEET_PROMPT;
  const clean = stripDataUrlPrefix(fileBase64);
  const isPdf = (mimeType === "application/pdf") || clean.startsWith("JVBERi");

  const zai = await getZai();

  // Fast path: PDF text extraction → chat model
  if (isPdf) {
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const bin = Buffer.from(clean, "base64");
      const pdf = await getDocumentProxy(new Uint8Array(bin));
      const result = await extractText(pdf, { mergePages: true });
      const pdfText = (result?.text ?? "").trim();
      if (pdfText.length > 50) {
        const chatResult = await zai.chat.completions.create({
          messages: [{ role: "user", content: `${instruction}\n\n--- DOCUMENT TEXT ---\n${pdfText}` }],
          thinking: { type: "disabled" },
        });
        const content = chatResult?.choices?.[0]?.message?.content ?? "";
        const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => typeof c === "string" ? c : c?.text ?? "").join("") : String(content);
        const parsed = extractJson(raw);
        if (parsed && typeof parsed === "object") return { result: parsed };
      }
    } catch (e) {
      console.error("[ai-relay] PDF text extraction failed, falling back to vision:", e);
    }
  }

  // Slow path: vision model (images + scanned PDFs)
  const mime = isPdf ? "application/pdf" : (mimeType || "image/png");
  const contentBlock = isPdf
    ? { type: "file_url", file_url: { url: `data:application/pdf;base64,${clean}` } }
    : { type: "image_url", image_url: { url: `data:${mime};base64,${clean}` } };

  const visionResult = await zai.chat.completions.createVision({
    model: "glm-4v",
    messages: [{ role: "user", content: [{ type: "text", text: instruction }, contentBlock] }],
    thinking: { type: "disabled" },
  } as any);
  const content = visionResult?.choices?.[0]?.message?.content ?? "";
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => typeof c === "string" ? c : c?.text ?? "").join("") : String(content);
  const parsed = extractJson(raw);
  if (parsed && typeof parsed === "object") return { result: parsed };
  throw new Error("AI did not return parseable JSON");
}

const server = createServer(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET") {
    const path = req.url?.split("?")[0];
    if (path === "/health") {
      sendJSON(res, 200, { status: "ok", service: "velos-ai-relay", port: PORT });
      return;
    }
    sendJSON(res, 405, { error: "Method not allowed" });
    return;
  }
  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "Method not allowed" });
    return;
  }

  // Audit 2e-F8 fix: require a Bearer token on all POST endpoints. Without
  // this, anyone reaching the relay via the gateway (?XTransformPort=3030)
  // gets unauthenticated Z.AI API calls — the operator pays the bill, and
  // the caller can extract structured data (COA, spec sheets) from any
  // uploaded document. The token is a shared secret between the Next.js app
  // (which calls the relay via /api/ai/relay-proxy) and this service.
  const RELAY_TOKEN = process.env.ZAI_RELAY_TOKEN;
  if (!RELAY_TOKEN || RELAY_TOKEN.length < 16) {
    console.error(
      "[ai-relay] ZAI_RELAY_TOKEN env var is missing or too short (min 16 chars). " +
        "Refusing all requests — set ZAI_RELAY_TOKEN to a random string (openssl rand -hex 32).",
    );
    sendJSON(res, 500, { error: "Relay not configured (missing ZAI_RELAY_TOKEN)." });
    return;
  }
  const authHeader = req.headers.authorization || "";
  const presented = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  // Constant-time compare to prevent timing-attack token recovery.
  if (presented.length !== RELAY_TOKEN.length) {
    sendJSON(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(RELAY_TOKEN))) {
      sendJSON(res, 401, { error: "Unauthorized" });
      return;
    }
  } catch {
    sendJSON(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const path = req.url?.split("?")[0];
    let result: unknown;
    if (path === "/chat") result = await handleChat(body);
    else if (path === "/vision") result = await handleVision(body);
    else if (path === "/extract") result = await handleExtract(body);
    else if (path === "/parse-document") result = await handleParseDocument(body);
    else { sendJSON(res, 404, { error: "Unknown endpoint" }); return; }
    sendJSON(res, 200, result);
  } catch (e) {
    console.error("[ai-relay] error:", e);
    sendJSON(res, 500, { error: e instanceof Error ? e.message : "Relay error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[velos-ai-relay] listening on http://0.0.0.0:${PORT}`);
  console.log(`[velos-ai-relay] accessible via gateway at /?XTransformPort=${PORT}`);
});
