"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Search, ChevronLeft, ChevronRight, RefreshCw, X, Eye, Bug, CircleAlert,
  MonitorSmartphone, Server, CheckCircle2, RotateCcw,
} from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtDateTime, fmtRelative } from "@/lib/utils/format";
import { ErrorLog } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";

const PAGE_SIZE = 50;

// 8-c (error audit) — admin triage surface for the error_logs table.
//
// Data source: GET /api/admin/errors (auth + audit.read; tenant-scoped for
// tenant admins, cross-tenant for super-admins) returning { items, total,
// stats }. Mutations: PUT /api/admin/errors { id, resolved } with an
// OPTIMISTIC update (the row flips resolved_at immediately, then the
// invalidation refetch confirms).
//
// Follows the audit-view.tsx / mail-queue-view.tsx patterns: debounced
// search + Select filters in a Card bar, KPI row, sticky-header table in a
// max-height custom-scroll container, prev/next pagination, detail dialog
// with mono stack + pretty-printed context JSON.

interface ErrorStats {
  total: number;
  open: number;
  client: number;
  server: number;
  last24h: number;
}

interface ErrorsResponse {
  items: ErrorLog[];
  total: number;
  stats: ErrorStats;
}

function levelBadgeClass(level: string): string {
  if (level === "warning") return "border-transparent bg-amber-500 text-white";
  return "border-transparent bg-destructive text-white";
}

function sourceBadgeClass(source: string): string {
  if (source === "server") return "bg-transparent border-border text-muted-foreground";
  return "border-transparent bg-secondary text-secondary-foreground";
}

function statusBadgeClass(resolved: boolean): string {
  if (resolved) return "border-transparent bg-emerald-600 text-white";
  return "border-transparent bg-amber-500 text-white";
}

