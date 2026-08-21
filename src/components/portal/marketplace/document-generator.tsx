"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  FileText,
  FilePlus,
  Download,
  Loader2,
  Eye,
  ShieldCheck,
  Pencil,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtDateTime } from "@/lib/utils/format";
import type {
  MarketplaceTradeDocumentType,
  MarketplaceTradeDocumentStatus,
} from "@/lib/marketplace/document-generators";
import { AUTO_GENERATABLE_TYPES } from "@/lib/marketplace/document-generators";
import type { TradeDocument } from "@/lib/data/marketplace-trade-documents-store";

interface DocumentGeneratorProps {
  /** Marketplace entity to scope the generator to. At least one of these
   *  must be supplied so the auto-generate route has a deal context. */
  postId?: string;
  negotiationId?: string;
  shipmentId?: string;
  /** Whether the caller is the issuer of the documents (i.e. the seller
   *  on a sell-side deal). When false, only the "view + download PDF"
   *  actions are available — generate / sign are hidden. */
  isIssuer: boolean;
}

interface DocumentsListResponse {
  items: TradeDocument[];
  total: number;
}

const STATUS_LABEL_KEY: Record<MarketplaceTradeDocumentStatus, string> = {
  draft: "marketplace-document-status-draft",
  generated: "marketplace-document-status-generated",
  sent: "marketplace-document-status-sent",
  signed: "marketplace-document-status-signed",
  rejected: "marketplace-document-status-rejected",
};

const STATUS_VARIANT: Record<MarketplaceTradeDocumentStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "secondary",
  generated: "outline",
  sent: "default",
  signed: "default",
  rejected: "destructive",
};

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

/**
 * DocumentGenerator — UI for the Phase 8 trade-document automation.
 *
 * Layout:
 *   1. Header: title + a short description.
 *   2. Generate panel: type selector + "Auto-generate" button. The
 *      selector is constrained to AUTO_GENERATABLE_TYPES (the rest are
 *      manual-only via the PUT route on a row's detail).
 *   3. Documents table: existing documents for this post / negotiation /
 *      shipment, with status badges, signed indicator, and per-row
 *      actions (Preview / Download PDF / Sign).
 *
 * The component supports both issuer + non-issuer viewers — non-issuers
 * can preview + download PDFs but cannot generate / sign.
 */
