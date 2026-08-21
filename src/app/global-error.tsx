"use client";

/**
 * Global Error Boundary — catches unhandled errors in any route segment.
 * Without this, a single component crash takes down the entire app with
 * Next.js's default error page (no recovery path, no "back to dashboard").
 * (Audit finding D-1/P1-1)
 *
 * F-8: now reports the error to Sentry (if SENTRY_DSN is configured) via
 * `Sentry.captureException`. If Sentry is not configured (no DSN), this is
 * a no-op — falls through to the existing `console.error` log.
 */

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report to Sentry (no-op if SENTRY_DSN not set — see sentry.client.config.ts).
    Sentry.captureException(error);
    // Also log to console — Render captures stdout/stderr so this is the
    // default error trail when Sentry is not configured.
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html>
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            backgroundColor: "#f8fafc",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: "420px",
              width: "100%",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: "64px",
                height: "64px",
                borderRadius: "50%",
                backgroundColor: "#fef2f2",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 20px",
              }}
            >
              <AlertTriangle
                style={{ width: "32px", height: "32px", color: "#dc2626" }}
              />
            </div>
            <h1
              style={{
                fontSize: "20px",
                fontWeight: 600,
                color: "#1e293b",
                marginBottom: "8px",
              }}
            >
              Something went wrong
            </h1>
            <p
              style={{
                fontSize: "14px",
                color: "#64748b",
                marginBottom: "24px",
                lineHeight: 1.5,
              }}
            >
              An unexpected error occurred. Your data is safe — try reloading
              the page. If the problem persists, contact support.
            </p>
            <Button onClick={reset} className="gap-2">
              <RotateCcw className="size-4" />
              Try again
            </Button>
            {error.digest && (
              <p
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginTop: "16px",
                  fontFamily: "monospace",
                }}
              >
                Error ID: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
