"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ─── TableScroll ─────────────────────────────────────────────────────── */
/**
 * Shared horizontal-scroll wrapper for wide data tables.
 *
 * Why: on mobile (≤ sm) the wide tables (partners, invoices, offers…) clip
 * their rightmost columns with no visual affordance that the table scrolls
 * horizontally (audit 4-d + E2E finding D3 — 390px viewport).
 *
 * What it adds over a bare `overflow-x-auto` div:
 * - `role="region"` + `aria-label` so screen readers announce a named
 *   scrollable region.
 * - A subtle right-edge gradient hint that fades the table's right edge,
 *   signalling more content to the left. The hint is mobile-only
 *   (`md:hidden`) — at md+ widths these tables fit and desktop users get
 *   real scrollbars. It is `pointer-events-none` so the last column stays
 *   clickable through it.
 *
 * NOTE (migration): only the 3 highest-traffic tables (partners-view,
 * invoices-view, offers-view) currently use this wrapper. The remaining
 * ~57 views keep their plain `overflow-x-auto` divs — migrate them
 * opportunistically when each view is next touched.
 */
export function TableScroll({
  children,
  label,
  className,
}: {
  children: ReactNode;
  /** Accessible name for the scrollable region (e.g. t("crm-partners")). */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn("relative w-full overflow-x-auto custom-scroll", className)}
    >
      {children}
      {/* Right-edge scroll hint — mobile only, purely decorative. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 md:hidden bg-gradient-to-l from-card to-transparent"
      />
    </div>
  );
}
