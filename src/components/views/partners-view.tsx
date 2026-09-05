"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useNewShortcut } from "@/lib/hooks/use-new-shortcut";
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
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationPrevious, PaginationNext, PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  Plus, Search, Users, Pencil, Trash2, Eye, Mail, Phone, Globe, MapPin,
  Building2, ShieldCheck, Star, Maximize2, DollarSign,
  ChevronDown, ChevronRight,
  ExternalLink, Send, Zap, CheckCircle2, Clock, AlertCircle, XCircle, KeyRound,
  Loader2, Copy, Check, Link as LinkIcon, Download, MessageSquare, Upload, FileDown,
  ShoppingCart, Package, RefreshCw, Briefcase, Paperclip,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { TableScroll } from "@/components/common/table-scroll";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { fmtMoney, fmtDate, fmtRelative, fmtNumber } from "@/lib/utils/format";
import { Partner, PartnerType, PartnerEntityType, PortalAccess, PortalTier } from "@/lib/supabase/types";
import { getTierMeta, ORDERED_TIERS } from "@/lib/portal/tiers";
import { useAppStore } from "@/lib/store/app-store";
import { CURRENCIES, ENTITY_TYPES, PAYMENT_TERMS_LOCAL } from "@/lib/data/reference";
import { getCountriesForSelect, getCitiesForSelect, getCountry } from "@/lib/data/geo/countries";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { usePageSize } from "@/lib/hooks/use-page-size";
import { PageSizeSelector } from "@/components/common/page-size-selector";
import { useT } from "@/lib/i18n/store";
import { Checkbox } from "@/components/ui/checkbox";
import { BulkActionBar, useRowSelection } from "@/components/common/bulk-action-bar";

