"use client";

import { useState, useRef, useCallback, useEffect } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ScanLine,
  Upload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  FileText,
  Wand2,
  ChevronDown,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";

// ─── Public types ─────────────────────────────────────────────────────────

export interface ScannerCoAParameter {
  name: string;
  value: string;
  /** Unit of measurement (e.g. "%", "mg/kg", "°C"). May be omitted. */
  unit?: string;
  /** Spec / limit / acceptable range stated on the CoA. May be omitted. */
  spec?: string;
  /** Pass / Fail / Conforms when the CoA states it. May be omitted. */
  result?: string;
}

export interface DocumentScannerFillPayload {
  /** Canonical product name extracted from the document. */
  productName?: string;
  /** Category code (e.g. "METAL", "AGRI") — null when not recognised. */
  category?: string | null;
  /** Key/value spec map — passed verbatim to the create-post form. */
  specifications?: Record<string, string>;
  /** List of measured quality parameters (name + value strings). */
  parameters?: ScannerCoAParameter[];
  /** Batch / lot number from a CoA. */
  batch?: string;
  /** ISO date from a CoA. */
  date?: string;
}

interface DocumentScannerProps {
  /**
   * Called when the user clicks "Apply Selected" in the selective-import
   * dialog — receives ONLY the checked + edited subset. The parent (create-
   * post form) decides how to map the fields into its own form state.
   */
  onFill: (data: DocumentScannerFillPayload) => void;
}

// ─── API response shapes (mirror src/lib/marketplace/document-parser.ts) ─

type ConfidenceLevel = "high" | "medium" | "low";

interface CoAResult {
  parameters: ScannerCoAParameter[];
  product: string;
  batch: string;
  date: string;
  manufactureDate?: string;
  expiryDate?: string;
  manufacturer?: string;
  grade?: string;
  origin?: string;
  certifications?: string[];
  storage?: string;
  packaging?: string;
  confidence?: ConfidenceLevel;
  uncertainFields?: string[];
}

interface SpecSheetResult {
  productName: string;
  specifications: Record<string, string>;
  category: string;
  sku?: string;
  hsCode?: string;
  brand?: string;
  originCountry?: string;
  shelfLife?: string;
  storage?: string;
  certifications?: string[];
  containerCapacity?: string;
  applications?: string[];
  confidence?: ConfidenceLevel;
  uncertainFields?: string[];
}

type ParseType = "coa" | "spec_sheet";

// Allowed MIME types — kept in sync with the API route + document-parser.
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp)$/i;
const PDF_MIME = "application/pdf";
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const PDF_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

// ─── Selective-import row model ──────────────────────────────────────────
//
// The dialog renders three row kinds:
//   • scalar — a single labelled text input (productName, batch, …)
//   • param  — a CoA parameter row with 5 inline-editable sub-fields
//              (name, value, unit, spec, result), shown inside a Collapsible.
//   • spec   — a spec-sheet { key, value } pair rendered as two side-by-side
//              inputs so the user can fix both the spec name and its value.
//
// `labelKey` is an i18n dictionary key — the row stores the KEY (not the
// translated string) so the row builder stays a pure function of the
// parsed result and never depends on the i18n hook (which would re-trigger
// the effect on every render). Translation happens at render-time in the
// RowView via `t(row.labelKey)`.

type SelectiveRow =
  | {
      kind: "scalar";
      key: string;
      labelKey: string;
      value: string;
      checked: boolean;
      uncertain: boolean;
    }
  | {
      kind: "param";
      key: string;
      index: number;
      name: string;
      value: string;
      unit: string;
      spec: string;
      result: string;
      checked: boolean;
      uncertain: boolean;
    }
  | {
      kind: "spec";
      key: string;
      specKey: string;
      specValue: string;
      checked: boolean;
      uncertain: boolean;
    };

// ─── Component ────────────────────────────────────────────────────────────

