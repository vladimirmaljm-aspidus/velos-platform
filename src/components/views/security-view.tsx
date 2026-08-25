"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Shield, ShieldCheck, ShieldAlert, History, Network, Laptop,
  Lock, Trash2, Ban, Globe2, Monitor, CheckCircle2, XCircle, Smartphone, LogOut,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState } from "@/components/common/empty-state";
import { fmtDateTime, fmtRelative } from "@/lib/utils/format";
import { useAppStore, isAdmin } from "@/lib/store/app-store";
import { MapLink } from "@/components/common/map-link";
import type {
  SecuritySession, LoginHistoryEntry, KnownIp, TrustedDevice,
} from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

function AdminRequired() {
  const t = useT();
  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
      <CardContent className="p-6 flex items-start gap-3">
        <Lock className="size-5 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-access-required")}</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t("admin-security-admin-only-desc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function parseUa(ua: string | null): { icon: typeof Monitor; label: string } {
  if (!ua) return { icon: Globe2, label: "Unknown" };
  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone")) {
    return { icon: Smartphone, label: "Mobile" };
  }
  if (lower.includes("mac")) return { icon: Monitor, label: "macOS" };
  if (lower.includes("windows")) return { icon: Monitor, label: "Windows" };
  if (lower.includes("linux")) return { icon: Monitor, label: "Linux" };
  return { icon: Globe2, label: "Web" };
}

