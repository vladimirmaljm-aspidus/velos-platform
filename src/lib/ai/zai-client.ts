import ZAI from "z-ai-web-dev-sdk";

/**
 * Shared Z.AI SDK client factory.
 *
 * Resolution order:
 * 1. File-based config (.z-ai-config) — works on the Z.ai sandbox where
 *    internal-api.z.ai is reachable.
 * 2. Relay proxy (ZAI_RELAY_URL) — for Vercel/serverless where
 *    internal-api.z.ai is NOT reachable. The relay runs on the sandbox
 *    and forwards requests to the Z.AI API. Set ZAI_RELAY_URL to the
 *    sandbox's external URL (the preview URL the user sees in the
 *    browser). The relay itself is at mini-services/ai-relay/index.ts
 *    and listens on port 3030.
 * 3. Direct env-var config (ZAI_BASE_URL + ZAI_API_KEY) — last resort,
 *    only works if the Z.AI API is directly reachable (not for
 *    internal-api.z.ai from Vercel).
 *
 * No secrets are committed — env vars are set on the Vercel project.
 */

export type ZaiConfig = {
  baseUrl: string;
  apiKey: string;
  chatId?: string;
  userId?: string;
  token?: string;
};

export type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;

/**
 * Build a ZAI client directly from a config object. The SDK's
 * constructor is marked private in the TS types but is callable at
 * runtime.
 */
function constructFromConfig(config: ZaiConfig): ZaiClient {
  const Ctor = ZAI as unknown as new (c: ZaiConfig) => ZaiClient;
  return new Ctor(config);
}

/**
 * Resolve the Z.AI config from env vars. Returns null if any required
 * field is missing.
 */
export function configFromEnv(): ZaiConfig | null {
  const baseUrl = process.env.ZAI_BASE_URL;
  const apiKey = process.env.ZAI_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    chatId: process.env.ZAI_CHAT_ID || undefined,
    userId: process.env.ZAI_USER_ID || undefined,
    token: process.env.ZAI_TOKEN || undefined,
  };
}

// ─── Relay proxy client (for Vercel) ────────────────────────────────────────

/**
 * A proxy client that implements the same interface as the Z.AI SDK
 * (.chat.completions.create + .chat.completions.createVision) but
 * forwards the calls to the relay mini-service on the sandbox via HTTP.
 *
 * The relay (mini-services/ai-relay/index.ts) runs on port 3030 and is
 * accessible through the gateway with ?XTransformPort=3030.
 *
 * Set ZAI_RELAY_URL to the sandbox's external preview URL (without a
 * path — the proxy appends /chat, /vision, /extract). Example:
 *   ZAI_RELAY_URL=https://abc123.z.ai/preview
 * The proxy calls:
 *   POST https://abc123.z.ai/preview/chat?XTransformPort=3030
 */
function createRelayClient(relayBase: string): ZaiClient {
  // Strip trailing slash so we can append /path cleanly.
  const base = relayBase.replace(/\/$/, "");
  const url = (path: string) => `${base}${path}?XTransformPort=3030`;

  async function callRelay(path: string, body: Record<string, unknown>): Promise<{ text: string; usage?: unknown }> {
    const res = await fetch(url(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Required by the Alibaba Cloud FC gateway (session affinity).
        // Without this header, the gateway returns 400 "Invocation is
        // rejected, due to header 'x-session-id' is required".
        "x-session-id": "velos-relay-1",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`AI relay call failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const data = await res.json() as { text?: string; usage?: unknown; error?: string };
    if (data.error) throw new Error(`AI relay error: ${data.error}`);
    return { text: data.text ?? "", usage: data.usage };
  }

  // The Z.AI SDK returns { choices: [{ message: { content } }], usage }.
  // We synthesize that shape from the relay's { text, usage } response.
  const synthResponse = (text: string, usage?: unknown) => ({
    choices: [{ index: 0, message: { role: "assistant", content: text } }],
    usage,
  });

  const client = {
    chat: {
      completions: {
        create: async (req: { messages: unknown[]; thinking?: unknown }) => {
          const { text, usage } = await callRelay("/chat", {
            messages: req.messages,
            thinking: req.thinking ?? { type: "disabled" },
          });
          return synthResponse(text, usage);
        },
        createVision: async (req: { messages: unknown[]; thinking?: unknown; model?: string }) => {
          const { text, usage } = await callRelay("/vision", {
            messages: req.messages,
            thinking: req.thinking ?? { type: "disabled" },
          });
          return synthResponse(text, usage);
        },
      },
    },
  };
  return client as unknown as ZaiClient;
}

/**
 * Get a Z.AI client.
 *
 * Resolution order:
 * 1. File-based config (.z-ai-config) — sandbox/local dev.
 * 2. ZAI_RELAY_URL — Vercel (relays through the sandbox).
 * 3. ZAI_BASE_URL + ZAI_API_KEY — direct (only if API is reachable).
 */
export async function getZaiClient(): Promise<ZaiClient> {
  // 1. File-based config (sandbox/local).
  try {
    return await ZAI.create();
  } catch {
    // Fall through.
  }

  // 2. Relay proxy (Vercel — can't reach internal-api.z.ai directly).
  const relayUrl = process.env.ZAI_RELAY_URL;
  if (relayUrl) {
    return createRelayClient(relayUrl);
  }

  // 3. Direct env-var config (last resort — only if API is reachable).
  const config = configFromEnv();
  if (config) {
    return constructFromConfig(config);
  }

  throw new Error(
    "AI vision service is not configured. Options:\n" +
      "  1. Create a .z-ai-config file (sandbox/local dev)\n" +
      "  2. Set ZAI_RELAY_URL to the sandbox preview URL (Vercel)\n" +
      "  3. Set ZAI_BASE_URL + ZAI_API_KEY (if the Z.AI API is directly reachable)",
  );
}
