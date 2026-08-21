import ZAI from "z-ai-web-dev-sdk";

/**
 * Shared Z.AI SDK client factory.
 *
 * The official `ZAI.create()` only reads a `.z-ai-config` file from
 * `process.cwd()`, `os.homedir()`, or `/etc/`. On serverless runtimes
 * (Vercel) none of those paths are writable at request time, so the SDK
 * throws "Configuration file not found" the moment document parsing or
 * web search is invoked.
 *
 * This helper tries the file-based config first (local dev with
 * `.z-ai-config` in the project root), then falls back to constructing
 * the client directly from `ZAI_BASE_URL` + `ZAI_API_KEY` env vars.
 *
 * No secrets are committed — the env vars are set on the Vercel project
 * (and locally via `.env`, which is gitignored).
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
 * runtime — we cast to bypass the type check without resorting to `any`.
 */
function constructFromConfig(config: ZaiConfig): ZaiClient {
  const Ctor = ZAI as unknown as new (c: ZaiConfig) => ZaiClient;
  return new Ctor(config);
}

/**
 * Resolve the Z.AI config from env vars (ZAI_BASE_URL + ZAI_API_KEY).
 * Returns null if either is missing.
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

/**
 * Get a Z.AI client.
 *
 * Resolution order:
 * 1. `ZAI.create()` — works if `.z-ai-config` exists (local dev)
 * 2. `constructFromConfig(configFromEnv())` — env vars (Vercel/serverless)
 *
 * Throws a descriptive error if neither path yields a configured client.
 */
export async function getZaiClient(): Promise<ZaiClient> {
  // 1. Try the file-based config first (local dev convenience).
  try {
    return await ZAI.create();
  } catch {
    // Fall through to env-var path.
  }

  // 2. Env-var fallback for serverless (Vercel) or any env without the
  //    .z-ai-config file.
  const config = configFromEnv();
  if (config) {
    return constructFromConfig(config);
  }

  throw new Error(
    "AI vision service is not configured — either create a .z-ai-config " +
      "file (baseUrl + apiKey) or set ZAI_BASE_URL + ZAI_API_KEY env vars.",
  );
}
