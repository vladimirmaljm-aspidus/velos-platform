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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Package, Loader2, Calculator, Info, Boxes, Layers } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { CONTAINER_SPECS } from "@/lib/marketplace/calculators";
import type {
  ContainerLoadability,
  ContainerType,
} from "@/lib/supabase/marketplace-logistics-types";
import { CONTAINER_TYPE_LABELS } from "@/lib/supabase/marketplace-logistics-types";

const CONTAINER_TYPES = Object.keys(CONTAINER_TYPE_LABELS) as ContainerType[];

/**
 * ContainerCalculator — container loadability calculator.
 *
 * Inputs: container type, package weight (kg), package volume (m³).
 * Result: max_packages (binding constraint), total_weight, total_volume,
 * weight_utilization %, volume_utilization %, overall utilization %,
 * and a note describing the binding constraint.
 *
 * Calls GET /api/marketplace/calculators/container — the heavy lifting is
 * done server-side in src/lib/marketplace/calculators.ts.
 */
export function ContainerCalculator() {
  const t = useT();
  const [container, setContainer] = useState<ContainerType>("40gp");
  const [pkgWeight, setPkgWeight] = useState("25");
  const [pkgVolume, setPkgVolume] = useState("0.05");

  const q = useQuery<{ result: ContainerLoadability }>({
    queryKey: ["marketplace-container-calc", container, pkgWeight, pkgVolume],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/calculators/container?containerType=${container}&pkgWeight=${encodeURIComponent(pkgWeight)}&pkgVolume=${encodeURIComponent(pkgVolume)}`,
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to compute loadability.");
      }
      return r.json();
    },
    enabled: Number(pkgWeight) > 0 || Number(pkgVolume) > 0,
    staleTime: 60_000,
  });

  const result = q.data?.result;
  const spec = CONTAINER_SPECS[container];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4" />
          {t("marketplace-container-calculator-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("marketplace-container-calculator-desc")}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="co-ct">{t("marketplace-container-type")}</Label>
            <Select value={container} onValueChange={(v) => setContainer(v as ContainerType)}>
              <SelectTrigger id="co-ct" className="w-full">
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
            <Label htmlFor="co-pw">{t("marketplace-container-pkg-weight")}</Label>
            <Input
              id="co-pw"
              type="number"
              min="0"
              step="0.001"
              value={pkgWeight}
              onChange={(e) => setPkgWeight(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="co-pv">{t("marketplace-container-pkg-volume")}</Label>
            <Input
              id="co-pv"
              type="number"
              min="0"
              step="0.0001"
              value={pkgVolume}
              onChange={(e) => setPkgVolume(e.target.value)}
            />
          </div>
        </div>

        {/* Container spec card */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm bg-muted/30 rounded-md p-3">
          <div>
            <p className="text-xs uppercase text-muted-foreground">{t("marketplace-container-max-payload")}</p>
            <p className="font-medium mt-0.5">{spec.max_payload_kg.toLocaleString()} kg</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">{t("marketplace-container-max-volume")}</p>
            <p className="font-medium mt-0.5">{spec.max_volume_m3} m³</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">{t("marketplace-container-tare")}</p>
            <p className="font-medium mt-0.5">{spec.tare_kg.toLocaleString()} kg</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">{t("marketplace-container-max-gross")}</p>
            <p className="font-medium mt-0.5">{spec.max_gross_kg.toLocaleString()} kg</p>
          </div>
        </div>

        {q.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("marketplace-container-loading")}
          </div>
        )}
        {q.isError && (
          <div className="text-sm text-rose-600">
            {(q.error as Error)?.message || "Failed to compute."}
          </div>
        )}
        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <ResultCell
                label={t("marketplace-container-max-packages")}
                value={result.max_packages.toLocaleString()}
                highlight
                icon={Boxes}
              />
              <ResultCell
                label={t("marketplace-container-total-weight")}
                value={`${result.total_weight_kg.toLocaleString()} kg`}
              />
              <ResultCell
                label={t("marketplace-container-total-volume")}
                value={`${result.total_volume_m3.toLocaleString()} m³`}
              />
              <ResultCell
                label={t("marketplace-container-by-weight")}
                value={result.max_packages_by_weight.toLocaleString()}
                icon={Layers}
              />
              <ResultCell
                label={t("marketplace-container-by-volume")}
                value={result.max_packages_by_volume.toLocaleString()}
                icon={Layers}
              />
              <ResultCell
                label={t("marketplace-container-utilization")}
                value={`${result.utilization_pct.toFixed(1)}%`}
              />
            </div>

            {/* Utilization bars */}
            <div className="space-y-2">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("marketplace-container-weight-util")}</span>
                  <span className="font-medium">{result.weight_utilization_pct.toFixed(1)}%</span>
                </div>
                <Progress value={result.weight_utilization_pct} className="h-2" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("marketplace-container-volume-util")}</span>
                  <span className="font-medium">{result.volume_utilization_pct.toFixed(1)}%</span>
                </div>
                <Progress value={result.volume_utilization_pct} className="h-2" />
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/30 rounded-md p-3">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{result.notes}</span>
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
          {t("marketplace-container-recalculate")}
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
  icon?: typeof Boxes;
}) {
  return (
    <div className={`rounded-md p-3 ${highlight ? "bg-emerald-500/10" : "bg-muted/30"}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}
