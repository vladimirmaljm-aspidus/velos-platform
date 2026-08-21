"use client";

import * as React from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Renders a small Google Maps link. Prefers exact lat/lng coordinates when
 * available, falls back to an IP-based lookup (opens ipinfo which shows the
 * IP on a map), and finally to a free-text address search.
 *
 * Used in admin views next to any recorded IP or location so operators can
 * jump straight to the map to inspect where a login / RFQ came from.
 */
export function MapLink({
  lat,
  lng,
  ip,
  address,
  label,
  className,
}: {
  lat?: number | null;
  lng?: number | null;
  ip?: string | null;
  address?: string | null;
  label?: string;
  className?: string;
}) {
  let href: string | null = null;
  let title = "Open on Google Maps";

  if (typeof lat === "number" && typeof lng === "number") {
    href = `https://www.google.com/maps?q=${lat},${lng}`;
    title = `Open ${lat.toFixed(5)}, ${lng.toFixed(5)} on Google Maps`;
  } else if (address && address.trim()) {
    href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    title = `Search "${address}" on Google Maps`;
  } else if (ip && ip !== "unknown" && ip !== "127.0.0.1" && ip !== "::1") {
    href = `https://ipinfo.io/${encodeURIComponent(ip)}`;
    title = `Look up ${ip} on ipinfo.io`;
  }

  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(
        "inline-flex items-center gap-1 text-xs text-primary hover:underline",
        "px-1 py-0.5 rounded hover:bg-primary/10 smooth",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <MapPin className="size-3" />
      {label ?? "Map"}
    </a>
  );
}