export function ErrorAuditView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  const qc = useQueryClient();
  const user = useAppStore((s) => s.user);

  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [source, setSource] = React.useState("");
  const [level, setLevel] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["error-audit", tenantKey, debouncedSearch, source, level, status, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (source) params.set("source", source);
      if (level) params.set("level", level);
      if (status) params.set("resolved", status);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const r = await fetch(api(`/api/admin/errors?${params}`));
      if (!r.ok) throw new Error(t("error-audit-load-failed"));
      return r.json() as Promise<ErrorsResponse>;
    },
  });

  const items = data?.items || [];
  const total = data?.total || 0;
  const stats = data?.stats;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasActiveFilters = !!(debouncedSearch || source || level || status);

  function clearFilters() {
    setSearch(""); setSource(""); setLevel(""); setStatus(""); setPage(0);
  }

  // ── Resolve / re-open with an optimistic row + stats patch ────────────
  const resolveMut = useMutation({
    mutationFn: async (vars: { id: string; resolved: boolean }) => {
      const r = await fetch(api("/api/admin/errors"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!r.ok) throw new Error(t("error-audit-toast-failed"));
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["error-audit"] });
      // Snapshot every cached filter/page combination so a failure rolls
      // the whole view back consistently.
      const snapshots = qc.getQueriesData<ErrorsResponse>({ queryKey: ["error-audit"] });
      const resolvedAt = vars.resolved ? new Date().toISOString() : null;
      const resolvedBy = vars.resolved ? user?.email || user?.username || "" : null;
      qc.setQueriesData<ErrorsResponse>({ queryKey: ["error-audit"] }, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((it) =>
            it.id === vars.id ? { ...it, resolved_at: resolvedAt, resolved_by: resolvedBy } : it,
          ),
          stats: old.stats
            ? { ...old.stats, open: Math.max(0, old.stats.open + (vars.resolved ? -1 : 1)) }
            : old.stats,
        };
      });
      return { snapshots };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, snap] of ctx.snapshots) qc.setQueryData(key, snap);
      }
      toast.error(t("error-audit-toast-failed"));
    },
    onSuccess: (_d, vars) => {
      toast.success(
        vars.resolved ? t("error-audit-toast-resolved") : t("error-audit-toast-reopened"),
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["error-audit"] });
    },
  });

  const detail = detailId ? items.find((i) => i.id === detailId) || null : null;

  return (
    <div>
      <PageHeader
        title={t("error-audit-title")}
        description={t("error-audit-desc")}
        actions={
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className={`size-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} /> {t("refresh")}
          </Button>
        }
      />

      {/* ── Stat cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label={t("error-audit-kpi-total")}
          value={stats?.total ?? 0}
          icon={Bug}
          sub={t("error-audit-kpi-last24h").replace("{n}", String(stats?.last24h ?? 0))}
        />
        <KpiCard
          label={t("error-audit-kpi-open")}
          value={stats?.open ?? 0}
          icon={CircleAlert}
          variant="warning"
        />
        <KpiCard
          label={t("error-audit-kpi-client")}
          value={stats?.client ?? 0}
          icon={MonitorSmartphone}
        />
        <KpiCard
          label={t("error-audit-kpi-server")}
          value={stats?.server ?? 0}
          icon={Server}
        />
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder={t("error-audit-search-placeholder")}
                value={search}
                onChange={(e) => { setPage(0); setSearch(e.target.value); }}
                className="pl-9"
              />
            </div>
            <Select value={source} onValueChange={(v) => { setPage(0); setSource(v === "__all" ? "" : v); }}>
              <SelectTrigger className="w-[150px]" aria-label={t("error-audit-filter-source")}>
                <SelectValue placeholder={t("error-audit-filter-source")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">{t("error-audit-source-all")}</SelectItem>
                <SelectItem value="client">{t("error-audit-source-client")}</SelectItem>
                <SelectItem value="server">{t("error-audit-source-server")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={level} onValueChange={(v) => { setPage(0); setLevel(v === "__all" ? "" : v); }}>
              <SelectTrigger className="w-[150px]" aria-label={t("error-audit-filter-level")}>
                <SelectValue placeholder={t("error-audit-filter-level")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">{t("error-audit-level-all")}</SelectItem>
                <SelectItem value="error">{t("error-audit-level-error")}</SelectItem>
                <SelectItem value="warning">{t("error-audit-level-warning")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => { setPage(0); setStatus(v === "__all" ? "" : v); }}>
              <SelectTrigger className="w-[150px]" aria-label={t("error-audit-filter-status")}>
                <SelectValue placeholder={t("error-audit-filter-status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">{t("error-audit-status-all")}</SelectItem>
                <SelectItem value="open">{t("error-audit-status-open")}</SelectItem>
                <SelectItem value="resolved">{t("error-audit-status-resolved")}</SelectItem>
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button size="sm" variant="ghost" onClick={clearFilters} title={t("error-audit-clear")}>
                <X className="size-3.5 mr-1" /> {t("error-audit-clear")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : error ? (
            <EmptyState
              icon={<CircleAlert className="size-6" />}
              title={t("error-audit-load-failed")}
              description={t("error-audit-empty-desc")}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Bug className="size-6" />}
              title={hasActiveFilters ? t("error-audit-empty-filtered-title") : t("error-audit-empty-title")}
              description={hasActiveFilters ? t("error-audit-empty-filtered-desc") : t("error-audit-empty-desc")}
            />
          ) : (
            <div className="max-h-[calc(100vh-240px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead className="whitespace-nowrap">{t("error-audit-col-level")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("error-audit-col-source")}</TableHead>
                    <TableHead className="min-w-[220px]">{t("error-audit-col-message")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("error-audit-col-user")}</TableHead>
                    <TableHead className="whitespace-nowrap text-right">{t("error-audit-col-count")}</TableHead>
                    <TableHead className="hidden lg:table-cell whitespace-nowrap">{t("error-audit-col-first-seen")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("error-audit-col-last-seen")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("error-audit-col-status")}</TableHead>
                    <TableHead className="whitespace-nowrap text-right">{t("error-audit-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((log) => {
                    const resolved = !!log.resolved_at;
                    return (
                      <TableRow key={log.id}>
                        <TableCell>
                          <Badge variant="outline" className={`font-mono text-xs ${levelBadgeClass(log.level)}`}>
                            {log.level === "warning" ? t("error-audit-level-warning") : t("error-audit-level-error")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${sourceBadgeClass(log.source)}`}>
                            {log.source === "server" ? t("error-audit-source-server") : t("error-audit-source-client")}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[280px]">
                          <button
                            type="button"
                            className="text-left text-sm font-medium truncate block max-w-full hover:underline focus:underline outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            title={log.message}
                            onClick={() => setDetailId(log.id)}
                          >
                            {log.message}
                          </button>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="max-w-[160px]">
                            <span className="text-sm truncate block" title={log.user_email || undefined}>
                              {log.user_email || t("error-audit-anonymous")}
                            </span>
                            {log.user_role && (
                              <span className="text-xs text-muted-foreground">{log.user_role}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm tabular">
                          {(log.occurrence_count || 1).toLocaleString()}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell whitespace-nowrap text-sm text-muted-foreground tabular">
                          {fmtDateTime(log.first_seen_at)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">
                          <span title={fmtDateTime(log.last_seen_at)}>
                            {fmtRelative(log.last_seen_at)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${statusBadgeClass(resolved)}`}>
                            {resolved ? t("error-audit-status-resolved") : t("error-audit-status-open")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDetailId(log.id)}
                              title={t("error-audit-action-view")}
                              aria-label={t("error-audit-action-view")}
                            >
                              <Eye className="size-3.5" />
                            </Button>
                            {resolved ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={resolveMut.isPending}
                                onClick={() => resolveMut.mutate({ id: log.id, resolved: false })}
                                title={t("error-audit-action-reopen")}
                              >
                                <RotateCcw className="size-3.5 mr-1" /> {t("error-audit-action-reopen")}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={resolveMut.isPending}
                                onClick={() => resolveMut.mutate({ id: log.id, resolved: true })}
                                title={t("error-audit-action-resolve")}
                              >
                                <CheckCircle2 className="size-3.5 mr-1" /> {t("error-audit-action-resolve")}
                              </Button>
                            )}
                          </div>
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

      {/* ── Pagination (mirrors audit-view) ────────────────────────── */}
      <div className="flex items-center justify-between text-xs text-muted-foreground mt-3">
        <div>
          {t("pf-audit-entries-page")
            .replace("{total}", total.toLocaleString())
            .replace("{page}", String(page + 1))
            .replace("{pages}", String(totalPages))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="size-3.5" /> {t("pf-audit-prev")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("pf-audit-next")} <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Detail dialog ──────────────────────────────────────────── */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle className="flex items-center gap-2">
              {detail && (
                <Badge variant="outline" className={`font-mono text-xs ${levelBadgeClass(detail.level)}`}>
                  {detail.level === "warning" ? t("error-audit-level-warning") : t("error-audit-level-error")}
                </Badge>
              )}
              <span className="text-base truncate max-w-[400px]">{detail?.message}</span>
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.source === "server" ? t("error-audit-source-server") : t("error-audit-source-client")} · ${(detail.occurrence_count || 1).toLocaleString()} × · ${fmtRelative(detail.last_seen_at)}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto custom-scroll px-6 py-4 space-y-4">
            {detail && (
              <>
                {/* Meta grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("error-audit-detail-fingerprint")}</p>
                    <p className="font-mono text-xs break-all">{detail.fingerprint}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("error-audit-detail-occurrences")}</p>
                    <p className="tabular">{(detail.occurrence_count || 1).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("error-audit-detail-first-seen")}</p>
                    <p className="tabular">{fmtDateTime(detail.first_seen_at)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("error-audit-detail-last-seen")}</p>
                    <p className="tabular">{fmtDateTime(detail.last_seen_at)}</p>
                  </div>
                  {detail.resolved_at && (
                    <>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("error-audit-detail-resolved-by")}</p>
                        <p className="truncate">{detail.resolved_by || "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t("error-audit-detail-resolved-at")}</p>
                        <p className="tabular">{fmtDateTime(detail.resolved_at)}</p>
                      </div>
                    </>
                  )}
                  {detail.tenant_id && (
                    <div className="col-span-2">
                      <p className="text-xs text-muted-foreground">{t("error-audit-detail-tenant")}</p>
                      <p className="font-mono text-xs break-all">{detail.tenant_id}</p>
                    </div>
                  )}
                </div>

                {/* URL */}
                {detail.url && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">{t("error-audit-detail-url")}</p>
                    <p className="text-sm break-all font-mono bg-muted/60 rounded p-2">{detail.url}</p>
                  </div>
                )}

                {/* Stack */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">{t("error-audit-detail-stack")}</p>
                  {detail.stack ? (
                    <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-muted/60 rounded p-3 max-h-72 overflow-y-auto custom-scroll">
                      {detail.stack}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("error-audit-none")}</p>
                  )}
                </div>

                {/* Context */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">{t("error-audit-detail-context")}</p>
                  {detail.context && Object.keys(detail.context).length > 0 ? (
                    <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-muted/60 rounded p-3 max-h-60 overflow-y-auto custom-scroll">
                      {JSON.stringify(detail.context, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("error-audit-none")}</p>
                  )}
                </div>

                {/* User agent */}
                {detail.user_agent && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">{t("error-audit-detail-user-agent")}</p>
                    <p className="text-xs break-all font-mono bg-muted/60 rounded p-2">{detail.user_agent}</p>
                  </div>
                )}
              </>
            )}
          </div>

          {detail && (
            <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
              {detail.resolved_at ? (
                <Button
                  variant="outline"
                  disabled={resolveMut.isPending}
                  onClick={() => { resolveMut.mutate({ id: detail.id, resolved: false }); setDetailId(null); }}
                >
                  <RotateCcw className="size-4 mr-1" /> {t("error-audit-action-reopen")}
                </Button>
              ) : (
                <Button
                  disabled={resolveMut.isPending}
                  onClick={() => { resolveMut.mutate({ id: detail.id, resolved: true }); setDetailId(null); }}
                >
                  <CheckCircle2 className="size-4 mr-1" /> {t("error-audit-action-resolve")}
                </Button>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
