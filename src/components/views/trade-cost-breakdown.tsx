"use client";

import * as React from "react";
import {
  TrendingUp,
  DollarSign,
  Ship,
  Banknote,
  Percent,
  Calculator,
  Send,
  FileCheck,
  Gauge,
  Globe2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/store";

const DISPLAY_CURRENCIES = [
  "USD", "EUR", "GBP", "CHF", "AED", "SAR", "CNY", "INR", "RUB",
  "JPY", "TRY", "BRL", "ZAR", "SGD", "HKD", "AUD", "CAD", "RSD",
  "EGP", "KRW", "MXN", "MYR", "THB", "IDR", "PHP", "NZD", "SEK",
  "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN", "ILS",
];

export interface CostLine {
  type: string;
  label: string;
  basis: string;
  value: number;
  amount: number;
  currency?: string; // currency of `amount` (defaults to buyCurrency when missing)
  fx_rate?: number; // rate to convert amount → buy_currency
  converted_amount?: number; // amount * fx_rate (cached, in buy_currency)
}

export interface BankCost {
  id: string;
  label: string;
  amount: number;
  basis: string;
}

export interface TransferFee {
  id: string;
  label: string;
  amount: number;
  description?: string;
}

export interface DocumentationCost {
  id: string;
  label: string;
  amount: number;
  description?: string;
}

export interface CostBreakdownPanelProps {
  // Buy side
  quantity: number;
  unit: string;
  buyPricePerUnit: number;
  buyCurrency: string;
  buyTotal: number;

  // Sell side
  sellPricePerUnit: number;
  sellCurrency: string;
  sellTotal: number;

  // FX
  exchangeRate: number;
  currenciesDiffer: boolean;
  buyTotalInSellCurrency: number;

  // Costs
  costLines: CostLine[];
  totalCosts: number; // in buy currency
  totalCostsInSellCurrency: number;
  landedCost: number; // buy + costs, in buy currency
  landedCostInSellCurrency: number;

  // Bank costs (in sell currency)
  bankCosts: BankCost[];
  totalBankCosts: number;

  // Transfer fees (in sell currency)
  transferFees: TransferFee[];
  totalTransferFees: number;

  // Documentation costs (in sell currency)
  documentationCosts: DocumentationCost[];
  totalDocumentationCosts: number;

  // Commission (in sell currency)
  commissionType: string;
  commissionRate: number;
  commissionAmount: number;

  // Results
  grossProfit: number; // sellTotal - landedCostInSellCurrency
  grossMarginPct: number;
  profitBeforeCommission: number; // grossProfit - bank - transfer - docs
  netProfit: number; // profitBeforeCommission - commissionAmount
  netMarginPct: number;

  // Per-unit
  landedCostPerUnit: number;
  profitPerUnit: number;

  // Variance analysis (±10%)
  bestCaseProfit: number;
  worstCaseProfit: number;
}

function fmtMoney(n: number, currency = "USD"): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

function fmtPct(n: number): string {
  return `${(n || 0).toFixed(1)}%`;
}

function commissionTypeLabel(type: string, rate: number): string {
  switch (type) {
    case "percent_profit":
      return `${rate}% of profit`;
    case "percent_revenue":
      return `${rate}% of revenue`;
    case "fixed_per_unit":
      return `fixed per unit`;
    case "fixed_total":
      return "fixed total";
    case "fixed":
      return "fixed";
    default:
      return "none";
  }
}

export function CostBreakdownPanel(props: CostBreakdownPanelProps) {
  const t = useT();
  const {
    quantity,
    unit,
    buyPricePerUnit,
    buyCurrency,
    buyTotal,
    sellPricePerUnit,
    sellCurrency,
    sellTotal,
    exchangeRate,
    currenciesDiffer,
    buyTotalInSellCurrency,
    costLines,
    totalCosts,
    totalCostsInSellCurrency,
    landedCostInSellCurrency,
    bankCosts,
    totalBankCosts,
    transferFees,
    totalTransferFees,
    documentationCosts,
    totalDocumentationCosts,
    commissionType,
    commissionRate,
    commissionAmount,
    grossProfit,
    grossMarginPct,
    profitBeforeCommission,
    netProfit,
    netMarginPct,
    landedCostPerUnit,
    profitPerUnit,
    bestCaseProfit,
    worstCaseProfit,
  } = props;

  const hasCosts = costLines.length > 0;
  const hasBankCosts = bankCosts.length > 0 && totalBankCosts > 0;
  const hasTransferFees = transferFees.length > 0 && totalTransferFees > 0;
  const hasDocCosts =
    documentationCosts.length > 0 && totalDocumentationCosts > 0;
  const hasCommission = commissionAmount > 0;

  // Color code the margin
  const marginColor =
    netMarginPct >= 15
      ? "text-green-600"
      : netMarginPct >= 5
        ? "text-yellow-600"
        : "text-red-600";
  const marginBg =
    netMarginPct >= 15
      ? "bg-green-500"
      : netMarginPct >= 5
        ? "bg-yellow-500"
        : "bg-red-500";

  // Cost structure bar widths (guarded against zero / negative)
  const total = sellTotal > 0 ? sellTotal : 1;
  const pctOf = (n: number) => {
    if (!isFinite(n) || n <= 0) return 0;
    return Math.min(100, (n / total) * 100);
  };

  // Variance spread for display
  const varianceSpread = Math.abs(worstCaseProfit - bestCaseProfit);
  const halfSpread = varianceSpread / 2;

  // ─── "View totals in <currency>" ───
  // Lets the user preview every total in a chosen display currency. Defaults
  // to the sell currency. When changed, fetches a fresh rate map keyed by
  // sellCurrency (cached 1h server-side) so the conversion is live.
  const [displayCurrency, setDisplayCurrency] = React.useState<string>(
    (sellCurrency || "USD").toUpperCase(),
  );
  const [rateMap, setRateMap] = React.useState<Record<string, number>>({});
  const [rateMapAt, setRateMapAt] = React.useState<string>("");
  const [rateMapLoading, setRateMapLoading] = React.useState(false);

  // Re-sync displayCurrency when sellCurrency changes (e.g. new calc loaded).
  React.useEffect(() => {
    setDisplayCurrency((sellCurrency || "USD").toUpperCase());
  }, [sellCurrency]);

  React.useEffect(() => {
    let cancelled = false;
    const base = (sellCurrency || "USD").toUpperCase();
    setRateMapLoading(true);
    fetch(`/api/exchange-rates?base=${encodeURIComponent(base)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => {
        if (cancelled) return;
        setRateMap(data.rates || {});
        setRateMapAt(data.fetchedAt || new Date().toISOString());
      })
      .catch(() => {
        if (cancelled) return;
        setRateMap({});
      })
      .finally(() => !cancelled && setRateMapLoading(false));
    return () => { cancelled = true; };
  }, [sellCurrency]);

  // Rate to convert from sellCurrency → displayCurrency.
  const displayRate = React.useMemo(() => {
    const s = (sellCurrency || "USD").toUpperCase();
    const d = displayCurrency.toUpperCase();
    if (s === d) return 1;
    // rateMap[d] means "1 sellCurrency = rateMap[d] d"
    const r = rateMap[d];
    return r && r > 0 ? r : 1;
  }, [rateMap, displayCurrency, sellCurrency]);

  // Helper: convert a value in sellCurrency to displayCurrency.
  const toDisplay = (n: number) => {
    if (!isFinite(n)) return 0;
    return n * displayRate;
  };
  // Helper: convert a value in buyCurrency to displayCurrency (cross via sell).
  const buyToDisplay = (n: number) => {
    if (!isFinite(n)) return 0;
    // n is in buyCurrency. We have rateMap keyed by sellCurrency. To convert
    // buy → display, we need: n * (1 / exchangeRate) to get to sellCurrency,
    // then multiply by displayRate.
    if (!currenciesDiffer) return toDisplay(n);
    const fx = exchangeRate && exchangeRate > 0 ? exchangeRate : 1;
    const inSell = n * fx;
    return toDisplay(inSell);
  };

  return (
    <Card className="sticky top-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="size-4" />
          {t("misc-live-cost-breakdown")}
          <span className="ml-auto flex items-center gap-1.5">
            <Globe2 className="size-3.5 text-muted-foreground" />
            <Select value={displayCurrency} onValueChange={setDisplayCurrency}>
              <SelectTrigger className="h-7 w-[88px] text-xs px-2 py-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {DISPLAY_CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">
                    <span className="font-mono">{c}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        </CardTitle>
        {displayCurrency !== (sellCurrency || "USD").toUpperCase() && (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1.5 mt-1">
            <span className="font-medium">1 {sellCurrency} = {displayRate.toFixed(4)} {displayCurrency}</span>
            <span className="opacity-50">·</span>
            <span>{rateMapLoading ? t("misc-fetching-live") : (rateMapAt ? t("misc-updated-time").replace("${time}", new Date(rateMapAt).toLocaleTimeString()) : t("misc-no-rate-available"))}</span>
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* BUY SIDE */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
            <DollarSign className="size-3" /> {t("misc-buy-side")}
          </div>
          <div className="flex justify-between">
            <span>{t("misc-buy-price-qty")}</span>
            <span className="font-mono">
              {fmtMoney(buyPricePerUnit, buyCurrency)} × {quantity} {unit}
            </span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>{t("misc-buy-total-colon")}</span>
            <span className="font-mono">{fmtMoney(buyTotal, buyCurrency)}</span>
          </div>
          {displayCurrency !== (buyCurrency || "USD").toUpperCase() && (
            <div className="flex justify-between text-xs text-muted-foreground italic">
              <span>{t("misc-in-currency").replace("${currency}", displayCurrency)}</span>
              <span className="font-mono">{fmtMoney(buyToDisplay(buyTotal), displayCurrency)}</span>
            </div>
          )}
          {currenciesDiffer && (
            <div className="flex justify-between text-xs text-blue-600">
              <span>{t("misc-fx-rate")}</span>
              <span className="font-mono">
                1 {buyCurrency} = {exchangeRate.toFixed(4)} {sellCurrency}
              </span>
            </div>
          )}
          {currenciesDiffer && (
            <div className="flex justify-between text-xs text-blue-600">
              <span>{t("misc-buy-total-in-cur").replace("${currency}", sellCurrency)}</span>
              <span className="font-mono">
                {fmtMoney(buyTotalInSellCurrency, sellCurrency)}
              </span>
            </div>
          )}
        </div>

        <Separator />

        {/* COST LINES */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
            <Ship className="size-3" /> {t("misc-costs-freight")}
          </div>
          {!hasCosts ? (
            <p className="text-xs text-muted-foreground italic">
              {t("misc-no-cost-lines-added")}
            </p>
          ) : (
            <div className="space-y-1">
              {costLines.map((line, i) => {
                const lineCurrency = (line.currency || buyCurrency).toUpperCase();
                const isForeign = lineCurrency !== buyCurrency.toUpperCase();
                const converted = typeof line.converted_amount === "number"
                  ? line.converted_amount
                  : (line.amount || 0) * (line.fx_rate || 1);
                return (
                  <div key={i} className="flex flex-col gap-0.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground truncate pr-2">{line.label}:</span>
                      <span className="font-mono whitespace-nowrap">
                        {fmtMoney(line.amount, lineCurrency)}
                      </span>
                    </div>
                    {isForeign && (
                      <div className="flex justify-between text-[10px] text-blue-600 dark:text-blue-400">
                        <span className="italic">
                          FX {line.fx_rate?.toFixed(4) || "—"} →
                        </span>
                        <span className="font-mono">
                          {fmtMoney(converted, buyCurrency)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="flex justify-between font-medium pt-1 border-t">
                <span>{t("misc-total-costs")}</span>
                <span className="font-mono">{fmtMoney(totalCosts, buyCurrency)}</span>
              </div>
              {currenciesDiffer && (
                <div className="flex justify-between text-xs text-blue-600">
                  <span>{t("misc-in-currency").replace("${currency}", sellCurrency)}</span>
                  <span className="font-mono">
                    {fmtMoney(totalCostsInSellCurrency, sellCurrency)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* LANDED COST */}
        <div className="bg-muted/30 rounded-lg p-3 space-y-1">
          <div className="flex justify-between font-semibold">
            <span>{t("misc-landed-cost-total")}</span>
            <span className="font-mono">
              {fmtMoney(landedCostInSellCurrency, sellCurrency)}
            </span>
          </div>
          {displayCurrency !== (sellCurrency || "USD").toUpperCase() && (
            <div className="flex justify-between text-xs text-muted-foreground italic">
              <span>{t("misc-in-currency").replace("${currency}", displayCurrency)}</span>
              <span className="font-mono">{fmtMoney(toDisplay(landedCostInSellCurrency), displayCurrency)}</span>
            </div>
          )}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t("misc-per-unit").replace("${unit}", unit)}</span>
            <span className="font-mono">
              {fmtMoney(landedCostPerUnit, sellCurrency)}
            </span>
          </div>
        </div>

        {/* SELL SIDE */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
            <TrendingUp className="size-3" /> {t("misc-sell-side")}
          </div>
          <div className="flex justify-between">
            <span>{t("misc-sell-price-qty")}</span>
            <span className="font-mono">
              {fmtMoney(sellPricePerUnit, sellCurrency)} × {quantity} {unit}
            </span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>{t("misc-sell-total-colon")}</span>
            <span className="font-mono">{fmtMoney(sellTotal, sellCurrency)}</span>
          </div>
          {displayCurrency !== (sellCurrency || "USD").toUpperCase() && (
            <div className="flex justify-between text-xs text-muted-foreground italic">
              <span>{t("misc-in-currency").replace("${currency}", displayCurrency)}</span>
              <span className="font-mono">{fmtMoney(toDisplay(sellTotal), displayCurrency)}</span>
            </div>
          )}
        </div>

        {/* BANK COSTS */}
        {hasBankCosts && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <Banknote className="size-3" /> {t("misc-bank-trade-finance")}
              </div>
              <div className="space-y-1">
                {bankCosts.map((bc) => (
                  <div key={bc.id} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{bc.label}:</span>
                    <span className="font-mono">
                      {fmtMoney(bc.amount, sellCurrency)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between font-medium pt-1 border-t">
                  <span>{t("misc-total-bank-costs")}:</span>
                  <span className="font-mono">
                    {fmtMoney(totalBankCosts, sellCurrency)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* TRANSFER FEES */}
        {hasTransferFees && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <Send className="size-3" /> {t("misc-international-transfers")}
              </div>
              <div className="space-y-1">
                {transferFees.map((tf) => (
                  <div key={tf.id} className="flex justify-between text-xs">
                    <span className="text-muted-foreground truncate pr-2" title={tf.description || tf.label}>
                      {tf.label}:
                    </span>
                    <span className="font-mono">
                      {fmtMoney(tf.amount, sellCurrency)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between font-medium pt-1 border-t">
                  <span>{t("misc-total-transfer-fees")}:</span>
                  <span className="font-mono">
                    {fmtMoney(totalTransferFees, sellCurrency)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* DOCUMENTATION COSTS */}
        {hasDocCosts && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <FileCheck className="size-3" /> {t("misc-documentation-label")}
              </div>
              <div className="space-y-1">
                {documentationCosts.map((dc) => (
                  <div key={dc.id} className="flex justify-between text-xs">
                    <span className="text-muted-foreground truncate pr-2" title={dc.description || dc.label}>
                      {dc.label}:
                    </span>
                    <span className="font-mono">
                      {fmtMoney(dc.amount, sellCurrency)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between font-medium pt-1 border-t">
                  <span>{t("misc-total-documentation")}:</span>
                  <span className="font-mono">
                    {fmtMoney(totalDocumentationCosts, sellCurrency)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* COMMISSION */}
        {hasCommission && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <Percent className="size-3" /> {t("misc-commission-label")}
              </div>
              <div className="flex justify-between text-xs">
                <span>
                  {t("misc-commission-label")} ({commissionTypeLabel(commissionType, commissionRate)}):
                </span>
                <span className="font-mono text-amber-600">
                  -{fmtMoney(commissionAmount, sellCurrency)}
                </span>
              </div>
            </div>
          </>
        )}

        {/* PROFIT SUMMARY */}
        <Separator />
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
            <TrendingUp className="size-3" /> {t("misc-profit-summary")}
          </div>

          {/* Gross profit */}
          <div className="flex justify-between">
            <span>{t("misc-gross-profit-colon")}</span>
            <span
              className={cn(
                "font-mono font-semibold",
                grossProfit >= 0 ? "text-green-600" : "text-red-600",
              )}
            >
              {fmtMoney(grossProfit, sellCurrency)}
            </span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t("misc-gross-margin-colon")}</span>
            <span className={marginColor}>{fmtPct(grossMarginPct)}</span>
          </div>

          {(hasBankCosts || hasTransferFees || hasDocCosts) && (
            <div className="space-y-0.5">
              {hasBankCosts && (
                <div className="flex justify-between text-xs text-amber-600">
                  <span>{t("misc-bank-costs-colon")}</span>
                  <span className="font-mono">
                    -{fmtMoney(totalBankCosts, sellCurrency)}
                  </span>
                </div>
              )}
              {hasTransferFees && (
                <div className="flex justify-between text-xs text-amber-600">
                  <span>{t("misc-transfer-fees-colon")}</span>
                  <span className="font-mono">
                    -{fmtMoney(totalTransferFees, sellCurrency)}
                  </span>
                </div>
              )}
              {hasDocCosts && (
                <div className="flex justify-between text-xs text-amber-600">
                  <span>{t("misc-documentation-colon")}</span>
                  <span className="font-mono">
                    -{fmtMoney(totalDocumentationCosts, sellCurrency)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Profit before commission (the commission base) */}
          {(hasBankCosts || hasTransferFees || hasDocCosts) && (
            <div className="flex justify-between text-xs border-t pt-1">
              <span className="text-muted-foreground">
                {commissionType === "percent_profit"
                  ? t("misc-profit-before-commission-base")
                  : `${t("misc-profit-before-commission")}:`}
              </span>
              <span
                className={cn(
                  "font-mono",
                  profitBeforeCommission >= 0 ? "text-green-600" : "text-red-600",
                )}
              >
                {fmtMoney(profitBeforeCommission, sellCurrency)}
              </span>
            </div>
          )}

          {hasCommission && (
            <div className="flex justify-between text-xs text-amber-600">
              <span>{t("misc-commission-colon")}:</span>
              <span className="font-mono">
                -{fmtMoney(commissionAmount, sellCurrency)}
              </span>
            </div>
          )}

          {/* Net profit (THE BIG NUMBER) */}
          <div className="bg-primary/5 rounded-lg p-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-bold text-base">{t("misc-net-profit-bold")}</span>
              <span
                className={cn(
                  "font-mono font-bold text-lg",
                  netProfit >= 0 ? "text-green-600" : "text-red-600",
                )}
              >
                {fmtMoney(netProfit, sellCurrency)}
              </span>
            </div>
            {displayCurrency !== (sellCurrency || "USD").toUpperCase() && (
              <div className="flex justify-between text-xs text-muted-foreground italic">
                <span>{t("misc-in-currency").replace("${currency}", displayCurrency)}</span>
                <span className="font-mono">{fmtMoney(toDisplay(netProfit), displayCurrency)}</span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground">{t("misc-net-margin-colon")}</span>
              <span className={cn("font-mono font-semibold", marginColor)}>
                {fmtPct(netMarginPct)}
              </span>
            </div>
            <Progress
              value={Math.max(0, Math.min(100, netMarginPct))}
              className={cn("h-2", marginBg)}
            />
          </div>

          {/* Per unit */}
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t("misc-profit-per-unit").replace("${unit}", unit)}</span>
            <span className="font-mono">
              {fmtMoney(profitPerUnit, sellCurrency)}
            </span>
          </div>
        </div>

        {/* VARIANCE ANALYSIS (±10%) */}
        <Separator />
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
            <Gauge className="size-3" /> {t("misc-scenario-analysis")}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t("misc-scenario-desc")}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {/* Best case */}
            <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded p-2 text-center">
              <div className="text-[10px] text-muted-foreground">{t("misc-best-case")}</div>
              <div
                className={cn(
                  "font-mono font-semibold text-xs",
                  bestCaseProfit >= 0 ? "text-green-600" : "text-red-600",
                )}
              >
                {fmtMoney(bestCaseProfit, sellCurrency)}
              </div>
            </div>
            {/* Expected */}
            <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded p-2 text-center">
              <div className="text-[10px] text-muted-foreground">{t("misc-expected")}</div>
              <div
                className={cn(
                  "font-mono font-semibold text-xs",
                  netProfit >= 0 ? "text-chart-1" : "text-destructive",
                )}
              >
                {fmtMoney(netProfit, sellCurrency)}
              </div>
            </div>
            {/* Worst case */}
            <div className="bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-900 rounded p-2 text-center">
              <div className="text-[10px] text-muted-foreground">{t("misc-worst-case")}</div>
              <div
                className={cn(
                  "font-mono font-semibold text-xs",
                  worstCaseProfit < 0 ? "text-red-600" : "text-orange-600",
                )}
              >
                {fmtMoney(worstCaseProfit, sellCurrency)}
              </div>
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground pt-1">
            <span>{t("misc-variance-spread")}</span>
            <span className="font-mono">
              ±{fmtMoney(halfSpread, sellCurrency)}
            </span>
          </div>
        </div>

        {/* Cost structure visualization */}
        {sellTotal > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                {t("misc-cost-structure")}
              </div>
              <div className="h-4 rounded-full overflow-hidden flex bg-muted/40">
                {/* Buy price */}
                <div
                  className="bg-blue-500"
                  style={{ width: `${pctOf(buyTotalInSellCurrency)}%` }}
                  title={`Buy: ${fmtMoney(buyTotalInSellCurrency, sellCurrency)}`}
                />
                {/* Costs */}
                <div
                  className="bg-orange-500"
                  style={{ width: `${pctOf(totalCostsInSellCurrency)}%` }}
                  title={`Costs: ${fmtMoney(totalCostsInSellCurrency, sellCurrency)}`}
                />
                {/* Bank costs */}
                {hasBankCosts && (
                  <div
                    className="bg-purple-500"
                    style={{ width: `${pctOf(totalBankCosts)}%` }}
                    title={`Bank: ${fmtMoney(totalBankCosts, sellCurrency)}`}
                  />
                )}
                {/* Transfer fees */}
                {hasTransferFees && (
                  <div
                    className="bg-cyan-500"
                    style={{ width: `${pctOf(totalTransferFees)}%` }}
                    title={`Transfers: ${fmtMoney(totalTransferFees, sellCurrency)}`}
                  />
                )}
                {/* Documentation */}
                {hasDocCosts && (
                  <div
                    className="bg-indigo-500"
                    style={{ width: `${pctOf(totalDocumentationCosts)}%` }}
                    title={`Docs: ${fmtMoney(totalDocumentationCosts, sellCurrency)}`}
                  />
                )}
                {/* Commission */}
                {hasCommission && (
                  <div
                    className="bg-amber-500"
                    style={{ width: `${pctOf(commissionAmount)}%` }}
                    title={`Commission: ${fmtMoney(commissionAmount, sellCurrency)}`}
                  />
                )}
                {/* Profit */}
                <div
                  className={cn(netProfit >= 0 ? "bg-green-500" : "bg-red-500")}
                  style={{ width: `${pctOf(netProfit)}%` }}
                  title={`Profit: ${fmtMoney(netProfit, sellCurrency)}`}
                />
              </div>
              <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-500" /> {t("misc-legend-buy")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-orange-500" /> {t("misc-legend-costs")}
                </span>
                {hasBankCosts && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-purple-500" /> {t("misc-legend-bank")}
                  </span>
                )}
                {hasTransferFees && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-cyan-500" /> {t("misc-legend-transfers")}
                  </span>
                )}
                {hasDocCosts && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-indigo-500" /> {t("misc-legend-docs")}
                  </span>
                )}
                {hasCommission && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-amber-500" /> {t("misc-legend-commission")}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      netProfit >= 0 ? "bg-green-500" : "bg-red-500",
                    )}
                  />{" "}
                  {t("misc-legend-profit")}
                </span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default CostBreakdownPanel;
