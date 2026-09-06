"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Mail, MailCheck, XCircle, HelpCircle, Eye, Lock, AlertTriangle, FileText, Code2, MonitorPlay, Ban, Inbox,
} from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState } from "@/components/common/empty-state";
import { fmtRelative, fmtDateTime } from "@/lib/utils/format";
import { useAppStore, isSuperAdmin } from "@/lib/store/app-store";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";

/**
 * TASK 41 — Email Log: the append-only audit of every outbound email
 * attempt, with the EXACT text that was sent. Replaces the removed Mail
 * Queue. No retry, no queue — by design:
 *   "jedan mejl ako se ne posalje mora samo da se prikaze da nije poslat
 *    ali nikako da se komila na listu cekanja" (owner).
 */

type StatusKey = "sent" | "failed" | "unknown";

interface EmailLogListItem {
  id: string;
  tenant_id: string | null;
  to_email: string;
  from_email: string | null;
  subject: string | null;
  status: StatusKey;
  provider: string | null;
  message_id: string | null;
  error: string | null;
  entity_type: string | null;
  entity_id: string | null;
  created_by: string | null;
  ip: string | null;
  sent_at: string | null;
  created_at: string;
}

interface EmailLogDetail extends EmailLogListItem {
  body_html: string | null;
  body_text: string | null;
}

interface ListResponse {
  items: EmailLogListItem[];
  total: number;
  stats: { sent24h: number; failed24h: number; unknown24h: number };
}

const STATUS_META: Record<StatusKey, { labelKey: string; className: string; icon: typeof MailCheck }> = {
  sent: { labelKey: "elog-status-sent", className: "bg-emerald-600 text-white", icon: MailCheck },
  failed: { labelKey: "elog-status-failed", className: "bg-destructive text-white", icon: XCircle },
  unknown: { labelKey: "elog-status-unknown", className: "bg-amber-500 text-white", icon: HelpCircle },
};

const ENTITY_LABEL: Record<string, string> = {
  offer: "Offer",
  invoice: "Invoice",
  proforma: "Proforma",
  loi: "LOI",
};

