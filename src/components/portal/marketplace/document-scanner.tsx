"use client";

import { useState, useRef, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ScanLine,
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  FileText,
  Wand2,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";

// ─── Public types ─────────────────────────────────────────────────────────

export interface DocumentScannerFillPayload {
  /** Canonical product name extracted from the document. */
  productName?: string;
  /** Category code (e.g. "METAL", "AGRI") — null when not recognised. */
  category?: string | null;
  /** Key/value spec map — passed verbatim to the create-post form. */
  specifications?: Record<string, string>;
  /** List of measured quality parameters (name + value strings). */
  parameters?: Array<{ name: string; value: string }>;
  /** Batch / lot number from a CoA. */
  batch?: string;
  /** ISO date from a CoA. */
  date?: string;
}

interface DocumentScannerProps {
  /**
   * Called when the user clicks "Fill Form" — receives the parsed
   * structured data. The parent (create-post form) decides how to map
   * the fields into its own form state.
   */
  onFill: (data: DocumentScannerFillPayload) => void;
}

// ─── API response shapes (mirror src/lib/marketplace/document-parser.ts) ─

interface CoAResult {
  parameters: Array<{ name: string; value: string }>;
  product: string;
  batch: string;
  date: string;
}
interface SpecSheetResult {
  productName: string;
  specifications: Record<string, string>;
  category: string;
}

type ParseType = "coa" | "spec_sheet";

// ─── Component ────────────────────────────────────────────────────────────

/**
 * DocumentScanner — upload area + preview of OCR-extracted data + a
 * "Fill Form" button that calls `onFill` with the structured payload so
 * the create-post form can populate itself.
 *
 * Two scan types are supported:
 *   • Certificate of Analysis — extracts product / batch / date /
 *     measured parameters (purity, moisture, ash, foreign matter, etc.).
 *     The parameters list maps onto the post's `quality_specs` field.
 *   • Product Spec Sheet — extracts product name / category / a
 *     key/value specifications map. The map goes onto the post's
 *     `specifications` JSONB column.
 *
 * The image is uploaded as base64 (NOT persisted server-side — the API
 * route keeps it in memory only for the duration of the VLM call). The
 * preview shows the parsed fields so the user can sanity-check before
 * filling the form.
 */
export function DocumentScanner({ onFill }: DocumentScannerProps) {
  const t = useT();
  const [scanType, setScanType] = useState<ParseType>("coa");
  const [parsedCoA, setParsedCoA] = useState<CoAResult | null>(null);
  const [parsedSpec, setParsedSpec] = useState<SpecSheetResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ── Mutation: POST /api/marketplace/parse-document ──────────────────
  const parse = useMutation({
    mutationFn: async (vars: { type: ParseType; imageBase64: string }) => {
      const r = await fetch("/api/marketplace/parse-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (r.status === 503) {
        // AI service unavailable — friendly message via the toast.
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("marketplace-document-scanner-ai-unavailable"));
      }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to parse document.");
      }
      return r.json() as Promise<{ result: CoAResult | SpecSheetResult }>;
    },
    onSuccess: (data) => {
      setErrorMsg(null);
      if (scanType === "coa") {
        const r = data.result as CoAResult;
        setParsedCoA(r);
        setParsedSpec(null);
      } else {
        const r = data.result as SpecSheetResult;
        setParsedSpec(r);
        setParsedCoA(null);
      }
      toast.success(t("marketplace-document-scanner-parsed"));
    },
    onError: (e: Error) => {
      setErrorMsg(e.message);
      toast.error(e.message);
    },
  });

  // ── File picker ──────────────────────────────────────────────────────
  const onFileSelected = useCallback(
    async (file: File) => {
      // Validate the MIME + size BEFORE encoding.
      if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
        toast.error(t("marketplace-document-scanner-invalid-format"));
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error(t("marketplace-document-scanner-too-large"));
        return;
      }
      // Render a preview thumbnail so the user sees what they uploaded.
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);

      // Read as base64 — the FileReader result is `data:<mime>;base64,<...>`
      // which the parser strips down to bare base64 internally.
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        parse.mutate({ type: scanType, imageBase64: dataUrl });
      };
      reader.onerror = () => {
        toast.error("Failed to read the file.");
        setPreviewUrl(null);
      };
      reader.readAsDataURL(file);
    },
    [scanType, parse, t],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) onFileSelected(file);
    },
    [onFileSelected],
  );

  const onPickFile = () => inputRef.current?.click();

  // ── "Fill Form" click — translate the parsed result into the form
  // payload shape and hand it back to the parent. The parent owns the
  // actual form state mutation. ─────────────────────────────────────
  function onFillClick() {
    if (scanType === "coa" && parsedCoA) {
      const payload: DocumentScannerFillPayload = {
        productName: parsedCoA.product || undefined,
        parameters: parsedCoA.parameters,
        batch: parsedCoA.batch || undefined,
        date: parsedCoA.date || undefined,
      };
      onFill(payload);
      toast.success(t("marketplace-document-scanner-form-filled"));
      return;
    }
    if (scanType === "spec_sheet" && parsedSpec) {
      const payload: DocumentScannerFillPayload = {
        productName: parsedSpec.productName || undefined,
        category: parsedSpec.category || undefined,
        specifications: parsedSpec.specifications,
      };
      onFill(payload);
      toast.success(t("marketplace-document-scanner-form-filled"));
      return;
    }
  }

  const hasParsedResult = scanType === "coa" ? !!parsedCoA : !!parsedSpec;

  return (
    <Card className="bg-muted/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5 text-muted-foreground">
          <ScanLine className="h-4 w-4" />
          {t("marketplace-document-scanner-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("marketplace-document-scanner-desc")}
        </p>

        {/* Scan-type picker */}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={scanType === "coa" ? "default" : "outline"}
            onClick={() => setScanType("coa")}
          >
            <FileText className="h-3.5 w-3.5 mr-1" />
            {t("marketplace-document-scanner-type-coa")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={scanType === "spec_sheet" ? "default" : "outline"}
            onClick={() => setScanType("spec_sheet")}
          >
            <ScanLine className="h-3.5 w-3.5 mr-1" />
            {t("marketplace-document-scanner-type-spec-sheet")}
          </Button>
        </div>

        {/* Upload area — drag-and-drop + click-to-pick. */}
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={onPickFile}
          className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-6 text-center cursor-pointer hover:border-primary/40 transition-colors"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Upload preview"
              className="max-h-32 rounded-md border"
            />
          ) : (
            <>
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {t("marketplace-document-scanner-dropzone")}
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFileSelected(f);
              // Reset the input value so the same file can be picked
              // again after the user reviews the result + clears it.
              e.target.value = "";
            }}
          />
        </div>

        {/* Loading / error states. */}
        {parse.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("marketplace-document-scanner-parsing")}
          </div>
        )}
        {errorMsg && !parse.isPending && (
          <div className="flex items-start gap-2 text-xs text-rose-700 dark:text-rose-400">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Parsed preview — CoA. */}
        {scanType === "coa" && parsedCoA && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                {t("marketplace-document-scanner-parsed-coa")}
              </Badge>
              {parsedCoA.parameters.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {parsedCoA.parameters.length} {t("marketplace-document-scanner-parameters-count")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <Field label={t("marketplace-product-name")} value={parsedCoA.product || "—"} />
              <Field label={t("marketplace-document-scanner-batch")} value={parsedCoA.batch || "—"} />
              <Field label={t("marketplace-document-scanner-date")} value={parsedCoA.date || "—"} />
            </div>
            {parsedCoA.parameters.length > 0 && (
              <>
                <Separator className="my-2" />
                <p className="text-xs font-medium">{t("marketplace-document-scanner-parameters")}</p>
                <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
                  {parsedCoA.parameters.map((p, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="text-muted-foreground truncate">{p.name}</span>
                      <span className="font-medium text-right">{p.value}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* Parsed preview — Spec Sheet. */}
        {scanType === "spec_sheet" && parsedSpec && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                {t("marketplace-document-scanner-parsed-spec")}
              </Badge>
              {Object.keys(parsedSpec.specifications).length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {Object.keys(parsedSpec.specifications).length} {t("marketplace-document-scanner-specs-count")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <Field label={t("marketplace-product-name")} value={parsedSpec.productName || "—"} />
              <Field label={t("marketplace-product-category")} value={parsedSpec.category || "—"} />
            </div>
            {Object.keys(parsedSpec.specifications).length > 0 && (
              <>
                <Separator className="my-2" />
                <p className="text-xs font-medium">{t("marketplace-document-scanner-specs")}</p>
                <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
                  {Object.entries(parsedSpec.specifications).map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-3">
                      <span className="text-muted-foreground truncate">{k}</span>
                      <span className="font-medium text-right">{v}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* Fill Form button — only shown when there is a parsed result. */}
        {hasParsedResult && (
          <Button
            type="button"
            size="sm"
            onClick={onFillClick}
            className="w-full"
          >
            <Wand2 className="h-3.5 w-3.5 mr-1" />
            {t("marketplace-document-scanner-fill-form")}
          </Button>
        )}

        {/* Hint that AI is doing the work — small print. */}
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Sparkles className="h-2.5 w-2.5" />
          {t("marketplace-document-scanner-ai-hint")}
        </p>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-background/60 p-1.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="font-medium truncate">{value}</p>
    </div>
  );
}
