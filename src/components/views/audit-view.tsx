"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search, ScrollText, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtDateTime } from "@/lib/utils/format";
import { AuditLog } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";

const PAGE_SIZE = 50;

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

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ["audit", tenantKey, debouncedSearch, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
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

  return (
    <div>
      <PageHeader
        title={t("audit")}
        description={`${data?.total ?? 0} ${t("admin-audit-events")}`}
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-4 sm:p-5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("admin-audit-search-placeholder")}
              value={search}
              onChange={(e) => { setPage(0); setSearch(e.target.value); }}
              className="pl-9"
            />
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
