"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
} from "@/components/ui/dialog";
import {
  Search,
  Download,
  FolderOpen,
  Loader2,
  FileCheck,
  Receipt,
  FileSignature,
  File as FileIcon,
  Eye,
  AlertCircle,
  FileText,
} from "lucide-react";
import { fmtDate, fmtBytes } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import type { SharedDocument } from "@/lib/supabase/types";

type DocCategory = SharedDocument["category"];

const CATEGORY_META: Record<
  DocCategory,
  {
    labelKey: string;
    badgeClass: string;
    iconBg: string;
    iconColor: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  contract: {
    labelKey: "portal-doc-cat-contract",
    badgeClass: "border-transparent bg-chart-1 text-white",
    iconBg: "bg-gradient-to-br from-primary/15 to-primary/5",
    iconColor: "text-primary",
    icon: FileSignature,
  },
  invoice: {
    labelKey: "portal-doc-cat-invoice",
    badgeClass: "border-transparent bg-chart-4 text-white",
    iconBg: "bg-gradient-to-br from-rose-500/15 to-rose-500/5",
    iconColor: "text-rose-600 dark:text-rose-400",
    icon: Receipt,
  },
  spec: {
    labelKey: "portal-doc-cat-spec",
    badgeClass: "border-transparent bg-chart-2 text-white",
    iconBg: "bg-gradient-to-br from-teal-500/15 to-teal-500/5",
    iconColor: "text-teal-600 dark:text-teal-400",
    icon: FileCheck,
  },
  other: {
    labelKey: "portal-doc-cat-other",
    badgeClass: "bg-secondary text-secondary-foreground",
    iconBg: "bg-gradient-to-br from-muted to-muted/50",
    iconColor: "text-muted-foreground",
    icon: FileIcon,
  },
};

/** MIME types that can be previewed inline in the browser */
const PREVIEWABLE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE_TYPES.has(mimeType);
}

