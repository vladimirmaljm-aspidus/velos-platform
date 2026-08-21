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
import { Loader2, Calculator, FileCheck, Info, Receipt } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";
import type { CustomsEstimate } from "@/lib/supabase/marketplace-logistics-types";
import { COUNTRIES } from "@/lib/data/reference";

/**
 * CustomsCalculator — HS-code-based customs duty + VAT calculator.
 *
 * Inputs: HS code (4–6 digits), origin country (ISO 3166-1 alpha-2),
 * destination country, declared value (in any currency — the result's
 * currency is the destination's).
 * Result: duty_rate %, duty_amount, vat_rate %, vat_amount, total_charges,
 * plus a note on the basis (HS chapter, applied MFN rate, VAT base).
 *
 * Calls GET /api/marketplace/calculators/customs — the heavy lifting is
 * done server-side in src/lib/marketplace/calculators.ts.
 */
export function CustomsCalculator() {
  const t = useT();
  const [hsCode, setHsCode] = useState("7204");
  const [origin, setOrigin] = useState("DE");
  const [dest, setDest] = useState("RS");
  const [value, setValue] = useState("25000");

  const q = useQuery<{ estimate: CustomsEstimate }>({
    queryKey: ["marketplace-customs-calc", hsCode, origin, dest, value],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/calculators/customs?hsCode=${encodeURIComponent(hsCode)}&origin=${encodeURIComponent(origin)}&dest=${encodeURIComponent(dest)}&value=${encodeURIComponent(value)}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to compute customs.");
      }
      return r.json();
    },
    enabled: hsCode.length >= 4 && origin.length === 2 && dest.length === 2 && Number(value) > 0,
    staleTime: 60_000,
  });

  const estimate = q.data?.estimate;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileCheck className="h-4 w-4" />
          {t("marketplace-customs-calculator-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("marketplace-customs-calculator-desc")}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Label htmlFor="c-hs">{t("marketplace-customs-hs-code")}</Label>
            <Input
              id="c-hs"
              value={hsCode}
              onChange={(e) => setHsCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="7204"
              maxLength={6}
            />
          </div>
          <div>
            <Label htmlFor="c-origin">{t("marketplace-customs-origin")}</Label>
            <select
              id="c-origin"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={origin}
              onChange={(e) => setOrigin(e.target.value.toUpperCase())}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="c-dest">{t("marketplace-customs-dest")}</Label>
            <select
              id="c-dest"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={dest}
              onChange={(e) => setDest(e.target.value.toUpperCase())}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="c-value">{t("marketplace-customs-value")}</Label>
            <Input
              id="c-value"
              type="number"
              min="0"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </div>

        {q.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("marketplace-customs-loading")}
          </div>
        )}
        {q.isError && (
          <div className="text-xs text-rose-600">
            {(q.error as Error)?.message || "Failed to compute."}
          </div>
        )}
        {estimate && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <ResultCell
                label={t("marketplace-customs-duty-rate")}
                value={`${estimate.duty_rate.toFixed(2)}%`}
              />
              <ResultCell
                label={t("marketplace-customs-duty-amount")}
                value={fmtMoney(estimate.duty_amount, estimate.currency)}
                highlight
              />
              <ResultCell
                label={t("marketplace-customs-vat-rate")}
                value={`${estimate.vat_rate.toFixed(2)}%`}
              />
              <ResultCell
                label={t("marketplace-customs-vat-amount")}
                value={fmtMoney(estimate.vat_amount, estimate.currency)}
              />
              <ResultCell
                label={t("marketplace-customs-declared-value")}
                value={fmtMoney(estimate.declared_value, estimate.currency)}
              />
              <ResultCell
                label={t("marketplace-customs-total")}
                value={fmtMoney(estimate.total_charges, estimate.currency)}
                highlight
                icon={Receipt}
              />
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{estimate.notes}</span>
            </div>
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => q.refetch()}
          disabled={q.isFetching || hsCode.length < 4}
          className="w-full"
        >
          {q.isFetching ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Calculator className="h-4 w-4 mr-1" />}
          {t("marketplace-customs-recalculate")}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultCell({
  label,
  value,
  highlight,
  icon: Icon,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  icon?: typeof Receipt;
}) {
  return (
    <div className={`rounded-md p-2 ${highlight ? "bg-emerald-500/10" : "bg-muted/30"}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}
