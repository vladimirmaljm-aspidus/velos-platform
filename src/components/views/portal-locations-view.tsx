"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MapPin,
  Globe,
  Clock,
  ExternalLink,
  User,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/common/page-header";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { fmtDate, fmtRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";

/* ────────────────────────────────────────────────────────────────────────
   Types — mirror what the /api/portal-access/locations endpoint returns.
   Kept loose (any) on the response because the data crosses a network
   boundary and we don't want a strict contract to block rendering.
   ──────────────────────────────────────────────────────────────────────── */

interface PortalLocation {
  portal_access_id: string;
  email: string | null;
  partner_id: string;
  ip: string | null;
  country: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  last_login_at: string | null;
  status: string;
  tier: string;
  source: "gps" | "ip" | "unknown";
}

interface PortalLoginHistoryEntry {
  username: string;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  success: boolean;
  created_at: string;
}

interface LocationsResponse {
  locations: PortalLocation[];
  login_history: PortalLoginHistoryEntry[];
  portal_logins: Array<{
    details: Record<string, unknown> | null;
    created_at: string;
    ip: string | null;
    user_agent: string | null;
  }>;
}

/* ────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────── */

function googleMapsHref(lat?: number | null, lng?: number | null, ip?: string | null): string | null {
  if (typeof lat === "number" && typeof lng === "number") {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  if (ip && ip !== "unknown" && ip !== "127.0.0.1" && ip !== "::1") {
    // No coordinates → fall back to an IP lookup service. Google Maps doesn't
    // resolve raw IPs well, but ipinfo.io shows the IP on a map.
    return `https://ipinfo.io/${encodeURIComponent(ip)}`;
  }
  return null;
}

function parseUa(ua: string | null): string {
  if (!ua) return "—";
  const lower = ua.toLowerCase();
  if (lower.includes("iphone") || lower.includes("android")) return "Mobile";
  if (lower.includes("mac")) return "macOS";
  if (lower.includes("windows")) return "Windows";
  if (lower.includes("linux")) return "Linux";
  return "Web";
}

function statusBadge(status: string) {
  const variant =
    status === "active"
      ? "default"
      : status === "suspended" || status === "revoked"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant as any}>{status}</Badge>;
}

function sourceBadge(source: PortalLocation["source"]) {
  if (source === "gps") return <Badge variant="default" className="text-[10px]">GPS</Badge>;
  if (source === "ip") return <Badge variant="secondary" className="text-[10px]">IP</Badge>;
  return <Badge variant="outline" className="text-[10px]">Unknown</Badge>;
}

/* ────────────────────────────────────────────────────────────────────────
   Main component
   ──────────────────────────────────────────────────────────────────────── */

