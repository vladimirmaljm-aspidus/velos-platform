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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Ship, Loader2, Calculator, Clock, MapPin, Info } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { fmtMoney } from "@/lib/utils/format";
import { PORT_CATALOG, CONTAINER_SPECS } from "@/lib/marketplace/calculators";
import type {
  ContainerType,
  FreightQuote,
} from "@/lib/supabase/marketplace-logistics-types";
import { CONTAINER_TYPE_LABELS } from "@/lib/supabase/marketplace-logistics-types";

const CONTAINER_TYPES = Object.keys(CONTAINER_TYPE_LABELS) as ContainerType[];

/**
 * FreightCalculator — port-pair freight cost + transit estimator.
 *
 * Inputs: origin port, destination port, container type.
 * Result: cost range (min/max USD) + transit-day range + the open-sea
 * distance (nautical miles) + a short note on the basis (matrix or
 * fallback heuristic).
 *
 * Calls GET /api/marketplace/calculators/freight — the heavy lifting is
 * done server-side in src/lib/marketplace/calculators.ts.
 */
export function FreightCalculator() {
  const t = useT();
  const [from, setFrom] = useState("cnsah");
  const [to, setTo] = useState("nlrtm");
  const [container, setContainer] = useState<ContainerType>("40gp");

  const q = useQuery<{ quote: FreightQuote }>({
    queryKey: ["marketplace-freight-calc", from, to, container],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/calculators/freight?port1=${encodeURIComponent(from)}&port2=${encodeURIComponent(to)}&container=${container}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to compute freight.");
      }
      return r.json();
    },
    enabled: !!from && !!to,
    staleTime: 60_000,
  });

  const quote = q.data?.quote;
  const spec = CONTAINER_SPECS[container];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Ship className="h-4 w-4" />
          {t("marketplace-freight-calculator-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("marketplace-freight-calculator-desc")}
        </p>

        {/* Inputs */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="f-from">{t("marketplace-freight-from-port")}</Label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger id="f-from" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PORT_CATALOG.map((p) => (
                  <SelectItem key={p.code} value={p.code}>
                    {p.name} ({p.country})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="f-to">{t("marketplace-freight-to-port")}</Label>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger id="f-to" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PORT_CATALOG.map((p) => (
                  <SelectItem key={p.code} value={p.code}>
                    {p.name} ({p.country})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="f-ct">{t("marketplace-freight-container")}</Label>
            <Select value={container} onValueChange={(v) => setContainer(v as ContainerType)}>
              <SelectTrigger id="f-ct" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTAINER_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CONTAINER_TYPE_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Result */}
        {q.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("marketplace-freight-loading")}
          </div>
        )}
        {q.isError && (
          <div className="text-xs text-rose-600">
            {(q.error as Error)?.message || "Failed to compute."}
          </div>
        )}
        {quote && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <ResultCell
                label={t("marketplace-freight-cost-min")}
                value={fmtMoney(quote.min, quote.currency)}
                highlight
              />
              <ResultCell
                label={t("marketplace-freight-cost-max")}
                value={fmtMoney(quote.max, quote.currency)}
                highlight
              />
              <ResultCell
                label={t("marketplace-freight-transit")}
                value={`${quote.transit_days.min}–${quote.transit_days.max} ${t("marketplace-freight-days")}`}
              />
              <ResultCell
                label={t("marketplace-freight-distance")}
                value={quote.distance_nm !== null ? `${quote.distance_nm.toLocaleString()} nm` : "—"}
              />
              <ResultCell
                label={t("marketplace-freight-container-spec")}
                value={`${spec.max_payload_kg.toLocaleString()} kg / ${spec.max_volume_m3} m³`}
              />
              <ResultCell
                label={t("marketplace-freight-route")}
                value={`${quote.from_port.toUpperCase()} → ${quote.to_port.toUpperCase()}`}
                icon={MapPin}
              />
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{quote.notes}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {t("marketplace-freight-estimate-disclaimer")}
            </div>
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="w-full"
        >
          {q.isFetching ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Calculator className="h-4 w-4 mr-1" />}
          {t("marketplace-freight-recalculate")}
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
  icon?: typeof MapPin;
}) {
  return (
    <div className={`rounded-md p-2 ${highlight ? "bg-emerald-500/10" : "bg-muted/30"}`}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}
