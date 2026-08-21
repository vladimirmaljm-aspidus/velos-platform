"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollText, Search, ChevronLeft, ChevronRight, RefreshCw, ShieldAlert, Download, X } from "lucide-react";
import { fmtDateTime } from "@/lib/utils/format";
import { MapLink } from "@/components/common/map-link";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";
import { toast } from "sonner";

interface AuditRow {
  id: string; tenant_id: string | null; user_id: string | null; username: string | null;
  action: string; entity_type: string | null; entity_id: string | null;
  details: Record<string, unknown> | null; ip: string | null; user_agent: string | null;
  created_at: string;
}
interface Tenant { id: string; name: string; }

const PAGE_SIZE = 50;

// FEAT-2 (Issue 2): curated action-type quick-filter options so operators
// can one-click slice the audit log by domain ("show me every security
// event", "show me every marketplace event", etc.). These map to substrings
// of audit_logs.action (which uses dot-namespaced actions like
// `kyc.approve`, `marketplace.bid.place`, `auth.login`, etc.). The values
// are intentionally prefixes so `kyc` catches `kyc.submit`, `kyc.approve`,
// `kyc.reject`, `kyc.resubmit`. The "Other" / blank option shows
// everything.
const ACTION_QUICK_FILTERS: { label: string; value: string }[] = [
  { label: "All actions", value: "" },
  { label: "Auth & sessions", value: "auth" },
  { label: "Login & logout", value: "login" },
  { label: "Tenant & signup", value: "tenant" },
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
  { label: "Cron jobs", value: "cron" },
];

