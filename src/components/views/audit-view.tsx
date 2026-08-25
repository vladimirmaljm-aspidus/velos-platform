"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Search, ScrollText, ChevronLeft, ChevronRight, RefreshCw, Download, X,
} from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { fmtDateTime } from "@/lib/utils/format";
import { AuditLog } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";

const PAGE_SIZE = 50;

// FEAT-2 (Issue 2): curated action-type quick-filter options so tenant
// admins can one-click slice their own audit log by domain. Mirrors the
// platform-audit-view's filter set so the tenant-scoped experience has
// parity with the cross-tenant one (operators were complaining that "no
// log page shows everything needed" — the tenant-scoped audit page
// previously had only a free-text search and zero structured filters).
const ACTION_QUICK_FILTERS: { label: string; value: string }[] = [
  { label: "All actions", value: "" },
  { label: "Auth & sessions", value: "auth" },
  { label: "Login & logout", value: "login" },
  { label: "KYC", value: "kyc" },
  { label: "Marketplace", value: "marketplace" },
  { label: "Offers", value: "offer" },
  { label: "Invoices", value: "invoice" },
  { label: "Proformas", value: "proforma" },
  { label: "Portal", value: "portal" },
  { label: "Vault", value: "vault" },
  { label: "Webhooks", value: "webhook" },
  { label: "API keys", value: "api_key" },
  { label: "Security", value: "security" },
];

function initials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function actionColor(action: string): string {
  if (action === "login" || action === "logout" || action.startsWith("login.") || action.startsWith("logout.")) {
    return "border-transparent bg-chart-1 text-white";
  }
  if (action.endsWith(".create")) {
    return "border-transparent bg-chart-2 text-white";
  }
  if (action.endsWith(".update")) {
    return "border-transparent bg-chart-4 text-white";
  }
  if (action.endsWith(".delete")) {
    return "border-transparent bg-destructive text-white";
  }
  if (action.endsWith(".approve")) {
    return "border-transparent bg-chart-1 text-white";
  }
  if (action.endsWith(".reject")) {
    return "border-transparent bg-destructive text-white";
  }
  return "border-transparent bg-secondary text-secondary-foreground";
}

