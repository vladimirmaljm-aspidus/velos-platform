"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Landmark,
  Shield,
  FileText,
  Loader2,
  Calculator,
  Info,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import type {
  FactoringCost,
  InsurancePremium,
  LCType,
  RiskLevel,
  LCChecklist,
} from "@/lib/supabase/marketplace-finance-types";
import { calculateLCChecklist } from "@/lib/data/marketplace-finance-store";
import { fmtMoney } from "@/lib/utils/format";

const LC_TYPES: LCType[] = [
  "irrevocable", "revocable", "confirmed", "unconfirmed",
  "transferable", "back_to_back", "standby",
];
const LC_TYPE_LABEL_KEY: Record<LCType, string> = {
  irrevocable: "marketplace-finance-lc-type-irrevocable",
  revocable: "marketplace-finance-lc-type-revocable",
  confirmed: "marketplace-finance-lc-type-confirmed",
  unconfirmed: "marketplace-finance-lc-type-unconfirmed",
  transferable: "marketplace-finance-lc-type-transferable",
  back_to_back: "marketplace-finance-lc-type-back-to-back",
  standby: "marketplace-finance-lc-type-standby",
};
const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "very_high"];
const RISK_LEVEL_LABEL_KEY: Record<RiskLevel, string> = {
  low: "marketplace-finance-risk-low",
  medium: "marketplace-finance-risk-medium",
  high: "marketplace-finance-risk-high",
  very_high: "marketplace-finance-risk-very-high",
};

/**
 * FinanceCalculators — combined finance-instrument calculators widget.
 *
 * Three tabs:
 *   1. Factoring — invoice amount + advance % + discount rate → advance
 *      amount, discount fee, reserve, net immediate payout. Calls the
 *      GET /api/marketplace/finance/calculators/factoring route.
 *   2. Insurance — insured amount + coverage % + risk level → annual
 *      premium. Calls GET /api/marketplace/finance/calculators/insurance.
 *   3. Letter of Credit — L/C type → required-documents checklist (under
 *      UCP 600). Computed client-side via `calculateLCChecklist` (pure
 *      function, no API call).
 *
 * All three are read-only / no side-effects — they're planning tools the
 * buyer + seller use BEFORE creating an instrument (the actual instrument
 * creation happens through the marketplace post-detail flow).
 */