export function PlatformAuditView() {
  const [tenantId, setTenantId] = React.useState<string>("");
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [action, setAction] = React.useState("");
  const [user, setUser] = React.useState("");
  const [entityType, setEntityType] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const t = useT();
  const userObj = useAppStore((s) => s.user);
  const isSuper = isSuperAdmin(userObj);

  // Defense-in-depth: even though the sidebar hides this view from
  // non-super-admins (and the audit API uses requireSuperAdmin), a
  // non-super-admin who lands here via state manipulation / direct
  // navigation should see a clear denial message instead of a partially
  // rendered UI that fires 403 fetches. We must declare all hooks BEFORE
  // the early return (Rules of Hooks), so the queries below pass
  // `enabled: isSuper` to short-circuit network calls when denied.

  const tenantsQ = useQuery({
    queryKey: ["platform-audit-tenants"],
    queryFn: async () => {
      const r = await fetch("/api/tenants");
      return r.ok ? (r.json() as Promise<{ items: Tenant[] }>) : { items: [] };
    },
    enabled: isSuper,
  });
  const tenants = tenantsQ.data?.items || [];

  const q = new URLSearchParams();
  if (tenantId) q.set("tenant_id", tenantId);
  if (action) q.set("action", action);
  if (user) q.set("user", user);
  if (entityType) q.set("entity_type", entityType);
  if (dateFrom) q.set("date_from", dateFrom);
  if (dateTo) q.set("date_to", dateTo);
  if (debouncedSearch) q.set("search", debouncedSearch);
  q.set("limit", String(PAGE_SIZE));
  q.set("offset", String(page * PAGE_SIZE));

  const auditQ = useQuery({
    queryKey: ["platform-audit", tenantId, action, user, entityType, dateFrom, dateTo, debouncedSearch, page],
    queryFn: async () => {
      const r = await fetch(`/api/super-admin/audit?${q.toString()}`);
      if (!r.ok) throw new Error("Failed to load audit");
      return r.json() as Promise<{ total: number; items: AuditRow[] }>;
    },
    refetchOnWindowFocus: false,
    enabled: isSuper,
  });

  const items = auditQ.data?.items || [];
  const total = auditQ.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // useMemo must run unconditionally to comply with react-hooks/rules-of-hooks.
  // The access-denied early return is placed AFTER this hook call.
  const tenantName = React.useMemo(() => new Map(tenants.map((tn) => [tn.id, tn.name])), [tenants]);

  const hasActiveFilters = !!(tenantId || action || user || entityType || dateFrom || dateTo || debouncedSearch);

  function clearFilters() {
    setTenantId(""); setAction(""); setUser(""); setEntityType("");
    setDateFrom(""); setDateTo(""); setSearch(""); setPage(0);
  }

  // UI-SUPER-AUDIT: client-side CSV export of the CURRENT page. The
  // server caps every fetch at 5,000 rows so a "full export" would be
  // massive; the operators who asked for this need a quick way to
  // pull the filtered page they're looking at into a spreadsheet for
  // an audit-meeting handout. For a true full export they can bump
  // `limit` server-side. The CSV uses the same field shape as the
  // table to make copy-paste mappings obvious.
  function exportCsv() {
    if (!items.length) { toast(t("pf-audit-export-empty")); return; }
    const cols = [
      "when", "tenant", "user", "action", "entity_type", "entity_id", "ip", "details",
    ];
    const rows = items.map((r) => ({
      when: fmtDateTime(r.created_at),
      tenant: r.tenant_id ? (tenantName.get(r.tenant_id) || r.tenant_id) : "platform",
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

  if (!isSuper) {
    return (
      <div>
        <PageHeader title={t("pf-audit-title")} description={t("pf-audit-desc")} />
        <Card className="border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5">
          <CardContent className="p-6 flex items-start gap-3">
            <div className="size-10 rounded-xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <p className="font-medium">Platform admin access required.</p>
              <p className="text-sm text-muted-foreground mt-1">
                This area is restricted to platform super-administrators. Contact your platform operator if you believe this is an error.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div><CardTitle className="flex items-center gap-2 text-base"><ScrollText className="size-4 text-primary" /> {t("pf-audit-title")}</CardTitle><CardDescription className="text-xs">{t("pf-audit-desc")}</CardDescription></div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!items.length} title={t("pf-audit-export-csv")}>
              <Download className="size-3.5 mr-1" /> {t("pf-audit-export-csv")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => auditQ.refetch()}><RefreshCw className={`size-3.5 mr-1 ${auditQ.isFetching ? "animate-spin" : ""}`} /> {t("refresh")}</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* ── Filter bar ───────────────────────────────────────────────
            FEAT-2 (Issue 2): the previous filter bar exposed only
            search + tenant + action-contains + username-contains. The
            user said "no log page shows everything needed" — they were
            right: the action-contains input was a free-text guess, the
            entity_type and date range dimensions were missing entirely
            even though the API supported them on the server side. Now
            there's a curated action quick-filter dropdown, an entity-
            type input, and date-from / date-to date pickers. The Clear
            button resets every filter at once (operators were getting
            trapped in narrow filter combinations with no easy escape). */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[180px]"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input placeholder={t("pf-audit-search-placeholder")} value={search} onChange={(e) => { setPage(0); setSearch(e.target.value); }} className="pl-8" /></div>
          <Select value={tenantId || "all"} onValueChange={(v) => { setPage(0); setTenantId(v === "all" ? "" : v); }}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder={t("pf-tenant")} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("pf-all-tenants")}</SelectItem>{tenants.map((tn) => <SelectItem key={tn.id} value={tn.id}>{tn.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={action} onValueChange={(v) => { setPage(0); setAction(v === "__all" ? "" : v); }}>
            <SelectTrigger className="w-[170px]"><SelectValue placeholder="Action type" /></SelectTrigger>
            <SelectContent>
              {ACTION_QUICK_FILTERS.map((f) => (
                <SelectItem key={f.label} value={f.value || "__all"}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input placeholder="Entity type (e.g. tenant)" value={entityType} onChange={(e) => { setPage(0); setEntityType(e.target.value); }} className="w-[170px]" />
          <Input placeholder={t("pf-audit-username")} value={user} onChange={(e) => { setPage(0); setUser(e.target.value); }} className="w-[140px]" />
          <Input type="date" value={dateFrom} onChange={(e) => { setPage(0); setDateFrom(e.target.value); }} className="w-[150px]" title="From date" />
          <Input type="date" value={dateTo} onChange={(e) => { setPage(0); setDateTo(e.target.value); }} className="w-[150px]" title="To date" />
          {hasActiveFilters && (
            <Button size="sm" variant="ghost" onClick={clearFilters} title="Clear all filters">
              <X className="size-3.5 mr-1" /> Clear
            </Button>
          )}
        </div>
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px]">{t("pf-audit-col-when")}</TableHead>
                <TableHead>{t("pf-audit-col-tenant")}</TableHead>
                <TableHead>{t("pf-audit-col-user")}</TableHead>
                <TableHead>{t("pf-audit-col-action")}</TableHead>
                <TableHead>{t("pf-audit-col-entity")}</TableHead>
                <TableHead>{t("pf-audit-col-ip")}</TableHead>
                <TableHead className="text-right">{t("pf-audit-col-details")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditQ.isLoading && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">{t("pf-audit-loading")}</TableCell></TableRow>}
              {!auditQ.isLoading && items.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">{t("pf-audit-no-entries")}</TableCell></TableRow>}
              {items.map((row) => (
                <React.Fragment key={row.id}>
                  <TableRow className="cursor-pointer" onClick={() => setExpanded((e) => e === row.id ? null : row.id)}>
                    <TableCell className="text-xs tabular text-muted-foreground">{fmtDateTime(row.created_at)}</TableCell>
                    <TableCell className="text-sm">{row.tenant_id ? tenantName.get(row.tenant_id) || row.tenant_id.slice(0, 8) : <span className="text-primary font-semibold">{t("pf-platform-badge")}</span>}</TableCell>
                    <TableCell className="text-sm">{row.username || "—"}</TableCell>
                    <TableCell><Badge variant="outline" className="font-mono text-xs">{row.action}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.entity_type ? `${row.entity_type}${row.entity_id ? "#" + row.entity_id.slice(0, 8) : ""}` : "—"}</TableCell>
                    <TableCell className="text-xs tabular"><span className="inline-flex items-center gap-1.5">{row.ip || "—"}{row.ip && <MapLink ip={row.ip} />}</span></TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{expanded === row.id ? t("pf-audit-hide") : t("pf-audit-show")}</TableCell>
                  </TableRow>
                  {expanded === row.id && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/40">
                        <pre className="text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto">{JSON.stringify({ details: row.details, user_agent: row.user_agent }, null, 2)}</pre>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div>{t("pf-audit-entries-page").replace("{total}", total.toLocaleString()).replace("{page}", String(page + 1)).replace("{pages}", String(totalPages))}</div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft className="size-3.5" /> {t("pf-audit-prev")}</Button>
            <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>{t("pf-audit-next")} <ChevronRight className="size-3.5" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
