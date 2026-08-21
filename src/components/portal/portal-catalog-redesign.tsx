"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
} from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Package,
  Search,
  Loader2,
  Hash,
  Globe2,
  Layers,
  Ruler,
  MapPin,
  ShoppingCart,
  FileText,
  Tags,
  Truck,
  Calendar,
  Boxes,
  ClipboardList,
  Sparkles,
  PackageCheck,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/utils/format";
import type { ProductCatalogEntry } from "@/lib/supabase/types";
import { RfqFormDialog } from "./rfq-form-dialog";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { useDebounced } from "@/lib/hooks/use-debounced";

// ─── Category color tokens ─────────────────────────────────────────────────
// Same convention as the rest of the portal so badges stay brand-consistent:
//   sugar/food = amber, grain = blue, cement/energy = teal, oil/agri = light
//   amber, chem = rose. Falls back to muted.
const CATEGORY_COLORS: Record<string, string> = {
  SUGAR: "border-transparent bg-chart-1 text-white",
  GRAIN: "border-transparent bg-chart-3 text-black",
  CEMENT: "border-transparent bg-chart-4 text-white",
  CMT: "border-transparent bg-chart-4 text-white",
  OIL: "border-transparent bg-chart-2 text-black",
  FOOD: "border-transparent bg-chart-1 text-white",
  AGRI: "border-transparent bg-chart-2 text-black",
  ENERGY: "border-transparent bg-chart-4 text-white",
  CHEM: "border-transparent bg-chart-5 text-white",
};

function categoryClass(cat: string | null | undefined): string {
  if (!cat) return "bg-secondary text-secondary-foreground";
  return CATEGORY_COLORS[cat] || "bg-secondary text-secondary-foreground";
}

// ISO alpha-2 → flag emoji (cosmetic; graceful for non-2-letter codes).
function flagEmoji(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "";
  const cp = code
    .toUpperCase()
    .split("")
    .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
}

// ─── Spec normalization helpers ──────────────────────────────────────────────
// `coa_params` is JSONB on the products table — it can be either an array of
// `{name, value}` pairs OR a `{key: value}` object. We normalize both into a
// list of `{name, value}` rows for the detail table. Also defends against
// non-string values (Numbers / Booleans are coerced via String()).
type SpecEntry = { name: string; value: string };

function normalizeSpecs(raw: unknown): SpecEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((p) => p && typeof p === "object")
      .map((p: any) => ({
        name: String(p.name ?? p.key ?? p.label ?? "").trim(),
        value: String(p.value ?? p.val ?? "").trim(),
      }))
      .filter((e) => e.value !== "");
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => ({
        name: k,
        value: typeof v === "string" ? v : JSON.stringify(v),
      }));
  }
  return [];
}

