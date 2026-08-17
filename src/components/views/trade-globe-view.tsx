"use client";
import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Ship,
  Truck,
  Loader2,
  Globe as GlobeIcon,
  MapPin,
  Anchor,
  Info,
  Clock,
  Route as RouteIcon,
  Flag,
  DollarSign,
  AlertCircle,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";

// MapLibre auto-detects its worker script URL from `import.meta.url` of its
// own module. Under Turbopack/webpack that module is bundled into a hashed
// chunk, so the auto-detected URL 404s — the module worker then never
// initializes, and every GeoJSON-backed source (route lines, basemap fills)
// hangs forever with no error surfaced to the main thread. Pointing MapLibre
// at our own statically-served copy of the worker script sidesteps this.
if (typeof window !== "undefined") {
  maplibregl.setWorkerUrl("/map/maplibre-gl-worker.mjs");
}

/* -------------------------------------------------------------------------- */
/*  Types (mirror src/lib/logistics/route-plan.ts)                            */
/* -------------------------------------------------------------------------- */

interface RouteLeg {
  kind: "road" | "sea";
  fromLabel: string;
  toLabel: string;
  fromCoords: [number, number];
  toCoords: [number, number];
  geometry: [number, number][];
  distanceKm: number;
  durationHours: number;
  approximate: boolean;
}

interface BorderCrossing {
  fromCountry: string;
  toCountry: string;
  at: [number, number];
  distanceKm: number;
}

interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: string;
}

interface RoutePlan {
  origin: { label: string; coords: [number, number] };
  destination: { label: string; coords: [number, number] };
  originPort: { label: string; coords: [number, number] };
  destinationPort: { label: string; coords: [number, number] };
  legs: RouteLeg[];
  intermediateWaypoints: Waypoint[];
  borderCrossings: BorderCrossing[];
  totals: {
    distanceKm: number;
    transitHours: number;
    dwellHours: number;
    totalHours: number;
    totalDays: number;
  };
  estimatedCost: {
    roadUsd: number;
    seaUsd: number;
    customsUsd: number;
    totalUsd: number;
    disclaimer: string;
  };
}

interface LogisticsRequest {
  id: string;
  number: string;
  status: string;
  mode?: string;
  origin_port?: string | null;
  origin_city?: string | null;
  origin_country?: string | null;
  destination_port?: string | null;
  destination_city?: string | null;
  destination_country?: string | null;
  cargo_description?: string | null;
  [key: string]: any;
}

// Self-hosted basemap — no external tile service. `demotiles.maplibre.org`
// is explicitly a demo/dev endpoint (unreliable under production load, and
// a single point of failure behind CSP/network policy). Countries are
// served from our own static asset instead, so the map never depends on
// any third-party domain being reachable.
const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    countries: { type: "geojson", data: "/map/countries-110m.geojson" },
  },
  layers: [
    { id: "ocean", type: "background", paint: { "background-color": "#0a0e1a" } },
    { id: "land", type: "fill", source: "countries", paint: { "fill-color": "#1a2138" } },
    { id: "land-outline", type: "line", source: "countries", paint: { "line-color": "#334155", "line-width": 0.6 } },
  ],
};
const ROAD_COLOR = "#f59e0b";
const SEA_COLOR = "#3b82f6";

function statusVariant(status: string): "default" | "secondary" | "outline" {
  const s = (status || "").toLowerCase();
  if (s === "delivered" || s === "completed") return "default";
  if (s === "pending" || s === "quoted") return "outline";
  return "secondary";
}

