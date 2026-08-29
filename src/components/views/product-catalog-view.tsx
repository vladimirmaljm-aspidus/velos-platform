"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationPrevious, PaginationNext, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  Plus, Search, Pencil, Trash2, Eye, Package, X, Boxes, Hash, Globe, Tag,
  ChevronDown, ChevronRight, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fmtMoney, fmtDate } from "@/lib/utils/format";
import { ProductCatalogEntry, SupplierOffer, Partner } from "@/lib/supabase/types";
import {
  PRODUCT_CATEGORIES, UNITS_OF_MEASURE,
} from "@/lib/data/reference";
import { getCountry } from "@/lib/data/geo/countries";
import { CountrySelect } from "@/components/common/country-select";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useI18nStore } from "@/lib/i18n/store";
import { t } from "@/lib/i18n/dictionaries";

const PAGE_SIZE = 20;

function flagEmoji(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode.length !== 2) return "";
  const cc = countryCode.toUpperCase();
  const codePoints = [...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

function categoryLabel(code: string): string {
  return PRODUCT_CATEGORIES.find((c) => c.code === code)?.name || code;
}

function unitLabel(code: string): string {
  return UNITS_OF_MEASURE.find((u) => u.code === code)?.name || code;
}

/**
 * Normalize specifications — the Supabase `product_catalog.specifications`
 * column can hold EITHER an array of {name, value} pairs (current shape) OR
 * a Record<string, string> (legacy shape). This helper returns a flat array
 * of {name, value} pairs so the UI never tries to render a raw object.
 */
function normalizeSpecs(raw: unknown): { name: string; value: string }[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return (raw as { name: string; value: string }[]).map((s) => ({
      name: String(s.name ?? ""),
      value: String(s.value ?? ""),
    }));
  }
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: String(value ?? ""),
    }));
  }
  return [];
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

const CATEGORY_BADGE: Record<string, string> = {
  AGRI: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  FOOD: "bg-chart-2/15 text-chart-2 border-chart-2/30",
  SUGAR: "bg-chart-1/15 text-chart-1 border-chart-1/30",
  GRAIN: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  OIL: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  METAL: "bg-muted text-muted-foreground border-border",
  CHEM: "bg-chart-5/15 text-chart-5 border-chart-5/30",
  CMT: "bg-chart-3/15 text-chart-3 border-chart-3/30",
  ENERGY: "bg-chart-4/15 text-chart-4 border-chart-4/30",
  TEXTILE: "bg-chart-2/15 text-chart-2 border-chart-2/30",
  MACHINERY: "bg-muted text-muted-foreground border-border",
  PACKAGING: "bg-secondary text-secondary-foreground border-border",
  OTHER: "bg-secondary text-secondary-foreground border-border",
};

