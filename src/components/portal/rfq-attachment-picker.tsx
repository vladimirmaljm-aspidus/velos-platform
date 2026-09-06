"use client";

import * as React from "react";
import { FileText, FileUp, X, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";

/**
 * Shared attachment picker for the two RFQ entry points (the catalog dialog
 * and the dedicated RFQ page form). Controlled: the parent owns the `files`
 * array and performs the actual upload on submit; this component handles
 * selection UX (click / drag&drop), client-side validation (size, empty,
 * count cap) and the per-file progress display.
 */

/** Client-side mirror of MAX_UPLOAD_SIZE (25 MB) from lib/upload/constants. */
const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** Client-side mirror of MAX_RFQ_ATTACHMENTS from lib/portal/rfq-attachments. */
export const RFQ_MAX_FILES = 10;
/** Extensions the backend verify-file accepts (magic-byte verified server-side). */
export const RFQ_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function RfqAttachmentPicker({
  files,
  onFiles,
  disabled,
  progress,
}: {
  files: File[];
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** index of the file currently uploading (per-file spinner/checkmark). */
  progress?: { index: number; done: boolean } | null;
}) {
  const t = useT();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);

  function addFiles(incoming: FileList | null) {
    if (!incoming || disabled) return;
    const list = Array.from(incoming);
    for (const f of list) {
      if (f.size > MAX_FILE_SIZE) {
        toast.error(`${f.name}: ${t("portal-rfq-attach-too-large")} (25 MB)`);
      } else if (f.size === 0) {
        toast.error(`${f.name}: ${t("portal-rfq-attach-empty")}`);
      }
    }
    const ok = list.filter((f) => f.size > 0 && f.size <= MAX_FILE_SIZE);
    onFiles([...files, ...ok].slice(0, RFQ_MAX_FILES));
    if (ok.length > RFQ_MAX_FILES - files.length) {
      toast.warning(t("portal-rfq-attach-max-files"));
    }
  }

  function removeFile(idx: number) {
    if (disabled) return;
    onFiles(files.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && fileInputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={t("portal-rfq-attach-drop-hint")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
        }}
        className={`rounded-lg border-2 border-dashed transition-colors ${disabled ? "opacity-50 cursor-not-allowed border-border/70" : "cursor-pointer"} ${dragOver ? "border-primary bg-primary/5" : "border-border/70 hover:border-primary/40"}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={RFQ_ACCEPT}
          className="hidden"
          disabled={disabled}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="flex flex-col items-center gap-1.5 py-6 px-4 text-center">
          <FileUp className="size-6 text-primary/70" />
          <p className="text-sm font-medium">{t("portal-rfq-attach-drop-hint")}</p>
          <p className="text-xs text-muted-foreground">
            {t("portal-rfq-attach-formats")} · {t("portal-rfq-attach-limit")}
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm"
            >
              {progress && progress.index === i ? (
                progress.done ? (
                  <CheckCircle2 className="size-4 text-emerald-600 shrink-0" />
                ) : (
                  <Loader2 className="size-4 animate-spin shrink-0" />
                )
              ) : (
                <FileText className="size-4 text-muted-foreground shrink-0" />
              )}
              <span className="truncate flex-1">{f.name}</span>
              <span className="text-xs text-muted-foreground tabular shrink-0">{fmtBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                disabled={disabled}
                aria-label={`${t("portal-action-remove")}: ${f.name}`}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("portal-rfq-attach-why")}</p>
    </div>
  );
}

/**
 * Shared upload-on-submit helper: uploads each file via /api/portal/upload
 * (category "rfq") sequentially and returns the created upload row ids.
 * Throws with a descriptive message on the first failure (the caller's
 * toast shows which file failed).
 */
export async function uploadRfqAttachments(
  files: File[],
  productName: string,
  onProgress?: (p: { index: number; done: boolean } | null) => void,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.({ index: i, done: false });
    const fd = new FormData();
    fd.append("file", files[i]);
    fd.append("category", "rfq");
    fd.append("doc_type", "rfq_specification");
    fd.append("description", (productName || "RFQ specification").slice(0, 120));
    const up = await fetch("/api/portal/upload", { method: "POST", body: fd });
    if (!up.ok) {
      const e = await up.json().catch(() => ({}));
      throw new Error(`${files[i].name}: ${e.error || "upload failed"}`);
    }
    const row = await up.json();
    ids.push(row.id);
    onProgress?.({ index: i, done: true });
  }
  onProgress?.(null);
  return ids;
}
