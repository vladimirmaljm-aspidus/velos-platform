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
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
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
