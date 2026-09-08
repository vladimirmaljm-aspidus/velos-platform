"use client";

/**
 * ReferralCommissionsTab — the admin control surface for portal referral
 * commissions (migration 097). Fourth tab of the Commissions view.
 *
 * Gives the admin TOTAL lifecycle control, exactly as requested:
 *   • which business (referral company, contact, product, linked document)
 *   • how much commission (amount, rate, deal value, currency)
 *   • is it paid / is the business done / when (state machine + timestamps)
 *   • are all documents in (checklist + the partner's uploaded files)
 *   • agreement status + payout bank account status per partner
 * State machine: pending → confirmed → approved → paid (+ cancelled),
 * with money gates (signed agreement + complete documents) enforced
 * server-side (/transition route) and surfaced here.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
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
import {
  Plus, Search, Eye, HandCoins, FileSignature, Landmark, Paperclip,
  CheckCircle2, XCircle, Clock3, CircleDollarSign, BadgeCheck, Loader2,
  Building2, User, Package, Hash, FileText, Wallet, ShieldCheck, TriangleAlert, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { fmtMoney, fmtDate } from "@/lib/utils/format";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { PartnerPicker } from "@/components/common/partner-picker";
import type { ReferralCommission } from "@/lib/supabase/types";

// ─── Types (admin list row = entry + enrichment) ───────────────────────────

type RefStatus = ReferralCommission["status"];

interface AdminRow extends ReferralCommission {
  partner_name: string;
  partner_email: string | null;
  agreement_status: string | null;
  agreement_signed_at: string | null;
  bank_status: string | null;
  iban_masked: string | null;
  attachments?: { id: string; filename: string; size_bytes: number; uploaded_at: string; mime_type: string | null }[];
}

interface DetailRow extends AdminRow {
  partner_email: string | null;
  agreement: {
    id: string; status: string; commission_type: string; commission_rate: number | null;
    commission_currency: string; conditions: string | null; agreement_version: string;
    activated_at: string | null; signed_at: string | null; signed_by_name: string | null;
    signed_version: string | null;
  } | null;
  payout_account: {
    id: string; status: string; beneficiary_name: string; bank_name: string | null;
    iban: string; iban_masked: string; swift_bic: string | null; account_currency: string | null;
    country: string | null; additional_instructions: string | null;
    verified_by: string | null; verified_at: string | null;
  } | null;
  attachments: { id: string; filename: string; size_bytes: number; uploaded_at: string; mime_type: string | null }[];
}

const STATUS_META: Record<RefStatus, { key: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending: { key: "ref-status-pending", className: "border-slate-400/40 bg-slate-400/10 text-slate-600 dark:text-slate-300", icon: Clock3 },
  confirmed: { key: "ref-status-confirmed", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400", icon: CheckCircle2 },
  approved: { key: "ref-status-approved", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: CircleDollarSign },
  paid: { key: "ref-status-paid", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", icon: BadgeCheck },
  cancelled: { key: "ref-status-cancelled", className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400", icon: XCircle },
};

// ─── Main tab component ────────────────────────────────────────────────────

export function ReferralCommissionsTab({
  isLoading: outerLoading, isError, onRefresh,
}: {
  isLoading: boolean;
  isError: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  const api = useApiUrl();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const listQ = useQuery<{ items: AdminRow[]; total: number }, Error>({
    queryKey: ["referral-commissions", statusFilter],
    queryFn: async () => {
      const r = await fetch(api("/api/referral-commissions", { status: statusFilter === "all" ? undefined : statusFilter }), { cache: "no-store" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load referral commissions.");
      }
      return r.json();
    },
  });

  const items = (listQ.data?.items || []).filter((r) => {
    if (!search.trim()) return true;
    const s = search.trim().toLowerCase();
    return (
      r.referral_company?.toLowerCase().includes(s) ||
      r.partner_name?.toLowerCase().includes(s) ||
      r.product?.toLowerCase().includes(s) ||
      r.ref_number?.toLowerCase().includes(s) ||
      r.referral_contact?.toLowerCase().includes(s)
    );
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["referral-commissions"] });
    qc.invalidateQueries({ queryKey: ["referral-commission-detail"] });
    onRefresh();
  };

  // KPIs
  const total = items.filter((r) => r.status !== "cancelled");
  const kpis = {
    entries: total.length,
    outstanding: total.filter((r) => r.status === "approved").reduce((s, r) => s + (Number(r.commission_amount) || 0), 0),
    paid: total.filter((r) => r.status === "paid").length,
    awaiting: total.filter((r) => r.status === "pending" || r.status === "confirmed").length,
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("refa-search-ph")} className="pl-8" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("refa-filter-all")}</SelectItem>
            <SelectItem value="pending">{t("ref-status-pending")}</SelectItem>
            <SelectItem value="confirmed">{t("ref-status-confirmed")}</SelectItem>
            <SelectItem value="approved">{t("ref-status-approved")}</SelectItem>
            <SelectItem value="paid">{t("ref-status-paid")}</SelectItem>
            <SelectItem value="cancelled">{t("ref-status-cancelled")}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={() => listQ.refetch()} title={t("misc-refresh") || "Refresh"}>
          <RefreshCw className="size-4" />
        </Button>
        <div className="flex-1" />
        <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> {t("refa-new")}
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat icon={HandCoins} label={t("refa-kpi-entries")} value={String(kpis.entries)} />
        <MiniStat icon={Wallet} label={t("refa-kpi-outstanding")} value={fmtMoney(kpis.outstanding, items[0]?.currency || "USD")} tone="amber" />
        <MiniStat icon={BadgeCheck} label={t("refa-kpi-paid-count")} value={String(kpis.paid)} tone="emerald" />
        <MiniStat icon={Clock3} label={t("refa-kpi-awaiting")} value={String(kpis.awaiting)} tone="sky" />
      </div>

      {/* Table */}
      {outerLoading || listQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : listQ.isError || isError ? (
        <QueryError onRetry={() => listQ.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<HandCoins className="size-6 text-muted-foreground" />}
          title={t("refa-empty-title")}
          description={t("refa-empty-body")}
          action={(
            <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> {t("refa-new")}
            </Button>
          )}
        />
      ) : (
        <Card className="border-border/60 shadow-soft">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("refa-th-partner")}</TableHead>
                  <TableHead>{t("refa-th-referral")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("refa-th-product")}</TableHead>
                  <TableHead className="text-right">{t("refa-th-amount")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("refa-th-docs")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("refa-th-agreement")}</TableHead>
                  <TableHead className="hidden xl:table-cell">{t("refa-th-bank")}</TableHead>
                  <TableHead>{t("refa-th-status")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => {
                  const st = STATUS_META[r.status];
                  const StIcon = st.icon;
                  return (
                    <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                      <TableCell className="max-w-[160px]">
                        <p className="font-medium truncate">{r.partner_name}</p>
                        {r.ref_number && <p className="text-[11px] text-muted-foreground tabular-nums">{r.ref_number}</p>}
                      </TableCell>
                      <TableCell className="max-w-[180px]">
                        <p className="truncate">{r.referral_company}</p>
                        {r.referral_contact && <p className="text-[11px] text-muted-foreground truncate">{r.referral_contact}</p>}
                      </TableCell>
                      <TableCell className="hidden md:table-cell max-w-[180px]">
                        <p className="text-sm truncate">{r.product || "—"}</p>
                        {r.deal_value != null && <p className="text-[11px] text-muted-foreground tabular-nums">{fmtMoney(r.deal_value, r.currency)}</p>}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums whitespace-nowrap">
                        {fmtMoney(r.commission_amount, r.currency)}
                        {r.status === "paid" && r.paid_amount != null && r.paid_amount !== r.commission_amount && (
                          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtMoney(r.paid_amount, r.currency)}</p>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <DocBadge complete={r.documents_complete} t={t} />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <AgreementMiniBadge status={r.agreement_status} signedAt={r.agreement_signed_at} t={t} />
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {r.bank_status ? <BankMiniBadge status={r.bank_status} t={t} /> : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("gap-1 whitespace-nowrap", st.className)}>
                          <StIcon className="size-3.5" /> {t(st.key)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="size-8" onClick={(e) => { e.stopPropagation(); setDetailId(r.id); }}>
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Create dialog */}
      <CreateReferralDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={invalidate} api={api} t={t} />

      {/* Detail sheet */}
      <ReferralDetailSheet
        id={detailId}
        onClose={() => setDetailId(null)}
        onChanged={invalidate}
        api={api}
        t={t}
      />
    </div>
  );
}

// ─── Small pieces ──────────────────────────────────────────────────────────

function MiniStat({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; tone?: "amber" | "emerald" | "sky";
}) {
  const tones: Record<string, string> = {
    amber: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
    emerald: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
    sky: "text-sky-600 dark:text-sky-400 bg-sky-500/10",
  };
  return (
    <Card className="border-border/60">
      <CardContent className="p-3 flex items-center gap-2.5">
        <div className={cn("size-8 rounded-lg flex items-center justify-center shrink-0", tone ? tones[tone] : "bg-muted")}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground truncate">{label}</p>
          <p className="font-semibold text-sm tabular-nums truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function DocBadge({ complete, t }: { complete: boolean; t: (k: string) => string }) {
  return complete ? (
    <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="size-3" /> {t("refa-docs-complete")}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 bg-muted/50 text-muted-foreground">
      <Paperclip className="size-3" /> {t("refa-docs-pending")}
    </Badge>
  );
}

function AgreementMiniBadge({ status, signedAt, t }: { status: string | null; signedAt: string | null; t: (k: string) => string }) {
  if (!status) return <span className="text-muted-foreground text-xs">—</span>;
  if (status === "signed") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
        <ShieldCheck className="size-3" /> {t("refa-ag-signed")} {signedAt ? fmtDate(signedAt) : ""}
      </Badge>
    );
  }
  if (status === "pending_signature") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 whitespace-nowrap">
        <FileSignature className="size-3" /> {t("refa-ag-awaiting")}
      </Badge>
    );
  }
  return <Badge variant="outline" className="bg-muted/50 text-muted-foreground">{status}</Badge>;
}

