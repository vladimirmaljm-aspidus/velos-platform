"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Plus, Search, Pencil, Trash2, Eye, MoreHorizontal, Wallet, TrendingUp, TrendingDown,
  PieChart, BookOpen, ArrowRightLeft, Landmark, FileBarChart, Settings2,
  CheckCircle2, RotateCcw, XCircle, ChevronRight, Download, Building2, Calendar,
  Hash, RefreshCw, Repeat,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { KpiCard } from "@/components/common/kpi-card";
import { fmtMoney, fmtDate } from "@/lib/utils/format";
import { CURRENCIES as REF_CURRENCIES } from "@/lib/data/reference";
import type {
  ErpAccount, ErpJournalEntry, ErpJournalLine, ErpBankAccount,
  ErpBankTransaction, ErpSetting, TrialBalance, BalanceSheet,
  ProfitAndLoss, GeneralLedger, TrialBalanceItem, BalanceSheetItem,
  GeneralLedgerEntry, FxRevaluationAdjustment,
} from "@/lib/supabase/types";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";

/* ─── i18n helpers ─────────────────────────────────────────────────────── */

// Maps the internal label keys used throughout this view to the i18n keys
// (mix of `fin-*` finance-domain keys, `fin-erp-*` keys added for this view,
// and shared `erp-*` keys from the UI dictionary). Any key not present here
// falls through to `t(key)` so callers can also pass i18n keys directly.
const ERP_LABEL_KEYS: Record<string, string> = {
  title: "fin-erp-title",
  description: "fin-erp-description",
  dashboard: "erp-dashboard",
  "chart-of-accounts": "erp-chart-of-accounts",
  "journal-entries": "fin-erp-journal-entries",
  "general-ledger": "erp-general-ledger",
  "bank-accounts": "erp-bank-accounts",
  "bank-transactions": "fin-erp-bank-transactions",
  "cost-centers": "fin-erp-cost-centers",
  "fiscal-periods": "fin-erp-fiscal-periods",
  reports: "fin-erp-reports",
  settings: "erp-settings",
  "total-assets": "erp-total-assets",
  "total-revenue": "erp-total-revenue",
  "total-expenses": "erp-total-expenses",
  "net-profit": "erp-net-profit",
  "recent-journal-entries": "fin-erp-recent-entries",
  "quick-actions": "fin-quick-actions-label",
  "new-journal-entry": "erp-quick-new-entry",
  "initialize-chart": "erp-initialize",
  "view-reports": "erp-quick-view-reports",
  code: "fin-code",
  name: "name",
  type: "type",
  category: "fin-category",
  standard: "fin-standard",
  active: "active",
  actions: "actions",
  "add-account": "fin-add-account",
  "edit-account": "fin-edit-account",
  "delete-account": "fin-delete-account",
  "delete-account-confirm": "fin-delete-account-confirm",
  "account-code": "erp-account-code",
  "account-name": "erp-account-name",
  "name-en": "fin-name-en",
  "account-type": "erp-account-type",
  "account-category": "erp-account-category",
  "parent-account": "erp-account-parent",
  "tax-code": "fin-tax-code",
  "description-label": "description",
  "is-active": "active",
  "initialize-eu": "fin-erp-initialize-eu",
  "initialize-uae": "fin-erp-initialize-uae",
  "initialize-desc": "erp-initialize-desc",
  "entry-number": "erp-entry-number",
  date: "date",
  reference: "erp-reference",
  status: "status",
  "debit-total": "erp-debit-total",
  "credit-total": "erp-credit-total",
  "add-entry": "erp-quick-new-entry",
  "edit-entry": "fin-edit-entry",
  "post-entry": "erp-post",
  "reverse-entry": "erp-reverse",
  "entry-date": "date",
  "entry-description": "description",
  "reference-type": "fin-reference-type",
  "reference-id": "fin-reference-id-field",
  currency: "fin-currency",
  notes: "fin-notes",
  lines: "fin-lines",
  account: "fin-account",
  debit: "erp-debit",
  credit: "erp-credit",
  "line-description": "fin-line-description",
  "add-line": "fin-add-line",
  "remove-line": "fin-remove-line",
  "balance-validation": "erp-lines-must-balance",
  "balanced": "fin-balanced",
  "not-balanced": "fin-not-balanced",
  draft: "erp-draft",
  posted: "erp-posted",
  reversed: "erp-reversed",
  cancelled: "erp-cancelled",
  "select-account": "fin-select-account",
  "date-from": "fin-date-from",
  "date-to": "fin-date-to",
  "running-balance": "fin-running-balance",
  "bank-name": "erp-bank-name",
  "account-number": "erp-account-number",
  iban: "erp-iban",
  "swift-bic": "erp-swift",
  balance: "erp-bank-balance",
  "add-bank-account": "fin-add-bank-account",
  "edit-bank-account": "fin-edit-bank-account",
  "linked-account": "fin-linked-account",
  transactions: "fin-transactions",
  amount: "amount",
  "transaction-type": "fin-transaction-type",
  counterparty: "fin-counterparty",
  reconciled: "erp-reconciled",
  "add-transaction": "fin-add-transaction",
  "trial-balance": "erp-trial-balance",
  "balance-sheet": "erp-balance-sheet",
  "profit-and-loss": "erp-profit-loss",
  "as-of-date": "erp-as-of-date",
  "period-start": "erp-period-start",
  "period-end": "erp-period-end",
  "generate-report": "fin-erp-generate-report",
  "export-report": "fin-export-report",
  "total-debit": "fin-total-debit-inline",
  "total-credit": "fin-total-credit-inline",
  assets: "fin-assets",
  liabilities: "fin-liabilities",
  equity: "erp-equity",
  revenue: "erp-revenue",
  expenses: "fin-expenses",
  "net-profit-loss": "fin-net-profit-loss",
  "accounting-standard": "erp-accounting-standard",
  "fiscal-year-start": "erp-fiscal-year-start",
  "fiscal-year-end": "erp-fiscal-year-end",
  "default-currency": "erp-default-currency",
  "vat-enabled": "erp-vat-enabled",
  "vat-rate": "fin-erp-vat-rate-percent",
  "vat-return-period": "erp-vat-return-period",
  "auto-post-journal": "fin-erp-auto-post-journal",
  "default-accounts": "erp-default-accounts",
  "revenue-account": "erp-revenue-account",
  "expense-account": "erp-expense-account",
  "receivable-account": "erp-receivable-account",
  "payable-account": "erp-payable-account",
  "vat-account": "erp-vat-account",
  "bank-charges-account": "erp-bank-charges-account",
  "cash-account": "erp-cash-account",
  "retention-account": "erp-retention-account",
  "round-off-account": "erp-round-off-account",
  "save-settings": "fin-save-settings",
  "no-accounts": "fin-no-accounts",
  "no-entries": "fin-no-entries",
  "no-bank-accounts": "fin-no-bank-accounts",
  "no-transactions": "fin-no-transactions",
  "no-report-data": "fin-no-report-data",
  "no-ledger-data": "fin-no-ledger-data",
  "view-entry": "fin-erp-view-entry",
  "gl-account": "fin-gl-account",
  "entry-detail": "fin-entry-detail",
};

function useErpLabel() {
  const t = useT();
  return useCallback((key: string) => t(ERP_LABEL_KEYS[key] ?? key), [t]);
}

/* ─── Constants ─────────────────────────────────────────────────────────── */

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
const ACCOUNT_CATEGORIES = [
  "current_asset", "fixed_asset", "intangible_asset", "current_liability", "long_term_liability",
  "share_capital", "retained_earnings", "current_earnings", "reserve",
  "operating_revenue", "other_revenue", "cost_of_sales", "operating_expense",
  "other_expense", "tax",
] as const;
const REFERENCE_TYPES = ["manual", "deal", "invoice", "proforma", "commission", "bank"] as const;
const CURRENCIES = REF_CURRENCIES.map((c) => c.value);
const VAT_RETURN_PERIODS = ["monthly", "quarterly", "yearly"] as const;

const ACCOUNT_TYPE_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  asset: "default",
  liability: "destructive",
  equity: "secondary",
  revenue: "outline",
  expense: "outline",
};

