import { redirect } from "next/navigation";

/**
 * Catch-all route — serves the SPA shell for all admin paths.
 *
 * The VELOS platform is a single-page application: all admin views
 * (dashboard, products, offers, invoices, etc.) are rendered client-side
 * through the Zustand app-store's `view` state, not through Next.js routes.
 *
 * Without this catch-all, direct navigation to /dashboard, /products, /offers,
 * etc. (via browser back/forward, refresh, or shared link) would 404.
 * This route redirects to / so the SPA shell loads and the client-side router
 * can restore the intended view from sessionStorage.
 *
 * Portal routes (/portal/*), API routes (/api/*), /api-docs, /offline, and
 * /verify/[code] have their own real Next.js routes and are matched first
 * by the Next.js router — this catch-all only handles unmatched paths.
 */

export default function CatchAllPage() {
  redirect("/");
}
