"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  HandCoins, FileSignature, Landmark, Wallet, CheckCircle2, Clock3, CircleDollarSign,
  Building2, User, Mail, Phone, Package, Hash, Paperclip, Loader2, ChevronDown,
  ShieldCheck, FileText, Upload, Download, BadgeCheck, XCircle, AlertTriangle, Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import { fmtDate, fmtMoney } from "@/lib/utils/format";

// ─── API payload types (client view of the 097 tables) ─────────────────────

interface ReferralAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  category: string;
  uploaded_at: string;
}

type CommissionStatus = "pending" | "confirmed" | "approved" | "paid" | "cancelled";

interface ReferralCommissionItem {
  id: string;
  referral_company: string;
  referral_contact: string | null;
  referral_email: string | null;
  referral_phone: string | null;
  ref_type: string;
  ref_number: string | null;
  product: string | null;
  deal_value: number | null;
  currency: string;
  commission_type: string;
  commission_rate: number | null;
  commission_amount: number;
  conditions: string | null;
  status: CommissionStatus;
  deal_done: boolean;
  deal_done_at: string | null;
  documents_complete: boolean;
  approved_at: string | null;
  paid_at: string | null;
  payout_reference: string | null;
  paid_amount: number | null;
  created_at: string;
  attachments: ReferralAttachment[];
}

interface PublicAgreement {
  id: string;
  status: "pending_signature" | "signed" | "suspended" | "terminated";
  commission_type: string;
  commission_rate: number | null;
  commission_currency: string;
  conditions: string | null;
  agreement_version: string;
  activated_at: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  signed_version: string | null;
}

interface PublicAccount {
  id: string;
  status: "submitted" | "verified" | "rejected";
  beneficiary_name: string;
  bank_name: string | null;
  iban: string;
  iban_masked: string;
  swift_bic: string | null;
  account_currency: string | null;
  country: string | null;
  additional_instructions: string | null;
  verified_at: string | null;
  updated_at: string;
}

interface ReferralsPayload {
  items: ReferralCommissionItem[];
  stats: {
    total_entries: number;
    total_commission: number;
    paid_commission: number;
    approved_commission: number;
    pending_commission: number;
    currency: string;
  };
  agreement: PublicAgreement | null;
  payout_account: PublicAccount | null;
}

// ─── Status helpers ────────────────────────────────────────────────────────

