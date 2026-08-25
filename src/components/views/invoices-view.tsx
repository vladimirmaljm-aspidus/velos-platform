"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useNewShortcut } from "@/lib/hooks/use-new-shortcut";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Plus, Search, FileText, Pencil, Trash2, Eye, X, Calendar, Send, CheckCircle2, Clock, Download, AlertTriangle, Wallet, Receipt, ChevronDown, ChevronRight, Sparkles, Zap, FileDown, DollarSign, Loader2, ArrowLeftRight, Info, History, Ban, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtMoney, fmtDate, fmtDateTime, fmtNumber } from "@/lib/utils/format";
import { Invoice, InvoiceStatus, OfferLineItem, Offer, Partner, Product } from "@/lib/supabase/types";
import { CURRENCIES, INVOICE_STATUSES, PAYMENT_TERMS_LOCAL } from "@/lib/data/reference";
import { UnitSelect } from "@/components/common/unit-select";
import { ProductPicker } from "@/components/common/product-picker";
import { PartnerPicker } from "@/components/common/partner-picker";
import { convertUnitPrice, describeConversion } from "@/lib/utils/unit-conversion";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { downloadPdf } from "@/lib/utils/download";
import { usePageSize } from "@/lib/hooks/use-page-size";
import { PageSizeSelector } from "@/components/common/page-size-selector";
import { useT } from "@/lib/i18n/store";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionBar, useRowSelection } from "@/components/common/bulk-action-bar";

const STATUS_LABEL_KEYS: Record<InvoiceStatus, string> = {
  draft: "fin-status-draft",
  sent: "fin-status-sent",
  paid: "fin-status-paid",
  overdue: "fin-status-overdue",
  cancelled: "fin-status-cancelled",
};

const PAYMENT_TERMS_OPTION_KEYS: Record<string, string> = {
  immediate: "fin-immediate-payment-term",
  net15: "Net 15",
  net30: "Net 30",
  net45: "Net 45",
  net60: "Net 60",
  net90: "Net 90",
};

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const t = useT();
  if (status === "draft") return <Badge variant="secondary">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "overdue") return <Badge variant="destructive">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "paid") return <Badge className="border-transparent bg-emerald-600 text-white">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "sent") return <Badge className="border-transparent bg-[var(--chart-1)] text-white">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  return <Badge className="border-transparent bg-muted text-muted-foreground">{t(STATUS_LABEL_KEYS[status])}</Badge>;
}

function lineTotal(it: OfferLineItem): number {
  const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
  const disc = line * (Number(it.discount) || 0) / 100;
  const net = line - disc;
  const tax = net * (Number(it.tax_rate) || 0) / 100;
  return net + tax;
}

function computeTotals(items: OfferLineItem[]) {
  let subtotal = 0, discount_total = 0, tax_total = 0, total = 0;
  for (const it of items) {
    const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
    const disc = line * (Number(it.discount) || 0) / 100;
    const net = line - disc;
    const tax = net * (Number(it.tax_rate) || 0) / 100;
    subtotal += line;
    discount_total += disc;
    tax_total += tax;
    total += net + tax;
  }
  return { subtotal, discount_total, tax_total, total };
}

function isOverdue(inv: Invoice): boolean {
  if (inv.status === "overdue" || inv.status === "paid" || inv.status === "cancelled") return inv.status === "overdue";
  if (!inv.due_date) return false;
  return new Date(inv.due_date).getTime() < Date.now();
}

/** Calculate due date from payment terms */
function calculateDueDate(paymentTerms: string): Date {
  const now = new Date();
  // Handle immediate / advance / due-on-receipt (0 days)
  const normalized = (paymentTerms || "").toLowerCase().trim();
  if (
    normalized === "immediate" ||
    normalized === "advance" ||
    normalized === "advance_100" ||
    normalized === "tt_advance" ||
    normalized === "due on receipt" ||
    normalized === "cia" ||
    normalized === "lc_sight" ||
    normalized === "lc_confirmed" ||
    normalized === "lc_transferable" ||
    normalized === "dp" ||
    normalized === "cad" ||
    normalized === "30_70_bl" ||
    normalized === "20_80_bl" ||
    normalized === "50_50" ||
    normalized === "40_60_proforma"
  ) {
    return now;
  }
  // Match "net30", "Net 30", "net 30", "net15" etc.
  const match = paymentTerms.match(/net\s*(\d+)/i);
  if (match) {
    const days = parseInt(match[1], 10);
    now.setDate(now.getDate() + days);
    return now;
  }
  // Letter of Credit: lc_30, lc_60, lc_90
  const lcMatch = paymentTerms.match(/lc[_\s]*(\d+)/i);
  if (lcMatch) {
    const days = parseInt(lcMatch[1], 10);
    now.setDate(now.getDate() + days);
    return now;
  }
  // Documents against Acceptance: default 60 days
  if (/da$/i.test(normalized)) {
    now.setDate(now.getDate() + 60);
    return now;
  }
  // Default to Net 30
  now.setDate(now.getDate() + 30);
  return now;
}