// 2b2-F1 — admin viewer URL rewriter. The admin partners-view renders
// messages sent by portal clients whose `attachment_url` is now stored
// in the new singular portal form `/api/portal/attachments/<id>` (auth
// via `getPortalSessionAccess`). Admins are authenticated via
// `requireAuth`, NOT the portal session, so they must use the
// admin-scoped download route `/api/portal-uploads/<id>/download`
// (gated by `requireAuth` + `requirePermission("portal-uploads.download")`).
// This rewrite handles THREE URL forms:
//   1. New singular portal form (post-2b2-F1 fix):
//      /api/portal/attachments/<id>?mode=inline
//        → /api/portal-uploads/<id>/download?mode=inline
//   2. Legacy broken singular form (pre-2b2-F1, kept for historical rows):
//      /api/portal/upload/<id>/download?mode=inline
//        → /api/portal-uploads/<id>/download?mode=inline
//   3. Legacy plural admin form (already correct, returned unchanged):
//      /api/portal-uploads/<id>/download?mode=inline
// Anything else is returned as-is (the message route's
// `sanitizeAttachmentUrl` already strips arbitrary URLs to null, so
// the only URLs that reach this code are portal-attachment paths).
function toAdminAttachmentHref(url: string): string {
  if (!url) return url;
  let out = url.replace(
    /^\/api\/portal\/attachments\/([^/?#]+)(\?[^#]*)?/,
    (_m, id, q) => `/api/portal-uploads/${id}/download${q || ""}`,
  );
  out = out.replace(
    /^\/api\/portal\/upload\/([^/?#]+)\/download/,
    "/api/portal-uploads/$1/download",
  );
  return out;
}

const TYPE_LABEL_KEYS: Record<PartnerType, string> = {
  buyer: "crm-type-buyer",
  supplier: "crm-type-supplier",
  both: "crm-type-both",
  agent: "crm-type-agent",
  logistics: "crm-type-logistics",
  customs: "crm-type-customs",
  bank: "crm-type-bank",
  inspector: "crm-type-inspector",
};

const STATUS_LABEL_KEYS = {
  active: "active", inactive: "inactive", blacklisted: "crm-blacklisted",
} as const;

const STATUS_BADGE = {
  active: "default", inactive: "secondary", blacklisted: "destructive",
} as const;

const KYC_LABEL_KEYS = {
  not_submitted: "kyc-not-submitted", pending: "pending", approved: "crm-approved", rejected: "crm-rejected",
} as const;

const PORTAL_STATUS_LABEL_KEYS: Record<string, string> = {
  pending_approval: "crm-portal-status-pending-approval",
  approved: "crm-portal-status-approved",
  invited: "crm-portal-status-invited",
  active: "crm-portal-status-active",
  suspended: "crm-portal-status-suspended",
  revoked: "crm-portal-status-revoked",
};

const PORTAL_STATUS_ICON: Record<string, typeof Clock> = {
  pending_approval: Clock,
  approved: CheckCircle2,
  invited: Send,
  active: CheckCircle2,
  suspended: AlertCircle,
  revoked: XCircle,
};

const PORTAL_STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending_approval: "outline",
  approved: "secondary",
  invited: "default",
  active: "default",
  suspended: "destructive",
  revoked: "destructive",
};

// Portal tier label translation keys for the labels.
const TIER_LABEL_KEYS: Record<PortalTier, string> = {
  premium: "crm-portal-tier-premium",
  business: "crm-portal-tier-business",
  standard: "crm-portal-tier-standard",
  basic: "crm-portal-tier-basic",
  limited: "crm-portal-tier-basic-legacy",
};

const TIER_INFO: Record<PortalTier, { label: string; description: string; features: string[] }> = {
  premium: {
    label: "Premium",
    description:
      "VIP client. Light KYC review only — document verification and geolocation are optional. Full feature access.",
    features: [
      "Full feature access",
      "Light KYC review (no document upload required)",
      "Geolocation not required",
      "PDF downloads",
      "RFQ submission",
      "Company info access",
    ],
  },
  business: {
    label: "Business",
    description:
      "Trusted regular client. Full KYC, document upload, and geolocation required. Full feature access.",
    features: [
      "Full feature access",
      "Full KYC verification required",
      "Document upload required",
      "Geolocation required",
      "PDF downloads",
      "RFQ submission",
    ],
  },
  standard: {
    label: "Standard",
    description:
      "Standard client. Full KYC, documents, and geolocation required. Can submit RFQs but cannot download PDFs.",
    features: [
      "View offers / documents / catalog",
      "Submit RFQs",
      "Full KYC + documents + geolocation required",
      "No PDF download",
    ],
  },
  basic: {
    label: "Basic",
    description:
      "Entry-level / trial client. Full KYC, documents, and geolocation required. Read-only access.",
    features: [
      "View catalog and own offers",
      "No RFQ submission",
      "No PDF download",
      "Full KYC + documents + geolocation required",
    ],
  },
  limited: {
    label: "Basic (legacy)",
    description: "Legacy limited tier — equivalent to Basic.",
    features: ["Same as Basic tier"],
  },
};

function riskColor(score: number): string {
  if (score < 30) return "text-emerald-600";
  if (score < 60) return "text-amber-600";
  return "text-destructive";
}

// Helper to generate a partner code from company name
function generatePartnerCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.slice(0, 3))
    .join("")
    .slice(0, 8);
}

export function PartnersView() {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const setView = useAppStore((s) => s.setView);
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const { pageSize: PAGE_SIZE, setPageSize, options: pageSizeOptions } = usePageSize("partners", 20);
// eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(1); }, [PAGE_SIZE]);
  const [editing, setEditing] = useState<Partner | null>(null);
  const [showForm, setShowForm] = useState(false);
  useNewShortcut(() => { setEditing(null); setShowForm(true); });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Wrapper setters that reset page when filters change
  const handleSearchChange = useCallback((v: string) => { setSearch(v); setPage(1); }, []);
  const handleStatusFilterChange = useCallback((v: string) => { setStatusFilter(v); setPage(1); }, []);
  const handleTypeFilterChange = useCallback((v: string) => { setTypeFilter(v); setPage(1); }, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["partners", tenantKey, search, statusFilter, typeFilter, page, PAGE_SIZE],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("type", typeFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      const r = await fetch(api(`/api/partners?${params}`));
      if (!r.ok) throw new Error("Failed to load partners");
      return r.json() as Promise<{ items: Partner[]; total: number }>;
    },
  });

  const detail = useQuery({
    queryKey: ["partner", tenantKey, detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/partners/${detailId}`));
      if (!r.ok) throw new Error("Failed to load partner");
      return r.json() as Promise<Partner>;
    },
    enabled: !!detailId,
  });

  const partnerDeals = useQuery({
    queryKey: ["deals", tenantKey, "partner", detailId],
    queryFn: async () => {
      const r = await fetch(api(`/api/deals?partner_id=${detailId}`));
      if (!r.ok) throw new Error("Failed to load deals");
      return r.json() as Promise<{ items: any[] }>;
    },
    enabled: !!detailId,
  });

  // FIX-UX #3: related-entity counts for the delete-confirm dialog. When a
  // user clicks "delete" on a partner, we fire one cheap request per entity
  // (deals / offers / invoices) using `?partner_id=X&limit=1` so the dialog
  // can show concrete counts + gate type-to-confirm behind non-zero totals.
  const relatedCounts = useQuery({
    queryKey: ["partner-related-counts", tenantKey, deleteId],
    queryFn: async () => {
      if (!deleteId) return null;
      const [dealsR, offersR, invoicesR] = await Promise.all([
        fetch(api(`/api/deals?partner_id=${deleteId}&limit=1`)),
        fetch(api(`/api/offers?partner_id=${deleteId}&limit=1`)),
        fetch(api(`/api/invoices?partner_id=${deleteId}&limit=1`)),
      ]);
      const safeTotal = async (r: Response) => {
        try {
          const j = await r.json();
          return Number(j?.total ?? j?.items?.length ?? 0) || 0;
        } catch { return 0; }
      };
      const [deals, offers, invoices] = await Promise.all([
        safeTotal(dealsR), safeTotal(offersR), safeTotal(invoicesR),
      ]);
      return { deals, offers, invoices };
    },
    enabled: !!deleteId,
  });
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  // When the delete dialog closes, clear the type-to-confirm input. We
  // wire this into the AlertDialog's onOpenChange below (not via useEffect)
  // to avoid the react-hooks/set-state-in-effect lint warning.
  const closeDeleteDialog = (o: boolean) => {
    if (!o) {
      setDeleteId(null);
      setDeleteConfirmText("");
    }
  };

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(api(`/api/partners/${id}`), { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success(t("crm-partner-deleted"));
      qc.invalidateQueries({ queryKey: ["partners", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      setDeleteId(null);
    },
    onError: () => toast.error(t("crm-delete-failed")),
  });

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rowSel = useRowSelection(items);

  // Derive delete-confirm helpers AFTER `items` is declared (the dialog
  // needs the partner name from the local cache).
  const deletePartnerName = items.find((p) => p.id === deleteId)?.name || "";
  const relatedTotal =
    (relatedCounts.data?.deals || 0) +
    (relatedCounts.data?.offers || 0) +
    (relatedCounts.data?.invoices || 0);
  const canDeletePartner = relatedTotal === 0 || deleteConfirmText === deletePartnerName;

  // Bulk delete — loop through DELETE /api/partners/[id] for each selected
  // partner. (No server-side bulk endpoint for partners exists yet — they
  // don't have status transitions, so a client-side loop is acceptable.)
  const bulkDeleteMut = useMutation({
    mutationFn: async (ids: string[]) => {
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          const r = await fetch(api(`/api/partners/${id}`), { method: "DELETE" });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
      return { ok, fail };
    },
    onSuccess: ({ ok, fail }) => {
      if (fail === 0) toast.success(t("crm-partner-bulk-delete-success").replace("${n}", String(ok)));
      else toast.warning(t("crm-partner-bulk-delete-partial").replace("${ok}", String(ok)).replace("${fail}", String(fail)));
      qc.invalidateQueries({ queryKey: ["partners", tenantKey] });
      qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
      rowSel.clear();
    },
    onError: () => toast.error(t("crm-partner-bulk-delete-failed")),
  });

  const bulkExportSelected = () => {
    if (rowSel.ids.length === 0) return;
    const url = `/api/export?type=partners&format=csv&ids=${encodeURIComponent(rowSel.ids.join(","))}`;
    window.open(url, "_blank");
  };

  // CSV import — POST FormData to /api/import?type=partners. The server
  // parses the CSV, coerces types, and upserts each row via the store.
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(api("/api/import?type=partners"), { method: "POST", body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error || t("crm-import-failed"));
      }
      return (await r.json()) as { successCount: number; failureCount: number; totalRows: number };
    },
    onSuccess: (data) => {
      if (data.failureCount === 0) {
        toast.success(t("crm-import-success").replace("${n}", String(data.successCount)).replace("${fail}", "0"));
      } else {
        toast.warning(
          t("crm-import-success")
            .replace("${n}", String(data.successCount))
            .replace("${fail}", String(data.failureCount)),
        );
      }
      qc.invalidateQueries({ queryKey: ["partners", tenantKey] });
    },
    onError: (e: any) => toast.error(e?.message || t("crm-import-failed")),
  });

  return (
    <div>
      <PageHeader
        title={t("partners")}
        description={t("crm-total-count").replace("${n}", String(total))}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open("/api/partners/export?format=csv", "_blank")}
              title={t("crm-export-csv")}
            >
              <Download className="size-4" /> {t("crm-export-csv")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => importFileRef.current?.click()}
              disabled={importMut.isPending}
              title={t("crm-partner-import-csv-tooltip")}
            >
              <Upload className="size-4" /> {t("crm-partner-import-csv")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // CSV template — same column set as /api/export?type=partners.
                const headers = [
                  "name", "type", "entity_type", "email", "phone", "country", "city",
                  "state", "postal_code", "address_line", "tax_id", "vat_number",
                  "contact_name", "contact_email", "contact_phone", "status", "risk_score",
                  "preferred_currency", "preferred_incoterm", "preferred_payment_terms",
                  "industry", "website", "bank_name", "bank_account", "bank_swift", "bank_iban",
                ];
                const sample = [
                  '"Demo Buyer Ltd"', "buyer", "legal_entity", "buyer@example.com", "+1 555 0100",
                  "US", "New York", "NY", "10001", '"123 Main St"', "US123456789", "",
                  '"Jane Doe"', "jane@example.com", "+1 555 0101", "active", "10",
                  "USD", "FOB", "net30", "trading", "https://example.com",
                  '"Bank of America"', "000123456789", "BOFAUS3N", "",
                ];
                const csv = `${headers.join(",")}\n${sample.join(",")}\n`;
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "partners-template.csv";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              title={t("crm-import-template-tooltip")}
              className="text-muted-foreground"
            >
              {t("crm-partner-import-template")}
            </Button>
            <Button onClick={() => { setEditing(null); setShowForm(true); }}>
              <Plus className="size-4 mr-1" /> {t("crm-new-partner")}
            </Button>
          </div>
        }
      />
      <ModuleInfoTooltip
        title="Partners"
        description="Manage your business partners — buyers, suppliers, agents, and logistics providers. Track deals, invoices, and communication history for each partner."
        howToUse={["Click 'Add Partner' to create a new partner", "Use the search bar to find partners by name, tax ID, or email", "Click a partner row to view their 360° profile (deals, invoices, documents)", "Use bulk actions to export or delete multiple partners"]}
      />

      {/* Hidden file input for CSV import — same pattern as products-view. */}
      <input
        ref={importFileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importMut.mutate(file);
          e.target.value = "";
        }}
      />

      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={t("crm-search-by-name-email-phone")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("status")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crm-all-statuses")}</SelectItem>
              <SelectItem value="active">{t("active")}</SelectItem>
              <SelectItem value="inactive">{t("inactive")}</SelectItem>
              <SelectItem value="blacklisted">{t("crm-blacklisted")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={handleTypeFilterChange}>
            <SelectTrigger className="w-full md:w-44"><SelectValue placeholder={t("type")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("crm-all-types")}</SelectItem>
              <SelectItem value="buyer">{t("crm-type-buyer")}</SelectItem>
              <SelectItem value="supplier">{t("crm-type-supplier")}</SelectItem>
              <SelectItem value="both">{t("crm-type-both")}</SelectItem>
              <SelectItem value="agent">{t("crm-type-agent")}</SelectItem>
              <SelectItem value="logistics">{t("crm-type-logistics")}</SelectItem>
              <SelectItem value="customs">{t("crm-type-customs")}</SelectItem>
              <SelectItem value="bank">{t("crm-type-bank")}</SelectItem>
              <SelectItem value="inspector">{t("crm-type-inspector")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
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
              icon={<Users className="size-6" />}
              title={t("crm-no-partners")}
              description={t("crm-no-partners-desc")}
              action={<Button onClick={() => { setEditing(null); setShowForm(true); }}><Plus className="size-4 mr-1" /> {t("crm-new-partner")}</Button>}
            />
          ) : (
            <>
              <div className="max-h-[calc(100vh-340px)] overflow-y-auto custom-scroll">
                {/* D3 mobile fix — shared TableScroll wrapper (aria region + right-edge scroll hint). */}
                <TableScroll label={t("partners")}>
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          checked={rowSel.allOnPageSelected}
                          onCheckedChange={rowSel.toggleAllOnPage}
                          aria-label={t("crm-select-all-on-page")}
                        />
                      </TableHead>
                      <TableHead>{t("name")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("type")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("crm-contact-person")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead className="w-32">{t("crm-risk")}</TableHead>
                      <TableHead className="hidden xl:table-cell">{t("crm-kyc-short")}</TableHead>
                      <TableHead className="hidden xl:table-cell">{t("crm-portal-access-section")}</TableHead>
                      <TableHead className="text-right">{t("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((p) => (
                      <TableRow
                        key={p.id}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setDetailId(p.id)}
                        data-state={rowSel.isSelected(p.id) ? "selected" : undefined}
                      >
                        <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={rowSel.isSelected(p.id)}
                            onCheckedChange={() => rowSel.toggle(p.id)}
                            aria-label={`${t("crm-select")} ${p.name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium flex items-center gap-1.5">
                            {p.name}
                            {p.is_commissioner && (
                              <DollarSign className="size-3.5 text-primary" />
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {[p.city, p.country].filter(Boolean).join(", ") || "—"}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge variant="outline">{t(TYPE_LABEL_KEYS[p.type])}</Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="text-sm truncate max-w-[180px]" title={p.contact_name || undefined}>{p.contact_name || "—"}</div>
                          {/* audit26: truncate long emails so the row never
                              stretches / breaks the table grid. */}
                          <div
                            className="text-xs text-muted-foreground truncate max-w-[220px]"
                            title={p.contact_email || p.email || undefined}
                          >
                            {p.contact_email || p.email || "—"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_BADGE[p.status]}>{t(STATUS_LABEL_KEYS[p.status])}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Progress value={p.risk_score} className="h-1.5 w-16" />
                            <span className={`text-xs tabular ${riskColor(p.risk_score)}`}>{p.risk_score}</span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          <Badge variant={p.kyc_status === "approved" ? "default" : p.kyc_status === "pending" ? "secondary" : "outline"}>
                            {t(KYC_LABEL_KEYS[p.kyc_status])}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          {p.portal_enabled ? (
                            <Badge variant="secondary" className="gap-1">
                              <Star className="size-3" /> {p.portal_level}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(p.id)} title={t("view")}>
                              <Eye className="size-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 text-primary"
                              title={t("crm-view-360")}
                              onClick={() => {
                                setSelectedId(p.id);
                                setView("partner-360");
                              }}
                            >
                              <Maximize2 className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(p); setShowForm(true); }} title={t("edit")}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(p.id)} title={t("delete")}>
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </TableScroll>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between border-t px-4 py-3 gap-3 flex-wrap">
                <p className="text-sm text-muted-foreground">
                  {total > 0
                    ? <>{t("crm-showing-range").replace("${from}", String((page - 1) * PAGE_SIZE + 1)).replace("${to}", String(Math.min(page * PAGE_SIZE, total))).replace("${total}", String(total))}</>
                    : <>{t("crm-no-results")}</>}
                </p>
                <div className="flex items-center gap-3">
                  <PageSizeSelector value={PAGE_SIZE} onChange={setPageSize} options={pageSizeOptions} />
                  {totalPages > 1 && (
                  <Pagination>
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                      {generatePageNumbers(page, totalPages).map((p, i) =>
                        p === "ellipsis" ? (
                          <PaginationItem key={`ellipsis-${i}`}>
                            <PaginationEllipsis />
                          </PaginationItem>
                        ) : (
                          <PaginationItem key={p}>
                            <PaginationLink
                              isActive={page === p}
                              onClick={() => setPage(p as number)}
                              className="cursor-pointer"
                            >
                              {p}
                            </PaginationLink>
                          </PaginationItem>
                        )
                      )}
                      <PaginationItem>
                        <PaginationNext
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Form dialog */}
      <PartnerFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        partner={editing}
        onSaved={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["partners", tenantKey] });
          qc.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
        }}
      />

      {/* Detail sheet */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Building2 className="size-5" />
              {detail.data?.name || t("crm-partner")}
            </SheetTitle>
            <SheetDescription>{t("crm-partner-details")}</SheetDescription>
          </SheetHeader>
          {detail.isLoading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail.data ? (
            <PartnerDetail partner={detail.data} deals={partnerDeals.data?.items || []} />
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={closeDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("crm-delete-partner-title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("crm-delete-partner-desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* FIX-UX #3: cascade warning + type-to-confirm for partners with
              deals / offers / invoices. Hides itself when no related rows. */}
          {relatedCounts.data && relatedTotal > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2 text-sm">
              <p className="font-medium text-destructive">
                {t("crm-delete-partner-orphan-warning")
                  .replace("${deals}", String(relatedCounts.data.deals))
                  .replace("${offers}", String(relatedCounts.data.offers))
                  .replace("${invoices}", String(relatedCounts.data.invoices))
                  .replace("${name}", deletePartnerName || t("crm-delete-partner-title").replace("?", "").toLowerCase())}
              </p>
              <p className="text-muted-foreground">
                {t("crm-delete-partner-type-confirm").replace("${name}", deletePartnerName)}
              </p>
              <Input
                placeholder={t("crm-delete-partner-type-confirm").replace("${name}", deletePartnerName)}
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                aria-label="Type partner name to confirm delete"
              />
            </div>
          )}
          {relatedCounts.isLoading && (
            <p className="text-xs text-muted-foreground">{t("crm-delete-partner-checking")}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && canDeletePartner && deleteMut.mutate(deleteId)}
              disabled={!canDeletePartner || deleteMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BulkActionBar
        count={rowSel.count}
        onClear={rowSel.clear}
        label={rowSel.count === 1 ? t("crm-partner-selected") : t("crm-partners-selected")}
        actions={[
          {
            key: "export-selected",
            label: t("crm-partner-bulk-export-selected"),
            icon: <FileDown className="size-4" />,
            variant: "outline",
            disabled: rowSel.count === 0,
            onClick: bulkExportSelected,
          },
          {
            key: "delete",
            label: t("delete"),
            icon: <Trash2 className="size-4" />,
            variant: "destructive",
            disabled: bulkDeleteMut.isPending,
            confirm: t("crm-partner-bulk-delete-confirm").replace("${n}", String(rowSel.count)),
            onClick: () => bulkDeleteMut.mutate(rowSel.ids),
          },
        ]}
      />
    </div>
  );
}

// ---- Pagination helper ----
function generatePageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "ellipsis")[] = [1];
  if (current > 3) pages.push("ellipsis");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 2) pages.push("ellipsis");
  pages.push(total);
  return pages;
}

// ---- Detail panel ----
function PartnerDetail({ partner, deals }: { partner: Partner; deals: any[] }) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const contactInfo = [
    { icon: Mail, label: t("email"), value: partner.email },
    { icon: Phone, label: t("crm-contact-phone"), value: partner.phone },
    { icon: Globe, label: t("crm-website"), value: partner.website },
    { icon: MapPin, label: t("crm-address"), value: [partner.address_line, partner.city, partner.state, partner.postal_code, partner.country].filter(Boolean).join(", ") || null },
    { icon: Building2, label: t("crm-tax-id"), value: partner.tax_id },
  ].filter((x) => x.value);

  // Portal access state
  const [showActivateDialog, setShowActivateDialog] = useState(false);
  const [portalEmail, setPortalEmail] = useState(partner.email || "");
  const [portalTier, setPortalTier] = useState<PortalTier>("standard");
  const [creatingPortal, setCreatingPortal] = useState(false);
  const [sendingInvite, setSendingInvite] = useState(false);
  const [testPassword, setTestPassword] = useState<string | null>(null);
  const [settingTestPwd, setSettingTestPwd] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedPwd, setCopiedPwd] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [adminMessage, setAdminMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageRefreshKey, setMessageRefreshKey] = useState(0);

  // Fetch portal access for this partner
  const portalQuery = useQuery({
    queryKey: ["portal-access", tenantKey, partner.id],
    queryFn: async () => {
      const r = await fetch(api(`/api/portal-access?partner_id=${partner.id}`));
      if (!r.ok) throw new Error("Failed to load portal access");
      const data = await r.json();
      // API returns { items: PortalAccess[] }, find the one for this partner
      const items: PortalAccess[] = data.items || [];
      return items.find((p) => p.partner_id === partner.id) || null;
    },
    enabled: !!partner.id,
  });

  const portalAccess = portalQuery.data;

  // Create portal access mutation
  const createPortalMut = useMutation({
    mutationFn: async (data: { partner_id: string; portal_email: string; tier: PortalTier }) => {
      const r = await fetch(api("/api/portal-access"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id: data.partner_id,
          portal_email: data.portal_email,
          tier: data.tier,
          status: "approved",
          can_view_offers: true,
          can_view_documents: true,
          can_view_catalog: getTierMeta(data.tier).canSubmitRfq || data.tier !== "basic",
          can_view_invoices: data.tier === "premium" || data.tier === "business",
          can_view_profile: true,
          can_view_company_info: data.tier === "premium" || data.tier === "business",
          can_submit_rfq: getTierMeta(data.tier).canSubmitRfq,
          can_download_pdf: getTierMeta(data.tier).canDownloadPdf,
          exempt_kyc: !getTierMeta(data.tier).requiresKyc,
          exempt_document_upload: !getTierMeta(data.tier).requiresDocuments,
          exempt_location_share: !getTierMeta(data.tier).requiresLocation,
          must_set_password: true,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create portal access");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-portal-access-activated"));
      qc.invalidateQueries({ queryKey: ["portal-access", tenantKey, partner.id] });
      qc.invalidateQueries({ queryKey: ["partners", tenantKey] });
      setShowActivateDialog(false);
    },
    onError: (e: any) => toast.error(e.message || "Failed to activate portal."),
  });

  // Send invite email mutation
  const sendInviteMut = useMutation({
    mutationFn: async () => {
      if (!portalAccess?.id) throw new Error("No portal access found");
      const r = await fetch(api(`/api/portal-access/${portalAccess.id}/invite`), {
        method: "POST",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to send invite");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("crm-invite-email-sent"));
      qc.invalidateQueries({ queryKey: ["portal-access", tenantKey, partner.id] });
    },
    onError: (e: any) => toast.error(e.message || "Failed to send invite."),
  });

  const handleActivatePortal = async () => {
    if (!portalEmail.trim()) {
      toast.error(t("crm-portal-email-required"));
      return;
    }
    createPortalMut.mutate({
      partner_id: partner.id,
      portal_email: portalEmail.trim(),
      tier: portalTier,
    });
  };

  const handleSendInvite = async () => {
    setSendingInvite(true);
    try {
      await sendInviteMut.mutateAsync();
    } finally {
      setSendingInvite(false);
    }
  };

  // Generate a random test password
  const generateTestPassword = () => {
    const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let pwd = "";
    for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    return pwd;
  };

  // Set a test password for the portal user
  const handleSetTestPassword = async () => {
    if (!portalAccess?.id) return;
    setSettingTestPwd(true);
    try {
      const pwd = generateTestPassword();
      const res = await fetch(api("/api/portal/setup-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_id: portalAccess.id, password: pwd }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Failed to set test password");
      }
      setTestPassword(pwd);
      qc.invalidateQueries({ queryKey: ["portal-access", tenantKey, partner.id] });
      toast.success(t("crm-test-password-set"));
    } catch (e: any) {
      toast.error(e.message || t("crm-failed-set-test-password"));
    } finally {
      setSettingTestPwd(false);
    }
  };

  const copyToClipboard = async (text: string, type: "url" | "pwd" | "email") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "url") { setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000); }
      if (type === "pwd") { setCopiedPwd(true); setTimeout(() => setCopiedPwd(false), 2000); }
      if (type === "email") { setCopiedEmail(true); setTimeout(() => setCopiedEmail(false), 2000); }
      toast.success(t("crm-copied-to-clipboard"));
    } catch {
      toast.error(t("crm-failed-copy-clipboard"));
    }
  };

  const portalLoginUrl = typeof window !== "undefined"
    ? `${window.location.origin}/portal/login?email=${encodeURIComponent(portalAccess?.portal_email || "")}`
    : "";

  return (
    <div className="px-4 pb-6">
      {/* Badges */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Badge variant={STATUS_BADGE[partner.status]}>{t(STATUS_LABEL_KEYS[partner.status])}</Badge>
        <Badge variant="outline">{t(TYPE_LABEL_KEYS[partner.type])}</Badge>
        <Badge variant="outline">{partner.entity_type === "company" ? t("crm-company") : t("crm-individual")}</Badge>
        <Badge variant={partner.kyc_status === "approved" ? "default" : "outline"} className="gap-1">
          <ShieldCheck className="size-3" /> {t(KYC_LABEL_KEYS[partner.kyc_status])}
        </Badge>
        {partner.portal_enabled && (
          <Badge variant="secondary" className="gap-1">
            <Star className="size-3" /> {t("crm-portal-tier-prefix").replace("${tier}", partner.portal_level)}
          </Badge>
        )}
        {partner.is_commissioner && (
          <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary">
            <DollarSign className="size-3" /> {t("crm-commission-agent-badge")}
          </Badge>
        )}
        {portalAccess && (
          <Badge variant={PORTAL_STATUS_BADGE[portalAccess.status]} className="gap-1">
            {(() => { const Icon = PORTAL_STATUS_ICON[portalAccess.status]; return <Icon className="size-3" />; })()}
            {t("crm-portal-prefix")}{t(PORTAL_STATUS_LABEL_KEYS[portalAccess.status])}
          </Badge>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{t("crm-risk")}</p>
            <p className={`text-2xl font-semibold tabular ${riskColor(partner.risk_score)}`}>{partner.risk_score}</p>
          </CardContent>
        </Card>
        <Card className="border-border/60 shadow-soft rounded-xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{t("crm-deals-tab")}</p>
            <p className="text-2xl font-semibold tabular">{fmtNumber(deals.length)}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="info">
        <TabsList className="flex w-full overflow-x-auto justify-start sm:grid sm:grid-cols-5">
          <TabsTrigger value="info">{t("crm-overview")}</TabsTrigger>
          <TabsTrigger value="contact">{t("crm-contact-person")}</TabsTrigger>
          <TabsTrigger value="bank">{t("crm-bank-details-section")}</TabsTrigger>
          <TabsTrigger value="deals">{t("crm-deals-tab")}</TabsTrigger>
          <TabsTrigger value="portal" className="gap-1">
            <KeyRound className="size-3.5" /> {t("crm-portal-access-section")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="info" className="space-y-3 mt-3">
          {/* Trade preferences */}
          <div className="grid grid-cols-2 gap-2">
            {partner.preferred_currency && (
              <div className="p-2 rounded-md bg-muted/30">
                <p className="text-xs text-muted-foreground">{t("currency")}</p>
                <p className="text-sm font-medium">{partner.preferred_currency}</p>
              </div>
            )}
            {partner.preferred_payment_terms && (
              <div className="p-2 rounded-md bg-muted/30">
                <p className="text-xs text-muted-foreground">{t("crm-payment-terms")}</p>
                <p className="text-sm font-medium">{partner.preferred_payment_terms}</p>
              </div>
            )}
            {partner.preferred_incoterm && (
              <div className="p-2 rounded-md bg-muted/30">
                <p className="text-xs text-muted-foreground">{t("crm-incoterm")}</p>
                <p className="text-sm font-medium">{partner.preferred_incoterm}</p>
              </div>
            )}
            {partner.vat_number && (
              <div className="p-2 rounded-md bg-muted/30">
                <p className="text-xs text-muted-foreground">{t("crm-vat-number")}</p>
                <p className="text-sm font-medium">{partner.vat_number}</p>
              </div>
            )}
            {partner.registration_number && (
              <div className="p-2 rounded-md bg-muted/30">
                <p className="text-xs text-muted-foreground">{t("crm-registration-no")}</p>
                <p className="text-sm font-medium">{partner.registration_number}</p>
              </div>
            )}
          </div>

          {/* KYC details */}
          <div className="p-3 rounded-md border border-border/60">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <ShieldCheck className="size-3" /> {t("crm-kyc-verification")}
            </p>
            <p className="text-sm font-medium">{t(KYC_LABEL_KEYS[partner.kyc_status])}</p>
            {partner.kyc_reviewed_by && (
              <p className="text-xs text-muted-foreground mt-1">
                {t("crm-reviewed")} {partner.kyc_reviewed_at ? fmtDate(partner.kyc_reviewed_at) : ""}
              </p>
            )}
          </div>

          {/* Portal info (summary in info tab) */}
          <div className="p-3 rounded-md border border-border/60">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Star className="size-3" /> {t("crm-portal-access-section")}
            </p>
            <p className="text-sm font-medium">
              {partner.portal_enabled ? t("crm-portal-enabled").replace("${tier}", partner.portal_level) : t("crm-portal-disabled")}
            </p>
          </div>

          {/* Notes */}
          {partner.notes && (
            <div className="text-sm mt-3">
              <p className="text-xs text-muted-foreground mb-1">{t("crm-notes-label")}</p>
              <p className="whitespace-pre-wrap p-3 rounded-md bg-muted/50">{partner.notes}</p>
            </div>
          )}

          {/* Tags */}
          {partner.tags && partner.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {partner.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
            </div>
          )}

          {/* Created / Updated */}
          <div className="text-xs text-muted-foreground pt-2 border-t">
            <p>{t("crm-created-label")} {fmtDate(partner.created_at)}</p>
            <p>{t("crm-updated-label")} {fmtRelative(partner.updated_at)}</p>
          </div>
        </TabsContent>

        <TabsContent value="contact" className="space-y-2 mt-3">
          {contactInfo.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("crm-no-contact-info")}</p>
          ) : contactInfo.map((x) => {
            const Icon = x.icon;
            return (
              <div key={x.label} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/30">
                <Icon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{x.label}</p>
                  <p className="text-sm break-words">{x.value}</p>
                </div>
              </div>
            );
          })}
          {/* Contact person */}
          {(partner.contact_name || partner.contact_email || partner.contact_phone) && (
            <div className="pt-3 border-t mt-3">
              <p className="text-xs text-muted-foreground mb-2">{t("crm-contact-person-section")}</p>
              <div className="space-y-1">
                {partner.contact_name && <p className="text-sm">{partner.contact_name}</p>}
                {partner.contact_email && <p className="text-sm text-muted-foreground">{partner.contact_email}</p>}
                {partner.contact_phone && <p className="text-sm text-muted-foreground">{partner.contact_phone}</p>}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="bank" className="space-y-2 mt-3">
          {(!partner.bank_name && !partner.bank_account && !partner.bank_swift && !partner.bank_iban) ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("crm-no-bank-details")}</p>
          ) : (
            <div className="space-y-2">
              {partner.bank_name && (
                <div className="p-2 rounded-md hover:bg-muted/30">
                  <p className="text-xs text-muted-foreground">{t("crm-bank-name")}</p>
                  <p className="text-sm">{partner.bank_name}</p>
                </div>
              )}
              {partner.bank_account && (
                <div className="p-2 rounded-md hover:bg-muted/30">
                  <p className="text-xs text-muted-foreground">{t("crm-account")}</p>
                  <p className="text-sm font-mono tabular">{partner.bank_account}</p>
                </div>
              )}
              {partner.bank_iban && (
                <div className="p-2 rounded-md hover:bg-muted/30">
                  <p className="text-xs text-muted-foreground">{t("crm-iban")}</p>
                  <p className="text-sm font-mono tabular">{partner.bank_iban}</p>
                </div>
              )}
              {partner.bank_swift && (
                <div className="p-2 rounded-md hover:bg-muted/30">
                  <p className="text-xs text-muted-foreground">{t("crm-swift-bic")}</p>
                  <p className="text-sm font-mono tabular">{partner.bank_swift}</p>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="deals" className="mt-3">
          {deals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("crm-no-deals-yet")}</p>
          ) : (
            <div className="space-y-2">
              {deals.map((d) => (
                <div key={d.id} className="flex items-center justify-between p-2 rounded-md border border-border/60">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{d.title}</p>
                    <p className="text-xs text-muted-foreground capitalize">{d.stage} · {fmtDate(d.expected_close)}</p>
                  </div>
                  <span className="text-sm font-mono tabular">{fmtMoney(d.value, d.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ====== PORTAL TAB ====== */}
        <TabsContent value="portal" className="space-y-4 mt-3">
          {portalQuery.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : portalAccess ? (
            <>
              {/* Portal Status Card */}
              <Card className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {(() => { const Icon = PORTAL_STATUS_ICON[portalAccess.status]; return <Icon className="size-5" />; })()}
                      <div>
                        <p className="text-sm font-medium">{t("crm-portal-status")}</p>
                        <p className="text-xs text-muted-foreground">{t(PORTAL_STATUS_LABEL_KEYS[portalAccess.status])}</p>
                      </div>
                    </div>
                    <Badge variant={PORTAL_STATUS_BADGE[portalAccess.status]} className="text-sm px-3 py-1">
                      {t(PORTAL_STATUS_LABEL_KEYS[portalAccess.status])}
                    </Badge>
                  </div>

                  {/* Status timeline */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className={`size-4 ${portalAccess.status !== "pending_approval" ? "text-emerald-500" : "text-muted-foreground"}`} />
                      <span className={portalAccess.status === "pending_approval" ? "text-muted-foreground" : ""}>{t("crm-approved")}</span>
                      {portalAccess.approved_at && <span className="text-xs text-muted-foreground ml-auto">{fmtDate(portalAccess.approved_at)}</span>}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Send className={`size-4 ${["invited", "active"].includes(portalAccess.status) ? "text-emerald-500" : "text-muted-foreground"}`} />
                      <span className={!["invited", "active"].includes(portalAccess.status) ? "text-muted-foreground" : ""}>{t("crm-invite-sent")}</span>
                      {portalAccess.invited_at && <span className="text-xs text-muted-foreground ml-auto">{fmtDate(portalAccess.invited_at)}</span>}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle2 className={`size-4 ${portalAccess.status === "active" ? "text-emerald-500" : "text-muted-foreground"}`} />
                      <span className={portalAccess.status !== "active" ? "text-muted-foreground" : ""}>{t("crm-portal-status-active")}</span>
                      {portalAccess.last_login_at && <span className="text-xs text-muted-foreground ml-auto">{t("crm-last-login")} {fmtRelative(portalAccess.last_login_at)}</span>}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Portal Details */}
              <Card className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-4 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("crm-portal-details")}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-2 rounded-md bg-muted/30">
                      <p className="text-xs text-muted-foreground">{t("crm-portal-email")}</p>
                      <p className="text-sm font-medium">{portalAccess.portal_email || "—"}</p>
                    </div>
                    <div className="p-2 rounded-md bg-muted/30">
                      <p className="text-xs text-muted-foreground">{t("crm-tier")}</p>
                      <p className="text-sm font-medium">{TIER_INFO[portalAccess.tier].label}</p>
                    </div>
                    <div className="p-2 rounded-md bg-muted/30">
                      <p className="text-xs text-muted-foreground">{t("crm-welcome-email")}</p>
                      <p className="text-sm font-medium">{portalAccess.welcome_email_sent ? t("crm-sent") : t("crm-not-sent")}</p>
                    </div>
                    <div className="p-2 rounded-md bg-muted/30">
                      <p className="text-xs text-muted-foreground">{t("crm-password-set")}</p>
                      <p className="text-sm font-medium">{portalAccess.must_set_password ? t("pending") : t("crm-yes")}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Actions */}
              <div className="space-y-2">
                {/* {t("crm-send-invite-email")} */}
                {!portalAccess.welcome_email_sent && portalAccess.status !== "active" && (
                  <Button
                    className="w-full"
                    onClick={handleSendInvite}
                    disabled={sendingInvite || sendInviteMut.isPending}
                  >
                    {sendingInvite || sendInviteMut.isPending ? (
                      <Loader2 className="size-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="size-4 mr-2" />
                    )}
                    {t("crm-send-invite-email")}
                  </Button>
                )}

                {/* Re-send invite if already sent but not active */}
                {portalAccess.welcome_email_sent && portalAccess.status !== "active" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleSendInvite}
                    disabled={sendingInvite || sendInviteMut.isPending}
                  >
                    {sendingInvite || sendInviteMut.isPending ? (
                      <Loader2 className="size-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="size-4 mr-2" />
                    )}
                    {t("crm-re-send-invite-email")}
                  </Button>
                )}
              </div>

              {/* Test Portal Login Section */}
              <Card className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 text-muted-foreground" />
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("crm-test-portal-login")}</p>
                  </div>
                  <div className="p-3 rounded-md bg-muted/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{t("crm-portal-email")}</p>
                      <div className="flex items-center gap-1">
                        <p className="text-sm font-mono">{portalAccess.portal_email || "—"}</p>
                        {portalAccess.portal_email && (
                          <button
                            type="button"
                            onClick={() => copyToClipboard(portalAccess.portal_email!, "email")}
                            className="text-muted-foreground hover:text-foreground smooth"
                            title={t("crm-copy-email")}
                          >
                            {copiedEmail ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{t("status")}</p>
                      <Badge variant={PORTAL_STATUS_BADGE[portalAccess.status]} className="text-xs">
                        {t(PORTAL_STATUS_LABEL_KEYS[portalAccess.status])}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{t("crm-password-set")}</p>
                      <p className="text-sm font-medium">{portalAccess.must_set_password ? t("crm-no-value") : t("crm-yes")}</p>
                    </div>
                  </div>

                  {/* Test Password Section */}
                  {testPassword && (
                    <div className="p-3 rounded-lg border border-green-200 bg-green-50/50 dark:bg-green-950/20 dark:border-green-800 space-y-2">
                      <p className="text-xs font-medium text-green-800 dark:text-green-300">{t("crm-test-credentials")}</p>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">{t("email")}</p>
                          <code className="text-xs font-mono">{portalAccess.portal_email}</code>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">{t("crm-password")}</p>
                          <div className="flex items-center gap-1">
                            <code className="text-xs font-mono">{testPassword}</code>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(testPassword, "pwd")}
                              className="text-muted-foreground hover:text-foreground smooth"
                              title={t("crm-copy-password")}
                            >
                              {copiedPwd ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    {/* Set Test Password */}
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={handleSetTestPassword}
                      disabled={settingTestPwd}
                    >
                      {settingTestPwd ? (
                        <Loader2 className="size-4 mr-2 animate-spin" />
                      ) : (
                        <KeyRound className="size-4 mr-2" />
                      )}
                      {testPassword ? t("crm-reset-test-password") : t("crm-set-test-password")}
                    </Button>

                    {/* Copy Portal Login URL */}
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => copyToClipboard(portalLoginUrl, "url")}
                    >
                      {copiedUrl ? (
                        <Check className="size-4 mr-2 text-green-600" />
                      ) : (
                        <LinkIcon className="size-4 mr-2" />
                      )}
                      {copiedUrl ? t("crm-copied") : t("crm-copy-portal-login-url")}
                    </Button>

                    {/* {t("crm-open-portal-login")} */}
                    <Button variant="outline" className="w-full" asChild>
                      <a
                        href={`/portal/login?email=${encodeURIComponent(portalAccess.portal_email || "")}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="size-4 mr-2" />
                        {t("crm-open-portal-login")}
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Admin → Portal Messaging */}
              <Card className="border-border/60 shadow-soft rounded-xl">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="size-4 text-primary" />
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("crm-portal-messages")}</p>
                  </div>

                  {/* Message history */}
                  <PortalMessageThread accessId={portalAccess.id} partnerId={partner.id} tenantId={partner.tenant_id} refreshKey={messageRefreshKey} />

                  {/* Send message */}
                  <div className="flex gap-2">
                    <Input
                      value={adminMessage}
                      onChange={(e) => setAdminMessage(e.target.value)}
                      placeholder={t("crm-type-message")}
                      disabled={sendingMessage}
                    />
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (!adminMessage.trim() || !portalAccess.id) return;
                        setSendingMessage(true);
                        try {
                          const r = await fetch(api(`/api/portal-access/${portalAccess.id}/message`), {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ message: adminMessage.trim(), send_email: false }),
                          });
                          if (!r.ok) {
                            const e = await r.json().catch(() => ({}));
                            throw new Error(e.error || "Failed");
                          }
                          toast.success(t("crm-message-sent"));
                          setAdminMessage("");
                          // Refresh message thread
                          setMessageRefreshKey(k => k + 1);
                        } catch (e: any) {
                          toast.error(e.message || t("crm-failed-send-invite"));
                        } finally {
                          setSendingMessage(false);
                        }
                      }}
                      disabled={sendingMessage || !adminMessage.trim()}
                    >
                      {sendingMessage ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            /* No portal access yet */
            <Card className="border-border/60 shadow-soft rounded-xl">
              <CardContent className="p-6 text-center space-y-4">
                <div className="mx-auto w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center">
                  <KeyRound className="size-8 text-muted-foreground" />
                </div>
                <div>
                  <p className="font-medium">{t("crm-no-portal-access")}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("crm-activate-portal-desc")}
                  </p>
                </div>
                <Button onClick={() => setShowActivateDialog(true)} size="lg">
                  <Zap className="size-4 mr-2" />
                  {t("crm-activate-portal")}
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Activate Portal Dialog */}
      <Dialog open={showActivateDialog} onOpenChange={setShowActivateDialog}>
        <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
            <DialogTitle className="flex items-center gap-2">
              <Zap className="size-5" />
              {t("crm-activate-portal-access")}
            </DialogTitle>
            <DialogDescription>
              {t("crm-activate-portal-desc-2").replace("${name}", partner.name)}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          <div className="space-y-5">
            {/* Portal Email */}
            <div className="space-y-2">
              <Label htmlFor="portal-email">{t("crm-portal-email")}</Label>
              <Input
                id="portal-email"
                type="email"
                value={portalEmail}
                onChange={(e) => setPortalEmail(e.target.value)}
                placeholder={t("crm-portal-email-ph")}
              />
              <p className="text-xs text-muted-foreground">
                {t("crm-portal-email-desc")}
              </p>
            </div>

            {/* Tier Selection */}
            <div className="space-y-3">
              <Label>{t("crm-access-tier")}</Label>
              <div className="space-y-2">
                {ORDERED_TIERS.map((meta) => {
                  const tier = meta.value;
                  const info = TIER_INFO[tier];
                  const isSelected = portalTier === tier;
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => setPortalTier(tier)}
                      className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                        isSelected
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border/60 hover:border-border hover:bg-muted/30"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-medium text-sm">{info.label}</p>
                        {isSelected && (
                          <CheckCircle2 className="size-4 text-primary" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{info.description}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {info.features.map((f) => (
                          <Badge key={f} variant={isSelected ? "secondary" : "outline"} className="text-xs px-1.5 py-0">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          </div>

          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4 gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowActivateDialog(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={handleActivatePortal}
              disabled={createPortalMut.isPending || !portalEmail.trim()}
            >
              {createPortalMut.isPending ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Zap className="size-4 mr-2" />
              )}
              {t("crm-create-and-invite")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Visual type buttons for the form ----
const TYPE_BUTTONS = [
  { value: "buyer" as PartnerType, labelKey: "crm-type-buyer", descriptionKey: "crm-type-buyer-desc", icon: ShoppingCart },
  { value: "supplier" as PartnerType, labelKey: "crm-type-supplier", descriptionKey: "crm-type-supplier-desc", icon: Package },
  { value: "both" as PartnerType, labelKey: "crm-type-both", descriptionKey: "crm-type-both-desc", icon: RefreshCw },
  { value: "agent" as PartnerType, labelKey: "crm-type-agent", descriptionKey: "crm-type-agent-desc", icon: Briefcase },
] as const;

const OTHER_TYPES = [
  { value: "logistics", labelKey: "crm-type-logistics-provider" },
  { value: "customs", labelKey: "crm-type-customs-broker" },
  { value: "bank", labelKey: "crm-type-bank-financial" },
  { value: "inspector", labelKey: "crm-type-inspection-agency" },
];

// ---- Form dialog ----
function PartnerFormDialog({
  open, onOpenChange, partner, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partner: Partner | null;
  onSaved: () => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [form, setForm] = useState<Partial<Partner>>({});
  const [saving, setSaving] = useState(false);
  const [showOtherTypes, setShowOtherTypes] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [quickCreate, setQuickCreate] = useState(true);
  // FIX-UX #4: dirty tracking so a beforeunload guard can warn before the
  // user loses their typed-in data on tab close / refresh / route change.
  const [isDirty, setIsDirty] = useState(false);

  const isEditing = !!partner;

  // Fix: use useEffect instead of useMemo for side effects
  useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setIsDirty(false);
      if (partner) {
        setForm({ ...partner });
        setShowOtherTypes(["logistics", "customs", "bank", "inspector"].includes(partner.type));
        // When editing, open "More Details" if any advanced field has data
        const hasAdvanced = partner.address_line || partner.city || partner.tax_id ||
          partner.bank_name || partner.bank_account || partner.notes ||
          partner.portal_enabled || partner.is_commissioner ||
          partner.contact_name || partner.contact_email;
        setMoreOpen(!!hasAdvanced);
        setQuickCreate(false);
      } else {
        setForm({
          type: "buyer", status: "active", risk_score: 0, preferred_currency: "USD",
          entity_type: "company", preferred_payment_terms: "net30",
          portal_enabled: false, portal_level: "none", kyc_status: "not_submitted",
        } as Partial<Partner>);
        setShowOtherTypes(false);
        setMoreOpen(false);
        setQuickCreate(true);
      }
    }
  }, [open, partner]);

  // beforeunload guard — fires the browser's "Leave site?" prompt when the
  // form has unsaved edits. Cleared automatically on unmount by the cleanup
  // function returned from useEffect.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  function set<K extends keyof Partner>(k: K, v: Partner[K]) {
    setForm((f) => ({ ...f, [k]: v }));
    setIsDirty(true);
  }

  // FIX-UX #2: inline validation. Email format check is enforced (block
  // save), phone + tax_id format warnings are surfaced inline but don't
  // block save (since they're optional + country-dependent).
  const trimmedName = (form.name || "").trim();
  const nameErr = !trimmedName ? t("crm-name-required-toast") : "";
  const emailVal = (form.email || "").trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailErr = emailVal && !emailRegex.test(emailVal)
    ? "Enter a valid email address (e.g. name@company.com)."
    : "";
  // Quick-create requires a non-empty email (existing rule). Full form
  // treats email as optional — but if provided, must be valid.
  const emailMissingErr = !isEditing && quickCreate && !emailVal
    ? t("crm-email-required-quick")
    : "";
  const phoneVal = (form.phone || "").trim();
  const phoneWarn = phoneVal && !/^[+\d][\d\s()-]{4,}$/.test(phoneVal)
    ? "Phone number looks unusual — verify the country code."
    : "";
  const taxIdVal = (form.tax_id || "").trim();
  const taxIdWarn = taxIdVal && /\s/.test(taxIdVal)
    ? "Tax IDs usually don't contain spaces — double-check."
    : "";
  const isValid = !nameErr && !emailErr && !emailMissingErr;

  // Auto-generate partner code from name
  const handleNameChange = useCallback((name: string) => {
    set("name", name);
    if (!isEditing && name.trim()) {
      // Auto-generate code from name
      const code = generatePartnerCode(name);
      if (code) {
        set("tax_id" as keyof Partner, code as any);
      }
    }
  }, [isEditing]);

  async function save() {
    if (!isValid) {
      toast.error(nameErr || emailErr || emailMissingErr);
      return;
    }
    setSaving(true);
    try {
      const method = partner ? "PUT" : "POST";
      const url = partner ? api(`/api/partners/${partner.id}`) : api("/api/partners");
      const payload = { ...form, risk_score: form.risk_score ?? 0, name: (form.name || "").trim() };
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success(partner ? t("crm-partner-updated") : t("crm-partner-created").replace("${name}", form.name || ""));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || t("crm-saving-failed-toast"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{partner ? t("crm-edit-partner") : t("crm-new-partner")}</DialogTitle>
          <DialogDescription>
            {partner ? t("crm-update-partner-info") : quickCreate ? t("crm-quick-create-basics") : t("crm-add-detailed-partner-info")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 custom-scroll">
          <div className="space-y-4">

            {/* Quick Create Toggle (only for new partners) */}
            {!isEditing && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                <Button
                  size="sm"
                  variant={quickCreate ? "default" : "ghost"}
                  onClick={() => setQuickCreate(true)}
                  className="gap-1"
                >
                  <Zap className="size-3.5" />
                  {t("crm-quick-create")}
                </Button>
                <Button
                  size="sm"
                  variant={!quickCreate ? "default" : "ghost"}
                  onClick={() => setQuickCreate(false)}
                  className="gap-1"
                >
                  <Building2 className="size-3.5" />
                  {t("crm-full-form")}
                </Button>
              </div>
            )}

            {/* === Quick Create Mode === */}
            {quickCreate && !isEditing ? (
              <div className="space-y-4">
                {/* Name */}
                <div className="space-y-2">
                  <Label htmlFor="quick-name">{t("crm-partner-name-required")}</Label>
                  <Input
                    id="quick-name"
                    value={form.name || ""}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={t("crm-partner-name-ph")}
                    className="text-lg"
                    autoFocus
                    aria-invalid={!!nameErr}
                  />
                  {nameErr && <p className="text-xs text-destructive">{nameErr}</p>}
                </div>

                {/* Type - Visual Buttons */}
                <div className="space-y-2">
                  <Label>{t("crm-partner-type-label")}</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {TYPE_BUTTONS.map((tb) => {
                      const isSelected = form.type === tb.value && !showOtherTypes;
                      return (
                        <button
                          key={tb.value}
                          type="button"
                          onClick={() => {
                            set("type", tb.value);
                            setShowOtherTypes(false);
                            if (tb.value === "agent") {
                              set("is_commissioner" as keyof Partner, true as any);
                            } else {
                              set("is_commissioner" as keyof Partner, false as any);
                            }
                          }}
                          className={`flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${
                            isSelected
                              ? "border-primary bg-primary/5 shadow-sm"
                              : "border-border/60 hover:border-border hover:bg-muted/30"
                          }`}
                        >
                          <span className="text-xl"><tb.icon className="size-5" /></span>
                          <div>
                            <p className={`font-medium text-sm ${isSelected ? "text-primary" : ""}`}>{t(tb.labelKey)}</p>
                            <p className="text-xs text-muted-foreground">{t(tb.descriptionKey)}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {/* Other types link */}
                  {!showOtherTypes && (
                    <button
                      type="button"
                      onClick={() => setShowOtherTypes(true)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                    >
                      {t("crm-other-types-link")}
                    </button>
                  )}
                  {showOtherTypes && (
                    <div className="space-y-1.5">
                      <Label>{t("crm-specific-type")}</Label>
                      <Select value={form.type || "logistics"} onValueChange={(v) => set("type", v as PartnerType)}>
                        <SelectTrigger><SelectValue placeholder={t("crm-select-type")} /></SelectTrigger>
                        <SelectContent>
                          {OTHER_TYPES.map((ot) => <SelectItem key={ot.value} value={ot.value}>{t(ot.labelKey)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* Email */}
                <div className="space-y-2">
                  <Label htmlFor="quick-email">{t("email")} *</Label>
                  <Input
                    id="quick-email"
                    type="email"
                    value={form.email || ""}
                    onChange={(e) => set("email", e.target.value)}
                    placeholder={t("crm-email-ph")}
                    aria-invalid={!!emailErr || !!emailMissingErr}
                  />
                  {(emailMissingErr || emailErr) && (
                    <p className="text-xs text-destructive">{emailMissingErr || emailErr}</p>
                  )}
                </div>

                {/* Phone (optional) */}
                <div className="space-y-2">
                  <Label htmlFor="quick-phone">{t("crm-contact-phone")} <span className="text-muted-foreground">{t("crm-optional")}</span></Label>
                  <Input
                    id="quick-phone"
                    value={form.phone || ""}
                    onChange={(e) => set("phone", e.target.value)}
                    placeholder={t("crm-phone-ph")}
                    aria-invalid={!!phoneWarn}
                  />
                  {phoneWarn && <p className="text-xs text-amber-600 dark:text-amber-400">{phoneWarn}</p>}
                </div>
              </div>
            ) : (
              /* === Full Form Mode / Edit Mode === */
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="md:col-span-2 space-y-1.5">
                    <Label>{t("crm-partner-name-required")}</Label>
                    <Input value={form.name || ""} onChange={(e) => handleNameChange(e.target.value)} placeholder="Acme Trading Ltd." aria-invalid={!!nameErr} />
                    {nameErr && <p className="text-xs text-destructive">{nameErr}</p>}
                  </div>

                  {/* Type - Visual Buttons for full form too */}
                  <div className="md:col-span-2 space-y-2">
                    <Label>{t("type")}</Label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {TYPE_BUTTONS.map((tb) => {
                        const isSelected = form.type === tb.value && !showOtherTypes;
                        return (
                          <button
                            key={tb.value}
                            type="button"
                            onClick={() => {
                              set("type", tb.value);
                              setShowOtherTypes(false);
                              if (tb.value === "agent") {
                                set("is_commissioner" as keyof Partner, true as any);
                              } else {
                                set("is_commissioner" as keyof Partner, false as any);
                              }
                            }}
                            className={`flex flex-col items-center gap-1 p-2.5 rounded-lg border-2 transition-all ${
                              isSelected
                                ? "border-primary bg-primary/5 shadow-sm"
                                : "border-border/60 hover:border-border hover:bg-muted/30"
                            }`}
                          >
                            <span className="text-lg"><tb.icon className="size-4" /></span>
                            <p className={`text-xs font-medium ${isSelected ? "text-primary" : ""}`}>{t(tb.labelKey)}</p>
                          </button>
                        );
                      })}
                    </div>
                    {/* Other types link */}
                    {!showOtherTypes && (
                      <button
                        type="button"
                        onClick={() => setShowOtherTypes(true)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                      >
                        {t("crm-other-types-link-short")}
                      </button>
                    )}
                    {showOtherTypes && (
                      <div className="space-y-1.5">
                        <Label>{t("crm-specific-type")}</Label>
                        <Select value={form.type || "logistics"} onValueChange={(v) => set("type", v as PartnerType)}>
                          <SelectTrigger><SelectValue placeholder={t("crm-select-type")} /></SelectTrigger>
                          <SelectContent>
                            {OTHER_TYPES.map((ot) => <SelectItem key={ot.value} value={ot.value}>{t(ot.labelKey)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label>{t("email")}</Label>
                    <Input type="email" value={form.email || ""} onChange={(e) => set("email", e.target.value)} placeholder="contact@company.com" aria-invalid={!!emailErr} />
                    {emailErr && <p className="text-xs text-destructive">{emailErr}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("crm-contact-phone")}</Label>
                    <Input value={form.phone || ""} onChange={(e) => set("phone", e.target.value)} placeholder="+1 555 123 4567" aria-invalid={!!phoneWarn} />
                    {phoneWarn && <p className="text-xs text-amber-600 dark:text-amber-400">{phoneWarn}</p>}
                  </div>
                </div>

                {/* === More Details (single collapsible section) === */}
                <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2 w-full py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {moreOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      {t("crm-more-details")}
                      {!moreOpen && (form.address_line || form.city || form.tax_id || form.bank_name || form.notes || form.contact_name) && (
                        <Badge variant="secondary" className="text-xs px-1.5 py-0">{t("crm-filled")}</Badge>
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-4 pt-1 pb-2">

                      {/* Address & Trade */}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{t("crm-address-trade")}</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label>{t("status")}</Label>
                            <Select value={form.status || "active"} onValueChange={(v) => set("status", v as Partner["status"])}>
                              <SelectTrigger><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="active">{t("active")}</SelectItem>
                                <SelectItem value="inactive">{t("inactive")}</SelectItem>
                                <SelectItem value="blacklisted">{t("crm-blacklisted")}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-entity-type-label")}</Label>
                            <Select value={form.entity_type || "company"} onValueChange={(v) => set("entity_type", v as PartnerEntityType)}>
                              <SelectTrigger><SelectValue placeholder={t("crm-select-entity-type")} /></SelectTrigger>
                              <SelectContent>
                                {ENTITY_TYPES.map((et) => <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-tax-id")}</Label>
                            <Input value={form.tax_id || ""} onChange={(e) => set("tax_id", e.target.value)} placeholder={t("crm-tax-id-ph")} aria-invalid={!!taxIdWarn} />
                            {taxIdWarn && <p className="text-xs text-amber-600 dark:text-amber-400">{taxIdWarn}</p>}
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-vat-number")}</Label>
                            <Input value={form.vat_number || ""} onChange={(e) => set("vat_number", e.target.value)} placeholder={t("crm-vat-number-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-registration-no")}</Label>
                            <Input value={form.registration_number || ""} onChange={(e) => set("registration_number", e.target.value)} placeholder={t("crm-registration-no-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-website")}</Label>
                            <Input value={form.website || ""} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("currency")}</Label>
                            <Select value={form.preferred_currency || "USD"} onValueChange={(v) => set("preferred_currency", v)}>
                              <SelectTrigger><SelectValue placeholder={t("crm-select-currency")} /></SelectTrigger>
                              <SelectContent className="max-h-72">
                                {CURRENCIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-payment-terms")}</Label>
                            <Select value={form.preferred_payment_terms || "net30"} onValueChange={(v) => set("preferred_payment_terms", v)}>
                              <SelectTrigger><SelectValue placeholder={t("crm-select-payment-terms")} /></SelectTrigger>
                              <SelectContent>
                                {PAYMENT_TERMS_LOCAL.map((pt) => <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="md:col-span-2 space-y-1.5">
                            <Label>{t("crm-address")}</Label>
                            <Input value={form.address_line || ""} onChange={(e) => set("address_line", e.target.value)} placeholder={t("crm-address")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-city")}</Label>
                            <Input value={form.city || ""} onChange={(e) => set("city", e.target.value)} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-state-region")}</Label>
                            <Input value={form.state || ""} onChange={(e) => set("state", e.target.value)} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-postal-code")}</Label>
                            <Input value={form.postal_code || ""} onChange={(e) => set("postal_code", e.target.value)} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-country")}</Label>
                            <SearchableSelect
                              options={getCountriesForSelect()}
                              value={form.country || ""}
                              onChange={(v) => set("country", v)}
                              placeholder={t("crm-select-country")}
                              searchPlaceholder={t("crm-search-countries")}
                              clearable
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-city")}</Label>
                            {form.country ? (
                              <SearchableSelect
                                options={getCitiesForSelect(form.country)}
                                value={form.city || ""}
                                onChange={(v) => set("city", v)}
                                placeholder={t("crm-select-city")}
                                searchPlaceholder={t("crm-search-cities")}
                                clearable
                              />
                            ) : (
                              <Input
                                value={form.city || ""}
                                onChange={(e) => set("city", e.target.value)}
                                placeholder={t("crm-select-country-first")}
                              />
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Contact Person */}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{t("crm-contact-person-section")}</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label>{t("name")}</Label>
                            <Input value={form.contact_name || ""} onChange={(e) => set("contact_name", e.target.value)} placeholder={t("crm-contact-name-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("email")}</Label>
                            <Input type="email" value={form.contact_email || ""} onChange={(e) => set("contact_email", e.target.value)} placeholder={t("crm-contact-email-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-contact-phone")}</Label>
                            <Input value={form.contact_phone || ""} onChange={(e) => set("contact_phone", e.target.value)} placeholder="+1 555 123 4567" />
                          </div>
                        </div>
                      </div>

                      {/* Bank Details */}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{t("crm-bank-details-section")}</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label>{t("crm-bank-name")}</Label>
                            <Input value={form.bank_name || ""} onChange={(e) => set("bank_name", e.target.value)} placeholder={t("crm-bank-name-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-account")}</Label>
                            <Input value={form.bank_account || ""} onChange={(e) => set("bank_account", e.target.value)} placeholder={t("crm-account-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-iban")}</Label>
                            <Input value={form.bank_iban || ""} onChange={(e) => set("bank_iban", e.target.value)} placeholder={t("crm-iban-ph")} />
                          </div>
                          <div className="space-y-1.5">
                            <Label>{t("crm-swift-bic")}</Label>
                            <Input value={form.bank_swift || ""} onChange={(e) => set("bank_swift", e.target.value)} placeholder={t("crm-swift-ph")} />
                          </div>
                        </div>
                      </div>

                      {/* Notes & Options */}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{t("crm-notes-options")}</p>
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label>{t("crm-notes-label")}</Label>
                            <Textarea rows={3} value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} placeholder={t("crm-partner-notes-ph")} />
                          </div>

                          <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30">
                            <Switch checked={!!form.portal_enabled} onCheckedChange={(v) => set("portal_enabled", v)} aria-label={t("crm-portal-access-toggle")} />
                            <div>
                              <p className="text-sm font-medium">{t("crm-portal-access-toggle")}</p>
                              <p className="text-xs text-muted-foreground">{t("crm-portal-access-toggle-desc")}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 p-3 rounded-md bg-primary/5 border border-primary/20">
                            <Switch checked={!!form.is_commissioner} onCheckedChange={(v) => set("is_commissioner", v)} aria-label={t("crm-commission-agent-section")} />
                            <div>
                              <p className="text-sm font-medium text-primary">{t("crm-commission-agent-section")}</p>
                              <p className="text-xs text-muted-foreground">{t("crm-commission-agent-desc")}</p>
                            </div>
                          </div>
                        </div>
                      </div>

                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || !isValid}>
            {saving ? t("crm-saving-ellipsis") : (partner ? t("crm-save-changes") : quickCreate ? t("crm-create-partner") : t("crm-create-partner"))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Portal Message Thread (admin side) ───────────────────────────────

function PortalMessageThread({
  accessId,
  partnerId,
  tenantId,
  refreshKey,
}: {
  accessId: string;
  partnerId: string;
  tenantId: string;
  refreshKey?: number;
}) {
  const t = useT();
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    // Use a microtask to avoid calling setState synchronously in the effect body
    queueMicrotask(() => { if (mounted) setLoading(true); });
    fetch(api(`/api/portal-access/${accessId}/message`))
      .then((r) => r.json())
      .then((data) => {
        if (!mounted) return;
        const items = (data.items || []) as any[];
        const mapped = items
          .map((m: any) => ({
            id: m.id,
            direction: m.direction === "portal_to_admin" ? "incoming" : "outgoing",
            message: m.body || "",
            sender: m.sender_username || "System",
            timestamp: m.created_at,
            attachment_url: m.attachment_url || null,
            attachment_name: m.attachment_name || null,
          }))
          .sort((a: any, b: any) => a.timestamp.localeCompare(b.timestamp));
        setMessages(mapped);
      })
      .catch(() => {
        if (mounted) setMessages([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [accessId, partnerId, refreshKey]);

  if (loading) {
    return <Skeleton className="h-32 w-full rounded-lg" />;
  }

  if (messages.length === 0) {
    return (
      <div className="text-center py-4 text-xs text-muted-foreground">
        {t("crm-no-messages")}
      </div>
    );
  }

  return (
    <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex flex-col max-w-[85%] rounded-lg p-2 text-xs ${
            msg.direction === "outgoing"
              ? "ml-auto bg-primary text-primary-foreground"
              : "mr-auto bg-muted"
          }`}
        >
          {msg.message && <p className="leading-relaxed whitespace-pre-wrap">{msg.message}</p>}
          {msg.attachment_url && msg.attachment_name && (
            <a
              // 2b2-F1 — admin viewer must use the admin-scoped download
              // route `/api/portal-uploads/[id]/download` (gated by
              // `requireAuth`), NOT the portal-side route
              // `/api/portal/attachments/[id]` (gated by
              // `getPortalSessionAccess`). The portal composer now
              // stores the singular portal form, which an admin cookie
              // would 401 at. `toAdminAttachmentHref` rewrites BOTH the
              // new singular portal form AND the legacy broken singular
              // `/api/portal/upload/<id>/download` form (kept for
              // historical message rows) to the admin plural form.
              href={toAdminAttachmentHref(msg.attachment_url)}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-1 inline-flex items-center gap-1 underline underline-offset-2 ${msg.direction === "outgoing" ? "text-primary-foreground" : "text-primary"}`}
            >
              <Paperclip className="size-3" /> {msg.attachment_name}
            </a>
          )}
          <p className={`text-[9px] mt-1 ${msg.direction === "outgoing" ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
            {msg.sender} · {fmtRelative(msg.timestamp)}
          </p>
        </div>
      ))}
    </div>
  );
}