export function ProductCatalogView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ProductCatalogEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleSearchChange = useCallback((v: string) => { setSearch(v); setPage(1); }, []);
  const handleCategoryChange = useCallback((v: string) => { setCategory(v); setPage(1); }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["product-catalog", tenantKey, search, category, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (category !== "all") params.set("category", category);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const r = await fetch(api(`/api/product-catalog?${params}`));
      if (!r.ok) throw new Error("Failed to load product catalog");
      return r.json() as Promise<{ items: ProductCatalogEntry[]; total: number }>;
    },
  });

  const detail = useQuery({
    queryKey: ["product-catalog", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/product-catalog/${detailId}`));
      if (!r.ok) throw new Error("Failed to load product");
      return r.json() as Promise<ProductCatalogEntry>;
    },
    enabled: !!detailId,
  });

  // Linked supplier offers for the product shown in the detail sheet
  const linkedOffers = useQuery({
    queryKey: ["supplier-offers", tenantKey, "by-product", detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/supplier-offers?product_id=${detailId}`));
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json() as Promise<{ items: SupplierOffer[] }>;
    },
    enabled: !!detailId,
  });

  // Partners lookup for supplier names
  const partners = useQuery({
    queryKey: ["partners", tenantKey, "all"],
    queryFn: async () => {
      const r = await fetch(api("/api/partners?limit=500"));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[] }>;
    },
  });

  const partnerMap = useMemo(() => new Map((partners.data?.items || []).map((p) => [p.id, p])), [partners.data]);

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/product-catalog/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t(locale, "crm-product-deleted"));
      qc.invalidateQueries({ queryKey: ["product-catalog", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t(locale, "crm-delete-failed")),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title={t(locale, "product-catalog")}
        description={`${total} ${t(locale, "crm-catalog-entries-desc")}`}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t(locale, "crm-new-product")}
          </Button>
        }
      />
      {/* FIX-PRODUCTS-DOCS / Fix 9 — Product Catalog split-brain deprecation
          banner. The portal catalog endpoint (/api/portal/catalog) reads
          from the `products` table filtered by `show_in_catalog && active`,
          NOT from the legacy `product_catalog` table this view manages.
          The two can drift silently: an admin editing entries here thinks
          they're curating what the portal sees, but the portal actually
          reads from Products. Use the Products view (per-row
          `show_in_catalog` toggle) to control portal visibility. This
          view is preserved for backward compatibility with existing
          catalog entries that have not yet been migrated to Products. */}
      <Alert variant="destructive" className="mb-4">
        <AlertTriangle className="size-4" />
        <AlertTitle>Legacy view — portal reads from Products, not this catalog</AlertTitle>
        <AlertDescription>
          The client portal catalog is curated via the <strong>show_in_catalog</strong> flag
          on the <strong>Products</strong> table (per-row toggle in the Products view), NOT
          this <code>product_catalog</code> table. Edits made here do NOT affect what portal
          clients see. Use the Products view to control portal visibility. This view is
          preserved for backward compatibility with legacy entries that have not yet been
          migrated to Products.
        </AlertDescription>
      </Alert>
      <ModuleInfoTooltip
        title="Product Catalog (Legacy)"
        description="Legacy product_catalog table — the portal catalog now reads from the Products table (show_in_catalog flag). Kept for backward compatibility with legacy entries that have not yet been migrated to Products."
        howToUse={["Add legacy catalog entries (deprecated — use the Products view instead)", "Curate portal visibility via the show_in_catalog toggle on the Products view", "Link supplier offers to catalog entries"]}
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t(locale, "crm-search-name-hs")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-full md:w-56"><SelectValue placeholder={t(locale, "crm-category")} /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all">{t(locale, "crm-all-categories")}</SelectItem>
              {PRODUCT_CATEGORIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
              ))}
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
              description={t(locale, "crm-no-products-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t(locale, "crm-new-product")}</Button>}
            />
          ) : (
            <>
              <div className="max-h-[calc(100vh-340px)] overflow-y-auto custom-scroll">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>{t(locale, "name")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t(locale, "crm-category")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t(locale, "crm-hs-code")}</TableHead>
                      <TableHead className="hidden xl:table-cell">{t(locale, "crm-base-unit")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t(locale, "crm-origin")}</TableHead>
                      <TableHead className="hidden xl:table-cell">{t(locale, "crm-specs")}</TableHead>
                      <TableHead>{t(locale, "status")}</TableHead>
                      <TableHead className="text-right">{t(locale, "actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((p) => {
                      const specs = normalizeSpecs(p.specifications).slice(0, 2);
                      return (
                        <TableRow
                          key={p.id}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setDetailId(p.id)}
                        >
                          <TableCell>
                            <div className="font-medium">{p.name}</div>
                            <div className="text-xs text-muted-foreground md:hidden">{categoryLabel(p.category)}</div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <Badge variant="outline" className={CATEGORY_BADGE[p.category] || ""}>{categoryLabel(p.category)}</Badge>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="font-mono text-xs tabular text-muted-foreground">{p.hs_code || "—"}</span>
                          </TableCell>
                          <TableCell className="hidden xl:table-cell text-sm">{unitLabel(p.base_unit)}</TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <div className="flex items-center gap-1.5 text-sm">
                              <span>{flagEmoji(p.origin_country) || "—"}</span>
                              <span className="text-muted-foreground">{p.origin_country ? getCountry(p.origin_country)?.name : "—"}</span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden xl:table-cell">
                            <div className="flex flex-wrap gap-1">
                              {specs.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : specs.map((s, i) => (
                                <Badge key={i} variant="secondary" className="font-normal">
                                  <span className="text-muted-foreground mr-1">{s.name}:</span>{s.value}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={p.active ? "outline" : "secondary"} className={p.active ? "bg-chart-1/15 text-chart-1 border-chart-1/30" : ""}>
                              {p.active ? t(locale, "active") : t(locale, "inactive")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(p.id)} title={t(locale, "view")}>
                                <Eye className="size-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(p); setShowForm(true); }} title={t(locale, "edit")}>
                                <Pencil className="size-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(p.id)} title={t(locale, "delete")}>
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

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <p className="text-sm text-muted-foreground">
                    {t(locale, "crm-showing")} {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} {t(locale, "crm-of")} {total}
                  </p>
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
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ProductFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        product={editing}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["product-catalog", tenantKey] });
        }}
      />

      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Package className="size-5" />
              {detail.data?.name || t(locale, "crm-product")}
            </SheetTitle>
            <SheetDescription>{t(locale, "crm-product-catalog-entry")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <ProductDetail
              product={detail.data}
              offers={linkedOffers.data?.items || []}
              partnerMap={partnerMap}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(locale, "crm-delete-product-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(locale, "crm-delete-product-desc")}
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
    </div>
  );
}

// ---- Detail panel ----
function ProductDetail({
  product, offers, partnerMap,
}: {
  product: ProductCatalogEntry;
  offers: SupplierOffer[];
  partnerMap: Map<string, Partner>;
}) {
  const locale = useI18nStore((s) => s.locale);
  const specs = normalizeSpecs(product.specifications);

  // Known imported data keys that should be displayed with nice labels
  const IMPORTED_KEY_LABELS: Record<string, string> = {
    brand: t(locale, "crm-brand"),
    shelf_life: t(locale, "crm-shelf-life"),
    image_url: t(locale, "crm-image-url"),
    logistics: t(locale, "crm-logistics-label"),
    coa_params: t(locale, "crm-coa-parameters"),
    tags: t(locale, "crm-tags"),
    inventory: t(locale, "inventory"),
    sku: t(locale, "crm-sku"),
  };

  // Separate imported data fields from generic specs
  const importedEntries = specs.filter((s) => s.name in IMPORTED_KEY_LABELS);
  const otherSpecEntries = specs.filter((s) => !(s.name in IMPORTED_KEY_LABELS));

  // Extract images from product.images
  const images: string[] = Array.isArray(product.images) ? product.images : [];

  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={CATEGORY_BADGE[product.category] || ""}>{categoryLabel(product.category)}</Badge>
        <Badge variant={product.active ? "outline" : "secondary"} className={product.active ? "bg-chart-1/15 text-chart-1 border-chart-1/30" : ""}>
          {product.active ? t(locale, "active") : t(locale, "inactive")}
        </Badge>
        {product.origin_country && (
          <Badge variant="outline">
            <span className="mr-1">{flagEmoji(product.origin_country)}</span>{getCountry(product.origin_country)?.name}
          </Badge>
        )}
      </div>

      {product.description && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t(locale, "description")}</p>
          <p className="text-sm whitespace-pre-wrap">{product.description}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Hash className="size-3" /> {t(locale, "crm-hs-code")}</p>
            <p className="text-sm font-mono tabular mt-1">{product.hs_code || "—"}</p>
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Boxes className="size-3" /> {t(locale, "crm-base-unit")}</p>
            <p className="text-sm mt-1">{unitLabel(product.base_unit)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Images */}
      {images.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t(locale, "crm-images")}</p>
          <div className="flex flex-wrap gap-2">
            {images.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline break-all">
                {t(locale, "crm-image")} {i + 1}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Imported data fields (brand, shelf_life, image_url, logistics, coa_params, tags, inventory, sku) */}
      {importedEntries.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">{t(locale, "crm-product-details")}</p>
          <div className="grid grid-cols-2 gap-2">
            {importedEntries.map((s) => (
              <Card key={s.name} className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-4 sm:p-5">
                  <p className="text-xs text-muted-foreground">{IMPORTED_KEY_LABELS[s.name] || s.name}</p>
                  <p className="text-sm font-medium mt-0.5 break-words">
                    {s.name === "image_url" ? (
                      <a href={s.value} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">{s.value}</a>
                    ) : s.name === "tags" ? (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {s.value.split(",").map((tag, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">{tag.trim()}</Badge>
                        ))}
                      </div>
                    ) : (
                      s.value
                    )}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Other specifications */}
      {otherSpecEntries.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1"><Tag className="size-3" /> {t(locale, "crm-specifications")}</p>
          <div className="border border-border/60 rounded-md divide-y divide-border/60">
            {otherSpecEntries.map((s, i) => (
              <div key={i} className="flex items-center justify-between p-2 text-sm">
                <span className="text-muted-foreground">{s.name}</span>
                <span className="font-medium tabular">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Separator />

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Globe className="size-3" /> {t(locale, "supplier-offers")} ({offers.length})</p>
        </div>
        {offers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(locale, "crm-no-supplier-offers-linked")}</p>
        ) : (
          <div className="border border-border/60 rounded-md overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="h-8 text-xs">{t(locale, "crm-supplier")}</TableHead>
                  <TableHead className="h-8 text-xs text-right">{t(locale, "crm-unit-price")}</TableHead>
                  <TableHead className="h-8 text-xs">{t(locale, "crm-incoterm")}</TableHead>
                  <TableHead className="h-8 text-xs hidden sm:table-cell">{t(locale, "crm-origin")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offers.map((o) => {
                  const supplier = partnerMap.get(o.supplier_id);
                  return (
                    <TableRow key={o.id} className="text-xs">
                      <TableCell className="font-medium">{supplier?.name || "—"}</TableCell>
                      <TableCell className="text-right tabular">{fmtMoney(o.unit_price, o.currency)}</TableCell>
                      <TableCell><Badge variant="outline" className="font-mono">{o.incoterm}</Badge></TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span className="mr-1">{flagEmoji(o.origin_country)}</span>
                        <span className="text-muted-foreground">{o.origin_country ? getCountry(o.origin_country)?.name : "—"}</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="pt-3 border-t">
        <p className="text-xs text-muted-foreground">{t(locale, "crm-updated")} {fmtDate(product.updated_at)}</p>
      </div>
    </div>
  );
}

// ---- Form dialog ----
function ProductFormDialog({
  open, onOpenChange, product, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  product: ProductCatalogEntry | null;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const locale = useI18nStore((s) => s.locale);

  const [form, setForm] = useState<Partial<ProductCatalogEntry>>({});
  const [specs, setSpecs] = useState<{ key: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (open) {
      const baseSpecs = product?.specifications
        ? normalizeSpecs(product.specifications).map((s) => ({ key: s.name, value: s.value }))
        : [];
// eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(product
        ? { ...product }
        : ({
            name: "", category: "OTHER", hs_code: "", description: "",
            base_unit: "pcs", origin_country: null, active: true,
          } as Partial<ProductCatalogEntry>));
      setSpecs(baseSpecs);
      // Open "More Details" when editing
      setMoreOpen(!!product);
    }
  }, [open, product]);

  function set<K extends keyof ProductCatalogEntry>(k: K, v: ProductCatalogEntry[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function updateSpec(idx: number, field: "key" | "value", v: string) {
    setSpecs((s) => s.map((row, i) => (i === idx ? { ...row, [field]: v } : row)));
  }
  function addSpec() {
    setSpecs((s) => [...s, { key: "", value: "" }]);
  }
  function removeSpec(idx: number) {
    setSpecs((s) => s.filter((_, i) => i !== idx));
  }

  async function save() {
    if (!form.name) { toast.error(t(locale, "crm-name-required")); return; }
    setSaving(true);
    try {
      const specObj: Record<string, string> = {};
      specs.forEach((s) => {
        const k = s.key.trim();
        if (k) specObj[k] = s.value.trim();
      });
      const payload = { ...form, specifications: Object.keys(specObj).length ? specObj : null };
      const method = product ? "PUT" : "POST";
      const url = product ? api(`/api/product-catalog/${product.id}`) : api("/api/product-catalog");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t(locale, "crm-request-failed"));
      }
      toast.success(product ? t(locale, "crm-product-updated") : t(locale, "crm-product-created"));
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t(locale, "crm-saving-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{product ? t(locale, "crm-edit-product") : t(locale, "crm-new-product")}</DialogTitle>
          <DialogDescription>
            {product ? t(locale, "crm-update-catalog-entry") : t(locale, "crm-start-with-basics")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="space-y-4">
          {/* ── Essential fields (always visible) ── */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">{t(locale, "crm-product-name-required")}</Label>
              <Input
                value={form.name || ""}
                onChange={(e) => set("name", e.target.value)}
                placeholder={t(locale, "crm-product-name-placeholder")}
                className="h-11 text-base"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>{t(locale, "crm-category")}</Label>
                <Select value={form.category || "OTHER"} onValueChange={(v) => set("category", v)}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {PRODUCT_CATEGORIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t(locale, "crm-hs-code")}</Label>
                <Input
                  value={form.hs_code || ""}
                  onChange={(e) => set("hs_code", e.target.value)}
                  placeholder="1701.99.10"
                  className="h-10 font-mono tabular"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t(locale, "crm-base-unit")}</Label>
                <Select value={form.base_unit || "pcs"} onValueChange={(v) => set("base_unit", v)}>
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {UNITS_OF_MEASURE.map((u) => (
                      <SelectItem key={u.code} value={u.code}>
                        <span className="font-mono mr-2">{u.code}</span> {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
                {!moreOpen && (form.description || form.origin_country || specs.length > 0) && (
                  <Badge variant="secondary" className="text-xs px-1.5 py-0">{t(locale, "crm-filled")}</Badge>
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-1 pb-2">
                <div className="space-y-1.5">
                  <Label>{t(locale, "crm-origin-country")}</Label>
                  <CountrySelect
                    value={form.origin_country}
                    onChange={(v) => set("origin_country", v)}
                    placeholder={t(locale, "crm-not-specified")}
                    className="h-10"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{t(locale, "description")}</Label>
                  <Textarea rows={2} value={form.description || ""} onChange={(e) => set("description", e.target.value)} />
                </div>

                <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30">
                  <Switch checked={!!form.active} onCheckedChange={(v) => set("active", v)} aria-label={t(locale, "active")} />
                  <div>
                    <p className="text-sm font-medium">{t(locale, "active")}</p>
                    <p className="text-xs text-muted-foreground">{t(locale, "crm-inactive-products-hidden")}</p>
                  </div>
                </div>

                <div>
                  <Separator className="my-2" />
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-muted-foreground">{t(locale, "crm-specifications-kv")}</p>
                    <Button type="button" size="sm" variant="outline" onClick={addSpec}>
                      <Plus className="size-3.5 mr-1" /> {t(locale, "crm-add-spec")}
                    </Button>
                  </div>
                  {specs.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-md">
                      {t(locale, "crm-no-specs-yet")}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {specs.map((s, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Input
                            value={s.key}
                            onChange={(e) => updateSpec(idx, "key", e.target.value)}
                            placeholder={t(locale, "crm-spec-key-placeholder")}
                            className="flex-1"
                          />
                          <Input
                            value={s.value}
                            onChange={(e) => updateSpec(idx, "value", e.target.value)}
                            placeholder={t(locale, "crm-spec-value-placeholder")}
                            className="flex-1"
                          />
                          <Button type="button" size="icon" variant="ghost" className="size-9 text-destructive shrink-0" onClick={() => removeSpec(idx)} title={t(locale, "remove")}>
                            <X className="size-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t(locale, "cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t(locale, "crm-saving") : product ? t(locale, "crm-update") : t(locale, "crm-create-product")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
