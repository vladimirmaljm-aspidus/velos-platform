"use client";

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Circle, Loader2, FilePlus, AlertTriangle } from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import type {
  MarketplaceTradeDocumentType,
} from "@/lib/marketplace/document-generators";
import type { TradeDocument } from "@/lib/data/marketplace-trade-documents-store";

interface DocumentChecklistProps {
  /** Marketplace entity to scope the checklist to. At least one must be
   *  supplied so the auto-generate route has a deal context. */
  postId?: string;
  negotiationId?: string;
  shipmentId?: string;
  /** Whether the caller is the issuer (i.e. can run "Generate Missing"). */
  isIssuer: boolean;
}

interface DocumentsListResponse {
  items: TradeDocument[];
  total: number;
}

/**
 * DocumentChecklist — shows which trade documents a deal needs and which
 * are already present. A "Generate Missing" button auto-issues any
 * missing docs via the auto-generate route.
 *
 * Required-doc set is the standard export-doc package:
 *   • Commercial Invoice
 *   • Packing List
 *   • Certificate of Origin
 *   • Bill of Lading (eBL)        (only when the deal involves a shipment)
 *   • Proforma Invoice            (only when the deal hasn't shipped yet)
 *
 * The "required" set is filtered by the props we're given:
 *   • When shipmentId is supplied → the BoL row is required.
 *   • When shipmentId is NOT supplied → the Proforma row is required.
 */