const STATUS_META: Record<CommissionStatus, { key: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending: { key: "ref-status-pending", className: "border-slate-400/40 bg-slate-400/10 text-slate-600 dark:text-slate-300", icon: Clock3 },
  confirmed: { key: "ref-status-confirmed", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400", icon: CheckCircle2 },
  approved: { key: "ref-status-approved", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: CircleDollarSign },
  paid: { key: "ref-status-paid", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", icon: BadgeCheck },
  cancelled: { key: "ref-status-cancelled", className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400", icon: XCircle },
};

const STEPS: { status: CommissionStatus; key: string }[] = [
  { status: "pending", key: "ref-step-recorded" },
  { status: "confirmed", key: "ref-step-confirmed" },
  { status: "approved", key: "ref-step-approved" },
  { status: "paid", key: "ref-step-paid" },
];
const STEP_INDEX: Record<CommissionStatus, number> = { pending: 0, confirmed: 1, approved: 2, paid: 3, cancelled: -1 };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function PortalReferrals() {
  const t = useT();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery<ReferralsPayload, Error>({
    queryKey: ["portal-referrals"],
    queryFn: async () => {
      const r = await fetch("/api/portal/referrals", { cache: "no-store" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load commissions.");
      }
      return r.json() as Promise<ReferralsPayload>;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["portal-referrals"] });

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground gap-2">
        <Loader2 className="size-5 animate-spin" /> {t("ref-loading") || "Loading…"}
      </div>
    );
  }
  if (q.isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-10 text-center space-y-3">
          <AlertTriangle className="size-8 mx-auto text-destructive" />
          <p className="text-sm text-muted-foreground">{(q.error as Error).message}</p>
          <Button variant="outline" size="sm" onClick={() => q.refetch()}>{t("ref-retry") || "Retry"}</Button>
        </CardContent>
      </Card>
    );
  }

  const data = q.data!;
  const stats = data.stats;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="size-11 rounded-xl bg-gradient-to-br from-amber-500/20 to-emerald-500/20 border border-amber-500/30 flex items-center justify-center">
            <HandCoins className="size-6 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("ref-portal-title")}</h1>
            <p className="text-sm text-muted-foreground">{t("ref-portal-subtitle")}</p>
          </div>
        </div>
        {/* Status chips */}
        <div className="flex flex-wrap items-center gap-2">
          <AgreementChip agreement={data.agreement} t={t} />
          <BankChip account={data.payout_account} t={t} />
        </div>
      </div>

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <KpiCard icon={CircleDollarSign} label={t("ref-kpi-total")} value={fmtMoney(stats.total_commission, stats.currency)} tone="slate" />
        <KpiCard icon={BadgeCheck} label={t("ref-kpi-paid")} value={fmtMoney(stats.paid_commission, stats.currency)} tone="emerald" />
        <KpiCard icon={Wallet} label={t("ref-kpi-approved")} value={fmtMoney(stats.approved_commission, stats.currency)} tone="amber" />
        <KpiCard icon={Clock3} label={t("ref-kpi-pending")} value={fmtMoney(stats.pending_commission, stats.currency)} tone="sky" />
      </div>

      {/* ── Tabs ── */}
      <Tabs defaultValue="deals" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 max-w-xl">
          <TabsTrigger value="deals" className="gap-1.5"><Package className="size-4" /> {t("ref-tab-deals")}</TabsTrigger>
          <TabsTrigger value="agreement" className="gap-1.5"><FileSignature className="size-4" /> {t("ref-tab-agreement")}</TabsTrigger>
          <TabsTrigger value="payout" className="gap-1.5"><Landmark className="size-4" /> {t("ref-tab-payout")}</TabsTrigger>
        </TabsList>

        <TabsContent value="deals" className="space-y-3">
          {data.items.length === 0 ? (
            <EmptyPanel icon={Package} title={t("ref-deals-empty-title")} body={t("ref-deals-empty-body")} />
          ) : (
            data.items.map((item) => (
              <CommissionCard
                key={item.id}
                item={item}
                t={t}
                expanded={expanded === item.id}
                onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
                onChanged={invalidate}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="agreement" className="space-y-4">
          <AgreementPanel agreement={data.agreement} t={t} onSigned={invalidate} />
        </TabsContent>

        <TabsContent value="payout" className="space-y-4">
          <PayoutPanel account={data.payout_account} t={t} onSaved={invalidate} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "slate" | "emerald" | "amber" | "sky";
}) {
  const tones: Record<string, string> = {
    slate: "text-slate-600 dark:text-slate-300 bg-slate-500/10",
    emerald: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
    amber: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
    sky: "text-sky-600 dark:text-sky-400 bg-sky-500/10",
  };
  return (
    <Card className="border-border/60 shadow-soft">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn("size-9 rounded-lg flex items-center justify-center shrink-0", tones[tone])}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-lg font-semibold tabular-nums leading-tight truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AgreementChip({ agreement, t }: { agreement: PublicAgreement | null; t: (k: string) => string }) {
  if (!agreement) {
    return (
      <Badge variant="outline" className="gap-1.5 bg-muted/50"><Info className="size-3.5" /> {t("ref-chip-no-agreement")}</Badge>
    );
  }
  if (agreement.status === "signed") {
    return (
      <Badge variant="outline" className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <ShieldCheck className="size-3.5" /> {t("ref-chip-agreement-signed")} · {fmtDate(agreement.signed_at)}
      </Badge>
    );
  }
  if (agreement.status === "pending_signature") {
    return (
      <Badge variant="outline" className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
        <FileSignature className="size-3.5" /> {t("ref-chip-agreement-awaiting")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 bg-muted/50"><XCircle className="size-3.5" /> {t("ref-chip-agreement-" + agreement.status)}</Badge>
  );
}

function BankChip({ account, t }: { account: PublicAccount | null; t: (k: string) => string }) {
  if (!account) {
    return (
      <Badge variant="outline" className="gap-1.5 bg-muted/50"><Landmark className="size-3.5" /> {t("ref-chip-no-bank")}</Badge>
    );
  }
  const cls =
    account.status === "verified" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : account.status === "rejected" ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
    : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return (
    <Badge variant="outline" className={cn("gap-1.5", cls)}>
      <Landmark className="size-3.5" /> {t("ref-chip-bank-" + account.status)} · {account.iban_masked}
    </Badge>
  );
}

function EmptyPanel({ icon: Icon, title, body }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-12 flex flex-col items-center text-center gap-2">
        <div className="size-12 rounded-full bg-muted flex items-center justify-center">
          <Icon className="size-6 text-muted-foreground" />
        </div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground max-w-md">{body}</p>
      </CardContent>
    </Card>
  );
}

/** One commission entry: summary + expandable detail (conditions, timeline, documents). */
function CommissionCard({ item, t, expanded, onToggle, onChanged }: {
  item: ReferralCommissionItem;
  t: (k: string) => string;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const st = STATUS_META[item.status];
  const StatusIcon = st.icon;
  const stepIdx = STEP_INDEX[item.status];

  return (
    <Card className={cn("border-border/60 shadow-soft overflow-hidden transition-colors", expanded && "border-border")}>
      <CardContent className="p-0">
        {/* Summary row */}
        <button
          type="button"
          onClick={onToggle}
          className="w-full text-left p-4 hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={expanded}
        >
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold truncate">{item.referral_company}</span>
                {item.ref_number && (
                  <Badge variant="outline" className="text-[11px] tabular-nums"><Hash className="size-3" />{item.ref_number}</Badge>
                )}
              </div>
              {item.referral_contact && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <User className="size-3.5 shrink-0" /> {item.referral_contact}
                  {item.referral_email && <><Mail className="size-3.5 shrink-0 ml-2" /> {item.referral_email}</>}
                  {item.referral_phone && <><Phone className="size-3.5 shrink-0 ml-2" /> {item.referral_phone}</>}
                </p>
              )}
              {item.product && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Package className="size-3.5 shrink-0" /> {item.product}
                  {item.deal_value != null && <span className="tabular-nums">· {fmtMoney(item.deal_value, item.currency)}</span>}
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <p className={cn("font-bold tabular-nums text-base",
                item.status === "paid" ? "text-emerald-600 dark:text-emerald-400" : item.status === "cancelled" ? "line-through text-muted-foreground" : "")}>
                {fmtMoney(item.commission_amount, item.currency)}
              </p>
              <Badge variant="outline" className={cn("gap-1", st.className)}>
                <StatusIcon className="size-3.5" /> {t(st.key)}
              </Badge>
            </div>
            <ChevronDown className={cn("size-4 text-muted-foreground shrink-0 mt-1 transition-transform", expanded && "rotate-180")} />
          </div>
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="border-t bg-muted/20 p-4 space-y-5">
            {/* Timeline */}
            <Timeline item={item} stepIdx={stepIdx} t={t} />

            {/* Terms */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <FileText className="size-3.5" /> {t("ref-terms-title")}
              </p>
              <div className="rounded-lg border bg-background p-3 text-sm space-y-1">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span>{t("ref-terms-type")}: <span className="text-foreground font-medium">{t("ref-type-" + item.commission_type)}</span></span>
                  {item.commission_rate != null && (
                    <span>{t("ref-terms-rate")}: <span className="text-foreground font-medium tabular-nums">
                      {item.commission_type.endsWith("_percent") ? `${item.commission_rate}%` : fmtMoney(item.commission_rate, item.currency)}
                    </span></span>
                  )}
                  <span>{t("ref-terms-recorded")}: <span className="text-foreground font-medium">{fmtDate(item.created_at)}</span></span>
                  {item.approved_at && <span>{t("ref-terms-approved")}: <span className="text-foreground font-medium">{fmtDate(item.approved_at)}</span></span>}
                  {item.paid_at && <span>{t("ref-terms-paid")}: <span className="text-foreground font-medium">{fmtDate(item.paid_at)}</span></span>}
                  {item.paid_at && item.payout_reference && <span>{t("ref-terms-reference")}: <span className="text-foreground font-medium tabular-nums">{item.payout_reference}</span></span>}
                  {item.paid_at && item.paid_amount != null && (
                    <span>{t("ref-terms-paid-amount")}: <span className="text-foreground font-medium tabular-nums">{fmtMoney(item.paid_amount, item.currency)}</span></span>
                  )}
                </div>
                {item.conditions && <p className="text-sm pt-2 whitespace-pre-wrap">{item.conditions}</p>}
              </div>
            </div>

            {/* Documents */}
            <DocumentsSection item={item} t={t} onChanged={onChanged} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Timeline({ item, stepIdx, t }: { item: ReferralCommissionItem; stepIdx: number; t: (k: string) => string }) {
  const dates: Record<string, string | null> = {
    pending: item.created_at,
    confirmed: item.deal_done_at,
    approved: item.approved_at,
    paid: item.paid_at,
  };
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">{t("ref-timeline-title")}</p>
      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const done = stepIdx >= i;
          const isCurrent = stepIdx === i;
          return (
            <div key={step.status} className={cn("flex items-center", i < STEPS.length - 1 && "flex-1")}>
              <div className="flex flex-col items-center gap-1 min-w-0">
                <div className={cn(
                  "size-7 rounded-full border flex items-center justify-center shrink-0 transition-colors",
                  done ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "border-border bg-muted text-muted-foreground",
                  isCurrent && "ring-2 ring-emerald-500/20 ring-offset-2 ring-offset-background",
                )}>
                  {done ? <CheckCircle2 className="size-4" /> : <div className="size-2 rounded-full bg-current opacity-40" />}
                </div>
                <p className={cn("text-[10px] font-medium text-center leading-tight max-w-[80px]", done ? "text-foreground" : "text-muted-foreground")}>
                  {t(step.key)}
                </p>
                {dates[step.status] && <p className="text-[9px] text-muted-foreground tabular-nums">{fmtDate(dates[step.status])}</p>}
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn("h-0.5 flex-1 mx-1 mb-5", stepIdx > i ? "bg-emerald-500/40" : "bg-border")} />
              )}
            </div>
          );
        })}
      </div>
      {item.status === "cancelled" && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
          <XCircle className="size-3.5" /> {t("ref-status-cancelled-note")}
        </p>
      )}
    </div>
  );
}

/** Upload + list of documents for one commission entry. */
function DocumentsSection({ item, t, onChanged }: {
  item: ReferralCommissionItem;
  t: (k: string) => string;
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const closed = item.status === "paid";

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        if (file.size > 25 * 1024 * 1024) {
          toast.error(`${file.name}: ${t("ref-doc-too-large") || "max 25MB"}`);
          continue;
        }
        const fd = new FormData();
        fd.append("file", file);
        fd.append("category", "commission");
        fd.append("doc_type", "referral_commission");
        fd.append("description", (item.referral_company || "Commission").slice(0, 120));
        const up = await fetch("/api/portal/upload", { method: "POST", body: fd });
        if (!up.ok) {
          const e = await up.json().catch(() => ({}));
          throw new Error(e.error || "upload failed");
        }
        const row = await up.json();
        const link = await fetch("/api/portal/referrals/attachments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referral_id: item.id, attachment_ids: [row.id] }),
        });
        if (!link.ok) {
          const e = await link.json().catch(() => ({}));
          throw new Error(e.error || "link failed");
        }
      }
      toast.success(t("ref-doc-uploaded"));
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Paperclip className="size-3.5" /> {t("ref-doc-title")}
          {item.documents_complete && (
            <Badge variant="outline" className="ml-2 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 gap-1 text-[10px]">
              <CheckCircle2 className="size-3" /> {t("ref-doc-confirmed")}
            </Badge>
          )}
        </p>
        {!closed && (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} {t("ref-doc-upload")}
          </Button>
        )}
      </div>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
      {item.attachments.length === 0 ? (
        <p className="text-xs text-muted-foreground rounded-lg border border-dashed p-3">{t("ref-doc-empty")}</p>
      ) : (
        <div className="grid gap-1.5">
          {item.attachments.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
              <FileText className="size-4 text-muted-foreground shrink-0" />
              <span className="text-sm truncate flex-1">{a.filename}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">{fmtBytes(a.size_bytes)}</span>
              <a href={`/api/portal/attachments/${a.id}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                <Download className="size-4" />
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agreement panel ───────────────────────────────────────────────────────

function AgreementPanel({ agreement, t, onSigned }: {
  agreement: PublicAgreement | null;
  t: (k: string) => string;
  onSigned: () => void;
}) {
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const signMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/portal/referrals/agreement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typed_name: typedName, consent }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Sign failed");
      return body;
    },
    onSuccess: () => {
      toast.success(t("ref-sign-success"));
      onSigned();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!agreement) {
    return <EmptyPanel icon={FileSignature} title={t("ref-ag-empty-title")} body={t("ref-ag-empty-body")} />;
  }

  if (agreement.status === "signed") {
    return (
      <Card className="border-emerald-500/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" /> {t("ref-ag-signed-title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-full border-2 border-emerald-500/50 bg-emerald-500/10 flex items-center justify-center font-serif italic text-emerald-700 dark:text-emerald-400 text-lg">
                {(agreement.signed_by_name || "?").trim().charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="font-serif italic text-lg leading-tight">{agreement.signed_by_name}</p>
                <p className="text-xs text-muted-foreground">{t("ref-ag-signed-at")} {fmtDate(agreement.signed_at)} · {agreement.signed_version}</p>
              </div>
            </div>
          </div>
          <AgreementText agreement={agreement} t={t} />
        </CardContent>
      </Card>
    );
  }

  if (agreement.status !== "pending_signature") {
    return <EmptyPanel icon={Info} title={t("ref-ag-inactive-title")} body={t("ref-ag-inactive-body-" + agreement.status) || t("ref-ag-inactive-body")} />;
  }

  // Pending signature — full document + signature form.
  const canSign = typedName.trim().length >= 3 && consent && !signMut.isPending;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileSignature className="size-5 text-amber-600 dark:text-amber-400" /> {t("ref-ag-title")}
          <Badge variant="outline" className="ml-1 tabular-nums text-[11px]">{agreement.agreement_version}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <AgreementText agreement={agreement} t={t} />

        <Separator />

        {/* Signature form */}
        <div className="space-y-3">
          <p className="text-sm font-medium">{t("ref-sign-form-title")}</p>
          <div className="space-y-1.5">
            <Label htmlFor="ref-typed-name">{t("ref-sign-typed-name")}</Label>
            <Input
              id="ref-typed-name"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={t("ref-sign-name-placeholder")}
              maxLength={200}
              autoComplete="name"
            />
            <p className="text-[11px] text-muted-foreground">{t("ref-sign-name-hint")}</p>
          </div>
          <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
            <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
            <span className="text-sm leading-relaxed">{t("ref-sign-consent")}</span>
          </label>
          <Button className="w-full gap-2" disabled={!canSign} onClick={() => signMut.mutate()}>
            {signMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileSignature className="size-4" />}
            {t("ref-sign-button")}
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">{t("ref-sign-legal-note")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** The rendered agreement terms (both before and after signing). */
function AgreementText({ agreement, t }: { agreement: PublicAgreement; t: (k: string) => string }) {
  const rateLabel =
    agreement.commission_rate != null
      ? agreement.commission_type.endsWith("_percent")
        ? `${agreement.commission_rate}%`
        : fmtMoney(agreement.commission_rate, agreement.commission_currency)
      : null;
  return (
    <div className="rounded-xl border bg-background p-5 space-y-4 text-sm leading-relaxed">
      <div className="space-y-1">
        <p className="font-semibold">{t("ref-ag-doc-title")}</p>
        <p className="text-xs text-muted-foreground">{t("ref-ag-doc-version")} {agreement.agreement_version} · {t("ref-ag-doc-activated")} {fmtDate(agreement.activated_at)}</p>
      </div>
      <Separator />
      <section className="space-y-1">
        <p className="font-medium">{t("ref-ag-s1-title")}</p>
        <p className="text-muted-foreground">{t("ref-ag-s1-body")}</p>
      </section>
      <section className="space-y-1">
        <p className="font-medium">{t("ref-ag-s2-title")}</p>
        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
          <li>{t("ref-ag-s2-l1")}</li>
          <li>{t("ref-ag-s2-l2")}</li>
          <li>{t("ref-ag-s2-l3")}</li>
        </ul>
      </section>
      <section className="space-y-1">
        <p className="font-medium">{t("ref-ag-s3-title")}</p>
        <p className="text-muted-foreground">
          {t("ref-ag-s3-body")}
          {rateLabel && <span className="font-semibold text-foreground"> {rateLabel} </span>}
          {rateLabel && <span>({t("ref-type-" + agreement.commission_type)})</span>}
        </p>
      </section>
      <section className="space-y-1">
        <p className="font-medium">{t("ref-ag-s4-title")}</p>
        <p className="text-muted-foreground">{t("ref-ag-s4-body")}</p>
      </section>
      <section className="space-y-1">
        <p className="font-medium">{t("ref-ag-s5-title")}</p>
        <p className="text-muted-foreground">{t("ref-ag-s5-body")}</p>
      </section>
      <section className="space-y-1">
        <p className="font-medium">{t("ref-ag-s6-title")}</p>
        <p className="text-muted-foreground">{t("ref-ag-s6-body")}</p>
      </section>
      {agreement.conditions && (
        <section className="space-y-1">
          <p className="font-medium">{t("ref-ag-custom-title")}</p>
          <p className="whitespace-pre-wrap text-muted-foreground rounded-lg bg-muted/40 border p-3">{agreement.conditions}</p>
        </section>
      )}
    </div>
  );
}

// ─── Payout panel ──────────────────────────────────────────────────────────

function PayoutPanel({ account, t, onSaved }: {
  account: PublicAccount | null;
  t: (k: string) => string;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    beneficiary_name: account?.beneficiary_name || "",
    bank_name: account?.bank_name || "",
    iban: account?.iban || "",
    swift_bic: account?.swift_bic || "",
    account_currency: account?.account_currency || "",
    country: account?.country || "",
    additional_instructions: account?.additional_instructions || "",
  });
  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/portal/referrals/bank-account", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Save failed");
      return body;
    },
    onSuccess: () => {
      toast.success(t("ref-bank-saved"));
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const statusBanner =
    account?.status === "verified" ? (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <BadgeCheck className="size-4 mt-0.5 shrink-0" /> {t("ref-bank-verified-note")}
      </div>
    ) : account?.status === "rejected" ? (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 flex items-start gap-2 text-sm text-rose-700 dark:text-rose-400">
        <XCircle className="size-4 mt-0.5 shrink-0" /> {t("ref-bank-rejected-note")}
      </div>
    ) : account ? (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
        <Clock3 className="size-4 mt-0.5 shrink-0" /> {t("ref-bank-submitted-note")}
      </div>
    ) : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="size-5" /> {t("ref-bank-title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {statusBanner}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ref-beneficiary">{t("ref-bank-beneficiary")} *</Label>
            <Input id="ref-beneficiary" value={form.beneficiary_name} onChange={set("beneficiary_name")} maxLength={200} placeholder={t("ref-bank-beneficiary-ph")} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ref-iban">{t("ref-bank-iban")} *</Label>
            <Input id="ref-iban" value={form.iban} onChange={set("iban")} maxLength={42} placeholder="DE89 3704 0044 0532 0130 00" className="uppercase tabular-nums font-mono" autoComplete="off" />
            <p className="text-[11px] text-muted-foreground">{t("ref-bank-iban-hint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-bank-name">{t("ref-bank-name")}</Label>
            <Input id="ref-bank-name" value={form.bank_name} onChange={set("bank_name")} maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-swift">{t("ref-bank-swift")}</Label>
            <Input id="ref-swift" value={form.swift_bic} onChange={set("swift_bic")} maxLength={11} placeholder="DEUTDEFF" className="uppercase font-mono" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-bank-currency">{t("ref-bank-currency")}</Label>
            <Input id="ref-bank-currency" value={form.account_currency} onChange={set("account_currency")} maxLength={3} placeholder="EUR" className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-bank-country">{t("ref-bank-country")}</Label>
            <Input id="ref-bank-country" value={form.country} onChange={set("country")} maxLength={60} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ref-bank-notes">{t("ref-bank-notes")}</Label>
            <Textarea id="ref-bank-notes" value={form.additional_instructions} onChange={set("additional_instructions")} maxLength={500} rows={2} placeholder={t("ref-bank-notes-ph")} />
          </div>
        </div>
        <Button className="gap-2" disabled={saveMut.isPending || form.beneficiary_name.trim().length < 2 || form.iban.replace(/\s+/g, "").length < 15} onClick={() => saveMut.mutate()}>
          {saveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Building2 className="size-4" />}
          {account ? t("ref-bank-update") : t("ref-bank-save")}
        </Button>
        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
          <ShieldCheck className="size-3.5 mt-0.5 shrink-0" /> {t("ref-bank-security-note")}
        </p>
      </CardContent>
    </Card>
  );
}
