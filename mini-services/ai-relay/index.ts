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
 */

import ZAI from "z-ai-web-dev-sdk";
import { createServer } from "http";

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

const server = createServer(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJSON(res, 200, { status: "ok", service: "velos-ai-relay", port: PORT });
    return;
  }
  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "Method not allowed" });
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
