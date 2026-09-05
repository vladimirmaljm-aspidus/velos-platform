"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plus, Search, Users, Pencil, Trash2, Eye, DollarSign,
  CheckCircle2, XCircle, Clock, TrendingUp, Wallet,
  UserCheck, HandCoins, FileText, Calculator,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { ModuleInfoTooltip } from "@/components/common/module-info-tooltip";

import { EmptyState } from "@/components/common/empty-state";
import { QueryError } from "@/components/common/query-error";
import { fmtMoney, fmtDate } from "@/lib/utils/format";
import { CURRENCIES as REF_CURRENCIES } from "@/lib/data/reference";

import type { CommissionAgent, DealCommission, CommissionPayout, CommissionSummary, CommissionType, CommissionStatus } from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { PartnerPicker } from "@/components/common/partner-picker";

const COMMISSION_TYPE_LABEL_KEYS: Record<CommissionType, string> = {
  profit_percent: "fin-commission-type-profit-percent",
  revenue_percent: "fin-commission-type-revenue-percent",
  fixed: "fin-commission-type-fixed",
  per_unit: "fin-commission-type-per-unit",
  custom: "fin-commission-type-custom",
};

const COMMISSION_STATUS_LABEL_KEYS: Record<CommissionStatus, string> = {
  pending: "fin-commission-status-pending",
  approved: "fin-commission-status-approved",
  paid: "fin-commission-status-paid",
  cancelled: "fin-commission-status-cancelled",
};

const STATUS_BADGE_VARIANT: Record<CommissionStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  approved: "default",
  paid: "secondary",
  cancelled: "destructive",
};

const PAYOUT_STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  completed: "default",
  cancelled: "destructive",
};

const CURRENCIES = REF_CURRENCIES.map((c) => c.value);

/* ─── Helper hooks ────────────────────────────────────────────────────────── */

function useLocale() {
  return "en" as const;
}

function typeLabel(t: (k: string) => string, type: CommissionType) {
  return t(COMMISSION_TYPE_LABEL_KEYS[type] ?? "") || type;
}

function statusLabel(t: (k: string) => string, status: CommissionStatus) {
  return t(COMMISSION_STATUS_LABEL_KEYS[status] ?? "") || status;
}

/* ─── Main Component ──────────────────────────────────────────────────────── */

