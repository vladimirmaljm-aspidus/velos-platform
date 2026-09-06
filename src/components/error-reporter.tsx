"use client";

/**
 * ErrorReporter — silent client-side error capture (task 8-c).
 * ─────────────────────────────────────────────────────────────────────────────
 * Mounted ONCE in src/components/providers.tsx. Listens to:
 *   • window "error"                 — uncaught JS errors (script parse,
 *                                       runtime, failed dynamic imports)
 *   • window "unhandledrejection"    — unhandled promise rejections (the
 *                                       #1 source of invisible failures in
 *                                       fetch-heavy code)
 * and POSTs them to the PUBLIC /api/client-errors route, which records them
 * into error_logs (source 'client') for the admin Error Audit view.
 *
 * React RENDER errors never reach these listeners (React catches them in
 * the error boundaries) — src/app/error.tsx + global-error.tsx call the
 * exported reportError() directly with the Next.js digest, so those land in
 * the same table.
 *
 * Loop prevention (this module must NEVER make things worse):
 *   • dedupe per page-load: a Set of client fingerprints — each distinct
 *     bug signature is reported at most once per load
 *   • hard cap: 15 unique reports per page-load (an error storm in a render
 *     loop would otherwise fire hundreds of POSTs)
 *   • every fetch failure is swallowed (.catch + outer try/catch) — a dead
 *     endpoint must not become an unhandled rejection, which would be
 *     captured by THIS module and loop forever
 *   • known noise is ignored: ResizeObserver loop errors (benign browser
 *     behaviour, floods consoles on every layout thrash)
 *
 * Transport: fetch with keepalive (survives tab close mid-flight). While the
 * page is unloading (pagehide) navigator.sendBeacon is used instead — the
 * right primitive for the unload window. NO visual UI (renders null).
 */

import { useEffect } from "react";

const ENDPOINT = "/api/client-errors";

/** Distinct bug signatures reported per page-load before going silent. */
const MAX_REPORTS_PER_LOAD = 15;

/**
 * Known-benign noise. ResizeObserver loop warnings are browser-internal
 * layout-race notifications — not actionable app bugs, and they can fire
 * dozens of times per second during layout thrash.
 */
const IGNORED_MESSAGE_PATTERNS: RegExp[] = [
  /^ResizeObserver loop/,
];

// ── Module-level per-page-load state (survives component remounts) ─────────
const seenFingerprints = new Set<string>();
let reportedCount = 0;
let isUnloading = false;

/** Sync djb2-style hash — CLIENT-side dedupe only (the server recomputes
 *  the real sha256 fingerprint in error-audit.ts; this just needs to be
 *  stable and cheap). */