/**
 * DocumentScanner — upload area + preview of OCR-extracted data + a
 * "Review & fill form" button that opens a selective-import dialog where
 * the user checks / edits the fields they want pushed into the create-post
 * form.
 *
 * Two scan types are supported:
 *   • Certificate of Analysis — extracts product / batch / date / measured
 *     parameters (purity, moisture, ash, foreign matter, …). The
 *     parameters list maps onto the post's `quality_specs` field.
 *   • Product Spec Sheet — extracts product name / category / a key/value
 *     specifications map. The map goes onto the post's `specifications`
 *     JSONB column.
 *
 * Two file kinds are supported:
 *   • Images (PNG / JPEG / WebP) — sent to the VLM via the
 *     `image_url` content block.
 *   • PDFs — sent via the `file_url` content block. PDFs are capped at
 *     15 MB; images at 5 MB.
 *
 * The file is uploaded as base64 (NOT persisted server-side — the API
 * route keeps it in memory only for the duration of the VLM call). The
 * preview shows either a thumbnail (images) or a PDF icon + filename
 * (PDFs) so the user can sanity-check before opening the review dialog.
 * The parsed-data preview also surfaces a confidence badge (`high` /
 * `medium` / `low`) the VLM self-assesses, plus the list of fields the
 * model was uncertain about.
 */
export function DocumentScanner({ onFill }: DocumentScannerProps) {
  const t = useT();
  const [scanType, setScanType] = useState<ParseType>("coa");
  const [parsedCoA, setParsedCoA] = useState<CoAResult | null>(null);
  const [parsedSpec, setParsedSpec] = useState<SpecSheetResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ── Mutation: parse document via relay (client-side) or Vercel API ─────
  // When NEXT_PUBLIC_ZAI_RELAY_URL is set (production), the browser calls
  // the relay directly — bypassing Vercel's network block to the Z.AI
  // internal API. The relay (on the sandbox) can reach internal-api.z.ai.
  // When the env var is NOT set (sandbox/local dev), falls back to the
  // Vercel API which uses the local .z-ai-config.
  const parse = useMutation({
    mutationFn: async (vars: {
      type: ParseType;
      fileBase64: string;
      mimeType: string;
    }) => {
      const relayUrl = process.env.NEXT_PUBLIC_ZAI_RELAY_URL;
      if (relayUrl) {
        // Client-side call to the relay (browser → sandbox → Z.AI)
        const r = await fetch(`${relayUrl}/parse-document?XTransformPort=3030`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-session-id": "velos-relay-1",
          },
          body: JSON.stringify(vars),
        });
        if (!r.ok) {
          const e = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error || "AI analysis failed. Try a smaller file.");
        }
        return r.json() as Promise<{ result: CoAResult | SpecSheetResult }>;
      }
      // Fallback: Vercel API (sandbox/local dev with .z-ai-config)
      const r = await fetch("/api/marketplace/parse-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (r.status === 503) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          e.error || t("marketplace-document-scanner-ai-unavailable"),
        );
      }
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error || "Failed to parse document.");
      }
      return r.json() as Promise<{ result: CoAResult | SpecSheetResult }>;
    },
    onSuccess: (data) => {
      setErrorMsg(null);
      if (scanType === "coa") {
        setParsedCoA(data.result as CoAResult);
        setParsedSpec(null);
      } else {
        setParsedSpec(data.result as SpecSheetResult);
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
      const isPdf = file.type === PDF_MIME;
      const isImage = IMAGE_MIME_RE.test(file.type);

      // Validate the MIME + size BEFORE encoding.
      if (!isImage && !isPdf) {
        toast.error(t("marketplace-document-scanner-invalid-format"));
        return;
      }
      const maxBytes = isPdf ? PDF_MAX_BYTES : IMAGE_MAX_BYTES;
      if (file.size > maxBytes) {
        toast.error(t("marketplace-document-scanner-too-large"));
        return;
      }

      // Reset any stale preview from the previous upload.
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
      setPdfFileName(null);
      setErrorMsg(null);

      if (isPdf) {
        // PDFs can't be drawn into an <img>; show a FileText icon + name.
        setPdfFileName(file.name);
      } else {
        // Render a preview thumbnail so the user sees what they uploaded.
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
      }

      // Read as base64 — the FileReader result is `data:<mime>;base64,<...>`.
      // The API route auto-detects the MIME from this prefix, but we pass
      // the explicit `mimeType` too so the parser doesn't have to guess
      // when the data: prefix is stripped.
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const mimeType = isPdf ? PDF_MIME : file.type;
        parse.mutate({ type: scanType, fileBase64: dataUrl, mimeType });
      };
      reader.onerror = () => {
        toast.error("Failed to read the file.");
        setPreviewUrl(null);
        setPdfFileName(null);
      };
      reader.readAsDataURL(file);
    },
    [scanType, parse, t, previewUrl],
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

  // ── Retry on error — let the user re-pick a file. ──────────────────
  function onRetry() {
    setErrorMsg(null);
    inputRef.current?.click();
  }

  // ── Open the selective-import dialog (only when a result is present).
  function openDialog() {
    if (!hasParsedResult) return;
    setDialogOpen(true);
  }

  // ── Apply the checked + edited subset to the form. Called from inside
  // the dialog. ─────────────────────────────────────────────────────────
  function applySelected(payload: DocumentScannerFillPayload) {
    onFill(payload);
    toast.success(t("marketplace-document-scanner-form-filled"));
    setDialogOpen(false);
  }

  // Switching scan type clears the opposite kind's parse result so the
  // preview never shows stale data from the previous scan type.
  function chooseScanType(next: ParseType) {
    if (next === scanType) return;
    setScanType(next);
    if (next === "coa") setParsedSpec(null);
    else setParsedCoA(null);
    setErrorMsg(null);
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
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("marketplace-document-scanner-desc")}
        </p>

        {/* Scan-type picker */}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={scanType === "coa" ? "default" : "outline"}
            onClick={() => chooseScanType("coa")}
          >
            <FileText className="h-3.5 w-3.5 mr-1" />
            {t("marketplace-document-scanner-type-coa")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={scanType === "spec_sheet" ? "default" : "outline"}
            onClick={() => chooseScanType("spec_sheet")}
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
          className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-6 text-center cursor-pointer hover:border-primary/40 transition-colors min-h-[140px]"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Upload preview"
              className="max-h-32 rounded-md border"
            />
          ) : pdfFileName ? (
            <div className="flex flex-col items-center gap-1 max-w-full">
              <FileText className="h-10 w-10 text-rose-600" />
              <p className="text-xs font-medium truncate max-w-full">{pdfFileName}</p>
              <p className="text-[10px] text-muted-foreground">PDF</p>
            </div>
          ) : (
            <>
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {t("marketplace-document-scanner-dropzone")}
              </p>
              <p className="text-[10px] text-muted-foreground">
                PNG · JPEG · WebP · PDF (≤ 5 MB image / ≤ 15 MB PDF)
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
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

        {/* Loading state — spinner + elapsed-seconds counter. */}
        {parse.isPending && <AnalyzingTimer />}

        {/* Error state — clear message + retry button. */}
        {errorMsg && !parse.isPending && (
          <div className="flex items-start gap-2 text-xs text-rose-700 dark:text-rose-400 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-2">
              <span className="block">{errorMsg}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRetry}
                className="h-6 text-[10px] px-2"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                {t("marketplace-document-scanner-retry")}
              </Button>
            </div>
          </div>
        )}

        {/* Parsed preview — CoA. */}
        {scanType === "coa" && parsedCoA && (
          <CoAPreview result={parsedCoA} />
        )}

        {/* Parsed preview — Spec Sheet. */}
        {scanType === "spec_sheet" && parsedSpec && (
          <SpecSheetPreview result={parsedSpec} />
        )}

        {/* Review & fill button — opens the selective-import dialog. */}
        {hasParsedResult && (
          <Button
            type="button"
            size="sm"
            onClick={openDialog}
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

      <SelectiveImportDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scanType={scanType}
        parsedCoA={parsedCoA}
        parsedSpec={parsedSpec}
        onApply={applySelected}
      />
    </Card>
  );
}

