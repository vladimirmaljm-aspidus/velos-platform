"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  type TooltipProps,
} from "recharts";
import { Loader2, Globe2, Download, Upload } from "lucide-react";
import { useT } from "@/lib/i18n/store";

interface TopCountry {
  country: string;
  count: number;
  percentage: number;
  name: string;
  flag: string;
}

interface TopCountriesResponse {
  importers: TopCountry[];
  exporters: TopCountry[];
  sampleSize: number;
}

interface TopCountriesPanelProps {
  category?: string;
  days?: number;
  limit?: number;
}

/**
 * TopCountriesPanel — top importing/exporting countries per category,
 * for the market-intelligence dashboard.
 *
 * Calls GET /api/marketplace/intelligence/top-countries?category=... &days=...
 *
 * Renders two horizontal bar charts (importers = buyers / exporters =
 * sellers) with the country flag + name as the X axis.
 */
export function TopCountriesPanel({
  category,
  days = 30,
  limit = 10,
}: TopCountriesPanelProps) {
  const t = useT();
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  params.set("days", String(days));
  params.set("limit", String(limit));
  const q = useQuery<TopCountriesResponse>({
    queryKey: ["mkt-intel-top-countries", category ?? "", days, limit],
    queryFn: async () => {
      const r = await fetch(
        `/api/marketplace/intelligence/top-countries?${params}`,
      );
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 0,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Globe2 className="h-4 w-4" />
            {t("marketplace-intel-top-countries-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Globe2 className="h-4 w-4" />
            {t("marketplace-intel-top-countries-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-load-error")}
        </CardContent>
      </Card>
    );
  }

  const { importers, exporters, sampleSize } = q.data;

  if (sampleSize === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Globe2 className="h-4 w-4" />
            {t("marketplace-intel-top-countries-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("marketplace-intel-no-data")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-1.5">
          <Globe2 className="h-4 w-4" />
          {t("marketplace-intel-top-countries-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <p className="text-xs font-medium flex items-center gap-1.5 mb-2">
            <Download className="h-3 w-3" />
            {t("marketplace-intel-top-importers")}
          </p>
          {importers.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3 text-center">
              {t("marketplace-intel-no-data")}
            </p>
          ) : (
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={importers}
                  layout="vertical"
                  margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <YAxis
                    type="category"
                    dataKey={(d) => `${d.flag} ${d.name}`}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    width={110}
                  />
                  <ChartTooltip content={<CountryTooltip />} />
                  <Bar
                    dataKey="count"
                    name={t("marketplace-intel-count")}
                    fill="#0ea5e9"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div>
          <p className="text-xs font-medium flex items-center gap-1.5 mb-2">
            <Upload className="h-3 w-3" />
            {t("marketplace-intel-top-exporters")}
          </p>
          {exporters.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3 text-center">
              {t("marketplace-intel-no-data")}
            </p>
          ) : (
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={exporters}
                  layout="vertical"
                  margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <YAxis
                    type="category"
                    dataKey={(d) => `${d.flag} ${d.name}`}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    width={110}
                  />
                  <ChartTooltip content={<CountryTooltip />} />
                  <Bar
                    dataKey="count"
                    name={t("marketplace-intel-count")}
                    fill="#B45309"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function CountryTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as TopCountry | undefined;
  if (!row) return null;
  return (
    <div className="rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md">
      <p className="font-medium mb-1">
        {row.flag} {row.name} ({row.country})
      </p>
      <p className="text-muted-foreground">
        {payload[0]?.name}:{" "}
        <span className="text-foreground font-medium">{row.count}</span>
      </p>
      <p className="text-muted-foreground">
        {row.percentage}% of total
      </p>
    </div>
  );
}