function BankMiniBadge({ status, t }: { status: string; t: (k: string) => string }) {
  if (status === "verified") {
    return <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"><BadgeCheck className="size-3" /> {t("refa-bank-verified")}</Badge>;
  }
  if (status === "rejected") {
    return <Badge variant="outline" className="gap-1 border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"><XCircle className="size-3" /> {t("refa-bank-rejected")}</Badge>;
  }
  return <Badge variant="outline" className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"><Clock3 className="size-3" /> {t("refa-bank-submitted")}</Badge>;
}

// ─── Create dialog ─────────────────────────────────────────────────────────

function CreateReferralDialog({ open, onOpenChange, onCreated, api, t }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  api: (p: string, params?: Record<string, string | number | boolean | undefined>) => string;
  t: (k: string) => string;
}) {
  const [partnerId, setPartnerId] = useState("");
  const [form, setForm] = useState({
    referral_company: "", referral_contact: "", referral_email: "", referral_phone: "",
    product: "", ref_number: "", deal_value: "", currency: "USD",
    commission_type: "revenue_percent", commission_rate: "", commission_amount: "",
    conditions: "", ref_type: "manual",
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api("/api/referral-commissions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id: partnerId,
          ...form,
          deal_value: form.deal_value ? Number(form.deal_value) : null,
          commission_rate: form.commission_rate ? Number(form.commission_rate) : null,
          commission_amount: form.commission_amount ? Number(form.commission_amount) : undefined,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Create failed");
      return body;
    },
    onSuccess: () => {
      toast.success(t("refa-created-toast"));
      onCreated();
      onOpenChange(false);
      setPartnerId("");
      setForm({
        referral_company: "", referral_contact: "", referral_email: "", referral_phone: "",
        product: "", ref_number: "", deal_value: "", currency: "USD",
        commission_type: "revenue_percent", commission_rate: "", commission_amount: "",
        conditions: "", ref_type: "manual",
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const valid = partnerId && form.referral_company.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><HandCoins className="size-5" /> {t("refa-new-title")}</DialogTitle>
          <DialogDescription>{t("refa-new-desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("refa-f-partner")} *</Label>
            <PartnerPicker value={partnerId} onSelect={(p) => setPartnerId(p?.id || "")} />
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("refa-f-company")} *</Label>
              <Input value={form.referral_company} onChange={set("referral_company")} placeholder={t("refa-f-company-ph")} maxLength={300} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-contact")}</Label>
              <Input value={form.referral_contact} onChange={set("referral_contact")} maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-contact-email")}</Label>
              <Input type="email" value={form.referral_email} onChange={set("referral_email")} maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-contact-phone")}</Label>
              <Input value={form.referral_phone} onChange={set("referral_phone")} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-ref-type")}</Label>
              <Select value={form.ref_type} onValueChange={(v) => setForm((f) => ({ ...f, ref_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">{t("refa-f-ref-manual")}</SelectItem>
                  <SelectItem value="deal">{t("refa-f-ref-deal")}</SelectItem>
                  <SelectItem value="offer">{t("refa-f-ref-offer")}</SelectItem>
                  <SelectItem value="invoice">{t("refa-f-ref-invoice")}</SelectItem>
                  <SelectItem value="proforma">{t("refa-f-ref-proforma")}</SelectItem>
                  <SelectItem value="loi">{t("refa-f-ref-loi")}</SelectItem>
                  <SelectItem value="rfq">{t("refa-f-ref-rfq")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-ref-number")}</Label>
              <Input value={form.ref_number} onChange={set("ref_number")} placeholder="OFF-2026-0014" maxLength={100} className="tabular-nums" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("refa-f-product")}</Label>
              <Input value={form.product} onChange={set("product")} placeholder={t("refa-f-product-ph")} maxLength={500} />
            </div>
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("refa-f-deal-value")}</Label>
              <Input type="number" min="0" step="0.01" value={form.deal_value} onChange={set("deal_value")} className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-currency")}</Label>
              <Input value={form.currency} onChange={set("currency")} maxLength={3} className="uppercase" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-type")}</Label>
              <Select value={form.commission_type} onValueChange={(v) => setForm((f) => ({ ...f, commission_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="revenue_percent">{t("ref-type-revenue_percent")}</SelectItem>
                  <SelectItem value="profit_percent">{t("ref-type-profit_percent")}</SelectItem>
                  <SelectItem value="fixed">{t("ref-type-fixed")}</SelectItem>
                  <SelectItem value="per_unit">{t("ref-type-per_unit")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-rate")}</Label>
              <Input type="number" min="0" step="0.01" value={form.commission_rate} onChange={set("commission_rate")} className="tabular-nums" placeholder="2.5" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("refa-f-amount")}</Label>
              <Input type="number" min="0" step="0.01" value={form.commission_amount} onChange={set("commission_amount")} className="tabular-nums" placeholder={t("refa-f-amount-ph")} />
              <p className="text-[11px] text-muted-foreground">{t("refa-f-amount-hint")}</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("refa-f-conditions")}</Label>
              <Textarea value={form.conditions} onChange={set("conditions")} rows={3} maxLength={4000} placeholder={t("refa-f-conditions-ph")} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("refa-cancel") || "Cancel"}</Button>
          <Button className="gap-1.5" disabled={!valid || createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("refa-create") || "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Detail sheet (total control) ──────────────────────────────────────────

function ReferralDetailSheet({ id, onClose, onChanged, api, t }: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
  api: (p: string, params?: Record<string, string | number | boolean | undefined>) => string;
  t: (k: string) => string;
}) {
  const [payOpen, setPayOpen] = useState(false);
  const [payRef, setPayRef] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [agOpen, setAgOpen] = useState(false);

  const q = useQuery<DetailRow, Error>({
    queryKey: ["referral-commission-detail", id],
    queryFn: async () => {
      const r = await fetch(api(`/api/referral-commissions/${id}`), { cache: "no-store" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load.");
      }
      return r.json();
    },
    enabled: !!id,
  });

  const transitionMut = useMutation({
    mutationFn: async (action: string) => {
      const r = await fetch(api(`/api/referral-commissions/${id}/transition`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Transition failed");
      return body;
    },
    onSuccess: () => { onChanged(); toast.success(t("refa-updated-toast")); },
    onError: (e: Error) => toast.error(e.message),
  });

  const payMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/api/referral-commissions/${id}/mark-paid`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payout_reference: payRef, paid_amount: payAmount ? Number(payAmount) : undefined }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Failed");
      return body;
    },
    onSuccess: () => { onChanged(); setPayOpen(false); toast.success(t("refa-paid-toast")); },
    onError: (e: Error) => toast.error(e.message),
  });

  const docsMut = useMutation({
    mutationFn: async (complete: boolean) => {
      const r = await fetch(api(`/api/referral-commissions/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents_complete: complete }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Failed");
      return body;
    },
    onSuccess: () => onChanged(),
    onError: (e: Error) => toast.error(e.message),
  });

  const bankVerifyMut = useMutation({
    mutationFn: async (status: "verified" | "rejected") => {
      const accId = q.data?.payout_account?.id;
      const r = await fetch(api(`/api/referral-commissions/payout-accounts/${accId}/verify`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Failed");
      return body;
    },
    onSuccess: () => onChanged(),
    onError: (e: Error) => toast.error(e.message),
  });

  if (!id) return null;
  const d = q.data;

  return (
    <Sheet open={!!id} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto p-0">
        <SheetHeader className="p-6 pb-3 border-b sticky top-0 bg-background z-10">
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            <HandCoins className="size-5" />
            {d ? d.referral_company : <Skeleton className="h-5 w-40" />}
            {d && <Badge variant="outline" className={cn("gap-1", STATUS_META[d.status].className)}>{t(STATUS_META[d.status].key)}</Badge>}
          </SheetTitle>
          <SheetDescription>
            {d ? `${d.partner_name} · ${fmtMoney(d.commission_amount, d.currency)} · ${fmtDate(d.created_at)}` : ""}
          </SheetDescription>
        </SheetHeader>

        {q.isLoading ? (
          <div className="p-6 space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : q.isError ? (
          <div className="p-6"><QueryError onRetry={() => q.refetch()} /></div>
        ) : d ? (
          <div className="p-6 space-y-6">
            {/* ── Lifecycle actions ── */}
            <div className="rounded-xl border p-4 space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("refa-actions-title")}</p>
              <div className="flex flex-wrap gap-2">
                {d.status === "pending" && (
                  <Button size="sm" className="gap-1.5" disabled={transitionMut.isPending} onClick={() => transitionMut.mutate("confirm")}>
                    <CheckCircle2 className="size-4" /> {t("refa-confirm-deal")}
                  </Button>
                )}
                {d.status === "confirmed" && (
                  <Button size="sm" className="gap-1.5" disabled={transitionMut.isPending} onClick={() => transitionMut.mutate("approve")}>
                    <ShieldCheck className="size-4" /> {t("refa-approve")}
                  </Button>
                )}
                {d.status === "approved" && (
                  <Button size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700" onClick={() => { setPayAmount(String(d.commission_amount)); setPayOpen(true); }}>
                    <Wallet className="size-4" /> {t("refa-mark-paid")}
                  </Button>
                )}
                {d.status !== "paid" && d.status !== "cancelled" && (
                  <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => setCancelOpen(true)}>
                    <XCircle className="size-4" /> {t("refa-cancel-entry")}
                  </Button>
                )}
                {d.status !== "paid" && !d.documents_complete && (
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={docsMut.isPending} onClick={() => docsMut.mutate(true)}>
                    <Paperclip className="size-4" /> {t("refa-docs-mark-complete")}
                  </Button>
                )}
                {d.status !== "paid" && d.documents_complete && (
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={docsMut.isPending} onClick={() => docsMut.mutate(false)}>
                    <TriangleAlert className="size-4" /> {t("refa-docs-reopen")}
                  </Button>
                )}
              </div>
              {/* Gate hints */}
              {d.status === "confirmed" && (
                <div className="text-xs text-muted-foreground space-y-1">
                  {!d.agreement || d.agreement.status !== "signed" ? (
                    <p className="text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <TriangleAlert className="size-3.5" /> {t("refa-gate-agreement")}
                    </p>
                  ) : null}
                  {!d.documents_complete && (
                    <p className="text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <TriangleAlert className="size-3.5" /> {t("refa-gate-docs")}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* ── Facts grid ── */}
            <div className="grid gap-3 sm:grid-cols-2 text-sm">
              <Fact icon={Building2} label={t("refa-f-partner")} value={d.partner_name} sub={d.partner_email || undefined} />
              <Fact icon={User} label={t("refa-f-contact")} value={d.referral_contact || "—"} sub={[d.referral_email, d.referral_phone].filter(Boolean).join(" · ") || undefined} />
              <Fact icon={Package} label={t("refa-f-product")} value={d.product || "—"} sub={d.deal_value != null ? fmtMoney(d.deal_value, d.currency) : undefined} />
              <Fact icon={Hash} label={t("refa-f-ref")} value={d.ref_number || t("refa-f-ref-manual")} sub={d.ref_type} />
              <Fact icon={CircleDollarSign} label={t("refa-th-amount")} value={fmtMoney(d.commission_amount, d.currency)} sub={rateSubLabel(d, t)} />
              <Fact icon={Clock3} label={t("refa-th-status")} value={t(STATUS_META[d.status].key)} sub={
                [d.deal_done_at ? `${t("ref-step-confirmed")}: ${fmtDate(d.deal_done_at)}` : null,
                 d.approved_at ? `${t("ref-step-approved")}: ${fmtDate(d.approved_at)}` : null,
                 d.paid_at ? `${t("ref-step-paid")}: ${fmtDate(d.paid_at)}` : null].filter(Boolean).join(" · ") || undefined
              } />
            </div>

            {/* Conditions */}
            {d.conditions && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("ref-terms-title")}</p>
                <p className="text-sm whitespace-pre-wrap rounded-lg border bg-muted/30 p-3">{d.conditions}</p>
              </div>
            )}
            {d.admin_notes && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("refa-notes")}</p>
                <p className="text-sm whitespace-pre-wrap rounded-lg border bg-muted/30 p-3">{d.admin_notes}</p>
              </div>
            )}

            {/* ── Documents ── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  <Paperclip className="size-3.5" /> {t("ref-doc-title")} ({d.attachments.length})
                </p>
                <DocBadge complete={d.documents_complete} t={t} />
              </div>
              {d.attachments.length === 0 ? (
                <p className="text-xs text-muted-foreground border border-dashed rounded-lg p-3">{t("ref-doc-empty-admin")}</p>
              ) : (
                <div className="grid gap-1.5">
                  {d.attachments.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                      <FileText className="size-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate flex-1">{a.filename}</span>
                      <span className="text-[11px] text-muted-foreground">{fmtDate(a.uploaded_at)}</span>
                      <a href={`/api/portal-uploads/${a.id}/download`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground text-xs underline">
                        {t("refa-download") || "Download"}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Agreement ── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  <FileSignature className="size-3.5" /> {t("ref-tab-agreement")}
                </p>
                {d.agreement ? <AgreementMiniBadge status={d.agreement.status} signedAt={d.agreement.signed_at} t={t} /> : <span className="text-muted-foreground text-xs">—</span>}
              </div>
              {d.agreement ? (
                <div className="rounded-lg border p-3 text-sm space-y-1.5">
                  <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    <span>{t("refa-ag-version")}: <span className="text-foreground font-medium tabular-nums">{d.agreement.agreement_version}</span></span>
                    <span>{t("refa-ag-rate")}: <span className="text-foreground font-medium">{d.agreement.commission_rate != null ? `${d.agreement.commission_rate}${d.agreement.commission_type.endsWith("_percent") ? "%" : ""}` : "—"}</span></span>
                    {d.agreement.signed_at && (
                      <span>{t("refa-ag-signed-by")}: <span className="text-foreground font-medium">{d.agreement.signed_by_name} · {fmtDate(d.agreement.signed_at)} · {d.agreement.signed_version}</span></span>
                    )}
                  </div>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAgOpen(true)}>
                    <FileSignature className="size-4" /> {t("refa-ag-manage")}
                  </Button>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-3 flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">{t("refa-ag-none")}</p>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAgOpen(true)}>
                    <Plus className="size-4" /> {t("refa-ag-create")}
                  </Button>
                </div>
              )}
            </div>

            {/* ── Bank account ── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  <Landmark className="size-3.5" /> {t("ref-tab-payout")}
                </p>
                {d.payout_account ? <BankMiniBadge status={d.payout_account.status} t={t} /> : <span className="text-muted-foreground text-xs">—</span>}
              </div>
              {d.payout_account ? (
                <div className="rounded-lg border p-3 text-sm space-y-1.5">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{t("ref-bank-beneficiary")}: <span className="text-foreground font-medium">{d.payout_account.beneficiary_name}</span></span>
                    <span>IBAN: <span className="text-foreground font-mono">{d.payout_account.iban}</span></span>
                    {d.payout_account.swift_bic && <span>SWIFT: <span className="text-foreground font-mono">{d.payout_account.swift_bic}</span></span>}
                    {d.payout_account.bank_name && <span>{t("ref-bank-name")}: <span className="text-foreground">{d.payout_account.bank_name}</span></span>}
                    {d.payout_account.verified_at && <span>{t("refa-bank-verified-at")}: <span className="text-foreground">{fmtDate(d.payout_account.verified_at)}</span></span>}
                  </div>
                  {d.payout_account.status !== "verified" && (
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700" disabled={bankVerifyMut.isPending} onClick={() => bankVerifyMut.mutate("verified")}>
                        <BadgeCheck className="size-4" /> {t("refa-bank-verify")}
                      </Button>
                      <Button size="sm" variant="destructive" className="gap-1.5" disabled={bankVerifyMut.isPending} onClick={() => bankVerifyMut.mutate("rejected")}>
                        <XCircle className="size-4" /> {t("refa-bank-reject")}
                      </Button>
                    </div>
                  )}
                  {d.payout_account.additional_instructions && (
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap pt-1">{d.payout_account.additional_instructions}</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border border-dashed rounded-lg p-3">{t("refa-bank-none")}</p>
              )}
            </div>
          </div>
        ) : null}

        {/* Mark paid dialog */}
        <Dialog open={payOpen} onOpenChange={setPayOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Wallet className="size-5" /> {t("refa-pay-title")}</DialogTitle>
              <DialogDescription>{d ? `${d.referral_company} · ${fmtMoney(d.commission_amount, d.currency)}` : ""}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>{t("refa-pay-amount")}</Label>
                <Input type="number" min="0" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} className="tabular-nums" />
              </div>
              <div className="space-y-1.5">
                <Label>{t("refa-pay-reference")} *</Label>
                <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="TRX-2026-000123" className="tabular-nums" maxLength={200} />
                <p className="text-[11px] text-muted-foreground">{t("refa-pay-reference-hint")}</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPayOpen(false)}>{t("refa-cancel") || "Cancel"}</Button>
              <Button className="gap-1.5 bg-emerald-600 hover:bg-emerald-700" disabled={!payRef.trim() || payMut.isPending} onClick={() => payMut.mutate()}>
                {payMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" />} {t("refa-mark-paid")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Cancel confirm */}
        <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("refa-cancel-title")}</AlertDialogTitle>
              <AlertDialogDescription>{t("refa-cancel-body")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("refa-cancel") || "Cancel"}</AlertDialogCancel>
              <AlertDialogAction onClick={() => transitionMut.mutate("cancel")} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                {t("refa-cancel-entry")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Agreement management dialog */}
        <AgreementAdminDialog
          open={agOpen}
          onOpenChange={setAgOpen}
          partnerId={d?.partner_id || ""}
          existing={d?.agreement || null}
          onChanged={onChanged}
          api={api}
          t={t}
        />
      </SheetContent>
    </Sheet>
  );
}

function Fact({ icon: Icon, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; sub?: string;
}) {
  return (
    <div className="rounded-lg border p-3 flex items-start gap-2.5">
      <Icon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="font-medium truncate">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground whitespace-pre-line">{sub}</p>}
      </div>
    </div>
  );
}

/** "revenue % · 2.5%" — terms sub-label for the amount fact card. */
function rateSubLabel(d: DetailRow, t: (k: string) => string): string {
  const type = t("ref-type-" + d.commission_type);
  if (d.commission_rate == null) return type;
  const rate = `${d.commission_rate}${d.commission_type.endsWith("_percent") ? "%" : ""}`;
  return `${type} · ${rate}`;
}

// ─── Agreement admin dialog ────────────────────────────────────────────────

function AgreementAdminDialog({ open, onOpenChange, partnerId, existing, onChanged, api, t }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  partnerId: string;
  existing: DetailRow["agreement"];
  onChanged: () => void;
  api: (p: string, params?: Record<string, string | number | boolean | undefined>) => string;
  t: (k: string) => string;
}) {
  const [form, setForm] = useState({
    commission_type: existing?.commission_type || "revenue_percent",
    commission_rate: existing?.commission_rate != null ? String(existing.commission_rate) : "",
    commission_currency: existing?.commission_currency || "USD",
    conditions: existing?.conditions || "",
  });

  const saveMut = useMutation({
    mutationFn: async (activate: boolean) => {
      const r = await fetch(api("/api/referral-commissions/agreements"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id: partnerId,
          commission_type: form.commission_type,
          commission_rate: form.commission_rate ? Number(form.commission_rate) : null,
          commission_currency: form.commission_currency,
          conditions: form.conditions || null,
          activate,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Failed");
      return body;
    },
    onSuccess: (_d, activate) => {
      onChanged();
      onOpenChange(false);
      toast.success(activate ? t("refa-ag-activated-toast") : t("refa-ag-saved-toast"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSignature className="size-5" /> {t("refa-ag-dialog-title")}</DialogTitle>
          <DialogDescription>{t("refa-ag-dialog-desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("refa-f-type")}</Label>
              <Select value={form.commission_type} onValueChange={(v) => setForm((f) => ({ ...f, commission_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="revenue_percent">{t("ref-type-revenue_percent")}</SelectItem>
                  <SelectItem value="profit_percent">{t("ref-type-profit_percent")}</SelectItem>
                  <SelectItem value="fixed">{t("ref-type-fixed")}</SelectItem>
                  <SelectItem value="per_unit">{t("ref-type-per_unit")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-f-rate")}</Label>
              <Input type="number" min="0" step="0.01" value={form.commission_rate} onChange={(e) => setForm((f) => ({ ...f, commission_rate: e.target.value }))} className="tabular-nums" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("refa-ag-currency")}</Label>
              <Input value={form.commission_currency} onChange={(e) => setForm((f) => ({ ...f, commission_currency: e.target.value.toUpperCase() }))} maxLength={3} className="uppercase" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("refa-f-conditions")}</Label>
            <Textarea value={form.conditions} onChange={(e) => setForm((f) => ({ ...f, conditions: e.target.value }))} rows={4} maxLength={8000} placeholder={t("refa-ag-conditions-ph")} />
          </div>
          {existing?.status === "signed" && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
              <TriangleAlert className="size-4 mt-0.5 shrink-0" />
              {t("refa-ag-resign-note")}
            </div>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="gap-1.5" disabled={saveMut.isPending} onClick={() => saveMut.mutate(false)}>
            {saveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />} {t("refa-ag-save-draft") || "Save"}
          </Button>
          <Button className="gap-1.5" disabled={saveMut.isPending} onClick={() => saveMut.mutate(true)}>
            <ShieldCheck className="size-4" /> {existing?.status === "signed" ? t("refa-ag-reactivate") : t("refa-ag-activate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
