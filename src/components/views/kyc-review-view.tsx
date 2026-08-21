"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Search, ShieldCheck, ClipboardCheck, Clock, CheckCircle2, XCircle, FileText,
  Building2, Receipt, ReceiptText, Landmark, Lightbulb, UserCheck, FileBadge,
  Plane, IdCard, Building, Eye, Check, ArrowRight, FileCheck2, Loader2,
  AlertTriangle, UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtDate, fmtRelative, fmtBytes, fmtDateTime } from "@/lib/utils/format";
import {
  KycSubmission, KycDocumentType, Partner, PartnerEntityType,
} from "@/lib/supabase/types";
import { getCountry } from "@/lib/data/reference";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useDebounced } from "@/lib/hooks/use-debounced";
import { useT } from "@/lib/i18n/store";

// Local copy of the KycSubmission.status union — there is a pre-existing
// duplicate `KycStatus` export in supabase/types.ts (Partner.kyc_status uses a
// different union), so importing the symbol would resolve to the intersection
// of both. We declare our own to keep the literal union intact.
type KycSubmissionStatus =
  | "draft" | "submitted" | "under_review" | "approved" | "rejected" | "resubmit";

// ---------- static lookups ----------

const STATUS_LABEL_KEYS: Record<KycSubmissionStatus, string> = {
  draft: "admin-kyc-status-draft",
  submitted: "admin-kyc-status-submitted",
  under_review: "admin-kyc-status-under-review",
  approved: "admin-kyc-status-approved",
  rejected: "admin-kyc-status-rejected",
  resubmit: "admin-kyc-status-resubmit",
};

// Helper to coerce the runtime status string into our local union. The
// shared `KycStatus` symbol in supabase/types.ts is shadowed by a duplicate
// declaration used for Partner.kyc_status, so we cast defensively here.
function asStatus(s: string | null | undefined): KycSubmissionStatus {
  if (!s) return "draft";
  if (s in STATUS_LABEL_KEYS) return s as KycSubmissionStatus;
  return "draft";
}

const ENTITY_LABEL_KEYS: Record<PartnerEntityType, string> = {
  company: "admin-kyc-entity-company",
  individual: "admin-kyc-entity-individual",
};

const DOC_TYPE_LABEL_KEYS: Record<KycDocumentType, string> = {
  passport: "admin-kyc-doc-type-passport",
  id_card: "admin-kyc-doc-type-id-card",
  company_registration: "admin-kyc-doc-type-company-registration",
  tax_certificate: "admin-kyc-doc-type-tax-certificate",
  vat_certificate: "admin-kyc-doc-type-vat-certificate",
  bank_statement: "admin-kyc-doc-type-bank-statement",
  utility_bill: "admin-kyc-doc-type-utility-bill",
  beneficial_owner_declaration: "admin-kyc-doc-type-beneficial-owner",
  trade_license: "admin-kyc-doc-type-trade-license",
  chamber_of_commerce: "admin-kyc-doc-type-chamber",
  other: "admin-kyc-doc-type-other",
};

const DOC_ICON: Record<KycDocumentType, LucideIcon> = {
  passport: Plane,
  id_card: IdCard,
  company_registration: Building2,
  tax_certificate: Receipt,
  vat_certificate: ReceiptText,
  bank_statement: Landmark,
  utility_bill: Lightbulb,
  beneficial_owner_declaration: UserCheck,
  trade_license: FileBadge,
  chamber_of_commerce: Building,
  other: FileText,
};

function statusBadgeClass(status: KycSubmissionStatus): string {
  switch (status) {
    case "approved":
      return "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "rejected":
      return "border-transparent bg-destructive text-white";
    case "under_review":
      return "border-transparent bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";
    case "submitted":
      return "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "resubmit":
      return "border-transparent bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200";
    case "draft":
    default:
      return "border-transparent bg-muted text-muted-foreground";
  }
}


function entityBadgeClass(et: PartnerEntityType): string {
  return et === "company"
    ? "border-transparent bg-secondary text-secondary-foreground"
    : "border-transparent bg-muted text-foreground";
}

// ---------- main view ----------