export function PortalLocationsView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const { data, isLoading, isFetching, refetch, error } = useQuery<LocationsResponse>({
    queryKey: ["portal-locations", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/portal-access/locations"));
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to load locations (${r.status})`);
      }
      return r.json() as Promise<LocationsResponse>;
    },
  });

  const locations = data?.locations ?? [];
  const loginHistory = data?.login_history ?? [];
  const portalLogins = data?.portal_logins ?? [];

  const withCoords = locations.filter(
    (l) => typeof l.latitude === "number" && typeof l.longitude === "number"
  ).length;
  const withGps = locations.filter((l) => l.source === "gps").length;
  const failedLogins = loginHistory.filter((h) => !h.success).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("portal-locations")}
        description={t("portal-loc-desc")}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className={cn("size-3.5 mr-1", isFetching && "animate-spin")} />
            {t("refresh")}
          </Button>
        }
      />

      {/* ── Stat tiles ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label={t("portal-loc-stat-tracked")} value={locations.length} />
        <StatTile label={t("portal-loc-stat-gps")} value={withGps} />
        <StatTile label={t("portal-loc-stat-ip")} value={withCoords - withGps} />
        <StatTile label={t("portal-loc-stat-failed")} value={failedLogins} alert={failedLogins > 0} />
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 flex items-start gap-3">
            <ShieldAlert className="size-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive">{t("portal-loc-load-failed")}</p>
              <p className="text-xs text-muted-foreground mt-1">{(error as Error).message}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Last known locations ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="size-4 text-primary" /> {t("portal-loc-last-known-title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("portal-loc-last-known-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">{t("portal-loading-dots")}</div>
          ) : locations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {t("portal-loc-empty")}
            </div>
          ) : (
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("portal-loc-col-user")}</TableHead>
                    <TableHead>{t("portal-loc-col-ip")}</TableHead>
                    <TableHead>{t("portal-loc-col-country")}</TableHead>
                    <TableHead>{t("portal-loc-col-city")}</TableHead>
                    <TableHead>{t("portal-loc-col-coords")}</TableHead>
                    <TableHead>{t("portal-last-login")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead className="text-right">{t("portal-loc-col-map")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locations.map((loc) => {
                    const href = googleMapsHref(loc.latitude, loc.longitude, loc.ip);
                    return (
                      <TableRow key={loc.portal_access_id}>
                        <TableCell>
                          <div className="flex items-center gap-2 min-w-0">
                            <User className="size-4 text-muted-foreground shrink-0" />
                            <div className="min-w-0">
                              <p className="font-medium truncate">{loc.email || "—"}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {t("portal-loc-tier-prefix")} {loc.tier}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {loc.ip || "—"}
                        </TableCell>
                        <TableCell>
                          {loc.country ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Globe className="size-3.5 text-muted-foreground" />
                              {loc.country}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>{loc.city || "—"}</TableCell>
                        <TableCell>
                          {typeof loc.latitude === "number" && typeof loc.longitude === "number" ? (
                            <span className="text-xs font-mono inline-flex items-center gap-1">
                              {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                              {sourceBadge(loc.source)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                              — {sourceBadge(loc.source)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs" title={loc.last_login_at || ""}>
                          {loc.last_login_at ? fmtRelative(loc.last_login_at) : "—"}
                        </TableCell>
                        <TableCell>{statusBadge(loc.status)}</TableCell>
                        <TableCell className="text-right">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline px-1 py-0.5 rounded hover:bg-primary/10"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink className="size-3" /> {t("portal-loc-open")}
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Portal login history ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="size-4 text-primary" /> {t("log-portal-login-history")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("log-portal-login-history-desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">{t("portal-loading-dots")}</div>
          ) : loginHistory.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {t("portal-loc-history-empty")}
            </div>
          ) : (
            <ScrollArea className="max-h-96">
              <div className="border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("portal-loc-col-email-username")}</TableHead>
                      <TableHead>{t("portal-loc-col-ip-short")}</TableHead>
                      <TableHead>{t("portal-loc-col-country")}</TableHead>
                      <TableHead>{t("portal-loc-col-device")}</TableHead>
                      <TableHead>{t("portal-loc-col-result")}</TableHead>
                      <TableHead>{t("portal-loc-col-time")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loginHistory.map((h, i) => {
                      const href = googleMapsHref(null, null, h.ip);
                      return (
                        <TableRow key={`${h.username}-${h.created_at}-${i}`}>
                          <TableCell className="font-medium">{h.username}</TableCell>
                          <TableCell className="font-mono text-xs">
                            <span className="inline-flex items-center gap-1">
                              {h.ip || "—"}
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                  title={t("portal-loc-lookup-ip")}
                                >
                                  <ExternalLink className="size-3" />
                                </a>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell>{h.country || "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                            {parseUa(h.user_agent)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={h.success ? "default" : "destructive"}>
                              {h.success ? t("success") : t("failed")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs" title={h.created_at}>
                            {fmtDate(h.created_at)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* ── Raw portal login audit entries ─────────────────────────────── */}
      {portalLogins.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="size-4 text-primary" /> {t("log-portal-login-audit")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("log-portal-login-audit-desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <ScrollArea className="max-h-72">
              <div className="border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("portal-loc-col-ip-short")}</TableHead>
                      <TableHead>{t("portal-loc-col-device")}</TableHead>
                      <TableHead>{t("portal-loc-col-details")}</TableHead>
                      <TableHead>{t("portal-loc-col-when")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {portalLogins.map((p, i) => {
                      const href = googleMapsHref(null, null, p.ip);
                      const details = p.details || {};
                      const detailStr = Object.entries(details)
                        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                        .join(", ");
                      return (
                        <TableRow key={`pa-${i}`}>
                          <TableCell className="font-mono text-xs">
                            <span className="inline-flex items-center gap-1">
                              {p.ip || "—"}
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  <ExternalLink className="size-3" />
                                </a>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                            {parseUa(p.user_agent)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[400px] truncate">
                            {detailStr || "—"}
                          </TableCell>
                          <TableCell className="text-xs" title={p.created_at}>
                            {fmtRelative(p.created_at)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Small presentational helper used by the stat tiles at the top.
   ──────────────────────────────────────────────────────────────────────── */

function StatTile({
  label,
  value,
  alert,
}: {
  label: string;
  value: number;
  alert?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3 bg-card",
        alert && value > 0 && "border-destructive/40 bg-destructive/5"
      )}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "text-xl font-bold tabular mt-0.5",
          alert && value > 0 && "text-destructive"
        )}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}