function clientFingerprint(message: string, stackFirstLine: string): string {
  const input = `${message}::${stackFirstLine}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return String(h);
}

function isIgnored(message: string): boolean {
  return IGNORED_MESSAGE_PATTERNS.some((p) => {
    try {
      return p.test(message);
    } catch {
      return false;
    }
  });
}

interface ErrorParts {
  message: string;
  stack: string | null;
  /** Extra known fields pulled off the Error/cause chain (React digest,
   *  error.cause) — merged into the report's context. */
  extra: Record<string, unknown>;
}

function extractErrorParts(err: unknown): ErrorParts {
  const extra: Record<string, unknown> = {};
  try {
    if (err instanceof Error) {
      // React/Next attach `digest` (server action + SSR error ids) and
      // `cause` (Error Options) — surface both in the context so the admin
      // detail view can correlate boundary reports with server logs.
      const anyErr = err as Error & { digest?: unknown; cause?: unknown };
      if (anyErr.digest !== undefined) extra.digest = String(anyErr.digest);
      if (anyErr.cause !== undefined) {
        extra.cause = anyErr.cause instanceof Error
          ? anyErr.cause.message
          : String(anyErr.cause).slice(0, 500);
      }
      return {
        message: err.message || err.name || "Error",
        stack: err.stack || null,
        extra,
      };
    }
    if (typeof err === "string") {
      return { message: err, stack: null, extra };
    }
    if (err === null || err === undefined) {
      return { message: "(no message)", stack: null, extra };
    }
    try {
      extra.value = JSON.stringify(err).slice(0, 500);
    } catch {
      extra.value = String(err).slice(0, 500);
    }
    return { message: String(err).slice(0, 500) || "(no message)", stack: null, extra };
  } catch {
    return { message: "reporter: extraction failed", stack: null, extra };
  }
}

/** Serialize + send one report. Swallows ALL failures by contract. */
function send(payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload);
    // During unload: sendBeacon (fire-and-forget, survives teardown).
    // Otherwise: fetch with keepalive (survives tab close mid-flight).
    if (
      isUnloading &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
        return;
      } catch {
        // fall through to fetch — beacon can throw on huge payloads
      }
    }
    if (typeof fetch !== "function") return;
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // MUST stay swallowed: a failing error-report POST becoming an
      // unhandled rejection would feed this very listener (infinite loop).
    });
  } catch {
    // Never throw out of the capture path.
  }
}

function report(
  parts: ErrorParts,
  level: "error" | "warning",
  context?: Record<string, unknown>,
): void {
  try {
    if (typeof window === "undefined") return; // SSR — server-side errors go through recordError()
    if (reportedCount >= MAX_REPORTS_PER_LOAD) return;
    const message = String(parts.message || "").slice(0, 1000);
    if (!message) return;
    if (isIgnored(message)) return;

    // First stack line that isn't the "Error: message" header is the throw
    // site — the stable part for dedupe (line numbers shift per build).
    const stackLines = (parts.stack || "").split("\n").filter((l) => l.trim());
    const throwSite = stackLines.find((l) => l.trim().startsWith("at ")) || stackLines[0] || "";
    const fp = clientFingerprint(message, throwSite);
    if (seenFingerprints.has(fp)) return;
    seenFingerprints.add(fp);
    reportedCount += 1;

    const mergedContext: Record<string, unknown> = { ...parts.extra };
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        try {
          mergedContext[k] = v instanceof Error ? v.message : v;
        } catch {
          // skip unserializable values
        }
      }
    }

    send({
      message,
      stack: parts.stack ? parts.stack.slice(0, 4000) : undefined,
      url: typeof window.location?.href === "string" ? window.location.href.slice(0, 500) : undefined,
      level,
      context: mergedContext,
    });
  } catch {
    // Never throw.
  }
}

/**
 * Report an error from application code (public API).
 *
 * Used by src/app/error.tsx + src/app/global-error.tsx (React render
 * errors with the Next.js digest + component stack) and available to any
 * code that catches an error worth recording.
 *
 * NEVER throws; safe to call from render paths and event handlers.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  report(extractErrorParts(err), "error", context);
}

// ── Task 40: window.fetch wrapper — 5xx API responses become reports ────────
//
// THE GAP this closes: every view in this codebase follows the pattern
//   const r = await fetch(api("/api/x")); if (!r.ok) { toast(...) }
// — the failed request is shown to the user and then FORGOTTEN. The
// reporter above only sees uncaught JS errors, so handled fetch failures
// (the majority of real production incidents, e.g. the tenant-delete 500s
// of 2026-09-06) never reached /api/client-errors.
//
// Wrapping window.fetch ONCE covers all 378 fetch call-sites without
// touching any of them:
//   • only same-origin /api/... URLs are inspected
//   • only status >= 500 counts (4xx are user errors, not app bugs)
//   • /api/client-errors itself is EXEMPT (a failing report POST must
//     never become another report — the loop this file exists to prevent)
//   • the ORIGINAL Response object is returned untouched — the body is
//     read from a clone (≤ 2 KB), so application code never notices
//   • dedupe + per-load cap + never-throw come from report() itself
//   • the reporter's own send() calls go through this wrapper too, but
//     its endpoint is exempt and its failures are swallowed in send()
let fetchPatched = false;

function patchFetchForApi5xx(): void {
  try {
    if (fetchPatched) return;
    if (typeof window === "undefined" || typeof window.fetch !== "function") return;
    fetchPatched = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const response = await originalFetch(input, init);

      try {
        // Cheap gate first: only 5xx proceed to the (heavier) URL check.
        if (response.status < 500) return response;

        // Resolve the request path (input may be a string, URL, Request).
        let path = "";
        try {
          if (typeof input === "string") path = input;
          else if (input instanceof URL) path = input.pathname;
          else if (input && typeof (input as Request).url === "string") {
            path = new URL((input as Request).url).pathname;
          }
        } catch {
          return response;
        }
        // Same-origin /api/ paths only — and never our own endpoint.
        if (!path.startsWith("/api/") || path === ENDPOINT) return response;

        const method =
          (init?.method || (input instanceof Request ? input.method : "GET") || "GET")
            .toString()
            .toUpperCase();

        // Best-effort real error message from the (cloned) body — routes
        // return { error: "..." }. Cap the read at 2 KB so a giant error
        // payload can't stall the page.
        let serverMessage: string | null = null;
        try {
          const clone = response.clone();
          const text = (await clone.text()).slice(0, 2048);
          try {
            const parsed = JSON.parse(text) as { error?: unknown };
            if (parsed && typeof parsed.error === "string" && parsed.error) {
              serverMessage = parsed.error;
            }
          } catch {
            // Non-JSON body — leave null.
          }
        } catch {
          // Body unreadable (stream already consumed elsewhere) — leave null.
        }

        report(
          {
            message: serverMessage || `${response.status} ${method} ${path}`,
            stack: null,
            extra: {},
          },
          "error",
          {
            type: "api_5xx",
            status: response.status,
            method,
            path,
          },
        );
      } catch {
        // The wrapper must never break the application's fetch.
      }

      return response;
    };
  } catch {
    // Never throw during patching.
  }
}

/**
 * Mounted once via <ErrorReporter /> in providers.tsx. Attaches the global
 * listeners and the unload beacon switch. Renders nothing.
 */
export function ErrorReporter(): null {
  useEffect(() => {
    function onWindowError(ev: ErrorEvent) {
      try {
        const parts = extractErrorParts(ev.error ?? ev.message);
        if (ev.filename || ev.lineno) {
          parts.extra.location = `${ev.filename || ""}:${ev.lineno || 0}:${ev.colno || 0}`;
        }
        report(parts, "error");
      } catch {
        // Never throw.
      }
    }

    function onUnhandledRejection(ev: PromiseRejectionEvent) {
      try {
        const parts = extractErrorParts(ev.reason);
        parts.extra.type = "unhandledrejection";
        report(parts, "error");
      } catch {
        // Never throw.
      }
    }

    function onPageHide() {
      try {
        isUnloading = true;
      } catch {
        // Never throw.
      }
    }

    window.addEventListener("error", onWindowError, true);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("pagehide", onPageHide);

    // Task 40 — the 5xx API-response capture (see patchFetchForApi5xx).
    patchFetchForApi5xx();

    return () => {
      try {
        window.removeEventListener("error", onWindowError, true);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
        window.removeEventListener("pagehide", onPageHide);
      } catch {
        // Never throw.
      }
    };
  }, []);

  return null;
}