function fmtHours(h: number): string {
  if (h < 24) return `${Math.round(h)}h`;
  const days = Math.floor(h / 24);
  const rem = Math.round(h % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

/* -------------------------------------------------------------------------- */
/*  Map component                                                             */
/* -------------------------------------------------------------------------- */

function RouteMap({ plan, loading, locale }: { plan: RoutePlan | null; loading: boolean; locale: import("@/lib/i18n/dictionaries").Locale }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const markersRef = React.useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = React.useState(false);
  const readyRef = React.useRef(false);
  const [mapError, setMapError] = React.useState(false);
  const [retryKey, setRetryKey] = React.useState(0);

  React.useEffect(() => {
    if (!containerRef.current) return;
    setMapError(false);
    readyRef.current = false;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [15, 30],
      zoom: 1.4,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      readyRef.current = true;
      setReady(true);
    });
    map.on("error", (e: any) => {
      // A failed basemap/tile fetch (offline, blocked domain, outage) — don't
      // leave the user staring at a blank canvas, surface it with a retry.
      if (!readyRef.current) setMapError(true);
      // eslint-disable-next-line no-console
      console.error("MapLibre error:", e?.error?.message || e);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [retryKey]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // Clear old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // Clear old layers/sources
    for (const id of ["route-road", "route-sea", "route-sea-outline"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource("route")) map.removeSource("route");

    if (!plan) return;

    const roadFeatures = plan.legs
      .filter((l) => l.kind === "road")
      .map((l) => ({
        type: "Feature" as const,
        properties: { kind: l.kind },
        geometry: { type: "LineString" as const, coordinates: l.geometry },
      }));
    const seaFeatures = plan.legs
      .filter((l) => l.kind === "sea")
      .map((l) => ({
        type: "Feature" as const,
        properties: { kind: l.kind },
        geometry: { type: "LineString" as const, coordinates: l.geometry },
      }));

    map.addSource("route", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [...roadFeatures, ...seaFeatures] },
    });
    map.addLayer({
      id: "route-sea",
      type: "line",
      source: "route",
      filter: ["==", ["get", "kind"], "sea"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": SEA_COLOR, "line-width": 2.5, "line-dasharray": [0.2, 1.6] },
    });
    map.addLayer({
      id: "route-road",
      type: "line",
      source: "route",
      filter: ["==", ["get", "kind"], "road"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ROAD_COLOR, "line-width": 3 },
    });

    // Markers
    const addMarker = (
      lngLat: [number, number],
      color: string,
      label: string,
      size = 10,
    ) => {
      const el = document.createElement("div");
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderRadius = "50%";
      el.style.background = color;
      el.style.border = "2px solid white";
      el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.4)";
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .setPopup(new maplibregl.Popup({ offset: 8 }).setText(label))
        .addTo(map);
      markersRef.current.push(marker);
    };

    addMarker(plan.origin.coords, "#10b981", `${t(locale, "log-origin")}: ${plan.origin.label}`, 12);
    addMarker(plan.originPort.coords, "#0ea5e9", `${t(locale, "log-legend-port")}: ${plan.originPort.label}`, 9);
    for (const wp of plan.intermediateWaypoints) {
      addMarker([wp.lng, wp.lat], "#8b5cf6", wp.name, 7);
    }
    addMarker(plan.destinationPort.coords, "#0ea5e9", `${t(locale, "log-legend-port")}: ${plan.destinationPort.label}`, 9);
    addMarker(plan.destination.coords, "#ef4444", `${t(locale, "log-legend-destination")}: ${plan.destination.label}`, 12);
    for (const b of plan.borderCrossings) {
      addMarker(b.at, "#f59e0b", `${t(locale, "log-marker-border")}: ${b.fromCountry} → ${b.toCountry}`, 6);
    }

    // Fit bounds to the whole route
    const bounds = new maplibregl.LngLatBounds();
    for (const l of plan.legs) {
      for (const c of l.geometry) bounds.extend(c as [number, number]);
    }
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 600 });
    }
  }, [plan, ready, locale]);

  return (
    <div className="absolute inset-0 rounded-2xl overflow-hidden">
      {/* Separate div for MapLibre to mount into — its stylesheet sets
          `.maplibregl-map { position: relative }` on whatever element it's
          given, and a stylesheet rule always wins over a Tailwind utility
          class of equal specificity regardless of nesting. Using an inline
          style here (not a class) is immune to that cascade fight and keeps
          the element correctly absolutely positioned + full-height. */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {mapError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-slate-950 gap-2 px-6 text-center">
          <AlertCircle className="size-6 text-amber-400" />
          <p className="text-sm text-slate-200">{t(locale, "log-map-load-failed")}</p>
          <p className="text-xs text-slate-400">{t(locale, "log-map-load-failed-hint")}</p>
          <Button size="sm" variant="secondary" className="mt-1" onClick={() => setRetryKey((k) => k + 1)}>
            {t(locale, "log-retry")}
          </Button>
        </div>
      ) : (!ready || loading) ? (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-slate-950/40 pointer-events-none">
          <Loader2 className="size-8 animate-spin text-white" />
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export function TradeGlobeView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);
  const [selectedRequest, setSelectedRequest] = React.useState<LogisticsRequest | null>(null);

  const { data, isLoading: listLoading } = useQuery({
    queryKey: ["logistics-globe", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/logistics-requests", { limit: 100 }));
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });
  const requests: LogisticsRequest[] = data?.items || data || [];

  const routePlanMutation = useMutation({
    mutationFn: async (body: { requestId: string } | { origin: { addressLine: string }; destination: { addressLine: string } }) => {
      const r = await fetch(api("/api/logistics/route-plan"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || t(locale, "log-route-build-failed"));
      return json.plan as RoutePlan;
    },
  });

  function selectRequest(req: LogisticsRequest) {
    setSelectedRequest(req);
    routePlanMutation.mutate({ requestId: req.id });
  }

  const [manualOrigin, setManualOrigin] = React.useState("");
  const [manualDest, setManualDest] = React.useState("");
  function plotManualRoute() {
    if (!manualOrigin.trim() || !manualDest.trim()) return;
    setSelectedRequest({ id: "__manual__", number: "Manual test", status: "pending" });
    routePlanMutation.mutate({
      origin: { addressLine: manualOrigin.trim() },
      destination: { addressLine: manualDest.trim() },
    });
  }

  const plan = routePlanMutation.data || null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <GlobeIcon className="size-5" /> Trade Globe
          </h2>
          <p className="text-sm text-muted-foreground">
            Real door-to-door route: road to the nearest port, real maritime
            path through canals/straits, road to the final address —
            geocoded from the actual request, not straight lines.
          </p>
        </div>
        <Badge variant="outline">{requests.length} requests</Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Request list */}
        <Card className="lg:col-span-1 lg:order-1 order-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <RouteIcon className="size-4" /> Logistics requests
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="px-4 pb-3 space-y-2 border-b border-border/60">
              <p className="text-[11px] font-semibold uppercase text-muted-foreground">Or test any address pair</p>
              <Input
                placeholder="Origin address"
                value={manualOrigin}
                onChange={(e) => setManualOrigin(e.target.value)}
                className="h-8 text-xs"
              />
              <Input
                placeholder="Destination address"
                value={manualDest}
                onChange={(e) => setManualDest(e.target.value)}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                className="w-full h-7 text-xs"
                disabled={!manualOrigin.trim() || !manualDest.trim() || routePlanMutation.isPending}
                onClick={plotManualRoute}
              >
                <Search className="size-3 mr-1" /> Plot route
              </Button>
            </div>
            <ScrollArea className="h-[280px] lg:h-[490px]">
              {listLoading ? (
                <div className="p-6 flex justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : requests.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground text-sm">
                  No logistics requests yet.
                </div>
              ) : (
                <ul className="divide-y divide-border/50">
                  {requests.map((req) => (
                    <li key={req.id}>
                      <button
                        type="button"
                        onClick={() => selectRequest(req)}
                        className={cn(
                          "w-full text-left px-4 py-3 hover:bg-accent/50 smooth",
                          selectedRequest?.id === req.id && "bg-accent/60",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-semibold">{req.number}</span>
                          <Badge variant={statusVariant(req.status)} className="text-[10px]">
                            {req.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {(req.origin_city || req.origin_port || "—")} → {(req.destination_city || req.destination_port || "—")}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Map */}
        <div className="lg:col-span-2 lg:order-2 order-1 relative rounded-2xl overflow-hidden bg-slate-950 border border-white/5" style={{ height: 600 }}>
          {!selectedRequest ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 gap-2 px-6 text-center">
              <RouteIcon className="size-8 opacity-50" />
              <p className="text-sm">Select a logistics request to plot its real route</p>
            </div>
          ) : (
            <RouteMap plan={plan} loading={routePlanMutation.isPending} locale={locale} />
          )}
          {routePlanMutation.isError && (
            <div className="absolute inset-x-3 top-3 z-10">
              <div className="flex items-center gap-2 rounded-lg bg-destructive/90 text-destructive-foreground text-xs px-3 py-2">
                <AlertCircle className="size-3.5 shrink-0" />
                {(routePlanMutation.error as Error)?.message || "Could not compute route"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Route details panel — only once a plan is loaded */}
      {plan && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Ship className="size-4" /> Route summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Origin</span>
                <span className="text-right truncate ml-2 max-w-[60%]">{plan.origin.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Origin port</span>
                <span>{plan.originPort.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Destination port</span>
                <span>{plan.destinationPort.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Destination</span>
                <span className="text-right truncate ml-2 max-w-[60%]">{plan.destination.label}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total distance</span>
                <span className="font-mono">{plan.totals.distanceKm.toLocaleString()} km</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground flex items-center gap-1"><Clock className="size-3" /> Transit</span>
                <span className="font-mono">{fmtHours(plan.totals.transitHours)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Dwell (ports + borders)</span>
                <span className="font-mono">{fmtHours(plan.totals.dwellHours)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Total time</span>
                <span className="font-mono">{plan.totals.totalDays}d</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Truck className="size-4" /> Legs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm max-h-56 overflow-y-auto custom-scroll">
              {plan.legs.map((leg, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {leg.kind === "road" ? (
                    <Truck className="size-3.5 mt-0.5 shrink-0" style={{ color: ROAD_COLOR }} />
                  ) : (
                    <Ship className="size-3.5 mt-0.5 shrink-0" style={{ color: SEA_COLOR }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{leg.fromLabel} → {leg.toLabel}</p>
                    <p className="text-muted-foreground">
                      {Math.round(leg.distanceKm).toLocaleString()} km · {fmtHours(leg.durationHours)}
                      {leg.approximate && " · est."}
                    </p>
                  </div>
                </div>
              ))}
              {plan.intermediateWaypoints.length > 0 && (
                <>
                  <Separator className="my-2" />
                  <p className="text-muted-foreground text-[11px] uppercase font-semibold">Via</p>
                  <div className="flex flex-wrap gap-1">
                    {plan.intermediateWaypoints.map((w) => (
                      <Badge key={w.id} variant="outline" className="text-[10px]">{w.name}</Badge>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <DollarSign className="size-4" /> Estimated cost
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Road</span>
                <span className="font-mono">${plan.estimatedCost.roadUsd.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sea freight</span>
                <span className="font-mono">${plan.estimatedCost.seaUsd.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Customs / borders</span>
                <span className="font-mono">${plan.estimatedCost.customsUsd.toLocaleString()}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-medium">
                <span>Total (indicative)</span>
                <span className="font-mono">${plan.estimatedCost.totalUsd.toLocaleString()}</span>
              </div>
              <p className="text-[11px] text-muted-foreground pt-1 flex items-start gap-1">
                <Info className="size-3 shrink-0 mt-0.5" /> {plan.estimatedCost.disclaimer}
              </p>

              {plan.borderCrossings.length > 0 && (
                <>
                  <Separator />
                  <p className="text-muted-foreground text-[11px] uppercase font-semibold flex items-center gap-1">
                    <Flag className="size-3" /> Border crossings
                  </p>
                  <div className="space-y-1">
                    {plan.borderCrossings.map((b, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span>{b.fromCountry} → {b.toCountry}</span>
                        <span className="text-muted-foreground font-mono">{b.distanceKm} km</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Legend */}
      <Card>
        <CardContent className="p-4 flex flex-wrap gap-x-6 gap-y-2">
          <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1 w-full sm:w-auto">
            <Info className="size-3" /> Legend
          </p>
          <div className="flex items-center gap-2 text-xs"><div className="w-3 h-0.5" style={{ background: ROAD_COLOR }} /> Road</div>
          <div className="flex items-center gap-2 text-xs"><div className="w-3 h-0.5" style={{ background: SEA_COLOR }} /> Sea</div>
          <div className="flex items-center gap-2 text-xs"><div className="size-2 rounded-full bg-emerald-500" /> Origin</div>
          <div className="flex items-center gap-2 text-xs"><div className="size-2 rounded-full bg-red-500" /> Destination</div>
          <div className="flex items-center gap-2 text-xs"><div className="size-2 rounded-full bg-sky-500" /> Port</div>
          <div className="flex items-center gap-2 text-xs"><div className="size-2 rounded-full bg-violet-500" /> Canal / strait / cape</div>
          <div className="flex items-center gap-2 text-xs"><div className="size-2 rounded-full bg-amber-500" /> Border crossing</div>
        </CardContent>
      </Card>

      {requests.length === 0 && !listLoading && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground space-y-2">
            <Anchor className="size-8 mx-auto opacity-50" />
            <p className="text-sm font-medium text-foreground">No routes yet</p>
            <p className="text-xs">
              Create logistics requests with origin and destination addresses
              to see their real routes plotted here.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