function SuperAdminRequired() {
  const t = useT();
  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
      <CardContent className="p-6 flex items-start gap-3">
        <Lock className="size-5 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("admin-access-required")}</p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t("admin-mail-admin-only-desc")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function EmailLogView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const user = useAppStore((s) => s.user);
  // Platform-level observability surface — super-admin only (same posture
  // as the Mail Queue it replaces; the exact email bodies are sensitive).
  const superAdmin = isSuperAdmin(user);
  const activeTenantId = useAppStore((s) => s.activeTenantId);
  const crossTenantMode = superAdmin && !activeTenantId;

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [status, setStatus] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["email-log", tenantKey, debouncedSearch, status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (status !== "all") params.set("status", status);
      params.set("limit", "100");
      const r = await fetch(api(`/api/email-log?${params}`));
      if (!r.ok) throw new Error("Failed to load email log");
      return r.json() as Promise<ListResponse>;
    },
    enabled: superAdmin,
  });

  // Tenant name lookup — only needed in cross-tenant mode.
  const tenantsQ = useQuery({
    queryKey: ["email-log-tenants"],
    queryFn: async () => {
      const r = await fetch("/api/tenants");
      return r.ok ? (r.json() as Promise<{ items: { id: string; name: string }[] }>) : { items: [] };
    },
    enabled: superAdmin && crossTenantMode,
    staleTime: 60_000,
  });
  const tenantNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (tenantsQ.data?.items || []).forEach((tn) => m.set(tn.id, tn.name));
    return m;
  }, [tenantsQ.data]);

  if (!superAdmin) {
    return (
      <div>
        <PageHeader title={t("elog-title")} description={t("elog-desc")} />
        <SuperAdminRequired />
      </div>
    );
  }

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? { sent24h: 0, failed24h: 0, unknown24h: 0 };

  return (
    <div>
      <PageHeader
        title={t("elog-title")}
        description={t("elog-desc")}
      />
      <ModuleInfoTooltip
        title="Email Log"
        description="Append-only audit of every outbound email: recipient, subject, the exact text that was sent, provider, status and errors. No queue, no automatic re-sends — failed emails simply show as failed."
        howToUse={[
          "Every send attempt appears here the moment it happens (sent / failed / unconfirmed)",
          "Unconfirmed = the provider timed out; the email may have arrived, so re-sending is blocked for 10 minutes",
          "Click a row to see the exact HTML and text the recipient received",
          "To re-send a document email, use the document's own Send action (LOI, Offer, Invoice, Proforma)",
        ]}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label={t("elog-kpi-sent24h")}
          value={stats.sent24h}
          icon={MailCheck}
          iconClassName="text-success"
          sub={t("elog-kpi-sent24h-sub")}
        />
        <KpiCard
          label={t("elog-kpi-failed24h")}
          value={stats.failed24h}
          icon={XCircle}
          iconClassName={stats.failed24h > 0 ? "text-destructive" : undefined}
          sub={t("elog-kpi-failed24h-sub")}
        />
        <KpiCard
          label={t("elog-kpi-unknown24h")}
          value={stats.unknown24h}
          icon={HelpCircle}
          iconClassName={stats.unknown24h > 0 ? "text-amber-500" : undefined}
          sub={t("elog-kpi-unknown24h-sub")}
        />
        <KpiCard
          label={t("total")}
          value={total}
          icon={Mail}
          sub={t("elog-kpi-total-sub")}
        />
      </div>

      {crossTenantMode && (
        <Card className="mb-4 border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
          <CardContent className="p-3 flex items-start gap-2.5">
            <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("elog-cross-tenant-note")}
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Input
              placeholder={t("elog-search-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-3"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("admin-col-status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("elog-all-statuses")}</SelectItem>
              <SelectItem value="sent">{t("elog-status-sent")}</SelectItem>
              <SelectItem value="failed">{t("elog-status-failed")}</SelectItem>
              <SelectItem value="unknown">{t("elog-status-unknown")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Mail className="size-6" />}
              title={t("elog-empty-title")}
              description={t("elog-empty-desc")}
            />
          ) : (
            <div className="max-h-[calc(100vh-440px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    {crossTenantMode && (
                      <TableHead className="hidden md:table-cell">{t("admin-mail-col-tenant")}</TableHead>
                    )}
                    <TableHead>{t("admin-mail-col-to")}</TableHead>
                    <TableHead>{t("admin-mail-subject")}</TableHead>
                    <TableHead>{t("admin-col-status")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("elog-col-provider")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-mail-col-error")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("elog-col-doc")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-col-created")}</TableHead>
                    <TableHead className="text-right">{t("admin-col-actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => {
                    const meta = STATUS_META[m.status] ?? STATUS_META.failed;
                    const Icon = meta.icon;
                    const tenantName = m.tenant_id
                      ? tenantNameMap.get(m.tenant_id) || m.tenant_id.slice(0, 8)
                      : "—";
                    return (
                      <TableRow
                        key={m.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setDetailId(m.id)}
                      >
                        {crossTenantMode && (
                          <TableCell className="hidden md:table-cell text-xs text-muted-foreground truncate max-w-[160px]" title={tenantName}>
                            {tenantName}
                          </TableCell>
                        )}
                        <TableCell className="font-medium text-sm truncate max-w-[200px]">{m.to_email}</TableCell>
                        <TableCell className="text-sm truncate max-w-[240px]">{m.subject || "—"}</TableCell>
                        <TableCell>
                          <Badge className={meta.className + " gap-1"}>
                            <Icon className="size-3" /> {t(meta.labelKey)}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs uppercase text-muted-foreground">{m.provider || "—"}</TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-destructive truncate max-w-[180px]" title={m.error || ""}>
                          {m.error || "—"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          {m.entity_type ? ENTITY_LABEL[m.entity_type] || m.entity_type : "—"}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs">{fmtRelative(m.created_at)}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(m.id)} title={t("view")}>
                              <Eye className="size-4" />
                            </Button>
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

      {/* Detail sheet — the EXACT text that was sent */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Mail className="size-5" />
              {t("elog-detail-title")}
            </SheetTitle>
            <SheetDescription>{t("elog-detail-desc")}</SheetDescription>
          </SheetHeader>
          {detailId ? (
            <EmailLogDetailSheet id={detailId} />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---- Detail panel ----
function EmailLogDetailSheet({ id }: { id: string }) {
  const api = useApiUrl();
  const t = useT();
  const [bodyTab, setBodyTab] = useState<"preview" | "html" | "text">("preview");

  const { data, isLoading } = useQuery({
    queryKey: ["email-log-detail", id],
    queryFn: async () => {
      const r = await fetch(api(`/api/email-log/${id}`));
      if (!r.ok) throw new Error("Failed to load email");
      return r.json() as Promise<{ item: EmailLogDetail }>;
    },
  });

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const item = data?.item;
  if (!item) {
    return (
      <div className="p-4">
        <EmptyState
          icon={<Mail className="size-6" />}
          title={t("elog-detail-not-found-title")}
          description={t("elog-detail-not-found-desc")}
        />
      </div>
    );
  }

  const meta = STATUS_META[item.status] ?? STATUS_META.failed;
  const Icon = meta.icon;

  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={meta.className + " gap-1"}>
          <Icon className="size-3" /> {t(meta.labelKey)}
        </Badge>
        {item.provider && (
          <Badge variant="outline" className="uppercase">{item.provider}</Badge>
        )}
        {item.entity_type && (
          <Badge variant="outline" className="gap-1">
            <FileText className="size-3" /> {ENTITY_LABEL[item.entity_type] || item.entity_type}
          </Badge>
        )}
      </div>

      <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/10">
        <CardContent className="p-3 flex items-start gap-2.5">
          {item.status === "sent" ? (
            <MailCheck className="size-4 text-emerald-600 mt-0.5 shrink-0" />
          ) : item.status === "unknown" ? (
            <HelpCircle className="size-4 text-amber-600 mt-0.5 shrink-0" />
          ) : (
            <Ban className="size-4 text-destructive mt-0.5 shrink-0" />
          )}
          <p className="text-xs text-muted-foreground">
            {item.status === "sent" && t("elog-detail-note-sent")}
            {item.status === "unknown" && t("elog-detail-note-unknown")}
            {item.status === "failed" && t("elog-detail-note-failed")}
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-mail-recipient")}</p>
          <p className="text-sm font-medium truncate">{item.to_email}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-mail-subject")}</p>
          <p className="text-sm truncate" title={item.subject || ""}>{item.subject || "—"}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-col-created")}</p>
          <p className="text-sm">{fmtDateTime(item.created_at)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("admin-mail-sent-at")}</p>
          <p className="text-sm">{item.sent_at ? fmtDateTime(item.sent_at) : "—"}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("elog-col-from")}</p>
          <p className="text-sm truncate">{item.from_email || "—"}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">{t("elog-col-message-id")}</p>
          <p className="text-xs font-mono truncate" title={item.message_id || ""}>{item.message_id || "—"}</p>
        </CardContent></Card>
      </div>

      {item.error && (
        <Card className="border-destructive/40">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">{t("elog-detail-error")}</p>
            <p className="text-sm text-destructive whitespace-pre-wrap">{item.error}</p>
          </CardContent>
        </Card>
      )}

      {/* The EXACT text that was sent — audit requirement */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted-foreground">{t("elog-detail-body")}</p>
          <div className="flex items-center gap-1">
            <Button size="sm" variant={bodyTab === "preview" ? "default" : "ghost"} className="h-7 text-xs gap-1" onClick={() => setBodyTab("preview")}>
              <MonitorPlay className="size-3" /> {t("elog-body-preview")}
            </Button>
            <Button size="sm" variant={bodyTab === "html" ? "default" : "ghost"} className="h-7 text-xs gap-1" onClick={() => setBodyTab("html")}>
              <Code2 className="size-3" /> HTML
            </Button>
            <Button size="sm" variant={bodyTab === "text" ? "default" : "ghost"} className="h-7 text-xs gap-1" onClick={() => setBodyTab("text")}>
              <FileText className="size-3" /> {t("elog-body-text")}
            </Button>
          </div>
        </div>

        {bodyTab === "preview" && (
          item.body_html ? (
            <div className="rounded-md border border-border/60 bg-white dark:bg-muted/40 overflow-hidden">
              <iframe
                title={t("elog-detail-body")}
                srcDoc={item.body_html}
                sandbox=""
                className="w-full h-[400px] block bg-white"
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground p-3 rounded-md border border-border/60">{t("elog-body-empty")}</p>
          )
        )}
        {bodyTab === "html" && (
          <pre className="text-xs font-mono whitespace-pre-wrap p-3 rounded-md bg-muted/50 border border-border/60 max-h-[400px] overflow-y-auto custom-scroll">
{item.body_html || t("elog-body-empty")}
          </pre>
        )}
        {bodyTab === "text" && (
          <pre className="text-xs font-mono whitespace-pre-wrap p-3 rounded-md bg-muted/50 border border-border/60 max-h-[400px] overflow-y-auto custom-scroll">
{item.body_text || t("elog-body-no-text")}
          </pre>
        )}
      </div>

      <div className="rounded-md border border-border/60 bg-muted/30 p-3 flex items-start gap-2">
        <Inbox className="size-4 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          {t("elog-detail-no-retry-note")}
        </p>
      </div>
    </div>
  );
}
