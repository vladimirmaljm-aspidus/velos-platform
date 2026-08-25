/**
 * Root route-level Loading Skeleton (FIX-NOTIF-A11Y).
 *
 * Shown by Next.js App Router during route segment transitions while
 * the new segment's JS chunk is loading / SSR is rendering. Without
 * this, the user sees the previous page frozen in place until the
 * new one is ready (the platform audit called this out: "No
 * loading.tsx anywhere; users see the previous page until the new
 * one hydrates").
 *
 * This is a server component (no "use client") so it can render
 * during the transition without waiting for hydration. The skeleton
 * is intentionally generic — most views have their own internal
 * loading states (React Query's `isLoading`) that take over once the
 * chunk loads and the page mounts.
 */
import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="min-h-[60vh] flex flex-col items-center justify-center gap-3 p-4 text-muted-foreground"
    >
      <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
      <span className="text-sm">Loading…</span>
    </div>
  );
}
