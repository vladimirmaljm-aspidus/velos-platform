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
import {
  Leaf,
  Loader2,
  Calculator,
  Info,
  MapPin,
  Ship,
  Lightbulb,
  Route,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { PORT_CATALOG } from "@/lib/marketplace/calculators";
import type {
  CarbonEstimate,
  ContainerType,
} from "@/lib/supabase/marketplace-logistics-types";
import { CONTAINER_TYPE_LABELS } from "@/lib/supabase/marketplace-logistics-types";

const CONTAINER_TYPES = Object.keys(CONTAINER_TYPE_LABELS) as ContainerType[];

/**
 * CarbonFootprint — CO2 emissions estimator for a sea shipment.
 *
 * Inputs: origin port, destination port, container type, weight (tonnes).
 * Result: tonnes of CO2-equivalent, a plain-language equivalent, the
 * distance (nm), and a list of mitigation suggestions.
 *
 * Calls GET /api/marketplace/calculators/carbon — the heavy lifting is
 * done server-side in src/lib/marketplace/calculators.ts using an IMO-
 * style gCO2e / tonne-km methodology.
 */
export function CarbonFootprint() {
  const t = useT();
  const [from, setFrom] = useState("cnsah");
  const [to, setTo] = useState("nlrtm");
  const [container, setContainer] = useState<ContainerType>("40gp");
  const [weight, setWeight] = useState("18");

  const q = useQuery<{ estimate: CarbonEstimate }>({
    queryKey: ["marketplace-carbon-calc", from, to, container, weight],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/calculators/carbon?port1=${encodeURIComponent(from)}&port2=${encodeURIComponent(to)}&container=${container}&weight=${encodeURIComponent(weight)}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to compute carbon estimate.");
      }
      return r.json();
    },
    enabled: !!from && !!to && Number(weight) > 0,
    staleTime: 60_000,
  });

  const estimate = q.data?.estimate;

  // Pick the badge color based on the CO2 intensity bucket.
  const intensityBucket = (() => {
    if (!estimate) return null;
    const tons = estimate.co2_tons;
    if (tons === 0) return null;
    if (tons < 0.5) return { label: t("marketplace-carbon-low"), cls: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
    if (tons < 2) return { label: t("marketplace-carbon-moderate"), cls: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400" };
    if (tons < 10) return { label: t("marketplace-carbon-high"), cls: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400" };
    return { label: t("marketplace-carbon-very-high"), cls: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400" };
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Leaf className="h-4 w-4" />
          {t("marketplace-carbon-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("marketplace-carbon-desc")}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="cb-from">{t("marketplace-carbon-from-port")}</Label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger id="cb-from" className="w-full">
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
            <Label htmlFor="cb-to">{t("marketplace-carbon-to-port")}</Label>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger id="cb-to" className="w-full">
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
            <Label htmlFor="cb-ct">{t("marketplace-carbon-container")}</Label>
            <Select value={container} onValueChange={(v) => setContainer(v as ContainerType)}>
              <SelectTrigger id="cb-ct" className="w-full">
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
          <div>
            <Label htmlFor="cb-w">{t("marketplace-carbon-weight")}</Label>
            <Input
              id="cb-w"
              type="number"
              min="0"
              step="0.001"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
        </div>

        {q.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("marketplace-carbon-loading")}
          </div>
        )}
        {q.isError && (
          <div className="text-xs text-rose-600">
            {(q.error as Error)?.message || "Failed to compute."}
          </div>
        )}
        {estimate && (
          <div className="space-y-3">
            {/* Headline CO2 number */}
            <div className="flex items-center gap-3 rounded-md bg-gradient-to-br from-emerald-500/10 to-blue-500/10 p-4">
              <Leaf className="h-8 w-8 text-emerald-600 shrink-0" />
              <div className="flex-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("marketplace-carbon-estimated-co2")}
                </p>
                <p className="text-2xl font-bold tracking-tight">
                  {estimate.co2_tons.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <span className="text-sm font-normal text-muted-foreground ml-1">tCO₂e</span>
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {estimate.equivalent}
                </p>
              </div>
              {intensityBucket && (
                <Badge variant="outline" className={intensityBucket.cls}>
                  {intensityBucket.label}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <ResultCell
                label={t("marketplace-carbon-route")}
                value={`${estimate.from_port.toUpperCase()} → ${estimate.to_port.toUpperCase()}`}
                icon={MapPin}
              />
              <ResultCell
                label={t("marketplace-carbon-distance")}
                value={estimate.distance_nm !== null ? `${estimate.distance_nm.toLocaleString()} nm` : "—"}
                icon={Route}
              />
              <ResultCell
                label={t("marketplace-carbon-cargo-weight")}
                value={`${estimate.weight_tons.toLocaleString()} t`}
                icon={Ship}
              />
            </div>

            {/* Suggestions */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Lightbulb className="h-3 w-3" />
                {t("marketplace-carbon-suggestions")}
              </p>
              <ul className="space-y-1.5">
                {estimate.suggestions.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span className="text-emerald-600 mt-0.5">•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{t("marketplace-carbon-disclaimer")}</span>
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
          {t("marketplace-carbon-recalculate")}
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultCell({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof MapPin;
}) {
  return (
    <div className="rounded-md bg-muted/30 p-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}
