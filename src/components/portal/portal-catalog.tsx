"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/lib/store/app-store";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/utils/format";
import type { ProductCatalogEntry } from "@/lib/supabase/types";
import { RfqFormDialog } from "./rfq-form-dialog";
import { useT } from "@/lib/i18n/store";

// Category → accent color tokens (emerald / amber / teal / rose / violet)
const CATEGORY_COLORS: Record<string, string> = {
  SUGAR: "border-transparent bg-chart-1 text-white",
  GRAIN: "border-transparent bg-chart-3 text-black",
  CEMENT: "border-transparent bg-chart-4 text-white",
  CMT: "border-transparent bg-chart-4 text-white",
  OIL: "border-transparent bg-chart-2 text-white",
  FOOD: "border-transparent bg-chart-1 text-white",
  AGRI: "border-transparent bg-chart-2 text-white",
  ENERGY: "border-transparent bg-chart-4 text-white",
  CHEM: "border-transparent bg-chart-5 text-white",
};

function categoryClass(cat: string): string {
  return CATEGORY_COLORS[cat] || "bg-secondary text-secondary-foreground";
}

// ISO alpha-2 → flag emoji
function flagEmoji(code: string | null): string {
  if (!code || code.length !== 2) return "";
  const cp = code
    .toUpperCase()
    .split("")
    .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65);
  return String.fromCodePoint(...cp);
}

