"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useNewShortcut } from "@/lib/hooks/use-new-shortcut";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PortAutocomplete } from "@/components/ui/port-autocomplete";
import { TradeAdvisor } from "@/components/common/trade-advisor";
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
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Plus, Search, FileText, Pencil, Trash2, Eye, ChevronDown, ChevronRight, X, Calendar, Send, CheckCircle2, XCircle, Clock, Download, Loader2, Sparkles, Building2, Receipt, FileSpreadsheet, ArrowRight, ArrowLeftRight, Info, Landmark, MapPin, Hash, Globe, CreditCard, Handshake, Package, Ship, Container, Banknote, FileCheck, Timer, History, GitBranch, Save, Truck, Ban, FileDown,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { fmtMoney, fmtDate, fmtDateTime, fmtNumber } from "@/lib/utils/format";
import { Offer, OfferLineItem, OfferStatus, Partner, Product, Deal, DocumentRevision, SupplierOffer, Tenant } from "@/lib/supabase/types";
import { CURRENCIES, OFFER_STATUSES, PAYMENT_TERMS_LOCAL, INCOTERM_CODES } from "@/lib/data/reference";
import { UnitSelect } from "@/components/common/unit-select";
import { convertUnitPrice, describeConversion } from "@/lib/utils/unit-conversion";
import { CountrySelect } from "@/components/common/country-select";
import { OfferTextBuilder } from "@/components/common/offer-text-builder";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { ProductPicker } from "@/components/common/product-picker";
import { PartnerPicker } from "@/components/common/partner-picker";
import { cn } from "@/lib/utils";
import { useEffectiveTenantId, useAppStore } from "@/lib/store/app-store";
import { checkOfferCompleteness } from "@/lib/utils/completeness-checker";
import { CompletenessChecker } from "@/components/common/completeness-checker";
import { downloadPdf } from "@/lib/utils/download";
import { usePageSize } from "@/lib/hooks/use-page-size";
import { PageSizeSelector } from "@/components/common/page-size-selector";
import { BulkActionBar, useRowSelection } from "@/components/common/bulk-action-bar";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/lib/i18n/store";

const STATUS_LABEL_KEYS: Record<OfferStatus, string> = {
  draft: "crm-draft-status",
  sent: "crm-sent-status",
  accepted: "crm-accepted",
  rejected: "crm-rejected",
  expired: "crm-expired",
  countered: "marketplace-response-status-countered",
};

function StatusBadge({ status }: { status: OfferStatus }) {
  const t = useT();
  if (status === "draft") return <Badge variant="secondary">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "rejected") return <Badge className="border-transparent bg-rose-600 text-white">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "accepted") return <Badge className="border-transparent bg-emerald-600 text-white">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "sent") return <Badge className="border-transparent bg-primary text-primary-foreground">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  if (status === "countered") return <Badge className="border-transparent bg-amber-500 text-white">{t(STATUS_LABEL_KEYS[status])}</Badge>;
  return <Badge className="border-transparent bg-muted text-muted-foreground">{t(STATUS_LABEL_KEYS[status])}</Badge>;
}

function lineTotal(it: OfferLineItem): number {
  const line = (Number(it.quantity) || 0) * (Number(it.unit_price) || 0);
  const disc = line * (Number(it.discount) || 0) / 100;
  const net = line - disc;
  const tax = net * (Number(it.tax_rate) || 0) / 100;
  return net + tax;
}

/**
 * Orange highlight class applied to form inputs whose value couldn't be
 * auto-filled from the trade calculation. Used together with the
 * `MissingFieldWrap` tooltip wrapper so the user gets both a visual cue and
 * an explanatory tooltip when hovering the field.
 */
const MISSING_FIELD_CLS = "border-orange-400 bg-orange-50 dark:bg-orange-950/20 focus-visible:ring-orange-300";

/**
 * Wraps a form field in a hover-tooltip that explains why the input is
 * highlighted in orange. Only renders the tooltip wrapper when `missing`
 * is true — when the field WAS auto-filled (or we're not in trade-calc
 * preview mode at all), the wrapper is a no-op fragment so existing
 * layout / behavior is unchanged.
 *
 * Used by the Trade Calculator → offer preview flow (Fix 1).
 */
function MissingFieldWrap({
  missing,
  children,
  tooltip,
}: {
  missing: boolean;
  children: ReactNode;
  tooltip?: string;
}) {
  const t = useT();
  if (!missing) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-full">{children}</div>
      </TooltipTrigger>
      <TooltipContent>
        {tooltip || t("crm-this-field-not-filled")}
      </TooltipContent>
    </Tooltip>
  );
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

// ─── Bank account shape (tenant.bank_accounts JSON array) ───
// The DB column is typed as `string | null` (jsonb), but in practice it holds
// a JSON array of { bankName, currency, swiftCode, accountNumber, holder }.
// Accept both camelCase and snake_case keys so we're resilient to legacy data.
interface TenantBankAccount {
  bankName?: string;
  bank_name?: string;
  accountNumber?: string;
  account_number?: string;
  swiftCode?: string;
  swift_code?: string;
  iban?: string;
  currency?: string;
  holder?: string;
  account_holder?: string;
}

function parseTenantBankAccounts(raw: string | null | undefined): TenantBankAccount[] {
  if (!raw) return [];
  if (Array.isArray(raw as any)) return raw as unknown as TenantBankAccount[];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Format a single bank account as the multi-line string saved into the
 *  offer's `bank_details` column. The PDF renders this verbatim. */
function formatBankDetailsForOffer(acct: TenantBankAccount): string {
  const bankName = acct.bankName || acct.bank_name || "";
  const accountNumber = acct.accountNumber || acct.account_number || acct.iban || "";
  const swift = acct.swiftCode || acct.swift_code || "";
  const holder = acct.holder || acct.account_holder || "";
  const currency = acct.currency || "";
  const lines: string[] = [];
  if (bankName) lines.push(bankName);
  if (holder) lines.push(`Account holder: ${holder}`);
  if (accountNumber) lines.push(`Account: ${accountNumber}`);
  if (swift) lines.push(`SWIFT: ${swift}`);
  if (currency) lines.push(`Currency: ${currency}`);
  return lines.join("\n");
}

// ─── Convert a numeric amount to English words (e.g. 171000 → "One Hundred
//     Seventy-One Thousand US Dollars"). Mirrors the PDF generator's
//     amountInWords helper so the offer form's "Amount in Words" line matches
//     exactly what will print on the PDF. Handles up to billions + cents.
function amountInWords(amount: number, currency = "USD"): string {
  const currName =
    currency === "USD" ? "US Dollars"
    : currency === "EUR" ? "Euros"
    : currency === "GBP" ? "Pounds Sterling"
    : currency === "CHF" ? "Swiss Francs"
    : currency === "AED" ? "UAE Dirhams"
    : currency === "CNY" ? "Chinese Yuan"
    : currency === "INR" ? "Indian Rupees"
    : currency === "RUB" ? "Russian Rubles"
    : currency === "JPY" ? "Japanese Yen"
    : currency === "SAR" ? "Saudi Riyals"
    : currency === "BRL" ? "Brazilian Real"
    : currency === "ZAR" ? "South African Rand"
    : currency === "TRY" ? "Turkish Lira"
    : currency === "SGD" ? "Singapore Dollars"
    : currency === "HKD" ? "Hong Kong Dollars"
    : currency;

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const teens = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function threeDigitsToWords(n: number): string {
    if (n === 0) return "";
    let str = "";
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    if (hundred > 0) str += ones[hundred] + " Hundred";
    if (remainder > 0) {
      if (str) str += " ";
      if (remainder < 10) str += ones[remainder];
      else if (remainder < 20) str += teens[remainder - 10];
      else {
        const t = Math.floor(remainder / 10);
        const o = remainder % 10;
        str += tens[t];
        if (o > 0) str += "-" + ones[o];
      }
    }
    return str;
  }

  if (!isFinite(amount)) return `Zero ${currName} Only`;
  const negative = amount < 0;
  const absAmount = Math.abs(amount);
  const whole = Math.floor(absAmount);
  const cents = Math.round((absAmount - whole) * 100);

  let words: string;
  if (whole === 0) {
    words = "Zero";
  } else {
    const billions = Math.floor(whole / 1000000000);
    const millions = Math.floor((whole % 1000000000) / 1000000);
    const thousands = Math.floor((whole % 1000000) / 1000);
    const remainder = whole % 1000;
    const parts: string[] = [];
    if (billions > 0) parts.push(threeDigitsToWords(billions) + " Billion");
    if (millions > 0) parts.push(threeDigitsToWords(millions) + " Million");
    if (thousands > 0) parts.push(threeDigitsToWords(thousands) + " Thousand");
    if (remainder > 0) parts.push(threeDigitsToWords(remainder));
    words = parts.join(" ");
  }

  let result = words + " " + currName;
  if (cents > 0) {
    const c = cents < 10 ? "0" + cents : String(cents);
    result += ` and ${c}/100`;
  }
  result += " Only";
  return negative ? `Minus ${result}` : result;
}

// ─── Partner context type ───
interface PartnerContext {
  partner: Partner;
  deals: Deal[];
  offers: Offer[];
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
  product: Product;
  catalogEntry: any;
  supplierOffers: SupplierOffer[];
  tradeCalculations: any[];
  inventoryStatus: { stock: number; reorder_level: number; low_stock: boolean; unit: string } | null;
  priceHistory: Array<{ date: string; source: string; source_number: string; unit_price: number; currency: string; quantity: number }>;
  /** Latest active supplier offer (sorted by created_at desc). Used by the
   *  form to auto-fill the unit price + trade fields and shown in the UI as
   *  the supplier-price indicator below the unit_price input. */
  latestSupplierOffer?: SupplierOffer | null;
}

// ─── Helper: 30 days from today ───
function thirtyDaysFromNow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString();
}

// ─── Helper: normalize specifications (array | record | null) → array ───
function normalizeSpecs(
  specs: OfferLineItem["specifications"] | Product["coa_params"]
): Array<{ name: string; value: string }> {
  if (!specs) return [];
  if (Array.isArray(specs)) {
    return specs.slice(0, 5).map((s: any) => ({
      name: String(s?.name ?? ""),
      value: String(s?.value ?? ""),
    }));
  }
  if (typeof specs === "object") {
    return Object.entries(specs).slice(0, 5).map(([name, value]) => ({
      name,
      value: String(value ?? ""),
    }));
  }
  return [];
}

