"use client";

import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, Trash2, Eye, FileText, Receipt, FileCheck, ScrollText, ClipboardList, File, GitBranch, Clock, History,
  Upload, ShieldCheck, XCircle, Loader2, Link as LinkIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { fmtDate, fmtDateTime } from "@/lib/utils/format";
import {
  DocumentRegisterEntry, DocumentRevision, DocumentType, Partner,
} from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { PartnerPicker } from "@/components/common/partner-picker";
import { useAppStore, isAdmin } from "@/lib/store/app-store";

type DocStatus = "current" | "superseded" | "archived";

const TYPE_LABEL_KEY: Record<DocumentType, string> = {
  offer: "fin-doc-type-offer",
  invoice: "fin-doc-type-invoice",
  proforma: "fin-doc-type-proforma",
  contract: "fin-doc-type-contract",
  spec: "fin-doc-type-spec",
  // BUILD-LOI — LOI entries are registered in document_register by the
  // LOI send route (type='loi'). Reuse the LOI title i18n key (translated
  // as "Letters of Intent") for the badge label so the document register
  // surfaces LOIs by the same label the admin sidebar uses.
  loi: "loi-title",
  other: "fin-doc-type-other",
};

const TYPE_PREFIX: Record<DocumentType, string> = {
  offer: "OF", invoice: "INV", proforma: "PR", contract: "CT", spec: "SP", loi: "LOI", other: "OT",
};

const TYPE_ICON: Record<DocumentType, typeof FileText> = {
  offer: FileText, invoice: Receipt, proforma: FileCheck, contract: ScrollText, spec: ClipboardList, loi: ScrollText, other: File,
};

function TypeBadge({ type }: { type: DocumentType }) {
  const t = useT();
  const cls: Record<DocumentType, string> = {
    offer: "border-transparent bg-[var(--chart-1)] text-white",
    invoice: "border-transparent bg-[var(--chart-4)] text-white",
    proforma: "border-transparent bg-[var(--chart-2)] text-white",
    contract: "border-transparent bg-emerald-600 text-white",
    spec: "border-transparent bg-[var(--chart-3)] text-black",
    // BUILD-LOI — amber-tinted badge so LOI rows visually match the LOI
    // list view's "expired" badge color family without colliding with the
    // green contract / blue offer badges.
    loi: "border-transparent bg-amber-500 text-white",
    other: "border-transparent bg-muted text-muted-foreground",
  };
  const Icon = TYPE_ICON[type];
  return (
    <Badge className={`gap-1 ${cls[type]}`}>
      <Icon className="size-3" /> {t(TYPE_LABEL_KEY[type])}
    </Badge>
  );
}

function StatusBadge({ status }: { status: DocStatus }) {
  const t = useT();
  if (status === "current") return <Badge className="border-transparent bg-emerald-600 text-white">{t("doc-status-current")}</Badge>;
  if (status === "superseded") return <Badge className="border-transparent bg-muted text-muted-foreground">{t("doc-status-superseded")}</Badge>;
  return <Badge variant="secondary">{t("doc-status-archived")}</Badge>;
}

function VersionBadge({ status, version }: { status: DocStatus; version: number }) {
  const cls = status === "current"
    ? "border-transparent bg-emerald-600 text-white"
    : status === "superseded"
      ? "border-transparent bg-muted text-muted-foreground"
      : "bg-secondary text-secondary-foreground";
  return <Badge className={`tabular ${cls}`}>V{version}</Badge>;
}