export function PortalCatalog() {
  const t = useT();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rfqProduct, setRfqProduct] = useState<ProductCatalogEntry | null>(null);

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
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.hs_code?.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q)
      );
    }
    return items;
  }, [allItems, categoryFilter, search]);

  const selected = filtered.find((p) => p.id === detailId) || null;

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Page header */}
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
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("portal-search-products")}
              className="pl-10 h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-10 w-full sm:w-44">
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
        </div>
      </div>

      {catalogQ.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyCatalog />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll pr-1">
          {filtered.map((p) => {
            // Specifications can be either an array of {name,value} pairs
            // (current Supabase data) or a Record<string,*> built by the
            // API mapper (coa_params / detailed_spec / logistics /
            // shelf_life). Normalize both into [{name, value}], skipping
            // null/empty entries.
            const rawSpecs = p.specifications as unknown;
            const specEntries: { name: string; value: string }[] = Array.isArray(rawSpecs)
              ? (rawSpecs as { name: string; value: string }[]).slice(0, 2)
              : typeof rawSpecs === "object" && rawSpecs !== null
                ? Object.entries(rawSpecs as Record<string, unknown>)
                    .filter(([, v]) => v !== null && v !== undefined && v !== "")
                    .slice(0, 2)
                    .map(([name, value]) => ({
                      name,
                      value: typeof value === "string" ? value : JSON.stringify(value),
                    }))
                : [];
            return (
              <div
                key={p.id}
                onClick={() => setDetailId(p.id)}
                className="border-gradient cursor-pointer group hover:-translate-y-0.5 smooth shadow-soft hover:shadow-soft-lg"
              >
                <div className="bg-card rounded-[calc(var(--radius-xl)-1px)] p-5 h-full">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <Badge className={cn("text-[10px] px-1.5 py-0", categoryClass(p.category))}>
                      {p.category}
                    </Badge>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="text-base leading-none">{flagEmoji(p.origin_country)}</span>
                      <span className="font-medium">{p.origin_country || "—"}</span>
                    </div>
                  </div>
                  <p className="text-base font-semibold leading-snug group-hover:text-primary smooth">
                    {p.name}
                  </p>
                  {p.description && (
                    <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
                      {p.description}
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 mt-3 text-[11px] text-muted-foreground">
                    <Hash className="size-3" />
                    <span className="font-mono tabular">{p.hs_code || "—"}</span>
                    <span className="mx-1">·</span>
                    <Ruler className="size-3" />
                    <span className="tabular">{p.base_unit}</span>
                  </div>
                  {specEntries.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-3">
                      {specEntries.map((s) => (
                        <span
                          key={s.name}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-muted/70 text-muted-foreground"
                        >
                          <span className="font-medium">{s.name}:</span> {s.value}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail sheet — glass-strong */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll glass-strong border-l border-border/60">
          {selected ? (
            <CatalogDetail
              product={selected}
              onRequestQuote={(product) => setRfqProduct(product)}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Detailed RFQ intake dialog */}
      <RfqFormDialog
        open={!!rfqProduct}
        onClose={() => setRfqProduct(null)}
        product={rfqProduct}
        onCreated={() => {
          setDetailId(null);
          useAppStore.getState().setView("portal-rfq");
        }}
      />
    </div>
  );
}

function EmptyCatalog() {
  const t = useT();
  return (
    <div className="card-premium p-12 flex flex-col items-center justify-center text-center">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <Package className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-catalog-empty-title")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {t("portal-catalog-empty-desc")}
      </p>
    </div>
  );
}

function CatalogDetail({ product, onRequestQuote }: { product: ProductCatalogEntry; onRequestQuote?: (product: ProductCatalogEntry) => void }) {
  const t = useT();

  // Build a clean list of specification entries from the structured fields.
  // The API returns specifications as { coa_params, detailed_spec, logistics,
  // shelf_life } — each may be null, a string, an array, or an object.
  const specSections: { title: string; entries: { name: string; value: string }[] }[] = [];

  // CoA params: array of {name, value} or key-value object
  const coa = (product as any).coa_params;
  if (coa) {
    const entries: { name: string; value: string }[] = Array.isArray(coa)
      ? coa.map((p: any) => ({ name: p.name || p.key || "", value: String(p.value ?? "") }))
      : typeof coa === "object"
        ? Object.entries(coa).map(([k, v]) => ({ name: k, value: String(v) }))
        : [];
    if (entries.length > 0) specSections.push({ title: t("portal-catalog-quality-specs") || "Quality Specifications", entries });
  }

  // Detailed spec: plain text
  const detailed = (product as any).detailed_spec;
  if (detailed && typeof detailed === "string") {
    specSections.push({ title: t("portal-catalog-detailed-spec") || "Detailed Specification", entries: [{ name: "", value: detailed }] });
  }

  // Logistics: container capacities
  const log = (product as any).logistics;
  if (log && typeof log === "object") {
    const entries = Object.entries(log)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => {
        const label = k === "cap20" ? "20ft Container" : k === "cap40" ? "40ft Container" : k;
        return { name: label, value: `${v} ${product.base_unit || "kg"}` };
      });
    if (entries.length > 0) specSections.push({ title: t("portal-catalog-logistics") || "Logistics", entries });
  }

  // Shelf life
  const shelf = (product as any).shelf_life;
  if (shelf && typeof shelf === "string") {
    specSections.push({ title: t("portal-catalog-shelf-life") || "Shelf Life", entries: [{ name: "", value: shelf }] });
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <div className="size-9 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center">
            <Package className="size-5 text-primary" />
          </div>
          {product.name}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          <Badge className={cn("text-[11px]", categoryClass(product.category))}>
            {product.category}
          </Badge>
          {product.origin_country && (
            <span className="inline-flex items-center gap-1 text-xs">
              <span className="text-base leading-none">{flagEmoji(product.origin_country)}</span>
              {product.origin_country}
            </span>
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="px-4 pb-4 space-y-5">
        {product.description && (
          <div>
            <h3 className="text-sm font-semibold mb-1.5">{t("portal-catalog-description")}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {product.description}
            </p>
          </div>
        )}

        {/* Key attributes */}
        <div className="grid grid-cols-2 gap-3">
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
          <InfoTile icon={Layers} label={t("portal-catalog-category")} value={product.category} />
        </div>

        {/* Full specifications — rendered as sections */}
        {specSections.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              {t("portal-catalog-full-specs")}
            </h3>
            {specSections.map((section, si) => (
              <div key={si}>
                <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">{section.title}</p>
                {section.entries.length === 1 && !section.entries[0].name ? (
                  // Single text entry (e.g. detailed_spec) — render as paragraph
                  <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/40">{section.entries[0].value}</p>
                ) : (
                  // Multiple entries — render as table
                  <div className="rounded-xl border border-border/60 overflow-hidden bg-card">
                    <table className="w-full text-sm">
                      <tbody>
                        {section.entries.map((s, ei) => (
                          <tr key={ei} className={ei % 2 === 0 ? "bg-muted/20" : ""}>
                            <td className="px-3 py-1.5 text-muted-foreground font-medium whitespace-nowrap">{s.name}</td>
                            <td className="px-3 py-1.5 text-right tabular">{s.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {product.images && product.images.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-2">{t("portal-catalog-images")}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {product.images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`${product.name} ${i + 1}`}
                  className="rounded-lg border border-border/60 object-cover aspect-square"
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground border-t border-border/60 pt-3">
          <MapPin className="size-3" />
          {t("portal-catalog-last-updated").replace("{date}", fmtDate(product.updated_at))}
        </div>

        {/* Request Quote button — quick action to create an RFQ from this product */}
        {onRequestQuote && (
          <div className="border-t border-border/60 pt-4">
            <Button
              onClick={() => onRequestQuote(product)}
              className="w-full gap-2"
              size="lg"
            >
              <ShoppingCart className="size-4" />
              {t("portal-catalog-request-quote")}
            </Button>
            <p className="text-[11px] text-muted-foreground text-center mt-2">
              {t("portal-catalog-request-quote-desc")}
            </p>
          </div>
        )}
      </div>
    </>
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
    <div className="rounded-lg border border-border/60 bg-card p-3 shadow-soft">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className={cn("text-sm font-medium mt-1 truncate", mono && "font-mono tabular")}>
        {value}
      </p>
    </div>
  );
}