export function AuditView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [action, setAction] = React.useState("");
  const [user, setUser] = React.useState("");
  const [entityType, setEntityType] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(0);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["audit", tenantKey, debouncedSearch, action, user, entityType, dateFrom, dateTo, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (action) params.set("action", action);
      if (user) params.set("user", user);
      if (entityType) params.set("entity_type", entityType);
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const r = await fetch(api(`/api/audit?${params}`));
      if (!r.ok) throw new Error("Failed to load audit log");
      return r.json() as Promise<{ items: AuditLog[]; total: number }>;
    },
  });

  const items = data?.items || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasActiveFilters = !!(debouncedSearch || action || user || entityType || dateFrom || dateTo);

  function clearFilters() {
    setSearch(""); setAction(""); setUser(""); setEntityType("");
    setDateFrom(""); setDateTo(""); setPage(0);
  }

  // FEAT-2 (Issue 2): client-side CSV export of the current filtered
  // page (parity with platform-audit-view). Operators asked for a way
  // to pull the audit log into a spreadsheet for compliance reporting;
  // the previous tenant-scoped audit page had no export at all.
  function exportCsv() {
    if (!items.length) { toast(t("pf-audit-export-empty")); return; }
    const cols = [
      "when", "user", "action", "entity_type", "entity_id", "ip", "details",
    ];
    const rows = items.map((r) => ({
      when: fmtDateTime(r.created_at),
      user: r.username || "",
      action: r.action,
      entity_type: r.entity_type || "",
      entity_id: r.entity_id || "",
      ip: r.ip || "",
      details: r.details ? JSON.stringify(r.details) : "",
    }));
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    try {
      const csv = `${cols.join(",")}\n${rows.map((r) => cols.map((c) => escape((r as any)[c])).join(",")).join("\n")}`;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(t("pf-audit-export-failed"), { description: e?.message });
    }
  }

  return (
    <div>
      <PageHeader
        title={t("audit")}
        description={`${data?.total ?? 0} ${t("admin-audit-events")}`}
      />
      <ModuleInfoTooltip
        title="Audit Logs"
        description="View all actions taken in your tenant — who did what, when, and from where. Export for compliance."
        howToUse={["Filter by action type, user, entity, or date range", "Search by keyword", "Export to CSV for compliance reports", "Logs are append-only (tamper-proof)"]}
      />

      {/* ── Filter bar ──────────────────────────────────────────────
          FEAT-2 (Issue 2): the tenant-scoped audit page previously had
          only a free-text search — no way to filter by action type,
          user, entity_type, or date range. The user said "no log page
          shows everything needed" and this page was the prime example.
          The bar now mirrors the platform-audit-view's filter set so a
          tenant admin gets the same one-click action-type dropdown
          (Auth / KYC / Marketplace / …) plus date pickers and a Clear
          button, with a CSV export to match. */}
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder={t("admin-audit-search-placeholder")}
                value={search}
                onChange={(e) => { setPage(0); setSearch(e.target.value); }}
                className="pl-9"
              />
            </div>
            <Select value={action} onValueChange={(v) => { setPage(0); setAction(v === "__all" ? "" : v); }}>
              <SelectTrigger className="w-[170px]"><SelectValue placeholder="Action type" /></SelectTrigger>
              <SelectContent>
                {ACTION_QUICK_FILTERS.map((f) => (
                  <SelectItem key={f.label} value={f.value || "__all"}>{f.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Entity type" value={entityType} onChange={(e) => { setPage(0); setEntityType(e.target.value); }} className="w-[150px]" />
            <Input placeholder={t("pf-audit-username")} value={user} onChange={(e) => { setPage(0); setUser(e.target.value); }} className="w-[140px]" />
            <Input type="date" value={dateFrom} onChange={(e) => { setPage(0); setDateFrom(e.target.value); }} className="w-[150px]" title="From date" />
            <Input type="date" value={dateTo} onChange={(e) => { setPage(0); setDateTo(e.target.value); }} className="w-[150px]" title="To date" />
            {hasActiveFilters && (
              <Button size="sm" variant="ghost" onClick={clearFilters} title="Clear all filters">
                <X className="size-3.5 mr-1" /> Clear
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={!items.length} title={t("pf-audit-export-csv")}>
                <Download className="size-3.5 mr-1" /> {t("pf-audit-export-csv")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                <RefreshCw className={`size-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} /> {t("refresh")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="size-6" />}
              title={t("admin-audit-empty-title")}
              description={t("admin-audit-empty-desc")}
            />
          ) : (
            <div className="max-h-[calc(100vh-240px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead className="whitespace-nowrap">{t("admin-col-time")}</TableHead>
                    <TableHead>{t("admin-col-user")}</TableHead>
                    <TableHead>{t("admin-col-action")}</TableHead>
                    <TableHead>{t("admin-col-entity")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-col-ip")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-col-details")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular">
                        {fmtDateTime(log.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="size-7">
                            <AvatarFallback className="text-xs bg-muted">{initials(log.username)}</AvatarFallback>
                          </Avatar>
                          <span className="text-sm font-medium truncate max-w-[140px]">
                            {log.username || "—"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`font-mono text-xs ${actionColor(log.action)}`}>
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm font-mono">
                        {log.entity_type && log.entity_id
                          ? `${log.entity_type}:${log.entity_id.slice(0, 8)}`
                          : "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="font-mono text-xs text-muted-foreground tabular">{log.ip || "—"}</span>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell max-w-[280px]">
                        {log.details ? (
                          <pre className="text-xs font-mono bg-muted/60 rounded p-2 overflow-x-auto custom-scroll max-h-24">
                            {JSON.stringify(log.details, null, 2)}
                          </pre>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination — mirrors platform-audit-view pattern */}
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
    </div>
  );
}