export function DocumentChecklist({
  postId,
  negotiationId,
  shipmentId,
  isIssuer,
}: DocumentChecklistProps) {
  const t = useT();
  const qc = useQueryClient();

  // ── Determine the required-doc set for this deal context ─────────────
  const requiredTypes = useMemo<MarketplaceTradeDocumentType[]>(() => {
    const base: MarketplaceTradeDocumentType[] = [
      "commercial_invoice",
      "packing_list",
      "certificate_of_origin",
    ];
    if (shipmentId) {
      base.push("bill_of_lading");
    } else {
      base.push("proforma_invoice");
    }
    return base;
  }, [shipmentId]);

  // ── Fetch the existing documents for this context ────────────────────
  const listKey = ["marketplace-documents", postId, negotiationId, shipmentId];
  const docsQ = useQuery<DocumentsListResponse>({
    queryKey: listKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (postId) params.set("post_id", postId);
      if (negotiationId) params.set("negotiation_id", negotiationId);
      if (shipmentId) params.set("shipment_id", shipmentId);
      params.set("limit", "100");
      const r = await fetch(`/api/marketplace/documents?${params}`);
      if (!r.ok) throw new Error("Failed to load documents.");
      return r.json();
    },
    enabled: !!(postId || negotiationId || shipmentId),
  });

  const items = docsQ.data?.items ?? [];

  // ── Compute present / missing / signed per type ──────────────────────
  const presentByType = new Map<MarketplaceTradeDocumentType, TradeDocument>();
  for (const doc of items) {
    const ty = doc.document_type as MarketplaceTradeDocumentType;
    // Keep the most recent of each type (signed > generated > draft).
    const prev = presentByType.get(ty);
    if (!prev || statusRank(doc.status) > statusRank(prev.status)) {
      presentByType.set(ty, doc);
    }
  }

  const missing = requiredTypes.filter((ty) => !presentByType.has(ty));
  const presentCount = requiredTypes.length - missing.length;
  const signedCount = requiredTypes.filter((ty) => presentByType.get(ty)?.digital_signature).length;
  const completenessPct = requiredTypes.length > 0
    ? Math.round((presentCount / requiredTypes.length) * 100)
    : 0;

  // ── "Generate Missing" — auto-generate all missing docs ─────────────
  const generateMissing = useMutation({
    mutationFn: async () => {
      const results: { type: string; status: "ok" | "error"; error?: string }[] = [];
      for (const ty of missing) {
        const r = await fetch("/api/marketplace/documents/auto-generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_type: ty,
            post_id: postId,
            negotiation_id: negotiationId,
            shipment_id: shipmentId,
          }),
        });
        if (r.ok) {
          results.push({ type: ty, status: "ok" });
        } else {
          const e = await r.json().catch(() => ({}));
          results.push({ type: ty, status: "error", error: e.error || "Failed" });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.status === "ok").length;
      const err = results.filter((r) => r.status === "error").length;
      if (err === 0) {
        toast.success(t("marketplace-document-checklist-all-generated"));
      } else if (ok === 0) {
        toast.error(t("marketplace-document-checklist-none-generated"));
      } else {
        toast.warning(
          t("marketplace-document-checklist-partial-generated")
            .replace("{ok}", String(ok))
            .replace("{err}", String(err)),
        );
      }
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {t("marketplace-document-checklist-title")}
          </span>
          <Badge variant="outline">
            {presentCount} / {requiredTypes.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("marketplace-document-checklist-desc")}
        </p>

        {/* Completeness progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {t("marketplace-document-checklist-completeness")}
            </span>
            <span className="font-medium">
              {completenessPct}%
              {signedCount > 0 ? (
                <span className="ml-2 text-muted-foreground">
                  · {signedCount} {t("marketplace-document-signed")}
                </span>
              ) : null}
            </span>
          </div>
          <Progress value={completenessPct} className="h-1.5" />
        </div>

        {/* Required-doc list */}
        <div className="space-y-1.5">
          {requiredTypes.map((ty) => {
            const doc = presentByType.get(ty);
            const present = !!doc;
            const signed = !!doc?.digital_signature;
            return (
              <div
                key={ty}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                {present ? (
                  signed ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  )
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/50" />
                )}
                <span className="flex-1">{t(TYPE_LABEL_KEY[ty])}</span>
                {doc ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{doc.reference_number}</span>
                    <Badge variant="outline">{t(STATUS_LABEL_KEY[doc.status as keyof typeof STATUS_LABEL_KEY])}</Badge>
                  </div>
                ) : (
                  <Badge variant="secondary">{t("marketplace-document-checklist-missing")}</Badge>
                )}
              </div>
            );
          })}
        </div>

        {/* Generate-missing button */}
        {isIssuer ? (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => generateMissing.mutate()}
              disabled={generateMissing.isPending || missing.length === 0}
            >
              {generateMissing.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FilePlus className="h-4 w-4" />
              )}
              {t("marketplace-document-checklist-generate-missing")}
            </Button>
            {missing.length === 0 ? (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                {t("marketplace-document-checklist-all-present")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-amber-600" />
                {t("marketplace-document-checklist-missing-count").replace("{n}", String(missing.length))}
              </span>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusRank(s: string): number {
  // Higher rank = more progressed.
  // draft=0, generated=1, sent=2, signed=3, rejected=4
  switch (s) {
    case "draft": return 0;
    case "generated": return 1;
    case "sent": return 2;
    case "signed": return 3;
    case "rejected": return 4;
    default: return 0;
  }
}

const TYPE_LABEL_KEY: Record<MarketplaceTradeDocumentType, string> = {
  commercial_invoice: "marketplace-document-type-commercial-invoice",
  packing_list: "marketplace-document-type-packing-list",
  certificate_of_origin: "marketplace-document-type-certificate-of-origin",
  bill_of_lading: "marketplace-document-type-bill-of-lading",
  shipping_manifest: "marketplace-document-type-shipping-manifest",
  inspection_certificate: "marketplace-document-type-inspection-certificate",
  insurance_certificate: "marketplace-document-type-insurance-certificate",
  export_declaration: "marketplace-document-type-export-declaration",
  customs_declaration: "marketplace-document-type-customs-declaration",
  letter_of_credit_draft: "marketplace-document-type-letter-of-credit-draft",
  proforma_invoice: "marketplace-document-type-proforma-invoice",
  weight_certificate: "marketplace-document-type-weight-certificate",
};

const STATUS_LABEL_KEY = {
  draft: "marketplace-document-status-draft",
  generated: "marketplace-document-status-generated",
  sent: "marketplace-document-status-sent",
  signed: "marketplace-document-status-signed",
  rejected: "marketplace-document-status-rejected",
} as const;
