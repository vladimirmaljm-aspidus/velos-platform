"use client";

/**
 * LoisView — admin view for Letters of Intent (LOI).
 *
 * Mirrors the structure of proformas-view.tsx (search + status filter +
 * partner filter + paginated table + detail sheet + create/edit dialog).
 *
 * Lifecycle:
 *   draft → sent → accepted | rejected | expired | cancelled
 *
 * The "send" action emails the LOI to the partner + registers it in
 * document_register (type='loi'). The "download PDF" action opens the
 * printable HTML page returned by /api/lois/[id]/pdf (the user can then
 * Ctrl+P → "Save as PDF" to mint a PDF artifact).
 */

import { useState, useMemo, useEffect } from "react";
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, Pencil, Trash2, Eye, Send, Download, FileText, Loader2, ScrollText,
  X, Package, Building2, Info,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { fmtMoney, fmtDate, fmtNumber } from "@/lib/utils/format";
import type { LetterOfIntent, LoiStatus, Partner, Product, Tenant } from "@/lib/supabase/types";
import { CURRENCIES } from "@/lib/data/reference";
import { UnitSelect } from "@/components/common/unit-select";
import { PartnerPicker } from "@/components/common/partner-picker";
import { ProductPicker } from "@/components/common/product-picker";
import { CountrySelect } from "@/components/common/country-select";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useEffectiveTenantId, useAppStore } from "@/lib/store/app-store";

// ─── Status styling ────────────────────────────────────────────────────────
// draft=gray, sent=blue, accepted=green, rejected=red, expired=amber,
// cancelled=gray (per BUILD-LOI spec).
const STATUS_LABEL_KEYS: Record<LoiStatus, string> = {
  draft: "loi-status-draft",
  sent: "loi-status-sent",
  accepted: "loi-status-accepted",
  rejected: "loi-status-rejected",
  expired: "loi-status-expired",
  cancelled: "loi-status-cancelled",
};

const STATUS_STYLES: Record<LoiStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  sent: "border-transparent bg-[var(--chart-1)] text-white",
  accepted: "border-transparent bg-emerald-600 text-white",
  rejected: "border-transparent bg-rose-600 text-white",
  expired: "border-transparent bg-amber-500 text-white",
  cancelled: "border-transparent bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: LoiStatus }) {
  const t = useT();
  const label = t(STATUS_LABEL_KEYS[status]);
  if (status === "draft") return <Badge variant="secondary">{label}</Badge>;
  return <Badge className={STATUS_STYLES[status]}>{label}</Badge>;
}

// ─── Form state shape ─────────────────────────────────────────────────────
// NOTE (FIX-LOI-UI-LOGIC): buyer_name / buyer_address / buyer_contact are
// intentionally absent — the backend auto-populates them from the caller's
// tenant record (the tenant IS the buyer; the LOI is issued BY the tenant
// TO the seller partner). The form therefore does not collect buyer info
// and the payload does not send it.
type LoiForm = {
  id?: string;
  partner_id: string;
  subject: string;
  product_id: string | null;       // optional link to a catalog product
  product_name: string;
  product_description: string;
  hs_code: string;
  origin_country: string;
  quantity: string;
  unit: string;
  unit_price: string;
  currency: string;
  delivery_terms: string;
  delivery_date: string;
  payment_terms: string;
  validity_until: string;
  notes: string;
  terms_text: string;
};

function emptyForm(): LoiForm {
  return {
    partner_id: "",
    subject: "",
    product_id: null,
    product_name: "",
    product_description: "",
    hs_code: "",
    origin_country: "",
    quantity: "",
    unit: "MT",
    unit_price: "",
    currency: "USD",
    delivery_terms: "",
    delivery_date: "",
    payment_terms: "",
    validity_until: "",
    notes: "",
    terms_text: "",
  };
}

function loiToForm(l: LetterOfIntent): LoiForm {
  return {
    id: l.id,
    partner_id: l.partner_id || "",
    subject: l.subject || "",
    product_id: l.product_id ?? null,
    product_name: l.product_name || "",
    product_description: l.product_description || "",
    hs_code: l.hs_code || "",
    origin_country: l.origin_country || "",
    quantity: l.quantity != null ? String(l.quantity) : "",
    unit: l.unit || "MT",
    unit_price: l.unit_price != null ? String(l.unit_price) : "",
    currency: l.currency || "USD",
    delivery_terms: l.delivery_terms || "",
    delivery_date: l.delivery_date || "",
    payment_terms: l.payment_terms || "",
    validity_until: l.validity_until || "",
    notes: l.notes || "",
    terms_text: l.terms_text || "",
  };
}

