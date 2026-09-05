import { redirect } from "next/navigation";
import AppEntry from "@/components/auth/app-entry";

// Force dynamic rendering — prevents Vercel from caching any auth-screen
// HTML (the /app/* deep links render the same session-gated surface as "/").
export const dynamic = "force-dynamic";

/**
 * Catch-all route — serves the SPA shell for admin paths.
 *
 * The VELOS platform is a single-page application: all admin views
 * (dashboard, products, offers, invoices, etc.) are rendered client-side
 * through the Zustand app-store's `view` state. URLs under /app/* are the
 * admin SPA's real address space (audit 4-d P1-1):
 *
 *   /app/<viewKey>          → that view (e.g. /app/partners, /app/offers)
 *   /app/<viewKey>?id=<uuid>→ drill-down views (e.g. /app/partner-360?id=…)
 *
 * This server component renders the shared auth gate (AppEntry) for every
 * /app/* path so a deep link cold-boots the SPA at the intended view:
 * logged out, the login form renders at the deep-linked URL; once the
 * session resolves, <AppShell/> mounts and `applyViewFromUrl()` adopts the
 * view from the URL. Unknown view keys are handled client-side (fallback to
 * "dashboard" + history.replaceState canonicalisation) — no server-side
 * allow-list is needed because the store's isViewKey guard runs before any
 * view is applied.
 *
 * Every other unmatched path (e.g. legacy /dashboard, /products links)
 * still redirects to "/" as before — the SPA then restores its view from
 * sessionStorage. Portal routes (/portal/*), API routes (/api/*),
 * /api-docs, /offline, and /verify/[code] have their own real Next.js
 * routes and are matched first by the Next.js router — this catch-all only
 * handles unmatched paths.
 */
export default async function CatchAllPage({
  params,
}: {
  params: Promise<{ catchAll: string[] }>;
}) {
  // Next.js 16: params is a Promise in async components — `await` is the
  // safe pattern (awaiting a plain object would also just resolve to it).
  const { catchAll } = await params;
  const path = "/" + (catchAll ?? []).join("/");
  if (path.startsWith("/app/")) {
    return <AppEntry />;
  }
  redirect("/");
}
