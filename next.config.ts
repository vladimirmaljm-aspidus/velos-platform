import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Vercel doesn't need "standalone" output — it handles the build natively
  typescript: {
    // Vercel has enough memory for TypeScript check (8GB+ vs Render's 512MB)
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  // unpdf bundles its own pdfjs internally and has CJS/dynamic-require
  // patterns that Turbopack mishandles when server-bundled. Treating it
  // as an external node module (required from node_modules at runtime)
  // avoids "Cannot find module" / "fetch failed" errors on Vercel.
  // z-ai-web-dev-sdk reads .z-ai-config from disk at runtime — keep external.
  serverExternalPackages: ["unpdf", "z-ai-web-dev-sdk"],
  // LOW_MEM_BUILD=1 (local sandbox builds): webpack memory optimizations —
  // the 4GB sandbox OOM-kills a default Turbopack/webpack build; this flag
  // trades build speed for ~40% lower peak RSS. Production CI (Vercel/Render)
  // never sets it, so their builds stay at full speed.
  ...(process.env.LOW_MEM_BUILD
    ? {
        // tsc --noEmit is verified separately in LOW_MEM runs — the in-build
        // TypeScript program doubles peak memory (two full type graphs).
        typescript: { ignoreBuildErrors: true },
        experimental: { webpackMemoryOptimizations: true },
        // The persistent webpack cache (filesystem) serializes megabytes of
        // strings after each compile — the single biggest memory spike for a
        // 4GB sandbox. LOW_MEM_BUILD disables it entirely: slower cold
        // rebuilds, but the build process stays under the OOM ceiling.
        webpack: (config: any) => {
          config.cache = false;
          return config;
        },
      }
    : {}),
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: [
            "default-src 'self'",
            // Audit C2 fix: removed 'unsafe-eval' — it allows eval()/new Function()
            // from an XSS injection, which is almost never needed in modern
            // Next.js 16 (Turbopack bundles everything; no lib should eval
            // untrusted strings). If a specific lib turns out to need it,
            // scope to that lib's origin via a per-route header override
            // rather than re-adding globally. Kept 'unsafe-inline' for now
            // — removing it requires nonce-based CSP (middleware nonce
            // injection + Next.js experimental.csp), which is a follow-up.
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https: blob:",
            "font-src 'self' data:",
            "connect-src 'self' https://*.supabase.co https://nominatim.openstreetmap.org https://maps.googleapis.com wss: ws:",
            "worker-src 'self' blob:",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "base-uri 'self'",
            "object-src 'none'",
          ].join("; ") },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
        ],
      },
    ];
  },
};

// Sentry wrapper — works on Vercel too (no-ops without DSN)
export default withSentryConfig(nextConfig, {
  silent: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
});