// ─── Product context preview card ───
// Shown beneath each line-item's ProductPicker once the product-context API
// has returned. Surfaces the data the user used to have to dig for manually:
// supplier offer price, key specs, stock status, last prices from history.
function ProductContextPreview({
  ctx,
  lineItem,
  partners,
  currency,
}: {
  ctx: ProductContext;
  lineItem: OfferLineItem;
  partners: Partner[];
  currency: string;
}) {
  const t = useT();
  const product = ctx.product;
  const inv = ctx.inventoryStatus;

  // Supplier offers come back from /api/automation/product-context sorted by
  // created_at desc (see prisma-store.listSupplierOffers). Prefer the most
  // recent active one as the price source.
  const supplierOffers: any[] = ctx.supplierOffers || [];
  const latestOffer = supplierOffers.find((so) => so.status === "active") || supplierOffers[0] || null;
  const supplierName = latestOffer
    ? partners.find((p) => p.id === latestOffer.supplier_id)?.name
    : null;

  const priceHistory = (ctx.priceHistory || []).slice(0, 3);

  const specsArr = normalizeSpecs(
    (lineItem as OfferLineItem).specifications || product?.coa_params || null
  );

  const image =
    (lineItem as any).image_url ||
    product?.image_url ||
    (ctx.catalogEntry?.images?.[0] as string | undefined) ||
    null;

  return (
    <div className="rounded-md border border-blue-500/20 bg-blue-50/40 dark:bg-blue-950/10 p-2 space-y-1.5 text-xs">
      {/* Row 1: image thumbnail + trade metadata pills */}
      <div className="flex items-start gap-2 flex-wrap">
        {image && (
          <img
            src={image}
            alt={lineItem.product_name || product?.name || "product"}
            className="size-10 rounded object-cover border shrink-0"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          {lineItem.hs_code && (
            <span className="font-mono px-1.5 py-0.5 rounded bg-muted text-foreground">
              HS {lineItem.hs_code}
            </span>
          )}
          {lineItem.brand && (
            <span className="text-muted-foreground">· {lineItem.brand}</span>
          )}
          {inv && (
            <span
              className={cn(
                "flex items-center gap-0.5",
                inv.low_stock
                  ? "text-amber-600 dark:text-amber-500"
                  : "text-emerald-600 dark:text-emerald-500"
              )}
            >
              <Package className="size-2.5" />
              Stock: {fmtNumber(inv.stock)} {inv.unit}
              {inv.low_stock && " (low)"}
            </span>
          )}
          {lineItem.origin_country && (
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <Globe className="size-2.5" />
              Origin: {lineItem.origin_country}
            </span>
          )}
        </div>
      </div>

      {/* Row 2: latest supplier offer price (the smart auto-fill source) */}
      {latestOffer && (
        <div className="flex items-center gap-1.5 flex-wrap text-amber-700 dark:text-amber-400">
          <Banknote className="size-3 shrink-0" />
          <span className="font-medium">
            Supplier: {fmtMoney(latestOffer.unit_price, latestOffer.currency || currency)}
          </span>
          <span className="text-muted-foreground">/{product?.unit || lineItem.unit}</span>
          {latestOffer.offer_number && (
            <span className="font-mono text-muted-foreground">({latestOffer.offer_number})</span>
          )}
          {supplierName && (
            <span className="text-muted-foreground">· {supplierName}</span>
          )}
          {latestOffer.incoterm && (
            <span className="text-muted-foreground">· {latestOffer.incoterm}</span>
          )}
          {latestOffer.packaging && (
            <span className="text-muted-foreground">· {latestOffer.packaging}</span>
          )}
          {latestOffer.origin_country && !lineItem.origin_country && (
            <span className="text-muted-foreground">· Origin: {latestOffer.origin_country}</span>
          )}
        </div>
      )}

      {/* Row 3: key specifications */}
      {specsArr.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
          <Info className="size-2.5 shrink-0" />
          {specsArr.map((s, i) => (
            <span key={i} className="px-1 py-0 rounded bg-muted/60">
              {s.name}: <span className="font-medium text-foreground">{s.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Row 4: price history (last 3 entries) */}
      {priceHistory.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
          <History className="size-2.5 shrink-0" />
          <span>{t("common-label-last-prices")}</span>
          {priceHistory.map((h, i) => (
            <span key={i} className="font-mono">
              {fmtMoney(h.unit_price, h.currency)}
              <span className="text-muted-foreground/70 ml-0.5">
                ×{fmtNumber(h.quantity)}
              </span>
              {i < priceHistory.length - 1 && (
                <span className="text-muted-foreground/50 mx-0.5">·</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function OffersView() {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const pendingOfferData = useAppStore((s) => s.pendingOfferData);
  const setPendingOfferData = useAppStore((s) => s.setPendingOfferData);

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [partnerFilter, setPartnerFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Offer | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showDealPicker, setShowDealPicker] = useState(false);
  const [page, setPage] = useState(0);
  const { pageSize: PAGE_SIZE, setPageSize, options: pageSizeOptions } = usePageSize("offers", 20);
// eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(0); }, [PAGE_SIZE]);
  // Pre-filled offer payload handed off from the Trade Calculator view's
  // "Create Offer from Calculation" button (Fix 1). Set on mount when the
  // app store carries pending data; cleared immediately so a refresh on
  // the offers view doesn't re-open a stale draft.
  const [prefilledOffer, setPrefilledOffer] = useState<Record<string, any> | null>(null);
  const [missingFields, setMissingFields] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (pendingOfferData) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setPrefilledOffer(pendingOfferData.offer);
      setMissingFields(new Set(pendingOfferData.missingFields || []));
      setEditing(null);
      setShowForm(true);
      setPendingOfferData(null);
    }
    // We only want this to fire once when the view mounts with pending data
    // — `pendingOfferData` is cleared synchronously above so subsequent
    // renders won't re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["offers", tenantKey, debouncedSearch, statusFilter, partnerFilter, page, PAGE_SIZE],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (partnerFilter !== "all") params.set("partner_id", partnerFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const r = await fetch(api(`/api/offers?${params}`));
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json() as Promise<{ items: Offer[]; total: number }>;
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
    queryKey: ["offer", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/offers/${detailId}`));
      if (!r.ok) throw new Error("Failed to load offer");
      return r.json() as Promise<Offer>;
    },
    enabled: !!detailId,
  });

  const statusMut = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: OfferStatus }) => {
      const r = await fetch(api(`/api/offers/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error("Status change failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-status-updated"));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      if (detailId) qc.invalidateQueries({ queryKey: ["offer", tenantKey, detailId] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: () => toast.error(t("crm-status-change-failed")),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/offers/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("crm-offer-deleted"));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("crm-delete-failed")),
  });

  // ─── Send offer to portal ───
  const sendMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/offers/${id}/send`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to send offer");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-offer-sent-to-portal"));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      if (detailId) qc.invalidateQueries({ queryKey: ["offer", tenantKey, detailId] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: (e: any) => toast.error(e.message || "Failed to send offer."),
  });

  // ─── Create Offer from Deal ───
  const createFromDealMut = useMutation({
    mutationFn: async (deal_id: string) => {
      const r = await fetch(api("/api/automation/create-offer-from-deal"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create offer from deal");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-offer-created-from-deal-success"));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setShowDealPicker(false);
    },
    onError: (e: any) => toast.error(e.message || "Failed to create offer from deal."),
  });

  // ─── Create Invoice from Offer ───
  const createInvoiceMut = useMutation({
    mutationFn: async (offer_id: string) => {
      const r = await fetch(api("/api/automation/create-invoice-from-offer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create invoice");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-invoice-created-from-offer"));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: (e: any) => toast.error(e.message || "Failed to create invoice."),
  });

  // ─── Create Proforma from Offer ───
  const createProformaMut = useMutation({
    mutationFn: async (offer_id: string) => {
      const r = await fetch(api("/api/automation/create-proforma-from-offer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create proforma");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-proforma-created-from-offer"));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    },
    onError: (e: any) => toast.error(e.message || "Failed to create proforma."),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const partnerList = partners.data?.items || [];
  const partnerName = (id: string) => partnerList.find((p) => p.id === id)?.name || "—";
  const rowSel = useRowSelection(items);

  // Bulk send — POST /api/offers/{id}/send for each selected offer.
  const bulkSendMut = useMutation({
    mutationFn: async (ids: string[]) => {
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          const r = await fetch(api(`/api/offers/${id}/send`), { method: "POST" });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
      return { ok, fail };
    },
    onSuccess: ({ ok, fail }) => {
      if (fail === 0) toast.success(t("crm-bulk-send-success").replace("${n}", String(ok)));
      else toast.warning(t("crm-bulk-send-partial").replace("${ok}", String(ok)).replace("${fail}", String(fail)));
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      rowSel.clear();
    },
    onError: () => toast.error(t("crm-bulk-send-failed")),
  });

  // ── Server-side bulk status mutations ────────────────────────────────
  // The accept / reject / cancel / delete actions hit the new
  // POST /api/offers/bulk endpoint so the loop runs server-side (one
  // round-trip, one audit log entry, atomic-ish state transitions validated
  // by the status-validator state machine).
  const bulkStatusMut = useMutation({
    mutationFn: async ({ ids, action }: { ids: string[]; action: "accept" | "reject" | "cancel" | "delete" }) => {
      const r = await fetch(api("/api/offers/bulk"), {
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
        vars.action === "accept" ? "crm-bulk-accept-success"
        : vars.action === "reject" ? "crm-bulk-reject-success"
        : vars.action === "cancel" ? "crm-bulk-cancel-success"
        : "crm-bulk-delete-success";
      const partialKey =
        vars.action === "accept" ? "crm-bulk-accept-partial"
        : vars.action === "reject" ? "crm-bulk-reject-partial"
        : vars.action === "cancel" ? "crm-bulk-cancel-partial"
        : "crm-bulk-delete-partial";
      if (data.failureCount === 0) {
        toast.success(t(labelKey).replace("${n}", String(data.successCount)));
      } else {
        toast.warning(
          t(partialKey)
            .replace("${ok}", String(data.successCount))
            .replace("${fail}", String(data.failureCount)),
        );
      }
      qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      rowSel.clear();
    },
    onError: (e: any, vars) => {
      const labelKey =
        vars.action === "accept" ? "crm-bulk-accept-failed"
        : vars.action === "reject" ? "crm-bulk-reject-failed"
        : vars.action === "cancel" ? "crm-bulk-cancel-failed"
        : "crm-bulk-delete-failed";
      toast.error(e?.message || t(labelKey));
    },
  });

  // Bulk export selected — opens the unified /api/export endpoint with the
  // selected IDs in the query string. Server returns a CSV blob; the browser
  // handles the download via window.open (no client-side CSV marshalling).
  const bulkExportSelected = () => {
    if (rowSel.ids.length === 0) return;
    const url = `/api/export?type=offers&format=csv&ids=${encodeURIComponent(rowSel.ids.join(","))}`;
    window.open(url, "_blank");
  };

  // Bulk download — trigger PDF download for each selected offer.
  const bulkDownloadMut = useMutation({
    mutationFn: async (ids: string[]) => {
      let ok = 0;
      for (const id of ids) {
        try {
          const off = items.find((o) => o.id === id);
          await downloadPdf(api(`/api/offers/${id}/pdf`), `${off?.number || id}.pdf`);
          ok++;
        } catch { /* keep going */ }
      }
      return { ok };
    },
    onSuccess: ({ ok }) => {
      toast.success(t("crm-bulk-download-success").replace("${n}", String(ok)));
      rowSel.clear();
    },
    onError: () => toast.error(t("crm-bulk-download-failed")),
  });

  // The legacy client-side bulkDeleteMut was replaced by the server-side
  // /api/offers/bulk endpoint — see bulkStatusMut above. It runs the deletes
  // server-side, with a single audit log entry and the same status guard
  // as DELETE /api/offers/[id] (only draft/cancelled/rejected can be
  // hard-deleted).

  return (
    <div>
      <PageHeader
        title={t("offers")}
        description={t("crm-total-count").replace("${n}", String(total))}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => window.open("/api/offers/export?format=csv", "_blank")}>
              <Download className="size-4 mr-1" /> {t("crm-export-csv")}
            </Button>
            <Button variant="outline" onClick={() => setShowDealPicker(true)}>
              <Handshake className="size-4 mr-1" /> {t("crm-from-deal")}
            </Button>
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("crm-new-offer")}
            </Button>
          </div>
        }
      />
      <ModuleInfoTooltip
        title="Offers"
        description="Manage offers sent to or received from partners. Track validity, accept/reject, and convert accepted offers to invoices."
        howToUse={["Create an offer for a partner with line items", "Set validity period (valid_until date)", "Send offer via email to the partner", "Accept/reject received offers", "Accepted offers can be converted to invoices"]}
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("crm-search-by-number-subject")}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crm-all-statuses")}</SelectItem>
              <SelectItem value="draft">{t("crm-draft-status")}</SelectItem>
              <SelectItem value="sent">{t("crm-sent-status")}</SelectItem>
              <SelectItem value="accepted">{t("crm-accepted")}</SelectItem>
              <SelectItem value="rejected">{t("crm-rejected")}</SelectItem>
              <SelectItem value="expired">{t("crm-expired")}</SelectItem>
              {/* FIX-AUDIT3 #4 — admin offers filter was missing the
                  `countered` status. The status exists (set by the
                  portal-client counter-offer flow) and shows up as a
                  "Countered" badge on rows, but admins had no way to
                  filter for it. */}
              <SelectItem value="countered">{t("marketplace-response-status-countered")}</SelectItem>
            </SelectContent>
          </Select>
          <PartnerPicker
            value={partnerFilter === "all" ? "" : partnerFilter}
            allowClear
            placeholder={t("crm-partner")}
            onSelect={(p) => { setPartnerFilter(p?.id || "all"); setPage(0); }}
            className="md:w-48"
          />
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
              icon={<FileText className="size-6" />}
              title={t("crm-no-offers")}
              description={t("crm-no-offers-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("crm-new-offer")}</Button>}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          checked={rowSel.allOnPageSelected}
                          onCheckedChange={rowSel.toggleAllOnPage}
                          aria-label={t("crm-select-all-on-page-label")}
                        />
                      </TableHead>
                      <TableHead>{t("crm-number")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("crm-subject")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("crm-partner")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead className="text-right">{t("crm-total-detail")}</TableHead>
                      <TableHead className="hidden xl:table-cell">{t("crm-valid-until-label")}</TableHead>
                      <TableHead className="text-right">{t("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((o) => (
                      <TableRow
                        key={o.id}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setDetailId(o.id)}
                        data-state={rowSel.isSelected(o.id) ? "selected" : undefined}
                      >
                        <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={rowSel.isSelected(o.id)}
                            onCheckedChange={() => rowSel.toggle(o.id)}
                            aria-label={t("fin-select-offer-aria").replace("${number}", o.number)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular">{o.number}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="font-medium truncate max-w-[200px]">{o.subject || "—"}</div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">{partnerName(o.partner_id)}</TableCell>
                        <TableCell><StatusBadge status={o.status} /></TableCell>
                        <TableCell className="text-right font-mono tabular">{fmtMoney(o.total, o.currency)}</TableCell>
                        <TableCell className="hidden xl:table-cell">{fmtDate(o.valid_until)}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(o.id)} title={t("view")} aria-label={t("view")}>
                              <Eye className="size-4" aria-hidden="true" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(o); setShowForm(true); }} title={t("edit")} aria-label={t("edit")}>
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(o.id)} title={t("delete")} aria-label={t("delete")}>
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination + Page size */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-border/60 gap-3 flex-wrap">
                <p className="text-sm text-muted-foreground">
                  {total > 0
                    ? <>{t("crm-showing-range").replace("${from}", String(page * PAGE_SIZE + 1)).replace("${to}", String(Math.min((page + 1) * PAGE_SIZE, total))).replace("${total}", String(total))}</>
                    : <>{t("crm-no-results")}</>}
                </p>
                <div className="flex items-center gap-3">
                  <PageSizeSelector value={PAGE_SIZE} onChange={setPageSize} options={pageSizeOptions} />
                  {totalPages > 1 && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
                        {t("crm-previous")}
                      </Button>
                      <span className="text-sm px-2 tabular-nums">{page + 1} / {totalPages}</span>
                      <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                        {t("crm-next")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Form dialog */}
      <OfferFormDialog
        open={showForm}
        onOpenChange={(o) => {
          setShowForm(o);
          // When the form closes (cancelled or saved), drop any pre-fill
          // state so the next "New offer" click starts fresh.
          if (!o) {
            setPrefilledOffer(null);
            setMissingFields(null);
          }
        }}
        offer={editing}
        prefilledOffer={prefilledOffer}
        missingFields={missingFields}
        partners={partnerList}
        onSaved={(offerNumber) => {
          setShowForm(false);
          setPrefilledOffer(null);
          setMissingFields(null);
          qc.invalidateQueries({ queryKey: ["offers", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="size-5" />
              <span className="font-mono text-base">{detail.data?.number || t("crm-offer")}</span>
            </SheetTitle>
            <SheetDescription>{detail.data?.subject || t("crm-offer-details")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <OfferDetail
              offer={detail.data}
              partnerName={partnerName(detail.data.partner_id)}
              onStatusChange={(status) => detailId && statusMut.mutate({ id: detailId, status })}
              onSend={() => detailId && sendMut.mutate(detailId)}
              isSending={sendMut.isPending}
              onCreateInvoice={() => detailId && createInvoiceMut.mutate(detailId)}
              onCreateProforma={() => detailId && createProformaMut.mutate(detailId)}
              isCreatingInvoice={createInvoiceMut.isPending}
              isCreatingProforma={createProformaMut.isPending}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("crm-delete-offer-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("crm-delete-offer-desc")}
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

      {/* Create Offer from Deal dialog */}
      <DealPickerDialog
        open={showDealPicker}
        onOpenChange={setShowDealPicker}
        onSelect={(dealId) => createFromDealMut.mutate(dealId)}
        isCreating={createFromDealMut.isPending}
      />

      <BulkActionBar
        count={rowSel.count}
        onClear={rowSel.clear}
        label={rowSel.count === 1 ? t("crm-offer-selected") : t("crm-offers-selected")}
        actions={[
          {
            key: "send",
            label: t("crm-send-all"),
            icon: <Send className="size-4" />,
            variant: "default",
            disabled: bulkSendMut.isPending,
            confirm: t("fin-bulk-send-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkSendMut.mutate(rowSel.ids),
          },
          {
            key: "accept",
            label: t("crm-bulk-accept-label"),
            icon: <CheckCircle2 className="size-4" />,
            variant: "outline",
            disabled: bulkStatusMut.isPending,
            confirm: t("crm-bulk-accept-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkStatusMut.mutate({ ids: rowSel.ids, action: "accept" }),
          },
          {
            key: "reject",
            label: t("crm-bulk-reject-label"),
            icon: <XCircle className="size-4" />,
            variant: "outline",
            disabled: bulkStatusMut.isPending,
            confirm: t("crm-bulk-reject-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkStatusMut.mutate({ ids: rowSel.ids, action: "reject" }),
          },
          {
            key: "cancel",
            label: t("crm-bulk-cancel-label"),
            icon: <Ban className="size-4" />,
            variant: "outline",
            disabled: bulkStatusMut.isPending,
            confirm: t("crm-bulk-cancel-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkStatusMut.mutate({ ids: rowSel.ids, action: "cancel" }),
          },
          {
            key: "export-selected",
            label: t("crm-bulk-export-selected"),
            icon: <FileDown className="size-4" />,
            variant: "outline",
            disabled: rowSel.count === 0,
            onClick: bulkExportSelected,
          },
          {
            key: "download",
            label: t("crm-download-pdfs"),
            icon: <Download className="size-4" />,
            variant: "outline",
            disabled: bulkDownloadMut.isPending,
            onClick: () => bulkDownloadMut.mutate(rowSel.ids),
          },
          {
            key: "delete",
            label: t("delete"),
            icon: <Trash2 className="size-4" />,
            variant: "destructive",
            disabled: bulkStatusMut.isPending,
            confirm: t("fin-bulk-delete-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkStatusMut.mutate({ ids: rowSel.ids, action: "delete" }),
          },
        ]}
      />
    </div>
  );
}

// ─── Deal Picker Dialog ───
function DealPickerDialog({
  open, onOpenChange, onSelect, isCreating,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSelect: (dealId: string) => void;
  isCreating: boolean;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [dealSearch, setDealSearch] = useState("");

  const deals = useQuery({
    queryKey: ["deals", tenantKey, "list", "100"],
    queryFn: async () => {
      const r = await fetch(api(`/api/deals?limit=100`));
      if (!r.ok) throw new Error("Failed to load deals");
      return r.json() as Promise<{ items: Deal[]; total: number }>;
    },
    enabled: open,
  });

  const dealList = deals.data?.items || [];
  const filtered = dealSearch
    ? dealList.filter((d) =>
        d.title.toLowerCase().includes(dealSearch.toLowerCase()) ||
        d.stage.toLowerCase().includes(dealSearch.toLowerCase())
      )
    : dealList;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-amber-500" />
            {t("crm-create-offer-from-deal-dialog")}
          </DialogTitle>
          <DialogDescription>{t("crm-create-offer-from-deal-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("crm-search-deals")}
              value={dealSearch}
              onChange={(e) => setDealSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          {deals.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t("crm-no-deals-found")}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto custom-scroll space-y-2">
              {filtered.map((d) => (
                <button
                  key={d.id}
                  className="w-full text-left rounded-lg border border-border/60 p-3 hover:bg-muted/50 transition-colors flex items-center gap-3"
                  onClick={() => onSelect(d.id)}
                  disabled={isCreating}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{d.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">{d.stage}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtMoney(d.value, d.currency)}</span>
                    </div>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>{t("cancel")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Detail panel ───
function OfferDetail({
  offer, partnerName, onStatusChange, onSend, isSending, onCreateInvoice, onCreateProforma, isCreatingInvoice, isCreatingProforma,
}: {
  offer: Offer;
  partnerName: string;
  onStatusChange: (s: OfferStatus) => void;
  onSend: () => void;
  isSending: boolean;
  onCreateInvoice: () => void;
  onCreateProforma: () => void;
  isCreatingInvoice: boolean;
  isCreatingProforma: boolean;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const statuses: OfferStatus[] = ["draft", "sent", "accepted", "rejected", "expired"];
  const totals = computeTotals(offer.items || []);

  // ─── Version / Revision tracking ───
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [savingVersion, setSavingVersion] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const revisions = useQuery({
    queryKey: ["document-revisions", tenantKey, offer.id],
    queryFn: async () => {
      try {
        // /api/document-register/[id] expects the register-entry id, not the
        // offer id, so we list-and-filter by reference_id instead.
        const r = await fetch(api(`/api/document-register?type=offer`));
        if (!r.ok) return [];
        const data = await r.json();
        return ((data.items || []) as any[])
          .filter((e) => e.reference_id === offer.id && e.type === "offer")
          .sort((a, b) => (b.version || 0) - (a.version || 0)) as DocumentRevision[];
      } catch {
        return [];
      }
    },
    enabled: !!offer.id,
  });

  const revisionList = revisions.data || [];

  // ─── Auto-saved revisions (written by recordRevision on every PUT) ───
  const autoRevisions = useQuery({
    queryKey: ["document-revisions-auto", tenantKey, offer.id],
    queryFn: async () => {
      try {
        const r = await fetch(api(`/api/document-revisions/${offer.id}`));
        if (!r.ok) return [];
        const data = await r.json();
        return ((data.items || []) as any[]).sort(
          (a, b) => (b.version || 0) - (a.version || 0),
        );
      } catch {
        return [];
      }
    },
    enabled: !!offer.id,
  });
  const autoRevisionList = autoRevisions.data || [];

  async function handleSaveVersion() {
    if (!changeNote.trim()) {
      toast.error(t("crm-change-note-required"));
      return;
    }
    setSavingVersion(true);
    try {
      // 1. Find existing register entries for THIS offer only.
      // /api/document-register ignores reference_id/type params and returns
      // every entry in the tenant — filter client-side so we don't touch
      // unrelated documents.
      const regRes = await fetch(api(`/api/document-register?type=offer`));
      const regData = await regRes.json().catch(() => ({ items: [] }));
      const existingEntries = (regData.items || []).filter(
        (e: any) => e.reference_id === offer.id && e.type === "offer",
      );
      const maxVersion = existingEntries.reduce((max: number, e: any) => Math.max(max, e.version || 0), 0);
      const nextVersion = maxVersion + 1;

      // 2. Mark previous entries as superseded — scoped strictly to this offer.
      for (const entry of existingEntries) {
        if (entry.status === "current") {
          await fetch(api(`/api/document-register`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...entry, status: "superseded" }),
          });
        }
      }

      // 3. Create new document register entry
      const registerEntry = {
        number: `${offer.number || "OF"}-V${nextVersion}`,
        type: "offer",
        version: nextVersion,
        reference_id: offer.id,
        partner_id: offer.partner_id,
        title: offer.subject || t("fin-offer-title-with-number").replace("${number}", offer.number || ""),
        status: "current",
        metadata: {
          total: offer.total,
          currency: offer.currency,
          status: offer.status,
          items_count: offer.items?.length || 0,
        },
      };
      const regRes2 = await fetch(api(`/api/document-register`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registerEntry),
      });
      if (!regRes2.ok) {
        const e = await regRes2.json().catch(() => ({}));
        throw new Error(e.error || t("fin-failed-create-document-register-entry"));
      }
      const regEntry = await regRes2.json();

      // 4. Create revision record
      const revRes = await fetch(api(`/api/document-revisions`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: regEntry.id,
          version: nextVersion,
          change_note: changeNote.trim(),
        }),
      });
      if (!revRes.ok) {
        const e = await revRes.json().catch(() => ({}));
        throw new Error(e.error || t("fin-failed-create-revision"));
      }

      toast.success(t("crm-version-saved"), { description: t("crm-version-saved-desc").replace("${n}", String(nextVersion)) });
      setChangeNote("");
      setShowVersionDialog(false);
      qc.invalidateQueries({ queryKey: ["document-revisions", tenantKey, offer.id] });
      qc.invalidateQueries({ queryKey: ["document-revisions-auto", tenantKey, offer.id] });
    } catch (e: any) {
      toast.error(e.message || t("crm-failed-save-version"));
    } finally {
      setSavingVersion(false);
    }
  }

  // Check if any trade fields have data
  const hasTradeData = !!(offer.offer_no || offer.bank_details || offer.pol || offer.pod || offer.vessel || offer.container_no || offer.lead_time || offer.packaging || offer.payment_terms || offer.tax_clause || offer.incoterm || offer.selling_price);

  return (
    <div className="px-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={offer.status} />
          <span className="text-sm text-muted-foreground">{partnerName}</span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("crm-change-status")} <ChevronDown className="size-4 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{t("crm-move-to")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {statuses.map((s) => (
              <DropdownMenuItem
                key={s}
                disabled={s === offer.status}
                onClick={() => onStatusChange(s)}
              >
                {t(STATUS_LABEL_KEYS[s])}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="default"
              size="sm"
              onClick={onSend}
              disabled={isSending || offer.status !== "draft"}
            >
              {isSending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Send className="size-4 mr-1" />}
              {t("send")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {offer.status !== "draft" ? t("crm-only-draft-can-be-sent") : t("crm-send-offer-tooltip")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowVersionDialog(true)}
            >
              <Save className="size-4 mr-1" /> {t("crm-save-version")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("crm-save-version-tooltip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateInvoice}
              disabled={isCreatingInvoice || (offer.status !== "accepted" && offer.status !== "sent")}
            >
              {isCreatingInvoice ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Receipt className="size-4 mr-1" />}
              {t("crm-create-invoice")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {offer.status !== "accepted" && offer.status !== "sent" ? t("crm-must-be-accepted-or-sent") : t("crm-auto-create-invoice-tooltip")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateProforma}
              disabled={isCreatingProforma}
            >
              {isCreatingProforma ? <Loader2 className="size-4 mr-1 animate-spin" /> : <FileSpreadsheet className="size-4 mr-1" />}
              {t("crm-create-proforma")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("crm-auto-create-proforma-tooltip")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Key dates */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Calendar className="size-3" /> {t("crm-valid-until-detail")}</p>
          <p className="text-sm font-medium">{fmtDate(offer.valid_until)}</p>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Send className="size-3" /> {t("crm-sent-detail")}</p>
          <p className="text-sm font-medium">{fmtDateTime(offer.sent_at)}</p>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><CheckCircle2 className="size-3" /> {t("crm-responded")}</p>
          <p className="text-sm font-medium">{fmtDateTime(offer.responded_at)}</p>
        </div>
        <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="size-3" /> {t("crm-created-label")}</p>
          <p className="text-sm font-medium">{fmtDate(offer.created_at)}</p>
        </div>
      </div>

      {/* Trade / Import Details */}
      {hasTradeData && (
        <div className="mb-4">
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <Ship className="size-4" /> {t("crm-trade-details")}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {offer.offer_no && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Hash className="size-3" /> {t("crm-supplier-ref")}</p>
                <p className="text-sm font-medium">{offer.offer_no}</p>
              </div>
            )}
            {offer.incoterm && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Globe className="size-3" /> {t("crm-incoterm-detail")}</p>
                <p className="text-sm font-medium">{offer.incoterm}</p>
              </div>
            )}
            {offer.payment_terms && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><CreditCard className="size-3" /> {t("crm-payment-terms-detail")}</p>
                <p className="text-sm font-medium">{offer.payment_terms}</p>
              </div>
            )}
            {offer.pol && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="size-3" /> {t("crm-port-of-loading")}</p>
                <p className="text-sm font-medium">{offer.pol}</p>
              </div>
            )}
            {offer.pod && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="size-3" /> {t("crm-port-of-discharge")}</p>
                <p className="text-sm font-medium">{offer.pod}</p>
              </div>
            )}
            {offer.vessel && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Ship className="size-3" /> {t("crm-vessel")}</p>
                <p className="text-sm font-medium">{offer.vessel}</p>
              </div>
            )}
            {offer.container_no && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Container className="size-3" /> {t("crm-container-no")}</p>
                <p className="text-sm font-medium">{offer.container_no}</p>
              </div>
            )}
            {offer.lead_time && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Timer className="size-3" /> {t("crm-lead-time-detail")}</p>
                <p className="text-sm font-medium">{offer.lead_time}</p>
              </div>
            )}
            {offer.packaging && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Package className="size-3" /> {t("crm-packaging-detail")}</p>
                <p className="text-sm font-medium">{offer.packaging}</p>
              </div>
            )}
            {offer.bank_details && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Banknote className="size-3" /> {t("crm-bank-details")}</p>
                <p className="text-sm font-medium whitespace-pre-wrap">{offer.bank_details}</p>
              </div>
            )}
            {offer.tax_clause && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><FileCheck className="size-3" /> {t("crm-tax-clause")}</p>
                <p className="text-sm font-medium">{offer.tax_clause}</p>
              </div>
            )}
            {offer.selling_price != null && (
              <div className="p-3 rounded-lg bg-muted/40 border border-border/60">
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Landmark className="size-3" /> {t("crm-selling-price-detail")}</p>
                <p className="text-sm font-medium">{fmtMoney(offer.selling_price, offer.currency)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Line items */}
      <div className="rounded-lg border border-border/60 overflow-hidden mb-4">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("crm-product")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("crm-sku-detail")}</TableHead>
              <TableHead className="text-right">{t("crm-quantity-detail")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("crm-unit-detail")}</TableHead>
              <TableHead className="text-right">{t("crm-unit-price-detail")}</TableHead>
              <TableHead className="text-right hidden sm:table-cell">{t("crm-discount-pct")}</TableHead>
              <TableHead className="text-right hidden sm:table-cell">{t("crm-tax-pct")}</TableHead>
              <TableHead className="text-right hidden md:table-cell">{t("crm-cost")}</TableHead>
              <TableHead className="text-right hidden md:table-cell">{t("crm-margin-detail")}</TableHead>
              <TableHead className="text-right">{t("crm-total-detail")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(offer.items || []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-6">
                  {t("crm-no-items")}
                </TableCell>
              </TableRow>
            ) : (offer.items || []).map((it, i) => {
              // FIX: normalize line item fields for legacy + new format.
              // Old format: {productId, price, invIndex} — no product_name.
              // New format: {product_id, product_name, unit_price, sku, unit}.
              const productName = (it as any).product_name || (it as any).name || (it as any).description || "";
              const productSku = (it as any).sku || "";
              const productUnit = (it as any).unit || "";
              const productUnitPrice = Number((it as any).unit_price ?? (it as any).price ?? 0);
              const productQty = Number((it as any).quantity ?? (it as any).qty ?? 0);
              const cost = Number(it.cost) || 0;
              const unitPrice = productUnitPrice;
              const marginPerUnit = unitPrice - cost;
              const marginPct = unitPrice > 0 ? (marginPerUnit / unitPrice) * 100 : 0;
              const hasCost = cost > 0;
              return (
                <TableRow key={i}>
                  <TableCell>
                    <div className="font-medium">{productName || "—"}</div>
                    <div className="text-xs text-muted-foreground sm:hidden">{productSku || "—"}</div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell font-mono text-xs tabular">{productSku || "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular">{fmtNumber(productQty)}</TableCell>
                  <TableCell className="hidden sm:table-cell">{productUnit || "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular">{fmtMoney(productUnitPrice, offer.currency)}</TableCell>
                  <TableCell className="text-right font-mono tabular hidden sm:table-cell">{it.discount}%</TableCell>
                  <TableCell className="text-right font-mono tabular hidden sm:table-cell">{it.tax_rate}%</TableCell>
                  <TableCell className="text-right font-mono tabular hidden md:table-cell">
                    {hasCost ? fmtMoney(cost, offer.currency) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular hidden md:table-cell">
                    {hasCost ? (
                      <span className={marginPct > 20 ? "text-chart-1" : marginPct > 0 ? "text-amber-600 dark:text-amber-500" : "text-destructive"}>
                        {marginPct.toFixed(0)}%
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular font-medium">{fmtMoney(lineTotal(it), offer.currency)}</TableCell>
                </TableRow>
              );
            })}
            {/* Total margin row — only when at least one line has a cost */}
            {(offer.items || []).some((it) => Number(it.cost) > 0) && (
              <TableRow className="font-semibold bg-muted/40">
                <TableCell colSpan={9} className="text-right text-xs text-muted-foreground">
                  {t("crm-total-margin")}
                </TableCell>
                <TableCell className="text-right font-mono tabular">
                  {(() => {
                    const totalRevenue = (offer.items || []).reduce((s, it) => s + lineTotal(it), 0);
                    const totalCost = (offer.items || []).reduce(
                      (s, it) => s + (Number(it.cost) || 0) * (Number(it.quantity) || 0),
                      0,
                    );
                    const totalMargin = totalRevenue - totalCost;
                    const totalMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
                    const accent = totalMargin >= 0 ? "text-chart-1" : "text-destructive";
                    return (
                      <span className={accent}>
                        {fmtMoney(totalMargin, offer.currency)} ({totalMarginPct.toFixed(1)}%)
                      </span>
                    );
                  })()}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Totals */}
      <div className="ml-auto w-full sm:w-72 space-y-1 mb-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("crm-subtotal")}</span>
          <span className="font-mono tabular">{fmtMoney(offer.subtotal ?? totals.subtotal, offer.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("crm-discount")}</span>
          <span className="font-mono tabular">- {fmtMoney(offer.discount_total ?? totals.discount_total, offer.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("crm-tax")}</span>
          <span className="font-mono tabular">{fmtMoney(offer.tax_total ?? totals.tax_total, offer.currency)}</span>
        </div>
        <div className="flex justify-between border-t pt-1 mt-1 text-base font-semibold">
          <span>{t("crm-total-detail")}</span>
          <span className="font-mono tabular">{fmtMoney(offer.total ?? totals.total, offer.currency)}</span>
        </div>
      </div>

      {offer.notes && (
        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1">{t("crm-notes-label")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/40">{offer.notes}</p>
        </div>
      )}
      {offer.terms && typeof offer.terms === "string" && (
        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1">{t("crm-terms")}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/40">{offer.terms}</p>
        </div>
      )}

      {/* Download PDF */}
      <div className="pt-3 border-t">
        <Button
          variant="outline"
          size="sm"
          disabled={downloading}
          onClick={async () => {
            try {
              setDownloading(true);
              const filename = `Offer_${offer.number || offer.id}.pdf`;
              await downloadPdf(api(`/api/offers/${offer.id}/pdf`), filename);
              toast.success(t("crm-pdf-downloaded"));
            } catch (e: any) {
              toast.error(e?.message || t("crm-failed-download-pdf"));
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Download className="size-4 mr-1" />}
          {t("crm-download-pdf")}
        </Button>
      </div>

      {/* Version History */}
      <div className="pt-4 mt-4 border-t">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <History className="size-4" /> {t("crm-version-history")}
          </h4>
          <Button variant="outline" size="sm" onClick={() => setShowVersionDialog(true)}>
            <GitBranch className="size-4 mr-1" /> {t("crm-save-new-version")}
          </Button>
        </div>

        {revisions.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : revisionList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-center">
            <GitBranch className="size-6 text-muted-foreground/40 mx-auto mb-1" />
            <p className="text-sm text-muted-foreground">{t("crm-no-versions-saved")}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t("crm-click-save-new-version")}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border/60 overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-20">{t("crm-version")}</TableHead>
                  <TableHead>{t("crm-change-note")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-32">{t("crm-author")}</TableHead>
                  <TableHead className="w-36">{t("crm-date")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {revisionList.map((rev, i) => (
                  <TableRow key={rev.id || i}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">V{rev.version}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{rev.change_note || "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">{rev.created_by || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{fmtDateTime(rev.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Auto-Saved Revisions (from recordRevision on every PUT) */}
      <div className="pt-4 mt-4 border-t">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <History className="size-4" /> {t("crm-auto-saved-revisions")}
            <Badge variant="outline" className="ml-1 font-mono text-xs">
              v{(offer as any).version || 1}
            </Badge>
          </h4>
        </div>

        {autoRevisions.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : autoRevisionList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-center">
            <History className="size-6 text-muted-foreground/40 mx-auto mb-1" />
            <p className="text-sm text-muted-foreground">{t("crm-no-auto-saved-revisions")}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("crm-auto-saved-desc")}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border/60 overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-20">{t("crm-version")}</TableHead>
                  <TableHead>{t("crm-changes")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-32">{t("crm-author")}</TableHead>
                  <TableHead className="w-36">{t("crm-date")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {autoRevisionList.map((rev: any, i: number) => {
                  const fields: any[] = Array.isArray(rev.changed_fields) ? rev.changed_fields : [];
                  return (
                    <TableRow key={rev.id || i}>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">V{rev.version}</Badge>
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
                                {(fields.length - 4) === 1 ? t("crm-more-fields").replace("${n}", String(fields.length - 4)) : t("crm-more-fields-plural").replace("${n}", String(fields.length - 4))}
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
        )}
      </div>

      {/* Save Version Dialog */}
      <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
        <DialogContent className="w-[95vw] max-w-3xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="size-5" /> {t("crm-save-new-version")}
            </DialogTitle>
            <DialogDescription>
              {t("crm-save-new-version-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label>{t("crm-change-note")} *</Label>
              <Textarea
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder={t("crm-change-note-placeholder")}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                {t("crm-change-note-desc")}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm">{t("crm-offer-summary")}</p>
              <div className="flex justify-between">
                <span>{t("crm-number")}</span>
                <span className="font-mono">{offer.number}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("status")}</span>
                <span>{offer.status}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("crm-total-detail")}</span>
                <span className="font-mono">{fmtMoney(offer.total, offer.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("crm-items-label")}</span>
                <span>{offer.items?.length || 0}</span>
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
            <Button variant="outline" onClick={() => setShowVersionDialog(false)} disabled={savingVersion}>{t("cancel")}</Button>
            <Button onClick={handleSaveVersion} disabled={savingVersion || !changeNote.trim()}>
              {savingVersion ? (
                <>
                  <Loader2 className="size-4 mr-1 animate-spin" /> {t("crm-saving-ellipsis")}
                </>
              ) : (
                <>
                  <Save className="size-4 mr-1" /> {t("crm-save-version")}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Form dialog ───
function OfferFormDialog({
  open, onOpenChange, offer, prefilledOffer, missingFields, partners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  offer: Offer | null;
  /** Pre-filled offer payload handed off from the Trade Calculator's
   *  "Create Offer from Calculation" flow (Fix 1). When present, the form
   *  initializes from this object instead of the empty defaults so the user
   *  can review the pre-filled data before saving. Cleared on close. */
  prefilledOffer?: Record<string, any> | null;
  /** Set of field keys the trade calc couldn't auto-fill. Inputs matching
   *  these keys are painted with an orange border + tooltip so the user
   *  knows to fill them in. Null when not in trade-calc preview mode. */
  missingFields?: Set<string> | null;
  partners: Partner[];
  onSaved: (offerNumber?: string) => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const isEditing = !!offer;

  const [moreDetailsOpen, setMoreDetailsOpen] = useState(false);
  // Completeness checker is collapsed by default — the score + critical count
  // is always visible in the trigger, and the user expands to drill into the
  // per-field list. Keeps the offer form compact instead of always showing a
  // tall scrollable list right below the line items.
  const [completenessOpen, setCompletenessOpen] = useState(false);
  // Form state. Extended with three non-DB-column fields used only by the UI:
  //   - `origin_country` is a real DB column on `offers` (added via migration)
  //     but is not in the Prisma schema, so we keep it loosely typed.
  //   - `inspection` and `certificate` are NOT DB columns on `offers` (they
  //     only exist on `supplier_offers`). We collect them in the form and, on
  //     save, fold them into the `terms` textarea so the data is preserved
  //     without a schema migration.
  const [form, setForm] = useState<Partial<Offer> & {
    items: OfferLineItem[];
    origin_country?: string | null;
    inspection?: string | null;
    certificate?: string | null;
  }>({ items: [] });
  const [saving, setSaving] = useState(false);
  const [partnerContext, setPartnerContext] = useState<PartnerContext | null>(null);
  const [loadingPartner, setLoadingPartner] = useState(false);
  const [productContextMap, setProductContextMap] = useState<Record<string, ProductContext>>({});
  const [loadingProductIdx, setLoadingProductIdx] = useState<number | null>(null);
  // Index (into the tenant's parsed `bank_accounts` JSON array) of the bank
  // account the user picked for this offer's payment. null = no selection —
  // the user can still type custom bank details into the textarea below.
  const [selectedBankAccountIdx, setSelectedBankAccountIdx] = useState<number | null>(null);
  // True while we wait for the user to confirm the choice in the bank account
  // dropdown (purely cosmetic — the textarea updates instantly).
  const [manualBankOverride, setManualBankOverride] = useState(false);

  // Ref mirror of `form` so callbacks that need to read the latest items
  // (e.g. handleUnitChange, selectProduct unit-conversion logic) don't have to
  // re-create on every keystroke and don't capture stale state.
  const formRef = useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);

  const deals = useQuery({
    queryKey: ["deals", tenantKey, "list", "100"],
    queryFn: async () => {
      const r = await fetch(api(`/api/deals?limit=100`));
      if (!r.ok) throw new Error("Failed to load deals");
      return r.json() as Promise<{ items: Deal[]; total: number }>;
    },
    enabled: open,
  });

  // ─── Fix: useMemo → useEffect for form initialization ───
  useEffect(() => {
    if (open) {
      if (offer) {
        // Parse the [Quality] block back out of notes so the Inspection and
        // Certificate form fields show their saved values when editing.
        const rawNotes = (offer.notes as string | null | undefined) || "";
        const qualityMatch = rawNotes.match(
          /\[Quality\]\s*Inspection:\s*([^|]+?)(?:\s*\|\s*Certificate:\s*(.+?))?\s*$/m,
        );
        const inspection = qualityMatch ? (qualityMatch[1] || "").trim() : null;
        const certificate = qualityMatch ? (qualityMatch[2] || "").trim() : null;
        const cleanNotes = rawNotes
          .replace(/\n*\[Quality\][\s\S]*$/m, "")
          .trim();

// eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({
          ...offer,
          notes: cleanNotes,
          // offer-level origin_country is a real DB column but is not on the
          // Prisma Offer type, so it round-trips through the untyped spread.
          origin_country: (offer as any).origin_country ?? null,
          inspection,
          certificate,
          items: (offer.items || []).map((i) => ({ ...i })),
        });
        setMoreDetailsOpen(true);
      } else if (prefilledOffer) {
        // ── Trade calc preview handoff (Fix 1) ────────────────────────
        // The Trade Calculator view called /api/trade-calculator/[id]/offer-preview
        // and stashed the pre-filled payload on the app store. We initialize
        // the form from it so the user can review + fix the orange-highlighted
        // missing fields before saving. The `_` prefixed fields are passed
        // through to the save() payload verbatim — POST /api/offers strips
        // them before persisting and uses them to auto-track commission
        // obligations (Fix 2).
        const p = prefilledOffer as any;
        // Always carry the pre-filled line items so the form opens with the
        // trade calc's product, qty, unit price already filled in.
        const items = Array.isArray(p.items)
          ? p.items.map((it: any) => ({ ...it }))
          : [];
        setForm({
          status: "draft",
          currency: p.currency || "USD",
          payment_terms: p.payment_terms || "net30",
          valid_until: p.valid_until || thirtyDaysFromNow(),
          notes: p.notes ?? "",
          terms: "",
          origin_country: null,
          inspection: null,
          certificate: null,
          // Spread the pre-filled payload last so partner_id, incoterm, pol,
          // pod, subject, currency, items, etc. take precedence over the
          // defaults above.
          ...p,
          // Re-map items — the spread above can re-introduce the original
          // array reference, but we want a fresh copy so edits don't mutate
          // the prefilledOffer object.
          items,
        } as any);
        setMoreDetailsOpen(true);
      } else {
        setForm({
          status: "draft",
          currency: "USD",
          payment_terms: "net30",
          valid_until: thirtyDaysFromNow(),
          notes: "",
          terms: "",
          origin_country: null,
          inspection: null,
          certificate: null,
          items: [],
        });
        setMoreDetailsOpen(false);
      }
      setPartnerContext(null);
      setProductContextMap({});
      // Reset the bank-account picker. When editing an existing offer we
      // don't try to reverse-match the saved `bank_details` text back to a
      // tenant account (it may have been edited manually) — we just leave
      // the picker empty so the user can re-select if needed.
      setSelectedBankAccountIdx(null);
      setManualBankOverride(false);
    }
  }, [open, offer, prefilledOffer]);

  /** Returns true when `field` is in the trade-calc missingFields set —
   *  used to paint the corresponding input with an orange border + tooltip
   *  so the user can see at a glance what the trade calc couldn't auto-fill. */
  const isMissingField = useCallback(
    (field: string) => !!missingFields && missingFields.has(field),
    [missingFields],
  );

  function set<K extends keyof Offer>(k: K, v: Offer[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  /** Setter for the extra form-only fields (origin_country, inspection,
   *  certificate) that are not part of the `Offer` type but live in the same
   *  form state. */
  function setExtra(k: "origin_country" | "inspection" | "certificate", v: string | null) {
    setForm((f) => ({ ...f, [k]: v }));
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
   * If the new unit is in the same physical category as the old one (e.g.
   * weight ↔ weight: kg → MT), the unit_price is auto-converted so the line
   * total stays the same. If the categories differ (e.g. kg → piece) the unit
   * is still changed but the price is left untouched and the user is warned
   * — we can't meaningfully convert a per-kg price into a per-piece price.
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
      // Can't convert (different categories) — just change unit, keep price
      setItem(idx, { unit: newUnit });
      if (currentPrice > 0) {
        toast.warning(t("fin-cannot-convert-price").replace("${oldUnit}", oldUnit).replace("${newUnit}", newUnit));
      }
    }
  }

  // ─── Partner auto-fill ───
  const fetchPartnerContext = useCallback(async (partnerId: string) => {
    if (!partnerId) {
      setPartnerContext(null);
      return;
    }
    setLoadingPartner(true);
    try {
      const r = await fetch(api(`/api/automation/partner-context?partner_id=${partnerId}`));
      if (!r.ok) throw new Error("Failed to load partner context");
      const ctx: PartnerContext = await r.json();
      setPartnerContext(ctx);

      const p = ctx.partner;
      setForm((f) => ({
        ...f,
        partner_id: partnerId,
        currency: p.preferred_currency || f.currency || "USD",
        terms: p.preferred_payment_terms || f.terms || "",
      }));

      toast.success(`${t("fin-partner-data-loaded")} ${p.name}`, { description: t("fin-currency-autofilled-desc") });
    } catch {
      toast.error(t("fin-failed-load-partner"));
      setPartnerContext(null);
    } finally {
      setLoadingPartner(false);
    }
  }, [t]);

  // ─── Product auto-fill ───
  // Called when the user picks a product from the ProductPicker. We:
  //   1. Fill the line item with the product's core fields immediately.
  //   2. Fetch /api/automation/product-context — this returns the catalog
  //      spec-sheet, supplier offers, inventory & price history in one call.
  //   3. Override with the catalog spec-sheet's richer metadata (HS code,
  //      specifications, origin) when present.
  //   4. If a recent active supplier offer exists, use its unit_price as the
  //      default (smart auto-fill — "if the product exists in our DB, suggest
  //      the latest buy price") and copy trade fields onto the offer header
  //      when the user hasn't filled them in yet.
  const selectProduct = useCallback(async (idx: number, p: Product) => {
    // 1. Immediate line-item fill from the product itself.
    //
    // Unit-conversion aware: if the user already picked a non-default unit on
    // this line (e.g. they set "MT" while the product is priced per "kg"),
    // preserve their choice and convert the product's price into that unit so
    // the form stays internally consistent. If the line still has the default
    // "pcs" unit (i.e. nothing has been chosen yet) we adopt the product's
    // native unit instead.
    const supplierUnit = p.unit || null;
    const currentLineUnit = formRef.current.items?.[idx]?.unit || null;
    const preserveLineUnit =
      currentLineUnit && currentLineUnit !== "pcs" ? currentLineUnit : null;
    const lineUnit = preserveLineUnit || supplierUnit || "pcs";

    const basePrice = Number(p.price) || 0;
    let priceToUse = basePrice;
    if (
      supplierUnit &&
      lineUnit !== supplierUnit &&
      basePrice > 0
    ) {
      const converted = convertUnitPrice(basePrice, supplierUnit, lineUnit);
      if (converted != null) priceToUse = converted;
    }

    setItem(idx, {
      product_id: p.id,
      product_name: p.name,
      sku: p.sku,
      unit_price: priceToUse,
      unit: lineUnit,
      hs_code: (p as any).hs_code ?? null,
      description: (p as any).description ?? null,
      detailed_spec: (p as any).detailed_spec ?? null,
      brand: (p as any).brand ?? null,
      // FIX (audit F-11): origin_country is not a DB column on products —
      // it's stored in attributes JSONB. Fall back to attributes.
      origin_country: (p as any).origin_country
        ?? ((p as any).attributes?.origin_country ?? null),
      // FIX (audit F-11): specifications — use coa_params if available.
      specifications: (p as any).coa_params ?? null,
    });

    setLoadingProductIdx(idx);
    try {
      const r = await fetch(api(`/api/automation/product-context?product_id=${p.id}`));
      if (!r.ok) throw new Error("Failed to load product context");
      const ctx: ProductContext = await r.json();
      setProductContextMap((prev) => ({ ...prev, [idx]: ctx }));

      // 2. Catalog spec-sheet override — richer trade metadata.
      const ce = ctx.catalogEntry;
      if (ce) {
        setItem(idx, {
          hs_code: ce.hs_code ?? (p as any).hs_code ?? null,
          detailed_spec: ce.detailed_spec ?? (p as any).detailed_spec ?? null,
          specifications: ce.specifications ?? null,
          origin_country: ce.origin_country ?? null,
          brand: ce.brand ?? (p as any).brand ?? null,
          description: ce.description ?? (p as any).description ?? null,
        });
        if (ce.price) setItem(idx, { unit_price: ce.price });
      }

      // 3. Latest supplier offer — smart price suggestion + trade-term auto-fill.
      // Sort by created_at desc so "latest" really means most recent, not just
      // first-in-array. Active offers are preferred over expired/on_hold ones.
      const supplierOffers: SupplierOffer[] = (ctx.supplierOffers || []) as SupplierOffer[];
      const activeSorted = [...supplierOffers].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      const latestOffer: SupplierOffer | null =
        activeSorted.find((so) => so.status === "active") ||
        activeSorted[0] ||
        null;

      // Persist the resolved latest offer on the context so the UI can render
      // the supplier-price indicator below the unit_price input without having
      // to re-derive it.
      if (latestOffer) {
        setProductContextMap((prev) => ({
          ...prev,
          [idx]: { ...ctx, latestSupplierOffer: latestOffer },
        }));
      }

      if (latestOffer) {
        // Use the supplier offer's unit_price as the line's default buy price
        // (only if it's a positive number — guards against bad data).
        // The supplier offer price is in the product's native unit (supplierUnit);
        // if the line item's unit differs (e.g. user picked MT while supplier
        // prices per kg), convert the price so it stays consistent with the unit.
        const soPrice = Number(latestOffer.unit_price);
        if (Number.isFinite(soPrice) && soPrice > 0) {
          const liveLineUnit = formRef.current.items?.[idx]?.unit || lineUnit;
          let priceToSet = soPrice;
          if (supplierUnit && liveLineUnit !== supplierUnit) {
            const converted = convertUnitPrice(soPrice, supplierUnit, liveLineUnit);
            if (converted != null) priceToSet = converted;
          }
          setItem(idx, { unit_price: priceToSet });
        }
        // Origin country on the line item (prefer the catalog spec-sheet,
        // then the supplier offer). We only override if the catalog didn't
        // already provide one — the SO's origin is a fallback.
        if (latestOffer.origin_country && !(ce && ce.origin_country)) {
          setItem(idx, { origin_country: latestOffer.origin_country });
        }

        // Offer-header trade fields — only fill in those the user hasn't set
        // yet, so we never clobber manual edits. Per task spec we only do this
        // for the FIRST line item (idx === 0) so adding a second product
        // doesn't silently re-fill the header.
        if (idx === 0) {
          setForm((f) => ({
            ...f,
            packaging: f.packaging || latestOffer.packaging || null,
            incoterm: f.incoterm || latestOffer.incoterm || null,
            pol: f.pol || latestOffer.loading_port || null,
            payment_terms: f.payment_terms || latestOffer.payment_terms || f.payment_terms || null,
            lead_time:
              f.lead_time ||
              (latestOffer.lead_time_days
                ? `${latestOffer.lead_time_days} days`
                : f.lead_time || null),
            origin_country:
              (f as any).origin_country ||
              latestOffer.origin_country ||
              null,
          }));
        }

        toast.success(t("fin-product-loaded").replace("${name}", p.name), {
          description: t("fin-product-loaded-with-supplier").replace("${price}", fmtMoney(latestOffer.unit_price, latestOffer.currency || p.currency)).replace("${number}", latestOffer.offer_number ? ` · ${latestOffer.offer_number}` : "").replace("${sku}", p.sku),
        });
      } else {
        toast.success(t("fin-product-loaded").replace("${name}", p.name), {
          description: t("fin-product-loaded-with-price").replace("${price}", fmtMoney(p.price, p.currency)).replace("${sku}", p.sku),
        });
      }
    } catch {
      // Context is optional — basic info already filled above.
      toast.success(t("fin-product-loaded").replace("${name}", p.name), {
        description: t("fin-product-loaded-with-price").replace("${price}", fmtMoney(p.price, p.currency)).replace("${sku}", p.sku),
      });
    } finally {
      setLoadingProductIdx(null);
    }
  }, [api, t]);

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
    setProductContextMap((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  }

  const totals = computeTotals(form.items || []);

  async function save() {
    if (!form.partner_id) { toast.error(t("fin-select-partner-toast")); return; }
    setSaving(true);
    try {
      const method = offer ? "PUT" : "POST";
      const url = offer ? api(`/api/offers/${offer.id}`) : api("/api/offers");

      // `inspection` and `certificate` are NOT DB columns on `offers` (only on
      // `supplier_offers`). To preserve the data without a schema migration we
      // fold them into the `notes` field as a "[Quality]" block, replacing any
      // previously-saved block so re-saving doesn't duplicate it. We then
      // strip them from the body so Supabase doesn't reject the upsert with an
      // "unknown column" error.
      const inspection = (form as any).inspection as string | null | undefined;
      const certificate = (form as any).certificate as string | null | undefined;
      const baseNotes = ((form.notes as string | null | undefined) || "")
        .replace(/\n*\[Quality\][\s\S]*$/m, "")
        .trim();
      const qualityParts: string[] = [];
      if (inspection) qualityParts.push(`Inspection: ${inspection}`);
      if (certificate) qualityParts.push(`Certificate: ${certificate}`);
      const combinedNotes =
        baseNotes || qualityParts.length > 0
          ? qualityParts.length > 0
            ? `${baseNotes}\n\n[Quality] ${qualityParts.join(" | ")}`.trim()
            : baseNotes
          : "";

      // Strip the extra fields so they aren't sent to the API.
      const { inspection: _insp, certificate: _cert, ...formRest } = form as any;

      // ─── Bank details: re-derive from the selected account when the user
      //     hasn't manually overridden the textarea. This keeps the saved
      //     `bank_details` string in sync even if the live form-state somehow
      //     drifted (e.g. the user picked an account then edited another field
      //     without touching the textarea). When `manualBankOverride` is true
      //     we keep the user's edited text verbatim. */
      let bankDetailsToSave = (form.bank_details as string | null | undefined) ?? null;
      if (
        selectedBankAccountIdx !== null &&
        !manualBankOverride &&
        tenantBankAccounts[selectedBankAccountIdx]
      ) {
        bankDetailsToSave = formatBankDetailsForOffer(
          tenantBankAccounts[selectedBankAccountIdx],
        );
      }

      const body = {
        ...formRest,
        bank_details: bankDetailsToSave,
        notes: combinedNotes,
        status: form.status || "draft",
        items: (form.items || []).map((it) => ({ ...it, total: lineTotal(it) })),
        ...computeTotals(form.items || []),
      };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("fin-request-failed"));
      }
      const result = await r.json().catch(() => ({}));
      const offerNumber = result.number || result.id || "";
      if (offer) {
        toast.success(t("crm-offer-updated"), { description: offerNumber ? t("crm-offer-updated-desc").replace("${number}", offerNumber) : undefined });
      } else {
        toast.success(t("crm-offer-created-toast"), { description: offerNumber ? t("crm-offer-updated-desc").replace("${number}", offerNumber) : t("crm-offer-created-toast-desc") });
      }
      onSaved(offerNumber);
    } catch (e: any) {
      toast.error(e.message || t("crm-saving-failed-toast"));
    } finally {
      setSaving(false);
    }
  }

  const dealList = deals.data?.items || [];
  const selectedPartner = partnerContext?.partner || partners.find((p) => p.id === form.partner_id);

  // ─── Tenant (company) record ───
  // Used by the completeness checker to verify that the seller's legal name,
  // address, registration number and bank details are present — these end up
  // on the offer PDF footer and on invoices/proformas spawned from the offer.
  // For regular users `/api/tenants` returns just their own tenant; for
  // super-admins it returns every tenant, so we filter by the effective
  // tenant id (activeTenantId for super-admins, user.tenant_id otherwise).
  const effectiveTenantId = useEffectiveTenantId();
  const tenantQuery = useQuery({
    queryKey: ["tenant", tenantKey, effectiveTenantId, "completeness"],
    queryFn: async () => {
      const r = await fetch(api("/api/tenants"));
      if (!r.ok) throw new Error("Failed to load tenant");
      const data = (await r.json()) as { items: Tenant[] };
      const list = data.items || [];
      const match = effectiveTenantId
        ? list.find((t) => t.id === effectiveTenantId)
        : null;
      return (match || list[0] || null) as Tenant | null;
    },
    enabled: open,
  });
  const tenant = tenantQuery.data ?? null;

  // ─── Tenant bank accounts (parsed from the JSON column) ───
  // The tenant's `bank_accounts` field holds a JSON array of
  // { bankName, accountNumber, swiftCode, currency, holder } records. We
  // expose them as a clean array so the bank-account picker in the form
  // can render a dropdown without re-parsing on every render.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const tenantBankAccounts = useMemo(
    () => parseTenantBankAccounts(tenant?.bank_accounts ?? null),
    [tenant?.bank_accounts],
  );

  // ─── Real-time completeness report ───
  // Recomputed on every keystroke so the panel below the line-items table
  // always reflects the current form state. The supplier-offers context map
  // carries the latest active supplier offer for each line item so the
  // checker can tell the user "this field IS available from supplier X" vs.
  // "this field is missing — look it up in the product catalog".
  const supplierOffersContext = useMemo(() => {
    const map: Record<number, any> = {};
    for (const [k, v] of Object.entries(productContextMap)) {
      const ctx = v as ProductContext;
      map[Number(k)] =
        ctx.latestSupplierOffer || ctx.supplierOffers?.[0] || null;
    }
    return map;
  }, [productContextMap]);

  const completenessReport = useMemo(
    () =>
      checkOfferCompleteness(
        form,
        form.items || [],
        selectedPartner ?? null,
        tenant,
        supplierOffersContext,
      ),
    [form, selectedPartner, tenant, supplierOffersContext],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            {offer ? t("crm-edit-offer") : t("crm-new-offer")}
            <Sparkles className="size-4 text-amber-500" />
          </DialogTitle>
          <DialogDescription>
            {offer ? t("crm-update-offer-details") : t("crm-create-offer-desc")}
          </DialogDescription>
        </DialogHeader>

        {/* ─── Trade calc preview banner (Fix 1) ────────────────────────
            When this offer was pre-filled from a trade calculation, surface
            an inline banner explaining the orange highlights so the user
            knows what the visual cue means. */}
        <div className="px-6 pt-4 space-y-2 shrink-0">
        {missingFields && missingFields.size > 0 && (
          <div className="rounded-lg border border-orange-300 bg-orange-50 dark:bg-orange-950/20 dark:border-orange-800 p-3 flex items-start gap-3">
            <Info className="size-4 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
            <div className="text-xs text-orange-900 dark:text-orange-200">
              <div className="font-semibold mb-0.5">{t("crm-review-prefilled-offer")}</div>
              <div>
                {t("crm-review-prefilled-desc")}
              </div>
            </div>
          </div>
        )}
        {missingFields && missingFields.size === 0 && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800 p-3 flex items-start gap-3">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-xs text-emerald-900 dark:text-emerald-200">
              <div className="font-semibold mb-0.5">{t("crm-prefilled-from-trade-calc")}</div>
              <div>
                {t("crm-prefilled-success-desc")}
              </div>
            </div>
          </div>
        )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">

          {/* ─── Partner Selection (top — auto-fill partner details) ─── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4" /> {t("crm-partner-section")}
              {partnerContext && !loadingPartner && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5 ml-1">
                  <Sparkles className="size-2.5 text-amber-500" /> {t("crm-auto-filled")}
                </Badge>
              )}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Partner select */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  {t("crm-partner-required-label")}
                  {loadingPartner && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                </Label>
                <MissingFieldWrap missing={isMissingField("partner_id")}>
                  <PartnerPicker
                    value={form.partner_id || ""}
                    fallbackName={selectedPartner?.name}
                    placeholder={t("crm-select-a-partner")}
                    className={cn(isMissingField("partner_id") && MISSING_FIELD_CLS)}
                    onSelect={(p) => {
                      const id = p?.id || "";
                      set("partner_id", id);
                      if (id) fetchPartnerContext(id);
                    }}
                  />
                </MissingFieldWrap>
              </div>

              {/* Currency */}
              <div className="space-y-1.5">
                <Label>{t("currency")}</Label>
                <MissingFieldWrap missing={isMissingField("currency")}>
                  <Select value={form.currency || "USD"} onValueChange={(v) => set("currency", v)}>
                    <SelectTrigger className={cn(isMissingField("currency") && MISSING_FIELD_CLS)}>
                      <SelectValue placeholder={t("crm-select-currency")} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </MissingFieldWrap>
              </div>
            </div>

            {/* Partner context panel — auto-pulled details */}
            {selectedPartner && partnerContext && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-50/50 dark:bg-amber-950/10 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Building2 className="size-4 text-amber-600" />
                  <span className="text-sm font-medium">{selectedPartner.name}</span>
                  <Badge variant="outline" className="text-xs">{selectedPartner.type}</Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                  {selectedPartner.address_line && (
                    <div className="flex items-start gap-1.5">
                      <MapPin className="size-3 text-muted-foreground mt-0.5 shrink-0" />
                      <span className="text-muted-foreground">{[selectedPartner.address_line, selectedPartner.city, selectedPartner.country].filter(Boolean).join(", ")}</span>
                    </div>
                  )}
                  {selectedPartner.tax_id && (
                    <div className="flex items-center gap-1.5">
                      <Hash className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-tax-id-prefix").replace("${value}", selectedPartner.tax_id)}</span>
                    </div>
                  )}
                  {selectedPartner.vat_number && (
                    <div className="flex items-center gap-1.5">
                      <Hash className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-vat-prefix").replace("${value}", selectedPartner.vat_number)}</span>
                    </div>
                  )}
                  {selectedPartner.bank_name && (
                    <div className="flex items-center gap-1.5">
                      <Landmark className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{selectedPartner.bank_name}{selectedPartner.bank_iban ? ` · ${selectedPartner.bank_iban}` : ""}</span>
                    </div>
                  )}
                  {selectedPartner.preferred_currency && (
                    <div className="flex items-center gap-1.5">
                      <Globe className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-currency-prefix").replace("${value}", selectedPartner.preferred_currency)}</span>
                    </div>
                  )}
                  {selectedPartner.preferred_incoterm && (
                    <div className="flex items-center gap-1.5">
                      <CreditCard className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-incoterm-prefix").replace("${value}", selectedPartner.preferred_incoterm)}</span>
                    </div>
                  )}
                  {selectedPartner.preferred_payment_terms && (
                    <div className="flex items-center gap-1.5">
                      <CreditCard className="size-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">{t("crm-terms-prefix").replace("${value}", selectedPartner.preferred_payment_terms)}</span>
                    </div>
                  )}
                </div>

                {/* Recent activity */}
                {(partnerContext.deals?.length > 0 || partnerContext.offers?.length > 0 || partnerContext.invoices?.length > 0) && (
                  <div className="mt-3 pt-2 border-t border-amber-500/10">
                    <Tabs defaultValue="offers" className="w-full">
                      <TabsList className="h-7">
                        <TabsTrigger value="offers" className="text-xs h-5 px-2">
                          {t("fin-tabs-offers")} ({partnerContext.offers?.length || 0})
                        </TabsTrigger>
                        <TabsTrigger value="deals" className="text-xs h-5 px-2">
                          {t("fin-tabs-deals")} ({partnerContext.deals?.length || 0})
                        </TabsTrigger>
                        <TabsTrigger value="invoices" className="text-xs h-5 px-2">
                          {t("fin-tabs-invoices")} ({partnerContext.invoices?.length || 0})
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="offers" className="mt-1">
                        <div className="max-h-24 overflow-y-auto custom-scroll">
                          {(partnerContext.offers || []).slice(0, 5).map((o: Offer) => (
                            <div key={o.id} className="flex items-center justify-between text-xs py-0.5">
                              <span className="font-mono">{o.number}</span>
                              <span className="text-muted-foreground truncate max-w-[120px]">{o.subject}</span>
                              <span className="font-mono">{fmtMoney(o.total, o.currency)}</span>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                      <TabsContent value="deals" className="mt-1">
                        <div className="max-h-24 overflow-y-auto custom-scroll">
                          {(partnerContext.deals || []).slice(0, 5).map((d: Deal) => (
                            <div key={d.id} className="flex items-center justify-between text-xs py-0.5">
                              <span className="truncate max-w-[140px]">{d.title}</span>
                              <Badge variant="outline" className="text-xs h-4 px-1">{d.stage}</Badge>
                              <span className="font-mono">{fmtMoney(d.value, d.currency)}</span>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                      <TabsContent value="invoices" className="mt-1">
                        <div className="max-h-24 overflow-y-auto custom-scroll">
                          {(partnerContext.invoices || []).slice(0, 5).map((inv: any) => (
                            <div key={inv.id} className="flex items-center justify-between text-xs py-0.5">
                              <span className="font-mono">{inv.number}</span>
                              <Badge variant="outline" className="text-xs h-4 px-1">{inv.status}</Badge>
                              <span className="font-mono">{fmtMoney(inv.total, inv.currency)}</span>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                    </Tabs>
                  </div>
                )}
              </div>
            )}

          </div>

          {/* ─── Trade Terms Section (always visible) ─── */}
          {/* All the import/export fields every offer should carry, in one place
              rather than scattered across the form. Auto-filled from the latest
              supplier offer when the user adds the first line item. */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Truck className="h-4 w-4" /> {t("crm-trade-terms-section")}
              <span className="text-xs text-muted-foreground font-normal">{t("crm-trade-terms-desc")}</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Incoterm */}
              <div className="space-y-1.5">
                <Label>{t("crm-incoterm-required")}</Label>
                <MissingFieldWrap missing={isMissingField("incoterm")}>
                  <Select
                    value={form.incoterm || "__none__"}
                    onValueChange={(v) => set("incoterm", v === "__none__" ? null : v)}
                  >
                    <SelectTrigger className={cn(isMissingField("incoterm") && MISSING_FIELD_CLS)}>
                      <SelectValue placeholder={t("crm-select-incoterm")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("crm-none-option")}</SelectItem>
                      {INCOTERM_CODES.map((code) => (
                        <SelectItem key={code} value={code}>{code}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </MissingFieldWrap>
              </div>

              {/* Payment Terms */}
              <div className="space-y-1.5">
                <Label>{t("crm-payment-terms-required")}</Label>
                <MissingFieldWrap missing={isMissingField("payment_terms")}>
                  <Select value={form.payment_terms || "net30"} onValueChange={(v) => set("payment_terms", v)}>
                    <SelectTrigger className={cn(isMissingField("payment_terms") && MISSING_FIELD_CLS)}>
                      <SelectValue placeholder={t("crm-select-payment-terms")} />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_TERMS_LOCAL.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </MissingFieldWrap>
              </div>

              {/* Valid Until */}
              <div className="space-y-1.5">
                <Label>{t("crm-valid-until-required")}</Label>
                <Input
                  type="date"
                  value={form.valid_until ? form.valid_until.slice(0, 10) : ""}
                  onChange={(e) => set("valid_until", e.target.value ? new Date(e.target.value).toISOString() : null)}
                />
              </div>

              {/* Loading Port (POL) */}
              <div className="space-y-1.5">
                <Label>{t("crm-loading-port-pol")}</Label>
                <MissingFieldWrap missing={isMissingField("pol")}>
                  <PortAutocomplete
                    value={form.pol || ""}
                    onChange={(v) => set("pol", v)}
                    placeholder={t("fin-placeholder-pol")}
                    className={cn(isMissingField("pol") && MISSING_FIELD_CLS)}
                  />
                </MissingFieldWrap>
              </div>

              {/* Discharge Port (POD) */}
              <div className="space-y-1.5">
                <Label>{t("crm-discharge-port-pod")}</Label>
                <MissingFieldWrap missing={isMissingField("pod")}>
                  <PortAutocomplete
                    value={form.pod || ""}
                    onChange={(v) => set("pod", v)}
                    placeholder={t("fin-placeholder-pod")}
                    className={cn(isMissingField("pod") && MISSING_FIELD_CLS)}
                  />
                </MissingFieldWrap>
              </div>

              {/* Lead Time */}
              <div className="space-y-1.5">
                <Label>{t("crm-lead-time-label")}</Label>
                <Input
                  value={form.lead_time || ""}
                  onChange={(e) => set("lead_time", e.target.value)}
                  placeholder={t("fin-placeholder-lead-time")}
                />
              </div>

              {/* Packaging */}
              <div className="space-y-1.5">
                <Label>{t("crm-packaging-label")}</Label>
                <Input
                  value={form.packaging || ""}
                  onChange={(e) => set("packaging", e.target.value)}
                  placeholder={t("fin-placeholder-packaging")}
                />
              </div>

              {/* Origin Country */}
              <div className="space-y-1.5">
                <Label>{t("crm-origin-country-label")}</Label>
                <MissingFieldWrap missing={isMissingField("origin_country")}>
                  <CountrySelect
                    value={(form as any).origin_country ?? null}
                    onChange={(v) => setExtra("origin_country", v || null)}
                    placeholder={t("crm-select-origin-country")}
                    className={cn(isMissingField("origin_country") && MISSING_FIELD_CLS)}
                  />
                </MissingFieldWrap>
              </div>

              {/* Inspection */}
              <div className="space-y-1.5">
                <Label>{t("crm-inspection-label")}</Label>
                <Select
                  value={(form as any).inspection || "__none__"}
                  onValueChange={(v) => setExtra("inspection", v === "__none__" ? null : v)}
                >
                  <SelectTrigger><SelectValue placeholder={t("crm-select-inspection")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("fin-none-dash-option")}</SelectItem>
                    <SelectItem value="SGS">SGS</SelectItem>
                    <SelectItem value="Intertek">Intertek</SelectItem>
                    <SelectItem value="Bureau Veritas">Bureau Veritas</SelectItem>
                    <SelectItem value="Cotecna">Cotecna</SelectItem>
                    <SelectItem value="other">{t("crm-other")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Certificate */}
              <div className="space-y-1.5">
                <Label>{t("crm-certificate-label")}</Label>
                <Input
                  value={(form as any).certificate || ""}
                  onChange={(e) => setExtra("certificate", e.target.value || null)}
                  placeholder={t("fin-placeholder-certificate")}
                />
              </div>
            </div>
          </div>

          {/* ─── Line Items Section (inline table) ─── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Package className="h-4 w-4" /> {t("crm-line-items")}
                <Sparkles className="size-3.5 text-amber-500" />
                <span className="text-xs text-muted-foreground font-normal">{t("crm-auto-fill-catalog-supplier")}</span>
              </h3>
              <Button type="button" size="sm" variant="outline" onClick={addItem}>
                <Plus className="size-4 mr-1" /> {t("crm-add-item")}
              </Button>
            </div>

            {(form.items || []).length === 0 ? (
              <div className="border rounded-md border-dashed border-border/60 p-6 text-center bg-card">
                <Package className="size-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">{t("crm-no-line-items")}</p>
                <p className="text-xs text-muted-foreground mt-1">{t("crm-click-add-item")}</p>
              </div>
            ) : (
              <div className="rounded-md border border-border/60 overflow-x-auto bg-card">
                <Table>
                  <TableHeader className="bg-muted/30">
                    <TableRow>
                      <TableHead className="min-w-[200px]">{t("crm-product")}</TableHead>
                      <TableHead className="w-24 hidden md:table-cell">{t("crm-hs-code")}</TableHead>
                      <TableHead className="w-20 text-right">{t("crm-qty")}</TableHead>
                      <TableHead className="w-24">{t("crm-unit-detail")}</TableHead>
                      <TableHead className="w-32 text-right">{t("crm-unit-price-detail")}</TableHead>
                      <TableHead className="w-16 text-right hidden sm:table-cell">{t("crm-disc-pct")}</TableHead>
                      <TableHead className="w-16 text-right hidden sm:table-cell">{t("crm-tax-pct-form")}</TableHead>
                      <TableHead className="w-28 text-right">{t("crm-line-total")}</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(form.items || []).map((it, idx) => {
                      const lineRevenue = lineTotal(it);
                      return (
                      <TableRow key={idx}>
                        <TableCell>
                          <div className="space-y-1">
                            <ProductPicker
                              value={it.product_id || ""}
                              fallbackName={it.product_name || ""}
                              fallbackSku={it.sku || ""}
                              placeholder={t("fin-search-products-placeholder")}
                              onSelect={(product) => {
                                if (product) {
                                  selectProduct(idx, product);
                                } else {
                                  setItem(idx, { product_id: "" });
                                  setProductContextMap((prev) => {
                                    const next = { ...prev };
                                    delete next[idx];
                                    return next;
                                  });
                                }
                              }}
                              onAddCustom={() => {
                                // "Add custom product" — clear the product_id
                                // but keep the current product_name so the
                                // user can keep typing a manual entry.
                                setItem(idx, { product_id: "" });
                                setProductContextMap((prev) => {
                                  const next = { ...prev };
                                  delete next[idx];
                                  return next;
                                });
                              }}
                            />
                            <Input
                              className="h-7 text-xs"
                              placeholder={t("crm-product-name-override")}
                              value={it.product_name || ""}
                              onChange={(e) => setItem(idx, { product_name: e.target.value })}
                            />
                            {loadingProductIdx === idx && (
                              <Loader2 className="size-3 animate-spin text-muted-foreground" />
                            )}
                            {productContextMap[idx] ? (
                              <ProductContextPreview
                                ctx={productContextMap[idx]}
                                lineItem={it}
                                partners={partners}
                                currency={form.currency || "USD"}
                              />
                            ) : (
                              // Lightweight inline metadata shown before the
                              // full context has loaded (or when the API call
                              // failed). Keeps the old brand chip available
                              // even when HS code is shown in its own column.
                              (it as any).brand ? (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                                  <span>{(it as any).brand}</span>
                                </div>
                              ) : null
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {it.hs_code ? (
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground tabular">
                              {it.hs_code}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            className="h-8 text-xs w-16 text-right"
                            value={it.quantity}
                            onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })}
                          />
                        </TableCell>
                        <TableCell>
                          <div
                            className="w-24"
                            title={
                              it.unit &&
                              productContextMap[idx]?.product?.unit &&
                              it.unit !== productContextMap[idx].product.unit &&
                              describeConversion(
                                productContextMap[idx].product!.unit,
                                it.unit,
                              )
                                ? `Unit conversion: ${describeConversion(
                                    productContextMap[idx].product!.unit,
                                    it.unit,
                                  )}`
                                : undefined
                            }
                          >
                            <UnitSelect
                              value={it.unit || ""}
                              onChange={(v) => handleUnitChange(idx, v)}
                              placeholder="pcs"
                              className="h-8 text-xs w-24"
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            className="h-8 text-xs w-28 text-right"
                            value={it.unit_price}
                            onChange={(e) => setItem(idx, { unit_price: Number(e.target.value) })}
                            title={
                              productContextMap[idx]?.latestSupplierOffer
                                ? (() => {
                                    const so = productContextMap[idx].latestSupplierOffer!;
                                    const soPrice = fmtMoney(
                                      so.unit_price,
                                      so.currency || form.currency || "USD",
                                    );
                                    const soUnit = productContextMap[idx].product?.unit || "unit";
                                    const soRef =
                                      (
                                        so.offer_number ||
                                        so.id ||
                                        ""
                                      ).slice(-6) || "?";
                                    const conv =
                                      it.unit &&
                                      productContextMap[idx].product?.unit &&
                                      it.unit !== productContextMap[idx].product.unit &&
                                      describeConversion(
                                        productContextMap[idx].product.unit,
                                        it.unit,
                                      )
                                        ? ` · ${describeConversion(
                                            productContextMap[idx].product!.unit,
                                            it.unit!,
                                          )}`
                                        : "";
                                    return t("fin-supplier-offer-tooltip").replace("${price}", soPrice).replace("${unit}", soUnit).replace("${ref}", soRef).replace("${conv}", conv);
                                  })()
                                : undefined
                            }
                          />
                          {/* Compact supplier-price badge (replaces the old
                              verbose paragraph). Only shown when a latest
                              supplier offer exists for this line. */}
                          {productContextMap[idx]?.latestSupplierOffer && (
                            <Badge
                              variant="outline"
                              className="mt-0.5 text-xs h-4 px-1 font-mono border-blue-500/30 bg-blue-50/60 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
                              title={t("fin-auto-filled-from-supplier-offer").replace("${number}", productContextMap[idx].latestSupplierOffer!.offer_number ? ` ${productContextMap[idx].latestSupplierOffer!.offer_number}` : "")}
                            >
                              {t("fin-supplier-prefix")} {fmtMoney(
                                productContextMap[idx].latestSupplierOffer!.unit_price,
                                productContextMap[idx].latestSupplierOffer!.currency || form.currency || "USD",
                              )}/{productContextMap[idx].product?.unit || "unit"}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right hidden sm:table-cell">
                          <Input
                            type="number"
                            className="h-8 text-xs w-14 text-right"
                            value={it.discount}
                            onChange={(e) => setItem(idx, { discount: Number(e.target.value) })}
                          />
                        </TableCell>
                        <TableCell className="text-right hidden sm:table-cell">
                          <Input
                            type="number"
                            className="h-8 text-xs w-14 text-right"
                            value={it.tax_rate}
                            onChange={(e) => setItem(idx, { tax_rate: Number(e.target.value) })}
                          />
                        </TableCell>
                        <TableCell
                          className="text-right font-mono tabular text-sm font-medium"
                          title={t("fin-line-total-prefix").replace("${money}", fmtMoney(lineRevenue, form.currency || "USD"))}
                        >
                          {fmtMoney(lineRevenue, form.currency || "USD")}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-8 text-destructive"
                            onClick={() => removeItem(idx)}
                            title={t("remove")}
                            aria-label={t("remove")}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* ─── Bank Account for Payment (NEW) ─── */}
          {/* The tenant's `bank_accounts` JSON array is presented as a
              dropdown. Picking one auto-fills the offer's `bank_details`
              string (which the PDF renders verbatim). The user can still
              override the auto-filled text manually — typing into the
              textarea below flips the picker to "custom" (no highlight). */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Landmark className="h-4 w-4" /> {t("crm-bank-account-payment")}
            </h3>
            {tenantBankAccounts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground bg-card">
                {t("crm-no-bank-accounts")}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  {t("crm-bank-account")}
                  {selectedBankAccountIdx !== null && !manualBankOverride && (
                    <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 gap-0.5">
                      <Sparkles className="size-2.5 text-amber-500" /> {t("fin-auto-filled")}
                    </Badge>
                  )}
                </Label>
                <Select
                  value={selectedBankAccountIdx === null ? "__none__" : String(selectedBankAccountIdx)}
                  onValueChange={(v) => {
                    if (v === "__none__") {
                      setSelectedBankAccountIdx(null);
                      // Don't clear the textarea — let the user keep the
                      // previously-auto-filled text if they want.
                      setManualBankOverride(false);
                    } else {
                      const idx = Number(v);
                      setSelectedBankAccountIdx(idx);
                      setManualBankOverride(false);
                      const acct = tenantBankAccounts[idx];
                      if (acct) {
                        const formatted = formatBankDetailsForOffer(acct);
                        setForm((f) => ({ ...f, bank_details: formatted }));
                        toast.success(t("crm-bank-details-auto-filled"), {
                          description: acct.bankName || acct.bank_name || t("fin-selected-account"),
                        });
                      }
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("crm-select-bank-account")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("crm-no-selection")}</SelectItem>
                    {tenantBankAccounts.map((acct, idx) => {
                      const bankName = acct.bankName || acct.bank_name || t("fin-bank-default-name");
                      const accountNumber = acct.accountNumber || acct.account_number || acct.iban || "—";
                      const currency = acct.currency || "";
                      const swift = acct.swiftCode || acct.swift_code || "";
                      return (
                        <SelectItem key={idx} value={String(idx)}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{bankName}</span>
                            {currency && (
                              <Badge variant="secondary" className="text-xs h-4 px-1">{currency}</Badge>
                            )}
                            <span className="text-xs text-muted-foreground font-mono">{accountNumber}</span>
                            {swift && (
                              <span className="text-xs text-muted-foreground font-mono">· {swift}</span>
                            )}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("crm-bank-details-editable")}
              </Label>
              <Textarea
                rows={3}
                className="font-mono text-xs"
                value={form.bank_details || ""}
                onChange={(e) => {
                  set("bank_details", e.target.value);
                  // User typed something manually → mark the picker as overridden
                  // so the "Auto-filled" badge disappears. They can still re-pick
                  // from the dropdown to re-fill from a tenant account.
                  setManualBankOverride(true);
                }}
                placeholder={t("crm-bank-details-placeholder")}
              />
              {manualBankOverride && selectedBankAccountIdx !== null && (
                <p className="text-xs text-muted-foreground italic">
                  {t("crm-customized-note")}
                </p>
              )}
            </div>
          </div>

          {/* ─── Offer Text / Notes / Terms (template builder) ─── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4" /> {t("crm-offer-text")}
              <span className="text-xs text-muted-foreground font-normal">{t("crm-template-builder")}</span>
            </h3>
            <div className="space-y-1.5">
              <Label>{t("crm-notes-label")}</Label>
              <Textarea
                rows={2}
                value={form.notes || ""}
                onChange={(e) => set("notes", e.target.value)}
                placeholder={t("crm-notes-placeholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("crm-offer-text-terms")}</Label>
              <OfferTextBuilder
                value={typeof form.terms === "string" ? form.terms : ""}
                onChange={(text) => set("terms", text)}
                currency={form.currency || undefined}
                total={computeTotals(form.items || []).total}
                validUntil={form.valid_until || undefined}
                incoterm={form.incoterm || undefined}
                paymentTerms={form.payment_terms || undefined}
                leadTime={form.lead_time || undefined}
                pol={form.pol || undefined}
                pod={form.pod || undefined}
                origin={(form as { origin_country?: string | null }).origin_country || undefined}
                packaging={form.packaging || undefined}
              />
            </div>
          </div>

          {/* ─── Totals (auto-calculated, read-only) ─── */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Receipt className="h-4 w-4" /> {t("crm-totals")}
              <span className="text-xs text-muted-foreground font-normal">{t("crm-totals-auto-calc")}</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              {/* Amount in words */}
              <div className="rounded-md border border-border/60 bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  {t("crm-amount-in-words")}
                </p>
                <p className="text-xs font-medium leading-snug">
                  {amountInWords(totals.total, form.currency || "USD")}
                </p>
              </div>
              {/* Numeric totals */}
              <div className="space-y-1 text-sm ml-auto w-full sm:w-72">
                <div className="flex items-center gap-1.5 mb-1">
                  <Sparkles className="size-3 text-amber-500" />
                  <span className="text-xs text-muted-foreground">{t("crm-auto-calculated")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("crm-subtotal")}</span>
                  <span className="font-mono tabular">{fmtMoney(totals.subtotal, form.currency || "USD")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("crm-discount")}</span>
                  <span className="font-mono tabular">- {fmtMoney(totals.discount_total, form.currency || "USD")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("crm-tax")}</span>
                  <span className="font-mono tabular">{fmtMoney(totals.tax_total, form.currency || "USD")}</span>
                </div>
                <div className="flex justify-between border-t pt-1.5 mt-1 text-base font-bold">
                  <span>{t("crm-grand-total")}</span>
                  <span className="font-mono tabular">{fmtMoney(totals.total, form.currency || "USD")}</span>
                </div>
              </div>
            </div>
          </div>

          {/* ─── Data Completeness Checker (real-time, collapsible) ─── */}
          {/* Surfaces every field that's still missing from the offer — grouped
              by offer / line item / buyer / company — so the user knows exactly
              what to fix or supplement before sending. Recomputed on every
              keystroke via the `completenessReport` memo above.
              Collapsed by default — the score + critical count always shows in
              the trigger, expand to drill into the per-field list. */}
          <Collapsible open={completenessOpen} onOpenChange={setCompletenessOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
              >
                {completenessOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                )}
                <CheckCircle2 className="size-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium">{t("crm-data-completeness")}</span>
                <Badge
                  variant={
                    completenessReport.criticalCount > 0
                      ? "destructive"
                      : completenessReport.warningCount > 0
                        ? "secondary"
                        : "default"
                  }
                  className="ml-auto"
                >
                  {completenessReport.completenessScore}%
                </Badge>
                {completenessReport.criticalCount > 0 && (
                  <span className="text-xs text-destructive">
                    {completenessReport.criticalCount} {t("crm-critical")}
                  </span>
                )}
                {completenessReport.criticalCount === 0 &&
                  completenessReport.warningCount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {completenessReport.warningCount} {t("crm-to-review")}
                    </span>
                  )}
                {completenessReport.criticalCount === 0 &&
                  completenessReport.warningCount === 0 && (
                    <span className="text-xs text-emerald-600">{t("crm-all-complete")}</span>
                  )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3 pb-2">
                <CompletenessChecker report={completenessReport} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ─── More Details Section (collapsible) ─── */}
          <Collapsible open={moreDetailsOpen} onOpenChange={setMoreDetailsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
              >
                {moreDetailsOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                )}
                <span className="text-sm font-medium">{t("crm-more-details")}</span>
                <span className="text-xs text-muted-foreground">{t("crm-subject-deal-etc")}</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3 space-y-4">
                {/* Subject + Deal */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-subject-label")}</Label>
                    <Input
                      value={form.subject || ""}
                      onChange={(e) => set("subject", e.target.value)}
                      placeholder={t("crm-equipment-inquiry-ph")}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-linked-deal")}</Label>
                    <Select
                      value={form.deal_id || "__none__"}
                      onValueChange={(v) => set("deal_id", v === "__none__" ? null : v)}
                    >
                      <SelectTrigger><SelectValue placeholder={t("crm-no-deal")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t("crm-no-deal-option")}</SelectItem>
                        {dealList.map((d) => (
                          <SelectItem key={d.id} value={d.id}>{d.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Supplier ref + Selling price */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-supplier-ref-label")}</Label>
                    <Input value={form.offer_no || ""} onChange={(e) => set("offer_no", e.target.value)} placeholder="SUP-2026-001" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-selling-price-label")}</Label>
                    <Input type="number" value={form.selling_price ?? ""} onChange={(e) => set("selling_price", e.target.value === "" ? null : Number(e.target.value))} placeholder={t("crm-per-unit")} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-tax-clause-label")}</Label>
                    <Input value={form.tax_clause || ""} onChange={(e) => set("tax_clause", e.target.value)} placeholder="VAT reverse charge" />
                  </div>
                </div>

                {/* Shipping specifics — vessel + container */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("crm-vessel-label")}</Label>
                    <Input value={form.vessel || ""} onChange={(e) => set("vessel", e.target.value)} placeholder="MV Ever Given" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-container-no-label")}</Label>
                    <Input value={form.container_no || ""} onChange={(e) => set("container_no", e.target.value)} placeholder="MSKU-1234567" />
                  </div>
                </div>

                {/* Trade Advisor — auto-shows FTA + tariff info when countries are known */}
                {selectedPartner?.country && (
                  <TradeAdvisor
                    reporterCode={selectedPartner.country}
                    partnerCode={undefined}
                    hsCode={(form.items?.[0] as any)?.hs_code}
                  />
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 mr-1 animate-spin" />
                {t("crm-saving-ellipsis")}
              </>
            ) : offer ? (
              t("crm-save-changes")
            ) : (
              <>
                <Plus className="size-4 mr-1" />
                {t("crm-create-offer")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