function normalizeLogistics(
  raw: unknown,
  unit: string,
  t: (k: string) => string,
): SpecEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const out: SpecEntry[] = [];
  // Container loadability
  if (obj.cap20 != null && obj.cap20 !== "") {
    out.push({ name: t("portal-catalog-cap20"), value: `${obj.cap20} ${unit}` });
  }
  if (obj.cap40 != null && obj.cap40 !== "") {
    out.push({ name: t("portal-catalog-cap40"), value: `${obj.cap40} ${unit}` });
  }
  // Packaging
  if (obj.packaging != null && obj.packaging !== "") {
    out.push({ name: t("portal-catalog-packaging"), value: String(obj.packaging) });
  }
  // Any other logistics fields ( pallets_per_container, weight_per_unit, etc.)
  for (const [k, v] of Object.entries(obj)) {
    if (["cap20", "cap40", "packaging"].includes(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    out.push({ name: k.replace(/_/g, " "), value: typeof v === "string" ? v : JSON.stringify(v) });
  }
  return out;
}

// ─── Main component ─────────────────────────────────────────────────────────
//
// Design brief:
//   - Sticky search/filter/sort bar at the top (results count visible)
//   - Responsive product grid (1 / 2 / 3 / 4 columns)
//   - Each card: image OR icon placeholder, name, SKU·unit, key spec summary,
//     two actions — "Specs" (opens drawer) + "Quote" (opens RFQ dialog)
//   - Detail drawer (Sheet, right side) shows ALL product data organized in
//     sections: Overview / CoA / Detailed Spec / Packaging & Logistics / Tags
//   - RFQ flow reuses the existing RfqFormDialog (already production-ready)
export function PortalCatalogRedesign() {
  const t = useT();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"name" | "category" | "newest">("name");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rfqProduct, setRfqProduct] = useState<ProductCatalogEntry | null>(null);
  const setView = useAppStore((s) => s.setView);

  // Debounce search so large catalogs (1000+ items) don't re-filter on every
  // keystroke — keeps typing smooth even on low-end devices.
  const debouncedSearch = useDebounced(search, 200);

  const catalogQ = useQuery<{ items: ProductCatalogEntry[]; total: number }>({
    queryKey: ["portal-catalog"],
    queryFn: async () => {
      const r = await fetch("/api/portal/catalog");
      if (!r.ok) throw new Error("Failed to load catalog");
      return r.json();
    },
  });

  const allItems = catalogQ.data?.items || [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    allItems.forEach((p) => p.category && set.add(p.category));
    return Array.from(set).sort();
  }, [allItems]);

  const filtered = useMemo(() => {
    let items = allItems;
    if (categoryFilter !== "all") {
      items = items.filter((p) => p.category === categoryFilter);
    }
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase();
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.brand ?? "").toLowerCase().includes(q) ||
          (p.category ?? "").toLowerCase().includes(q) ||
          (p.hs_code ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...items];
    if (sortBy === "name") {
      sorted.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (sortBy === "category") {
      sorted.sort(
        (a, b) =>
          (a.category ?? "").localeCompare(b.category ?? "") ||
          (a.name || "").localeCompare(b.name || ""),
      );
    } else if (sortBy === "newest") {
      // Newest first — created_at is ISO 8601 so lexicographic sort == chrono.
      sorted.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    }
    return sorted;
  }, [allItems, debouncedSearch, categoryFilter, sortBy]);

  const selected = filtered.find((p) => p.id === detailId) || null;

  const openRfq = useCallback((p: ProductCatalogEntry) => setRfqProduct(p), []);
  const closeRfq = useCallback(() => setRfqProduct(null), []);

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* ─── Page header ───────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("portal-catalog-title").split(" ")[0]}{" "}
            <span className="text-gradient-emerald">
              {t("portal-catalog-title").split(" ").slice(1).join(" ")}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {catalogQ.data
              ? t("portal-catalog-count").replace("{n}", String(filtered.length))
              : t("portal-catalog-loading")}
          </p>
        </div>
      </div>

      {/* ─── Sticky search / filter / sort bar ─────────────────────────── */}
      <div className="sticky top-0 z-30 -mx-1 px-1 py-3 bg-background/95 backdrop-blur border-b">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("portal-catalog-search-placeholder")}
              className="pl-9 h-10"
              aria-label={t("portal-catalog-search-placeholder")}
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-10 w-full sm:w-44" aria-label={t("portal-all-categories")}>
              <SelectValue placeholder={t("portal-all-categories")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("portal-all-categories")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="h-10 w-full sm:w-44" aria-label={t("portal-catalog-sort-by")}>
              <SelectValue placeholder={t("portal-catalog-sort-by")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">{t("portal-catalog-sort-name")}</SelectItem>
              <SelectItem value="category">{t("portal-catalog-sort-category")}</SelectItem>
              <SelectItem value="newest">{t("portal-catalog-sort-newest")}</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground whitespace-nowrap ml-auto tabular">
            {t("portal-catalog-results").replace("{n}", String(filtered.length))}
          </span>
        </div>
      </div>

      {/* ─── Body: loading / empty / grid ──────────────────────────────── */}
      {catalogQ.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : catalogQ.isError ? (
        <div className="card-premium p-12 flex flex-col items-center justify-center text-center">
          <div className="size-14 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
            <Inbox className="size-6 text-destructive" />
          </div>
          <p className="text-base font-semibold">{t("portal-catalog-empty-title")}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            {catalogQ.error instanceof Error ? catalogQ.error.message : t("portal-catalog-empty-desc")}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyCatalog query={search} hasCategory={categoryFilter !== "all"} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-8">
          {filtered.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              onViewSpecs={() => setDetailId(p.id)}
              onRequestQuote={() => openRfq(p)}
            />
          ))}
        </div>
      )}

      {/* ─── Detail drawer ─────────────────────────────────────────────── */}
      <Sheet
        open={!!detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
      >
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll glass-strong border-l border-border/60">
          {selected ? (
            <ProductDetailDrawer
              product={selected}
              onRequestQuote={() => {
                setDetailId(null);
                openRfq(selected);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* ─── RFQ dialog (existing, already production-ready) ─────────────── */}
      <RfqFormDialog
        open={!!rfqProduct}
        onClose={closeRfq}
        product={rfqProduct}
        onCreated={() => {
          setDetailId(null);
          setView("portal-rfq");
        }}
      />
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyCatalog({ query, hasCategory }: { query: string; hasCategory: boolean }) {
  const t = useT();
  return (
    <div className="card-premium p-12 flex flex-col items-center justify-center text-center">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <Package className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-catalog-no-products")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {(query || hasCategory) ? t("portal-catalog-no-products-desc") : t("portal-catalog-empty-desc")}
      </p>
    </div>
  );
}

// ─── Product card ───────────────────────────────────────────────────────────
function ProductCard({
  product,
  onViewSpecs,
  onRequestQuote,
}: {
  product: ProductCatalogEntry;
  onViewSpecs: () => void;
  onRequestQuote: () => void;
}) {
  const t = useT();
  // Build the compact 2-line spec summary for the card — picks the first
  // available brand / origin / packaging, in that order, capped at 2 rows
  // so cards in the grid stay height-aligned (cleaner grid look).
  const summary: { label: string; value: string }[] = [];
  if (product.brand) summary.push({ label: t("portal-catalog-brand"), value: product.brand });
  if (product.origin_country)
    summary.push({
      label: t("portal-catalog-origin"),
      value: `${flagEmoji(product.origin_country)} ${product.origin_country}`,
    });
  const pkg = (product.logistics as Record<string, unknown> | null)?.packaging;
  if (pkg && typeof pkg === "string") {
    summary.push({ label: t("portal-catalog-packaging"), value: pkg });
  } else if (product.shelf_life) {
    summary.push({ label: t("portal-catalog-shelf-life"), value: product.shelf_life });
  }

  return (
    <div className="bg-card rounded-xl border border-border/60 overflow-hidden flex flex-col hover:shadow-soft-lg hover:border-border smooth transition-all">
      {/* Image / placeholder tile — amber gradient + Package icon keeps cards
          visually balanced even when image_url is missing (most products today). */}
      <div
        className="relative aspect-[4/3] bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-950/40 dark:to-amber-900/30 flex items-center justify-center overflow-hidden cursor-pointer"
        onClick={onViewSpecs}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onViewSpecs();
          }
        }}
      >
        {product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.image_url}
            alt={product.name}
            className="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
        ) : (
          <Package className="size-12 text-amber-600/40 dark:text-amber-400/30" />
        )}
        {/* Category badge sits on top of the image (badge over gradient works
            even when no image is set). */}
        {product.category && (
          <Badge
            className={cn(
              "absolute top-2 left-2 text-xs px-2 py-0.5 shadow-sm",
              categoryClass(product.category),
            )}
          >
            {product.category}
          </Badge>
        )}
      </div>

      {/* Content */}
      <div className="p-4 flex-1 flex flex-col gap-2">
        <h3
          className="font-semibold text-sm leading-tight line-clamp-2 cursor-pointer hover:text-primary smooth"
          onClick={onViewSpecs}
          title={product.name}
        >
          {product.name}
        </h3>

        {/* SKU · unit line */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {product.sku ? (
            <>
              <span className="font-mono">{product.sku}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <Ruler className="size-3" />
          <span className="tabular">{product.base_unit}</span>
        </div>

        {/* Compact key-spec summary (max 2 rows) */}
        {summary.length > 0 && (
          <div className="mt-1 text-xs space-y-0.5 border-t border-border/40 pt-2">
            {summary.slice(0, 2).map((row) => (
              <div key={row.label} className="flex justify-between gap-2">
                <span className="text-muted-foreground truncate">{row.label}</span>
                <span className="font-medium text-right truncate">{row.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 pb-4 pt-0 flex gap-2 border-t border-border/40 mt-1">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-1.5"
          onClick={onViewSpecs}
          aria-label={t("portal-catalog-view-specs")}
        >
          <FileText className="size-3.5" />
          {t("portal-catalog-specs")}
        </Button>
        <Button
          size="sm"
          className="flex-1 gap-1.5"
          onClick={onRequestQuote}
          aria-label={t("portal-catalog-request-quote")}
        >
          <ShoppingCart className="size-3.5" />
          {t("portal-catalog-quote")}
        </Button>
      </div>
    </div>
  );
}

// ─── Detail drawer ─────────────────────────────────────────────────────────
function ProductDetailDrawer({
  product,
  onRequestQuote,
}: {
  product: ProductCatalogEntry;
  onRequestQuote: () => void;
}) {
  const t = useT();

  const coaEntries = normalizeSpecs(product.coa_params);
  const logisticsEntries = normalizeLogistics(product.logistics, product.base_unit, t);
  const tags = (product.tags ?? []).filter(Boolean);
  const images = product.images ?? (product.image_url ? [product.image_url] : []);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <div className="size-9 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center shrink-0">
            <Package className="size-5 text-primary" />
          </div>
          <span className="text-base leading-tight">{product.name}</span>
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          <Badge className={cn("text-xs", categoryClass(product.category))}>
            {product.category}
          </Badge>
          {product.origin_country && (
            <span className="inline-flex items-center gap-1 text-xs">
              <span className="text-base leading-none">{flagEmoji(product.origin_country)}</span>
              {product.origin_country}
            </span>
          )}
          {product.sku && (
            <span className="inline-flex items-center gap-1 text-xs font-mono">
              <Hash className="size-3" />
              {product.sku}
            </span>
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="px-4 pb-6 space-y-6">
        {/* ─── Overview ────────────────────────────────────────────────── */}
        <Section
          title={t("portal-catalog-section-overview")}
          icon={Sparkles}
        >
          {product.description && (
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              {product.description}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2.5">
            <InfoTile icon={Hash} label={t("portal-catalog-hs-code")} value={product.hs_code || "—"} mono />
            <InfoTile icon={Ruler} label={t("portal-catalog-base-unit")} value={product.base_unit} />
            <InfoTile
              icon={Globe2}
              label={t("portal-catalog-origin")}
              value={
                product.origin_country
                  ? `${flagEmoji(product.origin_country)} ${product.origin_country}`
                  : "—"
              }
            />
            <InfoTile icon={Layers} label={t("portal-catalog-category")} value={product.category || "—"} />
            {product.brand && (
              <InfoTile icon={PackageCheck} label={t("portal-catalog-brand")} value={product.brand} />
            )}
            {product.shelf_life && (
              <InfoTile icon={Calendar} label={t("portal-catalog-shelf-life")} value={product.shelf_life} />
            )}
          </div>
        </Section>

        {/* ─── Certificate of Analysis ─────────────────────────────────── */}
        {coaEntries.length > 0 && (
          <Section title={t("portal-catalog-section-coa")} icon={ClipboardList}>
            <div className="rounded-xl border border-border/60 overflow-hidden bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-1.5 text-left font-medium">
                      {t("portal-catalog-coa-parameter")}
                    </th>
                    <th className="px-3 py-1.5 text-right font-medium">
                      {t("portal-catalog-coa-value")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {coaEntries.map((e, i) => (
                    <tr
                      key={`${e.name}-${i}`}
                      className={i % 2 === 0 ? "bg-muted/15" : ""}
                    >
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{e.name}</td>
                      <td className="px-3 py-1.5 text-right tabular">{e.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ─── Detailed specification ──────────────────────────────────── */}
        {product.detailed_spec && (
          <Section title={t("portal-catalog-section-detailed")} icon={FileText}>
            <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/40 leading-relaxed">
              {product.detailed_spec}
            </p>
          </Section>
        )}

        {/* ─── Packaging & logistics ──────────────────────────────────── */}
        {logisticsEntries.length > 0 && (
          <Section title={t("portal-catalog-section-logistics")} icon={Truck}>
            <div className="rounded-xl border border-border/60 overflow-hidden bg-card">
              <table className="w-full text-sm">
                <tbody>
                  {logisticsEntries.map((e, i) => (
                    <tr key={`${e.name}-${i}`} className={i % 2 === 0 ? "bg-muted/15" : ""}>
                      <td className="px-3 py-1.5 text-muted-foreground font-medium whitespace-nowrap">
                        {e.name}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular">{e.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* ─── Tags ────────────────────────────────────────────────────── */}
        {tags.length > 0 && (
          <Section title={t("portal-catalog-section-tags")} icon={Tags}>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          </Section>
        )}

        {/* ─── Images ──────────────────────────────────────────────────── */}
        {images.length > 0 && (
          <Section title={t("portal-catalog-images")} icon={Boxes}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt={`${product.name} ${i + 1}`}
                  className="rounded-lg border border-border/60 object-cover aspect-square"
                  loading="lazy"
                />
              ))}
            </div>
          </Section>
        )}

        {/* ─── Meta ────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground border-t border-border/60 pt-3">
          <MapPin className="size-3" />
          {t("portal-catalog-last-updated").replace("{date}", fmtDate(product.updated_at))}
        </div>

        {/* ─── CTA: Request Quote ──────────────────────────────────────── */}
        <div className="border-t border-border/60 pt-4">
          <Button onClick={onRequestQuote} className="w-full gap-2" size="lg">
            <ShoppingCart className="size-4" />
            {t("portal-catalog-request-quote")}
          </Button>
          <p className="text-xs text-muted-foreground text-center mt-2">
            {t("portal-catalog-request-quote-desc")}
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Small building blocks ──────────────────────────────────────────────────
function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <div className="size-6 rounded-md bg-primary/10 flex items-center justify-center">
          <Icon className="size-3.5 text-primary" />
        </div>
        {title}
      </h3>
      {children}
    </section>
  );
}

function InfoTile({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-2.5 shadow-soft">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className={cn("text-sm font-medium mt-0.5 truncate", mono && "font-mono tabular")}>
        {value}
      </p>
    </div>
  );
}
