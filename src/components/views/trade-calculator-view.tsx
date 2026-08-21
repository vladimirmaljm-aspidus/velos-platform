"use client";

import { useEffect, useMemo, useState, useCallback, createElement } from "react";
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
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Plus, Pencil, Trash2, Eye, Calculator, X, TrendingUp, TrendingDown,
  DollarSign, Ship, Container, ArrowLeftRight, Sparkles, Loader2, Building2,
  MapPin, Lightbulb, FileText, ChevronDown, Landmark, Percent, RefreshCw,
  Truck, Plane, Train, Anchor, FileCheck, Send, Gauge,
} from "lucide-react";
import { PortAutocomplete } from "@/components/ui/port-autocomplete";
import { UnitSelect } from "@/components/common/unit-select";
import { ProductPicker } from "@/components/common/product-picker";
import { PartnerPicker } from "@/components/common/partner-picker";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtMoney, fmtDate, fmtNumber } from "@/lib/utils/format";
import {
  TradeCalculation, TradeCostLine, SupplierOffer, Partner,
  Product, CommissionAgent,
} from "@/lib/supabase/types";
import {
  TRADE_COST_TYPES, INCOTERMS, CURRENCIES, UNITS_OF_MEASURE,
  CONTAINER_TYPES, TRANSPORT_MODES, PAYMENT_TERMS_LOCAL,
} from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import {
  calculateBankCosts, BANK_COSTS, BankCostResult,
  calculateTransferFees, getNumTransfersForPaymentMethod,
  TRANSFER_FEES, TransferFeeResult,
} from "@/lib/data/bank-costs";
import {
  DOCUMENTATION_COSTS, getDefaultDocumentationIds,
  calculateDocumentationCosts, DocumentationCostResult,
} from "@/lib/data/documentation-costs";
import { getExchangeRate } from "@/lib/utils/exchange-rates";
import {
  convertUnit, describeConversion, canConvert,
} from "@/lib/utils/unit-conversion";
import {
  CostBreakdownPanel,
} from "./trade-cost-breakdown";

// ─── Enhanced transport modes ───
// Extends the base TRANSPORT_MODES (in reference.ts) with a Bulk Vessel variant
// for sea freight and richer hints. Codes stay backward-compatible with the
// existing 5 codes (SEA/AIR/ROAD/RAIL/MULTIMODAL); only SEA_BULK is new, so
// saved calculations continue to render correctly.
const ENHANCED_TRANSPORT_MODES: { code: string; nameKey: string; hintKey: string; icon: typeof Ship }[] = [
  { code: "SEA", nameKey: "log-transport-sea-container", hintKey: "log-transport-sea-container-hint", icon: Ship },
  { code: "SEA_BULK", nameKey: "log-transport-sea-bulk", hintKey: "log-transport-sea-bulk-hint", icon: Anchor },
  { code: "ROAD", nameKey: "log-transport-road", hintKey: "log-transport-road-hint", icon: Truck },
  { code: "RAIL", nameKey: "log-transport-rail", hintKey: "log-transport-rail-hint", icon: Train },
  { code: "AIR", nameKey: "log-transport-air", hintKey: "log-transport-air-hint", icon: Plane },
  { code: "MULTIMODAL", nameKey: "log-transport-multimodal", hintKey: "log-transport-multimodal-hint", icon: ArrowLeftRight },
];

// Truck types for ROAD transport mode.
const TRUCK_TYPES: { code: string; nameKey: string }[] = [
  { code: "standard", nameKey: "log-truck-standard" },
  { code: "refrigerated", nameKey: "log-truck-refrigerated" },
  { code: "tanker", nameKey: "log-truck-tanker" },
  { code: "flatbed", nameKey: "log-truck-flatbed" },
  { code: "lowboy", nameKey: "log-truck-lowboy" },
];

/**
 * Map the UNITS_OF_MEASURE codes (uppercase: MT, KG, G, LT, M3, …) to the
 * keys used by src/lib/utils/unit-conversion.ts (which mixes cases — MT, kg,
 * L, m3, …). Returns the input as-is when no mapping is known, so unknown
 * units still flow through `canConvert` / `convertUnit` unchanged.
 */
function normalizeUnitForConversion(u: string): string {
  const map: Record<string, string> = {
    KG: "kg",
    G: "g",
    LT: "L",
    M3: "m3",
    BBL: "bbl",
    GAL: "gal",
    M: "m",
    M2: "m2",
    // MT, PCS, CTN, PAL, BAG, DRM, BOX, SET — already match or are non-convertible
  };
  return map[u] || u;
}

/** Resolve a friendly icon for a transport_mode code. */
function transportModeIcon(code: string | null | undefined) {
  return ENHANCED_TRANSPORT_MODES.find((t) => t.code === code)?.icon || Ship;
}

// ─── Commission calculator types ───
// Local UI state — kept separate from TradeCalculation (which has no
// payment_terms / commission fields). The bank costs + commission are
// shown live in the preview and can optionally be added as cost lines.
type CommissionTypeLocal =
  | "percent_profit"
  | "percent_revenue"
  | "fixed_per_unit"
  | "fixed_total";

const COMMISSION_TYPE_OPTIONS: { value: CommissionTypeLocal; labelKey: string }[] = [
  { value: "percent_profit", labelKey: "misc-commission-percent-profit" },
  { value: "percent_revenue", labelKey: "misc-commission-percent-revenue" },
  { value: "fixed_per_unit", labelKey: "misc-commission-fixed-per-unit" },
  { value: "fixed_total", labelKey: "misc-commission-fixed-total" },
];

// Cost types available for the user to add (BUY_PRICE and SELL_PRICE are implicit
// — derived from buy_price_per_unit / sell_price_per_unit).
const EDITABLE_COST_TYPES = TRADE_COST_TYPES.filter(
  (t) => t.code !== "BUY_PRICE" && t.code !== "SELL_PRICE",
);

function costTypeLabel(code: string): string {
  return TRADE_COST_TYPES.find((t) => t.code === code)?.name || code;
}
function unitName(code: string): string {
  return UNITS_OF_MEASURE.find((u) => u.code === code)?.name || code;
}
function containerName(code: string | null): string {
  if (!code) return "—";
  return CONTAINER_TYPES.find((c) => c.code === code)?.name || code;
}

const CHART_COLORS = [
  "bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5",
  "bg-primary", "bg-amber-500", "bg-teal-500",
];

// ─── Partner context type ───
interface PartnerContext {
  partner: Partner;
  deals: any[];
  offers: any[];
  invoices: any[];
  proformas: any[];
  productCatalog: any[];
  supplierOffers: any[];
  portalAccess: any;
  kyc: { status: string; submitted_at: string; reviewed_at: string; review_notes: string } | null;
  tradeCalculations: any[];
  inventoryMovements: any[];
}

// ─── Product context type ───
interface ProductContext {
  product: any;
  catalogEntry: any;
  supplierOffers: any[];
  tradeCalculations: any[];
  inventoryStatus: { stock: number; reorder_level: number; low_stock: boolean; unit: string } | null;
  priceHistory: Array<{ date: string; source: string; source_number: string; unit_price: number; currency: string; quantity: number }>;
}

// ─── Incoterm-based cost line suggestions ───
const INCOTERM_COST_SUGGESTIONS: Record<string, Array<{ type: string; label: string; basis: "unit" | "percent" | "fixed" | "per_container"; default_value: number }>> = {
  FOB: [
    { type: "FREIGHT", label: "Ocean Freight", basis: "per_container", default_value: 2500 },
    { type: "INSURANCE", label: "Cargo Insurance", basis: "percent", default_value: 0.5 },
    { type: "LOCAL_CHARGES", label: "Local Port Charges", basis: "fixed", default_value: 500 },
  ],
  CIF: [
    { type: "CUSTOMS_DUTY", label: "Customs Duty", basis: "percent", default_value: 5 },
    { type: "VAT", label: "VAT / GST", basis: "percent", default_value: 20 },
    { type: "PORT_CHARGES", label: "Port & Handling Charges", basis: "fixed", default_value: 800 },
    { type: "DELIVERY", label: "Inland Delivery", basis: "fixed", default_value: 1200 },
  ],
  DDP: [
    { type: "FREIGHT", label: "Ocean Freight", basis: "per_container", default_value: 2500 },
    { type: "INSURANCE", label: "Cargo Insurance", basis: "percent", default_value: 0.5 },
    { type: "CUSTOMS_DUTY", label: "Customs Duty", basis: "percent", default_value: 5 },
    { type: "VAT", label: "VAT / GST", basis: "percent", default_value: 20 },
    { type: "PORT_CHARGES", label: "Port & Handling Charges", basis: "fixed", default_value: 800 },
    { type: "DELIVERY", label: "Inland Delivery", basis: "fixed", default_value: 1200 },
    { type: "LOCAL_DELIVERY", label: "Local Delivery to Door", basis: "fixed", default_value: 500 },
  ],
  EXW: [
    { type: "FREIGHT", label: "Transport to Port", basis: "fixed", default_value: 1500 },
    { type: "INSURANCE", label: "Cargo Insurance", basis: "percent", default_value: 0.5 },
    { type: "CUSTOMS_DUTY", label: "Customs Duty", basis: "percent", default_value: 5 },
    { type: "VAT", label: "VAT / GST", basis: "percent", default_value: 20 },
    { type: "PORT_CHARGES", label: "Port & Handling Charges", basis: "fixed", default_value: 800 },
    { type: "DELIVERY", label: "Inland Delivery", basis: "fixed", default_value: 1200 },
  ],
  CFR: [
    { type: "INSURANCE", label: "Cargo Insurance", basis: "percent", default_value: 0.5 },
    { type: "CUSTOMS_DUTY", label: "Customs Duty", basis: "percent", default_value: 5 },
    { type: "VAT", label: "VAT / GST", basis: "percent", default_value: 20 },
    { type: "PORT_CHARGES", label: "Port & Handling Charges", basis: "fixed", default_value: 800 },
    { type: "DELIVERY", label: "Inland Delivery", basis: "fixed", default_value: 1200 },
  ],
};