// ─── Analyzing-timer subcomponent ─────────────────────────────────────────
//
// Mount-only component: lives inside the `{parse.isPending && <AnalyzingTimer/>}`
// conditional, so it mounts fresh when the parse starts and unmounts when it
// ends. The useState starts at 0; the interval's setState calls happen in
// an async callback (NOT in the effect body) so they don't trip the
// `react-hooks/set-state-in-effect` rule.

function AnalyzingTimer() {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-700 dark:text-emerald-400" />
      <span className="font-medium">
        {t("marketplace-document-scanner-analyzing")}
      </span>
      {elapsed > 0 && (
        <span className="text-[10px] text-muted-foreground">
          {t("marketplace-document-scanner-elapsed").replace(
            "{n}",
            String(elapsed),
          )}
        </span>
      )}
    </div>
  );
}

// ─── Preview components (CoA + Spec Sheet) ─────────────────────────────────

function CoAPreview({ result }: { result: CoAResult }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge
          variant="outline"
          className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        >
          <CheckCircle2 className="h-3 w-3 mr-1" />
          {t("marketplace-document-scanner-parsed-coa")}
        </Badge>
        {result.parameters.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {result.parameters.length}{" "}
            {t("marketplace-document-scanner-parameters-count")}
          </span>
        )}
        {result.confidence && (
          <ConfidenceBadge
            level={result.confidence}
            label={t("marketplace-document-scanner-confidence")}
          />
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
        <Field label={t("marketplace-product-name")} value={result.product || "—"} />
        <Field label={t("marketplace-document-scanner-batch")} value={result.batch || "—"} />
        <Field label={t("marketplace-document-scanner-date")} value={result.date || "—"} />
        {result.manufacturer && (
          <Field label={t("marketplace-document-scanner-manufacturer")} value={result.manufacturer} />
        )}
        {result.grade && (
          <Field label={t("marketplace-document-scanner-grade")} value={result.grade} />
        )}
        {result.origin && (
          <Field label={t("marketplace-document-scanner-origin")} value={result.origin} />
        )}
        {result.expiryDate && (
          <Field label={t("marketplace-document-scanner-expiry")} value={result.expiryDate} />
        )}
      </div>
      {result.certifications && result.certifications.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.certifications.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
          ))}
        </div>
      )}
      {result.parameters.length > 0 && (
        <>
          <Separator className="my-2" />
          <p className="text-xs font-medium">
            {t("marketplace-document-scanner-parameters")}
          </p>
          <ul className="text-xs space-y-1 max-h-32 overflow-y-auto pr-1">
            {result.parameters.map((p, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-muted-foreground truncate">
                  {p.name}
                  {p.spec ? ` (spec: ${p.spec})` : ""}
                </span>
                <span className="font-medium text-right">
                  {p.value}
                  {p.unit ? ` ${p.unit}` : ""}
                  {p.result ? ` · ${p.result}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.uncertainFields && result.uncertainFields.length > 0 && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          {t("marketplace-document-scanner-uncertain-fields")}:{" "}
          {result.uncertainFields.join(", ")}
        </p>
      )}
    </div>
  );
}

function SpecSheetPreview({ result }: { result: SpecSheetResult }) {
  const t = useT();
  const specCount = Object.keys(result.specifications).length;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge
          variant="outline"
          className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        >
          <CheckCircle2 className="h-3 w-3 mr-1" />
          {t("marketplace-document-scanner-parsed-spec")}
        </Badge>
        {specCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {specCount} {t("marketplace-document-scanner-specs-count")}
          </span>
        )}
        {result.confidence && (
          <ConfidenceBadge
            level={result.confidence}
            label={t("marketplace-document-scanner-confidence")}
          />
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <Field label={t("marketplace-product-name")} value={result.productName || "—"} />
        <Field label={t("marketplace-product-category")} value={result.category || "—"} />
        {result.sku && (
          <Field label={t("marketplace-document-scanner-sku")} value={result.sku} />
        )}
        {result.hsCode && (
          <Field label={t("marketplace-document-scanner-hs-code")} value={result.hsCode} />
        )}
        {result.brand && (
          <Field label={t("marketplace-document-scanner-brand")} value={result.brand} />
        )}
        {result.originCountry && (
          <Field label={t("marketplace-document-scanner-origin")} value={result.originCountry} />
        )}
        {result.shelfLife && (
          <Field label={t("marketplace-document-scanner-shelf-life")} value={result.shelfLife} />
        )}
        {result.containerCapacity && (
          <Field label={t("marketplace-document-scanner-container-capacity")} value={result.containerCapacity} />
        )}
      </div>
      {result.certifications && result.certifications.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.certifications.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
          ))}
        </div>
      )}
      {specCount > 0 && (
        <>
          <Separator className="my-2" />
          <p className="text-xs font-medium">
            {t("marketplace-document-scanner-specs")}
          </p>
          <ul className="text-xs space-y-1 max-h-32 overflow-y-auto pr-1">
            {Object.entries(result.specifications).map(([k, v]) => (
              <li key={k} className="flex justify-between gap-3">
                <span className="text-muted-foreground truncate">{k}</span>
                <span className="font-medium text-right">{v}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.uncertainFields && result.uncertainFields.length > 0 && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          {t("marketplace-document-scanner-uncertain-fields")}:{" "}
          {result.uncertainFields.join(", ")}
        </p>
      )}
    </div>
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

function ConfidenceBadge({
  level,
  label,
}: {
  level: ConfidenceLevel;
  label: string;
}) {
  const tone =
    level === "high"
      ? "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : level === "medium"
        ? "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400";
  return (
    <Badge variant="outline" className={`text-[10px] ${tone}`}>
      {label}: {level}
    </Badge>
  );
}

// ─── Selective-import dialog ──────────────────────────────────────────────

function SelectiveImportDialog({
  open,
  onOpenChange,
  scanType,
  parsedCoA,
  parsedSpec,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scanType: ParseType;
  parsedCoA: CoAResult | null;
  parsedSpec: SpecSheetResult | null;
  onApply: (data: DocumentScannerFillPayload) => void;
}) {
  const t = useT();
  const confidence =
    scanType === "coa" ? parsedCoA?.confidence : parsedSpec?.confidence;

  // The body lives inside DialogContent — Radix mounts/unmounts it with
  // the dialog, so each open gets a fresh useState initializer (no useEffect
  // needed, no set-state-in-effect lint error).
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" showCloseButton={false} className="p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 pr-4">
            <Wand2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
            <span className="truncate">
              {t("marketplace-document-scanner-review-title")}
            </span>
            {confidence && (
              <ConfidenceBadge
                level={confidence}
                label={t("marketplace-document-scanner-confidence")}
              />
            )}
          </DialogTitle>
          <DialogDescription>
            {t("marketplace-document-scanner-review-desc")}
          </DialogDescription>
        </DialogHeader>

        <SelectiveImportDialogBody
          scanType={scanType}
          parsedCoA={parsedCoA}
          parsedSpec={parsedSpec}
          onApply={onApply}
          onOpenChange={onOpenChange}
          t={t}
        />
      </DialogContent>
    </Dialog>
  );
}

function SelectiveImportDialogBody({
  scanType,
  parsedCoA,
  parsedSpec,
  onApply,
  onOpenChange,
  t,
}: {
  scanType: ParseType;
  parsedCoA: CoAResult | null;
  parsedSpec: SpecSheetResult | null;
  onApply: (data: DocumentScannerFillPayload) => void;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
}) {
  // Lazy initializer — runs once on mount (i.e. every dialog open).
  const [rows, setRows] = useState<SelectiveRow[]>(() =>
    buildRows(scanType, parsedCoA, parsedSpec),
  );

  const checkedCount = rows.filter((r) => r.checked).length;

  // ── Build the form payload from checked + edited rows. ─────────────
  // Non-importable scalar fields (manufacturer, grade, origin, …) are
  // silently dropped — the create-post form doesn't have those fields.
  // The dialog still shows them for review/context (per task spec).
  function buildPayload(): DocumentScannerFillPayload {
    const payload: DocumentScannerFillPayload = {};
    for (const row of rows) {
      if (!row.checked) continue;
      if (row.kind === "scalar") {
        const v = row.value.trim();
        if (row.key === "productName" && v) payload.productName = v;
        else if (row.key === "category" && v) payload.category = v;
        else if (row.key === "batch" && v) payload.batch = v;
        else if (row.key === "date" && v) payload.date = v;
      } else if (row.kind === "param") {
        if (!payload.parameters) payload.parameters = [];
        payload.parameters.push({
          name: row.name.trim(),
          value: row.value.trim(),
          unit: row.unit.trim() || undefined,
          spec: row.spec.trim() || undefined,
          result: row.result.trim() || undefined,
        });
      } else if (row.kind === "spec") {
        if (!payload.specifications) payload.specifications = {};
        const k = row.specKey.trim();
        if (k) payload.specifications[k] = row.specValue.trim();
      }
    }
    return payload;
  }

  function onApplyClick() {
    onApply(buildPayload());
  }

  function toggleChecked(key: string) {
    setRows((rs) =>
      rs.map((r) => (r.key === key ? { ...r, checked: !r.checked } : r)),
    );
  }

  function setAll(checked: boolean) {
    setRows((rs) => rs.map((r) => ({ ...r, checked })));
  }

  function setScalarValue(key: string, value: string) {
    setRows((rs) =>
      rs.map((r) =>
        r.kind === "scalar" && r.key === key ? { ...r, value } : r,
      ),
    );
  }

  function setParamField(
    key: string,
    field: "name" | "value" | "unit" | "spec" | "result",
    value: string,
  ) {
    setRows((rs) =>
      rs.map((r) =>
        r.kind === "param" && r.key === key ? { ...r, [field]: value } : r,
      ),
    );
  }

  function setSpecField(
    key: string,
    field: "specKey" | "specValue",
    value: string,
  ) {
    setRows((rs) =>
      rs.map((r) =>
        r.kind === "spec" && r.key === key ? { ...r, [field]: value } : r,
      ),
    );
  }

  const applyLabel = t("marketplace-document-scanner-apply-selected-count").replace(
    "{n}",
    String(checkedCount),
  );

  return (
    <>
      {rows.length === 0 ? (
        <div className="flex-1 px-6 py-10 text-center text-xs text-muted-foreground">
          {t("marketplace-document-scanner-no-fields")}
        </div>
      ) : (
        <>
          {/* Toolbar — count + select-all / select-none. */}
          <div className="flex items-center justify-between gap-2 px-6 py-2 border-b bg-muted/30">
            <span className="text-[11px] text-muted-foreground">
              {applyLabel}
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-[10px] px-2"
                onClick={() => setAll(true)}
              >
                {t("marketplace-document-scanner-select-all")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 text-[10px] px-2"
                onClick={() => setAll(false)}
              >
                {t("marketplace-document-scanner-select-none")}
              </Button>
            </div>
          </div>

          {/* Scrollable row list. */}
          <div className="px-6 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
            {rows.map((row) => (
              <RowView
                key={row.key}
                row={row}
                t={t}
                onToggle={() => toggleChecked(row.key)}
                onSetScalar={(v) => setScalarValue(row.key, v)}
                onSetParam={(field, v) => setParamField(row.key, field, v)}
                onSetSpec={(field, v) => setSpecField(row.key, field, v)}
              />
            ))}
          </div>
        </>
      )}

      {/* Sticky footer — Cancel + Apply Selected (N fields). */}
      <DialogFooter className="sticky bottom-0 bg-background border-t py-3 px-6 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
        >
          {t("marketplace-document-scanner-cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onApplyClick}
          disabled={checkedCount === 0}
        >
          <Wand2 className="h-3.5 w-3.5 mr-1" />
          {applyLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

function RowView({
  row,
  t,
  onToggle,
  onSetScalar,
  onSetParam,
  onSetSpec,
}: {
  row: SelectiveRow;
  t: (key: string) => string;
  onToggle: () => void;
  onSetScalar: (v: string) => void;
  onSetParam: (
    field: "name" | "value" | "unit" | "spec" | "result",
    v: string,
  ) => void;
  onSetSpec: (field: "specKey" | "specValue", v: string) => void;
}) {
  // Uncertain rows get an amber tint so they're visually distinct.
  const uncertainTone = row.uncertain
    ? "border-amber-500/40 bg-amber-500/5"
    : "border-border bg-background";
  const placeholder = t("marketplace-document-scanner-empty-placeholder");

  return (
    <div className={`rounded-md border ${uncertainTone} p-2`}>
      {row.kind === "scalar" && (
        <div className="flex items-start gap-3">
          <Checkbox
            checked={row.checked}
            onCheckedChange={() => onToggle()}
            className="mt-2.5"
          />
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
                {t(row.labelKey)}
              </Label>
              {row.uncertain && (
                <Badge
                  variant="outline"
                  className="text-[9px] border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                >
                  <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                  {t("marketplace-document-scanner-uncertain-tag")}
                </Badge>
              )}
            </div>
            <Input
              value={row.value}
              onChange={(e) => onSetScalar(e.target.value)}
              placeholder={placeholder}
              className="h-8 text-xs"
            />
          </div>
        </div>
      )}

      {row.kind === "param" && (
        <Collapsible>
          <div className="flex items-start gap-3">
            <Checkbox
              checked={row.checked}
              onCheckedChange={() => onToggle()}
              className="mt-2.5"
            />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Label className="text-[11px] font-medium uppercase tracking-wide">
                  {t("marketplace-document-scanner-parameters")} #{row.index + 1}
                </Label>
                {row.uncertain && (
                  <Badge
                    variant="outline"
                    className="text-[9px] border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  >
                    <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                    {t("marketplace-document-scanner-uncertain-tag")}
                  </Badge>
                )}
                <span className="text-[10px] text-muted-foreground truncate ml-auto">
                  {row.name || "—"}: {row.value || "—"} {row.unit}
                </span>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-2"
                  >
                    <ChevronDown className="h-3 w-3" />
                    {t("marketplace-document-scanner-parameters-show-details")}
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                  <ParamInput
                    label="Name"
                    value={row.name}
                    onChange={(v) => onSetParam("name", v)}
                    placeholder={placeholder}
                  />
                  <ParamInput
                    label="Value"
                    value={row.value}
                    onChange={(v) => onSetParam("value", v)}
                    placeholder={placeholder}
                  />
                  <ParamInput
                    label="Unit"
                    value={row.unit}
                    onChange={(v) => onSetParam("unit", v)}
                    placeholder={placeholder}
                  />
                  <ParamInput
                    label="Spec"
                    value={row.spec}
                    onChange={(v) => onSetParam("spec", v)}
                    placeholder={placeholder}
                  />
                  <ParamInput
                    label="Result"
                    value={row.result}
                    onChange={(v) => onSetParam("result", v)}
                    placeholder={placeholder}
                  />
                </div>
              </CollapsibleContent>
            </div>
          </div>
        </Collapsible>
      )}

      {row.kind === "spec" && (
        <div className="flex items-start gap-3">
          <Checkbox
            checked={row.checked}
            onCheckedChange={() => onToggle()}
            className="mt-2.5"
          />
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
                {t("marketplace-document-scanner-spec-key")}
              </Label>
              <Input
                value={row.specKey}
                onChange={(e) => onSetSpec("specKey", e.target.value)}
                placeholder="spec"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
                  {t("marketplace-document-scanner-spec-value")}
                </Label>
                {row.uncertain && (
                  <Badge
                    variant="outline"
                    className="text-[9px] border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  >
                    <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                    {t("marketplace-document-scanner-uncertain-tag")}
                  </Badge>
                )}
              </div>
              <Input
                value={row.specValue}
                onChange={(e) => onSetSpec("specValue", e.target.value)}
                placeholder={placeholder}
                className="h-8 text-xs"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ParamInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
        {label}
      </Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
    </div>
  );
}

// ─── Row builder ───────────────────────────────────────────────────────────
//
// Pure function — given the parsed result, returns the row list with
// initial checked/uncertain flags. Fields are checked-by-default when:
//   • they have a non-empty value AND
//   • they are NOT in the AI's `uncertain_fields` list AND
//   • overall confidence is not "low".
// Fields with low overall confidence or empty values default to unchecked
// so the user must explicitly opt-in to importing them.

function buildRows(
  scanType: ParseType,
  parsedCoA: CoAResult | null,
  parsedSpec: SpecSheetResult | null,
): SelectiveRow[] {
  const rows: SelectiveRow[] = [];

  // A field is "uncertain" if its key (or a string containing it) appears
  // in the AI's uncertain_fields list. The check is case-insensitive and
  // includes "parameters" / "specifications" as parent markers.
  function makeUncertainCheck(uncertainFields: string[] | undefined) {
    const set = new Set<string>((uncertainFields || []).map((f) => f.toLowerCase()));
    return (fieldKey: string, parentKeys: string[] = []) =>
      parentKeys.some((p) => set.has(p.toLowerCase())) ||
      set.has(fieldKey.toLowerCase()) ||
      [...set].some(
        (f) =>
          f.includes(fieldKey.toLowerCase()) ||
          fieldKey.toLowerCase().includes(f),
      );
  }

  // Default checked/uncertain/value for a scalar field.
  function scalarDefaults(
    rawValue: string | undefined,
    fieldKey: string,
    confidence: ConfidenceLevel | undefined,
    isUncertain: boolean,
  ): { value: string; checked: boolean } {
    const value = (rawValue || "").trim();
    const checked =
      value.length > 0 && !isUncertain && confidence !== "low";
    return { value, checked };
  }

  if (scanType === "coa" && parsedCoA) {
    const isUncertain = makeUncertainCheck(parsedCoA.uncertainFields);
    const confidence = parsedCoA.confidence;

    // Scalar field definitions: [key, labelKey, rawValue, parentKeys?]
    const scalarDefs: Array<{
      key: string;
      labelKey: string;
      raw: string | undefined;
      parentKeys?: string[];
    }> = [
      { key: "productName", labelKey: "marketplace-product-name", raw: parsedCoA.product },
      { key: "batch", labelKey: "marketplace-document-scanner-batch", raw: parsedCoA.batch },
      { key: "date", labelKey: "marketplace-document-scanner-date", raw: parsedCoA.date },
      {
        key: "manufacturer",
        labelKey: "marketplace-document-scanner-manufacturer",
        raw: parsedCoA.manufacturer,
      },
      {
        key: "grade",
        labelKey: "marketplace-document-scanner-grade",
        raw: parsedCoA.grade,
      },
      {
        key: "origin",
        labelKey: "marketplace-document-scanner-origin",
        raw: parsedCoA.origin,
      },
      {
        key: "manufactureDate",
        labelKey: "marketplace-document-scanner-manufacture-date",
        raw: parsedCoA.manufactureDate,
      },
      {
        key: "expiryDate",
        labelKey: "marketplace-document-scanner-expiry",
        raw: parsedCoA.expiryDate,
      },
      {
        key: "storage",
        labelKey: "marketplace-document-scanner-storage",
        raw: parsedCoA.storage,
      },
      {
        key: "packaging",
        labelKey: "marketplace-document-scanner-packaging",
        raw: parsedCoA.packaging,
      },
      {
        key: "certifications",
        labelKey: "marketplace-document-scanner-certifications",
        raw: (parsedCoA.certifications || []).join(", "),
      },
    ];

    for (const def of scalarDefs) {
      const u = isUncertain(def.key, def.parentKeys || []);
      const { value, checked } = scalarDefaults(def.raw, def.key, confidence, u);
      rows.push({
        kind: "scalar",
        key: def.key,
        labelKey: def.labelKey,
        value,
        checked,
        uncertain: u,
      });
    }

    // Parameters — one expandable row per CoAParameter.
    const params = parsedCoA.parameters || [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const u =
        isUncertain("parameters") ||
        isUncertain(`parameters[${i}]`) ||
        isUncertain(`parameter[${i}]`);
      const hasAnyValue = !!(p.name || p.value || p.unit || p.spec || p.result);
      const checked = hasAnyValue && !u && confidence !== "low";
      rows.push({
        kind: "param",
        key: `param_${i}`,
        index: i,
        name: p.name || "",
        value: p.value || "",
        unit: p.unit || "",
        spec: p.spec || "",
        result: p.result || "",
        checked,
        uncertain: u,
      });
    }
  } else if (scanType === "spec_sheet" && parsedSpec) {
    const isUncertain = makeUncertainCheck(parsedSpec.uncertainFields);
    const confidence = parsedSpec.confidence;

    const scalarDefs: Array<{
      key: string;
      labelKey: string;
      raw: string | undefined;
      parentKeys?: string[];
    }> = [
      {
        key: "productName",
        labelKey: "marketplace-product-name",
        raw: parsedSpec.productName,
      },
      {
        key: "category",
        labelKey: "marketplace-product-category",
        raw: parsedSpec.category,
      },
      { key: "sku", labelKey: "marketplace-document-scanner-sku", raw: parsedSpec.sku },
      {
        key: "hsCode",
        labelKey: "marketplace-document-scanner-hs-code",
        raw: parsedSpec.hsCode,
      },
      {
        key: "brand",
        labelKey: "marketplace-document-scanner-brand",
        raw: parsedSpec.brand,
      },
      {
        key: "originCountry",
        labelKey: "marketplace-document-scanner-origin",
        raw: parsedSpec.originCountry,
      },
      {
        key: "shelfLife",
        labelKey: "marketplace-document-scanner-shelf-life",
        raw: parsedSpec.shelfLife,
      },
      {
        key: "storage",
        labelKey: "marketplace-document-scanner-storage",
        raw: parsedSpec.storage,
      },
      {
        key: "containerCapacity",
        labelKey: "marketplace-document-scanner-container-capacity",
        raw: parsedSpec.containerCapacity,
      },
      {
        key: "certifications",
        labelKey: "marketplace-document-scanner-certifications",
        raw: (parsedSpec.certifications || []).join(", "),
      },
      {
        key: "applications",
        labelKey: "marketplace-document-scanner-applications",
        raw: (parsedSpec.applications || []).join(", "),
      },
    ];

    for (const def of scalarDefs) {
      const u = isUncertain(def.key, def.parentKeys || []);
      const { value, checked } = scalarDefaults(def.raw, def.key, confidence, u);
      rows.push({
        kind: "scalar",
        key: def.key,
        labelKey: def.labelKey,
        value,
        checked,
        uncertain: u,
      });
    }

    // Specifications map — one row per { key, value }.
    const entries = Object.entries(parsedSpec.specifications || {});
    entries.forEach(([k, v], i) => {
      const u =
        isUncertain("specifications") ||
        isUncertain(`specifications[${i}]`) ||
        isUncertain(`specifications.${k}`);
      const value = (v || "").trim();
      const checked = value.length > 0 && !u && confidence !== "low";
      rows.push({
        kind: "spec",
        key: `spec_${i}`,
        specKey: k,
        specValue: value,
        checked,
        uncertain: u,
      });
    });
  }

  return rows;
}