export function FinanceCalculators() {
  const t = useT();
  const [tab, setTab] = useState("factoring");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Calculator className="h-4 w-4" />
          {t("marketplace-finance-calculators-title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="factoring" className="text-xs sm:text-sm">
              <Landmark className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">{t("marketplace-finance-tab-factoring")}</span>
            </TabsTrigger>
            <TabsTrigger value="insurance" className="text-xs sm:text-sm">
              <Shield className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">{t("marketplace-finance-tab-insurance")}</span>
            </TabsTrigger>
            <TabsTrigger value="lc" className="text-xs sm:text-sm">
              <FileText className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">{t("marketplace-finance-tab-lc")}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="factoring" className="mt-4">
            <FactoringCalculator />
          </TabsContent>
          <TabsContent value="insurance" className="mt-4">
            <InsuranceCalculator />
          </TabsContent>
          <TabsContent value="lc" className="mt-4">
            <LCChecklistCalculator />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ─── 1. Factoring calculator ───────────────────────────────────────────────

function FactoringCalculator() {
  const t = useT();
  const [amount, setAmount] = useState("50000");
  const [discountRate, setDiscountRate] = useState("2.5");
  const [advanceRate, setAdvanceRate] = useState("80");
  const [currency, setCurrency] = useState("USD");

  const q = useQuery<{ cost: FactoringCost }>({
    queryKey: ["marketplace-finance-factoring-calc", amount, discountRate, advanceRate, currency],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/finance/calculators/factoring?amount=${encodeURIComponent(amount)}&discountRate=${encodeURIComponent(discountRate)}&advanceRate=${encodeURIComponent(advanceRate)}&currency=${currency}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to compute factoring cost.");
      }
      return r.json();
    },
    enabled: Number(amount) > 0 && Number(discountRate) >= 0 && Number(advanceRate) >= 0,
    staleTime: 60_000,
  });

  const cost = q.data?.cost;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("marketplace-finance-factoring-desc")}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <Label htmlFor="fc-amount">{t("marketplace-finance-factoring-amount")}</Label>
          <Input
            id="fc-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="fc-disc">{t("marketplace-finance-factoring-discount")}</Label>
          <Input
            id="fc-disc"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={discountRate}
            onChange={(e) => setDiscountRate(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="fc-adv">{t("marketplace-finance-factoring-advance")}</Label>
          <Input
            id="fc-adv"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={advanceRate}
            onChange={(e) => setAdvanceRate(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="fc-cur">{t("marketplace-finance-currency")}</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="fc-cur" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["USD", "EUR", "GBP", "RSD", "TRY", "RUB"].map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {q.isLoading && <CalcLoading label={t("marketplace-finance-factoring-loading")} />}
      {q.isError && <CalcError message={(q.error as Error)?.message} />}

      {cost && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-md bg-gradient-to-br from-emerald-500/10 to-blue-500/10 p-4">
            <Landmark className="h-8 w-8 text-emerald-600 shrink-0" />
            <div className="flex-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("marketplace-finance-factoring-net-payout")}
              </p>
              <p className="text-2xl font-bold tracking-tight">
                {cost.currency}{" "}
                {cost.net_payout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
              <p className="text-sm text-muted-foreground mt-1">{cost.notes}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <ResultCell label={t("marketplace-finance-factoring-advance-amount")} value={fmtMoney(cost.advance_amount, cost.currency)} />
            <ResultCell label={t("marketplace-finance-factoring-discount-fee")} value={fmtMoney(cost.discount_fee, cost.currency)} />
            <ResultCell label={t("marketplace-finance-factoring-reserve")} value={fmtMoney(cost.reserve_amount, cost.currency)} />
            <ResultCell label={t("marketplace-finance-factoring-invoice")} value={fmtMoney(cost.invoice_amount, cost.currency)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 2. Insurance calculator ───────────────────────────────────────────────

function InsuranceCalculator() {
  const t = useT();
  const [amount, setAmount] = useState("100000");
  const [coverage, setCoverage] = useState("90");
  const [risk, setRisk] = useState<RiskLevel>("medium");
  const [currency, setCurrency] = useState("USD");

  const q = useQuery<{ premium: InsurancePremium }>({
    queryKey: ["marketplace-finance-insurance-calc", amount, coverage, risk, currency],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/finance/calculators/insurance?amount=${encodeURIComponent(amount)}&coverage=${encodeURIComponent(coverage)}&risk=${risk}&currency=${currency}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to compute insurance premium.");
      }
      return r.json();
    },
    enabled: Number(amount) > 0 && Number(coverage) >= 0,
    staleTime: 60_000,
  });

  const premium = q.data?.premium;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("marketplace-finance-insurance-desc")}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <Label htmlFor="ic-amount">{t("marketplace-finance-insurance-amount")}</Label>
          <Input
            id="ic-amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ic-cov">{t("marketplace-finance-insurance-coverage")}</Label>
          <Input
            id="ic-cov"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={coverage}
            onChange={(e) => setCoverage(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ic-risk">{t("marketplace-finance-insurance-risk")}</Label>
          <Select value={risk} onValueChange={(v) => setRisk(v as RiskLevel)}>
            <SelectTrigger id="ic-risk" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RISK_LEVELS.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(RISK_LEVEL_LABEL_KEY[r])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="ic-cur">{t("marketplace-finance-currency")}</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="ic-cur" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["USD", "EUR", "GBP", "RSD", "TRY", "RUB"].map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {q.isLoading && <CalcLoading label={t("marketplace-finance-insurance-loading")} />}
      {q.isError && <CalcError message={(q.error as Error)?.message} />}

      {premium && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-md bg-gradient-to-br from-emerald-500/10 to-blue-500/10 p-4">
            <Shield className="h-8 w-8 text-emerald-600 shrink-0" />
            <div className="flex-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("marketplace-finance-insurance-annual-premium")}
              </p>
              <p className="text-2xl font-bold tracking-tight">
                {premium.currency}{" "}
                {premium.premium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                <span className="text-sm font-normal text-muted-foreground ml-1">/yr</span>
              </p>
              <p className="text-sm text-muted-foreground mt-1">{premium.notes}</p>
            </div>
            <Badge variant="outline" className={RISK_BADGE_CLASS[premium.risk_level]}>
              {t(RISK_LEVEL_LABEL_KEY[premium.risk_level])}
            </Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <ResultCell label={t("marketplace-finance-insurance-insured")} value={fmtMoney(premium.insured_amount, premium.currency)} />
            <ResultCell label={t("marketplace-finance-insurance-covered")} value={fmtMoney(premium.coverage_amount, premium.currency)} />
            <ResultCell label={t("marketplace-finance-insurance-coverage-pct")} value={`${premium.coverage_pct}%`} />
            <ResultCell label={t("marketplace-finance-insurance-base-rate")} value={`${premium.base_rate}‰`} />
          </div>
        </div>
      )}
    </div>
  );
}

const RISK_BADGE_CLASS: Record<RiskLevel, string> = {
  low: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  medium: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  high: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400",
  very_high: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

// ─── 3. L/C checklist calculator ───────────────────────────────────────────

function LCChecklistCalculator() {
  const t = useT();
  const [lcType, setLcType] = useState<LCType>("irrevocable");

  // Pure function — no fetch. Recomputes on every render (cheap).
  const checklist: LCChecklist = calculateLCChecklist(lcType);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("marketplace-finance-lc-desc")}
      </p>
      <div>
        <Label htmlFor="lc-type">{t("marketplace-finance-lc-type")}</Label>
        <Select value={lcType} onValueChange={(v) => setLcType(v as LCType)}>
          <SelectTrigger id="lc-type" className="w-full sm:w-1/2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LC_TYPES.map((l) => (
              <SelectItem key={l} value={l}>
                {t(LC_TYPE_LABEL_KEY[l])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Required documents */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t("marketplace-finance-lc-required-docs")}
        </p>
        <ul className="space-y-2">
          {checklist.required_documents.map((d) => (
            <li key={d.code} className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
              <span>{t(d.label_key)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Optional documents */}
      {checklist.optional_documents.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("marketplace-finance-lc-optional-docs")}
            </p>
            <ul className="space-y-2">
              {checklist.optional_documents.map((d) => (
                <li key={d.code} className="flex items-start gap-2 text-sm">
                  <Circle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <span>{t(d.label_key)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/30 rounded-md p-3">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span>{checklist.notes}</span>
      </div>
    </div>
  );
}

// ─── Shared sub-components ─────────────────────────────────────────────────

function ResultCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/30 p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}

function CalcLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      {label}
    </div>
  );
}

function CalcError({ message }: { message?: string }) {
  return (
    <div className="text-sm text-rose-600">{message || "Failed to compute."}</div>
  );
}

// AUDIT18 — canonical fmtMoney (lib/utils/format): the local copy used
// toLocaleString(undefined) = OS locale, so a German browser rendered
// "1.234,56 EUR" inside marketplace widgets while the rest of the app
// showed "$1,234.56" — inconsistent money formatting across the app.

