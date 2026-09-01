"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Server, Database, Activity, Clock, Gauge, RefreshCw, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store/app-store";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { fmtRelative, fmtDateTime } from "@/lib/utils/format";
import {
  SettingsCardHeader, SectionLabel, LoadingCard, ErrorCard,
} from "./_shared";

interface SystemHealthData {
  process: {
    uptimeSeconds: number;
    memory: {
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
      externalMb: number;
    };
    nodeVersion: string;
    platform: string;
  };
  apm: {
    summary: {
      totalRequests: number;
      avgResponseTime: number;
      slowRequests: number;
      errorRate: number;
      byRoute: Record<string, any>;
    };
    alerts: string[];
    thresholds: { avgResponseTimeMs: number; errorRate: number; slowRequests: number };
    slowThresholdMs: number;
    bufferCapacity: number;
  };
  db: {
    status: "ok" | "error" | "not_configured";
    error: string | null;
    db_size_pretty: string | null;
    db_size_bytes: number | null;
    active_connections: number | null;
    max_connections: number | null;
    largest_tables: Array<{
      schemaname: string;
      tablename: string;
      size_pretty: string;
      size_bytes: number;
    }>;
    table_counts: Record<string, number>;
  };
  sentry: "enabled" | "server_only" | "client_only" | "disabled";
  crons: Array<{
    jobid: number;
    jobname: string;
    schedule: string;
    active: boolean;
    path: string | null;
    description: string | null;
    last_run_status: string | null;
    last_run_start: string | null;
    last_run_end: string | null;
    last_return_message: string | null;
  }>;
  retention: Array<{
    table: string;
    description: string;
    kind: string;
    days?: number;
  }>;
  timestamp: string;
}