// ── FIX-TENANT-DOC: verification workflow badge ──
// Reads the metadata-sourced `verification_status` field surfaced by the
// API (normalizeEntry in route.ts). Legacy rows created before this
// feature have NO verification_status in metadata — they render as
// "Untracked" with a tooltip explaining they should be treated as
// verified (since they pre-date the workflow).
function VerifyStatusBadge({ entry }: { entry: DocumentRegisterEntry }) {
  const t = useT();
  const status = entry.verification_status;
  if (!status) {
    // Legacy row — metadata key absent.
    return (
      <Badge
        variant="outline"
        className="border-border/60 text-muted-foreground"
        title={t("doc-vs-legacy-tooltip")}
      >
        {t("doc-vs-legacy")}
      </Badge>
    );
  }
  if (status === "verified") {
    return (
      <Badge className="border-transparent bg-emerald-600 text-white">
        <ShieldCheck className="size-3 mr-1" />
        {t("doc-vs-verified")}
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge className="border-transparent bg-destructive text-destructive-foreground">
        <XCircle className="size-3 mr-1" />
        {t("doc-vs-rejected")}
      </Badge>
    );
  }
  return (
    <Badge className="border-transparent bg-amber-500 text-white">
      <Clock className="size-3 mr-1" />
      {t("doc-vs-pending")}
    </Badge>
  );
}

function parseNumberParts(number: string): { prefix: string; year: string; seq: string } | null {
  // e.g. OF-2026-001-V2 → { prefix: "OF", year: "2026", seq: "001" }
  const m = number.match(/^([A-Z]+)-(\d{4})-(\d+)/);
  if (!m) return null;
  return { prefix: m[1], year: m[2], seq: m[3] };
}

function nextSeqForType(entries: DocumentRegisterEntry[], type: DocumentType): string {
  const year = String(new Date().getFullYear());
  const prefix = TYPE_PREFIX[type];
  let max = 0;
  for (const e of entries) {
    const parts = parseNumberParts(e.number);
    if (parts && parts.prefix === prefix && parts.year === year) {
      const n = parseInt(parts.seq, 10);
      if (n > max) max = n;
    }
  }
  return String(max + 1).padStart(3, "0");
}