export function SecurityView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  const admin = isAdmin(user);
  const isSuperAdminUser = !!user && user.role === "super_admin";

  // ── Plan gate — TRIAL tenants do NOT get the security center. ─────────
  // The security center exposes session revocation, login history (IP +
  // user-agent), trusted-device / known-IP allow-listing — powerful
  // surfaces that a trial tenant shouldn't configure. The sidebar
  // ALREADY hides this item via the `module_security` feature flag
  // (default false for every new tenant) AND the
  // `/api/security/*` routes enforce the flag server-side via
  // `requireFeature(..., "module_security", isSA)` — this is the in-view
  // defense for the direct-URL navigation case so a trial admin sees a
  // clean "upgrade your plan" card instead of a fetch error. Mirrors the
  // `planAllowed` gate on api-keys-view.tsx, webhooks-view.tsx, and
  // vault-view.tsx.
  const subQ = useQuery({
    queryKey: ["subscription-status-security"],
    queryFn: async () => {
      const r = await fetch("/api/subscription/status");
      if (!r.ok) return null;
      return r.json() as Promise<{
        subscription: { is_trial?: boolean } | null;
      }>;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const isTrial = !!subQ.data?.subscription?.is_trial;
  const planAllowed = isSuperAdminUser || !isTrial;

  const [tab, setTab] = useState("sessions");

  const sessionsQ = useQuery({
    queryKey: ["security", tenantKey, "sessions"],
    queryFn: async () => {
      const r = await fetch(api("/api/security/sessions"));
      if (!r.ok) throw new Error("Failed to load sessions");
      return r.json() as Promise<{ items: SecuritySession[] }>;
    },
    enabled: admin && planAllowed,
  });
  const loginQ = useQuery({
    queryKey: ["security", tenantKey, "login-history"],
    queryFn: async () => {
      const r = await fetch(api("/api/security/login-history?limit=200"));
      if (!r.ok) throw new Error("Failed to load login history");
      return r.json() as Promise<{ items: LoginHistoryEntry[] }>;
    },
    enabled: admin && planAllowed,
  });
  const ipsQ = useQuery({
    queryKey: ["security", tenantKey, "known-ips"],
    queryFn: async () => {
      const r = await fetch(api("/api/security/known-ips"));
      if (!r.ok) throw new Error("Failed to load known IPs");
      return r.json() as Promise<{ items: KnownIp[] }>;
    },
    enabled: admin && planAllowed,
  });
  const devicesQ = useQuery({
    queryKey: ["security", tenantKey, "trusted-devices"],
    queryFn: async () => {
      const r = await fetch(api("/api/security/trusted-devices"));
      if (!r.ok) throw new Error("Failed to load trusted devices");
      return r.json() as Promise<{ items: TrustedDevice[] }>;
    },
    enabled: admin && planAllowed,
  });

  if (!admin) {
    return (
      <div>
        <PageHeader
          title={t("admin-security-title")}
          description={t("admin-security-desc")}
        />
        <AdminRequired />
      </div>
    );
  }

  if (!planAllowed) {
    return (
      <div>
        <PageHeader
          title={t("admin-security-title")}
          description={t("admin-security-desc")}
        />
        <Card className="border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 rounded-xl">
          <CardContent className="p-6 flex items-start gap-3">
            <ShieldAlert className="size-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("admin-access-required")}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                The security center (session revocation, login history,
                trusted devices, known IPs) is a paid-plan surface and is
                not available during the trial. Upgrade your workspace to
                monitor and revoke active sessions and review login
                activity.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const sessions = sessionsQ.data?.items || [];
  const logins = loginQ.data?.items || [];
  const ips = ipsQ.data?.items || [];
  const devices = devicesQ.data?.items || [];

  const activeSessions = sessions.filter((s) => !s.revoked).length;
  const failed24h = logins.filter((l) => {
    if (l.success) return false;
    const d = new Date(l.created_at).getTime();
    return Date.now() - d < 24 * 3600 * 1000;
  }).length;
  const trustedIps = ips.filter((i) => i.trusted).length;
  const trustedDevices = devices.filter((d) => !d.revoked).length;

  return (
    <div>
      <PageHeader
        title={t("admin-security-title")}
        description={t("admin-security-desc")}
      />
      <ModuleInfoTooltip
        title="Security"
        description="View login history, active sessions, trusted devices, and known IPs. Revoke sessions and manage account security."
        howToUse={["Review recent login attempts", "Revoke suspicious sessions", "Remove trusted devices", "View known IPs", "Configure 2FA from Settings"]}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label={t("admin-security-active-sessions")}
          value={activeSessions}
          icon={ShieldCheck}
          sub={t("admin-security-not-revoked")}
        />
        <KpiCard
          label={t("admin-security-failed-24h")}
          value={failed24h}
          icon={ShieldAlert}
          iconClassName={failed24h > 0 ? "text-destructive" : undefined}
          sub={t("admin-security-last-24h")}
        />
        <KpiCard
          label={t("admin-security-trusted-ips")}
          value={trustedIps}
          icon={Network}
          sub={`${ips.length} ${t("admin-security-known")}`}
        />
        <KpiCard
          label={t("admin-security-trusted-devices")}
          value={trustedDevices}
          icon={Laptop}
          sub={`${devices.length} ${t("admin-security-total")}`}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full overflow-x-auto justify-start h-auto sm:grid sm:grid-cols-2 md:grid-cols-4">
          <TabsTrigger value="sessions" className="gap-1.5"><Shield className="size-3.5" /> {t("admin-security-tab-sessions")}</TabsTrigger>
          <TabsTrigger value="logins" className="gap-1.5"><History className="size-3.5" /> {t("admin-security-tab-logins")}</TabsTrigger>
          <TabsTrigger value="ips" className="gap-1.5"><Network className="size-3.5" /> {t("admin-security-tab-ips")}</TabsTrigger>
          <TabsTrigger value="devices" className="gap-1.5"><Laptop className="size-3.5" /> {t("admin-security-tab-devices")}</TabsTrigger>
        </TabsList>

        <TabsContent value="sessions" className="mt-4">
          <SessionsTab items={sessions} loading={sessionsQ.isLoading} />
        </TabsContent>
        <TabsContent value="logins" className="mt-4">
          <LoginHistoryTab items={logins} loading={loginQ.isLoading} />
        </TabsContent>
        <TabsContent value="ips" className="mt-4">
          <KnownIpsTab items={ips} loading={ipsQ.isLoading} />
        </TabsContent>
        <TabsContent value="devices" className="mt-4">
          <TrustedDevicesTab items={devices} loading={devicesQ.isLoading} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- Sessions tab ----------
function SessionsTab({ items, loading }: { items: SecuritySession[]; loading: boolean }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const revokeMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/security/sessions/${id}`), { method: "POST" });
      if (!r.ok) throw new Error("Failed to revoke session");
    },
    onSuccess: () => {
      toast.success("Session revoked.");
      qc.invalidateQueries({ queryKey: ["security", tenantKey, "sessions"] });
    },
    onError: () => toast.error("Failed to revoke session."),
  });

  return (
    <Card className="border-border/60 shadow-soft">
      <CardContent className="p-0">
        {loading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Shield className="size-6" />}
            title={t("admin-security-no-sessions-title")}
            description={t("admin-security-no-sessions-desc")}
          />
        ) : (
          <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>{t("admin-col-device-ua")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("admin-col-ip")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("admin-col-country")}</TableHead>
                  <TableHead className="hidden xl:table-cell">{t("admin-col-created")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("admin-col-last-used")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("admin-col-expires")}</TableHead>
                  <TableHead>{t("admin-col-status")}</TableHead>
                  <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => {
                  const ua = parseUa(s.user_agent);
                  const UaIcon = ua.icon;
                  return (
                    <TableRow key={s.id} className={s.current ? "bg-emerald-50/40 dark:bg-emerald-950/10" : ""}>
                      <TableCell>
                        <div className="flex items-start gap-2 min-w-0">
                          <UaIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{ua.label}</p>
                            <p className="text-xs text-muted-foreground truncate max-w-[260px]" title={s.user_agent || ""}>
                              {s.user_agent || "—"}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs tabular">
                        <span className="inline-flex items-center gap-1.5">{s.ip || "—"}{s.ip && <MapLink ip={s.ip} />}</span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">{s.country || "—"}</TableCell>
                      <TableCell className="hidden xl:table-cell text-xs">{fmtDateTime(s.created_at)}</TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{fmtRelative(s.last_used_at)}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">{fmtDateTime(s.expires_at)}</TableCell>
                      <TableCell>
                        {s.current ? (
                          <Badge className="bg-emerald-600 text-white">{t("admin-current")}</Badge>
                        ) : s.revoked ? (
                          <Badge variant="destructive">{t("admin-revoked")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("admin-active-badge")}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {!s.current && !s.revoked && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => revokeMut.mutate(s.id)}
                            disabled={revokeMut.isPending}
                          >
                            <Ban className="size-4 mr-1" /> {t("admin-revoke")}
                          </Button>
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
  );
}

// ---------- Login History tab ----------
function LoginHistoryTab({ items, loading }: { items: LoginHistoryEntry[]; loading: boolean }) {
  const t = useT();
  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </CardContent>
      </Card>
    );
  }
  if (items.length === 0) {
    return (
      <Card className="border-border/60 shadow-soft">
        <EmptyState
          icon={<History className="size-6" />}
          title={t("admin-security-no-logins-title")}
          description={t("admin-security-no-logins-desc")}
        />
      </Card>
    );
  }
  return (
    <Card className="border-border/60 shadow-soft">
      <CardContent className="p-0">
        <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead>{t("admin-col-time")}</TableHead>
                <TableHead>{t("admin-col-user")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("admin-col-ip")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("admin-col-country")}</TableHead>
                <TableHead className="hidden xl:table-cell">{t("admin-col-user-agent")}</TableHead>
                <TableHead>{t("admin-col-status")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("admin-col-reason")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) => (
                <TableRow
                  key={l.id}
                  className={l.success ? "" : "bg-destructive/5"}
                >
                  <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(l.created_at)}</TableCell>
                  <TableCell className="font-medium">{l.username}</TableCell>
                  <TableCell className="hidden md:table-cell font-mono text-xs tabular">
                    <span className="inline-flex items-center gap-1.5">{l.ip || "—"}{l.ip && <MapLink ip={l.ip} />}</span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{l.country || "—"}</TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <p className="text-xs text-muted-foreground truncate max-w-[280px]" title={l.user_agent || ""}>
                      {l.user_agent || "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    {l.success ? (
                      <Badge className="bg-emerald-600 text-white gap-1">
                        <CheckCircle2 className="size-3" /> {t("admin-success")}
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="gap-1">
                        <XCircle className="size-3" /> {t("admin-failed")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                    {l.reason || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Known IPs tab ----------
function KnownIpsTab({ items, loading }: { items: KnownIp[]; loading: boolean }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const trustMut = useMutation({
    mutationFn: async ({ id, trusted }: { id: string; trusted: boolean }) => {
      const r = await fetch(api(`/api/security/known-ips/${id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trusted }),
      });
      if (!r.ok) throw new Error("Failed to update IP");
    },
    onSuccess: (_v, vars) => {
      toast.success(vars.trusted ? "IP marked as trusted." : "IP untrusted.");
      qc.invalidateQueries({ queryKey: ["security", tenantKey, "known-ips"] });
    },
    onError: () => toast.error("Failed to update IP."),
  });
  const forgetMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/security/known-ips/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to forget IP");
    },
    onSuccess: () => {
      toast.success("IP forgotten.");
      qc.invalidateQueries({ queryKey: ["security", tenantKey, "known-ips"] });
    },
    onError: () => toast.error("Failed to forget IP."),
  });

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </CardContent>
      </Card>
    );
  }
  if (items.length === 0) {
    return (
      <Card className="border-border/60 shadow-soft">
        <EmptyState
          icon={<Network className="size-6" />}
          title={t("admin-security-no-ips-title")}
          description={t("admin-security-no-ips-desc")}
        />
      </Card>
    );
  }
  return (
    <Card className="border-border/60 shadow-soft">
      <CardContent className="p-0">
        <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead>{t("admin-col-ip")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("admin-col-country")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("admin-col-first-seen")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("admin-col-last-seen")}</TableHead>
                <TableHead>{t("admin-col-trusted")}</TableHead>
                <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((ip) => (
                <TableRow key={ip.id}>
                  <TableCell className="font-mono text-sm tabular">
                    <span className="inline-flex items-center gap-1.5">{ip.ip}<MapLink ip={ip.ip} /></span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{ip.country || "—"}</TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">{fmtDateTime(ip.first_seen)}</TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">{fmtRelative(ip.last_seen)}</TableCell>
                  <TableCell>
                    <Switch
                      checked={ip.trusted}
                      onCheckedChange={(v) => trustMut.mutate({ id: ip.id, trusted: v })}
                      disabled={trustMut.isPending}
                      aria-label={`${t("admin-trusted")} ${ip.ip}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => forgetMut.mutate(ip.id)}
                      disabled={forgetMut.isPending}
                    >
                      <Trash2 className="size-4 mr-1" /> {t("admin-forget")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Trusted Devices tab ----------
function TrustedDevicesTab({ items, loading }: { items: TrustedDevice[]; loading: boolean }) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const revokeMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/security/trusted-devices/${id}`), { method: "POST" });
      if (!r.ok) throw new Error("Failed to revoke device");
    },
    onSuccess: () => {
      toast.success("Device revoked.");
      qc.invalidateQueries({ queryKey: ["security", tenantKey, "trusted-devices"] });
    },
    onError: () => toast.error("Failed to revoke device."),
  });

  if (loading) {
    return (
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </CardContent>
      </Card>
    );
  }
  if (items.length === 0) {
    return (
      <Card className="border-border/60 shadow-soft">
        <EmptyState
          icon={<Laptop className="size-6" />}
          title={t("admin-security-no-devices-title")}
          description={t("admin-security-no-devices-desc")}
        />
      </Card>
    );
  }
  return (
    <Card className="border-border/60 shadow-soft">
      <CardContent className="p-0">
        <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead>{t("admin-col-device")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("admin-col-fingerprint")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("admin-col-ip")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("admin-col-last-used")}</TableHead>
                <TableHead>{t("admin-col-status")}</TableHead>
                <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.device_name}</TableCell>
                  <TableCell className="hidden md:table-cell font-mono text-xs text-muted-foreground tabular">
                    {d.fingerprint}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell font-mono text-xs tabular">
                    <span className="inline-flex items-center gap-1.5">{d.ip || "—"}{d.ip && <MapLink ip={d.ip} />}</span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs">{fmtRelative(d.last_used)}</TableCell>
                  <TableCell>
                    {d.revoked ? (
                      <Badge variant="destructive">{t("admin-revoked")}</Badge>
                    ) : (
                      <Badge className="bg-emerald-600 text-white gap-1">
                        <ShieldCheck className="size-3" /> {t("admin-trusted")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!d.revoked && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => revokeMut.mutate(d.id)}
                        disabled={revokeMut.isPending}
                      >
                        <Ban className="size-4 mr-1" /> {t("admin-revoke")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
