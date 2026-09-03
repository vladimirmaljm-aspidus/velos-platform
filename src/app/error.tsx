"use client";

/**
 * Root route-level Error Boundary (FIX-NOTIF-A11Y).
 *
 * `global-error.tsx` already exists as the catch-all for the entire
 * app, but it replaces the WHOLE document (the <html>/<body> shell) —
 * so when it triggers, the sidebar, topbar, and Toaster all disappear
 * and the user is dropped into a bare-bones error page with no nav.
 *
 * This `error.tsx` lives one level below `global-error.tsx`: it
 * catches errors thrown inside the route segment rendered by
 * `layout.tsx`'s {children}, while the layout itself (sidebar /
 * topbar / Toaster) stays mounted. So a crash in a single view
 * (e.g. ERP) shows a friendly error card INSIDE the app shell with
 * a "Try again" button — the user can still navigate elsewhere.
 *
 * Behaviour:
 *   • Logs to Sentry (no-op if SENTRY_DSN not set) + console.
 *   • Shows a Card with AlertTriangle icon, the error message, the
 *     digest (when present), and a "Try again" button that calls
 *     `reset()` to re-render the failed segment.
 *   • Falls back to a generic message when `error.message` is empty
 *     (which it can be in production where Next.js strips messages).
 *
 * (Audit finding D-1/P1-1, plus the cross-cutting Error Boundaries
 * finding from the platform audit: "No src/app/error.tsx — shell
 * chrome lost on any view crash".)
 */

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { reportError } from "@/components/error-reporter";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report to Sentry (no-op if SENTRY_DSN not set — see
    // sentry.client.config.ts). Also log to console so Render's
    // stdout/stderr capture picks it up as the default error trail.
    Sentry.captureException(error);
    console.error("[RouteError]", error);
    // 8-c (error audit): record the React render error in the in-house
    // error_logs table via the public /api/client-errors ingest (source
    // 'client'), carrying the Next.js digest so the admin Error Audit view
    // can correlate it with the server logs. reportError never throws.
    reportError(error, { digest: error?.digest, boundary: "route-error" });
  }, [error]);

  const displayMessage =
    error?.message && error.message.length > 0
      ? error.message
      : "An unexpected error occurred while rendering this view. Your data is safe — try reloading.";

  return (
    <div
      role="alert"
      className="min-h-[60vh] flex items-center justify-center p-4"
    >
      <Card className="max-w-md w-full text-center shadow-soft-lg">
        <CardHeader className="items-center gap-2 pb-2">
          <div className="size-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
          </div>
          <CardTitle className="text-lg">Something went wrong</CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            {displayMessage}
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-col gap-3 items-center pt-0">
          <Button onClick={reset} className="gap-2">
            <RotateCcw className="size-4" aria-hidden="true" />
            Try again
          </Button>
          {error?.digest && (
            <p className="text-xs text-muted-foreground font-mono">
              Error ID: {error.digest}
            </p>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