// Client-side mirror of the backend computation in /api/trade-calculator/route.ts.
// Extended with optional bank costs (sell currency) + commission so the live
// preview can show net profit (gross − bank − commission). The backend still
// computes gross totals only — bank costs/commission are preview-only here.
function computeTotals(
  form: Partial<TradeCalculation>,
  options?: {
    bankCostsTotal?: number; // already in sell currency
    commissionAmount?: number; // already in sell currency
  },
) {
  const qty = form.quantity || 0;
  const numContainers = form.num_containers || 1;
  const buyTotal = (form.buy_price_per_unit || 0) * qty;
  // Exchange rate: sell_currency per buy_currency. When currencies differ,
  // landed cost (in buy currency) must be converted to sell currency before
  // subtracting from sell revenue.
  const fxRate = Number(form.exchange_rate) || 1;
  const currenciesDiffer =
    !!form.buy_currency && !!form.sell_currency && form.buy_currency !== form.sell_currency;
  const effectiveFx = currenciesDiffer ? fxRate : 1;

  let landedCost = buyTotal;
  const lines = (form.cost_lines || []).filter(
    (l) => l.type !== "BUY_PRICE" && l.type !== "SELL_PRICE",
  );
  const buyCurrency = (form.buy_currency || "USD").toUpperCase();
  // Per-line currency conversion (mirror of server logic):
  // each line's `amount` is in its own currency; convert to buy_currency via
  // line.fx_rate before adding to landedCost. Same currency = 1.
  const computedLines = lines.map((line) => {
    let amount = 0;
    if (line.basis === "unit") amount = (line.value || 0) * qty;
    else if (line.basis === "fixed") amount = line.value || 0;
    else if (line.basis === "per_container") amount = (line.value || 0) * numContainers;
    else if (line.basis === "percent") amount = (landedCost * (line.value || 0)) / 100;
    amount = Math.round(amount * 100) / 100;

    const lineCurrency = (line.currency || buyCurrency).toUpperCase();
    const fxRate =
      lineCurrency === buyCurrency
        ? 1
        : (typeof line.fx_rate === "number" && line.fx_rate > 0
            ? line.fx_rate
            : 1);
    const convertedAmount = Math.round(amount * fxRate * 100) / 100;
    landedCost += convertedAmount;
    return {
      ...line,
      amount,
      currency: lineCurrency,
      fx_rate: fxRate,
      converted_amount: convertedAmount,
    };
  });

  const sellTotal = (form.sell_price_per_unit || 0) * qty;
  // Convert landed cost (buy currency) → sell currency for the margin math.
  const buyTotalInSellCurrency = buyTotal * effectiveFx;
  const landedCostInSellCurrency = landedCost * effectiveFx;
  // totalCosts now in BUY currency (sum of converted amounts).
  const totalCosts = computedLines.reduce((s, l) => s + (l.converted_amount || l.amount || 0), 0);
  const totalCostsInSellCurrency = totalCosts * effectiveFx;
  // Gross margin = sell revenue − landed cost (in sell currency).
  const margin = sellTotal - landedCostInSellCurrency;
  const marginPct = sellTotal > 0 ? (margin / sellTotal) * 100 : 0;
  const landedCostPerUnit = qty > 0 ? landedCostInSellCurrency / qty : 0;
  // Net profit = gross margin − bank costs − commission (all in sell currency).
  const bankCostsTotal = options?.bankCostsTotal || 0;
  const commissionAmount = options?.commissionAmount || 0;
  const netProfit = margin - bankCostsTotal - commissionAmount;
  const netMarginPct = sellTotal > 0 ? (netProfit / sellTotal) * 100 : 0;
  return {
    buyTotal: Math.round(buyTotal * 100) / 100,
    buyTotalInSellCurrency: Math.round(buyTotalInSellCurrency * 100) / 100,
    landedCost: Math.round(landedCost * 100) / 100,
    landedCostInSellCurrency: Math.round(landedCostInSellCurrency * 100) / 100,
    landedCostPerUnit: Math.round(landedCostPerUnit * 100) / 100,
    sellTotal: Math.round(sellTotal * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    marginPct: Math.round(marginPct * 100) / 100,
    totalCosts: Math.round(totalCosts * 100) / 100,
    totalCostsInSellCurrency: Math.round(totalCostsInSellCurrency * 100) / 100,
    computedLines,
    bankCostsTotal: Math.round(bankCostsTotal * 100) / 100,
    commissionAmount: Math.round(commissionAmount * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    netMarginPct: Math.round(netMarginPct * 100) / 100,
  };
}

export function TradeCalculatorView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  const setView = useAppStore((s) => s.setView);
  const setPendingOfferData = useAppStore((s) => s.setPendingOfferData);
  const [creatingOffer, setCreatingOffer] = useState(false);

  const qc = useQueryClient();
  const [editing, setEditing] = useState<TradeCalculation | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["trade-calculator", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/trade-calculator"));
      if (!r.ok) throw new Error("Failed to load trade calculations");
      return r.json() as Promise<{ items: TradeCalculation[]; total: number }>;
    },
  });

  const catalog = useQuery({
    queryKey: ["products", tenantKey, "trade-calc"],
    queryFn: async () => {
      const r = await fetch(api("/api/products?limit=1000"));
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<{ items: Product[]; total: number }>;
    },
  });
  const offers = useQuery({
    queryKey: ["supplier-offers", tenantKey, "all"],
    queryFn: async () => {
      const r = await fetch(api("/api/supplier-offers?limit=500"));
      if (!r.ok) throw new Error("Failed to load supplier offers");
      return r.json() as Promise<{ items: SupplierOffer[] }>;
    },
  });
  const partners = useQuery({
    queryKey: ["partners", tenantKey, "all"],
    queryFn: async () => {
      const r = await fetch(api("/api/partners?limit=500"));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[] }>;
    },
  });

  const catalogMap = new Map((catalog.data?.items || []).map((p) => [p.id, p]));
  const offerMap = new Map((offers.data?.items || []).map((o) => [o.id, o]));
  const partnerMap = new Map((partners.data?.items || []).map((p) => [p.id, p]));

  const detail = useQuery({
    queryKey: ["trade-calc", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/trade-calculator/${detailId}`));
      if (!r.ok) throw new Error("Failed to load calculation");
      return r.json() as Promise<TradeCalculation>;
    },
    enabled: !!detailId,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/trade-calculator/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("misc-calc-deleted-toast"));
      qc.invalidateQueries({ queryKey: ["trade-calculator", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("misc-delete-failed-toast")),
  });

  const items = data?.items || [];

  return (
    <div>
      <PageHeader
        title={t("misc-trade-calculator-title")}
        description={t("misc-saved-calculations-count").replace("${n}", String(data?.total ?? 0))}
        actions={
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" /> {t("misc-new-calculation")}
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 w-full rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Calculator className="size-6" />}
          title={t("misc-no-calculations")}
          description={t("misc-no-calculations-desc")}
          action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("misc-new-calculation")}</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[calc(100vh-220px)] overflow-y-auto custom-scroll pr-1 -mr-1">
          {items.map((c) => {
            const product = catalogMap.get(c.product_id || "");
            const supplier = partnerMap.get(c.supplier_id || "");
            const marginPositive = c.gross_margin >= 0;
            return (
              <Card
                key={c.id}
                className="border-border/60 shadow-soft rounded-xl hover:shadow-soft-md transition-shadow cursor-pointer hover:border-foreground/20"
                onClick={() => setDetailId(c.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{c.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{product?.name || t("misc-no-product")}</p>
                    </div>
                    <Badge variant="outline" className="font-mono shrink-0">{c.transport_mode}</Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">{t("misc-buy-per-unit")}</p>
                      <p className="font-medium tabular">{fmtMoney(c.buy_price_per_unit, c.buy_currency)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">{t("misc-sell-per-unit")}</p>
                      <p className="font-medium tabular">{fmtMoney(c.sell_price_per_unit, c.sell_currency)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">{t("misc-quantity")}</p>
                      <p className="font-medium tabular">{fmtNumber(c.quantity)} {c.unit}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">{t("misc-supplier-label")}</p>
                      <p className="font-medium truncate">{supplier?.name || "—"}</p>
                    </div>
                  </div>

                  <Separator className="my-3" />

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">{t("misc-gross-margin")}</p>
                      <p className={`text-lg font-semibold tabular ${marginPositive ? "text-chart-1" : "text-destructive"}`}>
                        {fmtMoney(c.gross_margin, c.sell_currency)}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={marginPositive
                        ? "bg-chart-1/15 text-chart-1 border-chart-1/30"
                        : "bg-destructive/10 text-destructive border-destructive/30"}
                    >
                      {marginPositive ? <TrendingUp className="size-3 mr-1" /> : <TrendingDown className="size-3 mr-1" />}
                      {c.margin_percent.toFixed(1)}%
                    </Badge>
                    <div className="flex items-center gap-1 ml-1" onClick={(e) => e.stopPropagation()}>
                      <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(c.id)} title={t("view")} aria-label={t("view")}>
                        <Eye className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(c); setShowForm(true); }} title={t("edit")} aria-label={t("edit")}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(c.id)} title={t("delete")} aria-label={t("delete")}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CalcFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        calc={editing}
        catalog={catalog.data?.items || []}
        offers={offers.data?.items || []}
        partners={partners.data?.items || []}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["trade-calculator", tenantKey] });
        }}
      />

      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Calculator className="size-5" />
              {detail.data?.name || t("misc-trade-calculation-singular")}
            </SheetTitle>
            <SheetDescription>{t("misc-landed-cost-margin-desc")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <CalcDetail
              calc={detail.data}
              product={catalogMap.get(detail.data.product_id || "")}
              offer={detail.data.supplier_offer_id ? offerMap.get(detail.data.supplier_offer_id) : undefined}
              supplier={partnerMap.get(detail.data.supplier_id || "")}
              buyer={partnerMap.get(detail.data.buyer_id || "")}
            />
          ) : null}
          {detail.data && (
            <SheetFooter className="mt-4 pt-4 border-t border-border/60">
              <Button
                disabled={creatingOffer}
                onClick={async () => {
                  if (!detail.data) return;
                  setCreatingOffer(true);
                  try {
                    // ── Review step (Fix 1) ──────────────────────────────
                    // Don't create the offer yet — fetch a pre-filled offer
                    // payload + a list of fields the trade calc couldn't
                    // auto-fill, then hand them off to the OffersView via
                    // the app store. The OffersView opens the form dialog
                    // pre-filled and paints the missing fields in orange so
                    // the user can review / fix them before saving.
                    const r = await fetch(api(`/api/trade-calculator/${detail.data.id}/offer-preview`));
                    if (!r.ok) {
                      const e = await r.json().catch(() => ({}));
                      throw new Error(e.error || "Failed to build offer preview");
                    }
                    const preview = await r.json();
                    setPendingOfferData({
                      offer: preview.offer,
                      missingFields: preview.missingFields || [],
                      tradeCalcId: detail.data.id,
                    });
                    setDetailId(null);
                    // Switch to the offers view — OffersView consumes
                    // pendingOfferData on mount and opens the form dialog.
                    setView("offers");
                    toast.success(t("misc-offer-form-prefilled"), {
                      description: t("misc-orange-fields-attention"),
                    });
                  } catch (e: any) {
                    toast.error(e.message || t("misc-failed-create-offer"));
                  } finally {
                    setCreatingOffer(false);
                  }
                }}
                className="gap-2"
              >
                {creatingOffer ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FileText className="size-4" />
                )}
                {t("misc-create-offer-from-calc")}
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("misc-delete-calc-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("misc-delete-calc-desc")}
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
    </div>
  );
}

// ---- Detail panel ----
function CalcDetail({
  calc, product, offer, supplier, buyer,
}: {
  calc: TradeCalculation;
  product?: Product;
  offer?: SupplierOffer;
  supplier?: Partner;
  buyer?: Partner;
}) {
  const t = useT();
  const marginPositive = calc.gross_margin >= 0;
  const displayCurrency = calc.sell_currency || calc.buy_currency || "USD";
  const lines = (calc.cost_lines || []);
  const totalForBar = Math.max(calc.total_landed_cost, 1);
  // When buy and sell currencies differ, the landed cost (stored in buy
  // currency) must be converted to sell currency to compare against sell
  // revenue. The backend already applies exchange_rate to gross_margin and
  // margin_percent, so we mirror that here for the displayed converted cost.
  const currenciesDiffer =
    !!calc.buy_currency && !!calc.sell_currency && calc.buy_currency !== calc.sell_currency;
  const fxRate = Number(calc.exchange_rate) || 1;
  const landedCostInSellCurrency = currenciesDiffer
    ? calc.total_landed_cost * fxRate
    : calc.total_landed_cost;

  // For the bar, show buy price + each cost line. BUY_PRICE/SELL_PRICE may exist in seed data.
  const barSegments: { label: string; amount: number; color: string }[] = [];
  // Buy price (implicit)
  barSegments.push({
    label: t("misc-buy-price"),
    amount: calc.total_buy_cost,
    color: CHART_COLORS[0],
  });
  lines.filter((l) => l.type !== "BUY_PRICE" && l.type !== "SELL_PRICE").forEach((l, i) => {
    barSegments.push({
      label: l.label || costTypeLabel(l.type),
      amount: l.amount,
      color: CHART_COLORS[(i + 1) % CHART_COLORS.length],
    });
  });

  return (
    <div className="px-4 pb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">{calc.transport_mode}</Badge>
        <Badge variant="outline">
          <Ship className="size-3 mr-1" />
          {calc.buy_incoterm} → {calc.sell_incoterm}
        </Badge>
        {calc.container_type && (
          <Badge variant="secondary">
            <Container className="size-3 mr-1" />
            {containerName(calc.container_type)} × {calc.num_containers}
          </Badge>
        )}
      </div>

      {/* Summary grid */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">{t("misc-buy-total")}</p>
            <p className="text-lg font-semibold tabular">{fmtMoney(calc.total_buy_cost, calc.buy_currency)}</p>
            <p className="text-xs text-muted-foreground tabular">
              {fmtMoney(calc.buy_price_per_unit, calc.buy_currency)} × {fmtNumber(calc.quantity)} {calc.unit}
            </p>
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">{t("misc-landed-cost")}</p>
            <p className="text-lg font-semibold tabular">{fmtMoney(calc.total_landed_cost, calc.buy_currency)}</p>
            <p className="text-xs text-muted-foreground tabular">
              {fmtMoney(calc.total_landed_cost / Math.max(calc.quantity, 1), calc.buy_currency)} / {calc.unit}
            </p>
            {currenciesDiffer && (
              <p className="text-xs tabular text-muted-foreground border-t pt-1 mt-1">
                ≈ {fmtMoney(landedCostInSellCurrency, calc.sell_currency)} @ {fxRate}
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">{t("misc-sell-revenue")}</p>
            <p className="text-lg font-semibold tabular">{fmtMoney(calc.total_sell_revenue, calc.sell_currency)}</p>
            <p className="text-xs text-muted-foreground tabular">
              {fmtMoney(calc.sell_price_per_unit, calc.sell_currency)} × {fmtNumber(calc.quantity)} {calc.unit}
            </p>
          </CardContent>
        </Card>
        <Card className={`border-border/60 shadow-soft rounded-xl ${marginPositive ? "" : "border-destructive/30"}`}>
          <CardContent className="p-4 sm:p-5">
            <p className="text-xs text-muted-foreground">{t("misc-gross-margin-card")}</p>
            <p className={`text-lg font-semibold tabular ${marginPositive ? "text-chart-1" : "text-destructive"}`}>
              {fmtMoney(calc.gross_margin, displayCurrency)}
            </p>
            <p className={`text-xs tabular ${marginPositive ? "text-chart-1" : "text-destructive"}`}>
              {marginPositive ? <TrendingUp className="size-3 inline mr-0.5" /> : <TrendingDown className="size-3 inline mr-0.5" />}
              {t("misc-margin-suffix").replace("${n}", calc.margin_percent.toFixed(2))}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Cost lines table */}
      <div>
        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
          <DollarSign className="size-3.5" /> {t("misc-cost-lines-count").replace("${n}", String(lines.length))}
        </p>
        <div className="border border-border/60 rounded-md overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="h-8 text-xs">{t("type")}</TableHead>
                <TableHead className="h-8 text-xs">{t("misc-label-field")}</TableHead>
                <TableHead className="h-8 text-xs">{t("misc-basis-label")}</TableHead>
                <TableHead className="h-8 text-xs text-right">{t("misc-value-label")}</TableHead>
                <TableHead className="h-8 text-xs text-right">{t("amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={i} className="text-xs">
                  <TableCell><Badge variant="secondary" className="font-mono">{l.type}</Badge></TableCell>
                  <TableCell className="font-medium">{l.label || costTypeLabel(l.type)}</TableCell>
                  <TableCell className="text-muted-foreground">{l.basis}</TableCell>
                  <TableCell className="text-right tabular">
                    {l.basis === "percent" ? `${l.value}%` : fmtMoney(l.value, l.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular font-medium">{fmtMoney(l.amount, l.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Visual breakdown bar */}
      <div>
        <p className="text-xs text-muted-foreground mb-2">{t("misc-cost-breakdown-title")}</p>
        <div className="flex h-3 w-full rounded-full overflow-hidden border border-border/60 bg-muted/30">
          {barSegments.map((s, i) => (
            <div
              key={i}
              className={`${s.color} h-full`}
              style={{ width: `${(s.amount / totalForBar) * 100}%` }}
              title={`${s.label}: ${fmtMoney(s.amount, displayCurrency)}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-3">
          {barSegments.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`size-2.5 rounded-sm ${s.color} shrink-0`} />
              <span className="text-muted-foreground truncate flex-1">{s.label}</span>
              <span className="tabular font-medium">{fmtMoney(s.amount, displayCurrency)}</span>
            </div>
          ))}
        </div>
      </div>

      <Separator />

      {/* Trade context */}
      <div>
        <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
          <ArrowLeftRight className="size-3.5" /> {t("misc-trade-context")}
        </p>
        <div className="border border-border/60 rounded-md divide-y divide-border/60 bg-card text-sm">
          <DetailRow label={t("misc-product")} value={product?.name || "—"} />
          <DetailRow label={t("misc-supplier-label")} value={supplier?.name || "—"} />
          <DetailRow label={t("misc-buyer-label")} value={buyer?.name || "—"} />
          <DetailRow label={t("misc-supplier-offer")} value={offer?.offer_number || "—"} mono />
          <DetailRow label={t("misc-quantity")} value={`${fmtNumber(calc.quantity)} ${unitName(calc.unit)}`} mono />
          <DetailRow label={t("misc-containers")} value={calc.num_containers ? `${calc.num_containers} × ${containerName(calc.container_type)}` : "—"} />
          <DetailRow label={t("log-loading-port")} value={calc.loading_port || "—"} />
          <DetailRow label={t("log-delivery-port")} value={calc.delivery_port || "—"} />
          <DetailRow label={t("misc-exchange-rate")} value={calc.exchange_rate.toString()} mono />
        </div>
      </div>

      <div className="pt-3 border-t">
        <p className="text-xs text-muted-foreground">{t("misc-created-prefix").replace("${date}", fmtDate(calc.created_at))}</p>
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between p-2.5 gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right font-medium truncate ${mono ? "font-mono tabular" : ""}`}>{value}</span>
    </div>
  );
}

// ---- Form dialog ----
function CalcFormDialog({
  open, onOpenChange, calc, catalog, offers, partners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  calc: TradeCalculation | null;
  catalog: Product[];
  offers: SupplierOffer[];
  partners: Partner[];
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<Partial<TradeCalculation>>({});
  const [lines, setLines] = useState<TradeCostLine[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<string>("");
  const [bankCostOverrides, setBankCostOverrides] = useState<Record<string, number>>({});
  const [showBankOverrides, setShowBankOverrides] = useState(false);
  const [bankCostsOpen, setBankCostsOpen] = useState(true);
  // ─── Transfer fees (SWIFT/correspondent/FX spread) — always apply ───
  const [transferFeeOverrides, setTransferFeeOverrides] = useState<Record<string, number>>({});
  const [transferFeesOpen, setTransferFeesOpen] = useState(true);
  // ─── Documentation costs (B/L, Phyto, CoO, THC, …) ───
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>(getDefaultDocumentationIds());
  const [docValueOverrides, setDocValueOverrides] = useState<Record<string, number>>({});
  const [docsOpen, setDocsOpen] = useState(true);
  const [commissionAgentId, setCommissionAgentId] = useState<string | null>(null);
  const [commissionType, setCommissionType] =
    useState<CommissionTypeLocal>("percent_profit");
  const [commissionRate, setCommissionRate] = useState<number>(0);
  const [fetchingRate, setFetchingRate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supplierContext, setSupplierContext] = useState<PartnerContext | null>(null);
  const [loadingSupplier, setLoadingSupplier] = useState(false);
  const [productContext, setProductContext] = useState<ProductContext | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(false);
  // Transport-mode-specific extras (vessel capacity, truck type, …) — kept
  // in local UI state because the TradeCalculation schema has no columns for
  // them. They're advisory: the user can turn them into a FREIGHT cost line
  // via the "Add cost line" button. The persisted fields (loading_port,
  // delivery_port, container_type, num_containers) ARE saved.
  const [transportExtras, setTransportExtras] = useState<{
    vessel_capacity_mt?: number;
    freight_rate_per_mt?: number;
    truck_type?: string;
    num_trucks?: number;
    air_chargeable_weight_kg?: number;
    num_wagons?: number;
  }>({});
  // Last unit-conversion description — shown as a hint below the unit field
  // so the user sees the auto-applied ratio (e.g. "1 MT = 1,000 kg").
  const [conversionHint, setConversionHint] = useState<string | null>(null);

  // ─── Commission agents (loaded for the commission dropdown) ───
  const commissionAgentsQuery = useQuery({
    queryKey: ["commission-agents", tenantKey, "trade-calc"],
    queryFn: async () => {
      const r = await fetch(api("/api/commission-agents?limit=200"));
      if (!r.ok) throw new Error("Failed to load commission agents");
      return r.json() as Promise<{ items: CommissionAgent[]; total: number }>;
    },
    enabled: open,
  });
  const commissionAgents = commissionAgentsQuery.data?.items || [];

  useEffect(() => {
    if (open) {
      const baseForm: Partial<TradeCalculation> = calc
        ? { ...calc }
        : {
            name: "", product_id: null, supplier_offer_id: null,
            supplier_id: null, buyer_id: null,
            quantity: 0, unit: "MT", num_containers: 1, container_type: "40HC",
            buy_price_per_unit: 0, buy_currency: "USD", buy_incoterm: "FOB",
            sell_price_per_unit: 0, sell_currency: "USD", sell_incoterm: "CIF",
            transport_mode: "SEA", loading_port: "", delivery_port: "",
            exchange_rate: 1,
          };
      // Filter out BUY_PRICE/SELL_PRICE rows — they're implicit
      const editableLines = (calc?.cost_lines || []).filter(
        (l) => l.type !== "BUY_PRICE" && l.type !== "SELL_PRICE",
      );
// eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(baseForm);
      setLines(editableLines);
      setPaymentTerms("");
      setBankCostOverrides({});
      setShowBankOverrides(false);
      // Reset transfer fees + documentation to defaults
      setTransferFeeOverrides({});
      setSelectedDocIds(getDefaultDocumentationIds());
      setDocValueOverrides({});
      // Restore commission UI state from the loaded calculation (previously
      // these were always reset to defaults, so editing a calc with commission
      // info silently dropped it on save — audit finding 1a).
      setCommissionAgentId((calc as any)?.commission_agent_id ?? null);
      setCommissionType((calc as any)?.commission_type || "percent_profit");
      setCommissionRate((calc as any)?.commission_rate || 0);
      setSupplierContext(null);
      setProductContext(null);
      setTransportExtras({});
      setConversionHint(null);
    }
  }, [open, calc]);

  // ─── Auto-fetch live exchange rate when currencies differ ───
  // Fires when buy/sell currency changes (or when dialog opens with
  // differing currencies). User can still override the rate manually.
  useEffect(() => {
    if (!open) return;
    const from = form.buy_currency;
    const to = form.sell_currency;
    if (!from || !to || from === to) return;
    let cancelled = false;
// eslint-disable-next-line react-hooks/set-state-in-effect
    setFetchingRate(true);
    getExchangeRate(from, to)
      .then((rate) => {
        if (cancelled || rate === null) return;
        // Only auto-fill if user hasn't typed a custom rate already —
        // we still update to keep rate fresh on currency change.
        set("exchange_rate", Math.round(rate * 10000) / 10000);
        toast.info(
          t("misc-auto-fetched-rate-toast").replace("${from}", from).replace("${rate}", rate.toFixed(4)).replace("${to}", to),
        );
      })
      .finally(() => {
        if (!cancelled) setFetchingRate(false);
      });
    return () => { cancelled = true; };
  }, [open, form.buy_currency, form.sell_currency]);

  // ─── Auto-fetch live FX rate per cost line whose currency differs from
  // buy_currency. Only fetches when fx_rate is undefined (i.e. currency just
  // changed). Once set (live or user-typed), the rate is preserved. ───
  useEffect(() => {
    if (!open) return;
    const buyCur = (form.buy_currency || "USD").toUpperCase();
    let cancelled = false;
    const pending = lines
      .map((l, idx) => ({ l, idx }))
      .filter(({ l }) => {
        const lc = (l.currency || buyCur).toUpperCase();
        return lc !== buyCur && (l.fx_rate === undefined || l.fx_rate === null);
      });
    if (pending.length === 0) return;
    Promise.all(
      pending.map(({ l, idx }) =>
        getExchangeRate((l.currency || buyCur).toUpperCase(), buyCur).then((r) => ({
          idx, r,
        })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setLines((arr) => {
        const next = [...arr];
        for (const { idx, r } of results) {
          if (r && r > 0) {
            next[idx] = {
              ...next[idx],
              fx_rate: Math.round(r * 10000) / 10000,
            };
          } else {
            // No rate available — fall back to 1 so totals don't blow up.
            next[idx] = { ...next[idx], fx_rate: 1 };
          }
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [open, lines.map((l) => `${l.currency}:${l.fx_rate ?? ""}`).join("|"), form.buy_currency]);

  // When commission agent is selected, auto-fill commission type + rate
  // from the agent's defaults.
  useEffect(() => {
    if (!commissionAgentId) return;
    const agent = commissionAgents.find((a) => a.id === commissionAgentId);
    if (!agent) return;
    // Map the agent's commission_type (CommissionType) to our local UI type.
    switch (agent.commission_type) {
      case "profit_percent":
// eslint-disable-next-line react-hooks/set-state-in-effect
        setCommissionType("percent_profit");
        setCommissionRate(agent.commission_rate || 0);
        break;
      case "revenue_percent":
        setCommissionType("percent_revenue");
        setCommissionRate(agent.commission_rate || 0);
        break;
      case "per_unit":
        setCommissionType("fixed_per_unit");
        setCommissionRate(agent.commission_per_unit || 0);
        break;
      case "fixed":
        setCommissionType("fixed_total");
        setCommissionRate(agent.commission_rate || 0);
        break;
      case "custom":
        // Leave current type as-is — user can pick.
        break;
    }
  }, [commissionAgentId, commissionAgents]);

  function set<K extends keyof TradeCalculation>(k: K, v: TradeCalculation[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Filter offers by selected product (if any)
  const availableOffers = form.product_id
    ? offers.filter((o) => o.product_id === form.product_id)
    : offers;
  const selectedSupplier = form.supplier_id ? partners.find((p) => p.id === form.supplier_id) : undefined;
  const selectedBuyer = form.buyer_id ? partners.find((p) => p.id === form.buyer_id) : undefined;
  // Show all partners in both dropdowns — the partner.type field is advisory
  // (and can be localized, e.g. "Kupac" = buyer in Serbian), so filtering by
  // type would exclude valid partners. Let the user pick any partner as
  // supplier or buyer.
  const buyerPartners = partners;
  const supplierPartners = partners;

  // ─── Supplier auto-fill ───
  const fetchSupplierContext = useCallback(async (supplierId: string) => {
    if (!supplierId) {
      setSupplierContext(null);
      return;
    }
    setLoadingSupplier(true);
    try {
      const r = await fetch(api(`/api/automation/partner-context?partner_id=${supplierId}`));
      if (!r.ok) throw new Error("Failed to load supplier context");
      const ctx: PartnerContext = await r.json();
      setSupplierContext(ctx);

      // Auto-fill supplier preferences
      const p = ctx.partner;
      setForm((f) => ({
        ...f,
        supplier_id: supplierId,
        buy_currency: p.preferred_currency || f.buy_currency || "USD",
        buy_incoterm: p.preferred_incoterm || f.buy_incoterm || "FOB",
        loading_port: f.loading_port || (ctx.supplierOffers?.[0]?.loading_port) || "",
      }));

      toast.success(t("misc-supplier-data-loaded-toast").replace("${name}", p.name), { description: t("misc-currency-incoterm-autofilled") });
    } catch {
      toast.error(t("misc-failed-load-supplier-context"));
      setSupplierContext(null);
    } finally {
      setLoadingSupplier(false);
    }
  }, []);

  // ─── Product auto-fill ───
  function selectProduct(productId: string | null) {
    setForm((f) => {
      // Reset supplier offer if it doesn't match new product
      const offerStillValid = productId && f.supplier_offer_id
        ? offers.find((o) => o.id === f.supplier_offer_id)?.product_id === productId
        : false;
      const catEntry = productId ? catalog.find((p) => p.id === productId) : null;
      return {
        ...f,
        product_id: productId,
        supplier_offer_id: offerStillValid ? f.supplier_offer_id : null,
        unit: catEntry?.unit || f.unit,
      };
    });

    // Fetch product context for richer data
    if (productId) {
      setLoadingProduct(true);
      fetch(api(`/api/automation/product-context?product_id=${productId}`))
        .then((r) => {
          if (!r.ok) throw new Error("Failed to load product context");
          return r.json() as Promise<ProductContext>;
        })
        .then((ctx) => {
          setProductContext(ctx);
          // Auto-fill from catalog entry
          const catEntry = ctx.catalogEntry;
          if (catEntry) {
            setForm((f) => ({
              ...f,
              buy_price_per_unit: catEntry.base_price || f.buy_price_per_unit,
              unit: catEntry.base_unit || f.unit,
              loading_port: f.loading_port || "",
            }));
          }
          toast.success(t("misc-product-data-loaded-toast"), { description: t("misc-price-unit-hs-autofilled") });
        })
        .catch(() => {
          toast.error(t("misc-failed-load-product-context"));
          setProductContext(null);
        })
        .finally(() => setLoadingProduct(false));
    } else {
      setProductContext(null);
    }
  }

  function selectOffer(offerId: string | null) {
    setForm((f) => {
      if (!offerId) {
        return { ...f, supplier_offer_id: null };
      }
      const offer = offers.find((o) => o.id === offerId);
      if (!offer) return f;
      return {
        ...f,
        supplier_offer_id: offer.id,
        product_id: offer.product_id,
        supplier_id: offer.supplier_id,
        buy_price_per_unit: offer.unit_price,
        buy_currency: offer.currency,
        buy_incoterm: offer.incoterm,
        loading_port: f.loading_port || offer.loading_port || "",
        unit: catalog.find((p) => p.id === offer.product_id)?.unit || f.unit,
      };
    });
  }

  // ─── Auto weight conversion (kg ↔ MT ↔ lb ↔ …) ───
  // When the user changes the quantity unit, we auto-convert BOTH the
  // quantity AND the buy price per unit so the total buy cost (qty × price)
  // stays invariant. We use `convertUnit` (works correctly for quantity) and
  // compute price_per_newUnit = price_per_oldUnit / convertUnit(1, old, new).
  // The ratio is shown as a hint below the unit dropdown.
  function handleUnitChange(newUnit: string) {
    const oldUnit = form.unit || "MT";
    if (oldUnit === newUnit) return;

    const normOld = normalizeUnitForConversion(oldUnit);
    const normNew = normalizeUnitForConversion(newUnit);

    if (!canConvert(normOld, normNew)) {
      // Different categories (e.g. weight → volume) — just change unit,
      // leave qty & price alone so the user can enter them manually.
      set("unit", newUnit);
      setConversionHint(null);
      return;
    }

    const oldQty = form.quantity || 0;
    const oldPrice = form.buy_price_per_unit || 0;
    const newQty = convertUnit(oldQty, normOld, normNew);
    const factor = convertUnit(1, normOld, normNew);
    // Price-per-newUnit = price-per-oldUnit / (1 oldUnit in newUnits).
    const newPrice = factor != null && factor !== 0
      ? oldPrice / factor
      : null;

    setForm((f) => ({
      ...f,
      unit: newUnit,
      quantity: newQty != null ? Math.round(newQty * 1000) / 1000 : f.quantity,
      buy_price_per_unit: newPrice != null
        ? Math.round(newPrice * 10000) / 10000
        : f.buy_price_per_unit,
    }));

    const desc = describeConversion(normOld, normNew);
    setConversionHint(desc);
    if (desc && newQty != null) {
      toast.info(t("misc-unit-converted-toast").replace("${desc}", desc), {
        description: t("misc-qty-price-converted-toast").replace("${old}", oldUnit).replace("${new}", newUnit),
      });
    }
  }

  // ─── Incoterm-based loading / delivery location auto-suggest ───
  // EXW  → loading at supplier's factory address (use Road Transport).
  // FOB/FAS/FCA → loading at port (clear address, switch to sea container).
  // CIF/CFR/CPT/CIP → both loading & delivery ports; sea container default.
  // DAP/DDP/DPU → delivery at buyer's address (use Multimodal).
  function handleIncotermChange(incoterm: string) {
    set("buy_incoterm", incoterm);

    if (incoterm === "EXW") {
      // Loading at supplier's address (factory / warehouse).
      if (selectedSupplier) {
        const addr = [
          selectedSupplier.address_line,
          selectedSupplier.city,
          selectedSupplier.country,
        ].filter(Boolean).join(", ");
        if (addr) set("loading_port", addr);
      }
      set("transport_mode", "ROAD");
    } else if (["FOB", "FAS", "FCA"].includes(incoterm)) {
      // Loading at port — clear any pre-filled address; user picks a port.
      set("loading_port", "");
      set("transport_mode", "SEA");
    } else if (["CIF", "CFR", "CPT", "CIP"].includes(incoterm)) {
      // Both loading port + delivery port — sea container default.
      set("transport_mode", "SEA");
    } else if (["DAP", "DDP", "DPU"].includes(incoterm)) {
      // Delivery at buyer's address.
      if (selectedBuyer) {
        const addr = [
          selectedBuyer.address_line,
          selectedBuyer.city,
          selectedBuyer.country,
        ].filter(Boolean).join(", ");
        if (addr) set("delivery_port", addr);
      }
      set("transport_mode", "MULTIMODAL");
    }

    toast.info(t("misc-tc-incoterm-set-toast").replace("${incoterm}", incoterm), {
      description: t("misc-tc-incoterm-set-desc"),
    });
  }

  function updateLine(idx: number, patch: Partial<TradeCostLine>) {
    setLines((arr) => arr.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, ...patch };
      // When currency changes, reset fx_rate so the live-rate effect can
      // re-populate it (see fetchLineFxRate below). Same currency = 1.
      if (patch.currency && patch.currency !== l.currency) {
        const newCurrency = patch.currency.toUpperCase();
        const buyCur = (form.buy_currency || "USD").toUpperCase();
        if (newCurrency === buyCur) {
          next.fx_rate = 1;
        } else {
          // Clear — the useEffect on [lines, form.buy_currency] will fetch live.
          next.fx_rate = undefined;
        }
      }
      // When user manually edits fx_rate, mark it as user-set (don't clobber).
      return next;
    }));
  }
  function addLine() {
    const defaultType = "FREIGHT";
    const ref = TRADE_COST_TYPES.find((t) => t.code === defaultType)!;
    setLines((arr) => [
      ...arr,
      {
        type: defaultType,
        label: ref.name,
        basis: ref.basis,
        value: 0,
        currency: form.buy_currency || "USD",
        amount: 0,
        fx_rate: 1,
        converted_amount: 0,
      },
    ]);
  }
  function removeLine(idx: number) {
    setLines((arr) => arr.filter((_, i) => i !== idx));
  }
  function changeLineType(idx: number, typeCode: string) {
    const ref = TRADE_COST_TYPES.find((t) => t.code === typeCode);
    if (!ref) return;
    setLines((arr) => arr.map((l, i) =>
      i === idx
        ? { ...l, type: typeCode, label: ref.name, basis: ref.basis }
        : l,
    ));
  }
  // Reset a single line's fx_rate to the live rate (used by the refresh icon
  // when the user has manually overridden the rate).
  async function resetLineFx(idx: number) {
    const line = lines[idx];
    if (!line) return;
    const buyCur = (form.buy_currency || "USD").toUpperCase();
    const lineCur = (line.currency || buyCur).toUpperCase();
    if (lineCur === buyCur) {
      updateLine(idx, { fx_rate: 1 });
      return;
    }
    const r = await getExchangeRate(lineCur, buyCur);
    if (r && r > 0) {
      updateLine(idx, { fx_rate: Math.round(r * 10000) / 10000 });
      toast.success(t("misc-tc-live-rate-fetched-toast").replace("${from}", lineCur).replace("${rate}", r.toFixed(4)).replace("${to}", buyCur));
    } else {
      toast.error(t("misc-tc-could-not-fetch-rate-toast").replace("${from}", lineCur).replace("${to}", buyCur));
    }
  }

  // ─── Auto-suggest cost lines based on incoterm ───
  function applyIncotermSuggestions() {
    const incoterm = form.buy_incoterm || "FOB";
    const suggestions = INCOTERM_COST_SUGGESTIONS[incoterm];
    if (!suggestions || suggestions.length === 0) {
      toast.info(t("misc-tc-no-suggestions-toast").replace("${incoterm}", incoterm));
      return;
    }

    // Check if lines already exist with these types
    const existingTypes = new Set(lines.map((l) => l.type));
    const newLines: TradeCostLine[] = [];
    let added = 0;

    for (const sug of suggestions) {
      if (!existingTypes.has(sug.type)) {
        newLines.push({
          type: sug.type,
          label: sug.label,
          basis: sug.basis,
          value: sug.default_value,
          currency: form.buy_currency || "USD",
          amount: 0,
        });
        added++;
      }
    }

    if (added > 0) {
      setLines((arr) => [...arr, ...newLines]);
      toast.success(t("misc-tc-added-cost-lines-toast").replace("${n}", String(added)).replace("${incoterm}", incoterm), {
        description: t("misc-tc-added-cost-lines-desc"),
      });
    } else {
      toast.info(t("misc-tc-all-suggestions-exist-toast"));
    }
  }

  // ─── Bank costs / trade finance helpers ───
  // Live bank-cost calculation — driven by the selected payment method and
  // the deal's sell-side total. The list of applicable cost items is sourced
  // from src/lib/data/bank-costs.ts (ICC Banking Commission averages).
  // Users can override individual rates via the "Edit Rates" dialog.
  //
  // NOTE: calculateBankCosts now returns ONLY trade-finance costs (LC
  // issuance, advising, etc.) — transfer fees are computed separately via
  // calculateTransferFees because they apply to ALL international payments.
  const applicableBankCostItems = useMemo(
    () => (paymentTerms ? BANK_COSTS.filter((c) => c.applicablePaymentMethods.includes(paymentTerms)) : []),
    [paymentTerms],
  );

  const bankCosts: BankCostResult[] = useMemo(() => {
    if (!paymentTerms) return [];
    const txValue = (form.sell_price_per_unit || 0) * (form.quantity || 0);
    if (txValue === 0) return [];
    return calculateBankCosts(paymentTerms, txValue, bankCostOverrides);
  }, [paymentTerms, form.sell_price_per_unit, form.quantity, bankCostOverrides]);

  const totalBankCosts = useMemo(
    () => bankCosts.reduce((s, b) => s + (b.amount || 0), 0),
    [bankCosts],
  );

  // Live preview computation (gross — no commission/bank/transfer/doc costs
  // folded in, so we can derive commission from net-of-costs profit below).
  const preview = useMemo(
    () => computeTotals({ ...form, cost_lines: lines }),
    [form, lines],
  );

  // ─── International transfer fees (SWIFT / correspondent / FX spread) ───
  // These apply to EVERY international payment regardless of payment method.
  // Number of transfers depends on the payment method (e.g. 30% advance +
  // 70% on B/L = 2 SWIFT messages). Falls back to "advance_100" (1 transfer).
  const numTransfers = useMemo(
    () => getNumTransfersForPaymentMethod(paymentTerms || "advance_100"),
    [paymentTerms],
  );

  const transferFees: TransferFeeResult[] = useMemo(() => {
    const txValue = preview.sellTotal;
    if (txValue <= 0) return [];
    return calculateTransferFees(
      txValue,
      form.sell_currency || "USD",
      numTransfers,
      transferFeeOverrides,
    );
  }, [preview.sellTotal, form.sell_currency, numTransfers, transferFeeOverrides]);

  const totalTransferFees = useMemo(
    () => transferFees.reduce((s, t) => s + (t.amount || 0), 0),
    [transferFees],
  );

  // ─── Documentation costs (B/L, Phyto, CoO, THC, …) ───
  // Pre-selected with typically-required documents; user can add/remove.
  // THC scales with num_containers when > 1.
  const documentationCosts: DocumentationCostResult[] = useMemo(() => {
    return calculateDocumentationCosts(
      selectedDocIds,
      docValueOverrides,
      form.num_containers || 1,
    );
  }, [selectedDocIds, docValueOverrides, form.num_containers]);

  const totalDocCosts = useMemo(
    () => documentationCosts.reduce((s, d) => s + (d.amount || 0), 0),
    [documentationCosts],
  );

  // ─── Profit BEFORE commission (after ALL costs: bank + transfer + docs) ───
  // Commission is now calculated from this net-of-costs profit, NOT from the
  // gross margin. This is the FIX to "commission AFTER all costs".
  const allCostsAfterLanded = totalBankCosts + totalTransferFees + totalDocCosts;
  const profitBeforeCommission = preview.margin - allCostsAfterLanded;

  // ─── Commission calculation ───
  // Helper: compute commission for a given profit base. Revenue- and
  // fixed-based commission types are unaffected by the profit base, but
  // percent_profit scales with profit (and clamps to 0 when profit ≤ 0).
  const calcCommissionForProfit = useCallback(
    (profitBase: number): number => {
      const rate = Number(commissionRate) || 0;
      const qty = form.quantity || 0;
      switch (commissionType) {
        case "percent_profit":
          return profitBase > 0 ? (profitBase * rate) / 100 : 0;
        case "percent_revenue":
          return (preview.sellTotal * rate) / 100;
        case "fixed_per_unit":
          return rate * qty;
        case "fixed_total":
          return rate;
        default:
          return 0;
      }
    },
    [commissionType, commissionRate, preview.sellTotal, form.quantity],
  );

  // Commission is calculated from profit AFTER all costs (bank + transfer + docs).
  const commissionAmount = useMemo(
    () => calcCommissionForProfit(profitBeforeCommission),
    [calcCommissionForProfit, profitBeforeCommission],
  );

  // Net profit = profit after all costs − commission (sell currency).
  const netProfit = profitBeforeCommission - commissionAmount;
  const netMarginPct =
    preview.sellTotal > 0 ? (netProfit / preview.sellTotal) * 100 : 0;
  const qtyForUnit = form.quantity || 0;
  const profitPerUnit = qtyForUnit > 0 ? netProfit / qtyForUnit : 0;

  // ─── ±10% Variance Analysis ───
  // Banks may charge more or less than expected — show best/worst case
  // scenarios on bank + transfer + documentation costs.
  const VARIANCE_PCT = 0.10;
  const bestCaseCosts = allCostsAfterLanded * (1 - VARIANCE_PCT);
  const worstCaseCosts = allCostsAfterLanded * (1 + VARIANCE_PCT);
  const bestCaseProfitBeforeCommission = preview.margin - bestCaseCosts;
  const worstCaseProfitBeforeCommission = preview.margin - worstCaseCosts;
  const bestCaseCommission = calcCommissionForProfit(bestCaseProfitBeforeCommission);
  const worstCaseCommission = calcCommissionForProfit(worstCaseProfitBeforeCommission);
  const bestCaseProfit = bestCaseProfitBeforeCommission - bestCaseCommission;
  const worstCaseProfit = worstCaseProfitBeforeCommission - worstCaseCommission;
  const varianceSpread = Math.abs(worstCaseProfit - bestCaseProfit);

  function applyBankCostOverrides(id: string, value: number) {
    setBankCostOverrides((prev) => ({ ...prev, [id]: value }));
  }
  function resetBankCostOverrides() {
    setBankCostOverrides({});
  }

  // ─── Transfer fee overrides ───
  function applyTransferFeeOverride(id: string, value: number) {
    setTransferFeeOverrides((prev) => ({ ...prev, [id]: value }));
  }
  function resetTransferFeeOverrides() {
    setTransferFeeOverrides({});
  }

  // ─── Documentation cost helpers ───
  function toggleDoc(id: string) {
    setSelectedDocIds((arr) =>
      arr.includes(id) ? arr.filter((d) => d !== id) : [...arr, id],
    );
  }
  function applyDocOverride(id: string, value: number) {
    setDocValueOverrides((prev) => ({ ...prev, [id]: value }));
  }
  function resetDocOverrides() {
    setDocValueOverrides({});
  }

  async function save() {
    if (!form.name) { toast.error(t("misc-tc-name-required")); return; }
    setSaving(true);
    try {
      // Include commission tracking state in the payload — previously the UI
      // had commission UI state but never sent it on save, so the backend's
      // PUT fell back to existing values and silently dropped the user's
      // commission edits. (Audit finding 1a.)
      const payload = {
        ...form,
        cost_lines: lines,
        commission_agent_id: commissionAgentId,
        commission_type: commissionType || null,
        commission_rate: commissionRate || 0,
      };
      const method = calc ? "PUT" : "POST";
      const url = calc ? api(`/api/trade-calculator/${calc.id}`) : api("/api/trade-calculator");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success(calc ? t("misc-tc-calculation-updated") : t("misc-tc-calculation-created"));
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t("misc-tc-saving-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-500" />
            {calc ? t("misc-edit-calculation") : t("misc-new-calculation")}
          </DialogTitle>
          <DialogDescription>{t("misc-calc-dialog-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("name")} *</Label>
            <Input value={form.name || ""} onChange={(e) => set("name", e.target.value)} placeholder={t("misc-name-placeholder-example")} />
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t("misc-source-section")}</p></div>

          {/* Product select with auto-fill */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {t("misc-product")}
              {loadingProduct && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
              {productContext && !loadingProduct && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5">
                  <Sparkles className="size-2.5 text-amber-500" /> {t("misc-auto-filled")}
                </Badge>
              )}
            </Label>
            <ProductPicker
              value={form.product_id || ""}
              onSelect={(p) => selectProduct(p?.id || null)}
              placeholder={t("misc-search-products-placeholder")}
              className="h-9"
            />
          </div>

          {/* Product context panel */}
          {productContext && form.product_id && (
            <div className="md:col-span-2 rounded-lg border border-amber-500/20 bg-amber-50/50 dark:bg-amber-950/10 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="size-4 text-amber-600" />
                <span className="text-sm font-medium">{productContext.catalogEntry?.name || "Product"}</span>
                {productContext.catalogEntry?.hs_code && (
                  <Badge variant="outline" className="text-xs font-mono">HS: {productContext.catalogEntry.hs_code}</Badge>
                )}
                {productContext.catalogEntry?.origin_country && (
                  <Badge variant="outline" className="text-xs">{productContext.catalogEntry.origin_country}</Badge>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                {productContext.catalogEntry?.base_unit && (
                  <div className="text-muted-foreground">{t("misc-unit-prefix").replace("${unit}", productContext.catalogEntry.base_unit)}</div>
                )}
                {productContext.supplierOffers?.length > 0 && (
                  <div className="text-muted-foreground">
                    {t("misc-supplier-offers-count").replace("${n}", String(productContext.supplierOffers.length))}
                  </div>
                )}
                {productContext.tradeCalculations?.length > 0 && (
                  <div className="text-muted-foreground">
                    {t("misc-prior-calculations-count").replace("${n}", String(productContext.tradeCalculations.length))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t("misc-supplier-offer")}</Label>
            <Select
              value={form.supplier_offer_id || "__none__"}
              onValueChange={(v) => selectOffer(v === "__none__" ? null : v)}
            >
              <SelectTrigger><SelectValue placeholder={t("misc-select-offer-autofill")} /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="__none__">{t("misc-no-offer")}</SelectItem>
                {availableOffers.map((o) => {
                  const sup = partners.find((p) => p.id === o.supplier_id);
                  return (
                    <SelectItem key={o.id} value={o.id}>
                      {sup?.name || t("misc-unknown")} — {fmtMoney(o.unit_price, o.currency)} {o.incoterm}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Supplier select with auto-fill */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {t("misc-supplier-label")}
              {loadingSupplier && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
              {supplierContext && !loadingSupplier && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5">
                  <Sparkles className="size-2.5 text-amber-500" /> {t("misc-auto-filled")}
                </Badge>
              )}
            </Label>
            <PartnerPicker
              value={form.supplier_id || ""}
              filterType="supplier"
              onSelect={(p) => {
                const sid = p?.id || null;
                set("supplier_id", sid);
                if (sid) fetchSupplierContext(sid);
                else setSupplierContext(null);
              }}
              placeholder={t("misc-search-suppliers-placeholder")}
            />
          </div>

          {/* Supplier context panel */}
          {supplierContext && form.supplier_id && (
            <div className="md:col-span-2 rounded-lg border border-amber-500/20 bg-amber-50/50 dark:bg-amber-950/10 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Building2 className="size-4 text-amber-600" />
                <span className="text-sm font-medium">{supplierContext.partner.name}</span>
                <Badge variant="outline" className="text-xs">{supplierContext.partner.type}</Badge>
                {supplierContext.partner.country && (
                  <Badge variant="outline" className="text-xs">{supplierContext.partner.country}</Badge>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                {supplierContext.partner.preferred_incoterm && (
                  <div className="flex items-center gap-1.5">
                    <Ship className="size-3 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">{t("misc-incoterm-prefix").replace("${code}", supplierContext.partner.preferred_incoterm)}</span>
                  </div>
                )}
                {supplierContext.partner.preferred_currency && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{t("misc-currency-prefix").replace("${code}", supplierContext.partner.preferred_currency)}</span>
                  </div>
                )}
                {supplierContext.partner.address_line && (
                  <div className="flex items-start gap-1.5">
                    <MapPin className="size-3 text-muted-foreground mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">{[supplierContext.partner.address_line, supplierContext.partner.city, supplierContext.partner.country].filter(Boolean).join(", ")}</span>
                  </div>
                )}
                {supplierContext.supplierOffers?.length > 0 && (
                  <div className="text-muted-foreground">
                    {t("misc-active-offers-count").replace("${n}", String(supplierContext.supplierOffers.length))}
                  </div>
                )}
                {supplierContext.tradeCalculations?.length > 0 && (
                  <div className="text-muted-foreground">
                    {t("misc-prior-calculations-count").replace("${n}", String(supplierContext.tradeCalculations.length))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t("misc-buyer-label")}</Label>
            <PartnerPicker
              value={form.buyer_id || ""}
              filterType="buyer"
              onSelect={(p) => set("buyer_id", p?.id || null)}
              placeholder={t("misc-search-buyers-placeholder")}
            />
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t("misc-quantity-transport-section")}</p></div>
          <div className="space-y-1.5">
            <Label>{t("misc-quantity")}</Label>
            <Input type="number" min={0} value={form.quantity ?? 0} onChange={(e) => set("quantity", Number(e.target.value))} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {t("misc-unit-label")}
              {conversionHint && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5 text-amber-600 border-amber-500/30">
                  <ArrowLeftRight className="size-2.5" /> {t("misc-auto-converted")}
                </Badge>
              )}
            </Label>
            <UnitSelect
              value={form.unit || "MT"}
              onChange={handleUnitChange}
              className="w-full"
            />
            {conversionHint && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <ArrowLeftRight className="size-3 shrink-0" />
                <span>{conversionHint}</span>
              </p>
            )}
          </div>

          {/* Transport mode — drives which fields appear below */}
          <div className="space-y-1.5 md:col-span-2">
            <Label className="flex items-center gap-1.5">
              {t("log-transport-mode")}
              {/* Use React.createElement instead of <Mode /> JSX so we don't
                  violate react-hooks/static-components (creating a component
                  during render). */}
              {createElement(transportModeIcon(form.transport_mode), {
                className: "size-3.5 text-muted-foreground",
              })}
            </Label>
            <Select value={form.transport_mode || "SEA"} onValueChange={(v) => set("transport_mode", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENHANCED_TRANSPORT_MODES.map((m) => (
                  <SelectItem key={m.code} value={m.code}>
                    <span className="mr-2">{t(m.nameKey)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {(() => {
                const m = ENHANCED_TRANSPORT_MODES.find((mm) => mm.code === form.transport_mode);
                return m ? t(m.hintKey) : t("log-select-transport-mode-hint");
              })()}
            </p>
          </div>

          {/* ── Container fields — shown for SEA / RAIL / MULTIMODAL ── */}
          {(form.transport_mode === "SEA" ||
            form.transport_mode === "RAIL" ||
            form.transport_mode === "MULTIMODAL" ||
            !form.transport_mode) && (
            <>
              <div className="space-y-1.5">
                <Label>{t("log-container-type")}</Label>
                <Select value={form.container_type || "40HC"} onValueChange={(v) => set("container_type", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {CONTAINER_TYPES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        <span className="font-mono mr-2">{c.code}</span> {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{form.transport_mode === "RAIL" ? t("log-num-wagons-containers") : t("log-num-containers")}</Label>
                <Input type="number" min={0} value={form.num_containers ?? 1} onChange={(e) => set("num_containers", Number(e.target.value))} className="tabular" />
              </div>
            </>
          )}

          {/* ── Bulk vessel fields — shown for SEA_BULK ── */}
          {form.transport_mode === "SEA_BULK" && (
            <>
              <div className="space-y-1.5">
                <Label>{t("log-vessel-capacity")}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={transportExtras.vessel_capacity_mt ?? 0}
                  onChange={(e) => setTransportExtras((s) => ({ ...s, vessel_capacity_mt: Number(e.target.value) }))}
                  className="tabular"
                  placeholder={t("log-vessel-capacity-placeholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("log-freight-rate-per-mt")}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={transportExtras.freight_rate_per_mt ?? 0}
                  onChange={(e) => setTransportExtras((s) => ({ ...s, freight_rate_per_mt: Number(e.target.value) }))}
                  className="tabular"
                  placeholder={t("log-freight-rate-mt-placeholder")}
                />
              </div>
              <p className="md:col-span-2 text-xs text-muted-foreground">
                {t("log-vessel-fields-hint")}
              </p>
            </>
          )}

          {/* ── Truck fields — shown for ROAD ── */}
          {form.transport_mode === "ROAD" && (
            <>
              <div className="space-y-1.5">
                <Label>{t("log-truck-type")}</Label>
                <Select
                  value={transportExtras.truck_type || "standard"}
                  onValueChange={(v) => setTransportExtras((s) => ({ ...s, truck_type: v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {TRUCK_TYPES.map((tt) => (
                      <SelectItem key={tt.code} value={tt.code}>{t(tt.nameKey)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("log-num-trucks")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={transportExtras.num_trucks ?? 1}
                  onChange={(e) => setTransportExtras((s) => ({ ...s, num_trucks: Number(e.target.value) }))}
                  className="tabular"
                />
              </div>
              <p className="md:col-span-2 text-xs text-muted-foreground">
                {t("log-truck-fields-hint")}
              </p>
            </>
          )}

          {/* ── Air freight fields — shown for AIR ── */}
          {form.transport_mode === "AIR" && (
            <>
              <div className="space-y-1.5">
                <Label>{t("log-chargeable-weight")}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={transportExtras.air_chargeable_weight_kg ?? 0}
                  onChange={(e) => setTransportExtras((s) => ({ ...s, air_chargeable_weight_kg: Number(e.target.value) }))}
                  className="tabular"
                  placeholder={t("log-chargeable-weight-placeholder")}
                />
              </div>
              <p className="md:col-span-2 text-xs text-muted-foreground">
                {t("log-air-fields-hint")}
              </p>
            </>
          )}

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t("misc-buy-side")}</p></div>
          <div className="space-y-1.5">
            <Label>{t("misc-buy-price-per-unit")}</Label>
            <Input type="number" min={0} step="0.01" value={form.buy_price_per_unit ?? 0} onChange={(e) => set("buy_price_per_unit", Number(e.target.value))} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("misc-buy-currency")}</Label>
            <Select value={form.buy_currency || "USD"} onValueChange={(v) => set("buy_currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <span className="font-mono mr-2">{c.value}</span> {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {t("misc-buy-incoterm")}
              <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5">
                <Sparkles className="size-2.5 text-amber-500" /> {t("misc-auto-sets-loading")}
              </Badge>
            </Label>
            <Select value={form.buy_incoterm || "FOB"} onValueChange={handleIncotermChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {INCOTERMS.map((i) => (
                  <SelectItem key={i.code} value={i.code}>
                    <span className="font-mono mr-2">{i.code}</span> {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("log-loading-port")}</Label>
            <PortAutocomplete
              value={form.loading_port || ""}
              onChange={(v) => set("loading_port", v)}
              placeholder={t("log-port-autocomplete-placeholder")}
            />
          </div>

          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t("misc-sell-side")}</p></div>
          <div className="space-y-1.5">
            <Label>{t("misc-sell-price-per-unit")}</Label>
            <Input type="number" min={0} step="0.01" value={form.sell_price_per_unit ?? 0} onChange={(e) => set("sell_price_per_unit", Number(e.target.value))} className="tabular" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("misc-sell-currency")}</Label>
            <Select value={form.sell_currency || "USD"} onValueChange={(v) => set("sell_currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <span className="font-mono mr-2">{c.value}</span> {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("misc-sell-incoterm")}</Label>
            <Select value={form.sell_incoterm || "CIF"} onValueChange={(v) => set("sell_incoterm", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {INCOTERMS.map((i) => (
                  <SelectItem key={i.code} value={i.code}>
                    <span className="font-mono mr-2">{i.code}</span> {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("log-delivery-port")}</Label>
            <PortAutocomplete
              value={form.delivery_port || ""}
              onChange={(v) => set("delivery_port", v)}
              placeholder={t("log-port-autocomplete-placeholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {t("misc-exchange-rate")}
              {form.buy_currency && form.sell_currency && form.buy_currency !== form.sell_currency && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5">
                  1 {form.buy_currency} = {Number(form.exchange_rate || 0).toFixed(4)} {form.sell_currency}
                </Badge>
              )}
            </Label>
            <div className="flex gap-1.5">
              <Input
                type="number"
                min={0}
                step="0.0001"
                value={form.exchange_rate ?? 1}
                onChange={(e) => set("exchange_rate", Number(e.target.value))}
                className="tabular flex-1"
                disabled={
                  !!form.buy_currency &&
                  !!form.sell_currency &&
                  form.buy_currency === form.sell_currency
                }
              />
              {form.buy_currency && form.sell_currency && form.buy_currency !== form.sell_currency && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 px-2"
                  disabled={fetchingRate}
                  onClick={async () => {
                    if (!form.buy_currency || !form.sell_currency) return;
                    setFetchingRate(true);
                    try {
                      const rate = await getExchangeRate(form.buy_currency, form.sell_currency);
                      if (rate !== null) {
                        set("exchange_rate", Math.round(rate * 10000) / 10000);
                        toast.success(t("misc-tc-fetched-exchange-rate-toast").replace("${from}", form.buy_currency || "").replace("${rate}", rate.toFixed(4)).replace("${to}", form.sell_currency || ""));
                      } else {
                        toast.error(t("misc-tc-could-not-fetch-exchange-rate-toast"));
                      }
                    } finally {
                      setFetchingRate(false);
                    }
                  }}
                  title={t("misc-fetch-live-rate-tooltip")}
                >
                  {fetchingRate ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  <span className="sr-only">{t("misc-fetch-live-rate-sr")}</span>
                </Button>
              )}
            </div>
            {form.buy_currency && form.sell_currency && form.buy_currency !== form.sell_currency && (
              <p className="text-xs text-muted-foreground">
                {t("misc-exchange-rate-hint")}
              </p>
            )}
          </div>

          {/* Cost lines editor */}
          <div className="md:col-span-2">
            <Separator className="my-1" />
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted-foreground">{t("misc-cost-lines-section")}</p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={applyIncotermSuggestions} title={t("misc-suggest-cost-lines-tooltip")}>
                  <Lightbulb className="size-3.5 mr-1" /> {t("misc-suggest-for-incoterm").replace("${incoterm}", form.buy_incoterm || "FOB")}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={addLine}>
                  <Plus className="size-3.5 mr-1" /> {t("misc-add-cost-line")}
                </Button>
              </div>
            </div>
            {lines.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-md">
                {t("misc-no-cost-lines-hint")}
              </p>
            ) : (
              <div className="space-y-2">
                {lines.map((l, idx) => {
                  const lineCur = (l.currency || form.buy_currency || "USD").toUpperCase();
                  const buyCur = (form.buy_currency || "USD").toUpperCase();
                  const isForeign = lineCur !== buyCur;
                  const computedAmt = (() => {
                    const qty = form.quantity || 0;
                    const numContainers = form.num_containers || 1;
                    if (l.basis === "unit") return (l.value || 0) * qty;
                    if (l.basis === "fixed") return l.value || 0;
                    if (l.basis === "per_container") return (l.value || 0) * numContainers;
                    if (l.basis === "percent") return 0; // depends on running landedCost
                    return 0;
                  })();
                  const converted = computedAmt * (l.fx_rate || 1);
                  return (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-12 sm:col-span-2">
                        <Select value={l.type} onValueChange={(v) => changeLineType(idx, v)}>
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent className="max-h-72">
                            {EDITABLE_COST_TYPES.map((t) => (
                              <SelectItem key={t.code} value={t.code}>
                                <span className="font-mono mr-2 text-xs">{t.code}</span> <span className="text-xs">{t.name}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-12 sm:col-span-3">
                        <Input
                          value={l.label}
                          onChange={(e) => updateLine(idx, { label: e.target.value })}
                          placeholder={t("misc-label-field")}
                          className="h-9 text-xs"
                        />
                      </div>
                      <div className="col-span-4 sm:col-span-1">
                        <Badge variant="secondary" className="font-mono w-full justify-center py-1.5 text-xs">{l.basis}</Badge>
                      </div>
                      <div className="col-span-5 sm:col-span-2">
                        <Input
                          type="number"
                          step="0.01"
                          value={l.value}
                          onChange={(e) => updateLine(idx, { value: Number(e.target.value) })}
                          className="h-9 text-xs tabular"
                          placeholder={l.basis === "percent" ? "%" : t("amount")}
                        />
                      </div>
                      <div className="col-span-3 sm:col-span-1">
                        <Select value={l.currency} onValueChange={(v) => updateLine(idx, { currency: v })}>
                          <SelectTrigger className="h-9 text-xs px-2"><SelectValue /></SelectTrigger>
                          <SelectContent className="max-h-72">
                            {CURRENCIES.map((c) => (
                              <SelectItem key={c.value} value={c.value} className="text-xs">
                                <span className="font-mono">{c.value}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-6 sm:col-span-2 flex items-center gap-1">
                        <Input
                          type="number"
                          step="0.0001"
                          value={l.fx_rate ?? ""}
                          onChange={(e) => updateLine(idx, { fx_rate: Number(e.target.value) || 0 })}
                          className="h-9 text-xs tabular"
                          placeholder="FX"
                          disabled={!isForeign}
                          title={isForeign ? `1 ${lineCur} = ${l.fx_rate ?? "—"} ${buyCur}` : t("misc-same-currency")}
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-9 shrink-0"
                          onClick={() => resetLineFx(idx)}
                          disabled={!isForeign}
                          title={isForeign ? t("misc-reset-to-live-rate") : t("misc-same-currency")}
                        >
                          <RefreshCw className={`size-3.5 ${fetchingRate ? "animate-spin" : ""}`} />
                        </Button>
                      </div>
                      <div className="col-span-2 sm:col-span-1 flex justify-end">
                        <Button type="button" size="icon" variant="ghost" className="size-9 text-destructive" onClick={() => removeLine(idx)} title={t("remove")} aria-label={t("remove")}>
                          <X className="size-4" />
                        </Button>
                      </div>
                      {isForeign && computedAmt > 0 && (
                        <div className="col-span-12 -mt-1 mb-1 pl-1 text-xs text-blue-600 dark:text-blue-400 italic">
                          {computedAmt.toLocaleString("en-US", { maximumFractionDigits: 2 })} {lineCur} × {l.fx_rate?.toFixed(4) ?? "—"} → <span className="font-mono font-medium not-italic">{converted.toLocaleString("en-US", { maximumFractionDigits: 2 })} {buyCur}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Payment terms — drives the bank costs calculator below */}
          <div className="md:col-span-2"><Separator className="my-1" /><p className="text-xs text-muted-foreground">{t("misc-payment-trade-finance-section")}</p></div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {t("misc-payment-terms-label")}
              <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5">
                <Landmark className="size-2.5" /> {t("misc-drives-bank-costs")}
              </Badge>
            </Label>
            <Select
              value={paymentTerms || "__none__"}
              onValueChange={(v) => setPaymentTerms(v === "__none__" ? "" : v)}
            >
              <SelectTrigger><SelectValue placeholder={t("misc-select-payment-terms-placeholder")} /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="__none__">{t("misc-none-option")}</SelectItem>
                {PAYMENT_TERMS_LOCAL.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Bank / Trade Finance Costs (auto-calculated from payment method) */}
          <div className="md:col-span-2">
            <Collapsible open={bankCostsOpen} onOpenChange={setBankCostsOpen}>
              <div className="flex items-center justify-between mb-1.5">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="gap-1 px-2 hover:bg-muted/50">
                    <Landmark className="size-3.5" />
                    <span className="text-xs font-medium">{t("misc-bank-trade-finance-costs")}</span>
                    {bankCosts.length > 0 && (
                      <Badge variant="secondary" className="text-xs h-4 px-1.5">{bankCosts.length}</Badge>
                    )}
                    <ChevronDown className={`size-3.5 transition-transform ${bankCostsOpen ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
                {bankCosts.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowBankOverrides(true)}
                  >
                    {t("misc-edit-rates")}
                  </Button>
                )}
              </div>
              <CollapsibleContent>
                {!paymentTerms ? (
                  <p className="text-xs text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-md">
                    {t("misc-select-payment-method-hint")}
                  </p>
                ) : bankCosts.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-md">
                    {t("misc-no-bank-costs-hint")}
                  </p>
                ) : (
                  <div className="border border-border/60 rounded-md overflow-hidden">
                    <Table>
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead className="h-8 text-xs">{t("misc-cost-item")}</TableHead>
                          <TableHead className="h-8 text-xs">{t("misc-basis-label")}</TableHead>
                          <TableHead className="h-8 text-xs text-right">{t("amount")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bankCosts.map((cost) => {
                          const item = applicableBankCostItems.find((c) => c.id === cost.id);
                          const overridden = bankCostOverrides[cost.id] !== undefined;
                          return (
                            <TableRow key={cost.id} className="text-xs">
                              <TableCell>
                                <div className="font-medium">{cost.label}</div>
                                {item?.description && (
                                  <div className="text-xs text-muted-foreground">{item.description}</div>
                                )}
                                {overridden && (
                                  <Badge variant="outline" className="text-[9px] mt-0.5 h-3.5 px-1 gap-0.5 text-amber-600 border-amber-500/30">
                                    <Sparkles className="size-2" /> {t("misc-custom-rate")}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground">{cost.basis}</TableCell>
                              <TableCell className="text-right tabular font-medium">
                                {fmtMoney(cost.amount, form.sell_currency || "USD")}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        <TableRow className="font-semibold bg-muted/20">
                          <TableCell>{t("misc-total-bank-costs")}</TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular">
                            {fmtMoney(totalBankCosts, form.sell_currency || "USD")}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1.5">
                  {t("misc-icc-bank-costs-hint")}
                </p>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* ─── Transfer Fees (SWIFT / correspondent / FX spread) ─── */}
          {/* Always present for international payments — independent of payment method. */}
          <div className="md:col-span-2">
            <Collapsible open={transferFeesOpen} onOpenChange={setTransferFeesOpen}>
              <div className="flex items-center justify-between mb-1.5">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="gap-1 px-2 hover:bg-muted/50">
                    <Send className="size-3.5" />
                    <span className="text-xs font-medium">{t("misc-international-transfer-fees")}</span>
                    <Badge variant="secondary" className="text-xs h-4 px-1.5">{t("misc-num-transfers-suffix").replace("${n}", String(numTransfers))}</Badge>
                    <ChevronDown className={`size-3.5 transition-transform ${transferFeesOpen ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
                {transferFees.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular">
                    {t("misc-total-prefix").replace("${amount}", fmtMoney(totalTransferFees, form.sell_currency || "USD"))}
                  </span>
                )}
              </div>
              <CollapsibleContent>
                {preview.sellTotal <= 0 ? (
                  <p className="text-xs text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-md">
                    {t("misc-enter-sell-price-hint")}
                  </p>
                ) : transferFees.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-md">
                    {t("misc-no-transfer-fees-hint")}
                  </p>
                ) : (
                  <div className="border border-border/60 rounded-md overflow-hidden">
                    <Table>
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead className="h-8 text-xs">{t("misc-fee-item")}</TableHead>
                          <TableHead className="h-8 text-xs">{t("misc-basis-label")}</TableHead>
                          <TableHead className="h-8 text-xs text-right">{t("amount")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {transferFees.map((fee) => {
                          const def = TRANSFER_FEES.find((f) => f.id === fee.id);
                          const overridden = transferFeeOverrides[fee.id] !== undefined;
                          return (
                            <TableRow key={fee.id} className="text-xs">
                              <TableCell>
                                <div className="font-medium">{fee.label}</div>
                                {def?.description && (
                                  <div className="text-xs text-muted-foreground">{def.description}</div>
                                )}
                                {overridden && (
                                  <Badge variant="outline" className="text-[9px] mt-0.5 h-3.5 px-1 gap-0.5 text-amber-600 border-amber-500/30">
                                    <Sparkles className="size-2" /> {t("misc-custom-badge")}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground">{def?.basis || "—"}</TableCell>
                              <TableCell className="text-right tabular font-medium">
                                {fmtMoney(fee.amount, form.sell_currency || "USD")}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        <TableRow className="font-semibold bg-muted/20">
                          <TableCell>{t("misc-total-transfer-fees")}</TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular">
                            {fmtMoney(totalTransferFees, form.sell_currency || "USD")}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                    <div className="p-2 space-y-1.5 bg-muted/20 border-t border-border/40">
                      {TRANSFER_FEES.map((fee) => {
                        const overridden = transferFeeOverrides[fee.id] !== undefined;
                        const current = transferFeeOverrides[fee.id] ?? fee.defaultValue;
                        return (
                          <div key={fee.id} className="grid grid-cols-12 gap-2 items-center">
                            <div className="col-span-6 text-xs text-muted-foreground truncate">{fee.label}</div>
                            <div className="col-span-4">
                              <Input
                                type="number"
                                step="0.01"
                                min={0}
                                value={current}
                                onChange={(e) => applyTransferFeeOverride(fee.id, Number(e.target.value))}
                                className="h-7 text-xs tabular"
                              />
                            </div>
                            <div className="col-span-2 flex items-center gap-1">
                              <span className="text-xs text-muted-foreground whitespace-nowrap">
                                {fee.basis === "percent" ? "%" : (form.sell_currency || "USD")}
                              </span>
                              {overridden && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-1.5 text-xs"
                                  onClick={() => {
                                    const next = { ...transferFeeOverrides };
                                    delete next[fee.id];
                                    setTransferFeeOverrides(next);
                                  }}
                                >
                                  {t("reset")}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {Object.keys(transferFeeOverrides).length > 0 && (
                        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={resetTransferFeeOverrides}>
                          {t("misc-reset-all")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1.5">
                  {t("misc-swift-fees-hint")}
                </p>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* ─── Documentation Costs (B/L, Phyto, CoO, THC, …) ─── */}
          <div className="md:col-span-2">
            <Collapsible open={docsOpen} onOpenChange={setDocsOpen}>
              <div className="flex items-center justify-between mb-1.5">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="gap-1 px-2 hover:bg-muted/50">
                    <FileCheck className="size-3.5" />
                    <span className="text-xs font-medium">{t("misc-documentation-costs")}</span>
                    <Badge variant="secondary" className="text-xs h-4 px-1.5">{t("misc-num-docs-suffix").replace("${n}", String(selectedDocIds.length))}</Badge>
                    <ChevronDown className={`size-3.5 transition-transform ${docsOpen ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
                {documentationCosts.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular">
                    {t("misc-total-prefix").replace("${amount}", fmtMoney(totalDocCosts, form.sell_currency || "USD"))}
                  </span>
                )}
              </div>
              <CollapsibleContent>
                <div className="border border-border/60 rounded-md overflow-hidden">
                  {documentationCosts.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic py-3 text-center">
                      {t("misc-no-docs-hint")}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader className="bg-muted/40">
                        <TableRow>
                          <TableHead className="h-8 text-xs">{t("misc-document-label")}</TableHead>
                          <TableHead className="h-8 text-xs">{t("misc-category")}</TableHead>
                          <TableHead className="h-8 text-xs text-right">{t("amount")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {documentationCosts.map((doc) => {
                          const def = DOCUMENTATION_COSTS.find((d) => d.id === doc.id);
                          const overridden = docValueOverrides[doc.id] !== undefined;
                          return (
                            <TableRow key={doc.id} className="text-xs">
                              <TableCell>
                                <div className="font-medium">{doc.label}</div>
                                {def?.description && (
                                  <div className="text-xs text-muted-foreground">{def.description}</div>
                                )}
                                {overridden && (
                                  <Badge variant="outline" className="text-[9px] mt-0.5 h-3.5 px-1 gap-0.5 text-amber-600 border-amber-500/30">
                                    <Sparkles className="size-2" /> {t("misc-custom-badge")}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground capitalize">{def?.category || "—"}</TableCell>
                              <TableCell className="text-right tabular font-medium">
                                {fmtMoney(doc.amount, form.sell_currency || "USD")}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                        <TableRow className="font-semibold bg-muted/20">
                          <TableCell>{t("misc-total-documentation")}</TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular">
                            {fmtMoney(totalDocCosts, form.sell_currency || "USD")}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  )}
                  {/* Document picker grid */}
                  <div className="p-2 space-y-1 bg-muted/20 border-t border-border/40 max-h-72 overflow-y-auto custom-scroll">
                    {DOCUMENTATION_COSTS.map((doc) => {
                      const selected = selectedDocIds.includes(doc.id);
                      const current = docValueOverrides[doc.id] ?? doc.defaultValue;
                      return (
                        <div
                          key={doc.id}
                          className={`grid grid-cols-12 gap-2 items-center p-1.5 rounded border ${selected ? "border-border/60 bg-background" : "border-dashed border-border/40 opacity-70"}`}
                        >
                          <div className="col-span-7 flex items-start gap-2">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleDoc(doc.id)}
                              className="mt-0.5 size-3.5"
                            />
                            <div className="min-w-0">
                              <div className="text-xs font-medium truncate">{doc.label}</div>
                              <div className="text-xs text-muted-foreground truncate">{doc.description}</div>
                              <div className="flex items-center gap-1 mt-0.5">
                                <Badge variant="outline" className="text-[9px] h-3 px-1 capitalize">{doc.category}</Badge>
                                <Badge variant="outline" className="text-[9px] h-3 px-1 font-mono">{doc.basis}</Badge>
                                {doc.typicallyRequired && (
                                  <Badge variant="outline" className="text-[9px] h-3 px-1 text-emerald-600 border-emerald-500/30">{t("misc-typically-required")}</Badge>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="col-span-5 flex items-center gap-1">
                            <Input
                              type="number"
                              step="0.01"
                              min={0}
                              value={current}
                              disabled={!selected}
                              onChange={(e) => applyDocOverride(doc.id, Number(e.target.value))}
                              className="h-7 text-xs tabular"
                            />
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {form.sell_currency || "USD"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(docValueOverrides).length > 0 && (
                      <Button type="button" size="sm" variant="ghost" className="h-7 text-xs mt-1" onClick={resetDocOverrides}>
                        {t("misc-reset-all-defaults")}
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {t("misc-doc-costs-hint")}
                </p>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Commission (live — based on current profit) */}
          <div className="md:col-span-2">
            <Separator className="my-1 mb-2" />
            <div className="border border-border/60 rounded-lg p-3 space-y-3 bg-muted/10">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Percent className="size-3.5" /> {t("misc-commission-live-calc")}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {/* Agent selector */}
                <div className="space-y-1">
                  <Label className="text-xs">{t("misc-commission-agent-label")}</Label>
                  <Select
                    value={commissionAgentId || "__none__"}
                    onValueChange={(v) => setCommissionAgentId(v === "__none__" ? null : v)}
                  >
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue placeholder={t("misc-select-agent-placeholder")} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value="__none__">{t("misc-none-option")}</SelectItem>
                      {commissionAgents.map((a) => {
                        const partner = partners.find((p) => p.id === a.partner_id);
                        return (
                          <SelectItem key={a.id} value={a.id}>
                            {partner?.name || t("misc-unknown-agent")} ({a.commission_type})
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                {/* Commission type */}
                <div className="space-y-1">
                  <Label className="text-xs">{t("type")}</Label>
                  <Select
                    value={commissionType}
                    onValueChange={(v) => setCommissionType(v as CommissionTypeLocal)}
                  >
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COMMISSION_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{t(opt.labelKey)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Rate / amount */}
                <div className="space-y-1">
                  <Label className="text-xs">
                    {commissionType.startsWith("percent") ? t("misc-rate-percent") : t("misc-amount-currency").replace("${currency}", form.sell_currency || "USD")}
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={commissionRate}
                    onChange={(e) => setCommissionRate(Number(e.target.value))}
                    className="h-9 text-xs tabular"
                  />
                </div>
              </div>

              {/* Live calculation summary */}
              <div className="bg-background rounded p-2.5 space-y-1 text-xs border border-border/40">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("misc-gross-profit-colon")}</span>
                  <span className="font-mono">{fmtMoney(preview.margin, form.sell_currency || "USD")}</span>
                </div>
                {totalBankCosts > 0 && (
                  <div className="flex justify-between text-amber-600">
                    <span>{t("misc-bank-costs-colon")}</span>
                    <span className="font-mono">-{fmtMoney(totalBankCosts, form.sell_currency || "USD")}</span>
                  </div>
                )}
                {totalTransferFees > 0 && (
                  <div className="flex justify-between text-amber-600">
                    <span>{t("misc-transfer-fees-colon")}</span>
                    <span className="font-mono">-{fmtMoney(totalTransferFees, form.sell_currency || "USD")}</span>
                  </div>
                )}
                {totalDocCosts > 0 && (
                  <div className="flex justify-between text-amber-600">
                    <span>{t("misc-documentation-colon")}</span>
                    <span className="font-mono">-{fmtMoney(totalDocCosts, form.sell_currency || "USD")}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-border/40 pt-1">
                  <span className="text-muted-foreground">
                    {t("misc-profit-before-commission")}{commissionType === "percent_profit" ? t("misc-commission-base-suffix") : ":"}
                  </span>
                  <span className={`font-mono ${profitBeforeCommission >= 0 ? "text-chart-1" : "text-destructive"}`}>
                    {fmtMoney(profitBeforeCommission, form.sell_currency || "USD")}
                  </span>
                </div>
                <div className="flex justify-between text-amber-600">
                  <span>
                    {t("misc-commission-colon")}
                    {commissionType === "percent_profit" ? t("misc-of-profit").replace("${rate}", String(commissionRate)) : ""}
                    {commissionType === "percent_revenue" ? t("misc-of-revenue").replace("${rate}", String(commissionRate)) : ""}
                    {commissionType === "fixed_per_unit" ? ` (${fmtMoney(commissionRate, form.sell_currency || "USD")} × ${fmtNumber(form.quantity || 0)} ${form.unit || "MT"})` : ""}
                    {commissionType === "fixed_total" ? t("misc-fixed-suffix") : ""}
                    :
                  </span>
                  <span className="font-mono">-{fmtMoney(commissionAmount, form.sell_currency || "USD")}</span>
                </div>
                <div className="flex justify-between font-semibold border-t border-border/40 pt-1">
                  <span>{t("misc-net-profit-colon")}</span>
                  <span className={`font-mono ${netProfit >= 0 ? "text-chart-1" : "text-destructive"}`}>
                    {fmtMoney(netProfit, form.sell_currency || "USD")}
                  </span>
                </div>
                <div className="flex justify-between text-muted-foreground text-xs">
                  <span>{t("misc-net-margin-colon")}</span>
                  <span>{netMarginPct.toFixed(1)}%</span>
                </div>

                {/* ±10% variance row */}
                <div className="grid grid-cols-3 gap-1.5 pt-1.5 mt-1 border-t border-border/40">
                  <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-1.5 text-center">
                    <div className="text-xs text-muted-foreground">{t("misc-best-case-minus-10")}</div>
                    <div className={`font-mono font-semibold text-xs ${bestCaseProfit >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {fmtMoney(bestCaseProfit, form.sell_currency || "USD")}
                    </div>
                  </div>
                  <div className="rounded border border-blue-500/30 bg-blue-500/5 p-1.5 text-center">
                    <div className="text-xs text-muted-foreground">{t("misc-expected")}</div>
                    <div className={`font-mono font-semibold text-xs ${netProfit >= 0 ? "text-chart-1" : "text-destructive"}`}>
                      {fmtMoney(netProfit, form.sell_currency || "USD")}
                    </div>
                  </div>
                  <div className="rounded border border-orange-500/30 bg-orange-500/5 p-1.5 text-center">
                    <div className="text-xs text-muted-foreground">{t("misc-worst-case-plus-10")}</div>
                    <div className={`font-mono font-semibold text-xs ${worstCaseProfit >= 0 ? "text-orange-600" : "text-red-600"}`}>
                      {fmtMoney(worstCaseProfit, form.sell_currency || "USD")}
                    </div>
                  </div>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Gauge className="size-2.5" /> {t("misc-variance-spread-label")}</span>
                  <span className="font-mono">±{fmtMoney(varianceSpread / 2, form.sell_currency || "USD")}</span>
                </div>
              </div>
            </div>
          </div>

          </div>
          </div>

          {/* RIGHT: Live Cost Breakdown Panel (sticky) */}
          <div className="lg:col-span-1">
            <CostBreakdownPanel
              quantity={form.quantity || 0}
              unit={form.unit || "MT"}
              buyPricePerUnit={form.buy_price_per_unit || 0}
              buyCurrency={form.buy_currency || "USD"}
              buyTotal={preview.buyTotal}
              sellPricePerUnit={form.sell_price_per_unit || 0}
              sellCurrency={form.sell_currency || "USD"}
              sellTotal={preview.sellTotal}
              exchangeRate={form.exchange_rate || 1}
              currenciesDiffer={
                !!form.buy_currency &&
                !!form.sell_currency &&
                form.buy_currency !== form.sell_currency
              }
              buyTotalInSellCurrency={preview.buyTotalInSellCurrency}
              costLines={preview.computedLines}
              totalCosts={preview.totalCosts}
              totalCostsInSellCurrency={preview.totalCostsInSellCurrency}
              landedCost={preview.landedCost}
              landedCostInSellCurrency={preview.landedCostInSellCurrency}
              bankCosts={bankCosts}
              totalBankCosts={totalBankCosts}
              transferFees={transferFees}
              totalTransferFees={totalTransferFees}
              documentationCosts={documentationCosts}
              totalDocumentationCosts={totalDocCosts}
              commissionType={commissionType}
              commissionRate={commissionRate}
              commissionAmount={commissionAmount}
              profitBeforeCommission={profitBeforeCommission}
              grossProfit={preview.margin}
              grossMarginPct={preview.marginPct}
              netProfit={netProfit}
              netMarginPct={netMarginPct}
              landedCostPerUnit={preview.landedCostPerUnit}
              profitPerUnit={profitPerUnit}
              bestCaseProfit={bestCaseProfit}
              worstCaseProfit={worstCaseProfit}
            />
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("misc-saving-toast") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Bank cost rate overrides dialog */}
      <Dialog open={showBankOverrides} onOpenChange={setShowBankOverrides}>
        <DialogContent className="w-[95vw] max-w-3xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle className="flex items-center gap-2">
              <Landmark className="size-4" /> {t("misc-edit-bank-cost-rates")}
            </DialogTitle>
            <DialogDescription>
              {t("misc-edit-bank-cost-rates-desc").replace("${currency}", form.sell_currency || "USD")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            {applicableBankCostItems.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-4 text-center">
                {t("misc-select-payment-method-first")}
              </p>
            ) : (
              <div className="space-y-3">
                {applicableBankCostItems.map((item) => {
                  const current = bankCostOverrides[item.id] ?? item.defaultValue;
                  const isOverridden = bankCostOverrides[item.id] !== undefined;
                  return (
                    <div key={item.id} className="grid grid-cols-12 gap-3 items-start">
                      <div className="col-span-7">
                        <Label className="text-xs font-medium">{item.label}</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                        <Badge variant="outline" className="text-xs mt-1 h-4 px-1.5 font-mono">
                          basis: {item.basis}
                        </Badge>
                      </div>
                      <div className="col-span-5 flex items-center gap-2">
                        <Input
                          type="number"
                          step="0.001"
                          min={0}
                          value={current}
                          onChange={(e) => applyBankCostOverrides(item.id, Number(e.target.value))}
                          className="h-9 text-xs tabular"
                        />
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {item.basis === "percent" || item.basis === "per_period" ? "%" : form.sell_currency || "USD"}
                        </span>
                        {isOverridden && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-9 px-2 text-xs"
                            onClick={() => {
                              const next = { ...bankCostOverrides };
                              delete next[item.id];
                              setBankCostOverrides(next);
                            }}
                          >
                            {t("reset")}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4 gap-2">
            <Button variant="outline" onClick={resetBankCostOverrides}>
              {t("misc-reset-all-defaults")}
            </Button>
            <Button onClick={() => setShowBankOverrides(false)}>{t("misc-done-label")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function PreviewCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular ${accent || ""}`}>{value}</p>
    </div>
  );
}