export function DocumentRegisterView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();
  const user = useAppStore((s) => s.user);
  const canVerifyReject = isAdmin(user);

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [formParent, setFormParent] = useState<DocumentRegisterEntry | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // FIX-TENANT-DOC: upload dialog + reject-reason dialog state.
  const [showUpload, setShowUpload] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<DocumentRegisterEntry | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["document-register", tenantKey, debouncedSearch, typeFilter, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const r = await fetch(api(`/api/document-register?${params}`));
      if (!r.ok) throw new Error("Failed to load document register");
      return r.json() as Promise<{ items: DocumentRegisterEntry[]; total: number }>;
    },
  });

  const partners = useQuery({
    queryKey: ["partners", tenantKey, "list", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=200`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  const detail = useQuery({
    queryKey: ["document-register", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/document-register/${detailId}`));
      if (!r.ok) throw new Error("Failed to load document");
      return r.json() as Promise<{ items: DocumentRevision[] }>;
    },
    enabled: !!detailId,
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/document-register/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to delete entry");
    },
    onSuccess: () => {
      toast.success(t("fin-document-entry-deleted"));
      qc.invalidateQueries({ queryKey: ["document-register", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("fin-delete-failed")),
  });

  // FIX-TENANT-DOC: verify / reject mutations. Both hit the new PUT
  // /api/document-register/[id] route. The route is permission-gated
  // server-side (`document-register.update`), so the client-side
  // `canVerifyReject` check is just a UX gate (hides the buttons from
  // non-admins) — the server enforces the real auth.
  const verifyMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/document-register/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification_status: "verified" }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Verify failed");
      }
    },
    onSuccess: () => {
      toast.success(t("doc-toast-verified"));
      qc.invalidateQueries({ queryKey: ["document-register", tenantKey] });
    },
    onError: (e: any) => toast.error(e.message || t("doc-toast-verify-failed")),
  });

  const rejectMut = useMutation({
    mutationFn: async (args: { id: string; reason: string }) => {
      const r = await fetch(api(`/api/document-register/${args.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification_status: "rejected", reject_reason: args.reason }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Reject failed");
      }
    },
    onSuccess: () => {
      toast.success(t("doc-toast-rejected"));
      qc.invalidateQueries({ queryKey: ["document-register", tenantKey] });
      setRejectTarget(null);
      setRejectReason("");
    },
    onError: (e: any) => toast.error(e.message || t("doc-toast-verify-failed")),
  });

  const items = data?.items || [];
  const partnerList = partners.data?.items || [];
  const partnerName = (id: string | null) => (id ? (partnerList.find((p) => p.id === id)?.name || "—") : "—");

  function openNew() {
    setFormParent(null);
    setShowForm(true);
  }

  function openVersion(parent: DocumentRegisterEntry) {
    setFormParent(parent);
    setShowForm(true);
  }

  return (
    <div>
      <PageHeader
        title={t("doc-document-register-title")}
        description={`${data?.total ?? 0} ${t("fin-entries-suffix")}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* FIX-TENANT-DOC: new "Upload Document" button — opens the
             * upload dialog with a file picker + linking dropdowns. The
             * existing "New entry" button (JSON metadata-only entry)
             * stays alongside for the legacy "register metadata without
             * uploading a file" workflow (e.g. logging a paper-originals
             * document). */}
            <Button variant="outline" onClick={() => setShowUpload(true)}>
              <Upload className="size-4 mr-1" /> {t("doc-upload-document")}
            </Button>
            <Button onClick={openNew}>
              <Plus className="size-4 mr-1" /> {t("doc-new-entry")}
            </Button>
          </div>
        }
      />
      <ModuleInfoTooltip
        title="Document Register"
        description="Upload, organize, and verify trade documents (contracts, certificates, bills of lading). Link to deals, invoices, and partners."
        howToUse={["Upload documents (PDF, images, docs)", "Link to deals, invoices, or offers", "Verify documents (pending → verified → rejected)", "Version control — superseded documents are archived", "Search and filter by type or status"]}
      />

      <Card className="mb-4 border-border/60 shadow-soft">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("fin-search-number-title")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("type")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("doc-all-types")}</SelectItem>
              <SelectItem value="offer">{t("fin-doc-type-offer")}</SelectItem>
              <SelectItem value="invoice">{t("fin-doc-type-invoice")}</SelectItem>
              <SelectItem value="proforma">{t("fin-doc-type-proforma")}</SelectItem>
              <SelectItem value="contract">{t("fin-doc-type-contract")}</SelectItem>
              <SelectItem value="spec">{t("fin-doc-type-spec")}</SelectItem>
              <SelectItem value="other">{t("fin-doc-type-other")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("fin-all-statuses")}</SelectItem>
              <SelectItem value="current">{t("doc-status-current")}</SelectItem>
              <SelectItem value="superseded">{t("doc-status-superseded")}</SelectItem>
              <SelectItem value="archived">{t("doc-status-archived")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft">
        <CardContent className="p-0">
          {isError ? (
            <div className="p-4">
              <QueryError onRetry={() => refetch()} />
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<FileText className="size-6" />}
              title={t("fin-no-documents")}
              description={t("fin-no-documents-desc")}
              action={<Button onClick={openNew}><Plus className="size-4 mr-1" /> {t("doc-new-entry")}</Button>}
            />
          ) : (
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("fin-number")}</TableHead>
                    <TableHead>{t("type")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("fin-title-col")}</TableHead>
                    <TableHead>{t("doc-version")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("fin-partner")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    {/* FIX-TENANT-DOC: new "Verification" column — surfaces the
                     * pending → verified → rejected workflow state. Hidden
                     * on small screens to keep the row readable. */}
                    <TableHead className="hidden lg:table-cell">{t("doc-verification-status")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("fin-created-col")}</TableHead>
                    <TableHead className="text-right">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((e) => (
                    <TableRow key={e.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setDetailId(e.id)}>
                      <TableCell className="font-mono text-xs">{e.number || "—"}</TableCell>
                      <TableCell><TypeBadge type={e.type} /></TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="font-medium truncate max-w-[220px]">{e.title || "—"}</div>
                      </TableCell>
                      <TableCell><VersionBadge status={e.status} version={e.version} /></TableCell>
                      <TableCell className="hidden lg:table-cell">{partnerName(e.partner_id)}</TableCell>
                      <TableCell><StatusBadge status={e.status} /></TableCell>
                      <TableCell className="hidden lg:table-cell"><VerifyStatusBadge entry={e} /></TableCell>
                      <TableCell className="hidden xl:table-cell">{fmtDate(e.created_at)}</TableCell>
                      <TableCell className="text-right" onClick={(ev) => ev.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(e.id)} title={t("view")} aria-label={t("view")}>
                            <Eye className="size-4" />
                          </Button>
                          {/* FIX-TENANT-DOC: download button for entries
                           * that have a stored file (legacy entries without
                           * an upload render nothing). Opens file_url in a
                           * new tab. */}
                          {e.file_url && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              asChild
                              title={t("doc-download")}
                              aria-label={t("doc-download")}
                            >
                              <a href={e.file_url} target="_blank" rel="noopener noreferrer">
                                <File className="size-4" />
                              </a>
                            </Button>
                          )}
                          {/* FIX-TENANT-DOC: Verify / Reject buttons. Only
                           * shown to admins (`canVerifyReject`) and only
                           * when the document is in "pending" state —
                           * verified / rejected rows keep only the other
                           * row actions (view / version / delete). */}
                          {canVerifyReject && e.verification_status === "pending" && (
                            <>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 text-emerald-600 hover:text-emerald-700"
                                onClick={() => verifyMut.mutate(e.id)}
                                disabled={verifyMut.isPending && verifyMut.variables === e.id}
                                title={t("doc-verify")}
                                aria-label={t("doc-verify")}
                              >
                                {verifyMut.isPending && verifyMut.variables === e.id
                                  ? <Loader2 className="size-4 animate-spin" />
                                  : <ShieldCheck className="size-4" />}
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 text-destructive"
                                onClick={() => { setRejectTarget(e); setRejectReason(""); }}
                                title={t("doc-reject")}
                                aria-label={t("doc-reject")}
                              >
                                <XCircle className="size-4" />
                              </Button>
                            </>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            onClick={() => openVersion(e)}
                            title={t("fin-new-version")} aria-label={t("fin-new-version")}
                          >
                            <GitBranch className="size-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(e.id)} title={t("delete")} aria-label={t("delete")}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Form dialog */}
      <DocumentFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        parent={formParent}
        existing={items}
        partners={partnerList}
        onSaved={() => {
          setShowForm(false);
          setFormParent(null);
          qc.invalidateQueries({ queryKey: ["document-register", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <History className="size-5" />
              <span className="font-mono text-base">
                {items.find((x) => x.id === detailId)?.number || t("doc-document-singular")}
              </span>
            </SheetTitle>
            <SheetDescription>
              {items.find((x) => x.id === detailId)?.title || t("doc-details")}
            </SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <DocumentDetail
              entry={items.find((x) => x.id === detailId) || null}
              revisions={detail.data?.items || []}
              partnerName={partnerName}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("fin-delete-document-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("fin-delete-document-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMut.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* FIX-TENANT-DOC: Upload Document dialog. Posts multipart/form-data
       * to /api/document-register with the file + metadata fields. The
       * route verifies the file via magic-bytes, uploads to the
       * `documents` Supabase Storage bucket, and inserts a row with
       * verification_status="pending" in metadata. */}
      <UploadDocumentDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        existing={items}
        onUploaded={() => {
          setShowUpload(false);
          qc.invalidateQueries({ queryKey: ["document-register", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* FIX-TENANT-DOC: reject reason dialog. Captures the mandatory
       * reject_reason before calling the PUT /api/document-register/[id]
       * route with verification_status="rejected". */}
      <AlertDialog
        open={!!rejectTarget}
        onOpenChange={(o) => {
          if (!o) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("doc-reject-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("doc-reject-desc")}
              {rejectTarget && (
                <span className="block mt-2 font-medium text-foreground">
                  {rejectTarget.number} — {rejectTarget.title || "—"}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason" className="text-xs text-muted-foreground">
              {t("doc-reject-reason-label")}
            </Label>
            <Textarea
              id="reject-reason"
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("doc-reject-reason-placeholder")}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => rejectTarget && rejectMut.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
              disabled={!rejectReason.trim() || rejectMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("doc-reject-confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---- Detail panel ----
function DocumentDetail({
  entry, revisions, partnerName,
}: {
  entry: DocumentRegisterEntry | null;
  revisions: DocumentRevision[];
  partnerName: (id: string | null) => string;
}) {
  const t = useT();
  if (!entry) {
    return <div className="p-4 text-sm text-muted-foreground">{t("fin-document-not-found")}</div>;
  }
  const initialNote =
    entry.metadata && typeof entry.metadata === "object" && "change_note" in entry.metadata
      ? String((entry.metadata as Record<string, unknown>).change_note || "")
      : "";

  // Build a unified timeline: initial creation + each revision (newest first)
  const timeline: { version: number; note: string; created_at: string; created_by: string | null; isInitial: boolean }[] = [];
  if (initialNote) {
    timeline.push({ version: entry.version, note: initialNote, created_at: entry.created_at, created_by: entry.created_by, isInitial: true });
  }
  for (const r of revisions) {
    timeline.push({ version: r.version, note: r.change_note, created_at: r.created_at, created_by: r.created_by, isInitial: false });
  }
  timeline.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div className="px-4 pb-6">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <TypeBadge type={entry.type} />
        <VersionBadge status={entry.status} version={entry.version} />
        <StatusBadge status={entry.status} />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><FileText className="size-3" /> {t("fin-title-col")}</p>
          <p className="text-sm font-medium truncate">{entry.title || "—"}</p>
        </div>
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground">{t("fin-partner")}</p>
          <p className="text-sm font-medium truncate">{partnerName(entry.partner_id)}</p>
        </div>
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground">{t("fin-reference-col")}</p>
          <p className="text-sm font-mono truncate">{entry.reference_id || "—"}</p>
        </div>
        <div className="p-3 rounded-md bg-muted/40">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="size-3" /> {t("fin-created-col")}</p>
          <p className="text-sm font-medium">{fmtDateTime(entry.created_at)}</p>
        </div>
      </div>

      {/* Revisions timeline */}
      <div className="border-t pt-4">
        <p className="text-sm font-medium mb-3 flex items-center gap-2">
          <GitBranch className="size-4" /> {t("fin-revisions-label")}
        </p>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6 border rounded-md">
            {t("fin-no-revisions-recorded")}
          </p>
        ) : (
          <ol className="relative border-l border-border ml-2 space-y-4">
            {timeline.map((r, i) => (
              <li key={i} className="ml-4">
                <span className={`absolute -left-[7px] mt-1 size-3 rounded-full border-2 border-background ${r.isInitial ? "bg-emerald-600" : "bg-[var(--chart-1)]"}`} />
                <div className="flex items-center gap-2 mb-1">
                  <Badge className={`tabular ${r.isInitial ? "border-transparent bg-emerald-600 text-white" : "border-transparent bg-[var(--chart-1)] text-white"}`}>
                    V{r.version}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(r.created_at)}</span>
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap">{r.note || "—"}</p>
                {r.created_by && (
                  <p className="text-xs text-muted-foreground mt-1">{t("fin-by-prefix")} {r.created_by}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// ---- Form dialog ----
function DocumentFormDialog({
  open, onOpenChange, parent, existing, partners, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  parent: DocumentRegisterEntry | null;
  existing: DocumentRegisterEntry[];
  partners: Partner[];
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const isVersion = !!parent;
  const [form, setForm] = useState<{
    type: DocumentType;
    title: string;
    partner_id: string;
    reference_id: string;
    version: number;
    change_note: string;
  }>({
    type: "offer", title: "", partner_id: "", reference_id: "", version: 1, change_note: "",
  });
  const [saving, setSaving] = useState(false);

  // Reset form when opening / when parent changes
  useEffect(() => {
    if (open) {
      if (parent) {
// eslint-disable-next-line react-hooks/set-state-in-effect
        setForm({
          type: parent.type,
          title: parent.title,
          partner_id: parent.partner_id || "",
          reference_id: parent.reference_id || "",
          version: parent.version + 1,
          change_note: "",
        });
      } else {
        setForm({
          type: "offer", title: "", partner_id: "", reference_id: "", version: 1, change_note: "",
        });
      }
    }
  }, [open, parent]);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Auto-generated number
  const number = useMemo(() => {
    const prefix = TYPE_PREFIX[form.type];
    const year = String(new Date().getFullYear());
    let seq: string;
    if (parent) {
      const parts = parseNumberParts(parent.number);
      seq = parts ? parts.seq : nextSeqForType(existing, form.type);
    } else {
      seq = nextSeqForType(existing, form.type);
    }
    return `${prefix}-${year}-${seq}-V${form.version}`;
  }, [form.type, form.version, parent, existing]);

  async function save() {
    if (!form.title.trim()) { toast.error(t("fin-enter-title-toast")); return; }
    setSaving(true);
    try {
      const basePayload = {
        number,
        type: form.type,
        title: form.title.trim(),
        partner_id: form.partner_id || null,
        reference_id: form.reference_id.trim() || null,
        version: Number(form.version) || 1,
        status: "current" as DocStatus,
        metadata: form.change_note.trim() ? { change_note: form.change_note.trim() } : null,
      };

      // 1) Create the new entry
      const createR = await fetch(api(`/api/document-register`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      });
      if (!createR.ok) {
        const e = await createR.json().catch(() => ({}));
        throw new Error(e.error || t("fin-failed-create-entry"));
      }

      // 2) If new version, mark parent as superseded
      if (parent) {
        const supR = await fetch(api(`/api/document-register`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: parent.id,
            status: "superseded",
          }),
        });
        if (!supR.ok) {
          toast.warning(t("fin-supersede-warning"));
        }
      }

      toast.success(parent ? t("fin-new-version-created") : t("fin-document-entry-created"));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("fin-save-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{parent ? `${t("fin-new-version-of")} ${parent.number}` : t("fin-new-document-entry")}</DialogTitle>
          <DialogDescription>
            {parent
              ? t("fin-auto-increments-desc")
              : t("fin-register-new-doc-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>{t("type")} *</Label>
            <Select
              value={form.type}
              onValueChange={(v) => set("type", v as DocumentType)}
              disabled={isVersion}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="offer">{t("fin-doc-type-offer")}</SelectItem>
                <SelectItem value="invoice">{t("fin-doc-type-invoice")}</SelectItem>
                <SelectItem value="proforma">{t("fin-doc-type-proforma")}</SelectItem>
                <SelectItem value="contract">{t("fin-doc-type-contract")}</SelectItem>
                <SelectItem value="spec">{t("fin-doc-type-spec")}</SelectItem>
                <SelectItem value="other">{t("fin-doc-type-other")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("doc-version")}</Label>
            <Input
              type="number"
              min={1}
              value={form.version}
              onChange={(e) => set("version", Number(e.target.value))}
            />
          </div>

          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("fin-title-required-label")} *</Label>
            <Input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder={t("fin-title-placeholder")}
              disabled={isVersion}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("fin-partner")}</Label>
            <PartnerPicker
              value={form.partner_id || ""}
              placeholder={t("fin-no-partner-option")}
              disabled={isVersion}
              onSelect={(p) => set("partner_id", p?.id || "")}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("fin-reference-id-label")}</Label>
            <Input
              value={form.reference_id}
              onChange={(e) => set("reference_id", e.target.value)}
              placeholder={t("fin-reference-id-placeholder")}
              disabled={isVersion}
            />
          </div>

          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("fin-generated-number")}</Label>
            <Input value={number} readOnly className="font-mono text-xs bg-muted/40" />
          </div>

          <div className="md:col-span-2 space-y-1.5">
            <Label>{t("fin-change-note")}</Label>
            <Textarea
              rows={3}
              value={form.change_note}
              onChange={(e) => set("change_note", e.target.value)}
              placeholder={parent ? t("fin-what-changed-placeholder") : t("fin-initial-note-placeholder")}
            />
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("fin-saving") : parent ? t("fin-create-version-btn") : t("fin-create-entry-btn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── FIX-TENANT-DOC: Upload Document dialog ────────────────────────────────
// Posts multipart/form-data to /api/document-register (the new multipart
// branch added to that route). The server validates + uploads the file to
// the `documents` Supabase Storage bucket and inserts a row with
// verification_status="pending" in metadata.
//
// Linking: the operator can optionally link the new document to an
// existing deal / invoice / offer. The link is stored in metadata so the
// detail panel + future cross-views can resolve it. We fetch the deal /
// invoice / offer lists lazily (only when the corresponding Select is
// opened) to keep the dialog's initial render fast — these lists can be
// large for tenants with years of data.
function UploadDocumentDialog({
  open, onOpenChange, existing, onUploaded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  existing: DocumentRegisterEntry[];
  onUploaded: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<{
    type: DocumentType;
    title: string;
    partner_id: string;
    change_note: string;
    linked_deal_id: string;
    linked_invoice_id: string;
    linked_offer_id: string;
  }>({
    type: "other",
    title: "",
    partner_id: "",
    change_note: "",
    linked_deal_id: "",
    linked_invoice_id: "",
    linked_offer_id: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form on (re)open.
  useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setForm({
        type: "other",
        title: "",
        partner_id: "",
        change_note: "",
        linked_deal_id: "",
        linked_invoice_id: "",
        linked_offer_id: "",
      });
      setFile(null);
    }
  }, [open]);

  // Lazy-loaded dropdown options. The deals / invoices / offers endpoints
  // cap at 500 rows; for tenants with more, the operator can use the
  // reference_id field on the legacy "New entry" dialog to link via free
  // text instead. (Keeping the dropdown bounded is the right trade-off —
  // an unbounded Select would be unusable.)
  const dealsQ = useQuery({
    queryKey: ["deals", tenantKey, "upload-dialog", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/deals?limit=200`));
      if (!r.ok) throw new Error("Failed to load deals");
      return r.json() as Promise<{ items: Array<{ id: string; title: string }> }>;
    },
    enabled: open,
  });
  const invoicesQ = useQuery({
    queryKey: ["invoices", tenantKey, "upload-dialog", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/invoices?limit=200`));
      if (!r.ok) throw new Error("Failed to load invoices");
      return r.json() as Promise<{ items: Array<{ id: string; number: string; subject?: string | null }> }>;
    },
    enabled: open,
  });
  const offersQ = useQuery({
    queryKey: ["offers", tenantKey, "upload-dialog", "200"],
    queryFn: async () => {
      const r = await fetch(api(`/api/offers?limit=200`));
      if (!r.ok) throw new Error("Failed to load offers");
      return r.json() as Promise<{ items: Array<{ id: string; number: string; subject?: string | null }> }>;
    },
    enabled: open,
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Auto-generate the document number the same way the legacy form does
  // (TYPE_PREFIX + year + next-seq + V1). We send it in the multipart body
  // so the server has a stable identifier even before the row is inserted.
  const number = useMemo(() => {
    const prefix = TYPE_PREFIX[form.type];
    const year = String(new Date().getFullYear());
    const seq = nextSeqForType(existing, form.type);
    return `${prefix}-${year}-${seq}-V1`;
  }, [form.type, existing]);

  async function save() {
    if (!file) { toast.error(t("doc-file-required")); return; }
    if (!form.title.trim()) { toast.error(t("fin-enter-title-toast")); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("number", number);
      fd.append("type", form.type);
      fd.append("title", form.title.trim());
      fd.append("version", "1");
      fd.append("change_note", form.change_note.trim());
      if (form.partner_id) fd.append("partner_id", form.partner_id);
      if (form.linked_deal_id) fd.append("linked_deal_id", form.linked_deal_id);
      if (form.linked_invoice_id) fd.append("linked_invoice_id", form.linked_invoice_id);
      if (form.linked_offer_id) fd.append("linked_offer_id", form.linked_offer_id);

      const r = await fetch(api("/api/document-register"), {
        method: "POST",
        body: fd, // multipart/form-data — Content-Type set automatically by the browser
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || t("doc-toast-upload-failed"));
      }
      toast.success(t("doc-toast-uploaded"));
      onUploaded();
    } catch (e: any) {
      toast.error(e.message || t("doc-toast-upload-failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <Upload className="size-5" />
            {t("doc-upload-dialog-title")}
          </DialogTitle>
          <DialogDescription>{t("doc-upload-dialog-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* File picker */}
          <div className="space-y-1.5">
            <Label>{t("doc-file")} *</Label>
            <label
              htmlFor="doc-upload-input"
              className="flex flex-col items-center justify-center gap-2 cursor-pointer rounded-lg border border-dashed border-border/70 bg-muted/30 px-4 py-6 text-sm hover:bg-muted/50 transition-colors"
            >
              {file ? (
                <>
                  <File className="size-6 text-muted-foreground" />
                  <span className="font-medium text-foreground">{file.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </span>
                </>
              ) : (
                <>
                  <Upload className="size-6 text-muted-foreground" />
                  <span className="text-muted-foreground">{t("doc-file-allowed")}</span>
                </>
              )}
              <input
                id="doc-upload-input"
                type="file"
                accept="application/pdf,image/*,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setFile(f);
                    // Auto-fill title if empty.
                    if (!form.title.trim()) {
                      const baseName = f.name.replace(/\.[^.]+$/, "");
                      set("title", baseName.slice(0, 120));
                    }
                  }
                }}
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("type")} *</Label>
              <Select value={form.type} onValueChange={(v) => set("type", v as DocumentType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="offer">{t("fin-doc-type-offer")}</SelectItem>
                  <SelectItem value="invoice">{t("fin-doc-type-invoice")}</SelectItem>
                  <SelectItem value="proforma">{t("fin-doc-type-proforma")}</SelectItem>
                  <SelectItem value="contract">{t("fin-doc-type-contract")}</SelectItem>
                  <SelectItem value="spec">{t("fin-doc-type-spec")}</SelectItem>
                  <SelectItem value="other">{t("fin-doc-type-other")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-2 space-y-1.5">
              <Label>{t("fin-title-required-label")} *</Label>
              <Input
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder={t("fin-title-placeholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("fin-partner")}</Label>
              <PartnerPicker
                value={form.partner_id}
                placeholder={t("fin-no-partner-option")}
                onSelect={(p) => set("partner_id", p?.id || "")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("fin-generated-number")}</Label>
              <Input value={number} readOnly className="font-mono text-xs bg-muted/40" />
            </div>

            {/* Optional linking to existing CRM / finance entities. */}
            <div className="md:col-span-2 space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <LinkIcon className="size-3.5" />
                {t("doc-linked-to")}
              </Label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Select value={form.linked_deal_id || "none"} onValueChange={(v) => set("linked_deal_id", v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder={t("doc-no-link")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("doc-no-link")}</SelectItem>
                    {(dealsQ.data?.items || []).slice(0, 200).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {t("doc-linked-deal")}: {d.title?.slice(0, 40) || d.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={form.linked_invoice_id || "none"} onValueChange={(v) => set("linked_invoice_id", v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder={t("doc-no-link")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("doc-no-link")}</SelectItem>
                    {(invoicesQ.data?.items || []).slice(0, 200).map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        {t("doc-linked-invoice")}: {i.number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={form.linked_offer_id || "none"} onValueChange={(v) => set("linked_offer_id", v === "none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder={t("doc-no-link")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("doc-no-link")}</SelectItem>
                    {(offersQ.data?.items || []).slice(0, 200).map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {t("doc-linked-offer")}: {o.number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="md:col-span-2 space-y-1.5">
              <Label>{t("fin-change-note")}</Label>
              <Textarea
                rows={2}
                value={form.change_note}
                onChange={(e) => set("change_note", e.target.value)}
                placeholder={t("fin-initial-note-placeholder")}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || !file}>
            {saving ? (
              <>
                <Loader2 className="size-4 mr-1 animate-spin" /> {t("doc-uploading")}
              </>
            ) : (
              <>
                <Upload className="size-4 mr-1" /> {t("doc-upload-button")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