export function CommissionsView() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const qc = useQueryClient();
  const locale = useLocale();
  const t = useT();
  const [tab, setTab] = useState("agents");

  /* ── Queries ──────────────────────────────────────────────────────── */
  const agentsQ = useQuery({
    queryKey: ["commission-agents", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/commission-agents"));
      if (!r.ok) throw new Error("Failed to load agents");
      const data = await r.json();
      return (data.items || data || []) as CommissionAgent[];
    },
  });

  const dealsQ = useQuery({
    queryKey: ["deal-commissions", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/deal-commissions"));
      if (!r.ok) throw new Error("Failed to load deal commissions");
      const data = await r.json();
      return (data.items || data || []) as DealCommission[];
    },
  });

  const payoutsQ = useQuery({
    queryKey: ["commission-payouts", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/commission-payouts"));
      if (!r.ok) throw new Error("Failed to load payouts");
      const data = await r.json();
      return (data.items || data || []) as CommissionPayout[];
    },
  });

  const summariesQ = useQuery({
    queryKey: ["commission-summaries", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/commission-summaries"));
      if (!r.ok) throw new Error("Failed to load summaries");
      const data = await r.json();
      return (Array.isArray(data) ? data : data.items || []) as CommissionSummary[];
    },
  });

  const partnersQ = useQuery({
    queryKey: ["partners-list", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/partners?limit=200"));
      if (!r.ok) throw new Error("Failed to load partners");
      const data = await r.json();
      return (data.items || data) as { id: string; name: string }[];
    },
  });

  const dealsListQ = useQuery({
    queryKey: ["deals-list", tenantKey],
    queryFn: async () => {
      const r = await fetch(api("/api/deals?limit=200"));
      if (!r.ok) throw new Error("Failed to load deals");
      const data = await r.json();
      return (data.items || data) as { id: string; title: string; value: number; profit: number; quantity: number; unit: string; currency: string }[];
    },
  });

  /* ── Derived data ─────────────────────────────────────────────────── */
  const summaries = summariesQ.data || [];
  const agents = agentsQ.data || [];
  const dealCommissions = dealsQ.data || [];
  const payouts = payoutsQ.data || [];

  const totalEarned = summaries.reduce((s, x) => s + (x.total_commission || 0), 0);
  const totalPending = summaries.reduce((s, x) => s + (x.pending_commission || 0), 0);
  const totalPaid = summaries.reduce((s, x) => s + (x.paid_commission || 0), 0);
  const activeAgents = agents.filter((a) => a.active).length;

  const partnerMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of partnersQ.data || []) m.set(p.id, p.name);
    return m;
  }, [partnersQ.data]);

  /* ── Summary cards ────────────────────────────────────────────────── */
  const summaryCards = [
    { icon: TrendingUp, label: "Total Earned", value: fmtMoney(totalEarned), color: "text-emerald-600 dark:text-emerald-400" },
    { icon: Clock, label: "Pending", value: fmtMoney(totalPending), color: "text-amber-600 dark:text-amber-400" },
    { icon: CheckCircle2, label: "Paid", value: fmtMoney(totalPaid), color: "text-blue-600 dark:text-blue-400" },
    { icon: Users, label: "Active Agents", value: String(activeAgents), color: "text-violet-600 dark:text-violet-400" },
  ];

  return (
    <div>
      <PageHeader
        title={t("commissions")}
        description={t("fin-commissions-desc")}
      />
      <ModuleInfoTooltip
        title="Commissions"
        description="Manage commission agents and their payouts. Track commission per deal, approve payouts, and view summaries."
        howToUse={["Add agents and set their commission rates", "Commissions are auto-calculated per deal", "Approve pending commissions before payout", "Record payouts (atomic — prevents double-payment)", "View summaries by agent or date range"]}
      />

      {/* ── Summary Cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {summaryCards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label} className="border-border/60 shadow-soft rounded-xl">
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`size-10 rounded-lg flex items-center justify-center bg-muted/50 ${c.color}`}>
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground truncate">{c.label}</p>
                  <p className="text-lg font-semibold tabular">{c.value}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full overflow-x-auto justify-start mb-4 sm:grid sm:grid-cols-3">
          <TabsTrigger value="agents" className="gap-1.5">
            <Users className="size-4" />
            {t("commission-agents")}
          </TabsTrigger>
          <TabsTrigger value="deals" className="gap-1.5">
            <HandCoins className="size-4" />
            {t("commission-deal-commissions")}
          </TabsTrigger>
          <TabsTrigger value="payouts" className="gap-1.5">
            <Wallet className="size-4" />
            {t("commission-payouts")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          <AgentsTab
            agents={agents}
            partners={partnersQ.data || []}
            partnerMap={partnerMap}
            locale={locale}
            isLoading={agentsQ.isLoading}
            isError={agentsQ.isError}
            onRefresh={() => qc.invalidateQueries({ queryKey: ["commission-agents", tenantKey] })}
          />
        </TabsContent>

        <TabsContent value="deals">
          <DealCommissionsTab
            commissions={dealCommissions}
            agents={agents}
            partners={partnersQ.data || []}
            deals={dealsListQ.data || []}
            partnerMap={partnerMap}
            locale={locale}
            isLoading={dealsQ.isLoading}
            isError={dealsQ.isError}
            onRefresh={() => {
              qc.invalidateQueries({ queryKey: ["deal-commissions", tenantKey] });
              qc.invalidateQueries({ queryKey: ["commission-summaries", tenantKey] });
            }}
          />
        </TabsContent>

        <TabsContent value="payouts">
          <PayoutsTab
            payouts={payouts}
            agents={agents}
            dealCommissions={dealCommissions}
            partnerMap={partnerMap}
            locale={locale}
            isLoading={payoutsQ.isLoading}
            isError={payoutsQ.isError}
            onRefresh={() => {
              qc.invalidateQueries({ queryKey: ["commission-payouts", tenantKey] });
              qc.invalidateQueries({ queryKey: ["commission-summaries", tenantKey] });
              qc.invalidateQueries({ queryKey: ["deal-commissions", tenantKey] });
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab 1: Agents
   ═════════════════════════════════════════════════════════════════════════ */

function AgentsTab({
  agents, partners, partnerMap, locale, isLoading, isError, onRefresh,
}: {
  agents: CommissionAgent[];
  partners: { id: string; name: string }[];
  partnerMap: Map<string, string>;
  locale?: string;
  isLoading: boolean;
  isError: boolean;
  onRefresh: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CommissionAgent | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search) return agents;
    const q = search.toLowerCase();
    return agents.filter((a) => {
      const name = partnerMap.get(a.partner_id) || "";
      return name.toLowerCase().includes(q) || a.commission_type.toLowerCase().includes(q);
    });
  }, [agents, search, partnerMap]);

  return (
    <>
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={"Search agents…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="size-4 mr-1" />
            {"Add Agent"}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isError ? (
            <div className="p-4">
              <QueryError onRetry={onRefresh} />
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" />}
              title={"No agents"}
              description={"Add your first commission agent to get started."}
              action={
                <Button onClick={() => { setEditing(null); setShowForm(true); }}>
                  <Plus className="size-4 mr-1" />
                  {"Add Agent"}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-420px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{"Partner Name"}</TableHead>
                    <TableHead>{"Commission Type"}</TableHead>
                    <TableHead className="hidden md:table-cell">{"Rate"}</TableHead>
                    <TableHead className="hidden lg:table-cell">{"Per Unit"}</TableHead>
                    <TableHead className="hidden md:table-cell">{"Currency"}</TableHead>
                    <TableHead>{"Active"}</TableHead>
                    <TableHead className="text-right">{"Actions"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((a) => (
                    <TableRow key={a.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="font-medium">{partnerMap.get(a.partner_id) || "—"}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{typeLabel(t, a.commission_type)}</Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell tabular">
                        {a.commission_type === "profit_percent" || a.commission_type === "revenue_percent"
                          ? `${a.commission_rate}%`
                          : a.commission_type === "fixed"
                            ? fmtMoney(a.commission_rate, a.commission_currency)
                            : a.commission_rate}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell tabular">
                        {a.commission_type === "per_unit" ? fmtMoney(a.commission_per_unit, a.commission_currency) : "—"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="secondary" className="font-mono text-xs">{a.commission_currency}</Badge>
                      </TableCell>
                      <TableCell>
                        {a.active ? (
                          <Badge variant="default" className="gap-1"><CheckCircle2 className="size-3" /> {"Yes"}</Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1"><XCircle className="size-3" /> {"No"}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => { setEditing(a); setShowForm(true); }} title="Edit">
                            <Pencil className="size-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="size-8 text-destructive" onClick={() => setDeleteId(a.id)} title="Delete">
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

      {/* ── Agent Form Dialog ─────────────────────────────────────────── */}
      <AgentFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        agent={editing}
        partners={partners}
        locale={locale}
        onSaved={() => { setShowForm(false); onRefresh(); }}
      />

      {/* ── Delete Confirmation ───────────────────────────────────────── */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{"Delete agent?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {"This action cannot be undone. Related deal commissions may lose their reference."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{"Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteId) return;
                try {
                  const r = await fetch(api(`/api/commission-agents/${deleteId}`), { method: "DELETE" });
                  if (!r.ok) throw new Error();
                  toast.success("Agent deleted.");
                  onRefresh();
                } catch {
                  toast.error("Delete failed.");
                }
                setDeleteId(null);
              }}
            >
              {"Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ── Agent Form Dialog ────────────────────────────────────────────────────── */

function AgentFormDialog({
  open, onOpenChange, agent, partners, locale, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agent: CommissionAgent | null;
  partners: { id: string; name: string }[];
  locale?: string;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<Partial<CommissionAgent>>({});
  const [saving, setSaving] = useState(false);

  useMemo(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setForm(
        agent
          ? { ...agent }
          : {
              commission_type: "profit_percent" as CommissionType,
              commission_rate: 0,
              commission_per_unit: 0,
              commission_custom_formula: null,
              commission_currency: "USD",
              is_default: false,
              active: true,
              notes: null,
            },
      );
    }
  }, [open, agent]);

  function set<K extends keyof CommissionAgent>(k: K, v: CommissionAgent[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.partner_id) {
      toast.error("Select a partner.");
      return;
    }
    setSaving(true);
    try {
      const method = agent ? "PUT" : "POST";
      const url = agent ? api(`/api/commission-agents/${agent.id}`) : api("/api/commission-agents");
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success(agent ? ("Agent updated.") : ("Agent created."));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || ("Saving failed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{agent ? ("Edit Agent") : ("New Agent")}</DialogTitle>
          <DialogDescription>
            {"Configure the commission agent settings."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Partner select */}
          <div className="md:col-span-2 space-y-1.5">
            <Label>{"Partner"} *</Label>
            <PartnerPicker
              value={form.partner_id || ""}
              placeholder={"Select partner"}
              onSelect={(p) => set("partner_id", p?.id || "")}
            />
          </div>

          {/* Commission type */}
          <div className="space-y-1.5">
            <Label>{"Commission Type"}</Label>
            <Select value={form.commission_type || "profit_percent"} onValueChange={(v) => set("commission_type", v as CommissionType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(COMMISSION_TYPE_LABEL_KEYS) as CommissionType[]).map((tp) => (
                  <SelectItem key={tp} value={tp}>{typeLabel(t, tp)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Commission rate */}
          <div className="space-y-1.5">
            <Label>{"Rate"}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.commission_rate ?? 0}
              onChange={(e) => set("commission_rate", Number(e.target.value))}
            />
          </div>

          {/* Per unit — shown only when type=per_unit */}
          {form.commission_type === "per_unit" && (
            <div className="space-y-1.5">
              <Label>{"Per Unit Amount"}</Label>
              <Input
                type="number"
                step="0.01"
                value={form.commission_per_unit ?? 0}
                onChange={(e) => set("commission_per_unit", Number(e.target.value))}
              />
            </div>
          )}

          {/* Custom formula — shown only when type=custom */}
          {form.commission_type === "custom" && (
            <div className="md:col-span-2 space-y-1.5">
              <Label>{"Custom Formula"}</Label>
              <Input
                value={form.commission_custom_formula || ""}
                onChange={(e) => set("commission_custom_formula", e.target.value)}
                placeholder={"e.g. (profit * 0.03) + 500"}
              />
            </div>
          )}

          {/* Currency */}
          <div className="space-y-1.5">
            <Label>{"Currency"}</Label>
            <Select value={form.commission_currency || "USD"} onValueChange={(v) => set("commission_currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Notes */}
          <div className="md:col-span-2 space-y-1.5">
            <Label>{"Notes"}</Label>
            <Textarea
              rows={3}
              value={form.notes || ""}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>

          {/* Toggles */}
          <div className="md:col-span-2 flex items-center gap-3 p-3 rounded-md bg-muted/30">
            <Switch checked={!!form.is_default} onCheckedChange={(v) => set("is_default", v)} aria-label="Is Default" />
            <div>
              <p className="text-sm font-medium">{"Is Default"}</p>
              <p className="text-xs text-muted-foreground">
                {"Auto-apply to new deals with this partner"}
              </p>
            </div>
          </div>

          <div className="md:col-span-2 flex items-center gap-3 p-3 rounded-md bg-muted/30">
            <Switch checked={!!form.active} onCheckedChange={(v) => set("active", v)} aria-label="Active" />
            <div>
              <p className="text-sm font-medium">{"Active"}</p>
              <p className="text-xs text-muted-foreground">
                {"Enable this commission agent"}
              </p>
            </div>
          </div>
        </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{"Cancel"}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? ("Saving…") : ("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab 2: Deal Commissions
   ═════════════════════════════════════════════════════════════════════════ */

function DealCommissionsTab({
  commissions, agents, partners, deals, partnerMap, locale, isLoading, isError, onRefresh,
}: {
  commissions: DealCommission[];
  agents: CommissionAgent[];
  partners: { id: string; name: string }[];
  deals: { id: string; title: string; value: number; profit: number; quantity: number; unit: string; currency: string }[];
  partnerMap: Map<string, string>;
  locale?: string;
  isLoading: boolean;
  isError: boolean;
  onRefresh: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = commissions;
    if (statusFilter !== "all") {
      result = result.filter((c) => c.status === statusFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = partnerMap.get(c.partner_id) || "";
        return name.toLowerCase().includes(q) || c.deal_id.toLowerCase().includes(q);
      });
    }
    return result;
  }, [commissions, search, statusFilter, partnerMap]);

  const detailCommission = useMemo(() => {
    if (!detailId) return null;
    return commissions.find((c) => c.id === detailId) || null;
  }, [detailId, commissions]);

  return (
    <>
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder={"Search by agent…"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-44">
              <SelectValue placeholder={"Status"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{"All statuses"}</SelectItem>
              {(Object.keys(COMMISSION_STATUS_LABEL_KEYS) as CommissionStatus[]).map((s) => (
                <SelectItem key={s} value={s}>{statusLabel(t, s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setShowForm(true)}>
            <Plus className="size-4 mr-1" />
            {"Add Commission"}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isError ? (
            <div className="p-4">
              <QueryError onRetry={onRefresh} />
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<HandCoins className="size-6" />}
              title={"No commissions"}
              description={"Add your first deal commission."}
              action={
                <Button onClick={() => setShowForm(true)}>
                  <Plus className="size-4 mr-1" />
                  {"Add Commission"}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-420px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{"Deal"}</TableHead>
                    <TableHead>{"Agent"}</TableHead>
                    <TableHead className="hidden md:table-cell">{"Type"}</TableHead>
                    <TableHead className="hidden lg:table-cell">{"Rate"}</TableHead>
                    <TableHead className="hidden lg:table-cell">{"Deal Value"}</TableHead>
                    <TableHead className="hidden xl:table-cell">{"Deal Profit"}</TableHead>
                    <TableHead>{"Commission"}</TableHead>
                    <TableHead>{"Status"}</TableHead>
                    <TableHead className="text-right">{"Actions"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((c) => (
                    <TableRow key={c.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="font-medium font-mono text-xs truncate max-w-[100px]">{c.deal_id}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{partnerMap.get(c.partner_id) || "—"}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="text-xs">{typeLabel(t, c.commission_type)}</Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell tabular">
                        {c.commission_type === "profit_percent" || c.commission_type === "revenue_percent"
                          ? `${c.commission_rate}%`
                          : c.commission_rate}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell tabular text-sm">
                        {fmtMoney(c.deal_value, c.commission_currency)}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell tabular text-sm">
                        {fmtMoney(c.deal_profit, c.commission_currency)}
                      </TableCell>
                      <TableCell className="tabular font-semibold">
                        {fmtMoney(c.calculated_commission, c.commission_currency)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => setDetailId(c.id)} title="View">
                            <Eye className="size-4" />
                          </Button>
                          {c.status === "pending" && (
                            <Button size="icon" variant="ghost" className="size-8 text-blue-600" onClick={() => approveCommission(c.id, onRefresh, api)} title="Approve">
                              <CheckCircle2 className="size-4" />
                            </Button>
                          )}
                          {c.status === "approved" && (
                            <Button size="icon" variant="ghost" className="size-8 text-emerald-600" onClick={() => markPaidCommission(c.id, onRefresh, api)} title="Mark as Paid">
                              <DollarSign className="size-4" />
                            </Button>
                          )}
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

      {/* ── Add Commission Dialog ─────────────────────────────────────── */}
      <AddCommissionDialog
        open={showForm}
        onOpenChange={setShowForm}
        agents={agents}
        partners={partners}
        deals={deals}
        partnerMap={partnerMap}
        locale={locale}
        onSaved={() => { setShowForm(false); onRefresh(); }}
      />

      {/* ── Detail Sheet ──────────────────────────────────────────────── */}
      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto custom-scroll">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="size-5" />
              {"Commission Details"}
            </SheetTitle>
            <SheetDescription>{"Deal commission overview"}</SheetDescription>
          </SheetHeader>
          {detailCommission ? (
            <CommissionDetail commission={detailCommission} partnerMap={partnerMap} locale={locale} />
          ) : (
            <div className="p-4 space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/* ── Status Badge ─────────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: CommissionStatus }) {
  const t = useT();
  const iconMap: Record<CommissionStatus, React.ReactNode> = {
    pending: <Clock className="size-3" />,
    approved: <CheckCircle2 className="size-3" />,
    paid: <DollarSign className="size-3" />,
    cancelled: <XCircle className="size-3" />,
  };
  return (
    <Badge variant={STATUS_BADGE_VARIANT[status]} className="gap-1">
      {iconMap[status]}
      {statusLabel(t, status)}
    </Badge>
  );
}

/* ── Commission Detail Panel ──────────────────────────────────────────────── */

function CommissionDetail({
  commission, partnerMap, locale,
}: {
  commission: DealCommission;
  partnerMap: Map<string, string>;
  locale?: string;
}) {
  const t = useT();
  const rows = [
    { label: "Agent", value: partnerMap.get(commission.partner_id) || "—" },
    { label: "Commission Type", value: typeLabel(t, commission.commission_type) },
    { label: "Rate", value: `${commission.commission_rate}` },
    { label: "Deal Value", value: fmtMoney(commission.deal_value, commission.commission_currency) },
    { label: "Deal Profit", value: fmtMoney(commission.deal_profit, commission.commission_currency) },
    { label: "Quantity", value: `${commission.deal_quantity} ${commission.deal_unit}` },
    { label: "Calculated Commission", value: fmtMoney(commission.calculated_commission, commission.commission_currency) },
    { label: "Status", value: statusLabel(t, commission.status) },
    { label: "Approved By", value: commission.approved_by || "—" },
    { label: "Approved At", value: commission.approved_at ? fmtDate(commission.approved_at) : "—" },
    { label: "Paid At", value: commission.paid_at ? fmtDate(commission.paid_at) : "—" },
    { label: "Payout Reference", value: commission.payout_reference || "—" },
    { label: "Created", value: fmtDate(commission.created_at) },
    { label: "Updated", value: fmtDate(commission.updated_at) },
  ];

  return (
    <div className="px-4 pb-6">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <StatusBadge status={commission.status} />
        <Badge variant="outline" className="font-mono text-xs">{commission.commission_currency}</Badge>
      </div>

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between p-2 rounded-md hover:bg-muted/30">
            <p className="text-xs text-muted-foreground">{r.label}</p>
            <p className="text-sm font-medium text-right">{r.value}</p>
          </div>
        ))}
      </div>

      {commission.notes && (
        <div className="mt-4 pt-4 border-t">
          <p className="text-xs text-muted-foreground mb-1">{"Notes"}</p>
          <p className="text-sm whitespace-pre-wrap p-3 rounded-md bg-muted/50">{commission.notes}</p>
        </div>
      )}
    </div>
  );
}

/* ── Add Commission Dialog ────────────────────────────────────────────────── */

function AddCommissionDialog({
  open, onOpenChange, agents, partners, deals, partnerMap, locale, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agents: CommissionAgent[];
  partners: { id: string; name: string }[];
  deals: { id: string; title: string; value: number; profit: number; quantity: number; unit: string; currency: string }[];
  partnerMap: Map<string, string>;
  locale?: string;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [form, setForm] = useState<Partial<DealCommission>>({});
  const [saving, setSaving] = useState(false);

  useMemo(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setForm({
        commission_type: "profit_percent" as CommissionType,
        commission_rate: 0,
        commission_per_unit: 0,
        commission_custom_formula: null,
        commission_currency: "USD",
        deal_value: 0,
        deal_profit: 0,
        deal_quantity: 0,
        deal_unit: "",
        calculated_commission: 0,
        status: "pending" as CommissionStatus,
        notes: null,
      });
    }
  }, [open]);

  function set<K extends keyof DealCommission>(k: K, v: DealCommission[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  /* When agent selected, auto-fill from agent settings */
  function handleAgentChange(agentId: string) {
    const agent = agents.find((a) => a.id === agentId);
    if (agent) {
      setForm((f) => ({
        ...f,
        agent_id: agent.id,
        partner_id: agent.partner_id,
        commission_type: agent.commission_type,
        commission_rate: agent.commission_rate,
        commission_per_unit: agent.commission_per_unit,
        commission_custom_formula: agent.commission_custom_formula,
        commission_currency: agent.commission_currency,
      }));
    } else {
      setForm((f) => ({ ...f, agent_id: agentId }));
    }
  }

  /* When deal selected, auto-fill from deal data */
  function handleDealChange(dealId: string) {
    const deal = deals.find((d) => d.id === dealId);
    if (deal) {
      setForm((f) => ({
        ...f,
        deal_id: deal.id,
        deal_value: deal.value,
        deal_profit: deal.profit,
        deal_quantity: deal.quantity,
        deal_unit: deal.unit,
        commission_currency: deal.currency,
      }));
    } else {
      setForm((f) => ({ ...f, deal_id: dealId }));
    }
  }

  /* Calculate preview */
  const preview = useMemo(() => {
    const type = form.commission_type;
    const rate = form.commission_rate || 0;
    const dealValue = form.deal_value || 0;
    const dealProfit = form.deal_profit || 0;
    const dealQty = form.deal_quantity || 0;
    const perUnit = form.commission_per_unit || 0;

    if (type === "profit_percent") return dealProfit * (rate / 100);
    if (type === "revenue_percent") return dealValue * (rate / 100);
    if (type === "fixed") return rate;
    if (type === "per_unit") return dealQty * perUnit;
    return 0; // custom requires server-side
  }, [form.commission_type, form.commission_rate, form.deal_value, form.deal_profit, form.deal_quantity, form.commission_per_unit]);

  async function save() {
    if (!form.agent_id || !form.deal_id) {
      toast.error("Select an agent and a deal.");
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, calculated_commission: preview };
      const r = await fetch(api("/api/deal-commissions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success("Commission created.");
      onSaved();
    } catch (e: any) {
      toast.error(e.message || ("Saving failed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{"New Deal Commission"}</DialogTitle>
          <DialogDescription>
            {"Link a deal to a commission agent."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Agent select */}
          <div className="space-y-1.5">
            <Label>{"Agent"} *</Label>
            <Select value={form.agent_id || ""} onValueChange={handleAgentChange}>
              <SelectTrigger><SelectValue placeholder={"Select agent"} /></SelectTrigger>
              <SelectContent>
                {agents.filter((a) => a.active).map((a) => (
                  <SelectItem key={a.id} value={a.id}>{partnerMap.get(a.partner_id) || a.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Deal select */}
          <div className="space-y-1.5">
            <Label>{"Deal"} *</Label>
            <Select value={form.deal_id || ""} onValueChange={handleDealChange}>
              <SelectTrigger><SelectValue placeholder={"Select deal"} /></SelectTrigger>
              <SelectContent>
                {deals.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Commission type (auto-filled) */}
          <div className="space-y-1.5">
            <Label>{"Commission Type"}</Label>
            <Select value={form.commission_type || "profit_percent"} onValueChange={(v) => set("commission_type", v as CommissionType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(COMMISSION_TYPE_LABEL_KEYS) as CommissionType[]).map((tp) => (
                  <SelectItem key={tp} value={tp}>{typeLabel(t, tp)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Rate */}
          <div className="space-y-1.5">
            <Label>{"Rate"}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.commission_rate ?? 0}
              onChange={(e) => set("commission_rate", Number(e.target.value))}
            />
          </div>

          {/* Per unit — conditional */}
          {form.commission_type === "per_unit" && (
            <div className="space-y-1.5">
              <Label>{"Per Unit Amount"}</Label>
              <Input
                type="number"
                step="0.01"
                value={form.commission_per_unit ?? 0}
                onChange={(e) => set("commission_per_unit", Number(e.target.value))}
              />
            </div>
          )}

          {/* Custom formula — conditional */}
          {form.commission_type === "custom" && (
            <div className="md:col-span-2 space-y-1.5">
              <Label>{"Custom Formula"}</Label>
              <Input
                value={form.commission_custom_formula || ""}
                onChange={(e) => set("commission_custom_formula", e.target.value)}
              />
            </div>
          )}

          {/* Currency */}
          <div className="space-y-1.5">
            <Label>{"Currency"}</Label>
            <Select value={form.commission_currency || "USD"} onValueChange={(v) => set("commission_currency", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Notes */}
          <div className="md:col-span-2 space-y-1.5">
            <Label>{"Notes"}</Label>
            <Textarea
              rows={2}
              value={form.notes || ""}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>

          {/* Preview */}
          <div className="md:col-span-2 p-3 rounded-lg bg-muted/30 border border-border/60">
            <div className="flex items-center gap-2 mb-2">
              <Calculator className="size-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium">{"Calculated Commission Preview"}</span>
            </div>
            <p className="text-xl font-semibold tabular">
              {fmtMoney(preview, form.commission_currency || "USD")}
            </p>
            <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
              <p>{"Deal Value"}: {fmtMoney(form.deal_value || 0, form.commission_currency || "USD")}</p>
              <p>{"Deal Profit"}: {fmtMoney(form.deal_profit || 0, form.commission_currency || "USD")}</p>
              <p>{"Quantity"}: {form.deal_quantity || 0} {form.deal_unit || ""}</p>
            </div>
          </div>
        </div>

        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{"Cancel"}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? ("Saving…") : ("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Approve / Mark Paid helpers ──────────────────────────────────────────── */

async function approveCommission(id: string, onRefresh: () => void, api: (path: string) => string) {
  try {
    const r = await fetch(api(`/api/deal-commissions/${id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    if (!r.ok) throw new Error();
    toast.success("Commission approved.");
    onRefresh();
  } catch {
    toast.error("Approval failed.");
  }
}

async function markPaidCommission(id: string, onRefresh: () => void, api: (path: string) => string) {
  try {
    const r = await fetch(api(`/api/deal-commissions/${id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_paid" }),
    });
    if (!r.ok) throw new Error();
    toast.success("Commission marked as paid.");
    onRefresh();
  } catch {
    toast.error("Mark as paid failed.");
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tab 3: Payouts
   ═════════════════════════════════════════════════════════════════════════ */

function PayoutsTab({
  payouts, agents, dealCommissions, partnerMap, locale, isLoading, isError, onRefresh,
}: {
  payouts: CommissionPayout[];
  agents: CommissionAgent[];
  dealCommissions: DealCommission[];
  partnerMap: Map<string, string>;
  locale?: string;
  isLoading: boolean;
  isError: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  const [showForm, setShowForm] = useState(false);

  return (
    <>
      <Card className="mb-4 border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-3 flex flex-col md:flex-row gap-2 justify-end">
          <Button onClick={() => setShowForm(true)}>
            <Plus className="size-4 mr-1" />
            {"Create Payout"}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="p-0">
          {isError ? (
            <div className="p-4">
              <QueryError onRetry={onRefresh} />
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : payouts.length === 0 ? (
            <EmptyState
              icon={<Wallet className="size-6" />}
              title={"No payouts"}
              description={"Create your first commission payout."}
              action={
                <Button onClick={() => setShowForm(true)}>
                  <Plus className="size-4 mr-1" />
                  {"Create Payout"}
                </Button>
              }
            />
          ) : (
            <div className="max-h-[calc(100vh-420px)] overflow-y-auto custom-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>{"Agent"}</TableHead>
                    <TableHead>{"Amount"}</TableHead>
                    <TableHead className="hidden md:table-cell">{"Currency"}</TableHead>
                    <TableHead className="hidden lg:table-cell">{"Payment Method"}</TableHead>
                    <TableHead className="hidden lg:table-cell">{"Reference"}</TableHead>
                    <TableHead>{"Status"}</TableHead>
                    <TableHead className="hidden xl:table-cell">{"Date"}</TableHead>
                    <TableHead className="text-right">{"Actions"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payouts.map((p) => (
                    <TableRow key={p.id} className="hover:bg-muted/50 transition-colors">
                      <TableCell>
                        <div className="font-medium">{partnerMap.get(p.partner_id) || "—"}</div>
                      </TableCell>
                      <TableCell className="tabular font-semibold">
                        {fmtMoney(p.total_amount, p.currency)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="secondary" className="font-mono text-xs">{p.currency}</Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm">
                        {p.payment_method || "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm font-mono">
                        {p.payment_reference || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={PAYOUT_STATUS_BADGE[p.status] || "outline"} className="gap-1">
                          {p.status === "completed" && <CheckCircle2 className="size-3" />}
                          {p.status === "pending" && <Clock className="size-3" />}
                          {p.status === "cancelled" && <XCircle className="size-3" />}
                          {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-sm">
                        {p.paid_at ? fmtDate(p.paid_at) : fmtDate(p.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-8" onClick={() => {
                            toast.info(`${"Commissions in payout"}: ${p.commission_ids?.length || 0}`);
                          }} title="View details">
                            <Eye className="size-4" />
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

      {/* ── Create Payout Dialog ──────────────────────────────────────── */}
      <CreatePayoutDialog
        open={showForm}
        onOpenChange={setShowForm}
        agents={agents}
        dealCommissions={dealCommissions}
        partnerMap={partnerMap}
        locale={locale}
        onSaved={() => { setShowForm(false); onRefresh(); }}
      />
    </>
  );
}

/* ── Create Payout Dialog ─────────────────────────────────────────────────── */

function CreatePayoutDialog({
  open, onOpenChange, agents, dealCommissions, partnerMap, locale, onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agents: CommissionAgent[];
  dealCommissions: DealCommission[];
  partnerMap: Map<string, string>;
  locale?: string;
  onSaved: () => void;
}) {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedCommissionIds, setSelectedCommissionIds] = useState<Set<string>>(new Set());
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  /* Reset on open */
  useMemo(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setSelectedAgentId("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setSelectedCommissionIds(new Set());
// eslint-disable-next-line react-hooks/set-state-in-render
      setPaymentMethod("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setPaymentReference("");
// eslint-disable-next-line react-hooks/set-state-in-render
      setNotes("");
    }
  }, [open]);

  /* Pending commissions for selected agent */
  const pendingCommissions = useMemo(() => {
    if (!selectedAgentId) return [];
    return dealCommissions.filter(
      (c) => c.agent_id === selectedAgentId && c.status === "approved",
    );
  }, [selectedAgentId, dealCommissions]);

  const selectedAgent = useMemo(() => {
    return agents.find((a) => a.id === selectedAgentId) || null;
  }, [selectedAgentId, agents]);

  /* Auto-select all when agent changes */
  useMemo(() => {
    if (selectedAgentId) {
// eslint-disable-next-line react-hooks/set-state-in-render
      setSelectedCommissionIds(new Set(pendingCommissions.map((c) => c.id)));
    } else {
// eslint-disable-next-line react-hooks/set-state-in-render
      setSelectedCommissionIds(new Set());
    }
  }, [selectedAgentId, pendingCommissions]);

  /* Total amount */
  const totalAmount = useMemo(() => {
    return pendingCommissions
      .filter((c) => selectedCommissionIds.has(c.id))
      .reduce((sum, c) => sum + c.calculated_commission, 0);
  }, [pendingCommissions, selectedCommissionIds]);

  const currency = selectedAgent?.commission_currency || "USD";

  function toggleCommission(id: string) {
    setSelectedCommissionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!selectedAgentId) {
      toast.error("Select an agent.");
      return;
    }
    if (selectedCommissionIds.size === 0) {
      toast.error("Select at least one commission.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        agent_id: selectedAgentId,
        partner_id: selectedAgent?.partner_id,
        total_amount: totalAmount,
        currency,
        commission_ids: Array.from(selectedCommissionIds),
        payment_method: paymentMethod || null,
        payment_reference: paymentReference || null,
        notes: notes || null,
        // This dialog issues a completed payout — the selected commissions
        // are marked paid immediately (no separate "pending payout" stage).
        status: "completed",
      };
      const r = await fetch(api("/api/commission-payouts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Request failed");
      }
      toast.success("Payout created.");
      onSaved();
    } catch (e: any) {
      toast.error(e.message || ("Saving failed."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{"Create Payout"}</DialogTitle>
          <DialogDescription>
            {"Create a commission payout for an agent."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Agent select */}
          <div className="md:col-span-2 space-y-1.5">
            <Label>{"Agent"} *</Label>
            <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
              <SelectTrigger><SelectValue placeholder={"Select agent"} /></SelectTrigger>
              <SelectContent>
                {agents.filter((a) => a.active).map((a) => (
                  <SelectItem key={a.id} value={a.id}>{partnerMap.get(a.partner_id) || a.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Pending commissions list */}
          {selectedAgentId && (
            <div className="md:col-span-2 space-y-1.5">
              <Label>{"Approved Commissions"} ({pendingCommissions.length})</Label>
              {pendingCommissions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {"No approved commissions for this agent."}
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto custom-scroll border border-border/60 rounded-lg divide-y divide-border/60">
                  {pendingCommissions.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-3 p-2.5 hover:bg-muted/30 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedCommissionIds.has(c.id)}
                        onCheckedChange={() => toggleCommission(c.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium truncate">{c.deal_id}</span>
                          <span className="text-sm font-semibold tabular ml-2">
                            {fmtMoney(c.calculated_commission, c.commission_currency)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {typeLabel(t, c.commission_type)} · {fmtMoney(c.deal_value, c.commission_currency)}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Total amount */}
          <div className="md:col-span-2 p-3 rounded-lg bg-muted/30 border border-border/60">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{"Total Amount"}</span>
              <span className="text-xl font-semibold tabular">{fmtMoney(totalAmount, currency)}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {selectedCommissionIds.size} {"commission(s)"} {"selected"}
            </p>
          </div>

          {/* Payment method */}
          <div className="space-y-1.5">
            <Label>{"Payment Method"}</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger><SelectValue placeholder={"Select"} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bank_transfer">{"Bank Transfer"}</SelectItem>
                <SelectItem value="cash">{"Cash"}</SelectItem>
                <SelectItem value="check">{"Check"}</SelectItem>
                <SelectItem value="other">{"Other"}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Payment reference */}
          <div className="space-y-1.5">
            <Label>{"Payment Reference"}</Label>
            <Input
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder={"e.g. 2024-001"}
            />
          </div>

          {/* Notes */}
          <div className="md:col-span-2 space-y-1.5">
            <Label>{"Notes"}</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{"Cancel"}</Button>
          <Button onClick={save} disabled={saving || selectedCommissionIds.size === 0}>
            {saving ? ("Saving…") : ("Create Payout")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