export function PortalDocuments() {
  const t = useT();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [previewDoc, setPreviewDoc] = useState<SharedDocument | null>(null);

  const docsQ = useQuery<{ items: SharedDocument[]; total: number }>({
    queryKey: ["portal-documents"],
    queryFn: async () => {
      const r = await fetch("/api/portal/documents");
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
  });

  const allItems = docsQ.data?.items || [];

  const categories = useMemo(() => {
    const set = new Set<DocCategory>();
    allItems.forEach((d) => set.add(d.category));
    return Array.from(set);
  }, [allItems]);

  const filtered = useMemo(() => {
    let items = allItems;
    if (categoryFilter !== "all") {
      items = items.filter((d) => d.category === categoryFilter);
    }
    if (search) {
      items = items.filter((d) =>
        d.filename.toLowerCase().includes(search.toLowerCase())
      );
    }
    return items;
  }, [allItems, categoryFilter, search]);

  const handleDownload = useCallback((doc: SharedDocument) => {
    const link = document.createElement("a");
    link.href = `/api/portal/documents/${doc.id}/download`;
    link.download = doc.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const handlePreview = useCallback((doc: SharedDocument) => {
    if (!isPreviewable(doc.mime_type)) {
      toast.info(t("portal-doc-preview-na"));
      handleDownload(doc);
      return;
    }
    setPreviewDoc(doc);
  }, [handleDownload, t]);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("portal-documents-title").split(" ")[0]}{" "}
            <span className="text-gradient-emerald">
              {t("portal-documents-title").split(" ").slice(1).join(" ")}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {docsQ.data
              ? t("portal-documents-count").replace("{n}", String(filtered.length))
              : t("portal-documents-loading")}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("portal-search-files")}
              className="pl-10 h-10 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-10 w-full sm:w-44">
              <SelectValue placeholder={t("portal-all-categories")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("portal-all-categories")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(CATEGORY_META[c].labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {docsQ.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : docsQ.isError ? (
        // FIX-DOCS-CHECK: render an explicit error state instead of a
        // misleading "empty" state when the fetch fails. Previously the
        // view fell through to the `filtered.length === 0` branch and
        // showed the "no documents" empty card — the partner would
        // conclude they had no documents when actually the request had
        // failed (auth expired, network, etc.). The retry button re-runs
        // the query; if the underlying cause was an expired session the
        // next failure will surface a 401 and the portal shell will
        // redirect to login (see portal-shell.tsx interceptors).
        <div className="card-premium p-12 flex flex-col items-center justify-center text-center">
          <div className="size-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <AlertCircle className="size-7 text-destructive" />
          </div>
          <p className="text-base font-semibold">
            {t("portal-doc-load-error-title")}
          </p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
            {t("portal-doc-load-error-desc")}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => docsQ.refetch()}
          >
            {t("portal-action-try-again")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyDocuments t={t} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll pr-1">
          {filtered.map((doc) => {
            const meta = CATEGORY_META[doc.category];
            const Icon = meta.icon;
            const canPreview = isPreviewable(doc.mime_type);
            return (
              <div
                key={doc.id}
                className="card-premium p-5 group cursor-default hover:-translate-y-0.5"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "size-12 rounded-xl flex items-center justify-center shrink-0 smooth group-hover:scale-105",
                      meta.iconBg
                    )}
                  >
                    <Icon className={cn("size-5", meta.iconColor)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-semibold truncate leading-snug"
                      title={doc.filename}
                    >
                      {doc.filename}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge
                        className={cn("text-xs px-1.5 py-0", meta.badgeClass)}
                      >
                        {t(meta.labelKey)}
                      </Badge>
                      <span className="text-xs text-muted-foreground tabular">
                        {fmtBytes(doc.size)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground tabular">
                    {t("portal-doc-uploaded").replace("{date}", fmtDate(doc.created_at))}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {canPreview && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePreview(doc);
                        }}
                        className="h-8 smooth opacity-80 group-hover:opacity-100 hover:shadow-soft"
                      >
                        <Eye className="size-3.5 mr-1" /> {t("portal-action-view")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(doc);
                      }}
                      className="h-8 smooth opacity-80 group-hover:opacity-100 hover:shadow-soft"
                    >
                      <Download className="size-3.5 mr-1" /> {t("portal-action-download")}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Document Preview Dialog */}
      <DocumentPreviewDialog
        open={!!previewDoc}
        onOpenChange={(open) => {
          if (!open) setPreviewDoc(null);
        }}
        document={previewDoc}
        t={t}
      />
    </div>
  );
}

// ─── Document Preview Dialog ────────────────────────────────────────────────

function DocumentPreviewDialog({
  open,
  onOpenChange,
  document: doc,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: SharedDocument | null;
  t: (k: string) => string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Reset state when dialog opens
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setLoading(true);
        setError(false);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange]
  );

  if (!doc) return null;

  const previewUrl = `/api/portal/documents/${doc.id}/download?mode=inline`;
  const downloadUrl = `/api/portal/documents/${doc.id}/download`;
  const isPdf = doc.mime_type === "application/pdf";
  const isImage = doc.mime_type?.startsWith("image/");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="p-4 pb-3 border-b flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="size-5 text-primary shrink-0" />
            <DialogTitle className="text-base truncate">{doc.filename}</DialogTitle>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground tabular">
              {fmtBytes(doc.size)}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => {
                const link = document.createElement("a");
                link.href = downloadUrl;
                link.download = doc.filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
              }}
            >
              <Download className="size-3.5 mr-1" /> {t("portal-action-download")}
            </Button>
          </div>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {t("portal-doc-preview-of").replace("{filename}", doc.filename)}
        </DialogDescription>

        {/* Body */}
        <div className="flex-1 min-h-0 relative bg-muted/30">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
              <AlertCircle className="size-10 text-destructive" />
              <p className="text-sm text-muted-foreground">{t("portal-doc-preview-failed")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(false);
                  setLoading(true);
                }}
              >
                {t("portal-action-try-again")}
              </Button>
            </div>
          )}

          {isPdf && (
            <iframe
              src={previewUrl}
              className="w-full h-[75vh] border-0"
              title={t("portal-doc-preview-of").replace("{filename}", doc.filename)}
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setError(true);
              }}
            />
          )}

          {isImage && (
            <div className="flex items-center justify-center p-4 h-[75vh]">
              <img
                src={previewUrl}
                alt={doc.filename}
                className="max-w-full max-h-full object-contain"
                onLoad={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  setError(true);
                }}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Empty State ────────────────────────────────────────────────────────────

function EmptyDocuments({ t }: { t: (k: string) => string }) {
  return (
    <div className="card-premium p-12 flex flex-col items-center justify-center text-center">
      <div className="size-16 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center mb-4">
        <FolderOpen className="size-7 text-primary" />
      </div>
      <p className="text-base font-semibold">{t("portal-doc-empty-title")}</p>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {t("portal-doc-empty-desc")}
      </p>
    </div>
  );
}