export function SystemHealth() {
  const api = useApiUrl();
  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const t = useT();

  const [data, setData] = React.useState<SystemHealthData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(api("/api/admin/system-health"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setData(d);
    } catch (e: any) {
      setError(e?.message || "Failed to load system health");
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    // AUDIT19 (frontend #1) — load immediately on mount, THEN poll every
    // 30s. setInterval alone never fires `load` on the first tick, so the
    // tab rendered a spinner for the full 30-second interval before any
    // data appeared (every sibling panel calls `void load()` first).
    // load() calls setLoading synchronously at its start; the rule's
    // static analysis can't follow the promise — same disable as the
    // sibling super-admin panels (monitoring-settings.tsx:89).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const id = setInterval(load, 30_000); // refresh every 30s
    return () => clearInterval(id);
  }, [load]);

  if (loading && !data) return <LoadingCard title={t("pf-sa-sys-title")} />;
  if (error || !data) return <ErrorCard title={t("pf-sa-sys-title")} message={error || "No data"} />;

  const memPct = data.process.memory.heapTotalMb > 0
    ? Math.round((data.process.memory.heapUsedMb / data.process.memory.heapTotalMb) * 100)
    : 0;
  const uptimeHours = Math.floor(data.process.uptimeSeconds / 3600);
  const uptimeMin = Math.floor((data.process.uptimeSeconds % 3600) / 60);
  const uptimeStr = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMin}m` : `${uptimeMin}m`;

  const connPct = data.db.max_connections && data.db.max_connections > 0
    ? Math.round(((data.db.active_connections ?? 0) / data.db.max_connections) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Top refresh bar */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="py-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Activity className={`size-4 ${data.apm.alerts.length > 0 ? "text-amber-500" : "text-emerald-500"}`} />
            <span className="text-sm font-medium">{t("pf-sa-sys-title")}</span>
            <span className="text-xs text-muted-foreground">last updated {fmtRelative(data.timestamp)}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => { void load(); }}>
            <RefreshCw className={`size-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> {t("pf-sa-sys-refresh")}
          </Button>
        </CardContent>
      </Card>

      {/* APM quick KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          icon={Gauge}
          label="Avg Response"
          value={`${data.apm.summary.avgResponseTime}ms`}
          tone={data.apm.summary.avgResponseTime > data.apm.thresholds.avgResponseTimeMs ? "warn" : "ok"}
          hint={`Threshold: ${data.apm.thresholds.avgResponseTimeMs}ms`}
        />
        <Tile
          icon={AlertTriangle}
          label="Error Rate"
          value={`${(data.apm.summary.errorRate * 100).toFixed(1)}%`}
          tone={data.apm.summary.errorRate > data.apm.thresholds.errorRate ? "warn" : "ok"}
          hint={`Threshold: ${(data.apm.thresholds.errorRate * 100).toFixed(1)}%`}
        />
        <Tile
          icon={Clock}
          label="Slow Requests"
          value={String(data.apm.summary.slowRequests)}
          tone={data.apm.summary.slowRequests > data.apm.thresholds.slowRequests ? "warn" : "ok"}
          hint={`>${data.apm.slowThresholdMs}ms · ${data.apm.summary.totalRequests} total`}
        />
        <Tile
          icon={Server}
          label="Uptime"
          value={uptimeStr}
          tone="info"
          hint={`Node ${data.process.nodeVersion} · ${data.process.platform}`}
        />
      </div>

      {/* APM alerts banner */}
      {data.apm.alerts.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="size-4 text-amber-600" />
              <span className="font-medium text-sm text-amber-700 dark:text-amber-400">{data.apm.alerts.length} active alert(s)</span>
            </div>
            <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
              {data.apm.alerts.map((a, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-amber-500/60">•</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => setView("performance")}>
              Open Performance Dashboard
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Memory & process */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-sys-mem-title")}
          description={`${t("pf-sa-sys-mem-desc")} Heap usage: ${data.process.memory.heapUsedMb}MB / ${data.process.memory.heapTotalMb}MB (${memPct}%). RSS: ${data.process.memory.rssMb}MB · External: ${data.process.memory.externalMb}MB.`}
          dirty={false}
          saving={false}
        />
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile icon={Server} label="RSS (Resident)" value={`${data.process.memory.rssMb} MB`} tone="info" />
          <Tile icon={Database} label="Heap Used" value={`${data.process.memory.heapUsedMb} MB`} tone={memPct > 80 ? "warn" : "ok"} hint={`${memPct}% of heap total`} />
          <Tile icon={Database} label="Heap Total" value={`${data.process.memory.heapTotalMb} MB`} tone="info" />
          <Tile icon={Database} label="External" value={`${data.process.memory.externalMb} MB`} tone="info" hint="C++ objects (Buffer, etc.)" />
        </CardContent>
      </Card>

      {/* DB metrics — real Postgres introspection */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-sys-db-title")}
          description={`${t("pf-sa-sys-db-desc")} DB status: ${data.db.status}. Size + connections + largest tables via the get_db_metrics() RPC (migration 043). Row-count liveness probe below.`}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-4">
          {/* Top-row DB tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Tile
              icon={Database}
              label="Database Size"
              value={data.db.db_size_pretty ?? "—"}
              tone="info"
              hint={data.db.db_size_bytes != null ? `${data.db.db_size_bytes.toLocaleString()} bytes` : undefined}
            />
            <Tile
              icon={Server}
              label="Active Connections"
              value={data.db.active_connections != null ? String(data.db.active_connections) : "—"}
              tone={connPct > 80 ? "warn" : "ok"}
              hint={data.db.max_connections ? `${connPct}% of ${data.db.max_connections} max` : undefined}
            />
            <Tile
              icon={Activity}
              label="Liveness Probe"
              value={data.db.status === "ok" ? "OK" : data.db.status}
              tone={data.db.status === "ok" ? "ok" : "critical"}
              hint={data.db.error ? data.db.error : "All probe tables reachable"}
            />
          </div>

          {/* Largest tables */}
          {data.db.largest_tables.length > 0 && (
            <div>
              <SectionLabel hint="top 10 · by pg_total_relation_size">Largest Tables</SectionLabel>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Schema</TableHead>
                    <TableHead>Table</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.db.largest_tables.map((t) => (
                    <TableRow key={`${t.schemaname}.${t.tablename}`}>
                      <TableCell className="text-xs font-mono">{t.schemaname}</TableCell>
                      <TableCell><code className="text-xs font-mono">{t.tablename}</code></TableCell>
                      <TableCell className="text-right tabular text-xs">{t.size_pretty} <span className="text-muted-foreground">({Number(t.size_bytes).toLocaleString()} B)</span></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Row-count liveness probe */}
          <div>
            <SectionLabel hint="HEAD probe · capped at 1000 by PostgREST">Row Count Liveness Probe</SectionLabel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Row Count</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(data.db.table_counts).map(([table, count]) => (
                  <TableRow key={table}>
                    <TableCell><code className="text-xs font-mono">{table}</code></TableCell>
                    <TableCell className="text-right tabular">{count < 0 ? "—" : count >= 1000 ? "1000+" : count}</TableCell>
                    <TableCell className="text-right">
                      {count >= 0 ? <CheckCircle2 className="size-4 text-emerald-500 inline" /> : <XCircle className="size-4 text-destructive inline" />}
                    </TableCell>
                  </TableRow>
                ))}
                {data.db.error && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-destructive text-xs">DB error: {data.db.error}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Sentry */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-mon-sentry-title")}
          description={`${t("pf-sa-mon-sentry-desc")} Render service status is available in the Render dashboard — link below.`}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Sentry status</span>
            <Badge variant="outline" className={`uppercase text-xs tracking-wider ${
              data.sentry === "enabled" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" :
              data.sentry === "disabled" ? "bg-destructive/10 text-destructive border-destructive/30" :
              "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
            }`}>
              {data.sentry}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <a href="https://dashboard.render.com" target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline">
                Open Render Dashboard
              </Button>
            </a>
            <a href="https://sentry.io" target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline">
                Open Sentry Dashboard
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Cron status — real pg_cron metadata */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-sys-cron-title")}
          description={t("pf-sa-sys-cron-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.crons.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-xs text-muted-foreground text-center py-6">
                    No pg_cron jobs visible — run migration 043 to enable the get_cron_status() RPC.
                  </TableCell>
                </TableRow>
              ) : data.crons.map((c) => (
                <TableRow key={c.jobid}>
                  <TableCell>
                    <code className="text-xs font-mono">{c.jobname}</code>
                    {c.path && <div className="text-xs text-muted-foreground font-mono mt-0.5">{c.path}</div>}
                  </TableCell>
                  <TableCell><Badge variant="outline" className="text-xs font-mono">{c.schedule}</Badge></TableCell>
                  <TableCell>
                    {c.active ? (
                      <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">ACTIVE</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs bg-muted text-muted-foreground">PAUSED</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular">
                    {c.last_run_start ? fmtDateTime(c.last_run_start) : "never"}
                  </TableCell>
                  <TableCell>
                    {c.last_run_status ? (
                      <Badge variant="outline" className={`text-xs uppercase ${
                        c.last_run_status === "succeeded"
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                          : "bg-destructive/10 text-destructive border-destructive/30"
                      }`}>
                        {c.last_run_status}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.description ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Retention policy mirror — REMOVED (D-AUDIT-3).
          This was a duplicate of the retention table shown under
          Data Protection. Per the consolidation task, retention lives
          only on the Data Protection tab to avoid two sources of truth
          for the same read-only data. */}

      <p className="text-xs text-muted-foreground text-center">
        Auto-refreshing every 30s · Snapshot taken {fmtDateTime(data.timestamp)} · Process uptime {uptimeStr}
      </p>
    </div>
  );
}

function Tile({
  icon: Icon, label, value, tone, hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "ok" | "warn" | "info" | "critical";
  hint?: string;
}) {
  const cls = {
    ok: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
    warn: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400",
    info: "border-primary/30 bg-primary/5",
    critical: "border-destructive/30 bg-destructive/5 text-destructive",
  }[tone];
  return (
    <div className={`rounded-xl border ${cls} p-3`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider opacity-70">{label}</p>
          <p className="text-xl font-bold tabular mt-1">{value}</p>
        </div>
        <Icon className="size-4 opacity-60" />
      </div>
      {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
    </div>
  );
}
