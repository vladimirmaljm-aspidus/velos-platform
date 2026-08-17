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
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { fmtDate, fmtDateTime } from "@/lib/utils/format";
import {
  DocumentRegisterEntry, DocumentRevision, DocumentType, Partner,
} from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";
import { PartnerPicker } from "@/components/common/partner-picker";

type DocStatus = "current" | "superseded" | "archived";

const TYPE_LABEL_KEY: Record<DocumentType, string> = {
  offer: "fin-doc-type-offer",
  invoice: "fin-doc-type-invoice",
  proforma: "fin-doc-type-proforma",
  contract: "fin-doc-type-contract",
  spec: "fin-doc-type-spec",
  other: "fin-doc-type-other",
};

const TYPE_PREFIX: Record<DocumentType, string> = {
  offer: "OF", invoice: "INV", proforma: "PR", contract: "CT", spec: "SP", other: "OT",
};

const TYPE_ICON: Record<DocumentType, typeof FileText> = {
  offer: FileText, invoice: Receipt, proforma: FileCheck, contract: ScrollText, spec: ClipboardList, other: File,
};

function TypeBadge({ type }: { type: DocumentType }) {
  const t = useT();
  const cls: Record<DocumentType, string> = {
    offer: "border-transparent bg-[var(--chart-1)] text-white",
    invoice: "border-transparent bg-[var(--chart-4)] text-white",
    proforma: "border-transparent bg-[var(--chart-2)] text-white",
    contract: "border-transparent bg-emerald-600 text-white",
    spec: "border-transparent bg-[var(--chart-3)] text-black",
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

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [formParent, setFormParent] = useState<DocumentRegisterEntry | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
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
          <Button onClick={openNew}>
            <Plus className="size-4 mr-1" /> {t("doc-new-entry")}
          </Button>
        }
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
          {isLoading ? (
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
                      <TableCell className="hidden xl:table-cell">{fmtDate(e.created_at)}</TableCell>
                      <TableCell className="text-right" onClick={(ev) => ev.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(e.id)} title={t("view")} aria-label={t("view")}>
                            <Eye className="size-4" />
                          </Button>
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
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{parent ? `${t("fin-new-version-of")} ${parent.number}` : t("fin-new-document-entry")}</DialogTitle>
          <DialogDescription>
            {parent
              ? t("fin-auto-increments-desc")
              : t("fin-register-new-doc-desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto pr-1">

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 py-2">
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("fin-saving") : parent ? t("fin-create-version-btn") : t("fin-create-entry-btn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
