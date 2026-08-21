"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, MapPin } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";

interface HeatmapPoint {
  country: string;
  lat: number;
  lng: number;
  intensity: number;
  postCount: number;
  name: string;
  flag: string;
}

interface HeatmapResponse {
  points: HeatmapPoint[];
  sampleSize: number;
}

interface HeatmapPanelProps {
  category?: string;
  /** 'buy' | 'sell' | undefined (both). */
  type?: "buy" | "sell";
  days?: number;
}

/**
 * HeatmapPanel — world map with demand intensity bubbles, for the
 * market-intelligence dashboard.
 *
 * Calls GET /api/marketplace/intelligence/heatmap?category=... &type=... &days=...
 *
 * Renders a lightweight SVG world map (equirectangular projection) with
 * sized bubbles per country. The world map outline is intentionally
 * simplified — we only draw the continental land masses as background
 * rectangles so the bubbles pop against a recognizable canvas, without
 * the bundle cost of maplibre-gl + tile server.
 *
 * For each heatmap point:
 *   • bubble area ∝ intensity (0–100, relative to busiest country)
 *   • bubble colour scales green → amber → red as intensity rises
 *   • hover tooltip shows country name + post count
 */
export function HeatmapPanel({ category, type, days = 30 }: HeatmapPanelProps) {
  const t = useT();
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (type) params.set("type", type);
  params.set("days", String(days));
  const q = useQuery<HeatmapResponse>({
    queryKey: ["mkt-intel-heatmap", category ?? "", type ?? "", days],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/heatmap?${params}`,
      );
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <MapPin className="h-4 w-4" />
            {t("marketplace-intel-heatmap-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <MapPin className="h-4 w-4" />
            {t("marketplace-intel-heatmap-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-load-error")}
        </CardContent>
      </Card>
    );
  }

  const { points, sampleSize } = q.data;

  if (sampleSize === 0 || points.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <MapPin className="h-4 w-4" />
            {t("marketplace-intel-heatmap-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-no-data")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          <MapPin className="h-4 w-4" />
          {t("marketplace-intel-heatmap-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <WorldMap points={points} />
        <p className="text-xs text-muted-foreground text-center">
          {t("marketplace-intel-sample-size").replace("{n}", String(sampleSize))}{" "}
          · {t("marketplace-intel-heatmap-legend")}
        </p>
        <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            {t("marketplace-intel-heatmap-low")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            {t("marketplace-intel-heatmap-medium")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
            {t("marketplace-intel-heatmap-high")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── World map (SVG) ───────────────────────────────────────────────────────
//
// Equirectangular projection: x = (lng + 180) / 360 * W, y = (90 - lat) / 180 * H.
// The continental backdrop is a simplified approximation — a single
// rectangle for each major continent with the right bbox. This is enough
// to orient the viewer (the bubbles do the heavy lifting).

const MAP_W = 640;
const MAP_H = 320;

// Approximate continental bboxes in lng/lat so we draw something
// recognisable as a world map background. The values are deliberately
// coarse; the bubbles' coordinates are computed from the real
// lat/lng in the data.
const CONTINENTS: Array<{ lng: number; lat: number; w: number; h: number }> = [
  // North America
  { lng: -100, lat: 45, w: 120, h: 100 },
  // South America
  { lng: -60, lat: -20, w: 60, h: 110 },
  // Europe
  { lng: 15, lat: 50, w: 50, h: 40 },
  // Africa
  { lng: 20, lat: 0, w: 60, h: 110 },
  // Asia
  { lng: 90, lat: 45, w: 110, h: 80 },
  // Oceania
  { lng: 135, lat: -25, w: 50, h: 30 },
];

function project(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng + 180) / 360) * MAP_W;
  const y = ((90 - lat) / 180) * MAP_H;
  return { x, y };
}

function intensityColor(intensity: number): string {
  if (intensity >= 66) return "#f43f5e"; // rose-500
  if (intensity >= 33) return "#f59e0b"; // amber-500
  return "#10b981"; // emerald-500
}

function WorldMap({ points }: { points: HeatmapPoint[] }) {
  return (
    <div className="w-full overflow-hidden rounded-md border bg-muted/30">
      <svg
        width="100%"
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className="block"
        role="img"
        aria-label="World heatmap"
      >
        {/* Ocean background */}
        <rect x="0" y="0" width={MAP_W} height={MAP_H} fill="var(--background)" />

        {/* Continental backdrops */}
        {CONTINENTS.map((c, i) => {
          const p = project(c.lat, c.lng);
          // Convert lng-span → x-span and lat-span → y-span
          const xSpan = (c.w / 360) * MAP_W;
          const ySpan = (c.h / 180) * MAP_H;
          return (
            <rect
              key={i}
              x={p.x - xSpan / 2}
              y={p.y - ySpan / 2}
              width={xSpan}
              height={ySpan}
              rx="6"
              fill="var(--muted)"
              fillOpacity="0.45"
              stroke="var(--border)"
              strokeOpacity="0.5"
            />
          );
        })}

        {/* Latitude gridlines (every 30°) */}
        {[60, 30, 0, -30, -60].map((lat) => {
          const { y } = project(lat, 0);
          return (
            <line
              key={`lat-${lat}`}
              x1="0"
              y1={y}
              x2={MAP_W}
              y2={y}
              stroke="var(--border)"
              strokeOpacity="0.3"
              strokeDasharray="2 2"
            />
          );
        })}

        {/* Demand bubbles — area ∝ intensity, color by band */}
        {points.map((p) => {
          const { x, y } = project(p.lat, p.lng);
          // bubble radius: 4 + (intensity/100) * 16 → 4–20
          const r = 4 + (p.intensity / 100) * 16;
          const color = intensityColor(p.intensity);
          return (
            <g key={p.country}>
              <circle
                cx={x}
                cy={y}
                r={r}
                fill={color}
                fillOpacity="0.55"
                stroke={color}
                strokeWidth="1"
              />
              <title>{`${p.flag} ${p.name}: ${p.postCount} posts (${p.intensity}% intensity)`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