export function DocumentGenerator({
  postId,
  negotiationId,
  shipmentId,
  isIssuer,
}: DocumentGeneratorProps) {
  const t = useT();
  const qc = useQueryClient();
  const [selectedType, setSelectedType] = useState<MarketplaceTradeDocumentType>("commercial_invoice");
  const [previewDoc, setPreviewDoc] = useState<TradeDocument | null>(null);

  // ── List of existing documents for this marketplace context ──────────
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

  // ── Auto-generate a new document ─────────────────────────────────────
  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/marketplace/documents/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_type: selectedType,
          post_id: postId,
          negotiation_id: negotiationId,
          shipment_id: shipmentId,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to auto-generate document.");
      }
      return r.json() as Promise<TradeDocument>;
    },
    onSuccess: () => {
      toast.success(t("marketplace-document-generated"));
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Sign a document ──────────────────────────────────────────────────
  const sign = useMutation({
    mutationFn: async (docId: string) => {
      const r = await fetch(`/api/marketplace/documents/${docId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to sign document.");
      }
      return r.json() as Promise<{ document: TradeDocument }>;
    },
    onSuccess: () => {
      toast.success(t("marketplace-document-signed"));
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Download PDF (open the [id]/pdf endpoint in a new tab) ───────────
  const downloadPdf = (doc: TradeDocument) => {
    // Use a hidden <a> + click so browsers treat it as a download.
    const url = `/api/marketplace/documents/${doc.id}/pdf`;
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.download = `${doc.document_type}_${doc.reference_number || doc.id}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const items = docsQ.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {t("marketplace-document-generator-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("marketplace-document-generator-desc")}
        </p>

        {/* ── Auto-generate panel (issuer only) ─────────────────────── */}
        {isIssuer ? (
          <div className="space-y-3 rounded-md border border-dashed p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs uppercase text-muted-foreground mb-1 block">
                  {t("marketplace-document-type")}
                </label>
                <Select value={selectedType} onValueChange={(v) => setSelectedType(v as MarketplaceTradeDocumentType)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(AUTO_GENERATABLE_TYPES as MarketplaceTradeDocumentType[]).map((ty) => (
                      <SelectItem key={ty} value={ty}>
                        {t(TYPE_LABEL_KEY[ty])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => generate.mutate()}
                disabled={generate.isPending}
              >
                {generate.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FilePlus className="h-4 w-4" />
                )}
                {t("marketplace-document-generate")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("marketplace-document-generate-hint")}
            </p>
          </div>
        ) : null}

        {/* ── Documents list ─────────────────────────────────────────── */}
        {docsQ.isLoading ? (
          <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {t("marketplace-document-loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            {t("marketplace-document-empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((doc) => (
              <div
                key={doc.id}
                className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
              >
                <div className="flex-1 min-w-[200px]">
                  <div className="font-medium">
                    {t(TYPE_LABEL_KEY[doc.document_type as MarketplaceTradeDocumentType])}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {doc.reference_number ? (
                      <span>{doc.reference_number} · </span>
                    ) : null}
                    {fmtDateTime(doc.created_at)}
                  </div>
                </div>
                <Badge variant={STATUS_VARIANT[doc.status as MarketplaceTradeDocumentStatus]}>
                  {t(STATUS_LABEL_KEY[doc.status as MarketplaceTradeDocumentStatus])}
                </Badge>
                {doc.digital_signature ? (
                  <Badge variant="outline" className="gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    {t("marketplace-document-signed")}
                  </Badge>
                ) : null}
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPreviewDoc(doc)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t("marketplace-document-preview")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => downloadPdf(doc)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t("marketplace-document-pdf")}
                  </Button>
                  {isIssuer && !doc.digital_signature ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => sign.mutate(doc.id)}
                      disabled={sign.isPending}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t("marketplace-document-sign")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Preview dialog */}
      <DocumentPreviewDialog
        doc={previewDoc}
        typeLabel={previewDoc ? t(TYPE_LABEL_KEY[previewDoc.document_type as MarketplaceTradeDocumentType]) : ""}
        onClose={() => setPreviewDoc(null)}
      />
    </Card>
  );
}

// ─── Preview dialog ─────────────────────────────────────────────────────────

interface DocumentPreviewDialogProps {
  doc: TradeDocument | null;
  typeLabel: string;
  onClose: () => void;
}

function DocumentPreviewDialog({ doc, typeLabel, onClose }: DocumentPreviewDialogProps) {
  const t = useT();
  const open = doc !== null;

  // Flatten the document_data for the preview — the meta block first,
  // then the rest of the JSONB as a sorted key-value list.
  const rows = useMemo(() => {
    if (!doc) return [];
    // Clone the document_data so we never mutate the cached row.
    const data = JSON.parse(JSON.stringify(doc.document_data ?? {})) as Record<string, any>;
    const out: { key: string; value: string }[] = [];
    const meta = data.meta as Record<string, any> | undefined;
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        out.push({ key: `meta.${k}`, value: stringify(v) });
      }
      delete data.meta;
    }
    for (const [k, v] of Object.entries(data)) {
      out.push({ key: k, value: stringify(v) });
    }
    return out;
  }, [doc]);

  // Reset the body scroll when the dialog closes.
  useEffect(() => { /* no-op — Dialog handles body scroll lock */ }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[98vw] max-w-4xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{typeLabel}</DialogTitle>
          <DialogDescription>
            {doc?.reference_number ? `${doc.reference_number} · ` : ""}
            {fmtDateTime(doc?.created_at || new Date().toISOString())}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-1 text-xs font-mono">
          {rows.length === 0 ? (
            <div className="text-muted-foreground">
              {t("marketplace-document-empty-data")}
            </div>
          ) : (
            rows.map((r, idx) => (
              <div key={idx} className="grid grid-cols-[180px_1fr] gap-2 border-b border-border/40 py-1">
                <span className="text-muted-foreground break-words">{r.key}</span>
                <span className="whitespace-pre-wrap break-words">{r.value}</span>
              </div>
            ))
          )}
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={onClose}>
            {t("marketplace-document-close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