export function InvoicesView() {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [partnerFilter, setPartnerFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showOfferPicker, setShowOfferPicker] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { pageSize: PAGE_SIZE, setPageSize, options: pageSizeOptions } = usePageSize("invoices", 20);
// eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(0); }, [PAGE_SIZE, debouncedSearch, statusFilter, partnerFilter]);

  const { data, isLoading } = useQuery({
    queryKey: ["invoices", tenantKey, debouncedSearch, statusFilter, partnerFilter, page, PAGE_SIZE],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (partnerFilter !== "all") params.set("partner_id", partnerFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const r = await fetch(api(`/api/invoices?${params}`));
      if (!r.ok) throw new Error("Failed to load invoices");
      return r.json() as Promise<{ items: Invoice[]; total: number }>;
    },
  });
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Unfiltered list for KPI rollups
  const kpiQuery = useQuery({
    queryKey: ["invoices", tenantKey, "kpi"],
    queryFn: async () => {
      const r = await fetch(api(`/api/invoices?limit=500`));
      if (!r.ok) throw new Error("Failed to load KPI data");
      return r.json() as Promise<{ items: Invoice[]; total: number }>;
    },
  });

  const partners = useQuery({
    queryKey: ["partners", tenantKey, "list", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=200`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  const detail = useQuery({
    queryKey: ["invoice", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/invoices/${detailId}`));
      if (!r.ok) throw new Error("Failed to load invoice");
      return r.json() as Promise<Invoice>;
    },
    enabled: !!detailId,
  });

  // Mark as sent mutation
  const markSentMut = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const r = await fetch(api(`/api/invoices/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "sent", sent_at: new Date().toISOString() }),
      });
      if (!r.ok) throw new Error("Failed to mark as sent");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("fin-invoice-marked-sent"));
      qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
      if (detailId) qc.invalidateQueries({ queryKey: ["invoice", tenantKey, detailId] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: () => toast.error(t("fin-could-not-update-invoice")),
  });

  // ─── Send invoice to portal (email + status + portal notification) ───
  const sendMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/invoices/${id}/send`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("fin-failed-send-invoice"));
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("fin-invoice-sent-portal"));
      qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
      if (detailId) qc.invalidateQueries({ queryKey: ["invoice", tenantKey, detailId] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: (e: any) => toast.error(e.message || t("fin-failed-send-invoice")),
  });

  const markPaidMut = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const r = await fetch(api(`/api/invoices/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
      });
      if (!r.ok) throw new Error("Failed to mark as paid");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("fin-invoice-marked-paid"));
      qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
      if (detailId) qc.invalidateQueries({ queryKey: ["invoice", tenantKey, detailId] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: () => toast.error(t("fin-could-not-update-invoice")),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/invoices/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to delete invoice");
    },
    onSuccess: () => {
      toast.success(t("fin-invoice-deleted"));
      qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("fin-delete-failed")),
  });

  // Create invoice from offer mutation
  const createFromOfferMut = useMutation({
    mutationFn: async ({ offer_id }: { offer_id: string }) => {
      const r = await fetch(api(`/api/automation/create-invoice-from-offer`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("fin-failed-create-invoice-offer"));
      }
      return r.json() as Promise<Invoice>;
    },
    onSuccess: (created) => {
      toast.success(t("fin-invoice-created-from-offer"), { description: created.number });
      qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setShowOfferPicker(false);
      // Open the newly created invoice for editing
      setEditing(created);
      setShowForm(true);
    },
    onError: (e: any) => toast.error(e.message || t("fin-failed-create-invoice-offer")),
  });

  const items = data?.items || [];
  const partnerList = partners.data?.items || [];
  const partnerName = (id: string) => partnerList.find((p) => p.id === id)?.name || "—";
  const rowSel = useRowSelection(items);

  // ── Bulk invoice mutations ──────────────────────────────────────────
  // All bulk invoice operations route through /api/invoices/bulk so the
  // loop runs server-side (one round-trip, one audit log entry, state
  // machine enforced by validateStatusTransition).
  const bulkInvoiceMut = useMutation({
    mutationFn: async ({ ids, action }: {
      ids: string[];
      action: "mark_sent" | "mark_paid" | "cancel" | "delete";
    }) => {
      const r = await fetch(api("/api/invoices/bulk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Bulk operation failed");
      }
      return (await r.json()) as { successCount: number; failureCount: number };
    },
    onSuccess: (data, vars) => {
      const labelKey =
        vars.action === "mark_sent" ? "fin-bulk-mark-sent-success"
        : vars.action === "mark_paid" ? "fin-bulk-mark-paid-success"
        : vars.action === "cancel" ? "fin-bulk-cancel-success"
        : "fin-bulk-delete-invoices-success";
      const partialKey =
        vars.action === "mark_sent" ? "fin-bulk-mark-sent-partial"
        : vars.action === "mark_paid" ? "fin-bulk-mark-paid-partial"
        : vars.action === "cancel" ? "fin-bulk-cancel-partial"
        : "fin-bulk-delete-invoices-partial";
      if (data.failureCount === 0) {
        toast.success(t(labelKey).replace("${n}", String(data.successCount)));
      } else {
        toast.warning(
          t(partialKey)
            .replace("${ok}", String(data.successCount))
            .replace("${fail}", String(data.failureCount)),
        );
      }
      qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      rowSel.clear();
    },
    onError: (e: any, vars) => {
      const labelKey =
        vars.action === "mark_sent" ? "fin-bulk-mark-sent-failed"
        : vars.action === "mark_paid" ? "fin-bulk-mark-paid-failed"
        : vars.action === "cancel" ? "fin-bulk-cancel-failed"
        : "fin-bulk-delete-invoices-failed";
      toast.error(e?.message || t(labelKey));
    },
  });

  const bulkExportSelected = () => {
    if (rowSel.ids.length === 0) return;
    const url = `/api/export?type=invoices&format=csv&ids=${encodeURIComponent(rowSel.ids.join(","))}`;
    window.open(url, "_blank");
  };

  // KPI computations
  const kpis = useMemo(() => {
    const all = kpiQuery.data?.items || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let outstanding = 0;
    let overdueCount = 0;
    let paidThisMonth = 0;
    for (const inv of all) {
      if (inv.status === "sent" || inv.status === "overdue") {
        outstanding += Number(inv.total) || 0;
      }
      if (inv.status === "overdue") overdueCount += 1;
      if (inv.status === "paid" && inv.paid_at && new Date(inv.paid_at) >= monthStart) {
        paidThisMonth += Number(inv.total) || 0;
      }
    }
    return { outstanding, overdueCount, paidThisMonth };
  }, [kpiQuery.data]);

  return (
    <div>
      <PageHeader
        title={t("invoices")}
        description={t("fin-total-count").replace("${n}", String(data?.total ?? 0))}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => window.open("/api/invoices/export?format=csv", "_blank")}>
              <Download className="size-4 mr-1" /> {t("fin-export-csv")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowOfferPicker(true)}
              className="gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
            >
              <Zap className="size-4" /> {t("fin-from-offer")}
            </Button>
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("fin-new-invoice")}
            </Button>
          </div>
        }
      />

      {/* KPI summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <KpiCard
          label={t("fin-total-outstanding")}
          value={fmtMoney(kpis.outstanding, "USD")}
          sub={t("fin-sent-plus-overdue")}
          icon={Wallet}
        />
        <KpiCard
          label={t("fin-overdue-label")}
          value={kpis.overdueCount}
          sub={t("fin-past-due-date")}
          icon={AlertTriangle}
          iconClassName={kpis.overdueCount > 0 ? "text-destructive" : undefined}
        />
        <KpiCard
          label={t("fin-paid-this-month")}
          value={fmtMoney(kpis.paidThisMonth, "USD")}
          sub={new Date().toLocaleString("en-US", { month: "long", year: "numeric" })}
          icon={CheckCircle2}
          iconClassName="text-success"
        />
      </div>

      <Card className="mb-4 border-border/60 shadow-soft">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("fin-search-number-subject")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("fin-all-statuses")}</SelectItem>
              <SelectItem value="draft">{t("fin-status-draft")}</SelectItem>
              <SelectItem value="sent">{t("fin-status-sent")}</SelectItem>
              <SelectItem value="paid">{t("fin-status-paid")}</SelectItem>
              <SelectItem value="overdue">{t("fin-status-overdue")}</SelectItem>
              <SelectItem value="cancelled">{t("fin-status-cancelled")}</SelectItem>
            </SelectContent>
          </Select>
          <PartnerPicker
            value={partnerFilter === "all" ? "" : partnerFilter}
            allowClear
            placeholder={t("fin-partner")}
            onSelect={(p) => setPartnerFilter(p?.id || "all")}
            className="md:w-48"
          />
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Receipt className="size-6" />}
              title={t("fin-no-invoices")}
              description={t("fin-no-invoices-desc")}
              action={
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setShowOfferPicker(true)} className="gap-1.5 border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400">
                    <Zap className="size-4" /> {t("fin-from-offer")}
                  </Button>
                  <Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("fin-new-invoice")}</Button>
                </div>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
              <div className="overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={rowSel.allOnPageSelected}
                        onCheckedChange={rowSel.toggleAllOnPage}
                        aria-label={t("fin-select-all-on-page-label")}
                      />
                    </TableHead>
                    <TableHead>{t("fin-number")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("fin-subject")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("fin-partner")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead className="text-right">{t("fin-total-col")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("fin-issued")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("fin-due")}</TableHead>
                    <TableHead className="text-right">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((inv) => {
                    const overdue = isOverdue(inv);
                    return (
                      <TableRow
                        key={inv.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setDetailId(inv.id)}
                        data-state={rowSel.isSelected(inv.id) ? "selected" : undefined}
                      >
                        <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={rowSel.isSelected(inv.id)}
                            onCheckedChange={() => rowSel.toggle(inv.id)}
                            aria-label={t("fin-select-invoice-aria").replace("${number}", inv.number || inv.id)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{inv.number}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="font-medium truncate max-w-[200px]">{inv.subject || "—"}</div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">{partnerName(inv.partner_id)}</TableCell>
                        <TableCell><StatusBadge status={inv.status} /></TableCell>
                        <TableCell className="text-right tabular">{fmtMoney(inv.total, inv.currency)}</TableCell>
                        <TableCell className="hidden xl:table-cell">{fmtDate(inv.issue_date)}</TableCell>
                        <TableCell className="hidden xl:table-cell">
                          <span className={overdue ? "text-destructive font-medium" : ""}>{fmtDate(inv.due_date)}</span>
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="size-8" title={t("fin-quick-actions-tooltip")} aria-label={t("fin-quick-actions-tooltip")}>
                                  <ChevronDown className="size-4" aria-hidden="true" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuLabel className="text-xs text-muted-foreground">{t("fin-quick-actions-label")}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {inv.status === "draft" && (
                                  <DropdownMenuItem onClick={() => markSentMut.mutate({ id: inv.id })} disabled={markSentMut.isPending}>
                                    <Send className="size-4 mr-2" /> {t("fin-mark-as-sent")}
                                  </DropdownMenuItem>
                                )}
                                {(inv.status === "sent" || inv.status === "overdue") && (
                                  <DropdownMenuItem onClick={() => markPaidMut.mutate({ id: inv.id })} disabled={markPaidMut.isPending}>
                                    <CheckCircle2 className="size-4 mr-2" /> {t("fin-mark-as-paid")}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={async () => {
                                    try {
                                      setDownloadingId(inv.id);
                                      await downloadPdf(
                                        api(`/api/invoices/${inv.id}/pdf`),
                                        `Invoice_${inv.number || inv.id}.pdf`,
                                      );
                                      toast.success(t("fin-pdf-downloaded"));
                                    } catch (e: any) {
                                      toast.error(e?.message || t("fin-failed-download-pdf"));
                                    } finally {
                                      setDownloadingId(null);
                                    }
                                  }}
                                  disabled={downloadingId === inv.id}
                                  className="flex items-center"
                                >
                                  {downloadingId === inv.id ? (
                                    <Loader2 className="size-4 mr-2 animate-spin" />
                                  ) : (
                                    <FileDown className="size-4 mr-2" />
                                  )}
                                  {t("fin-download-pdf")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => setDetailId(inv.id)}>
                                  <Eye className="size-4 mr-2" /> {t("fin-view-details")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => { setEditing(inv); setShowForm(true); }}>
                                  <Pencil className="size-4 mr-2" /> {t("edit")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteId(inv.id)}
                                >
                                  <Trash2 className="size-4 mr-2" /> {t("delete")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(inv.id)} title={t("view")} aria-label={t("view")}>
                              <Eye className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
            </div>
          )}
          {/* Pagination + Page size */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-border/60 gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground">
              {total > 0
                ? <>{t("fin-showing-range").replace("${from}", String(page * PAGE_SIZE + 1)).replace("${to}", String(Math.min((page + 1) * PAGE_SIZE, total))).replace("${total}", String(total))}</>
                : <>{t("fin-no-results")}</>}
            </p>
            <div className="flex items-center gap-3">
              <PageSizeSelector value={PAGE_SIZE} onChange={setPageSize} options={pageSizeOptions} />
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    {t("previous")}
                  </Button>
                  <span className="text-sm px-2 tabular-nums">{page + 1} / {totalPages}</span>
                  <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                    {t("next")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Form dialog */}
      <InvoiceFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        invoice={editing}
        partners={partnerList}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Create from Offer dialog */}
      <CreateFromOfferDialog
        open={showOfferPicker}
        onOpenChange={setShowOfferPicker}
        onCreateFromOffer={(offerId) => createFromOfferMut.mutate({ offer_id: offerId })}
        isCreating={createFromOfferMut.isPending}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Receipt className="size-5" />
              <span className="font-mono text-base">{detail.data?.number || t("fin-invoice-label")}</span>
            </SheetTitle>
            <SheetDescription>{detail.data?.subject || t("fin-invoice-details")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <InvoiceDetail
              invoice={detail.data}
              partnerName={partnerName(detail.data.partner_id)}
              onMarkPaid={() => detailId && markPaidMut.mutate({ id: detailId })}
              onMarkSent={() => detailId && markSentMut.mutate({ id: detailId })}
              onSend={() => detailId && sendMut.mutate(detailId)}
              markingPaid={markPaidMut.isPending}
              markingSent={markSentMut.isPending}
              sending={sendMut.isPending}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("fin-delete-invoice-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("fin-delete-invoice-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BulkActionBar
        count={rowSel.count}
        onClear={rowSel.clear}
        label={rowSel.count === 1 ? t("fin-invoice-selected") : t("fin-invoices-selected")}
        actions={[
          {
            key: "mark-sent",
            label: t("fin-bulk-mark-sent-label"),
            icon: <Send className="size-4" />,
            variant: "default",
            disabled: bulkInvoiceMut.isPending,
            confirm: t("fin-bulk-mark-sent-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkInvoiceMut.mutate({ ids: rowSel.ids, action: "mark_sent" }),
          },
          {
            key: "mark-paid",
            label: t("fin-bulk-mark-paid-label"),
            icon: <CheckCircle2 className="size-4" />,
            variant: "outline",
            disabled: bulkInvoiceMut.isPending,
            confirm: t("fin-bulk-mark-paid-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkInvoiceMut.mutate({ ids: rowSel.ids, action: "mark_paid" }),
          },
          {
            key: "cancel",
            label: t("fin-bulk-cancel-label"),
            icon: <Ban className="size-4" />,
            variant: "outline",
            disabled: bulkInvoiceMut.isPending,
            confirm: t("fin-bulk-cancel-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkInvoiceMut.mutate({ ids: rowSel.ids, action: "cancel" }),
          },
          {
            key: "export-selected",
            label: t("fin-bulk-export-selected"),
            icon: <FileDown className="size-4" />,
            variant: "outline",
            disabled: rowSel.count === 0,
            onClick: bulkExportSelected,
          },
          {
            key: "delete",
            label: t("delete"),
            icon: <Trash2 className="size-4" />,
            variant: "destructive",
            disabled: bulkInvoiceMut.isPending,
            confirm: t("fin-bulk-delete-invoices-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkInvoiceMut.mutate({ ids: rowSel.ids, action: "delete" }),
          },
        ]}
      />
    </div>
  );
}

// ---- Create from Offer dialog ----
function CreateFromOfferDialog({
  open, onOpenChange, onCreateFromOffer, isCreating,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreateFromOffer: (offerId: string) => void;
  isCreating: boolean;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [searchOffer, setSearchOffer] = useState("");

  const { data: offersData, isLoading: offersLoading } = useQuery({
    queryKey: ["offers", tenantKey, "accepted-sent"],
    queryFn: async () => {
      const r = await fetch(api(`/api/offers?limit=100`));
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json() as Promise<{ items: Offer[]; total: number }>;
    },
    enabled: open,
  });

  const acceptedOffers = useMemo(() => {
    const all = offersData?.items || [];
    return all
      .filter((o) => o.status === "accepted" || o.status === "sent")
      .filter((o) =>
        !searchOffer ||
        o.number.toLowerCase().includes(searchOffer.toLowerCase()) ||
        o.subject.toLowerCase().includes(searchOffer.toLowerCase())
      );
  }, [offersData, searchOffer]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-emerald-500" />
            {t("fin-create-invoice-from-offer")}
          </DialogTitle>
          <DialogDescription>
            {t("fin-select-offer-invoice-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">

        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder={t("fin-search-offers-placeholder")}
            value={searchOffer}
            onChange={(e) => setSearchOffer(e.target.value)}
            className="pl-9"
          />
        </div>

        {offersLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
          </div>
        ) : acceptedOffers.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <FileText className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t("fin-no-accepted-offers")}</p>
            <p className="text-xs mt-1">{t("fin-accept-offer-first")}</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto custom-scroll pr-1">
            {acceptedOffers.map((offer) => (
              <Card
                key={offer.id}
                className="border-border/60 hover:border-emerald-400/50 hover:shadow-soft cursor-pointer transition-all duration-200"
                onClick={() => onCreateFromOffer(offer.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs font-medium">{offer.number}</span>
                        <Badge
                          variant="secondary"
                          className={
                            offer.status === "accepted"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                              : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                          }
                        >
                          {offer.status === "accepted" ? t("fin-status-accepted") : t("fin-status-sent")}
                        </Badge>
                      </div>
                      <p className="text-sm font-medium truncate">{offer.subject}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {offer.currency} {fmtMoney(offer.total, offer.currency)} · {offer.items?.length || 0} {t("fin-items-suffix")}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      disabled={isCreating}
                      className="bg-emerald-600 text-white hover:bg-emerald-700 shrink-0"
                      onClick={(e) => { e.stopPropagation(); onCreateFromOffer(offer.id); }}
                    >
                      {isCreating ? (
                        <span className="flex items-center gap-1"><span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> {t("fin-creating")}</span>
                      ) : (
                        <>
                          <Zap className="size-3.5 mr-1" /> {t("fin-create")}
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Detail panel ----
function InvoiceDetail({
  invoice, partnerName, onMarkPaid, onMarkSent, onSend, markingPaid, markingSent, sending,
}: {
  invoice: Invoice;
  partnerName: string;
  onMarkPaid: () => void;
  onMarkSent: () => void;
  onSend: () => void;
  markingPaid: boolean;
  markingSent: boolean;
  sending: boolean;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const [downloading, setDownloading] = useState(false);
  const totals = computeTotals(invoice.items || []);
  const overdue = isOverdue(invoice);

  const canRecordPayment = invoice.status !== "paid" && invoice.status !== "cancelled" && invoice.status !== "draft";

  // ─── Auto-saved revisions (from recordRevision in the API layer) ───
  const revisions = useQuery({
    queryKey: ["document-revisions", tenantKey, invoice.id],
    queryFn: async () => {
      try {
        const r = await fetch(api(`/api/document-revisions/${invoice.id}`));
        if (!r.ok) return [];
        const data = await r.json();
        return ((data.items || []) as any[]).sort(
          (a, b) => (b.version || 0) - (a.version || 0),
        );
      } catch {
        return [];
      }
    },
    enabled: !!invoice.id,
  });
  const revisionList = revisions.data || [];

  return (
    <div className="px-4 pb-6">
      {/* Quick Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={invoice.status} />
          <span className="text-sm text-muted-foreground">{partnerName}</span>
        </div>
        <div className="flex items-center gap-2">
          {invoice.status === "draft" && (
            <Button size="sm" onClick={onSend} disabled={sending} variant="default" className="gap-1">
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("send")}
            </Button>
          )}
          {invoice.status === "draft" && (
            <Button size="sm" onClick={onMarkSent} disabled={markingSent} variant="outline" className="gap-1">
              <Send className="size-3.5" /> {t("fin-mark-as-sent")}
            </Button>
          )}
          {canRecordPayment && (
            <RecordPaymentDialog invoice={invoice} />
          )}
          {invoice.status !== "paid" && invoice.status !== "cancelled" && (
            <Button size="sm" onClick={onMarkPaid} disabled={markingPaid} className="bg-emerald-600 text-white hover:bg-emerald-700 gap-1">
              <CheckCircle2 className="size-3.5" /> {t("fin-mark-as-paid")}
            </Button>
          )}
        </div>
      </div>

      {/* Key-value header */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="size-3" /> {t("fin-issue-date")}</p>
          <p className="text-sm font-medium">{fmtDate(invoice.issue_date)}</p>
        </div>
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="size-3" /> {t("fin-due-date")}</p>
          <p className={`text-sm font-medium ${overdue ? "text-destructive" : ""}`}>{fmtDate(invoice.due_date)}</p>
        </div>
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Send className="size-3" /> {t("fin-sent-label")}</p>
          <p className="text-sm font-medium">{fmtDateTime(invoice.sent_at)}</p>
        </div>
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><CheckCircle2 className="size-3" /> {t("fin-paid-label")}</p>
          <p className="text-sm font-medium">{fmtDateTime(invoice.paid_at)}</p>
        </div>
      </div>

      {/* Line items table */}
      <div className="rounded-md border overflow-hidden mb-4">
        <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("fin-product")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("fin-sku")}</TableHead>
              <TableHead className="text-right">{t("fin-qty")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("fin-unit")}</TableHead>
              <TableHead className="text-right">{t("fin-price")}</TableHead>
              <TableHead className="text-right hidden sm:table-cell">{t("fin-disc-percent")}</TableHead>
              <TableHead className="text-right hidden sm:table-cell">{t("fin-tax-percent")}</TableHead>
              <TableHead className="text-right">{t("fin-total-col")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(invoice.items || []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-6">
                  {t("fin-no-line-items")}
                </TableCell>
              </TableRow>
            ) : (invoice.items || []).map((it, i) => (
              <TableRow key={i}>
                <TableCell>
                  <div className="font-medium">{it.product_name || "—"}</div>
                  <div className="text-xs text-muted-foreground sm:hidden">{it.sku || "—"}</div>
                </TableCell>
                <TableCell className="hidden sm:table-cell font-mono text-xs">{it.sku || "—"}</TableCell>
                <TableCell className="text-right tabular">{fmtNumber(it.quantity)}</TableCell>
                <TableCell className="hidden sm:table-cell text-xs">{it.unit || "—"}</TableCell>
                <TableCell className="text-right tabular">{fmtMoney(it.unit_price, invoice.currency)}</TableCell>
                <TableCell className="text-right tabular hidden sm:table-cell">{it.discount}%</TableCell>
                <TableCell className="text-right tabular hidden sm:table-cell">{it.tax_rate}%</TableCell>
                <TableCell className="text-right tabular font-medium">{fmtMoney(lineTotal(it), invoice.currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      </div>

      {/* Totals */}
      <div className="ml-auto w-full sm:w-72 space-y-1 mb-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("fin-subtotal")}</span>
          <span className="tabular">{fmtMoney(invoice.subtotal ?? totals.subtotal, invoice.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("fin-discount")}</span>
          <span className="tabular">- {fmtMoney(invoice.discount_total ?? totals.discount_total, invoice.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("fin-tax")}</span>
          <span className="tabular">{fmtMoney(invoice.tax_total ?? totals.tax_total, invoice.currency)}</span>
        </div>
        <div className="flex justify-between border-t pt-1 mt-1 text-base font-semibold">
          <span>{t("fin-total-col")}</span>
          <span className="tabular">{fmtMoney(invoice.total ?? totals.total, invoice.currency)}</span>
        </div>
      </div>

      {/* Notes */}
      {invoice.notes && (
        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1">{t("fin-notes")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/40">{invoice.notes}</p>
        </div>
      )}

      {/* Quick Actions Footer */}
      <div className="pt-3 border-t flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={downloading}
          onClick={async () => {
            try {
              setDownloading(true);
              const filename = `Invoice_${invoice.number || invoice.id}.pdf`;
              await downloadPdf(api(`/api/invoices/${invoice.id}/pdf`), filename);
              toast.success(t("fin-pdf-downloaded"));
            } catch (e: any) {
              toast.error(e?.message || t("fin-failed-download-pdf"));
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Download className="size-4 mr-1" />}
          {t("fin-download-pdf")}
        </Button>
        {invoice.status === "draft" && (
          <Button size="sm" variant="default" onClick={onSend} disabled={sending} className="gap-1">
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("send")}
          </Button>
        )}
        {invoice.status === "draft" && (
          <Button size="sm" variant="outline" onClick={onMarkSent} disabled={markingSent} className="gap-1">
            <Send className="size-3.5" /> {t("fin-mark-as-sent")}
          </Button>
        )}
        {canRecordPayment && (
          <RecordPaymentDialog invoice={invoice} triggerVariant="footer" />
        )}
        {invoice.status !== "paid" && invoice.status !== "cancelled" && (
          <Button size="sm" onClick={onMarkPaid} disabled={markingPaid} className="bg-emerald-600 text-white hover:bg-emerald-700 gap-1">
            <CheckCircle2 className="size-3.5" /> {t("fin-mark-as-paid")}
          </Button>
        )}
      </div>

      {/* Version History (auto-saved revisions) */}
      <div className="pt-4 mt-4 border-t">
        <h4 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
          <History className="size-4" /> {t("fin-version-history")}
          <Badge variant="outline" className="ml-1 font-mono text-xs">
            v{(invoice as any).version || 1}
          </Badge>
        </h4>
        {revisions.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : revisionList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-center">
            <History className="size-6 text-muted-foreground/40 mx-auto mb-1" />
            <p className="text-sm text-muted-foreground">{t("fin-no-revisions")}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("fin-no-revisions-desc-invoice")}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border/60 overflow-hidden">
            <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-20">{t("fin-version")}</TableHead>
                  <TableHead>{t("fin-changes")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-32">{t("fin-author")}</TableHead>
                  <TableHead className="w-36">{t("date")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {revisionList.map((rev: any, i: number) => {
                  const fields: any[] = Array.isArray(rev.changed_fields) ? rev.changed_fields : [];
                  return (
                    <TableRow key={rev.id || i}>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          V{rev.version}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm align-top">
                        {rev.change_note ? (
                          <p className="mb-1">{rev.change_note}</p>
                        ) : null}
                        {fields.length > 0 ? (
                          <div className="space-y-1">
                            {fields.slice(0, 4).map((c: any, idx: number) => (
                              <div key={idx} className="text-xs">
                                <span className="font-medium">{c.field}:</span>{" "}
                                <span className="text-red-600 dark:text-red-400 line-through">
                                  {String(c.before ?? "").slice(0, 40) || "∅"}
                                </span>{" "}
                                →{" "}
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  {String(c.after ?? "").slice(0, 40) || "∅"}
                                </span>
                              </div>
                            ))}
                            {fields.length > 4 ? (
                              <div className="text-xs text-muted-foreground">
                                +{fields.length - 4} {t("fin-more-fields-suffix")}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-sm text-muted-foreground align-top">
                        {rev.changed_by_username || rev.created_by || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums align-top">
                        {fmtDateTime(rev.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Record Payment dialog ----
function RecordPaymentDialog({
  invoice,
  triggerVariant = "header",
}: {
  invoice: Invoice;
  triggerVariant?: "header" | "footer";
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<string>(
    invoice.total != null ? String(invoice.total) : ""
  );
  const [method, setMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [submitting, setSubmitting] = useState(false);

  // Re-sync the default amount when the invoice prop changes.
  useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setAmount(invoice.total != null ? String(invoice.total) : "");
    }
  }, [invoice.id, invoice.total, open]);

  async function handleSubmit() {
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      toast.error(t("fin-enter-valid-amount"));
      return;
    }
    if (!method) {
      toast.error(t("fin-select-payment-method"));
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(api(`/api/invoices/${invoice.id}/record-payment`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: numAmount,
          method,
          reference: reference || undefined,
          payment_date: paymentDate || undefined,
        }),
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        toast.success(
          data?.status === "partial"
            ? t("fin-partial-payment-recorded")
            : t("fin-payment-recorded-paid")
        );
        qc.invalidateQueries({ queryKey: ["invoices", tenantKey] });
        qc.invalidateQueries({ queryKey: ["invoice", tenantKey, invoice.id] });
        qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        setOpen(false);
        setReference("");
      } else {
        const e = await r.json().catch(() => ({}));
        toast.error(e.error || t("fin-failed-record-payment"));
      }
    } catch (e) {
      toast.error(t("fin-network-error-retry"));
    } finally {
      setSubmitting(false);
    }
  }

  const trigger =
    triggerVariant === "footer" ? (
      <Button size="sm" variant="outline" className="gap-1">
        <DollarSign className="size-3.5" /> {t("fin-record-payment")}
      </Button>
    ) : (
      <Button size="sm" variant="outline" className="gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950">
        <DollarSign className="size-3.5" /> {t("fin-record-payment")}
      </Button>
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="w-[95vw] max-w-3xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="size-5 text-emerald-600" />
            {t("fin-record-payment-with-number").replace("${number}", invoice.number)}
          </DialogTitle>
          <DialogDescription>
            {t("fin-record-payment-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">{t("amount")} ({invoice.currency || "USD"})</Label>
              <Input
                id="pay-amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("fin-outstanding-label")}: {fmtMoney(invoice.total ?? 0, invoice.currency || "USD")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">{t("fin-payment-date")}</Label>
              <Input
                id="pay-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t("fin-method")}</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue placeholder={t("fin-select-method")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bank_transfer">{t("fin-bank-transfer")}</SelectItem>
                <SelectItem value="cash">{t("fin-cash")}</SelectItem>
                <SelectItem value="check">{t("fin-check")}</SelectItem>
                <SelectItem value="card">{t("fin-card")}</SelectItem>
                <SelectItem value="other">{t("fin-other")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">{t("fin-reference-optional")}</Label>
            <Input
              id="pay-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("fin-reference-placeholder")}
            />
          </div>

          {Number(amount) < Number(invoice.total ?? 0) - 0.01 && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-700/40 p-3 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="size-3.5 inline mr-1" />
              {t("fin-partial-payment-warning")} <strong>{t("fin-partial-word")}</strong>,{" "}
              {t("fin-not-paid-word")}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-emerald-600 text-white hover:bg-emerald-700 gap-1"
          >
            {submitting ? (
              <><Clock className="size-3.5 animate-spin" /> {t("fin-recording")}</>
            ) : (
              <><DollarSign className="size-3.5" /> {t("fin-record-payment")}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ---- Form dialog ----
function InvoiceFormDialog({
  open, onOpenChange, invoice, partners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice: Invoice | null;
  partners: Partner[];
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [form, setForm] = useState<Partial<Invoice> & { items: OfferLineItem[]; payment_terms?: string | null }>({ items: [] });

  // Ref mirror of `form` so event handlers (handleUnitChange, selectProduct)
  // can read the latest line items without capturing stale state.
  const formRef = useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);

  const [saving, setSaving] = useState(false);
  const [partnerContextLoading, setPartnerContextLoading] = useState(false);
  const [partnerContext, setPartnerContext] = useState<{
    partner: Partner;
    deals: any[];
    offers: Offer[];
    invoices: any[];
    proformas: any[];
  } | null>(null);

  // Collapsible section states
  const isEditing = !!invoice;
  const [lineItemsOpen, setLineItemsOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(false);

  const offers = useQuery({
    queryKey: ["offers", tenantKey, "list", "100"],
    queryFn: async () => {
      const r = await fetch(api(`/api/offers?limit=100`));
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json() as Promise<{ items: Offer[]; total: number }>;
    },
    enabled: open,
  });

  const products = useQuery({
    queryKey: ["products", tenantKey, "list", "1000"],
    queryFn: async () => {
      const r = await fetch(api(`/api/products?limit=1000`));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: Product[]; total: number }>;
    },
    enabled: open,
  });

  // Reset form when opening / when invoice changes
  useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setPartnerContext(null);
      if (invoice) {
        setForm({
          ...invoice,
          items: (invoice.items || []).map((i) => ({ ...i })),
        });
        // When editing, expand all sections
        setLineItemsOpen(true);
        setNotesOpen(true);
      } else {
        setForm({
          currency: "EUR",
          issue_date: new Date().toISOString(),
          due_date: calculateDueDate("net30").toISOString(),
          notes: "",
          status: "draft",
          items: [],
          payment_terms: "net30",
        });
        // When creating new, line items open, notes closed
        setLineItemsOpen(true);
        setNotesOpen(false);
      }
    }
  }, [open, invoice]);

  // Fetch partner context when a partner is selected
  const fetchPartnerContext = useCallback(async (partnerId: string) => {
    if (!partnerId) return;
    setPartnerContextLoading(true);
    try {
      const r = await fetch(api(`/api/automation/partner-context?partner_id=${partnerId}`));
      if (!r.ok) throw new Error("Failed to load partner context");
      const data = await r.json();
      setPartnerContext(data);
      return data;
    } catch (e) {
      console.error("Failed to load partner context:", e);
      toast.error(t("fin-could-not-load-partner"));
      return null;
    } finally {
      setPartnerContextLoading(false);
    }
  }, []);

  // Auto-fill partner data when partner is selected
  const handlePartnerChange = useCallback(async (partnerId: string) => {
    setForm((f) => ({ ...f, partner_id: partnerId }));

    if (!partnerId) return;

    const partner = partners.find((p) => p.id === partnerId);
    if (!partner) return;

    // Auto-fill from partner data immediately
    setForm((f) => {
      const updates: Partial<Invoice> & { items: OfferLineItem[]; payment_terms?: string | null } = { ...f };

      // Auto-fill currency from partner preference
      if (partner.preferred_currency && !f.currency) {
        updates.currency = partner.preferred_currency;
      }

      // Auto-fill payment terms from partner preference
      if (partner.preferred_payment_terms) {
        updates.payment_terms = partner.preferred_payment_terms;
        // Auto-calculate due date based on payment terms
        const dueDate = calculateDueDate(partner.preferred_payment_terms);
        updates.due_date = dueDate.toISOString();
      }

      return updates;
    });

    // Fetch full partner context for additional data
    const ctx = await fetchPartnerContext(partnerId);
    if (ctx?.partner) {
      const p = ctx.partner as Partner;
      setForm((f) => {
        const updates: Partial<Invoice> & { items: OfferLineItem[]; payment_terms?: string | null } = { ...f };

        // Fill currency if not already set
        if (p.preferred_currency && f.currency === "EUR") {
          updates.currency = p.preferred_currency;
        }

        // Fill payment terms and due date
        if (p.preferred_payment_terms && !f.payment_terms) {
          updates.payment_terms = p.preferred_payment_terms;
          const dueDate = calculateDueDate(p.preferred_payment_terms);
          updates.due_date = dueDate.toISOString();
        }

        // Append notes with partner info
        if (p.vat_number || p.bank_name || p.bank_iban) {
          const partnerInfo = [
            p.vat_number ? `VAT: ${p.vat_number}` : "",
            p.bank_name ? `Bank: ${p.bank_name}` : "",
            p.bank_iban ? `IBAN: ${p.bank_iban}` : "",
            p.bank_swift ? `SWIFT: ${p.bank_swift}` : "",
            p.bank_account ? `Account: ${p.bank_account}` : "",
          ].filter(Boolean).join(" | ");

          if (partnerInfo) {
            updates.notes = f.notes
              ? `${f.notes}\n\nPartner: ${p.name} — ${partnerInfo}`
              : `Partner: ${p.name} — ${partnerInfo}`;
          }
        }

        return updates;
      });
    }
  }, [partners, fetchPartnerContext]);

  // Auto-fill from offer when selected
  const handleOfferChange = useCallback(async (offerId: string | null) => {
    if (!offerId) {
      setForm((f) => ({ ...f, offer_id: null }));
      return;
    }

    setForm((f) => ({ ...f, offer_id: offerId }));

    // Fetch the offer data
    try {
      const r = await fetch(api(`/api/offers/${offerId}`));
      if (!r.ok) throw new Error("Failed to load offer");
      const offer: Offer = await r.json();

      setForm((f) => ({
        ...f,
        offer_id: offerId,
        partner_id: offer.partner_id,
        subject: offer.subject,
        currency: offer.currency,
        items: (offer.items || []).map((i) => ({ ...i })),
        notes: f.notes
          ? `${f.notes}\n\n${t("fin-auto-filled-from-offer-with-number").replace("${number}", offer.number)}`
          : t("fin-auto-filled-from-offer-with-number").replace("${number}", offer.number),
        payment_terms: offer.payment_terms || "net30",
        due_date: calculateDueDate(offer.payment_terms || "net30").toISOString(),
      }));

      // Also trigger partner auto-fill for bank details
      if (offer.partner_id) {
        fetchPartnerContext(offer.partner_id);
      }

      toast.success(t("fin-auto-filled-from-offer-with-number").replace("${number}", offer.number));
    } catch (e) {
      toast.error(t("fin-failed-load-offer-data"));
    }
  }, [fetchPartnerContext, t]);

  function set<K extends keyof Invoice>(k: K, v: Invoice[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Handle payment terms change — auto-calculate due date
  function handlePaymentTermsChange(terms: string) {
    const dueDate = calculateDueDate(terms);
    setForm((f) => ({
      ...f,
      payment_terms: terms,
      due_date: dueDate.toISOString(),
    }));
  }

  function setItem(idx: number, patch: Partial<OfferLineItem>) {
    setForm((f) => {
      const items = [...(f.items || [])];
      items[idx] = { ...items[idx], ...patch };
      return { ...f, items };
    });
  }

  /**
   * Handle a unit-of-measure change on a line item.
   *
   * Same-category changes (e.g. kg → MT) auto-convert the unit_price so the
   * line total stays the same. Cross-category changes (e.g. kg → piece) leave
   * the price untouched and warn the user.
   */
  function handleUnitChange(idx: number, newUnit: string) {
    const items = formRef.current.items || [];
    const item = items[idx];
    if (!item) {
      setItem(idx, { unit: newUnit });
      return;
    }
    const oldUnit = item.unit || "";

    if (!oldUnit || oldUnit === newUnit) {
      setItem(idx, { unit: newUnit });
      return;
    }

    const currentPrice = Number(item.unit_price) || 0;
    const convertedPrice = convertUnitPrice(currentPrice, oldUnit, newUnit);

    if (convertedPrice != null && currentPrice > 0) {
      setItem(idx, { unit: newUnit, unit_price: convertedPrice });
      toast.info(t("fin-price-auto-converted").replace("${old}", String(currentPrice)).replace("${oldUnit}", oldUnit).replace("${new}", convertedPrice.toFixed(2)).replace("${newUnit}", newUnit));
    } else {
      setItem(idx, { unit: newUnit });
      if (currentPrice > 0) {
        toast.warning(t("fin-cannot-convert-price").replace("${oldUnit}", oldUnit).replace("${newUnit}", newUnit));
      }
    }
  }

  function selectProduct(idx: number, p: Product) {
    // Unit-conversion aware: if the user already picked a non-default unit on
    // this line (e.g. they set "MT" while the product is priced per "kg"),
    // preserve their choice and convert the product price into that unit so
    // the form stays internally consistent. If the line still has the default
    // "pcs" unit we adopt the product's native unit instead.
    const supplierUnit = p.unit || null;
    const currentLineUnit = formRef.current.items?.[idx]?.unit || null;
    const preserveLineUnit =
      currentLineUnit && currentLineUnit !== "pcs" ? currentLineUnit : null;
    const lineUnit = preserveLineUnit || supplierUnit || "pcs";

    const basePrice = Number(p.price) || 0;
    let priceToUse = basePrice;
    if (supplierUnit && lineUnit !== supplierUnit && basePrice > 0) {
      const converted = convertUnitPrice(basePrice, supplierUnit, lineUnit);
      if (converted != null) priceToUse = converted;
    }

    setItem(idx, {
      product_id: p.id,
      product_name: p.name,
      sku: p.sku,
      unit: lineUnit,
      unit_price: priceToUse,
      hs_code: (p as any).hs_code ?? null,
      description: (p as any).description ?? null,
      detailed_spec: (p as any).detailed_spec ?? null,
      brand: (p as any).brand ?? null,
      origin_country: (p as any).origin_country
        ?? ((p as any).attributes?.origin_country ?? null),
      specifications: (p as any).coa_params ?? null,
    });
  }

  function addItem() {
    setForm((f) => ({
      ...f,
      items: [...(f.items || []), {
        product_id: "", product_name: "", sku: "", unit: "pcs",
        quantity: 1, unit_price: 0, discount: 0, tax_rate: 20, total: 0,
      }],
    }));
  }

  function removeItem(idx: number) {
    setForm((f) => ({
      ...f,
      items: (f.items || []).filter((_, i) => i !== idx),
    }));
  }

  // Auto-calculate totals when items change
  const totals = useMemo(() => computeTotals(form.items || []), [form.items]);

  async function save() {
    if (!form.partner_id) { toast.error(t("fin-select-partner-toast")); return; }
    setSaving(true);
    try {
      const method = invoice ? "PUT" : "POST";
      const url = invoice ? api(`/api/invoices/${invoice.id}`) : api("/api/invoices");
      const computed = computeTotals(form.items || []);
      const body = {
        ...form,
        items: (form.items || []).map((it) => ({ ...it, total: lineTotal(it) })),
        subtotal: computed.subtotal,
        discount_total: computed.discount_total,
        tax_total: computed.tax_total,
        total: computed.total,
      };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("fin-failed-save"));
      }
      const saved = await r.json();
      if (invoice) {
        toast.success(t("fin-invoice-updated-toast"), { description: saved.number || invoice.number });
      } else {
        toast.success(t("fin-invoice-created-toast"), { description: saved.number || "" });
      }
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("fin-failed-save"));
    } finally {
      setSaving(false);
    }
  }

  const offerList = offers.data?.items || [];
  // `products` is kept for the unit-conversion tip lookup below
  // (ProductPicker fetches its own copy and calls selectProduct with the
  // full Product object).

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            {isEditing ? t("fin-edit-invoice") : t("fin-new-invoice")}
            {partnerContextLoading && (
              <span className="size-3.5 animate-spin rounded-full border-2 border-emerald-500/30 border-t-emerald-500" />
            )}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t("fin-update-invoice-desc")
              : t("fin-create-invoice-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">

          {/* ── Essential section (always visible) ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                {t("fin-partner-required")} *
                {partnerContextLoading && (
                  <span className="size-3 animate-spin rounded-full border-2 border-emerald-500/30 border-t-emerald-500" />
                )}
                {partnerContext && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                    <Sparkles className="size-3" /> {t("fin-auto-filled")}
                  </span>
                )}
              </Label>
              <PartnerPicker
                value={form.partner_id || ""}
                fallbackName={partnerContext?.partner?.name}
                placeholder={t("fin-select-partner")}
                onSelect={(p) => p?.id && handlePartnerChange(p.id)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("fin-currency")}</Label>
              <Select value={form.currency || "EUR"} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger><SelectValue placeholder={t("fin-select-currency")} /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                {t("fin-payment-terms")}
                <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                  <Zap className="size-3" /> {t("fin-auto-due")}
                </span>
              </Label>
              <Select
                value={form.payment_terms || "net30"}
                onValueChange={handlePaymentTermsChange}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.keys(PAYMENT_TERMS_OPTION_KEYS).map((value) => (
                    <SelectItem key={value} value={value}>{t(PAYMENT_TERMS_OPTION_KEYS[value])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                {t("fin-due-date")}
                {form.payment_terms && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("fin-due-date-auto")} {form.payment_terms}</span>
                )}
              </Label>
              <Input
                type="date"
                value={form.due_date ? form.due_date.slice(0, 10) : ""}
                onChange={(e) => set("due_date", e.target.value ? new Date(e.target.value).toISOString() : null as unknown as string)}
              />
            </div>

            {/* Partner context info card */}
            {partnerContext?.partner && (
              <div className="md:col-span-2 p-3 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50">
                <div className="flex items-center gap-1.5 mb-2">
                  <Sparkles className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{t("fin-partner-autofill-label")}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  {partnerContext.partner.vat_number && (
                    <div>
                      <span className="text-muted-foreground">{t("fin-vat-colon")}</span>{" "}
                      <span className="font-medium">{partnerContext.partner.vat_number}</span>
                    </div>
                  )}
                  {partnerContext.partner.bank_name && (
                    <div>
                      <span className="text-muted-foreground">{t("fin-bank-colon")}</span>{" "}
                      <span className="font-medium">{partnerContext.partner.bank_name}</span>
                    </div>
                  )}
                  {partnerContext.partner.bank_iban && (
                    <div>
                      <span className="text-muted-foreground">{t("fin-iban-label")}:</span>{" "}
                      <span className="font-mono font-medium">{partnerContext.partner.bank_iban}</span>
                    </div>
                  )}
                  {partnerContext.partner.bank_swift && (
                    <div>
                      <span className="text-muted-foreground">{t("fin-swift-label")}:</span>{" "}
                      <span className="font-mono font-medium">{partnerContext.partner.bank_swift}</span>
                    </div>
                  )}
                  {partnerContext.partner.preferred_payment_terms && (
                    <div>
                      <span className="text-muted-foreground">{t("fin-terms-label")}:</span>{" "}
                      <span className="font-medium">{partnerContext.partner.preferred_payment_terms}</span>
                    </div>
                  )}
                  {partnerContext.partner.address_line && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">{t("fin-address-label")}:</span>{" "}
                      <span className="font-medium">
                        {partnerContext.partner.address_line}
                        {partnerContext.partner.city ? `, ${partnerContext.partner.city}` : ""}
                        {partnerContext.partner.country ? `, ${partnerContext.partner.country}` : ""}
                      </span>
                    </div>
                  )}
                </div>
                {partnerContext.offers?.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-emerald-200/50 dark:border-emerald-800/50">
                    <span className="text-xs text-muted-foreground">
                      {partnerContext.offers.length} {t("fin-offers-suffix")} · {partnerContext.invoices?.length || 0} {t("fin-invoices-suffix")}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Line Items section (collapsible) ── */}
          <Collapsible open={lineItemsOpen} onOpenChange={setLineItemsOpen} className="border-t pt-2 mt-1">
            <CollapsibleTrigger asChild>
              <button type="button" className="flex items-center gap-2 w-full py-2 text-sm font-medium hover:text-foreground/80 transition-colors group">
                {lineItemsOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                )}
                <span>{t("fin-line-items")}</span>
                {(form.items || []).length > 0 && (
                  <span className="text-xs text-muted-foreground font-normal">
                    ({(form.items || []).length} {t("fin-items-suffix")} · {fmtMoney(totals.total, form.currency || "EUR")})
                  </span>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pb-2">
                {/* Linked offer + Add item row */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                  <div className="flex-1 space-y-1 w-full">
                    <Label className="flex items-center gap-1.5 text-xs">
                      {t("fin-linked-offer")}
                      <span className="text-muted-foreground">{t("fin-autofills-all-hint")}</span>
                    </Label>
                    <Select
                      value={form.offer_id || "__none__"}
                      onValueChange={(v) => handleOfferChange(v === "__none__" ? null : v)}
                    >
                      <SelectTrigger className="h-9"><SelectValue placeholder={t("fin-no-linked-offer")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t("fin-no-offer-option")}</SelectItem>
                        {offerList
                          .filter((o) => o.status === "accepted" || o.status === "sent")
                          .map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              <span className="flex items-center gap-1.5">
                                <span className="font-mono text-xs">{o.number}</span>
                                <span className="text-muted-foreground">· {o.subject}</span>
                                <Badge variant="secondary" className="ml-1 text-xs px-1 py-0">
                                  {o.status === "accepted" ? "✓" : "→"}
                                </Badge>
                              </span>
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={addItem} className="mt-auto shrink-0">
                    <Plus className="size-4 mr-1" /> {t("fin-add-item")}
                  </Button>
                </div>

                {(form.items || []).length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4 border rounded-md">
                    {t("fin-no-items-yet")}
                  </p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto custom-scroll pr-1">
                    {(form.items || []).map((it, idx) => (
                      <div key={idx} className="rounded-md border p-2 grid grid-cols-12 gap-1.5 items-end">
                        <div className="col-span-12 sm:col-span-3 space-y-1">
                          <Label className="text-xs">{t("fin-product")}</Label>
                          <ProductPicker
                            value={it.product_id || ""}
                            fallbackName={it.product_name || ""}
                            fallbackSku={it.sku || ""}
                            placeholder={t("fin-select-placeholder")}
                            onSelect={(product) => {
                              if (product) {
                                selectProduct(idx, product);
                              } else {
                                setItem(idx, { product_id: "" });
                              }
                            }}
                            onAddCustom={() => {
                              // "Add custom product" — clear the product_id
                              // but keep the current product_name so the
                              // user can keep typing a manual entry.
                              setItem(idx, { product_id: "" });
                            }}
                          />
                          <Input
                            className="h-8 text-xs"
                            placeholder={t("fin-product-name-placeholder")}
                            value={it.product_name || ""}
                            onChange={(e) => setItem(idx, { product_name: e.target.value })}
                          />
                        </div>
                        <div className="col-span-4 sm:col-span-2 space-y-1">
                          <Label className="text-xs">{t("fin-qty")}</Label>
                          <Input
                            type="number"
                            className="h-9"
                            value={it.quantity}
                            onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })}
                          />
                        </div>
                        <div className="col-span-4 sm:col-span-2 space-y-1">
                          <Label className="text-xs">{t("fin-unit")}</Label>
                          <UnitSelect
                            value={it.unit || ""}
                            onChange={(v) => handleUnitChange(idx, v)}
                            placeholder="pcs"
                          />
                        </div>
                        <div className="col-span-4 sm:col-span-2 space-y-1">
                          <Label className="text-xs">{t("fin-price")}</Label>
                          <Input
                            type="number"
                            className="h-9"
                            value={it.unit_price}
                            onChange={(e) => setItem(idx, { unit_price: Number(e.target.value) })}
                          />
                          {it.product_id &&
                            it.unit &&
                            (() => {
                              const p = (products.data?.items || []).find((x) => x.id === it.product_id);
                              const supplierUnit = p?.unit || null;
                              if (!supplierUnit || supplierUnit === it.unit) return null;
                              const desc = describeConversion(supplierUnit, it.unit);
                              if (!desc) return null;
                              return (
                                <div className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-0.5 mt-0.5">
                                  <ArrowLeftRight className="size-2.5 shrink-0" />
                                  <span>{desc}</span>
                                </div>
                              );
                            })()}
                        </div>
                        <div className="col-span-2 sm:col-span-1 space-y-1">
                          <Label className="text-xs">{t("fin-disc-percent")}</Label>
                          <Input
                            type="number"
                            className="h-9"
                            value={it.discount}
                            onChange={(e) => setItem(idx, { discount: Number(e.target.value) })}
                          />
                        </div>
                        <div className="col-span-2 sm:col-span-1 space-y-1">
                          <Label className="text-xs">{t("fin-vat-percent")}</Label>
                          <Input
                            type="number"
                            className="h-9"
                            value={it.tax_rate}
                            onChange={(e) => setItem(idx, { tax_rate: Number(e.target.value) })}
                          />
                        </div>
                        <div className="col-span-1 flex justify-end">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-9 text-destructive"
                            onClick={() => removeItem(idx)}
                            title={t("fin-remove-item-title")}
                            aria-label={t("fin-remove-item-title")}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <div className="col-span-12 text-right text-xs text-muted-foreground -mt-1">
                          {t("fin-line-total").replace("${money}", fmtMoney(lineTotal(it), form.currency || "EUR"))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Computed totals */}
                {(form.items || []).length > 0 && (
                  <div className="ml-auto w-full sm:w-72 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("fin-subtotal")}</span>
                      <span className="tabular">{fmtMoney(totals.subtotal, form.currency || "EUR")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("fin-discount")}</span>
                      <span className="tabular">- {fmtMoney(totals.discount_total, form.currency || "EUR")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t("fin-tax")}</span>
                      <span className="tabular">{fmtMoney(totals.tax_total, form.currency || "EUR")}</span>
                    </div>
                    <div className="flex justify-between border-t pt-1 mt-1 text-base font-semibold">
                      <span>{t("fin-total-col")}</span>
                      <span className="tabular">{fmtMoney(totals.total, form.currency || "EUR")}</span>
                    </div>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ── Notes section (collapsible) ── */}
          <Collapsible open={notesOpen} onOpenChange={setNotesOpen} className="border-t pt-2 mt-1">
            <CollapsibleTrigger asChild>
              <button type="button" className="flex items-center gap-2 w-full py-2 text-sm font-medium hover:text-foreground/80 transition-colors group">
                {notesOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                )}
                <span>{t("fin-notes")}</span>
                {form.notes && (
                  <span className="text-xs text-muted-foreground font-normal truncate max-w-[200px]">
                    — {form.notes.slice(0, 40)}{form.notes.length > 40 ? "…" : ""}
                  </span>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pb-2 space-y-1.5">
                <Textarea
                  rows={3}
                  value={form.notes || ""}
                  onChange={(e) => set("notes", e.target.value)}
                  placeholder={t("fin-notes-placeholder")}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ── More details (collapsible, only for edit) ── */}
          {isEditing && (
            <Collapsible defaultOpen className="border-t pt-2 mt-1">
              <CollapsibleTrigger asChild>
                <button type="button" className="flex items-center gap-2 w-full py-2 text-sm font-medium hover:text-foreground/80 transition-colors group">
                  <ChevronDown className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  <span>{t("fin-more-details")}</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-2">
                  <div className="md:col-span-2 space-y-1.5">
                    <Label>{t("fin-subject")}</Label>
                    <Input
                      value={form.subject || ""}
                      onChange={(e) => set("subject", e.target.value)}
                      placeholder={t("fin-subject-placeholder")}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>{t("fin-issue-date")}</Label>
                    <Input
                      type="date"
                      value={form.issue_date ? form.issue_date.slice(0, 10) : ""}
                      onChange={(e) => set("issue_date", e.target.value ? new Date(e.target.value).toISOString() : null as unknown as string)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>{t("fin-status-field")}</Label>
                    <Select value={form.status || "draft"} onValueChange={(v) => set("status", v as InvoiceStatus)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {INVOICE_STATUSES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{t(STATUS_LABEL_KEYS[s.value as InvoiceStatus])}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("fin-saving") : isEditing ? t("fin-save-changes") : t("fin-create-invoice-btn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
