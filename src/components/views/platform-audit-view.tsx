"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollText, Search, ChevronLeft, ChevronRight, RefreshCw, ShieldAlert } from "lucide-react";
import { fmtDateTime } from "@/lib/utils/format";
import { MapLink } from "@/components/common/map-link";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { PageHeader } from "@/components/common/page-header";

interface AuditRow {
  id: string; tenant_id: string | null; user_id: string | null; username: string | null;
  action: string; entity_type: string | null; entity_id: string | null;
  details: Record<string, unknown> | null; ip: string | null; user_agent: string | null;
  created_at: string;
}
interface Tenant { id: string; name: string; }

const PAGE_SIZE = 50;

export function PlatformAuditView() {
  const [tenantId, setTenantId] = React.useState<string>("");
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [action, setAction] = React.useState("");
  const [user, setUser] = React.useState("");
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
  if (debouncedSearch) q.set("search", debouncedSearch);
  q.set("limit", String(PAGE_SIZE));
  q.set("offset", String(page * PAGE_SIZE));

  const auditQ = useQuery({
    queryKey: ["platform-audit", tenantId, action, user, debouncedSearch, page],
    queryFn: async () => {
      const r = await fetch(`/api/super-admin/audit?${q.toString()}`);
      if (!r.ok) throw new Error("Failed to load audit");
      return r.json() as Promise<{ total: number; items: AuditRow[] }>;
    },
    refetchOnWindowFocus: false,
    enabled: isSuper,
  });

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

  const items = auditQ.data?.items || [];
  const total = auditQ.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tenantName = React.useMemo(() => new Map(tenants.map((t) => [t.id, t.name])), [tenants]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div><CardTitle className="flex items-center gap-2 text-base"><ScrollText className="size-4 text-primary" /> {t("pf-audit-title")}</CardTitle><CardDescription className="text-xs">{t("pf-audit-desc")}</CardDescription></div>
          <Button size="sm" variant="outline" onClick={() => auditQ.refetch()}><RefreshCw className={`size-3.5 mr-1 ${auditQ.isFetching ? "animate-spin" : ""}`} /> {t("refresh")}</Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[180px]"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input placeholder={t("pf-audit-search-placeholder")} value={search} onChange={(e) => { setPage(0); setSearch(e.target.value); }} className="pl-8" /></div>
          <Select value={tenantId || "all"} onValueChange={(v) => { setPage(0); setTenantId(v === "all" ? "" : v); }}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder={t("pf-tenant")} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("pf-all-tenants")}</SelectItem>{tenants.map((tn) => <SelectItem key={tn.id} value={tn.id}>{tn.name}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder={t("pf-audit-action-contains")} value={action} onChange={(e) => { setPage(0); setAction(e.target.value); }} className="w-[160px]" />
          <Input placeholder={t("pf-audit-username")} value={user} onChange={(e) => { setPage(0); setUser(e.target.value); }} className="w-[140px]" />
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
                    <TableCell><Badge variant="outline" className="font-mono text-[10px]">{row.action}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.entity_type ? `${row.entity_type}${row.entity_id ? "#" + row.entity_id.slice(0, 8) : ""}` : "—"}</TableCell>
                    <TableCell className="text-xs tabular"><span className="inline-flex items-center gap-1.5">{row.ip || "—"}{row.ip && <MapLink ip={row.ip} />}</span></TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{expanded === row.id ? t("pf-audit-hide") : t("pf-audit-show")}</TableCell>
                  </TableRow>
                  {expanded === row.id && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/40">
                        <pre className="text-[11px] font-mono whitespace-pre-wrap break-all overflow-x-auto">{JSON.stringify({ details: row.details, user_agent: row.user_agent }, null, 2)}</pre>
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