const ACCOUNT_TYPE_COLOR: Record<string, string> = {
  asset: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  liability: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  equity: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  revenue: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  expense: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

const STATUS_BADGE: Record<string, { className: string; key: string }> = {
  draft: { className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300", key: "erp-draft" },
  posted: { className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300", key: "erp-posted" },
  reversed: { className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300", key: "erp-reversed" },
  cancelled: { className: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300", key: "erp-cancelled" },
};

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface JournalLineForm {
  account_id: string;
  description: string;
  debit: number;
  credit: number;
  // E-2 (multi-currency ERP): per-line currency + FX rate. Falls back to
  // the entry-level currency / exchange_rate when undefined (the RPC
  // does the same server-side).
  currency: string;
  fx_rate: number;
}

interface JournalEntryForm {
  date: string;
  description: string;
  reference_type: string;
  reference_id: string;
  currency: string;
  notes: string;
  lines: JournalLineForm[];
}

// E-2 (multi-currency ERP) — form state for the FX Revaluation dialog.
interface FxRevalForm {
  reval_date: string;
  base_currency: string;
  adjustments: FxRevalAdjForm[];
}

interface FxRevalAdjForm {
  account_id: string;
  currency: string;
  fx_rate_old: number;
  fx_rate_new: number;
  balance_foreign: number;
  gain_loss_account_id: string;
  description: string;
}

interface AccountForm {
  id?: string;
  code: string;
  name: string;
  name_en: string;
  account_type: string;
  account_category: string;
  parent_id: string;
  tax_code: string;
  description: string;
  is_active: boolean;
}

interface BankAccountForm {
  id?: string;
  bank_name: string;
  account_number: string;
  iban: string;
  swift_bic: string;
  currency: string;
  balance: number;
  account_id: string;
  is_active: boolean;
}

interface BankTransactionForm {
  bank_account_id: string;
  date: string;
  amount: number;
  transaction_type: string;
  description: string;
  reference: string;
  counterparty: string;
  counterparty_account: string;
}

interface SettingsForm {
  accounting_standard: string;
  fiscal_year_start: string;
  fiscal_year_end: string;
  default_currency: string;
  vat_enabled: boolean;
  vat_rate: number;
  vat_return_period: string;
  auto_post_journal: boolean;
  revenue_account_id: string;
  expense_account_id: string;
  receivable_account_id: string;
  payable_account_id: string;
  vat_account_id: string;
  bank_charges_account_id: string;
  cash_account_id: string;
  retention_account_id: string;
  round_off_account_id: string;
}

const emptyJournalEntry: JournalEntryForm = {
  date: new Date().toISOString().split("T")[0],
  description: "",
  reference_type: "manual",
  reference_id: "",
  currency: "EUR",
  notes: "",
  lines: [{ account_id: "", description: "", debit: 0, credit: 0, currency: "EUR", fx_rate: 1 }],
};

// E-2 (multi-currency ERP) — empty form for the FX Revaluation dialog.
const emptyFxReval: FxRevalForm = {
  reval_date: new Date().toISOString().split("T")[0],
  base_currency: "USD",
  adjustments: [],
};

const emptyFxRevalAdj: FxRevalAdjForm = {
  account_id: "",
  currency: "EUR",
  fx_rate_old: 1,
  fx_rate_new: 1,
  balance_foreign: 0,
  gain_loss_account_id: "",
  description: "",
};

const emptyAccount: AccountForm = {
  code: "", name: "", name_en: "", account_type: "asset", account_category: "",
  parent_id: "", tax_code: "", description: "", is_active: true,
};

const emptyBankAccount: BankAccountForm = {
  bank_name: "", account_number: "", iban: "", swift_bic: "",
  currency: "EUR", balance: 0, account_id: "", is_active: true,
};

const emptyBankTransaction: BankTransactionForm = {
  bank_account_id: "", date: new Date().toISOString().split("T")[0],
  amount: 0, transaction_type: "credit", description: "",
  reference: "", counterparty: "", counterparty_account: "",
};

const emptySettings: SettingsForm = {
  accounting_standard: "eu", fiscal_year_start: "01-01", fiscal_year_end: "12-31",
  default_currency: "EUR", vat_enabled: true, vat_rate: 20,
  vat_return_period: "quarterly", auto_post_journal: false,
  revenue_account_id: "", expense_account_id: "", receivable_account_id: "",
  payable_account_id: "", vat_account_id: "", bank_charges_account_id: "",
  cash_account_id: "", retention_account_id: "", round_off_account_id: "",
};

/* ─── Scrollbar styling ─────────────────────────────────────────────────── */

const scrollbarStyle = "max-h-96 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border";

/* ─── Main Component ────────────────────────────────────────────────────── */

export function ErpView() {
  const lbl = useErpLabel();
  const [activeTab, setActiveTab] = useState("dashboard");

  return (
    <div className="space-y-6">
      <PageHeader
        title={lbl("title")}
        description={lbl("description")}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="w-full overflow-x-auto">
          <TabsList className="mb-4 flex w-max min-w-full gap-1">
            <TabsTrigger value="dashboard" className="gap-2"><Wallet className="size-4" />{lbl("dashboard")}</TabsTrigger>
            <TabsTrigger value="accounts" className="gap-2"><BookOpen className="size-4" />{lbl("chart-of-accounts")}</TabsTrigger>
            <TabsTrigger value="journal" className="gap-2"><ArrowRightLeft className="size-4" />{lbl("journal-entries")}</TabsTrigger>
            <TabsTrigger value="ledger" className="gap-2"><PieChart className="size-4" />{lbl("general-ledger")}</TabsTrigger>
            <TabsTrigger value="bank" className="gap-2"><Landmark className="size-4" />{lbl("bank-accounts")}</TabsTrigger>
            <TabsTrigger value="reports" className="gap-2"><FileBarChart className="size-4" />{lbl("reports")}</TabsTrigger>
            <TabsTrigger value="settings" className="gap-2"><Settings2 className="size-4" />{lbl("settings")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="dashboard"><ErpDashboard /></TabsContent>
        <TabsContent value="accounts"><ChartOfAccounts /></TabsContent>
        <TabsContent value="journal"><JournalEntries /></TabsContent>
        <TabsContent value="ledger"><GeneralLedger /></TabsContent>
        <TabsContent value="bank"><BankAccounts /></TabsContent>
        <TabsContent value="reports"><ErpReports /></TabsContent>
        <TabsContent value="settings"><ErpSettings /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. ERP DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */

function ErpDashboard() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const qc = useQueryClient();

  const accountsQ = useQuery({
    queryKey: ["erp-accounts", tenantKey],
    queryFn: () => fetch(api("/api/erp/accounts")).then((r) => r.json()),
  });

  const entriesQ = useQuery({
    queryKey: ["erp-journal-entries", tenantKey],
    queryFn: () => fetch(api("/api/erp/journal-entries")).then((r) => r.json()),
  });

  const initMutation = useMutation({
    mutationFn: (standard: string) =>
      fetch(api("/api/erp/initialize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ standard }),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-chart-initialized"));
      qc.invalidateQueries({ queryKey: ["erp-accounts", tenantKey] });
      qc.invalidateQueries({ queryKey: ["erp-settings", tenantKey] });
    },
    onError: () => toast.error(lbl("fin-failed-initialize")),
  });

  const accounts: ErpAccount[] = accountsQ.data?.items ?? accountsQ.data ?? [];
  const entries: ErpJournalEntry[] = entriesQ.data?.items ?? entriesQ.data ?? [];

  // Compute KPIs
  const totalAssets = useMemo(() => {
    const assetAccounts = accounts.filter((a) => a.account_type === "asset");
    return assetAccounts.reduce((sum, a) => sum + 0, 0); // placeholder until we have real balances
  }, [accounts]);

  const totalRevenue = useMemo(() => {
    const postedEntries = entries.filter((e) => e.status === "posted");
    return postedEntries.reduce((sum, e) => sum + (e.credit_total || 0), 0);
  }, [entries]);

  const totalExpenses = useMemo(() => {
    const postedEntries = entries.filter((e) => e.status === "posted");
    return postedEntries.reduce((sum, e) => sum + (e.debit_total || 0), 0);
  }, [entries]);

  const netProfit = totalRevenue - totalExpenses;

  const recentEntries = entries.slice(0, 10);

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={lbl("total-assets")}
          value={fmtMoney(totalAssets, "EUR")}
          icon={Wallet}
          variant="default"
        />
        <KpiCard
          label={lbl("total-revenue")}
          value={fmtMoney(totalRevenue, "EUR")}
          icon={TrendingUp}
          variant="positive"
        />
        <KpiCard
          label={lbl("total-expenses")}
          value={fmtMoney(totalExpenses, "EUR")}
          icon={TrendingDown}
          variant="negative"
        />
        <KpiCard
          label={lbl("net-profit")}
          value={fmtMoney(netProfit, "EUR")}
          icon={PieChart}
          variant={netProfit >= 0 ? "positive" : "negative"}
        />
      </div>

      {/* Recent Journal Entries */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{lbl("recent-journal-entries")}</CardTitle>
        </CardHeader>
        <CardContent>
          {recentEntries.length === 0 ? (
            <EmptyState
              icon={<BookOpen />}
              title={lbl("no-entries")}
              action={
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => initMutation.mutate("eu")}>
                    <Plus className="size-4 mr-2" />{lbl("initialize-chart")}
                  </Button>
                </div>
              }
            />
          ) : (
            <div className={scrollbarStyle}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{lbl("entry-number")}</TableHead>
                    <TableHead>{lbl("date")}</TableHead>
                    <TableHead>{lbl("description")}</TableHead>
                    <TableHead>{lbl("status")}</TableHead>
                    <TableHead className="text-right">{lbl("debit-total")}</TableHead>
                    <TableHead className="text-right">{lbl("credit-total")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-mono font-medium">{entry.entry_number}</TableCell>
                      <TableCell>{fmtDate(entry.date)}</TableCell>
                      <TableCell className="max-w-[200px]">{entry.description}</TableCell>
                      <TableCell>
                        <Badge className={STATUS_BADGE[entry.status]?.className ?? ""}>
                          {lbl(STATUS_BADGE[entry.status]?.key ?? "")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(entry.debit_total, entry.currency)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(entry.credit_total, entry.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{lbl("quick-actions")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => {
              // Switch to journal tab and trigger new entry
              const event = new CustomEvent("erp-new-entry");
              window.dispatchEvent(event);
            }}>
              <ArrowRightLeft className="size-4 mr-2" />{lbl("new-journal-entry")}
            </Button>
            <Button variant="outline" onClick={() => initMutation.mutate("eu")} disabled={initMutation.isPending}>
              <RefreshCw className={`size-4 mr-2 ${initMutation.isPending ? "animate-spin" : ""}`} />{lbl("initialize-eu")}
            </Button>
            <Button variant="outline" onClick={() => initMutation.mutate("uae")} disabled={initMutation.isPending}>
              <RefreshCw className={`size-4 mr-2 ${initMutation.isPending ? "animate-spin" : ""}`} />{lbl("initialize-uae")}
            </Button>
            <Button variant="outline" onClick={() => {
              const event = new CustomEvent("erp-goto-reports");
              window.dispatchEvent(event);
            }}>
              <FileBarChart className="size-4 mr-2" />{lbl("view-reports")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. CHART OF ACCOUNTS
   ═══════════════════════════════════════════════════════════════════════════ */

function ChartOfAccounts() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editAccount, setEditAccount] = useState<ErpAccount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ErpAccount | null>(null);
  const [showInitDialog, setShowInitDialog] = useState(false);
  const [form, setForm] = useState<AccountForm>(emptyAccount);

  const accountsQ = useQuery({
    queryKey: ["erp-accounts", tenantKey, filterType],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterType !== "all") params.set("account_type", filterType);
      if (search) params.set("search", search);
      return fetch(api(`/api/erp/accounts?${params}`)).then((r) => r.json());
    },
  });

  const accounts: ErpAccount[] = accountsQ.data?.items ?? accountsQ.data ?? [];

  const saveMutation = useMutation({
    mutationFn: (data: AccountForm) =>
      fetch(api("/api/erp/accounts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl(editAccount ? "fin-account-updated" : "fin-account-created"));
      qc.invalidateQueries({ queryKey: ["erp-accounts", tenantKey] });
      setShowAddDialog(false);
      setEditAccount(null);
      setForm(emptyAccount);
    },
    onError: () => toast.error(lbl("fin-failed-save-account")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(api(`/api/erp/accounts/${id}`), { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-account-deleted"));
      qc.invalidateQueries({ queryKey: ["erp-accounts", tenantKey] });
      setDeleteTarget(null);
    },
    onError: () => toast.error(lbl("fin-failed-delete-account")),
  });

  const initMutation = useMutation({
    mutationFn: (standard: string) =>
      fetch(api("/api/erp/initialize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ standard }),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-chart-initialized"));
      qc.invalidateQueries({ queryKey: ["erp-accounts", tenantKey] });
      setShowInitDialog(false);
    },
    onError: () => toast.error(lbl("fin-failed-initialize-short")),
  });

  function openEdit(account: ErpAccount) {
    setEditAccount(account);
    setForm({
      id: account.id,
      code: account.code,
      name: account.name,
      name_en: account.name_en ?? "",
      account_type: account.account_type,
      account_category: account.account_category ?? "",
      parent_id: account.parent_id ?? "",
      tax_code: account.tax_code ?? "",
      description: account.description ?? "",
      is_active: account.is_active,
    });
    setShowAddDialog(true);
  }

  function openAdd() {
    setEditAccount(null);
    setForm(emptyAccount);
    setShowAddDialog(true);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={lbl("fin-search-accounts-placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-64"
            />
          </div>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{lbl("fin-all-types")}</SelectItem>
              {ACCOUNT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowInitDialog(true)}>
            <RefreshCw className="size-4 mr-2" />{lbl("initialize-chart")}
          </Button>
          <Button onClick={openAdd}>
            <Plus className="size-4 mr-2" />{lbl("add-account")}
          </Button>
        </div>
      </div>

      {/* Table */}
      {accountsQ.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={lbl("no-accounts")}
          action={
            <Button onClick={() => setShowInitDialog(true)}>
              <RefreshCw className="size-4 mr-2" />{lbl("initialize-chart")}
            </Button>
          }
        />
      ) : (
        <div className={scrollbarStyle}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{lbl("code")}</TableHead>
                <TableHead>{lbl("name")}</TableHead>
                <TableHead>{lbl("type")}</TableHead>
                <TableHead>{lbl("category")}</TableHead>
                <TableHead>{lbl("standard")}</TableHead>
                <TableHead>{lbl("active")}</TableHead>
                <TableHead className="text-right">{lbl("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => (
                <TableRow key={account.id}>
                  <TableCell className="font-mono font-semibold">{account.code}</TableCell>
                  <TableCell>
                    <div>
                      <span className="font-medium">{account.name}</span>
                      {account.name_en && (
                        <span className="text-muted-foreground text-xs ml-2">({account.name_en})</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={ACCOUNT_TYPE_COLOR[account.account_type] ?? ""}>
                      {account.account_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {account.account_category?.replace(/_/g, " ") ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="uppercase text-xs">{account.standard ?? "—"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={account.is_active ? "default" : "secondary"}>
                      {account.is_active ? lbl("active") : lbl("inactive")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(account)} title={lbl("edit")} aria-label={lbl("edit")}>
                        <Pencil className="size-4" />
                      </Button>
                      {!account.is_system && (
                        <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(account)} title={lbl("delete")} aria-label={lbl("delete")}>
                          <Trash2 className="size-4 text-destructive" />
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

      {/* Add/Edit Account Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>{editAccount ? lbl("edit-account") : lbl("add-account")}</DialogTitle>
            <DialogDescription>
              {editAccount ? lbl("fin-update-account-desc") : lbl("fin-create-account-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-4">
            <div className="space-y-2">
              <Label>{lbl("account-code")}</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={lbl("fin-erp-account-code-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("account-name")}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={lbl("fin-erp-account-name-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("name-en")}</Label>
              <Input value={form.name_en} onChange={(e) => setForm({ ...form, name_en: e.target.value })} placeholder={lbl("fin-erp-english-name-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("account-type")}</Label>
              <Select value={form.account_type} onValueChange={(v) => setForm({ ...form, account_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("account-category")}</Label>
              <Select value={form.account_category} onValueChange={(v) => setForm({ ...form, account_category: v })}>
                <SelectTrigger><SelectValue placeholder={lbl("fin-select-category")} /></SelectTrigger>
                <SelectContent>
                  {ACCOUNT_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("parent-account")}</Label>
              <Select value={form.parent_id} onValueChange={(v) => setForm({ ...form, parent_id: v })}>
                <SelectTrigger><SelectValue placeholder={lbl("fin-none-top-level")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{lbl("fin-none-top-level")}</SelectItem>
                  {accounts.filter((a) => a.id !== editAccount?.id).map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("tax-code")}</Label>
              <Input value={form.tax_code} onChange={(e) => setForm({ ...form, tax_code: e.target.value })} placeholder={lbl("fin-erp-tax-code-placeholder")} />
            </div>
            <div className="space-y-2 flex items-center gap-3 pt-6">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} aria-label={lbl("is-active")} />
              <Label>{lbl("is-active")}</Label>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>{lbl("description")}</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={lbl("fin-erp-optional-description-placeholder")} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>{lbl("cancel")}</Button>
            <Button onClick={() => saveMutation.mutate({ ...form, parent_id: form.parent_id === "none" ? "" : form.parent_id })} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? lbl("fin-saving") : lbl("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{lbl("delete-account")}</AlertDialogTitle>
            <AlertDialogDescription>
              {lbl("delete-account-confirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{lbl("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}>
              {lbl("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Initialize Dialog */}
      <Dialog open={showInitDialog} onOpenChange={setShowInitDialog}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{lbl("initialize-chart")}</DialogTitle>
            <DialogDescription>{lbl("initialize-desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-4 py-4">
            <Button className="flex-1" onClick={() => initMutation.mutate("eu")} disabled={initMutation.isPending}>
              {lbl("fin-erp-initialize-eu")}
            </Button>
            <Button className="flex-1" variant="outline" onClick={() => initMutation.mutate("uae")} disabled={initMutation.isPending}>
              {lbl("fin-erp-initialize-uae")}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInitDialog(false)}>{lbl("cancel")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. JOURNAL ENTRIES
   ═══════════════════════════════════════════════════════════════════════════ */

function JournalEntries() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editEntry, setEditEntry] = useState<ErpJournalEntry | null>(null);
  const [viewEntry, setViewEntry] = useState<ErpJournalEntry | null>(null);
  const [form, setForm] = useState<JournalEntryForm>(emptyJournalEntry);

  const accountsQ = useQuery({
    queryKey: ["erp-accounts", tenantKey],
    queryFn: () => fetch(api("/api/erp/accounts")).then((r) => r.json()),
  });
  const accounts: ErpAccount[] = accountsQ.data?.items ?? accountsQ.data ?? [];

  const entriesQ = useQuery({
    queryKey: ["erp-journal-entries", tenantKey, filterStatus],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (search) params.set("search", search);
      return fetch(api(`/api/erp/journal-entries?${params}`)).then((r) => r.json());
    },
  });

  const entries: ErpJournalEntry[] = entriesQ.data?.items ?? entriesQ.data ?? [];

  const saveMutation = useMutation({
    mutationFn: (data: JournalEntryForm & { id?: string }) =>
      fetch(api("/api/erp/journal-entries"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.json();
      }),
    onSuccess: () => {
      toast.success(lbl(editEntry ? "fin-entry-updated" : "fin-entry-created"));
      qc.invalidateQueries({ queryKey: ["erp-journal-entries", tenantKey] });
      setShowAddDialog(false);
      setEditEntry(null);
      setForm(emptyJournalEntry);
    },
    onError: (e: any) => toast.error(e.message || lbl("fin-failed-save-entry")),
  });

  const postMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(api(`/api/erp/journal-entries/${id}/post`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-entry-posted"));
      qc.invalidateQueries({ queryKey: ["erp-journal-entries", tenantKey] });
    },
    onError: () => toast.error(lbl("fin-failed-post-entry")),
  });

  const reverseMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(api(`/api/erp/journal-entries/${id}/reverse`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-entry-reversed"));
      qc.invalidateQueries({ queryKey: ["erp-journal-entries", tenantKey] });
    },
    onError: () => toast.error(lbl("fin-failed-reverse-entry")),
  });

  // E-2 (multi-currency ERP) — revaluation entry creation. Posts to
  // /api/erp/journal-entries/revalue which calls the
  // create_fx_revaluation RPC. The new entry is created in `draft`
  // status — the user reviews it and posts it via the existing
  // post mutation.
  const [showRevalDialog, setShowRevalDialog] = useState(false);
  const [revalForm, setRevalForm] = useState<FxRevalForm>(emptyFxReval);

  const revalMutation = useMutation({
    mutationFn: (data: FxRevalForm) =>
      fetch(api("/api/erp/journal-entries/revalue"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || "Failed");
        return body;
      }),
    onSuccess: (data: { entry_number?: string; id?: string }) => {
      toast.success(`${lbl("fin-reval-success")}: ${data?.entry_number ?? ""}`);
      qc.invalidateQueries({ queryKey: ["erp-journal-entries", tenantKey] });
      setShowRevalDialog(false);
      setRevalForm(emptyFxReval);
    },
    onError: (e: any) => toast.error(e?.message || lbl("fin-reval-failed")),
  });

  function addRevalAdj() {
    setRevalForm({ ...revalForm, adjustments: [...revalForm.adjustments, { ...emptyFxRevalAdj }] });
  }
  function removeRevalAdj(index: number) {
    setRevalForm({ ...revalForm, adjustments: revalForm.adjustments.filter((_, i) => i !== index) });
  }
  function updateRevalAdj(index: number, field: keyof FxRevalAdjForm, value: string | number) {
    const adjustments = [...revalForm.adjustments];
    adjustments[index] = { ...adjustments[index], [field]: value };
    setRevalForm({ ...revalForm, adjustments });
  }

  const totalDebit = form.lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = form.lines.reduce((s, l) => s + (l.credit || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;
  // E-2 (multi-currency ERP): base-currency totals for the editor's
  // balance check. The RPC enforces the foreign-currency balance
  // server-side (debits must equal credits in the line currency), but
  // base-currency totals are informative — when every line has the
  // same currency as the base, they should also equal the foreign
  // totals. When lines span multiple currencies, the base totals are
  // informational only (an FX gain/loss on settlement is expected).
  const totalDebitBase = form.lines.reduce((s, l) => s + (l.debit || 0) * (l.fx_rate || 1), 0);
  const totalCreditBase = form.lines.reduce((s, l) => s + (l.credit || 0) * (l.fx_rate || 1), 0);

  function openEdit(entry: ErpJournalEntry) {
    setEditEntry(entry);
    setForm({
      date: entry.date,
      description: entry.description,
      reference_type: entry.reference_type ?? "manual",
      reference_id: entry.reference_id ?? "",
      currency: entry.currency,
      notes: entry.notes ?? "",
      // E-2 (multi-currency ERP): preserve per-line currency + fx_rate
      // when editing. Defaults to the entry-level currency and a rate
      // of 1 when the line didn't have them set (legacy rows from
      // before migration 038).
      lines: entry.lines?.map((l) => ({
        account_id: l.account_id,
        description: l.description ?? "",
        debit: l.debit,
        credit: l.credit,
        currency: l.currency ?? entry.currency,
        fx_rate: l.fx_rate ?? entry.exchange_rate ?? 1,
      })) ?? [{ account_id: "", description: "", debit: 0, credit: 0, currency: entry.currency, fx_rate: 1 }],
    });
    setShowAddDialog(true);
  }

  function openAdd() {
    setEditEntry(null);
    setForm(emptyJournalEntry);
    setShowAddDialog(true);
  }

  function addLine() {
    // E-2 (multi-currency ERP): new line inherits the entry's currency
    // and a default fx_rate of 1 (which is correct when the line's
    // currency equals the base currency; the user can edit it).
    setForm({ ...form, lines: [...form.lines, { account_id: "", description: "", debit: 0, credit: 0, currency: form.currency, fx_rate: 1 }] });
  }

  function removeLine(index: number) {
    setForm({ ...form, lines: form.lines.filter((_, i) => i !== index) });
  }

  function updateLine(index: number, field: keyof JournalLineForm, value: string | number) {
    const lines = [...form.lines];
    lines[index] = { ...lines[index], [field]: value };
    setForm({ ...form, lines });
  }

  // Listen for custom event to open new entry dialog
  useState(() => {
    const handler = () => openAdd();
    window.addEventListener("erp-new-entry", handler);
    return () => window.removeEventListener("erp-new-entry", handler);
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder={lbl("fin-search-entries-placeholder")} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-64" />
          </div>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{lbl("fin-all-statuses")}</SelectItem>
              <SelectItem value="draft">{lbl("erp-draft")}</SelectItem>
              <SelectItem value="posted">{lbl("erp-posted")}</SelectItem>
              <SelectItem value="reversed">{lbl("erp-reversed")}</SelectItem>
              <SelectItem value="cancelled">{lbl("erp-cancelled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button onClick={openAdd}>
            <Plus className="size-4 mr-2" />{lbl("add-entry")}
          </Button>
          {/* E-2 (multi-currency ERP) — open the FX Revaluation dialog. */}
          <Button variant="outline" onClick={() => { setRevalForm(emptyFxReval); setShowRevalDialog(true); }}>
            <Repeat className="size-4 mr-2" />{lbl("fin-revalue")}
          </Button>
        </div>
      </div>

      {/* Table */}
      {entriesQ.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : entries.length === 0 ? (
        <EmptyState icon={<ArrowRightLeft />} title={lbl("no-entries")} action={<Button onClick={openAdd}><Plus className="size-4 mr-2" />{lbl("add-entry")}</Button>} />
      ) : (
        <div className={scrollbarStyle}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{lbl("entry-number")}</TableHead>
                <TableHead>{lbl("date")}</TableHead>
                <TableHead>{lbl("description")}</TableHead>
                <TableHead>{lbl("reference")}</TableHead>
                <TableHead>{lbl("status")}</TableHead>
                <TableHead className="text-right">{lbl("debit-total")}</TableHead>
                <TableHead className="text-right">{lbl("credit-total")}</TableHead>
                <TableHead className="text-right">{lbl("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-mono font-medium">
                    {entry.entry_number}
                    {/* E-2: flag revaluation entries inline so they stand out */}
                    {entry.is_revaluation && (
                      <Badge variant="outline" className="ml-2 text-[10px] py-0 px-1.5 align-middle">{lbl("fin-revaluation-badge")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>{fmtDate(entry.date)}</TableCell>
                  <TableCell className="max-w-[200px]">{entry.description}</TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {entry.reference_type ? `${entry.reference_type}${entry.reference_id ? `: ${entry.reference_id.slice(0, 8)}...` : ""}` : "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className={STATUS_BADGE[entry.status]?.className ?? ""}>
                      {lbl(STATUS_BADGE[entry.status]?.key ?? "")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {fmtMoney(entry.debit_total, entry.currency)}
                    {/* E-2: when an entry has a base_currency different
                        from its line currency, show the base-currency
                        total too. For revaluation entries, debit_total
                        is already in the base currency. */}
                    {entry.base_currency && entry.base_currency !== entry.currency && (
                      <div className="text-[10px] text-muted-foreground">
                        ≈ {fmtMoney(entry.debit_total, entry.base_currency)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {fmtMoney(entry.credit_total, entry.currency)}
                    {entry.base_currency && entry.base_currency !== entry.currency && (
                      <div className="text-[10px] text-muted-foreground">
                        ≈ {fmtMoney(entry.credit_total, entry.base_currency)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" onClick={() => setViewEntry(entry)} title={lbl("view")} aria-label={lbl("view")}>
                        <Eye className="size-4" />
                      </Button>
                      {entry.status === "draft" && (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => openEdit(entry)} title={lbl("edit")} aria-label={lbl("edit")}>
                            <Pencil className="size-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => postMutation.mutate(entry.id)} title={lbl("erp-post")} aria-label={lbl("erp-post")}>
                            <CheckCircle2 className="size-4 text-emerald-600" />
                          </Button>
                        </>
                      )}
                      {entry.status === "posted" && (
                        <Button variant="ghost" size="icon" onClick={() => reverseMutation.mutate(entry.id)} title={lbl("erp-reverse")} aria-label={lbl("erp-reverse")}>
                          <RotateCcw className="size-4 text-red-600" />
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

      {/* Add/Edit Journal Entry Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>{editEntry ? lbl("edit-entry") : lbl("add-entry")}</DialogTitle>
            <DialogDescription>
              {editEntry ? lbl("fin-update-entry-desc") : lbl("fin-create-entry-desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* Header fields */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{lbl("entry-date")}</Label>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{lbl("currency")}</Label>
                <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{lbl("reference-type")}</Label>
                <Select value={form.reference_type} onValueChange={(v) => setForm({ ...form, reference_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {REFERENCE_TYPES.map((t) => <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{lbl("entry-description")}</Label>
                <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={lbl("fin-erp-entry-description-placeholder")} />
              </div>
              <div className="space-y-2">
                <Label>{lbl("reference-id")}</Label>
                <Input value={form.reference_id} onChange={(e) => setForm({ ...form, reference_id: e.target.value })} placeholder={lbl("fin-reference-id-placeholder")} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{lbl("notes")}</Label>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={lbl("fin-erp-optional-notes-placeholder")} rows={2} />
            </div>

            {/* Lines */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{lbl("lines")}</h3>
                <div className="flex items-center gap-3">
                  <Badge className={isBalanced ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}>
                    {isBalanced ? lbl("balanced") : lbl("not-balanced")}
                  </Badge>
                  <Button variant="outline" size="sm" onClick={addLine}>
                    <Plus className="size-4 mr-1" />{lbl("add-line")}
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{lbl("account")}</TableHead>
                      <TableHead>{lbl("line-description")}</TableHead>
                      {/* E-2: per-line currency + FX rate + base amounts */}
                      <TableHead className="w-24">{lbl("fin-currency")}</TableHead>
                      <TableHead className="text-right w-24">{lbl("fin-fx-rate")}</TableHead>
                      <TableHead className="text-right w-32">{lbl("debit")}</TableHead>
                      <TableHead className="text-right w-32">{lbl("credit")}</TableHead>
                      <TableHead className="text-right w-32">{lbl("fin-base-amount")}</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {form.lines.map((line, idx) => {
                      const lineDebitBase = (line.debit || 0) * (line.fx_rate || 1);
                      const lineCreditBase = (line.credit || 0) * (line.fx_rate || 1);
                      return (
                      <TableRow key={idx}>
                        <TableCell>
                          <Select value={line.account_id} onValueChange={(v) => updateLine(idx, "account_id", v)}>
                            <SelectTrigger className="w-64"><SelectValue placeholder={lbl("select-account")} /></SelectTrigger>
                            <SelectContent>
                              {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input value={line.description} onChange={(e) => updateLine(idx, "description", e.target.value)} placeholder={lbl("description")} />
                        </TableCell>
                        <TableCell>
                          <Select value={line.currency} onValueChange={(v) => updateLine(idx, "currency", v)}>
                            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.0001"
                            value={line.fx_rate || ""}
                            onChange={(e) => updateLine(idx, "fx_rate", parseFloat(e.target.value) || 1)}
                            className="text-right"
                            placeholder="1.0"
                          />
                        </TableCell>
                        <TableCell>
                          <Input type="number" step="0.01" value={line.debit || ""} onChange={(e) => updateLine(idx, "debit", parseFloat(e.target.value) || 0)} className="text-right" />
                        </TableCell>
                        <TableCell>
                          <Input type="number" step="0.01" value={line.credit || ""} onChange={(e) => updateLine(idx, "credit", parseFloat(e.target.value) || 0)} className="text-right" />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground align-middle">
                          {/* Show the larger of debit_base / credit_base so
                              the column is meaningful for both sides. */}
                          {lineDebitBase > 0 && <div>{fmtMoney(lineDebitBase, form.currency)}</div>}
                          {lineCreditBase > 0 && <div>{fmtMoney(lineCreditBase, form.currency)}</div>}
                          {lineDebitBase === 0 && lineCreditBase === 0 && <span className="opacity-40">—</span>}
                        </TableCell>
                        <TableCell>
                          {form.lines.length > 1 && (
                            <Button variant="ghost" size="icon" onClick={() => removeLine(idx)} title={lbl("remove")} aria-label={lbl("remove")}>
                              <XCircle className="size-4 text-destructive" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {/* Totals — foreign + base */}
              <div className="flex justify-end gap-8 pt-2 border-t">
                <div className="text-sm"><span className="text-muted-foreground">{lbl("debit-total")}:</span> <span className="font-mono font-semibold">{fmtMoney(totalDebit, form.currency)}</span></div>
                <div className="text-sm"><span className="text-muted-foreground">{lbl("credit-total")}:</span> <span className="font-mono font-semibold">{fmtMoney(totalCredit, form.currency)}</span></div>
                {/* E-2: base-currency totals — only shown when there's
                    actual FX activity (otherwise they'd duplicate the
                    foreign totals and add noise). */}
                {(totalDebitBase !== totalDebit || totalCreditBase !== totalCredit) && (
                  <>
                    <div className="text-sm border-l pl-8"><span className="text-muted-foreground">{lbl("fin-base-amount")} D:</span> <span className="font-mono font-semibold">{fmtMoney(totalDebitBase, form.currency)}</span></div>
                    <div className="text-sm"><span className="text-muted-foreground">{lbl("fin-base-amount")} C:</span> <span className="font-mono font-semibold">{fmtMoney(totalCreditBase, form.currency)}</span></div>
                  </>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>{lbl("cancel")}</Button>
            <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending || !isBalanced}>
              {saveMutation.isPending ? lbl("fin-saving") : lbl("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Entry Dialog */}
      <Dialog open={!!viewEntry} onOpenChange={() => setViewEntry(null)}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>{lbl("entry-detail")} — {viewEntry?.entry_number}</DialogTitle>
            <DialogDescription>
              {viewEntry?.description} — {fmtDate(viewEntry?.date)}
            </DialogDescription>
          </DialogHeader>
          {viewEntry && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div><span className="text-xs text-muted-foreground">{lbl("status")}</span><div><Badge className={STATUS_BADGE[viewEntry.status]?.className ?? ""}>{lbl(STATUS_BADGE[viewEntry.status]?.key ?? "")}</Badge></div></div>
                <div><span className="text-xs text-muted-foreground">{lbl("currency")}</span><div className="font-mono">{viewEntry.currency}</div></div>
                {/* E-2: show the base currency if it differs from the line currency */}
                <div><span className="text-xs text-muted-foreground">{lbl("fin-base-currency")}</span><div className="font-mono">{viewEntry.base_currency ?? viewEntry.currency}</div></div>
                <div><span className="text-xs text-muted-foreground">{lbl("reference")}</span><div>{viewEntry.reference_type ?? "—"}{viewEntry.reference_id ? `: ${viewEntry.reference_id.slice(0, 8)}...` : ""}</div></div>
                <div><span className="text-xs text-muted-foreground">{lbl("notes")}</span><div>{viewEntry.notes ?? "—"}</div></div>
              </div>
              {viewEntry.is_revaluation && (
                <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm">
                  <span className="font-semibold">{lbl("fin-revaluation-badge")}</span>
                  <span className="ml-2 text-muted-foreground">
                    {lbl("fin-revalue-entry")} — {viewEntry.description}
                  </span>
                </div>
              )}
              {viewEntry.lines && viewEntry.lines.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{lbl("account")}</TableHead>
                      <TableHead>{lbl("line-description")}</TableHead>
                      {/* E-2: per-line currency + FX rate + base amounts */}
                      <TableHead className="text-right">{lbl("fin-currency")}</TableHead>
                      <TableHead className="text-right">{lbl("fin-fx-rate")}</TableHead>
                      <TableHead className="text-right">{lbl("debit")}</TableHead>
                      <TableHead className="text-right">{lbl("credit")}</TableHead>
                      <TableHead className="text-right">{lbl("fin-base-amount")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {viewEntry.lines.map((line) => {
                      const acct = accounts.find((a) => a.id === line.account_id);
                      // E-2: derive the line's currency + fx_rate +
                      // base amounts with sensible fallbacks for
                      // legacy rows (pre-migration 038).
                      const lineCurrency = line.currency ?? viewEntry.currency;
                      const lineFxRate = line.fx_rate ?? 1;
                      const lineDebitBase = line.debit_base ?? (line.debit ? line.debit * lineFxRate : 0);
                      const lineCreditBase = line.credit_base ?? (line.credit ? line.credit * lineFxRate : 0);
                      const baseCur = viewEntry.base_currency ?? viewEntry.currency;
                      return (
                        <TableRow key={line.id}>
                          <TableCell className="font-mono">{acct ? `${acct.code} — ${acct.name}` : line.account_id}</TableCell>
                          <TableCell>{line.description ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{lineCurrency}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{lineFxRate}</TableCell>
                          <TableCell className="text-right font-mono">{line.debit ? fmtMoney(line.debit, lineCurrency) : ""}</TableCell>
                          <TableCell className="text-right font-mono">{line.credit ? fmtMoney(line.credit, lineCurrency) : ""}</TableCell>
                          <TableCell className="text-right font-mono">
                            {lineDebitBase > 0 && <div>{fmtMoney(lineDebitBase, baseCur)}</div>}
                            {lineCreditBase > 0 && <div>{fmtMoney(lineCreditBase, baseCur)}</div>}
                            {lineDebitBase === 0 && lineCreditBase === 0 && <span className="opacity-40">—</span>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              <div className="flex justify-end gap-8 pt-2 border-t">
                <div className="text-sm"><span className="text-muted-foreground">{lbl("debit-total")}:</span> <span className="font-mono font-semibold">{fmtMoney(viewEntry.debit_total, viewEntry.currency)}</span></div>
                <div className="text-sm"><span className="text-muted-foreground">{lbl("credit-total")}:</span> <span className="font-mono font-semibold">{fmtMoney(viewEntry.credit_total, viewEntry.currency)}</span></div>
                {/* E-2: show the base-currency totals too when they differ */}
                {viewEntry.base_currency && viewEntry.base_currency !== viewEntry.currency && (
                  <>
                    <div className="text-sm border-l pl-8"><span className="text-muted-foreground">{lbl("fin-base-amount")} D:</span> <span className="font-mono font-semibold">{fmtMoney(viewEntry.debit_total, viewEntry.base_currency)}</span></div>
                    <div className="text-sm"><span className="text-muted-foreground">{lbl("fin-base-amount")} C:</span> <span className="font-mono font-semibold">{fmtMoney(viewEntry.credit_total, viewEntry.base_currency)}</span></div>
                  </>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewEntry(null)}>{lbl("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* E-2 (multi-currency ERP) — FX Revaluation dialog */}
      <Dialog open={showRevalDialog} onOpenChange={setShowRevalDialog}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>{lbl("fin-revalue-entry")}</DialogTitle>
            <DialogDescription>{lbl("fin-revalue-desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{lbl("fin-reval-date")}</Label>
                <Input type="date" value={revalForm.reval_date} onChange={(e) => setRevalForm({ ...revalForm, reval_date: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{lbl("fin-base-currency")}</Label>
                <Select value={revalForm.base_currency} onValueChange={(v) => setRevalForm({ ...revalForm, base_currency: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{lbl("fin-reval-adjustments")}</h3>
                <Button variant="outline" size="sm" onClick={addRevalAdj}>
                  <Plus className="size-4 mr-1" />{lbl("add-line")}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{lbl("account")}</TableHead>
                      <TableHead className="w-24">{lbl("fin-currency")}</TableHead>
                      <TableHead className="text-right w-28">Old Rate</TableHead>
                      <TableHead className="text-right w-28">New Rate</TableHead>
                      <TableHead className="text-right w-32">Balance</TableHead>
                      <TableHead>{lbl("fin-gain-loss")} Acct</TableHead>
                      <TableHead className="text-right w-32">{lbl("fin-gain-loss")}</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {revalForm.adjustments.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-4 text-sm">
                          No adjustments — submit to create an empty revaluation entry header only.
                        </TableCell>
                      </TableRow>
                    )}
                    {revalForm.adjustments.map((adj, idx) => {
                      const baseOld = (adj.balance_foreign || 0) * (adj.fx_rate_old || 1);
                      const baseNew = (adj.balance_foreign || 0) * (adj.fx_rate_new || 1);
                      const delta = baseNew - baseOld;
                      return (
                        <TableRow key={idx}>
                          <TableCell>
                            <Select value={adj.account_id} onValueChange={(v) => updateRevalAdj(idx, "account_id", v)}>
                              <SelectTrigger className="w-56"><SelectValue placeholder={lbl("select-account")} /></SelectTrigger>
                              <SelectContent>
                                {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Select value={adj.currency} onValueChange={(v) => updateRevalAdj(idx, "currency", v)}>
                              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input type="number" step="0.0001" value={adj.fx_rate_old || ""} onChange={(e) => updateRevalAdj(idx, "fx_rate_old", parseFloat(e.target.value) || 0)} className="text-right" />
                          </TableCell>
                          <TableCell>
                            <Input type="number" step="0.0001" value={adj.fx_rate_new || ""} onChange={(e) => updateRevalAdj(idx, "fx_rate_new", parseFloat(e.target.value) || 0)} className="text-right" />
                          </TableCell>
                          <TableCell>
                            <Input type="number" step="0.01" value={adj.balance_foreign || ""} onChange={(e) => updateRevalAdj(idx, "balance_foreign", parseFloat(e.target.value) || 0)} className="text-right" />
                          </TableCell>
                          <TableCell>
                            <Select value={adj.gain_loss_account_id} onValueChange={(v) => updateRevalAdj(idx, "gain_loss_account_id", v)}>
                              <SelectTrigger className="w-56"><SelectValue placeholder={lbl("select-account")} /></SelectTrigger>
                              <SelectContent>
                                {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {delta !== 0 && (
                              <span className={delta > 0 ? "text-emerald-600" : "text-red-600"}>
                                {delta > 0 ? "+" : ""}{fmtMoney(Math.abs(delta), revalForm.base_currency)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" onClick={() => removeRevalAdj(idx)} title={lbl("remove")} aria-label={lbl("remove")}>
                              <XCircle className="size-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">
                Each adjustment generates two balanced journal lines: one debiting/crediting the foreign-currency
                account, and one crediting/debiting the FX gain/loss account. The entry is saved as <code>draft</code> —
                review and post it via the entries list once you're satisfied.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRevalDialog(false)}>{lbl("cancel")}</Button>
            <Button onClick={() => revalMutation.mutate(revalForm)} disabled={revalMutation.isPending || !revalForm.reval_date}>
              {revalMutation.isPending ? lbl("fin-saving") : lbl("fin-revalue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. GENERAL LEDGER
   ═══════════════════════════════════════════════════════════════════════════ */

function GeneralLedger() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const accountsQ = useQuery({
    queryKey: ["erp-accounts", tenantKey],
    queryFn: () => fetch(api("/api/erp/accounts")).then((r) => r.json()),
  });
  const accounts: ErpAccount[] = accountsQ.data?.items ?? accountsQ.data ?? [];

  const ledgerQ = useQuery({
    queryKey: ["erp-general-ledger", tenantKey, selectedAccountId, dateFrom, dateTo],
    queryFn: () => {
      const params = new URLSearchParams({
        type: "general_ledger",
        account_id: selectedAccountId,
      });
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      return fetch(api(`/api/erp/reports?${params}`)).then((r) => r.json());
    },
    enabled: !!selectedAccountId,
  });

  const ledger: GeneralLedger | null = ledgerQ.data ?? null;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>{lbl("gl-account")}</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger><SelectValue placeholder={lbl("select-account")} /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("date-from")}</Label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("date-to")}</Label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button variant="outline" onClick={() => { setDateFrom(""); setDateTo(""); }} className="w-full">
                {lbl("fin-clear-filters")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Ledger */}
      {!selectedAccountId ? (
        <EmptyState icon={<PieChart />} title={lbl("select-account")} description={lbl("fin-select-account-view-ledger")} />
      ) : ledgerQ.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : !ledger?.entries?.length ? (
        <EmptyState icon={<PieChart />} title={lbl("no-ledger-data")} />
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">
              {ledger.account_code} — {ledger.account_name}
            </CardTitle>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>{lbl("fin-opening-label")}: <span className="font-mono font-semibold text-foreground">{fmtMoney(ledger.opening_balance, "EUR")}</span></span>
              <span>{lbl("fin-closing-label")}: <span className="font-mono font-semibold text-foreground">{fmtMoney(ledger.closing_balance, "EUR")}</span></span>
              <span>{lbl("fin-total-debit-inline")}: <span className="font-mono font-semibold text-foreground">{fmtMoney(ledger.total_debit, "EUR")}</span></span>
              <span>{lbl("fin-total-credit-inline")}: <span className="font-mono font-semibold text-foreground">{fmtMoney(ledger.total_credit, "EUR")}</span></span>
              {/* E-2: show base-currency balances too when the account
                  has any multi-currency activity. */}
              {ledger.base_currency && (
                <span className="border-l pl-6">
                  {lbl("fin-base-amount")}: <span className="font-mono font-semibold text-foreground">{fmtMoney(ledger.opening_balance_base ?? ledger.opening_balance, ledger.base_currency)} → {fmtMoney(ledger.closing_balance_base ?? ledger.closing_balance, ledger.base_currency)}</span>
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className={scrollbarStyle}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{lbl("entry-number")}</TableHead>
                    <TableHead>{lbl("date")}</TableHead>
                    <TableHead>{lbl("description")}</TableHead>
                    {/* E-2: line currency column for multi-currency GL */}
                    <TableHead className="text-right">{lbl("fin-currency")}</TableHead>
                    <TableHead className="text-right">{lbl("debit")}</TableHead>
                    <TableHead className="text-right">{lbl("credit")}</TableHead>
                    {/* E-2: base-currency equivalents */}
                    <TableHead className="text-right">{lbl("fin-base-amount")} D</TableHead>
                    <TableHead className="text-right">{lbl("fin-base-amount")} C</TableHead>
                    <TableHead className="text-right">{lbl("running-balance")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.entries.map((entry: GeneralLedgerEntry, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell className="font-mono">{entry.entry_number}</TableCell>
                      <TableCell>{fmtDate(entry.date)}</TableCell>
                      <TableCell>{entry.description}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">{entry.currency ?? "EUR"}</TableCell>
                      <TableCell className="text-right font-mono">{entry.debit ? fmtMoney(entry.debit, entry.currency ?? "EUR") : ""}</TableCell>
                      <TableCell className="text-right font-mono">{entry.credit ? fmtMoney(entry.credit, entry.currency ?? "EUR") : ""}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">{entry.debit_base ? fmtMoney(entry.debit_base, ledger.base_currency ?? "EUR") : ""}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">{entry.credit_base ? fmtMoney(entry.credit_base, ledger.base_currency ?? "EUR") : ""}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{fmtMoney(entry.balance, "EUR")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. BANK ACCOUNTS
   ═══════════════════════════════════════════════════════════════════════════ */

function BankAccounts() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const qc = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editBankAccount, setEditBankAccount] = useState<ErpBankAccount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ErpBankAccount | null>(null);
  const [selectedBankAccount, setSelectedBankAccount] = useState<ErpBankAccount | null>(null);
  const [showTransactionDialog, setShowTransactionDialog] = useState(false);
  const [txForm, setTxForm] = useState<BankTransactionForm>(emptyBankTransaction);
  const [form, setForm] = useState<BankAccountForm>(emptyBankAccount);

  const accountsQ = useQuery({
    queryKey: ["erp-accounts", tenantKey],
    queryFn: () => fetch(api("/api/erp/accounts")).then((r) => r.json()),
  });
  const chartAccounts: ErpAccount[] = accountsQ.data?.items ?? accountsQ.data ?? [];

  const bankAccountsQ = useQuery({
    queryKey: ["erp-bank-accounts", tenantKey],
    queryFn: () => fetch(api("/api/erp/bank-accounts")).then((r) => r.json()),
  });
  const bankAccounts: ErpBankAccount[] = bankAccountsQ.data?.items ?? bankAccountsQ.data ?? [];

  const transactionsQ = useQuery({
    queryKey: ["erp-bank-transactions", tenantKey, selectedBankAccount?.id],
    queryFn: () => {
      const params = new URLSearchParams();
      if (selectedBankAccount?.id) params.set("bank_account_id", selectedBankAccount.id);
      return fetch(api(`/api/erp/bank-transactions?${params}`)).then((r) => r.json());
    },
    enabled: !!selectedBankAccount,
  });
  const transactions: ErpBankTransaction[] = transactionsQ.data?.items ?? transactionsQ.data ?? [];

  const saveMutation = useMutation({
    mutationFn: (data: BankAccountForm) =>
      fetch(api("/api/erp/bank-accounts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-bank-account-saved"));
      qc.invalidateQueries({ queryKey: ["erp-bank-accounts", tenantKey] });
      setShowAddDialog(false);
      setEditBankAccount(null);
      setForm(emptyBankAccount);
    },
    onError: () => toast.error(lbl("fin-failed-save-bank-account")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(api(`/api/erp/bank-accounts/${id}`), { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-bank-account-deleted"));
      qc.invalidateQueries({ queryKey: ["erp-bank-accounts", tenantKey] });
      setDeleteTarget(null);
      if (selectedBankAccount?.id === deleteTarget?.id) setSelectedBankAccount(null);
    },
    onError: () => toast.error(lbl("fin-failed-delete-bank-account")),
  });

  const saveTxMutation = useMutation({
    mutationFn: (data: BankTransactionForm) =>
      fetch(api("/api/erp/bank-transactions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-transaction-created"));
      qc.invalidateQueries({ queryKey: ["erp-bank-transactions", tenantKey] });
      setShowTransactionDialog(false);
      setTxForm(emptyBankTransaction);
    },
    onError: () => toast.error(lbl("fin-failed-create-transaction")),
  });

  function openEdit(ba: ErpBankAccount) {
    setEditBankAccount(ba);
    setForm({
      id: ba.id,
      bank_name: ba.bank_name,
      account_number: ba.account_number,
      iban: ba.iban ?? "",
      swift_bic: ba.swift_bic ?? "",
      currency: ba.currency,
      balance: ba.balance,
      account_id: ba.account_id,
      is_active: ba.is_active,
    });
    setShowAddDialog(true);
  }

  function openAdd() {
    setEditBankAccount(null);
    setForm(emptyBankAccount);
    setShowAddDialog(true);
  }

  function openAddTx(ba: ErpBankAccount) {
    setTxForm({ ...emptyBankTransaction, bank_account_id: ba.id });
    setShowTransactionDialog(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openAdd}><Plus className="size-4 mr-2" />{lbl("add-bank-account")}</Button>
      </div>

      {bankAccountsQ.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}</div>
      ) : bankAccounts.length === 0 ? (
        <EmptyState icon={<Landmark />} title={lbl("no-bank-accounts")} action={<Button onClick={openAdd}><Plus className="size-4 mr-2" />{lbl("add-bank-account")}</Button>} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {bankAccounts.map((ba) => (
            <Card
              key={ba.id}
              className={`cursor-pointer transition-all hover:shadow-md ${selectedBankAccount?.id === ba.id ? "ring-2 ring-primary" : ""}`}
              onClick={() => setSelectedBankAccount(ba)}
            >
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-5 text-muted-foreground" />
                      <span className="font-semibold text-lg">{ba.bank_name}</span>
                    </div>
                    <div className="text-sm text-muted-foreground">{ba.account_number}</div>
                    {ba.iban && <div className="text-xs text-muted-foreground font-mono">{lbl("erp-iban")}: {ba.iban}</div>}
                    {ba.swift_bic && <div className="text-xs text-muted-foreground font-mono">{lbl("erp-swift")}: {ba.swift_bic}</div>}
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold">{fmtMoney(ba.balance, ba.currency)}</div>
                    <Badge variant="outline" className="mt-1">{ba.currency}</Badge>
                  </div>
                </div>
                <div className="flex gap-2 mt-4 pt-3 border-t">
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); openEdit(ba); }}>
                    <Pencil className="size-3 mr-1" />{lbl("edit")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); openAddTx(ba); }}>
                    <Plus className="size-3 mr-1" />{lbl("fin-add-transaction")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setDeleteTarget(ba); }}>
                    <Trash2 className="size-3 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Transactions for selected bank account */}
      {selectedBankAccount && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">
              {lbl("transactions")} — {selectedBankAccount.bank_name} ({selectedBankAccount.account_number})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {transactionsQ.isLoading ? (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : transactions.length === 0 ? (
              <EmptyState icon={<ArrowRightLeft />} title={lbl("no-transactions")} />
            ) : (
              <div className={scrollbarStyle}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{lbl("date")}</TableHead>
                      <TableHead>{lbl("description")}</TableHead>
                      <TableHead>{lbl("counterparty")}</TableHead>
                      <TableHead>{lbl("transaction-type")}</TableHead>
                      <TableHead className="text-right">{lbl("amount")}</TableHead>
                      <TableHead>{lbl("reconciled")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell>{fmtDate(tx.date)}</TableCell>
                        <TableCell>{tx.description ?? "—"}</TableCell>
                        <TableCell>{tx.counterparty ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant={tx.transaction_type === "credit" ? "default" : "secondary"}>
                            {tx.transaction_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {fmtMoney(tx.amount, selectedBankAccount.currency)}
                        </TableCell>
                        <TableCell>
                          {tx.is_reconciled ? (
                            <CheckCircle2 className="size-4 text-emerald-600" />
                          ) : (
                            <XCircle className="size-4 text-muted-foreground" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Add/Edit Bank Account Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>{editBankAccount ? lbl("edit-bank-account") : lbl("add-bank-account")}</DialogTitle>
            <DialogDescription>{lbl("fin-enter-bank-details-desc")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-4">
            <div className="space-y-2">
              <Label>{lbl("bank-name")}</Label>
              <Input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} placeholder={lbl("fin-erp-bank-name-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("account-number")}</Label>
              <Input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} placeholder={lbl("fin-erp-account-number-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("iban")}</Label>
              <Input value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} placeholder={lbl("fin-erp-iban-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("swift-bic")}</Label>
              <Input value={form.swift_bic} onChange={(e) => setForm({ ...form, swift_bic: e.target.value })} placeholder={lbl("fin-erp-swift-bic-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("currency")}</Label>
              <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("balance")}</Label>
              <Input type="number" step="0.01" value={form.balance || ""} onChange={(e) => setForm({ ...form, balance: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("linked-account")}</Label>
              <Select value={form.account_id} onValueChange={(v) => setForm({ ...form, account_id: v })}>
                <SelectTrigger><SelectValue placeholder={lbl("select-account")} /></SelectTrigger>
                <SelectContent>
                  {chartAccounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 flex items-center gap-3 pt-6">
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} aria-label={lbl("active")} />
              <Label>{lbl("active")}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>{lbl("cancel")}</Button>
            <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? lbl("fin-saving") : lbl("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{lbl("fin-delete-bank-account-title")}</AlertDialogTitle>
            <AlertDialogDescription>{lbl("fin-delete-bank-account-confirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{lbl("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}>{lbl("delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Transaction Dialog */}
      <Dialog open={showTransactionDialog} onOpenChange={setShowTransactionDialog}>
        <DialogContent size="full">
          <DialogHeader>
            <DialogTitle>{lbl("add-transaction")}</DialogTitle>
            <DialogDescription>{lbl("fin-enter-transaction-desc")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-4">
            <div className="space-y-2">
              <Label>{lbl("date")}</Label>
              <Input type="date" value={txForm.date} onChange={(e) => setTxForm({ ...txForm, date: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("amount")}</Label>
              <Input type="number" step="0.01" value={txForm.amount || ""} onChange={(e) => setTxForm({ ...txForm, amount: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("transaction-type")}</Label>
              <Select value={txForm.transaction_type} onValueChange={(v) => setTxForm({ ...txForm, transaction_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">{lbl("fin-credit-in")}</SelectItem>
                  <SelectItem value="debit">{lbl("fin-debit-out")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("counterparty")}</Label>
              <Input value={txForm.counterparty} onChange={(e) => setTxForm({ ...txForm, counterparty: e.target.value })} placeholder={lbl("fin-erp-counterparty-name-placeholder")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("description")}</Label>
              <Input value={txForm.description} onChange={(e) => setTxForm({ ...txForm, description: e.target.value })} placeholder={lbl("description")} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("reference")}</Label>
              <Input value={txForm.reference} onChange={(e) => setTxForm({ ...txForm, reference: e.target.value })} placeholder={lbl("fin-erp-reference-placeholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTransactionDialog(false)}>{lbl("cancel")}</Button>
            <Button onClick={() => saveTxMutation.mutate(txForm)} disabled={saveTxMutation.isPending}>
              {saveTxMutation.isPending ? lbl("fin-saving") : lbl("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. ERP REPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

function ErpReports() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const [reportTab, setReportTab] = useState("trial_balance");
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split("T")[0]);
  const [periodStart, setPeriodStart] = useState(`${new Date().getFullYear()}-01-01`);
  const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().split("T")[0]);

  const trialBalanceQ = useQuery({
    queryKey: ["erp-report-trial-balance", tenantKey, asOfDate],
    queryFn: () => fetch(api(`/api/erp/reports?type=trial_balance&as_of_date=${asOfDate}`)).then((r) => r.json()),
    enabled: reportTab === "trial_balance",
  });

  const balanceSheetQ = useQuery({
    queryKey: ["erp-report-balance-sheet", tenantKey, asOfDate],
    queryFn: () => fetch(api(`/api/erp/reports?type=balance_sheet&as_of_date=${asOfDate}`)).then((r) => r.json()),
    enabled: reportTab === "balance_sheet",
  });

  const profitAndLossQ = useQuery({
    queryKey: ["erp-report-profit-and-loss", tenantKey, periodStart, periodEnd],
    queryFn: () => fetch(api(`/api/erp/reports?type=profit_and_loss&period_start=${periodStart}&period_end=${periodEnd}`)).then((r) => r.json()),
    enabled: reportTab === "profit_and_loss",
  });

  const trialBalance: TrialBalance | null = trialBalanceQ.data ?? null;
  const balanceSheet: BalanceSheet | null = balanceSheetQ.data ?? null;
  const profitAndLoss: ProfitAndLoss | null = profitAndLossQ.data ?? null;

  return (
    <div className="space-y-4">
      <Tabs value={reportTab} onValueChange={setReportTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="trial_balance">{lbl("trial-balance")}</TabsTrigger>
          <TabsTrigger value="balance_sheet">{lbl("balance-sheet")}</TabsTrigger>
          <TabsTrigger value="profit_and_loss">{lbl("profit-and-loss")}</TabsTrigger>
        </TabsList>

        {/* Trial Balance */}
        <TabsContent value="trial_balance">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <CardTitle className="text-lg">{lbl("trial-balance")}</CardTitle>
                <div className="flex items-center gap-3">
                  <Label className="text-sm">{lbl("as-of-date")}</Label>
                  <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="w-44" />
                  <Button variant="outline" size="sm" disabled>
                    <Download className="size-4 mr-1" />{lbl("export-report")}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {trialBalanceQ.isLoading ? (
                <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : !trialBalance?.items?.length ? (
                <EmptyState icon={<FileBarChart />} title={lbl("no-report-data")} />
              ) : (
                <div className={scrollbarStyle}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{lbl("code")}</TableHead>
                        <TableHead>{lbl("name")}</TableHead>
                        <TableHead>{lbl("type")}</TableHead>
                        <TableHead className="text-right">{lbl("debit")}</TableHead>
                        <TableHead className="text-right">{lbl("credit")}</TableHead>
                        {/* E-2: base-currency columns */}
                        <TableHead className="text-right">{lbl("fin-base-amount")} D</TableHead>
                        <TableHead className="text-right">{lbl("fin-base-amount")} C</TableHead>
                        <TableHead className="text-right">{lbl("balance")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {trialBalance.items.map((item: TrialBalanceItem) => {
                        const baseCur = trialBalance.base_currency ?? "EUR";
                        return (
                        <TableRow key={item.account_id}>
                          <TableCell className="font-mono">{item.account_code}</TableCell>
                          <TableCell>{item.account_name}</TableCell>
                          <TableCell>
                            <Badge className={ACCOUNT_TYPE_COLOR[item.account_type] ?? ""}>{item.account_type}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">{item.debit_total ? fmtMoney(item.debit_total, "EUR") : ""}</TableCell>
                          <TableCell className="text-right font-mono">{item.credit_total ? fmtMoney(item.credit_total, "EUR") : ""}</TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">{item.debit_total_base ? fmtMoney(item.debit_total_base, baseCur) : ""}</TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">{item.credit_total_base ? fmtMoney(item.credit_total_base, baseCur) : ""}</TableCell>
                          <TableCell className="text-right font-mono font-semibold">{fmtMoney(item.balance, "EUR")}</TableCell>
                        </TableRow>
                        );
                      })}
                      {/* Totals */}
                      <TableRow className="font-bold border-t-2">
                        <TableCell colSpan={3}>{lbl("fin-total-col")}</TableCell>
                        <TableCell className="text-right font-mono">{fmtMoney(trialBalance.total_debit, "EUR")}</TableCell>
                        <TableCell className="text-right font-mono">{fmtMoney(trialBalance.total_credit, "EUR")}</TableCell>
                        <TableCell className="text-right font-mono">{trialBalance.total_debit_base ? fmtMoney(trialBalance.total_debit_base, trialBalance.base_currency ?? "EUR") : ""}</TableCell>
                        <TableCell className="text-right font-mono">{trialBalance.total_credit_base ? fmtMoney(trialBalance.total_credit_base, trialBalance.base_currency ?? "EUR") : ""}</TableCell>
                        <TableCell></TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Balance Sheet */}
        <TabsContent value="balance_sheet">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <CardTitle className="text-lg">{lbl("balance-sheet")}</CardTitle>
                <div className="flex items-center gap-3">
                  <Label className="text-sm">{lbl("as-of-date")}</Label>
                  <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="w-44" />
                  <Button variant="outline" size="sm" disabled>
                    <Download className="size-4 mr-1" />{lbl("export-report")}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {balanceSheetQ.isLoading ? (
                <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : !balanceSheet ? (
                <EmptyState icon={<FileBarChart />} title={lbl("no-report-data")} />
              ) : (
                <div className="space-y-6">
                  {/* Assets */}
                  <div>
                    <h3 className="text-base font-semibold mb-2 text-sky-700 dark:text-sky-400">{lbl("assets")}</h3>
                    <BalanceSheetTable items={balanceSheet.assets} />
                    <div className="text-right mt-2 font-bold text-sm">{lbl("fin-total-assets-inline")}: {fmtMoney(balanceSheet.total_assets, "EUR")}{balanceSheet.total_assets_base ? <span className="ml-2 text-xs font-normal text-muted-foreground">≈ {fmtMoney(balanceSheet.total_assets_base, balanceSheet.base_currency ?? "EUR")}</span> : null}</div>
                  </div>
                  {/* Liabilities */}
                  <div>
                    <h3 className="text-base font-semibold mb-2 text-red-700 dark:text-red-400">{lbl("liabilities")}</h3>
                    <BalanceSheetTable items={balanceSheet.liabilities} />
                    <div className="text-right mt-2 font-bold text-sm">{lbl("fin-total-liabilities-inline")}: {fmtMoney(balanceSheet.total_liabilities, "EUR")}{balanceSheet.total_liabilities_base ? <span className="ml-2 text-xs font-normal text-muted-foreground">≈ {fmtMoney(balanceSheet.total_liabilities_base, balanceSheet.base_currency ?? "EUR")}</span> : null}</div>
                  </div>
                  {/* Equity */}
                  <div>
                    <h3 className="text-base font-semibold mb-2 text-purple-700 dark:text-purple-400">{lbl("equity")}</h3>
                    <BalanceSheetTable items={balanceSheet.equity} />
                    <div className="text-right mt-2 font-bold text-sm">{lbl("fin-total-equity-inline")}: {fmtMoney(balanceSheet.total_equity, "EUR")}{balanceSheet.total_equity_base ? <span className="ml-2 text-xs font-normal text-muted-foreground">≈ {fmtMoney(balanceSheet.total_equity_base, balanceSheet.base_currency ?? "EUR")}</span> : null}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Profit & Loss */}
        <TabsContent value="profit_and_loss">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <CardTitle className="text-lg">{lbl("profit-and-loss")}</CardTitle>
                <div className="flex items-center gap-3">
                  <Label className="text-sm">{lbl("period-start")}</Label>
                  <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="w-40" />
                  <Label className="text-sm">{lbl("period-end")}</Label>
                  <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-40" />
                  <Button variant="outline" size="sm" disabled>
                    <Download className="size-4 mr-1" />{lbl("export-report")}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {profitAndLossQ.isLoading ? (
                <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : !profitAndLoss ? (
                <EmptyState icon={<FileBarChart />} title={lbl("no-report-data")} />
              ) : (
                <div className="space-y-6">
                  {/* Revenue */}
                  <div>
                    <h3 className="text-base font-semibold mb-2 text-emerald-700 dark:text-emerald-400">{lbl("revenue")}</h3>
                    <BalanceSheetTable items={profitAndLoss.revenue} />
                    <div className="text-right mt-2 font-bold text-sm">{lbl("fin-total-revenue-inline")}: {fmtMoney(profitAndLoss.total_revenue, "EUR")}{profitAndLoss.total_revenue_base ? <span className="ml-2 text-xs font-normal text-muted-foreground">≈ {fmtMoney(profitAndLoss.total_revenue_base, profitAndLoss.base_currency ?? "EUR")}</span> : null}</div>
                  </div>
                  {/* Expenses */}
                  <div>
                    <h3 className="text-base font-semibold mb-2 text-amber-700 dark:text-amber-400">{lbl("expenses")}</h3>
                    <BalanceSheetTable items={profitAndLoss.expenses} />
                    <div className="text-right mt-2 font-bold text-sm">{lbl("fin-total-expenses-inline")}: {fmtMoney(profitAndLoss.total_expenses, "EUR")}{profitAndLoss.total_expenses_base ? <span className="ml-2 text-xs font-normal text-muted-foreground">≈ {fmtMoney(profitAndLoss.total_expenses_base, profitAndLoss.base_currency ?? "EUR")}</span> : null}</div>
                  </div>
                  {/* Net Profit */}
                  <div className="border-t-2 pt-4">
                    <div className="text-right text-xl font-bold">
                      {lbl("net-profit-loss")}: {fmtMoney(profitAndLoss.net_profit, "EUR")}
                      {profitAndLoss.net_profit_base !== undefined && profitAndLoss.net_profit_base !== profitAndLoss.net_profit && (
                        <span className="ml-2 text-sm font-normal text-muted-foreground">≈ {fmtMoney(profitAndLoss.net_profit_base, profitAndLoss.base_currency ?? "EUR")}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ─── Helper: Balance Sheet Table ─────────────────────────────────────── */

function BalanceSheetTable({ items }: { items: BalanceSheetItem[] }) {
  const t = useT();
  if (!items || items.length === 0) {
    return <div className="text-sm text-muted-foreground py-2">{t("fin-no-data")}</div>;
  }
  return (
    <div className={scrollbarStyle}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("fin-code")}</TableHead>
            <TableHead>{t("name")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
            {/* E-2: base-currency equivalent */}
            <TableHead className="text-right">{t("fin-base-amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, idx) => (
            <TableRow key={idx}>
              <TableCell className="font-mono">{item.account_code}</TableCell>
              <TableCell>{item.account_name}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(item.amount, "EUR")}</TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {item.amount_base ? fmtMoney(item.amount_base, "EUR") : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. ERP SETTINGS
   ═══════════════════════════════════════════════════════════════════════════ */

function ErpSettings() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();

  const lbl = useErpLabel();
  const qc = useQueryClient();

  const accountsQ = useQuery({
    queryKey: ["erp-accounts", tenantKey],
    queryFn: () => fetch(api("/api/erp/accounts")).then((r) => r.json()),
  });
  const accounts: ErpAccount[] = accountsQ.data?.items ?? accountsQ.data ?? [];

  const settingsQ = useQuery({
    queryKey: ["erp-settings", tenantKey],
    queryFn: () => fetch(api("/api/erp/settings")).then((r) => r.json()),
  });

  const settings: ErpSetting | null = settingsQ.data?.id ? settingsQ.data : null;

  const [form, setForm] = useState<SettingsForm>(emptySettings);

  // Sync form when settings load
  useState(() => {
    if (settings) {
      setForm({
        accounting_standard: settings.accounting_standard ?? "eu",
        fiscal_year_start: settings.fiscal_year_start ?? "01-01",
        fiscal_year_end: settings.fiscal_year_end ?? "12-31",
        default_currency: settings.default_currency ?? "EUR",
        vat_enabled: settings.vat_enabled ?? true,
        vat_rate: settings.vat_rate ?? 20,
        vat_return_period: settings.vat_return_period ?? "quarterly",
        auto_post_journal: settings.auto_post_journal ?? false,
        revenue_account_id: settings.revenue_account_id ?? "",
        expense_account_id: settings.expense_account_id ?? "",
        receivable_account_id: settings.receivable_account_id ?? "",
        payable_account_id: settings.payable_account_id ?? "",
        vat_account_id: settings.vat_account_id ?? "",
        bank_charges_account_id: settings.bank_charges_account_id ?? "",
        cash_account_id: settings.cash_account_id ?? "",
        retention_account_id: settings.retention_account_id ?? "",
        round_off_account_id: settings.round_off_account_id ?? "",
      });
    }
  });

  const saveMutation = useMutation({
    mutationFn: (data: SettingsForm) =>
      fetch(api("/api/erp/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success(lbl("fin-settings-saved"));
      qc.invalidateQueries({ queryKey: ["erp-settings", tenantKey] });
    },
    onError: () => toast.error(lbl("fin-failed-save-settings")),
  });

  function updateField<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm({ ...form, [key]: value });
  }

  if (settingsQ.isLoading) {
    return <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{lbl("accounting-standard")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label>{lbl("accounting-standard")}</Label>
              <Select value={form.accounting_standard} onValueChange={(v) => updateField("accounting_standard", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="eu">{lbl("fin-eu-ifrs")}</SelectItem>
                  <SelectItem value="uae">{lbl("fin-uae-ifrs")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("default-currency")}</Label>
              <Select value={form.default_currency} onValueChange={(v) => updateField("default_currency", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{lbl("fiscal-year-start")}</Label>
              <Input value={form.fiscal_year_start} onChange={(e) => updateField("fiscal_year_start", e.target.value)} placeholder="MM-DD" />
            </div>
            <div className="space-y-2">
              <Label>{lbl("fiscal-year-end")}</Label>
              <Input value={form.fiscal_year_end} onChange={(e) => updateField("fiscal_year_end", e.target.value)} placeholder="MM-DD" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{lbl("fin-vat-tax")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2 flex items-center gap-3">
              <Switch checked={form.vat_enabled} onCheckedChange={(v) => updateField("vat_enabled", v)} aria-label={lbl("vat-enabled")} />
              <Label>{lbl("vat-enabled")}</Label>
            </div>
            <div className="space-y-2">
              <Label>{lbl("vat-rate")}</Label>
              <Input type="number" step="0.1" value={form.vat_rate} onChange={(e) => updateField("vat_rate", parseFloat(e.target.value) || 0)} />
            </div>
            <div className="space-y-2">
              <Label>{lbl("vat-return-period")}</Label>
              <Select value={form.vat_return_period} onValueChange={(v) => updateField("vat_return_period", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VAT_RETURN_PERIODS.map((p) => <SelectItem key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 flex items-center gap-3">
              <Switch checked={form.auto_post_journal} onCheckedChange={(v) => updateField("auto_post_journal", v)} aria-label={lbl("auto-post-journal")} />
              <Label>{lbl("auto-post-journal")}</Label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{lbl("default-accounts")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <AccountSelect label={lbl("revenue-account")} value={form.revenue_account_id} onChange={(v) => updateField("revenue_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("expense-account")} value={form.expense_account_id} onChange={(v) => updateField("expense_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("receivable-account")} value={form.receivable_account_id} onChange={(v) => updateField("receivable_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("payable-account")} value={form.payable_account_id} onChange={(v) => updateField("payable_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("vat-account")} value={form.vat_account_id} onChange={(v) => updateField("vat_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("bank-charges-account")} value={form.bank_charges_account_id} onChange={(v) => updateField("bank_charges_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("cash-account")} value={form.cash_account_id} onChange={(v) => updateField("cash_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("retention-account")} value={form.retention_account_id} onChange={(v) => updateField("retention_account_id", v)} accounts={accounts} />
            <AccountSelect label={lbl("round-off-account")} value={form.round_off_account_id} onChange={(v) => updateField("round_off_account_id", v)} accounts={accounts} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending} className="min-w-[160px]">
          {saveMutation.isPending ? lbl("fin-saving") : lbl("save-settings")}
        </Button>
      </div>
    </div>
  );
}

/* ─── Helper: Account Select ───────────────────────────────────────────── */

function AccountSelect({ label, value, onChange, accounts }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  accounts: ErpAccount[];
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder={t("fin-select-account-placeholder")} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t("fin-none-option")}</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