function formToPayload(f: LoiForm): Record<string, unknown> {
  // NOTE (FIX-LOI-UI-LOGIC): buyer_name / buyer_address / buyer_contact are
  // NOT sent — the API auto-fills them from the caller's tenant record. We
  // also keep the form's explicit product_* / unit / unit_price values,
  // even when product_id is set: the API respects explicit values over the
  // product auto-fill, so a user-tweaked unit_price survives a save.
  const payload: Record<string, unknown> = {
    partner_id: f.partner_id,
    subject: f.subject,
    product_name: f.product_name,
    product_description: f.product_description || null,
    hs_code: f.hs_code || null,
    origin_country: f.origin_country || null,
    quantity: Number(f.quantity),
    unit: f.unit,
    unit_price: Number(f.unit_price),
    currency: f.currency,
    delivery_terms: f.delivery_terms || null,
    delivery_date: f.delivery_date || null,
    payment_terms: f.payment_terms || null,
    validity_until: f.validity_until,
    notes: f.notes || null,
    terms_text: f.terms_text || null,
  };
  if (f.product_id) payload.product_id = f.product_id;
  else payload.product_id = null;
  if (f.id) payload.id = f.id;
  return payload;
}

function validateForm(f: LoiForm): string | null {
  if (!f.partner_id) return "partner_id is required.";
  if (!f.subject.trim()) return "subject is required.";
  if (!f.product_name.trim()) return "product_name is required.";
  const q = Number(f.quantity);
  if (!Number.isFinite(q) || q <= 0) return "quantity must be a positive number.";
  const p = Number(f.unit_price);
  if (!Number.isFinite(p) || p <= 0) return "unit_price must be a positive number.";
  if (!f.unit.trim()) return "unit is required.";
  if (!f.validity_until) return "validity_until is required.";
  return null;
}