export function KycReviewView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 300);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);

  // KYC list
  const { data, isLoading } = useQuery({
    queryKey: ["kyc", tenantKey, debouncedSearch, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const r = await fetch(api(`/api/kyc?${params}`));
      if (!r.ok) throw new Error("Failed to load KYC submissions");
      return r.json() as Promise<{ items: KycSubmission[]; total: number }>;
    },
  });

  // Partners lookup (for partner names + portal info)
  const partnersQ = useQuery({
    queryKey: ["partners", tenantKey, "lookup", "kyc"],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners?limit=500`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  // Users lookup (to resolve reviewer name)
  const usersQ = useQuery({
    queryKey: ["users", tenantKey, "lookup"],
    queryFn: async () => {
      const r = await fetch(api(`/api/users`));
      if (!r.ok) throw new Error("Failed to load users");
      return r.json() as Promise<{ items: any[] }>;
    },
  });

  const partnerMap = useMemo(() => {
    const m = new Map<string, Partner>();
    partnersQ.data?.items.forEach((p) => m.set(p.id, p));
    return m;
  }, [partnersQ.data]);

  const userMap = useMemo(() => {
    const m = new Map<string, string>();
    usersQ.data?.items.forEach((u: any) => {
      m.set(u.id, u.full_name || u.username || u.email || "—");
    });
    return m;
  }, [usersQ.data]);

  const items = data?.items || [];

  // KPI calculations
  const kpis = useMemo(() => {
    const all = items;
    return {
      pending: all.filter((k) => asStatus(k.status) === "submitted").length,
      underReview: all.filter((k) => asStatus(k.status) === "under_review").length,
      approved: all.filter((k) => asStatus(k.status) === "approved").length,
      rejected: all.filter((k) => asStatus(k.status) === "rejected").length,
    };
  }, [items]);

  function resolvePartnerName(k: KycSubmission): string {
    if (k.legal_name) return k.legal_name;
    const p = partnerMap.get(k.partner_id);
    return p?.name || t("admin-kyc-unknown-partner");
  }

  return (
    <div>
      <PageHeader
        title={t("admin-kyc-title")}
        description={t("admin-kyc-desc")}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <KpiCard
          label={t("admin-kyc-kpi-pending")}
          value={kpis.pending}
          sub={t("admin-kyc-kpi-pending-sub")}
          icon={Clock}
          iconClassName={kpis.pending > 0 ? "text-warning" : undefined}
        />
        <KpiCard
          label={t("admin-kyc-kpi-under-review")}
          value={kpis.underReview}
          sub={t("admin-kyc-kpi-under-review-sub")}
          icon={ClipboardCheck}
        />
        <KpiCard
          label={t("admin-kyc-kpi-approved")}
          value={kpis.approved}
          sub={t("admin-kyc-kpi-approved-sub")}
          icon={CheckCircle2}
          iconClassName="text-success"
        />
        <KpiCard
          label={t("admin-kyc-kpi-rejected")}
          value={kpis.rejected}
          sub={t("admin-kyc-kpi-rejected-sub")}
          icon={XCircle}
          iconClassName="text-destructive"
        />
      </div>

      {/* Filters */}
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("admin-kyc-search-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-52">
              <SelectValue placeholder={t("status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin-kyc-all-statuses")}</SelectItem>
              <SelectItem value="draft">{t("admin-kyc-status-draft")}</SelectItem>
              <SelectItem value="submitted">{t("admin-kyc-status-submitted")}</SelectItem>
              <SelectItem value="under_review">{t("admin-kyc-status-under-review")}</SelectItem>
              <SelectItem value="approved">{t("admin-kyc-status-approved")}</SelectItem>
              <SelectItem value="rejected">{t("admin-kyc-status-rejected")}</SelectItem>
              <SelectItem value="resubmit">{t("admin-kyc-status-resubmit")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* List table */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck className="size-6" />}
              title={t("admin-kyc-empty-title")}
              description={t("admin-kyc-empty-desc")}
            />
          ) : (
            <div className="max-h-[calc(100vh-380px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{t("admin-kyc-col-partner")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("admin-kyc-col-entity")}</TableHead>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("admin-kyc-col-submitted")}</TableHead>
                    <TableHead className="hidden sm:table-cell text-center">{t("admin-kyc-col-documents")}</TableHead>
                    <TableHead className="hidden xl:table-cell">{t("admin-kyc-col-reviewed-by")}</TableHead>
                    <TableHead className="text-right">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((k) => {
                    const isClosed = asStatus(k.status) === "approved" || asStatus(k.status) === "rejected";
                    return (
                      <TableRow
                        key={k.id}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setReviewId(k.id)}
                      >
                        <TableCell>
                          <div className="font-medium truncate max-w-[220px]">{resolvePartnerName(k)}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[220px]">
                            {k.contact_email || k.city || "—"}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge className={entityBadgeClass(k.entity_type)}>
                            {k.entity_type === "company" ? <Building2 className="size-3" /> : <UserRound className="size-3" />}
                            {t(ENTITY_LABEL_KEYS[k.entity_type])}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={statusBadgeClass(asStatus(k.status))}>
                            {t(STATUS_LABEL_KEYS[asStatus(k.status)])}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-sm text-muted-foreground tabular">
                          {fmtRelative(k.submitted_at || k.updated_at)}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-center">
                          <Badge variant="outline" className="tabular">
                            {k.documents?.length || 0}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell text-sm">
                          {k.reviewed_by ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Check className="size-3.5 text-muted-foreground" />
                              {userMap.get(k.reviewed_by) || t("admin-kyc-reviewer")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant={isClosed ? "outline" : "default"}
                            onClick={() => setReviewId(k.id)}
                            className="h-8"
                          >
                            <Eye className="size-3.5 mr-1" />
                            {t("admin-kyc-review-btn")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review dialog */}
      <ReviewDialog
        id={reviewId}
        open={!!reviewId}
        onOpenChange={(o) => !o && setReviewId(null)}
        partnerMap={partnerMap}
        userMap={userMap}
        onReject={(id) => setRejectId(id)}
        onApproved={() => {
          qc.invalidateQueries({ queryKey: ["kyc", tenantKey] });
          qc.invalidateQueries({ queryKey: ["partners", tenantKey] });
        }}
        onNotesChanged={() => qc.invalidateQueries({ queryKey: ["kyc", tenantKey] })}
      />

      {/* Reject dialog */}
      <RejectDialog
        id={rejectId}
        open={!!rejectId}
        onOpenChange={(o) => !o && setRejectId(null)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["kyc", tenantKey] });
        }}
      />
    </div>
  );
}

// ---------- status flow stepper ----------

const FLOW_STEPS: { key: KycSubmissionStatus; labelKey: string }[] = [
  { key: "draft", labelKey: "admin-kyc-status-draft" },
  { key: "submitted", labelKey: "admin-kyc-status-submitted" },
  { key: "under_review", labelKey: "admin-kyc-status-under-review" },
  { key: "approved", labelKey: "admin-kyc-status-approved" },
];

function StatusFlow({ status, rejectionReason }: { status: KycSubmissionStatus; rejectionReason?: string | null }) {
  const t = useT();
  // For rejected state, show first 3 steps + a rejected terminal
  const rejected = status === "rejected";
  const steps = rejected
    ? [
        { key: "draft" as KycSubmissionStatus, labelKey: "admin-kyc-status-draft" },
        { key: "submitted" as KycSubmissionStatus, labelKey: "admin-kyc-status-submitted" },
        { key: "under_review" as KycSubmissionStatus, labelKey: "admin-kyc-status-under-review" },
        { key: "rejected" as KycSubmissionStatus, labelKey: "admin-kyc-status-rejected" },
      ]
    : FLOW_STEPS;

  const currentIndex = steps.findIndex((s) => s.key === status);
  // For under_review, also light up submitted + draft as done
  // For approved, light up everything
  // For draft, light up draft only (current)
  // For submitted, light up draft + submitted
  const doneIndex = rejected ? currentIndex : currentIndex;

  return (
    <div className="flex items-center w-full overflow-x-auto custom-scroll pb-1">
      {steps.map((s, i) => {
        const isDone = i < doneIndex || s.key === "approved";
        const isCurrent = i === doneIndex;
        const isRejected = s.key === "rejected";
        const isApproved = s.key === "approved";
        const dotClass = isRejected
          ? "bg-destructive text-white border-destructive"
          : isApproved && (isDone || isCurrent)
            ? "bg-emerald-600 text-white border-emerald-600"
            : isCurrent && !isApproved
              ? "bg-primary text-primary-foreground border-primary"
              : isDone
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-muted text-muted-foreground border-border";

        return (
          <div key={s.key} className="flex items-center min-w-fit">
            <div className="flex flex-col items-center gap-1.5 px-1">
              <div className={`size-7 rounded-full border-2 flex items-center justify-center text-xs font-semibold tabular smooth ${dotClass}`}>
                {isDone && !isCurrent ? <Check className="size-3.5" /> : i + 1}
              </div>
              <span className={`text-xs uppercase tracking-wide font-medium whitespace-nowrap ${isCurrent ? "text-foreground" : "text-muted-foreground"}`}>
                {t(s.labelKey)}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`h-0.5 w-8 sm:w-16 mx-0.5 -mt-4 rounded-full ${
                  i < doneIndex ? "bg-primary/40" : "bg-border"
                }`}
              />
            )}
          </div>
        );
      })}
      {rejected && rejectionReason && (
        <div className="ml-3 -mt-4 max-w-xs text-xs text-destructive/90 bg-destructive/10 border border-destructive/20 rounded-md px-2.5 py-1.5">
          <span className="font-medium">{t("admin-kyc-reason-label")}</span> {rejectionReason}
        </div>
      )}
    </div>
  );
}

// ---------- definition list helper ----------

function DefRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-1 sm:gap-3 py-2 border-b border-border/50 last:border-0">
      <dt className="text-xs font-medium text-muted-foreground sm:col-span-1">{label}</dt>
      <dd className={`text-sm sm:col-span-2 break-words ${mono ? "font-mono tabular text-[13px]" : ""}`}>
        {value && value.trim() !== "" ? value : <span className="text-muted-foreground">—</span>}
      </dd>
    </div>
  );
}

// ---------- review dialog ----------

function ReviewDialog({
  id, open, onOpenChange, partnerMap, userMap, onReject, onApproved, onNotesChanged,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partnerMap: Map<string, Partner>;
  userMap: Map<string, string>;
  onReject: (id: string) => void;
  onApproved: () => void;
  onNotesChanged: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [tab, setTab] = useState("business");
  const [notes, setNotes] = useState("");
  const [approvedResult, setApprovedResult] = useState<{ partner: Partner; submission: KycSubmission } | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  // Track the entity we've initialised local state for, so we can re-sync when it changes
  // (React 19 pattern: store info from previous render to derive state without useEffect).
  const [lastInitId, setLastInitId] = useState<string | null>(null);

  // Load full submission
  const q = useQuery({
    queryKey: ["kyc", tenantKey, id],
    queryFn: async () => {
      const r = await fetch(api(`/api/kyc/${id}`));
      if (!r.ok) throw new Error("Failed to load submission");
      return r.json() as Promise<KycSubmission>;
    },
    enabled: !!id,
  });

  // Sync local form state when the loaded submission changes (id or refetch result).
  if (open && id && id !== lastInitId && q.data) {
    setLastInitId(id);
    setTab("business");
    setNotes(q.data.review_notes || "");
    setNotesDirty(false);
    if (asStatus(q.data.status) === "approved" && q.data.auto_transferred) {
      const partner = partnerMap.get(q.data.partner_id) || null;
      setApprovedResult(partner ? { partner, submission: q.data } : null);
    } else {
      setApprovedResult(null);
    }
  }

  // When the dialog closes, clear the "last initialised" tracker so the next open re-syncs.
  if (!open && lastInitId !== null) {
    setLastInitId(null);
    setApprovedResult(null);
  }

  // Save notes (auto-save on blur if dirty)
  const saveNotesMut = useMutation({
    mutationFn: async (newNotes: string) => {
      const r = await fetch(api(`/api/kyc/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_notes: newNotes }),
      });
      if (!r.ok) throw new Error("Failed to save notes");
      return r.json();
    },
    onSuccess: () => {
      setNotesDirty(false);
      onNotesChanged();
    },
    onError: () => toast.error(t("admin-kyc-toast-notes-failed")),
  });

  // Approve + transfer
  const approveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/api/kyc/${id}/approve`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Approve failed");
      }
      return r.json() as Promise<{ submission: KycSubmission; partner: Partner; transferred: boolean; portal_access: any }>;
    },
    onSuccess: (data) => {
      setApprovedResult({ partner: data.partner, submission: data.submission });
      toast.success(
        data.portal_access
          ? t("admin-kyc-toast-approved-portal")
          : t("admin-kyc-toast-approved")
      );
      onApproved();
    },
    onError: (e: any) => toast.error(e.message || t("admin-kyc-toast-approve-failed")),
  });

  // Request resubmission (admin asks client for more info)
  const resubmitMut = useMutation({
    mutationFn: async (note: string) => {
      const r = await fetch(api(`/api/kyc/${id}/resubmit`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Resubmit failed");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("admin-kyc-toast-resubmit"));
      onApproved();
    },
    onError: (e: any) => toast.error(e.message || t("admin-kyc-toast-resubmit-failed")),
  });

  const sub = q.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60 sticky top-0 bg-card z-20">
          <div className="flex items-start justify-between gap-4 pr-8">
            <div className="min-w-0">
              {q.isLoading ? (
                <>
                  <Skeleton className="h-6 w-64 mb-2" />
                  <Skeleton className="h-4 w-40" />
                </>
              ) : sub ? (
                <>
                  <DialogTitle className="flex items-center gap-2 text-xl">
                    <ShieldCheck className="size-5 text-primary" />
                    <span className="truncate">{sub.legal_name || partnerMap.get(sub.partner_id)?.name || t("admin-kyc-dialog-title")}</span>
                  </DialogTitle>
                  <DialogDescription className="flex flex-wrap items-center gap-2 mt-1.5">
                    <Badge className={entityBadgeClass(sub.entity_type)}>
                      {sub.entity_type === "company" ? <Building2 className="size-3" /> : <UserRound className="size-3" />}
                      {t(ENTITY_LABEL_KEYS[sub.entity_type])}
                    </Badge>
                    <Badge className={statusBadgeClass(asStatus(sub.status))}>{t(STATUS_LABEL_KEYS[asStatus(sub.status)])}</Badge>
                    {sub.auto_transferred && (
                      <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200 gap-1">
                        <FileCheck2 className="size-3" /> {t("admin-kyc-transferred-badge")}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground tabular">
                      {t("admin-kyc-submitted-prefix")} {fmtRelative(sub.submitted_at || sub.created_at)}
                    </span>
                  </DialogDescription>
                </>
              ) : (
                <DialogTitle>{t("admin-kyc-dialog-title")}</DialogTitle>
              )}
            </div>
          </div>

          {/* Status flow stepper */}
          {sub && (
            <div className="mt-4">
              <StatusFlow status={asStatus(sub.status)} rejectionReason={sub.rejection_reason} />
            </div>
          )}
        </DialogHeader>

        {/* Body */}
        {q.isLoading ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !sub ? (
          <div className="p-6">
            <EmptyState title={t("admin-kyc-not-found-title")} description={t("admin-kyc-not-found-desc")} />
          </div>
        ) : approvedResult ? (
          // Approval success state
          <ApprovedState
            partner={approvedResult.partner}
            submission={approvedResult.submission}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <div className="px-6 py-5">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="flex w-full overflow-x-auto justify-start mb-4 sm:grid sm:grid-cols-5">
                <TabsTrigger value="business">{t("admin-kyc-tab-business")}</TabsTrigger>
                <TabsTrigger value="owner">{t("admin-kyc-tab-owner")}</TabsTrigger>
                <TabsTrigger value="bank">{t("admin-kyc-tab-bank")}</TabsTrigger>
                <TabsTrigger value="documents">
                  {t("admin-kyc-col-documents")}
                  <Badge variant="secondary" className="ml-1.5 tabular h-4 px-1.5">
                    {sub.documents?.length || 0}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="notes">{t("admin-kyc-tab-notes")}</TabsTrigger>
              </TabsList>

              {/* Business Info */}
              <TabsContent value="business" className="mt-0">
                <Card className="border-border/60 shadow-soft">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building2 className="size-4 text-primary" />
                      {sub.entity_type === "company" ? t("admin-kyc-card-company") : t("admin-kyc-card-individual")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <dl className="divide-y divide-border/50">
                      <DefRow label={t("admin-kyc-field-entity-type")} value={t(ENTITY_LABEL_KEYS[sub.entity_type])} />
                      <DefRow label={t("admin-kyc-field-legal-name")} value={sub.legal_name} />
                      {sub.trade_name && <DefRow label={t("admin-kyc-field-trade-name")} value={sub.trade_name} />}
                      {sub.entity_type === "company" && (
                        <>
                          <DefRow label={t("admin-kyc-field-reg-number")} value={sub.registration_number} mono />
                          <DefRow label={t("admin-kyc-field-tax-id")} value={sub.tax_id} mono />
                          <DefRow label={t("admin-kyc-field-vat-number")} value={sub.vat_number} mono />
                          <DefRow label={t("admin-kyc-field-website")} value={sub.company_website} />
                        </>
                      )}
                      <DefRow
                        label={t("admin-kyc-field-address")}
                        value={[sub.address_line, sub.postal_code, sub.city, sub.state, getCountry(sub.country || "")?.name || sub.country]
                          .filter(Boolean)
                          .join(", ") || null}
                      />
                      <DefRow label={t("admin-kyc-field-contact-person")} value={sub.contact_name} />
                      <DefRow label={t("admin-kyc-field-contact-email")} value={sub.contact_email} mono />
                      <DefRow label={t("admin-kyc-field-contact-phone")} value={sub.contact_phone} mono />
                      {sub.contact_position && <DefRow label={t("admin-kyc-field-position")} value={sub.contact_position} />}
                      <DefRow label={t("admin-kyc-field-business-activity")} value={sub.business_activity} />
                      <DefRow label={t("admin-kyc-field-monthly-volume")} value={sub.expected_monthly_volume} />
                      <DefRow label={t("admin-kyc-field-source-of-funds")} value={sub.source_of_funds} />
                    </dl>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Beneficial Owner */}
              <TabsContent value="owner" className="mt-0">
                <Card className="border-border/60 shadow-soft">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <UserCheck className="size-4 text-primary" />
                      {t("admin-kyc-card-owner")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {!sub.owner_name && !sub.owner_id_number && !sub.owner_nationality ? (
                      <p className="text-sm text-muted-foreground py-6 text-center">
                        {t("admin-kyc-no-owner")}
                      </p>
                    ) : (
                      <dl className="divide-y divide-border/50">
                        <DefRow label={t("admin-kyc-field-owner-name")} value={sub.owner_name} />
                        <DefRow label={t("admin-kyc-field-id-type")} value={sub.owner_id_type} />
                        <DefRow label={t("admin-kyc-field-id-number")} value={sub.owner_id_number} mono />
                        <DefRow label={t("admin-kyc-field-nationality")} value={getCountry(sub.owner_nationality || "")?.name || sub.owner_nationality} />
                        <DefRow label={t("admin-kyc-field-dob")} value={sub.owner_dob ? fmtDate(sub.owner_dob) : null} />
                        <DefRow label={t("admin-kyc-field-address")} value={sub.owner_address} />
                      </dl>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Bank */}
              <TabsContent value="bank" className="mt-0">
                <Card className="border-border/60 shadow-soft">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Landmark className="size-4 text-primary" />
                      {t("admin-kyc-card-bank")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {!sub.bank_name && !sub.bank_account && !sub.bank_iban && !sub.bank_swift ? (
                      <p className="text-sm text-muted-foreground py-6 text-center">
                        {t("admin-kyc-no-bank")}
                      </p>
                    ) : (
                      <dl className="divide-y divide-border/50">
                        <DefRow label={t("admin-kyc-field-bank-name")} value={sub.bank_name} />
                        <DefRow label={t("admin-kyc-field-account-number")} value={sub.bank_account} mono />
                        <DefRow label={t("admin-kyc-field-iban")} value={sub.bank_iban} mono />
                        <DefRow label={t("admin-kyc-field-swift")} value={sub.bank_swift} mono />
                      </dl>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Documents */}
              <TabsContent value="documents" className="mt-0">
                <Card className="border-border/60 shadow-soft">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <FileText className="size-4 text-primary" />
                      {t("admin-kyc-card-docs")}
                      <Badge variant="secondary" className="tabular ml-1">{sub.documents?.length || 0}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {(!sub.documents || sub.documents.length === 0) ? (
                      <p className="text-sm text-muted-foreground py-6 text-center">
                        {t("admin-kyc-no-docs")}
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {sub.documents.map((doc) => {
                          const Icon = DOC_ICON[doc.type] || FileText;
                          return (
                            <div
                              key={doc.id}
                              className="group relative flex items-start gap-3 p-3 rounded-lg border border-border/60 bg-card hover:bg-muted/40 hover:border-border smooth"
                            >
                              <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                                <Icon className="size-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <Badge variant="outline" className="mb-1 text-xs">
                                  {t(DOC_TYPE_LABEL_KEYS[doc.type])}
                                </Badge>
                                <p className="text-sm font-medium truncate" title={doc.filename}>
                                  {doc.filename}
                                </p>
                                <p className="text-xs text-muted-foreground tabular">
                                  {fmtBytes(doc.size)} · {fmtRelative(doc.uploaded_at)}
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 shrink-0"
                                onClick={() => { if (doc.file_path || doc.url) { window.open(doc.url || `/api/portal-uploads/${(doc as any).portal_upload_id || doc.id}/download`, "_blank"); } else { toast.info(t("admin-kyc-no-file")); } }}
                              >
                                <Eye className="size-3.5 mr-1" />
                                {t("view")}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Review notes */}
              <TabsContent value="notes" className="mt-0">
                <Card className="border-border/60 shadow-soft">
                  <CardHeader className="pb-2 pt-4">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <ClipboardCheck className="size-4 text-primary" />
                      {t("admin-kyc-card-notes")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    <Textarea
                      placeholder={t("admin-kyc-notes-placeholder")}
                      rows={6}
                      value={notes}
                      onChange={(e) => {
                        setNotes(e.target.value);
                        setNotesDirty(true);
                      }}
                      onBlur={() => notesDirty && saveNotesMut.mutate(notes)}
                    />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        {saveNotesMut.isPending
                          ? t("admin-saving")
                          : notesDirty
                            ? t("admin-kyc-unsaved")
                            : notes
                              ? t("admin-kyc-saved")
                              : t("admin-kyc-no-notes")}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={!notesDirty || saveNotesMut.isPending}
                        onClick={() => saveNotesMut.mutate(notes)}
                      >
                        {t("admin-kyc-save-now")}
                      </Button>
                    </div>

                    {sub.reviewed_by && (
                      <div className="pt-3 mt-3 border-t border-border/50 text-xs text-muted-foreground space-y-1">
                        <p>
                          <span className="font-medium text-foreground">{t("admin-kyc-reviewed-by-label")}</span>{" "}
                          {userMap.get(sub.reviewed_by) || t("admin-kyc-reviewer")}
                        </p>
                        {sub.reviewed_at && (
                          <p>
                            <span className="font-medium text-foreground">{t("admin-kyc-reviewed-at")}:</span>{" "}
                            <span className="tabular">{fmtDateTime(sub.reviewed_at)}</span>
                          </p>
                        )}
                        {sub.rejection_reason && (
                          <p className="text-destructive">
                            <span className="font-medium">{t("admin-kyc-rejection-reason")}</span> {sub.rejection_reason}
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}

        {/* Action bar */}
        {sub && !approvedResult && asStatus(sub.status) !== "rejected" && (
          <DialogFooter className="px-6 py-4 border-t border-border/60 bg-muted/30 sticky bottom-0">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between w-full gap-3">
              <p className="text-xs text-muted-foreground">
                {asStatus(sub.status) === "approved"
                  ? t("admin-kyc-action-approved-desc")
                  : t("admin-kyc-action-pending-desc")}
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  className="border-amber-500/40 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/40"
                  onClick={() => {
                    const note = prompt(
                      t("admin-kyc-resubmit-prompt")
                    );
                    if (note !== null) resubmitMut.mutate(note);
                  }}
                  disabled={approveMut.isPending || resubmitMut.isPending}
                >
                  <AlertTriangle className="size-4 mr-1" />
                  {t("admin-kyc-request-update")}
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onReject(sub.id)}
                  disabled={approveMut.isPending}
                >
                  <XCircle className="size-4 mr-1" />
                  {t("reject")}
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={() => approveMut.mutate()}
                  disabled={approveMut.isPending || asStatus(sub.status) === "approved"}
                >
                  {approveMut.isPending ? (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4 mr-1" />
                  )}
                  {asStatus(sub.status) === "approved" ? t("admin-kyc-already-approved") : t("admin-kyc-approve-transfer")}
                </Button>
              </div>
            </div>
          </DialogFooter>
        )}

        {sub && asStatus(sub.status) === "rejected" && (
          <DialogFooter className="px-6 py-4 border-t border-border/60 bg-muted/30 sticky bottom-0">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="size-4" />
                <span>{t("admin-kyc-rejected-banner")}</span>
              </div>
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t("close")}</Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- approved / transferred state ----------

const TRANSFERRED_FIELDS: { key: keyof Partner; labelKey: string }[] = [
  { key: "name", labelKey: "admin-kyc-field-legal-name" },
  { key: "entity_type", labelKey: "admin-kyc-field-entity-type" },
  { key: "tax_id", labelKey: "admin-kyc-field-tax-id" },
  { key: "vat_number", labelKey: "admin-kyc-field-vat-number" },
  { key: "registration_number", labelKey: "admin-kyc-field-reg-number" },
  { key: "address_line", labelKey: "admin-kyc-field-address" },
  { key: "city", labelKey: "admin-kyc-field-city" },
  { key: "state", labelKey: "admin-kyc-field-state" },
  { key: "postal_code", labelKey: "admin-kyc-field-postal-code" },
  { key: "country", labelKey: "admin-kyc-field-country" },
  { key: "contact_name", labelKey: "admin-kyc-field-contact-name" },
  { key: "contact_email", labelKey: "admin-kyc-field-contact-email" },
  { key: "contact_phone", labelKey: "admin-kyc-field-contact-phone" },
  { key: "bank_name", labelKey: "admin-kyc-field-bank-name" },
  { key: "bank_account", labelKey: "admin-kyc-field-bank-account" },
  { key: "bank_iban", labelKey: "admin-kyc-field-iban" },
  { key: "bank_swift", labelKey: "admin-kyc-field-swift-short" },
];

function ApprovedState({
  partner, submission, onClose,
}: {
  partner: Partner | null;
  submission: KycSubmission;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="px-6 py-8">
      <div className="flex flex-col items-center text-center mb-6">
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-emerald-500/20 blur-2xl rounded-full animate-pulse" />
          <div className="relative size-16 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-soft-lg">
            <Check className="size-9" strokeWidth={3} />
          </div>
        </div>
        <h2 className="text-xl font-semibold text-foreground">{t("admin-kyc-approved-state-title")}</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          {t("admin-kyc-approved-state-desc")}
        </p>
        <Badge className="mt-3 border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200 gap-1">
          <FileCheck2 className="size-3" />
          {t("admin-kyc-data-transferred")}
        </Badge>
      </div>

      {partner && (
        <Card className="border-border/60 shadow-soft mb-4">
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 className="size-4 text-primary" />
              {t("admin-kyc-card-partner-updated")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0">
              {TRANSFERRED_FIELDS.map((f) => {
                const val = partner[f.key];
                const display = val === null || val === undefined || val === "" ? null : String(val);
                return (
                  <div
                    key={String(f.key)}
                    className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0"
                  >
                    <span className="text-xs text-muted-foreground">{t(f.labelKey)}</span>
                    <span className="text-xs font-medium tabular truncate max-w-[60%] text-right">
                      {display || <span className="text-muted-foreground">—</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/60">
        <div className="text-xs text-muted-foreground">
          {t("admin-kyc-approved-prefix")} {fmtDateTime(submission.reviewed_at || new Date().toISOString())}
        </div>
        <Button onClick={onClose} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Check className="size-4 mr-1" />
          {t("admin-kyc-done")}
        </Button>
      </div>
    </div>
  );
}

// ---------- reject dialog ----------

function RejectDialog({
  id, open, onOpenChange, onDone,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [reason, setReason] = useState("");
  // Reset the reason field whenever a different submission is opened for rejection.
  const [lastRejectId, setLastRejectId] = useState<string | null>(null);
  if (open && id !== lastRejectId) {
    setLastRejectId(id);
    setReason("");
  }
  if (!open && lastRejectId !== null) {
    setLastRejectId(null);
  }

  const mut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/api/kyc/${id}/reject`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Reject failed");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("admin-kyc-toast-rejected"));
      onDone();
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e.message || t("admin-kyc-toast-reject-failed")),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <XCircle className="size-5 text-destructive" />
            {t("admin-kyc-reject-dialog-title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin-kyc-reject-dialog-desc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="py-2">
          <Label htmlFor="reject-reason" className="text-xs">{t("admin-kyc-reject-reason-label")}</Label>
          <Textarea
            id="reject-reason"
            placeholder={t("admin-kyc-reject-reason-placeholder")}
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1.5"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mut.isPending}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!reason.trim() || mut.isPending}
            onClick={(e) => {
              e.preventDefault();
              mut.mutate();
            }}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {mut.isPending ? t("admin-kyc-rejecting") : t("admin-kyc-reject-submit")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
