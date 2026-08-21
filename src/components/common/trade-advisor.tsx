"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Globe, CheckCircle2, AlertTriangle, Info, FileText,
  ChevronDown, ChevronRight, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/store";

interface TradeAdvisorProps {
  /** ISO alpha-2 code of the destination country (where goods are going) */
  reporterCode?: string | null;
  /** ISO alpha-2 code of the origin country (where goods come from) */
  partnerCode?: string | null;
  /** Optional HS code for product-specific advice */
  hsCode?: string | null;
}

interface AdvisorData {
  reporter: string;
  partner: string;
  freeTradeAgreements: Array<{
    name: string;
    type: string;
    typeExplanation: string;
    description: string;
    tariffReduction: string;
    notes: string;
  }>;
  tariff: {
    mfnRate: number;
    mfnExplanation: string;
    vat: number;
    vatName: string;
    vatExplanation: string;
    notes: string;
    foodExemptions: string;
    hasFTA: boolean;
    estimatedDuty: string;
    estimatedTotalTax: string;
  } | null;
  recommendations: string[];
  requiredDocuments: string[];
  glossary: Array<{
    term: string;
    full: string;
    explanation: string;
  }>;
}

/**
 * Trade Advisor popup — automatically appears when both origin and destination
 * countries are selected in a form (offer, deal, trade calculation).
 *
 * Shows:
 *   - Free Trade Agreements that apply
 *   - Tariff rates (MFN + preferential)
 *   - VAT / GST rates
 *   - Smart recommendations (what documents you need, what to include in your offer)
 *   - Glossary of trade terms (so non-experts understand)
 *
 * The popup is collapsible — click to expand/collapse.
 */
export function TradeAdvisor({ reporterCode, partnerCode, hsCode }: TradeAdvisorProps) {
  const [expanded, setExpanded] = React.useState(true);
  const t = useT();

  const { data, isLoading } = useQuery<AdvisorData>({
    queryKey: ["trade-advisor", reporterCode, partnerCode, hsCode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (reporterCode) params.set("reporter", reporterCode);
      if (partnerCode) params.set("partner", partnerCode);
      if (hsCode) params.set("hsCode", hsCode);
      const r = await fetch(`/api/integrations/wits?${params}`);
      if (!r.ok) throw new Error("Failed to load trade advisor");
      return r.json();
    },
    enabled: !!reporterCode && !!partnerCode,
  });

  if (!reporterCode || !partnerCode) return null;

  const hasFTA = (data?.freeTradeAgreements || []).length > 0;

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-primary/5 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-primary/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-primary" />
          <span className="text-sm font-semibold">{t("misc-ta-title")}</span>
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : hasFTA ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 text-xs">
              <CheckCircle2 className="size-3 mr-1" /> {t("misc-ta-fta-applies")}
            </Badge>
          ) : (
            <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 text-xs">
              <AlertTriangle className="size-3 mr-1" /> {t("misc-ta-mfn-tariff")}
            </Badge>
          )}
        </div>
        {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
      </button>

      {/* Content */}
      {expanded && data && (
        <div className="px-3 pb-3 space-y-3">
          {/* Route */}
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="font-medium">{partnerCode}</span>
            <span>→</span>
            <span className="font-medium">{reporterCode}</span>
            {hsCode && <span className="ml-2 text-muted-foreground/70">· HS: {hsCode}</span>}
          </div>

          {/* FTA section */}
          {data.freeTradeAgreements.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                {t("misc-ta-fta-section").replace("{n}", String(data.freeTradeAgreements.length))}
              </p>
              {data.freeTradeAgreements.map((fta, i) => (
                <div key={i} className="rounded-md bg-emerald-500/5 border border-emerald-500/20 p-2">
                  <p className="text-xs font-medium">{fta.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{fta.tariffReduction}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{fta.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Tariff section */}
          {data.tariff && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold">{t("misc-ta-tariff-summary")}</p>
              <div className="rounded-md bg-card border border-border/40 p-2 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t("misc-ta-customs-duty")}</span>
                  <span className="font-medium">{data.tariff.estimatedDuty}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{data.tariff.vatName}:</span>
                  <span className="font-medium">{data.tariff.vat}%</span>
                </div>
                <div className="flex justify-between text-xs pt-1 border-t border-border/30">
                  <span className="text-muted-foreground">{t("misc-ta-total-tax")}</span>
                  <span className="font-bold text-primary">{data.tariff.estimatedTotalTax}</span>
                </div>
              </div>
              {data.tariff.foodExemptions && (
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">🥗 {t("misc-ta-food-exemptions")}</span> {data.tariff.foodExemptions}
                </p>
              )}
            </div>
          )}

          {/* Recommendations */}
          {data.recommendations.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold">{t("misc-ta-recommendations")}</p>
              {data.recommendations.map((rec, i) => (
                <p key={i} className="text-xs text-muted-foreground leading-relaxed">{rec}</p>
              ))}
            </div>
          )}

          {/* Required documents */}
          {data.requiredDocuments.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold flex items-center gap-1">
                <FileText className="size-3" /> {t("misc-ta-required-docs")}
              </p>
              <div className="flex flex-wrap gap-1">
                {data.requiredDocuments.map((doc, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">{doc}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Glossary */}
          {data.glossary.length > 0 && (
            <details className="group">
              <summary className="text-xs font-semibold cursor-pointer flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <Info className="size-3" /> {t("misc-ta-glossary").replace("{n}", String(data.glossary.length))}
                <ChevronRight className="size-3 group-open:hidden" />
                <ChevronDown className="size-3 hidden group-open:block" />
              </summary>
              <div className="mt-2 space-y-1.5">
                {data.glossary.map((g, i) => (
                  <div key={i} className="text-xs">
                    <span className="font-medium">{g.term}</span>
                    <span className="text-muted-foreground"> ({g.full}): </span>
                    <span className="text-muted-foreground">{g.explanation}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