// ─── View ──────────────────────────────────────────────────────────────────
export function LoisView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  const qc = useQueryClient();
  const effectiveTenantId = useEffectiveTenantId();
  const setView = useAppStore((s) => s.setView);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [partnerFilter, setPartnerFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<LetterOfIntent | null>(null);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [form, setForm] = useState<LoiForm>(emptyForm());
  // Holds the Product object selected via the ProductPicker (for display in
  // the form's "Product selected" badge). `null` means manual entry.
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sendId, setSendId] = useState<string | null>(null);
  const [sendEmail, setSendEmail] = useState<string>("");

  // ─── Tenant (the buyer = the company issuing the LOI) ────────────────
  // For regular users `/api/tenants` returns just their own tenant; for
  // super-admins it returns every tenant, so we filter by the effective
  // tenant id (activeTenantId for super-admins, user.tenant_id otherwise).
  // Mirrors the pattern used in offers-view.tsx for the completeness checker.
  const tenantQuery = useQuery({
    queryKey: ["tenant", tenantKey, effectiveTenantId, "loi-buyer"],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenant");
      const data = (await r.json()) as { items: Tenant[] };
      const list = data.items || [];
      const match = effectiveTenantId
        ? list.find((tt) => tt.id === effectiveTenantId)
        : null;
      return (match || list[0] || null) as Tenant | null;
    },
  });
  const tenant = tenantQuery.data ?? null;

  // ─── List query ────────────────────────────────────────────────────────
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["lois", tenantKey, debouncedSearch, statusFilter, partnerFilter],
    queryFn: async () => {
      const params: Record<string, string | undefined> = {};
      if (debouncedSearch) params.search = debouncedSearch;
      if (statusFilter !== "all") params.status = statusFilter;
      if (partnerFilter !== "all") params.partner_id = partnerFilter;
      params.limit = "200";
      const r = await fetch(api("/api/lois", params));
      if (!r.ok) throw new Error("Failed to load LOIs");
      return r.json() as Promise<{ items: LetterOfIntent[]; total: number }>;
    },
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // ─── Partners (for partner filter + form picker) ────────────────────────
  const partners = useQuery({
    queryKey: ["partners", tenantKey, "list", "200"],
    queryFn: async () => {
      const r = await fetch(api("/api/partners", { limit: "200" }));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });
  const partnerName = (id: string | null | undefined) =>
    partners.data?.items.find((p) => p.id === id)?.name || "—";

  // ─── Detail query ──────────────────────────────────────────────────────
  const detail = useQuery({
    queryKey: ["loi", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/lois/${detailId}`));
      if (!r.ok) throw new Error("Failed to load LOI");
      return r.json() as Promise<LetterOfIntent>;
    },
    enabled: !!detailId,
  });

  // ─── Products (catalog) for the ProductPicker ─────────────────────────
  // NOTE: this shares the same queryKey as the ProductPicker's internal
  // query (["products", tenantKey, "picker", "1000"]), so react-query will
  // reuse the cache — no double fetch. We only need this so that:
  //   1. openEdit() can resolve the selectedProduct object for the form's
  //      "Product selected" badge (without re-implementing a fetch in
  //      openEdit); and
  //   2. the detail panel can render the product name + SKU link.
  const productsQuery = useQuery({
    queryKey: ["products", tenantKey, "picker", "1000"],
    queryFn: async () => {
      const r = await fetch(api(`/api/products`, { limit: 1000 }));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: Product[]; total: number }>;
    },
    staleTime: 60_000,
  });

  // ─── Create / Update mutation ──────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async (f: LoiForm) => {
      const payload = formToPayload(f);
      const r = await fetch(api(`/api/lois${f.id ? `/${f.id}` : ""}`), {
        method: f.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      return r.json() as Promise<LetterOfIntent>;
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.id ? t("loi-toast-updated") : t("loi-toast-created"));
      qc.invalidateQueries({ queryKey: ["lois", tenantKey] });
      setShowForm(false);
      setEditing(null);
    },
    onError: (e: Error) => {
      toast.error(`${t("loi-toast-error")}`, { description: e.message });
    },
  });

  // ─── Delete mutation ──────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/lois/${id}`), { method: "DELETE" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("loi-toast-deleted"));
      setDeleteId(null);
      qc.invalidateQueries({ queryKey: ["lois", tenantKey] });
    },
    onError: (e: Error) => {
      toast.error(`${t("loi-toast-error")}`, { description: e.message });
      setDeleteId(null);
    },
  });

  // ─── Send mutation ────────────────────────────────────────────────────
  const sendMutation = useMutation({
    mutationFn: async ({ id, email }: { id: string; email?: string }) => {
      const r = await fetch(api(`/api/lois/${id}/send`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(email ? { email } : {}),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err?.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("loi-toast-sent"));
      setSendId(null);
      setSendEmail("");
      qc.invalidateQueries({ queryKey: ["lois", tenantKey] });
    },
    onError: (e: Error) => {
      toast.error(`${t("loi-toast-error")}`, { description: e.message });
      setSendId(null);
    },
  });

  // ─── Download (open printable HTML in a new tab) ──────────────────────
  const handleDownload = async (loi: LetterOfIntent) => {
    try {
      const url = api(`/api/lois/${loi.id}/pdf`);
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      // Open the printable HTML in a new tab — the user can then Ctrl+P →
      // "Save as PDF" using the embedded "Print / Save as PDF" button +
      // @media print CSS in the route's HTML template.
      window.open(objectUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (e: any) {
      toast.error(`${t("loi-toast-error")}`, { description: e?.message || "Failed to download PDF" });
    }
  };

  // ─── Form open/close helpers ──────────────────────────────────────────
  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setSelectedProduct(null);
    setShowForm(true);
  };
  const openEdit = (loi: LetterOfIntent) => {
    setEditing(loi);
    setForm(loiToForm(loi));
    // Resolve the Product object from the cached catalog so the form's
    // "Product selected" badge shows the right name/SKU. If the product
    // isn't found in the cache (e.g. deleted from the catalog after the
    // LOI was created, or the picker query hasn't resolved yet), the
    // badge stays hidden — form.product_id is preserved regardless so
    // the API keeps the link on save.
    const pid = loi.product_id;
    setSelectedProduct(
      pid ? (productsQuery.data?.items.find((p) => p.id === pid) ?? null) : null
    );
    setShowForm(true);
  };
  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
    setSelectedProduct(null);
  };

  // ─── Product pick / clear handlers ───────────────────────────────────
  // When the user picks a product from the catalog, we auto-fill the
  // product_* fields from the Product record and set product_id. When
  // they clear the selection, we drop the product_id link and reset the
  // product_* fields to empty (manual entry). Per the API contract,
  // explicit product_* values in the body take precedence over the
  // auto-fill from product_id, so user-tweaked fields survive a save.
  const handleProductPick = (p: Product | null) => {
    if (p) {
      setSelectedProduct(p);
      const attrOrigin =
        (p.attributes as Record<string, unknown> | null)?.origin_country;
      setForm((prev) => ({
        ...prev,
        product_id: p.id,
        product_name: p.name || prev.product_name,
        product_description: p.description ?? prev.product_description,
        hs_code: p.hs_code ?? prev.hs_code,
        origin_country:
          p.origin_country ?? (typeof attrOrigin === "string" ? attrOrigin : prev.origin_country),
        unit: p.unit || prev.unit,
        unit_price: p.price != null ? String(p.price) : prev.unit_price,
      }));
    } else {
      // Treated the same as "Clear selection".
      handleClearProduct();
    }
  };

  const handleClearProduct = () => {
    setSelectedProduct(null);
    setForm((prev) => ({
      ...prev,
      product_id: null,
      product_name: "",
      product_description: "",
      hs_code: "",
      origin_country: "",
      unit: prev.unit || "MT",
      unit_price: "",
    }));
  };

  const handleSubmit = () => {
    const err = validateForm(form);
    if (err) {
      toast.error(t("loi-toast-error"), { description: err });
      return;
    }
    saveMutation.mutate(form);
  };

  // ─── Live total computed from form ────────────────────────────────────
  const liveTotal = useMemo(() => {
    const q = Number(form.quantity);
    const p = Number(form.unit_price);
    if (!Number.isFinite(q) || !Number.isFinite(p)) return 0;
    return Math.round(q * p * 100) / 100;
  }, [form.quantity, form.unit_price]);

  // ─── Derived lists for filter dropdowns ───────────────────────────────
  const statuses: LoiStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "cancelled"];

  return (
    <div>
      <PageHeader
        title={t("loi-title")}
        description={t("loi-title") + (total > 0 ? ` — ${total}` : "")}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4 mr-1" /> {t("loi-create")}
          </Button>
        }
      />

      {/* Filters */}
      <Card className="mb-4 border-border/60 shadow-soft">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("loi-search-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-44">
              <SelectValue placeholder={t("loi-status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("loi-all-statuses")}</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>{t(STATUS_LABEL_KEYS[s])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <PartnerPicker
            value={partnerFilter === "all" ? "" : partnerFilter}
            allowClear
            placeholder={t("loi-all-partners")}
            onSelect={(p) => setPartnerFilter(p?.id || "all")}
            className="md:w-48"
          />
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isError ? (
            <div className="p-4">
              <QueryError onRetry={() => refetch()} />
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="size-6" />}
              title={t("loi-empty-title")}
              description={t("loi-empty-desc")}
              action={
                <Button onClick={openCreate}>
                  <Plus className="size-4 mr-1" /> {t("loi-create")}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="min-w-[110px]">{t("loi-number")}</TableHead>
                      <TableHead className="min-w-[160px]">{t("loi-subject")}</TableHead>
                      <TableHead className="min-w-[120px]">{t("loi-buyer")}</TableHead>
                      <TableHead className="min-w-[120px]">{t("loi-seller")}</TableHead>
                      <TableHead className="min-w-[130px]">{t("loi-product")}</TableHead>
                      <TableHead className="text-right min-w-[90px]">{t("loi-quantity")}</TableHead>
                      <TableHead className="text-right min-w-[120px]">{t("loi-total-value")}</TableHead>
                      <TableHead className="min-w-[100px]">{t("loi-status")}</TableHead>
                      <TableHead className="min-w-[100px]">{t("loi-validity")}</TableHead>
                      <TableHead className="min-w-[90px]">{t("loi-created")}</TableHead>
                      <TableHead className="text-right min-w-[170px]">{t("loi-actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((loi) => (
                      <TableRow
                        key={loi.id}
                        className="cursor-pointer"
                        onClick={() => setDetailId(loi.id)}
                      >
                        <TableCell className="font-mono text-xs">{loi.number}</TableCell>
                        <TableCell className="font-medium">
                          <div className="truncate max-w-[260px]" title={loi.subject}>
                            {loi.subject}
                          </div>
                        </TableCell>
                        <TableCell className="truncate max-w-[160px]" title={loi.buyer_name}>
                          {loi.buyer_name}
                        </TableCell>
                        <TableCell className="truncate max-w-[160px]" title={partnerName(loi.partner_id)}>
                          {partnerName(loi.partner_id)}
                        </TableCell>
                        <TableCell className="truncate max-w-[160px]" title={loi.product_name}>
                          {loi.product_name}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtNumber(loi.quantity)} <span className="text-xs text-muted-foreground">{loi.unit}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {fmtMoney(loi.total_value, loi.currency)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={loi.status} />
                        </TableCell>
                        <TableCell className="text-sm">{fmtDate(loi.validity_until)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDate(loi.created_at)}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDetailId(loi.id)}
                              title={t("loi-view")}
                            >
                              <Eye className="size-3.5" />
                            </Button>
                            {loi.status === "draft" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openEdit(loi)}
                                title={t("loi-edit")}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                            )}
                            {loi.status === "draft" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setSendId(loi.id);
                                  const p = partners.data?.items.find((x) => x.id === loi.partner_id);
                                  setSendEmail(p?.email || "");
                                }}
                                title={t("loi-send")}
                              >
                                <Send className="size-3.5" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleDownload(loi)}
                              title={t("loi-download-pdf")}
                            >
                              <Download className="size-3.5" />
                            </Button>
                            {["draft", "cancelled"].includes(loi.status) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDeleteId(loi.id)}
                                title={t("loi-delete")}
                                className="text-destructive hover:text-destructive"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail Sheet */}
      <Sheet open={!!detailId} onOpenChange={(v) => !v && setDetailId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("loi-detail-title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("loi-detail-title")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : detail.data ? (
            <LoiDetail
              loi={detail.data}
              tenant={tenant}
              tenantLoading={tenantQuery.isLoading}
              partnerName={partnerName(detail.data.partner_id)}
              hasProductLink={!!detail.data.product_id}
              onViewProduct={() => setView("products")}
              onEdit={() => {
                setDetailId(null);
                openEdit(detail.data);
              }}
              onSend={() => {
                setDetailId(null);
                setSendId(detail.data.id);
                const p = partners.data?.items.find((x) => x.id === detail.data.partner_id);
                setSendEmail(p?.email || "");
              }}
              onDownload={() => handleDownload(detail.data)}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Create / Edit Dialog */}
      <Dialog open={showForm} onOpenChange={(v) => !v && closeForm()}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("loi-edit-title") : t("loi-create-title")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editing ? t("loi-edit-title") : t("loi-create-title")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
            <div className="sm:col-span-2">
              <Label>{t("loi-seller")} <span className="text-destructive">*</span></Label>
              <PartnerPicker
                value={form.partner_id}
                onSelect={(p) => setForm({ ...form, partner_id: p?.id || "" })}
                allowClear={false}
                placeholder={t("loi-all-partners")}
              />
            </div>

            {/* Buyer (read-only — auto-filled from the tenant profile).
                The tenant IS the buyer; the LOI is issued BY the tenant TO
                the seller partner. The backend ignores buyer_name/address/
                contact in the request body and fills them from the tenant
                record, so we don't collect them. */}
            <div className="sm:col-span-2">
              <Label>{t("loi-buyer-auto-filled")}</Label>
              <BuyerInfoCard tenant={tenant} loading={tenantQuery.isLoading} />
              <p className="text-xs text-muted-foreground mt-1.5 flex items-start gap-1.5">
                <Info className="size-3.5 shrink-0 mt-0.5" />
                <span>{t("loi-buyer-note")}</span>
              </p>
            </div>

            <div className="sm:col-span-2">
              <Label>{t("loi-subject")} <span className="text-destructive">*</span></Label>
              <Input
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="Letter of Intent — Purchase of ..."
              />
            </div>

            {/* Product section: a ProductPicker at the top (lets the user
                auto-fill product_name/description/hs_code/origin_country/
                unit/unit_price from a catalog row), followed by the
                editable product fields. When a product is selected, a
                "Product selected" badge + "Clear selection" button appear
                next to the picker — clearing the selection drops the
                product_id link and resets the fields to manual entry.
                The fields below are ALWAYS editable, even when a product
                is selected — the API respects explicit values over the
                product auto-fill, so the user can tweak unit_price for
                this specific LOI without affecting the catalog row. */}
            <div className="sm:col-span-2">
              <div className="flex items-center justify-between gap-2 mb-2">
                <Label className="mb-0">{t("loi-product")}</Label>
                {form.product_id && (
                  <Badge variant="secondary" className="gap-1">
                    <Package className="size-3" />
                    {t("loi-product-selected")}
                    {selectedProduct?.sku && (
                      <span className="font-mono text-[10px] opacity-70">
                        {selectedProduct.sku}
                      </span>
                    )}
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <ProductPicker
                    value={form.product_id ?? ""}
                    onSelect={handleProductPick}
                    fallbackName={editing?.product_name || form.product_name || undefined}
                    fallbackSku={undefined}
                    placeholder={t("loi-select-from-catalog")}
                  />
                </div>
                {form.product_id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleClearProduct}
                    className="h-8 text-xs text-muted-foreground"
                    title={t("loi-clear-selection")}
                  >
                    <X className="size-3.5" />
                    <span className="ml-1">{t("loi-clear-selection")}</span>
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 flex items-start gap-1.5">
                <Info className="size-3.5 shrink-0 mt-0.5" />
                <span>
                  {t("loi-select-from-catalog")} — {t("loi-enter-manually")}.
                </span>
              </p>
            </div>

            <div>
              <Label>{t("loi-product-name")} <span className="text-destructive">*</span></Label>
              <Input
                value={form.product_name}
                onChange={(e) => setForm({ ...form, product_name: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("loi-hs-code")}</Label>
              <Input
                value={form.hs_code}
                onChange={(e) => setForm({ ...form, hs_code: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label>{t("loi-product-description")}</Label>
              <Textarea
                rows={2}
                value={form.product_description}
                onChange={(e) => setForm({ ...form, product_description: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label>{t("loi-origin-country")}</Label>
              <CountrySelect
                value={form.origin_country || null}
                onChange={(v) => setForm({ ...form, origin_country: v })}
              />
            </div>

            <div>
              <Label>{t("loi-quantity")} <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                step="any"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("loi-unit")} <span className="text-destructive">*</span></Label>
              <UnitSelect
                value={form.unit}
                onChange={(v) => setForm({ ...form, unit: v })}
              />
            </div>
            <div>
              <Label>{t("loi-unit-price")} <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                step="any"
                value={form.unit_price}
                onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("loi-currency")} <span className="text-destructive">*</span></Label>
              <Select
                value={form.currency}
                onValueChange={(v) => setForm({ ...form, currency: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("loi-currency")} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="sm:col-span-2 rounded-md bg-muted/40 px-3 py-2 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("loi-total-value-computed")}</span>
              <span className="text-base font-semibold tabular-nums">
                {fmtMoney(liveTotal, form.currency)}
              </span>
            </div>

            <div>
              <Label>{t("loi-validity-until")} <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={form.validity_until}
                onChange={(e) => setForm({ ...form, validity_until: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("loi-delivery-date")}</Label>
              <Input
                type="date"
                value={form.delivery_date}
                onChange={(e) => setForm({ ...form, delivery_date: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("loi-delivery-terms")}</Label>
              <Input
                value={form.delivery_terms}
                onChange={(e) => setForm({ ...form, delivery_terms: e.target.value })}
                placeholder="e.g. CIF Rotterdam"
              />
            </div>
            <div>
              <Label>{t("loi-payment-terms")}</Label>
              <Input
                value={form.payment_terms}
                onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                placeholder="e.g. 30% advance, 70% on B/L"
              />
            </div>

            <div className="sm:col-span-2">
              <Label>{t("loi-notes")}</Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label>{t("loi-terms-text")}</Label>
              <Textarea
                rows={6}
                value={form.terms_text}
                onChange={(e) => setForm({ ...form, terms_text: e.target.value })}
                placeholder="This Letter of Intent sets forth the buyer's intent to purchase..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeForm}>
              {t("loi-cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : null}
              {t("loi-save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send confirmation dialog */}
      <AlertDialog open={!!sendId} onOpenChange={(v) => !v && setSendId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("loi-send")}</AlertDialogTitle>
            <AlertDialogDescription>{t("loi-confirm-send")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Label>{t("loi-buyer-contact")}</Label>
            <Input
              type="email"
              placeholder="partner@example.com"
              value={sendEmail}
              onChange={(e) => setSendEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to mark as sent without sending an email (portal notification only).
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sendMutation.isPending}>{t("loi-cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={sendMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (sendId) sendMutation.mutate({ id: sendId, email: sendEmail || undefined });
              }}
            >
              {sendMutation.isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t("loi-send")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={(v) => !v && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("loi-delete")}</AlertDialogTitle>
            <AlertDialogDescription>{t("loi-confirm-delete")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("loi-cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (deleteId) deleteMutation.mutate(deleteId);
              }}
            >
              {deleteMutation.isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t("loi-delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────
function LoiDetail({
  loi, partnerName, onEdit, onSend, onDownload,
  tenant, tenantLoading, hasProductLink, onViewProduct,
}: {
  loi: LetterOfIntent;
  partnerName: string;
  onEdit: () => void;
  onSend: () => void;
  onDownload: () => void;
  /** The tenant record (= the buyer). Used to render the read-only buyer
   *  info card at the top of the detail panel, mirroring the form. When
   *  `null` (tenant query not yet resolved, or 404), the LOI's own
   *  buyer_name / buyer_address / buyer_contact fields are shown as a
   *  fallback so the panel is never empty. */
  tenant: Tenant | null;
  tenantLoading: boolean;
  /** When true, the LOI was created from a catalog product (loi.product_id
   *  is set) — render a "View product in catalog" link below the product
   *  DetailCard. */
  hasProductLink: boolean;
  onViewProduct: () => void;
}) {
  const t = useT();
  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusBadge status={loi.status} />
          <span className="text-sm font-mono text-muted-foreground">{loi.number}</span>
        </div>
        <div className="flex items-center gap-2">
          {loi.status === "draft" && (
            <Button size="sm" onClick={onSend}>
              <Send className="size-3.5 mr-1" /> {t("loi-send")}
            </Button>
          )}
          {loi.status === "draft" && (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="size-3.5 mr-1" /> {t("loi-edit")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onDownload}>
            <Download className="size-3.5 mr-1" /> {t("loi-download-pdf")}
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold leading-tight">{loi.subject}</h3>
        <p className="text-sm text-muted-foreground mt-1">{loi.product_name}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Buyer (read-only — auto-filled from the tenant profile). The
            tenant IS the buyer; the LOI is issued BY the tenant. We use
            the live tenant record when available, and fall back to the
            LOI's own buyer_* fields if the tenant query hasn't resolved
            yet (e.g. on first open). */}
        <DetailCard label={t("loi-buyer-auto-filled")}>
          {tenant ? (
            <BuyerInfoBody tenant={tenant} />
          ) : tenantLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            // Fallback: render the snapshot stored on the LOI itself.
            <div>
              <div className="font-medium">{loi.buyer_name}</div>
              {loi.buyer_contact && (
                <div className="text-sm text-muted-foreground">{loi.buyer_contact}</div>
              )}
              {loi.buyer_address && (
                <div className="text-sm text-muted-foreground whitespace-pre-line">
                  {loi.buyer_address}
                </div>
              )}
            </div>
          )}
        </DetailCard>
        <DetailCard label={t("loi-seller")}>
          <div className="font-medium">{partnerName}</div>
        </DetailCard>
      </div>

      <DetailCard label={t("loi-product")}>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("loi-product-name")}</dt>
          <dd>{loi.product_name}</dd>
          {loi.product_description && (
            <>
              <dt className="text-muted-foreground">{t("loi-product-description")}</dt>
              <dd className="whitespace-pre-line">{loi.product_description}</dd>
            </>
          )}
          {loi.hs_code && (
            <>
              <dt className="text-muted-foreground">{t("loi-hs-code")}</dt>
              <dd className="font-mono">{loi.hs_code}</dd>
            </>
          )}
          {loi.origin_country && (
            <>
              <dt className="text-muted-foreground">{t("loi-origin-country")}</dt>
              <dd>{loi.origin_country}</dd>
            </>
          )}
        </dl>
        {hasProductLink && (
          <Button
            type="button"
            size="sm"
            variant="link"
            onClick={onViewProduct}
            className="h-auto p-0 mt-2 text-xs"
          >
            <Package className="size-3 mr-1" />
            {t("loi-view-product")}
          </Button>
        )}
      </DetailCard>

      <DetailCard label={t("loi-quantity") + " / " + t("loi-total-value")}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">{t("loi-quantity")}</div>
            <div className="font-medium tabular-nums">
              {fmtNumber(loi.quantity)} <span className="text-xs text-muted-foreground">{loi.unit}</span>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">{t("loi-unit-price")}</div>
            <div className="font-medium tabular-nums">{fmtMoney(loi.unit_price, loi.currency)}</div>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <div className="text-muted-foreground text-xs">{t("loi-total-value")}</div>
            <div className="font-semibold tabular-nums text-base">{fmtMoney(loi.total_value, loi.currency)}</div>
          </div>
        </div>
      </DetailCard>

      <DetailCard label={t("loi-delivery-terms") + " / " + t("loi-payment-terms")}>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <div>
            <dt className="text-muted-foreground">{t("loi-delivery-terms")}</dt>
            <dd>{loi.delivery_terms || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("loi-delivery-date")}</dt>
            <dd>{fmtDate(loi.delivery_date)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("loi-payment-terms")}</dt>
            <dd>{loi.payment_terms || "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("loi-validity-until")}</dt>
            <dd className="font-medium">{fmtDate(loi.validity_until)}</dd>
          </div>
        </dl>
      </DetailCard>

      {loi.notes && (
        <DetailCard label={t("loi-notes")}>
          <div className="text-sm whitespace-pre-line">{loi.notes}</div>
        </DetailCard>
      )}

      {loi.terms_text && (
        <DetailCard label={t("loi-terms-text")}>
          <div className="text-sm whitespace-pre-line leading-relaxed">{loi.terms_text}</div>
        </DetailCard>
      )}

      <div className="text-xs text-muted-foreground pt-2 border-t border-border/40">
        <span>{t("loi-created")}: {fmtDate(loi.created_at)}</span>
        {loi.sent_at && <span className="ml-4">{t("loi-status-sent")}: {fmtDate(loi.sent_at)}</span>}
        {loi.responded_at && <span className="ml-4">Responded: {fmtDate(loi.responded_at)}</span>}
      </div>
    </div>
  );
}

function DetailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/40 bg-card p-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}

// ─── Buyer info (read-only) ───────────────────────────────────────────────
// Used by BOTH the form (BuyerInfoCard) and the detail panel (BuyerInfoBody).
// Renders the tenant's legal name, address and contact info as a static
// info card — no inputs, because the backend fills these from the tenant
// profile and the buyer cannot be overridden.

/** Assembles a single-line address from the tenant's address fields,
 *  matching the API's own `buyerAddress` join logic. */
function tenantAddress(t: Tenant): string | null {
  const parts = [t.address_line, t.postal_code, t.city, t.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Assembles a single-line contact line from the tenant's email + phone,
 *  matching the API's own `buyerContact` join logic. */
function tenantContact(t: Tenant): string | null {
  const parts = [t.email, t.phone].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : null;
}

function BuyerInfoBody({ tenant }: { tenant: Tenant }) {
  const name = tenant.legal_name || tenant.name;
  const address = tenantAddress(tenant);
  const contact = tenantContact(tenant);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 font-medium">
        <Building2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="truncate">{name}</span>
      </div>
      {address && (
        <div className="text-sm text-muted-foreground whitespace-pre-line pl-5">
          {address}
        </div>
      )}
      {contact && (
        <div className="text-sm text-muted-foreground pl-5">{contact}</div>
      )}
    </div>
  );
}

/** Read-only info card variant used in the form (with a border, padding,
 *  and a "loading" skeleton state for first render). Mirrors the visual
 *  style of an input but is purely presentational. */
function BuyerInfoCard({
  tenant,
  loading,
}: {
  tenant: Tenant | null;
  loading: boolean;
}) {
  if (loading && !tenant) {
    return <Skeleton className="h-16 w-full rounded-md" />;
  }
  if (!tenant) {
    return (
      <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        Tenant profile not available — buyer will be auto-filled on save.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
      <BuyerInfoBody tenant={tenant} />
    </div>
  );
}
