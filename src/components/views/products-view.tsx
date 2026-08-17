"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationPrevious, PaginationNext, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  Plus, Search, Package, Pencil, Trash2, Eye, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronRight, Wand2, Download, Info, Upload, FileDown, Power, PowerOff,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtMoney, fmtNumber, fmtDate, fmtRelative } from "@/lib/utils/format";
import { Product } from "@/lib/supabase/types";
import { CURRENCIES, PRODUCT_UNITS } from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { usePageSize } from "@/lib/hooks/use-page-size";
import { PageSizeSelector } from "@/components/common/page-size-selector";
import { BulkActionBar, useRowSelection } from "@/components/common/bulk-action-bar";
import { EyeOff, Trash } from "lucide-react";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";

type StockStatus = "ok" | "low" | "out";

function stockStatus(p: Product): StockStatus {
  if (p.stock <= 0) return "out";
  if (p.stock <= p.reorder_level) return "low";
  return "ok";
}

// ---- Pagination helper ----
function generatePageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "ellipsis")[] = [1];
  if (current > 3) pages.push("ellipsis");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 2) pages.push("ellipsis");
  pages.push(total);
  return pages;
}

export function ProductsView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const { pageSize: PAGE_SIZE, setPageSize, options: pageSizeOptions } = usePageSize("products", 20);
  useEffect(() => { setPage(1); }, [PAGE_SIZE]);
  const [editing, setEditing] = useState<Product | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleSearchChange = useCallback((v: string) => { setSearch(v); setPage(1); }, []);
  const handleCategoryChange = useCallback((v: string) => { setCategoryFilter(v); setPage(1); }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["products", tenantKey, search, categoryFilter, page, PAGE_SIZE],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const r = await fetch(api(`/api/products?${params}`));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: Product[]; total: number }>;
    },
  });

  // Distinct categories across ALL products (not just the current page) —
  // used by the form's category datalist so the user can pick from the
  // 12+ real categories in production (tobacco, agriculture, metals, …)
  // instead of the 7 hardcoded PRODUCT_CATEGORIES_LOCAL.
  const { data: allCategories } = useQuery({
    queryKey: ["product-categories-all", tenantKey],
    queryFn: async () => {
      const r = await fetch(api(`/api/products?limit=10000`));
      if (!r.ok) throw new Error("Failed to load categories");
      const d = await r.json() as { items: Product[] };
      return Array.from(
        new Set(d.items.map((p) => p.category).filter(Boolean) as string[])
      ).sort();
    },
    staleTime: 60_000,
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const rowSel = useRowSelection(items);

  // Bulk mutations
  const bulkCatalogMut = useMutation({
    mutationFn: async ({ ids, show }: { ids: string[]; show: boolean }) => {
      const r = await fetch(api("/api/products/bulk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: show ? "show_in_portal" : "hide_from_portal" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Bulk operation failed");
      }
      return (await r.json()) as { successCount: number; failureCount: number };
    },
    onSuccess: (data, vars) => {
      if (data.failureCount === 0) {
        toast.success(`${data.successCount} ${t(locale, "crm-products-updated")}`);
      } else {
        toast.warning(
          `${data.successCount} ${t(locale, "crm-updated-lower")} · ${data.failureCount} ${t(locale, "crm-failed-lower")}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["products", tenantKey] });
      qc.invalidateQueries({ queryKey: ["portal-catalog"] });
      // intentionally not invalidating variants.selected to avoid stale
      // closure warnings — rowSel.clear() drops the selection.
      rowSel.clear();
    },
    onError: (e: any) => toast.error(e?.message || t(locale, "crm-bulk-update-failed")),
  });

  // Bulk activate / deactivate — toggles `products.active` via the bulk endpoint.
  const bulkActiveMut = useMutation({
    mutationFn: async ({ ids, activate }: { ids: string[]; activate: boolean }) => {
      const r = await fetch(api("/api/products/bulk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: activate ? "activate" : "deactivate" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Bulk operation failed");
      }
      return (await r.json()) as { successCount: number; failureCount: number };
    },
    onSuccess: (data, vars) => {
      const key = vars.activate ? "crm-bulk-activate-success" : "crm-bulk-deactivate-success";
      if (data.failureCount === 0) {
        toast.success(t(locale, key).replace("${n}", String(data.successCount)));
      } else {
        toast.warning(
          `${data.successCount} ${t(locale, "crm-updated-lower")} · ${data.failureCount} ${t(locale, "crm-failed-lower")}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["products", tenantKey] });
      rowSel.clear();
    },
    onError: (e: any, vars) => {
      const key = vars.activate ? "crm-bulk-activate-failed" : "crm-bulk-deactivate-failed";
      toast.error(e?.message || t(locale, key));
    },
  });

  const bulkDeleteMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const r = await fetch(api("/api/products/bulk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "delete" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || "Bulk delete failed");
      }
      return (await r.json()) as { successCount: number; failureCount: number };
    },
    onSuccess: (data) => {
      if (data.failureCount === 0) {
        toast.success(`${data.successCount} ${t(locale, "crm-products-deleted")}`);
      } else {
        toast.warning(
          `${data.successCount} ${t(locale, "crm-deleted-lower")} · ${data.failureCount} ${t(locale, "crm-failed-lower")}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["products", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      rowSel.clear();
    },
    onError: (e: any) => toast.error(e?.message || t(locale, "crm-bulk-delete-failed")),
  });

  // Bulk export selected — opens the unified /api/export endpoint with the
  // selected IDs in the query string.
  const bulkExportSelected = () => {
    if (rowSel.ids.length === 0) return;
    const url = `/api/export?type=products&format=csv&ids=${encodeURIComponent(rowSel.ids.join(","))}`;
    window.open(url, "_blank");
  };

  // ── CSV import ───────────────────────────────────────────────────────
  // Hidden <input type="file"> triggered by the "Import CSV" button. The
  // selected file is POSTed as FormData to /api/import?type=products, which
  // parses the CSV and upserts each row. The response carries per-row
  // success/failure counts so we can surface a useful toast.
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(api("/api/import?type=products"), { method: "POST", body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || t(locale, "crm-import-failed"));
      }
      return (await r.json()) as { successCount: number; failureCount: number; totalRows: number };
    },
    onSuccess: (data) => {
      if (data.failureCount === 0) {
        toast.success(t(locale, "crm-import-success").replace("${n}", String(data.successCount)).replace("${fail}", "0"));
      } else {
        toast.warning(
          t(locale, "crm-import-success")
            .replace("${n}", String(data.successCount))
            .replace("${fail}", String(data.failureCount)),
        );
      }
      qc.invalidateQueries({ queryKey: ["products", tenantKey] });
      qc.invalidateQueries({ queryKey: ["product-categories-all", tenantKey] });
    },
    onError: (e: any) => toast.error(e?.message || t(locale, "crm-import-failed")),
  });

  const categories = useMemo(() => {
    const set = new Set<string>();
    items.forEach((p) => { if (p.category) set.add(p.category); });
    return Array.from(set).sort();
  }, [items]);

  const selected = useMemo(
    () => items.find((p) => p.id === detailId) || null,
    [items, detailId],
  );

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/products/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t(locale, "crm-product-deleted"));
      qc.invalidateQueries({ queryKey: ["products", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t(locale, "crm-delete-failed")),
  });

  async function toggleCatalog(p: Product, next: boolean) {
    try {
      const r = await fetch(api(`/api/products`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...p,
          show_in_catalog: next,
          force: true,
          // Ensure tenant_id is always present — super-admins browsing without
          // an active tenant context would otherwise send tenant_id=null and
          // the POST would 400 on the NOT NULL column.
          tenant_id: p.tenant_id,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || t(locale, "crm-update-failed"));
      }
      toast.success(next ? t(locale, "crm-now-visible-portal") : t(locale, "crm-hidden-portal"));
      qc.invalidateQueries({ queryKey: ["products", tenantKey] });
      qc.invalidateQueries({ queryKey: ["portal-catalog"] });
    } catch (e: any) {
      toast.error(e.message || t(locale, "crm-update-failed"));
    }
  }

  return (
    <div>
      <PageHeader
        title={t(locale, "products")}
        description={`${total} ${t(locale, "crm-total-lower")}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open("/api/products/export?format=csv", "_blank")}
              title={t(locale, "crm-export-csv")}
            >
              <Download className="size-4" /> {t(locale, "crm-export-csv")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => importFileRef.current?.click()}
              disabled={importMut.isPending}
              title={t(locale, "crm-import-csv-tooltip")}
            >
              <Upload className="size-4" /> {t(locale, "crm-import-csv")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // CSV template — opens a data: URL so the user gets a
                // starter file with the correct headers. No server round-trip
                // needed; the columns mirror /api/export?type=products.
                const headers = [
                  "sku", "name", "category", "unit", "price", "currency",
                  "cost", "stock", "reorder_level", "active", "show_in_catalog",
                  "hs_code", "brand", "description",
                ];
                const sample = [
                  "DEMO-001", "Demo Product", "tobacco", "MT", "1500", "USD",
                  "1200", "100", "20", "true", "true", "24011000", "DemoBrand",
                  '"Sample description, commas are OK when quoted"',
                ];
                const csv = `${headers.join(",")}\n${sample.join(",")}\n`;
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "products-template.csv";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              title={t(locale, "crm-import-template-tooltip")}
              className="text-muted-foreground"
            >
              {t(locale, "crm-import-template")}
            </Button>
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t(locale, "crm-new-product")}
            </Button>
          </div>
        }
      />

      {/* Hidden file input for CSV import. The button triggers .click() on
          this input; the change handler uploads the file via the importMut
          mutation. Accept is restricted to CSV-like MIME types so the OS
          file picker filters out non-CSV files. */}
      <input
        ref={importFileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importMut.mutate(file);
          // Reset the input so selecting the same file twice in a row
          // still fires onChange (otherwise the second pick is a no-op).
          e.target.value = "";
        }}
      />

      {/* Explanatory banner — Products is now the single source of truth.
          Product Catalog (the old spec-sheet table) has been merged in. */}
      <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <Info className="size-5 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">{t(locale, "crm-products-banner-title")}</h3>
            <p className="text-sm text-muted-foreground">
              {t(locale, "crm-products-banner-desc")}
            </p>
            <div className="flex flex-wrap gap-4 mt-2 text-xs text-muted-foreground">
              <span>📋 {t(locale, "crm-products-banner-active")}</span>
              <span>👁️ {t(locale, "crm-products-banner-portal")}</span>
              <span>📦 {t(locale, "crm-products-banner-stock")}</span>
            </div>
          </div>
        </div>
      </div>

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t(locale, "crm-search-sku-name")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={categoryFilter} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-full md:w-48"><SelectValue placeholder={t(locale, "crm-category")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t(locale, "crm-all-categories")}</SelectItem>
              {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Package className="size-6" />}
              title={t(locale, "crm-no-products")}
              description={t(locale, "crm-no-products-populate-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t(locale, "crm-new-product")}</Button>}
            />
          ) : (
            <>
              <div className="max-h-[calc(100vh-340px)] overflow-y-auto custom-scroll">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          checked={rowSel.allOnPageSelected}
                          onCheckedChange={rowSel.toggleAllOnPage}
                          aria-label={t(locale, "crm-select-all-on-page")}
                        />
                      </TableHead>
                      <TableHead className="w-28">{t(locale, "crm-sku")}</TableHead>
                      <TableHead>{t(locale, "name")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t(locale, "crm-category")}</TableHead>
                      <TableHead className="text-right">{t(locale, "crm-price")}</TableHead>
                      <TableHead className="text-right">{t(locale, "crm-stock")}</TableHead>
                      <TableHead>{t(locale, "status")}</TableHead>
                      <TableHead className="text-center" title={t(locale, "crm-portal-toggle-tooltip")}>
                        {t(locale, "portal")}
                      </TableHead>
                      <TableHead className="text-right">{t(locale, "actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((p) => {
                      const st = stockStatus(p);
                      return (
                        <TableRow
                          key={p.id}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setDetailId(p.id)}
                          data-state={rowSel.isSelected(p.id) ? "selected" : undefined}
                        >
                          <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={rowSel.isSelected(p.id)}
                              onCheckedChange={() => rowSel.toggle(p.id)}
                              aria-label={`${t(locale, "crm-select")} ${p.sku}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular">{p.sku}</TableCell>
                          <TableCell>
                            <div className="font-medium">{p.name}</div>
                            <div className="text-xs text-muted-foreground">{p.unit}</div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {p.category
                              ? <Badge variant="outline">{p.category}</Badge>
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular">{fmtMoney(p.price, p.currency)}</TableCell>
                          <TableCell className="text-right">
                            {st === "out" ? (
                              <span className="inline-flex items-center gap-1 text-destructive font-medium tabular">
                                <AlertTriangle className="size-3.5" /> {fmtNumber(p.stock)}
                              </span>
                            ) : st === "low" ? (
                              <span className="inline-flex items-center gap-1 text-amber-600 font-medium tabular">
                                <AlertTriangle className="size-3.5" /> {fmtNumber(p.stock)}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-600 font-medium tabular">
                                <CheckCircle2 className="size-3.5" /> {fmtNumber(p.stock)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {p.active
                              ? <Badge>{t(locale, "active")}</Badge>
                              : <Badge variant="secondary">{t(locale, "inactive")}</Badge>}
                          </TableCell>
                          <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={!!p.show_in_catalog}
                              onCheckedChange={(v) => toggleCatalog(p, v)}
                              aria-label={t(locale, "crm-show-in-portal-catalog")}
                            />
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(p.id)} title={t(locale, "view")} aria-label={t(locale, "view")}>
                                <Eye className="size-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(p); setShowForm(true); }} title={t(locale, "edit")} aria-label={t(locale, "edit")}>
                                <Pencil className="size-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(p.id)} title={t(locale, "delete")} aria-label={t(locale, "delete")}>
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination + Page size */}
              <div className="flex items-center justify-between border-t px-4 py-3 gap-3 flex-wrap">
                <p className="text-sm text-muted-foreground">
                  {total > 0
                    ? <>{t(locale, "crm-showing")} {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} {t(locale, "crm-of")} {total}</>
                    : <>{t(locale, "no_results")}</>}
                </p>
                <div className="flex items-center gap-3">
                  <PageSizeSelector value={PAGE_SIZE} onChange={setPageSize} options={pageSizeOptions} />
                  {totalPages > 1 && (
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                      {generatePageNumbers(page, totalPages).map((p, i) =>
                        p === "ellipsis" ? (
                          <PaginationItem key={`ellipsis-${i}`}>
                            <PaginationEllipsis />
                          </PaginationItem>
                        ) : (
                          <PaginationItem key={p}>
                            <PaginationLink
                              isActive={page === p}
                              onClick={() => setPage(p as number)}
                              className="cursor-pointer"
                            >
                              {p}
                            </PaginationLink>
                          </PaginationItem>
                        )
                      )}
                      <PaginationItem>
                        <PaginationNext
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Form dialog */}
      <ProductFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        product={editing}
        existingCategories={allCategories || []}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["products", tenantKey] });
          qc.invalidateQueries({ queryKey: ["product-categories-all", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Package className="size-5" />
              {selected?.name || t(locale, "crm-product")}
            </SheetTitle>
            <SheetDescription className="font-mono">{selected?.sku}</SheetDescription>
          </SheetHeader>
          {selected ? (
            <ProductDetail product={selected} />
          ) : (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(locale, "crm-delete-product-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(locale, "crm-delete-product-inventory-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(locale, "cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t(locale, "delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BulkActionBar
        count={rowSel.count}
        onClear={rowSel.clear}
        label={rowSel.count === 1 ? t(locale, "crm-product-selected") : t(locale, "crm-products-selected")}
        actions={[
          {
            key: "activate",
            label: t(locale, "crm-bulk-activate-label"),
            icon: <Power className="size-4" />,
            variant: "default",
            disabled: bulkActiveMut.isPending,
            onClick: () => bulkActiveMut.mutate({ ids: rowSel.ids, activate: true }),
          },
          {
            key: "deactivate",
            label: t(locale, "crm-bulk-deactivate-label"),
            icon: <PowerOff className="size-4" />,
            variant: "outline",
            disabled: bulkActiveMut.isPending,
            onClick: () => bulkActiveMut.mutate({ ids: rowSel.ids, activate: false }),
          },
          {
            key: "show-in-portal",
            label: t(locale, "crm-show-in-portal"),
            icon: <Eye className="size-4" />,
            variant: "outline",
            disabled: bulkCatalogMut.isPending,
            onClick: () => bulkCatalogMut.mutate({ ids: rowSel.ids, show: true }),
          },
          {
            key: "hide-from-portal",
            label: t(locale, "crm-hide-from-portal"),
            icon: <EyeOff className="size-4" />,
            variant: "outline",
            disabled: bulkCatalogMut.isPending,
            onClick: () => bulkCatalogMut.mutate({ ids: rowSel.ids, show: false }),
          },
          {
            key: "export-selected",
            label: t(locale, "crm-bulk-export-selected"),
            icon: <FileDown className="size-4" />,
            variant: "outline",
            disabled: rowSel.count === 0,
            onClick: bulkExportSelected,
          },
          {
            key: "delete",
            label: t(locale, "delete"),
            icon: <Trash className="size-4" />,
            variant: "destructive",
            disabled: bulkDeleteMut.isPending,
            confirm: `${t(locale, "crm-delete-n-products-confirm")} (${rowSel.count})`,
            onClick: () => bulkDeleteMut.mutate(rowSel.ids),
          },
        ]}
      />
    </div>
  );
}

// ---- Detail panel ----
function ProductDetail({ product }: { product: Product }) {
  const locale = useI18nStore((s) => s.locale);
  const st = stockStatus(product);
  const margin = product.cost && product.cost > 0 && product.price > 0
    ? Math.round(((product.price - product.cost) / product.price) * 100)
    : null;

  const info = [
    { label: t(locale, "crm-unit"), value: product.unit },
    { label: t(locale, "crm-category"), value: product.category || null },
    { label: t(locale, "crm-price"), value: fmtMoney(product.price, product.currency) },
    { label: t(locale, "crm-cost"), value: product.cost ? fmtMoney(product.cost, product.currency) : null },
    { label: t(locale, "crm-margin"), value: margin !== null ? `${margin}%` : null },
    { label: t(locale, "crm-stock"), value: fmtNumber(product.stock) },
    { label: t(locale, "crm-reorder-level"), value: fmtNumber(product.reorder_level) },
  ].filter((x) => x.value);

  // Known imported data keys that should be displayed with nice labels
  // FIX (audit F-8): read from top-level product fields first, fall back to attributes.
  const IMPORTED_KEY_LABELS: Record<string, string> = {
    hs_code: t(locale, "crm-hs-code"),
    brand: t(locale, "crm-brand"),
    image_url: t(locale, "crm-image-url"),
    tags: t(locale, "crm-tags"),
    inventory: t(locale, "inventory"),
  };

  // Build a merged attributes object: top-level fields + attributes JSONB
  // so the detail panel shows data regardless of where it's stored.
  const mergedAttrs: Record<string, unknown> = {
    ...(product.attributes || {}),
    hs_code: (product as any).hs_code ?? (product.attributes as any)?.hs_code ?? null,
    brand: (product as any).brand ?? (product.attributes as any)?.brand ?? null,
    image_url: (product as any).image_url ?? (product.attributes as any)?.image_url ?? null,
    tags: (product as any).tags ?? (product.attributes as any)?.tags ?? null,
    inventory: (product as any).inventory ?? (product.attributes as any)?.inventory ?? null,
  };

  // Separate imported data fields from generic attributes
  // FIX (audit F-8): use mergedAttrs (top-level + attributes) so data
  // stored in dedicated columns (hs_code, brand, etc.) is also shown.
  const attributes = mergedAttrs;
  const importedEntries = Object.entries(mergedAttrs).filter(([k, v]) => k in IMPORTED_KEY_LABELS && v != null);
  const otherEntries = Object.entries(mergedAttrs).filter(([k, v]) => !(k in IMPORTED_KEY_LABELS) && v != null);

  // CoA params can be an array of {name, value} objects OR a key-value object
  const coaParams = (product as any).coa_params;
  const coaEntries: Array<[string, string]> = Array.isArray(coaParams)
    ? coaParams.map((p: any) => [p.name || p.key || "", String(p.value ?? "")])
    : (coaParams && typeof coaParams === "object"
      ? Object.entries(coaParams).map(([k, v]) => [k, String(v)])
      : []);

  // Logistics: {cap20, cap40} or similar
  const logistics = (product as any).logistics;
  const logisticsEntries: Array<[string, string]> = logistics && typeof logistics === "object"
    ? Object.entries(logistics).map(([k, v]) => {
        const label = k === "cap20" ? "20ft Container Capacity" : k === "cap40" ? "40ft Container Capacity" : k;
        return [label, `${v} ${product.unit || "kg"}`];
      })
    : [];

  const detailedSpec = (product as any).detailed_spec;
  const shelfLife = (product as any).shelf_life;

  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={product.active ? "default" : "secondary"}>
          {product.active ? t(locale, "active") : t(locale, "inactive")}
        </Badge>
        {product.category && <Badge variant="outline">{product.category}</Badge>}
        {st === "out" && (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="size-3" /> {t(locale, "crm-out-of-stock")}
          </Badge>
        )}
        {st === "low" && (
          <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 gap-1">
            <AlertTriangle className="size-3" /> {t(locale, "crm-low-stock")}
          </Badge>
        )}
        {st === "ok" && (
          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 gap-1">
            <CheckCircle2 className="size-3" /> {t(locale, "crm-in-stock")}
          </Badge>
        )}
      </div>

      {product.description && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t(locale, "description")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/50">{product.description}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {info.map((x) => (
          <Card key={x.label} className="border-border/60 shadow-soft rounded-xl">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">{x.label}</p>
              <p className="text-sm font-medium mt-0.5 break-words tabular">{x.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Product details: hs_code, brand, shelf_life, logistics, coa_params, etc. */}
      {/* Imported data fields from attributes */}
      {importedEntries.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t(locale, "crm-product-details")}</p>
          <div className="grid grid-cols-2 gap-2">
            {importedEntries.map(([k, v]) => (
              <Card key={k} className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">{IMPORTED_KEY_LABELS[k]}</p>
                  <p className="text-sm font-medium mt-0.5 break-words">
                    {k === "image_url" && typeof v === "string" ? (
                      <a href={v} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">{v}</a>
                    ) : k === "tags" && Array.isArray(v) ? (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {v.map((tag: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-xs">{tag}</Badge>
                        ))}
                      </div>
                    ) : k === "inventory" && typeof v === "object" && v !== null ? (
                      <span className="font-mono text-xs">{JSON.stringify(v)}</span>
                    ) : (
                      String(v)
                    )}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* CoA Parameters (quality specifications) */}
      {coaEntries.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t(locale, "crm-coa-parameters")}</p>
          <div className="rounded-xl border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {coaEntries.map(([name, value], i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-muted/30" : ""}>
                    <td className="px-3 py-1.5 text-muted-foreground font-medium whitespace-nowrap">{name}</td>
                    <td className="px-3 py-1.5 text-right tabular">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detailed specification */}
      {detailedSpec && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t(locale, "crm-detailed-spec") || "Detailed Specification"}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/50">{detailedSpec}</p>
        </div>
      )}

      {/* Logistics */}
      {logisticsEntries.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t(locale, "crm-logistics-label")}</p>
          <div className="grid grid-cols-2 gap-2">
            {logisticsEntries.map(([label, value]) => (
              <Card key={label} className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-sm font-medium mt-0.5 tabular">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Shelf life */}
      {shelfLife && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t(locale, "crm-shelf-life")}</p>
          <p className="text-sm font-medium">{shelfLife}</p>
        </div>
      )}

      {/* Other attributes */}
      {otherEntries.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t(locale, "crm-attributes")}</p>
          <div className="flex flex-wrap gap-1.5">
            {otherEntries.map(([k, v]) => (
              <Badge key={k} variant="secondary" className="font-mono text-xs">
                {k}: {String(v)}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="pt-4 border-t space-y-1">
        <p className="text-xs text-muted-foreground">{t(locale, "crm-created")}: {fmtDate(product.created_at)}</p>
        <p className="text-xs text-muted-foreground">{t(locale, "crm-updated")}: {fmtRelative(product.updated_at)}</p>
      </div>
    </div>
  );
}

// ---- SKU auto-generation ----
function generateSku(name: string): string {
  if (!name.trim()) return "";
  const words = name.trim().split(/\s+/);
  const parts = words.map((w) =>
    w.substring(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, "")
  );
  const suffix = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
  return parts.join("-") + "-" + suffix;
}

// ---- Form dialog ----
function ProductFormDialog({
  open, onOpenChange, product, onSaved, existingCategories,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  product: Product | null;
  onSaved: () => void;
  existingCategories: string[];
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);

  const [form, setForm] = useState<Partial<Product>>({});
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // FIX: Use useEffect instead of useMemo for side effects
  useEffect(() => {
    if (open) {
      setForm(product ? { ...product } : {
        unit: "pcs",
        currency: "USD",
        stock: 0,
        reorder_level: 0,
        active: true,
        price: 0,
        cost: 0,
        attributes: null,
      });
      // Open "More Details" when editing (so user can see all fields)
      setMoreOpen(!!product);
    }
  }, [open, product]);

  function set<K extends keyof Product>(k: K, v: Product[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const handleAutoSku = useCallback(() => {
    const sku = generateSku(form.name || "");
    if (sku) set("sku", sku);
  }, [form.name]);

  async function save() {
    if (!form.name) { toast.error(t(locale, "crm-name-required")); return; }
    // Auto-generate SKU if not provided
    const finalSku = form.sku || generateSku(form.name || "");
    setSaving(true);
    try {
      const method = product ? "PUT" : "POST";
      const url = product ? api(`/api/products/${product.id}`) : api("/api/products");
      const body = { ...form, sku: finalSku };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t(locale, "crm-request-failed"));
      }
      toast.success(product ? t(locale, "crm-product-updated") : t(locale, "crm-product-created"));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t(locale, "crm-saving-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{product ? t(locale, "crm-edit-product") : t(locale, "crm-new-product")}</DialogTitle>
          <DialogDescription>
            {product ? t(locale, "crm-update-product-details") : t(locale, "crm-start-with-basics")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
        <div className="space-y-4 py-2">
          {/* ── Essential fields (always visible) ── */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">{t(locale, "crm-product-name-required")}</Label>
              <Input
                value={form.name || ""}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Aluminum Rod"
                className="h-11 text-base"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>{t(locale, "crm-price")}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price ?? 0}
                  onChange={(e) => set("price", Number(e.target.value))}
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t(locale, "crm-unit")}</Label>
                <Select value={form.unit || "pcs"} onValueChange={(v) => set("unit", v)}>
                  <SelectTrigger className="h-10"><SelectValue placeholder={t(locale, "crm-select-unit")} /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_UNITS.map((u) => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t(locale, "crm-category")}</Label>
                <Input
                  list="product-categories"
                  value={form.category || ""}
                  onChange={(e) => set("category", (e.target.value || null) as Product["category"])}
                  placeholder="e.g. tobacco, agriculture, metals..."
                  className="h-10"
                />
                <datalist id="product-categories">
                  {existingCategories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            </div>

            {/* Prominent SKU auto-generate */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label>{t(locale, "crm-sku")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={handleAutoSku}
                >
                  <Wand2 className="size-3.5" /> {t(locale, "crm-auto-generate")}
                </Button>
              </div>
              <Input
                value={form.sku || ""}
                onChange={(e) => set("sku", e.target.value)}
                placeholder={t(locale, "crm-auto-generated-from-name")}
                className="font-mono"
              />
            </div>
          </div>

          {/* ── More Details (collapsible) ── */}
          <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 w-full py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group"
              >
                {moreOpen ? (
                  <ChevronDown className="size-4 transition-transform" />
                ) : (
                  <ChevronRight className="size-4 transition-transform" />
                )}
                {t(locale, "crm-more-details")}
                {!moreOpen && (form.cost || form.description || form.currency !== "USD" || form.reorder_level) && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{t(locale, "crm-filled")}</Badge>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-1 pb-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t(locale, "crm-cost")}</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form.cost ?? 0}
                      onChange={(e) => set("cost", Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t(locale, "currency")}</Label>
                    <Select value={form.currency || "USD"} onValueChange={(v) => set("currency", v)}>
                      <SelectTrigger><SelectValue placeholder={t(locale, "crm-select-currency")} /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t(locale, "crm-stock")}</Label>
                    <Input
                      type="number"
                      min={0}
                      value={form.stock ?? 0}
                      onChange={(e) => set("stock", Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t(locale, "crm-reorder-level")}</Label>
                    <Input
                      type="number"
                      min={0}
                      value={form.reorder_level ?? 0}
                      onChange={(e) => set("reorder_level", Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>{t(locale, "description")}</Label>
                  <Textarea
                    rows={3}
                    value={form.description || ""}
                    onChange={(e) => set("description", e.target.value)}
                    placeholder={t(locale, "crm-optional-product-description")}
                  />
                </div>

                {/* ── Specification fields (editable) ── */}
                {/* FIX (audit F-2): added brand, hs_code, image_url, origin_country inputs */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t(locale, "crm-brand") || "Brand"}</Label>
                    <Input
                      value={(form as any).brand || ""}
                      onChange={(e) => set("brand" as any, e.target.value)}
                      placeholder="e.g. Al Fakher"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t(locale, "crm-hs-code") || "HS Code"}</Label>
                    <Input
                      value={(form as any).hs_code || ""}
                      onChange={(e) => set("hs_code" as any, e.target.value)}
                      placeholder="e.g. 24031100"
                      className="font-mono"
                    />
                  </div>
                </div>

                {/* Tags — stored as string[]; comma-separated input */}
                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-tags") || "Tags"}</Label>
                  <Input
                    value={(form.tags || []).join(", ")}
                    onChange={(e) => {
                      const arr = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                      set("tags", arr.length > 0 ? arr : null);
                    }}
                    placeholder="e.g. organic, premium, eu-origin"
                  />
                  <p className="text-xs text-muted-foreground">Comma-separated tags</p>
                </div>

                {/* Origin Country — stored in attributes JSONB (origin_country key).
                    The products table has no dedicated column yet, so attributes
                    is the documented workaround (see Product.origin_country). */}
                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-origin-country") || "Origin Country"}</Label>
                  <Input
                    value={(form.attributes as any)?.origin_country || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      const attrs = { ...((form.attributes as any) || {}) };
                      if (v) attrs.origin_country = v;
                      else delete attrs.origin_country;
                      set("attributes", Object.keys(attrs).length > 0 ? attrs : null);
                    }}
                    placeholder="e.g. TR, BR, ID"
                  />
                  <p className="text-xs text-muted-foreground">ISO alpha-2 country code (stored in attributes JSONB)</p>
                </div>

                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-image-url") || "Image URL"}</Label>
                  <Input
                    value={(form as any).image_url || ""}
                    onChange={(e) => set("image_url" as any, e.target.value)}
                    placeholder="https://..."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-shelf-life")}</Label>
                  <Input
                    value={(form as any).shelf_life || ""}
                    onChange={(e) => set("shelf_life" as any, e.target.value)}
                    placeholder="e.g. 24 months sealed"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-detailed-spec") || "Detailed Specification"}</Label>
                  <Textarea
                    rows={4}
                    value={(form as any).detailed_spec || ""}
                    onChange={(e) => set("detailed_spec" as any, e.target.value)}
                    placeholder="Origin, packaging, certifications, quality standards, handling instructions..."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-coa-parameters")}</Label>
                  <p className="text-xs text-muted-foreground">
                    One parameter per line, format: <code className="font-mono">Name | Value</code>
                  </p>
                  <Textarea
                    rows={6}
                    value={(() => {
                      const params = (form as any).coa_params;
                      if (Array.isArray(params)) {
                        return params.map((p: any) => `${p.name || ""} | ${p.value || ""}`).join("\n");
                      }
                      if (params && typeof params === "object") {
                        return Object.entries(params).map(([k, v]) => `${k} | ${String(v)}`).join("\n");
                      }
                      return "";
                    })()}
                    onChange={(e) => {
                      const lines = e.target.value.split("\n").filter(l => l.trim());
                      const arr = lines.map(line => {
                        const [name, ...rest] = line.split("|");
                        return { name: (name || "").trim(), value: rest.join("|").trim() };
                      }).filter(p => p.name);
                      set("coa_params" as any, arr.length > 0 ? arr : null);
                    }}
                    placeholder={"Zinc (Zn) Content | 33.0% Min\nMoisture | 1.0% Max\nAppearance | White powder"}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>20ft Container Capacity ({form.unit || "kg"})</Label>
                    <Input
                      type="number"
                      value={(form as any).logistics?.cap20 ?? ""}
                      onChange={(e) => {
                        const log = { ...((form as any).logistics || {}) };
                        if (e.target.value) log.cap20 = Number(e.target.value);
                        else delete log.cap20;
                        set("logistics" as any, Object.keys(log).length > 0 ? log : null);
                      }}
                      placeholder="e.g. 24000"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>40ft Container Capacity ({form.unit || "kg"})</Label>
                    <Input
                      type="number"
                      value={(form as any).logistics?.cap40 ?? ""}
                      onChange={(e) => {
                        const log = { ...((form as any).logistics || {}) };
                        if (e.target.value) log.cap40 = Number(e.target.value);
                        else delete log.cap40;
                        set("logistics" as any, Object.keys(log).length > 0 ? log : null);
                      }}
                      placeholder="e.g. 27000"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30">
                  <Switch checked={!!form.active} onCheckedChange={(v) => set("active", v)} aria-label={t(locale, "active")} />
                  <div>
                    <p className="text-sm font-medium">{t(locale, "active")}</p>
                    <p className="text-xs text-muted-foreground">{t(locale, "crm-active-products-available")}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30">
                  <Switch checked={!!form.show_in_catalog} onCheckedChange={(v) => set("show_in_catalog", v)} aria-label={t(locale, "crm-show-in-portal-catalog")} />
                  <div>
                    <p className="text-sm font-medium">{t(locale, "crm-show-in-portal-catalog")}</p>
                    <p className="text-xs text-muted-foreground">{t(locale, "crm-portal-clients-see-desc")}</p>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t(locale, "cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t(locale, "crm-saving") : product ? t(locale, "crm-update") : t(locale, "crm-create-product")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
