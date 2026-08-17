"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/store";

/**
 * Permission catalog — every module the platform exposes, with the actions
 * each module supports. Used by <PermissionTree /> to render a grouped
 * checkbox tree instead of asking the user to type "module.action" by hand.
 *
 * Add new modules/actions here as the platform grows.
 */
export const PERMISSION_CATALOG: Record<
  string,
  { label: string; description: string; actions: string[] }
> = {
  partners: {
    label: "Partners",
    description: "Customers, suppliers, agents, customs, banks",
    actions: ["read", "create", "update", "delete", "export"],
  },
  products: {
    label: "Products",
    description: "Product master + stock",
    actions: ["read", "create", "update", "delete"],
  },
  deals: {
    label: "Deals",
    description: "Pipeline opportunities",
    actions: ["read", "create", "update", "delete"],
  },
  offers: {
    label: "Offers",
    description: "Quotes & proposals",
    actions: ["read", "create", "update", "delete", "send", "pdf"],
  },
  demands: {
    label: "Demands (RFQ)",
    description: "Inbound requests for quote",
    actions: ["read", "create", "update", "delete"],
  },
  invoices: {
    label: "Invoices",
    description: "Customer invoices",
    actions: ["read", "create", "update", "delete", "send", "pdf"],
  },
  proformas: {
    label: "Proformas",
    description: "Proforma invoices",
    actions: ["read", "create", "update", "delete", "send", "pdf"],
  },
  documents: {
    label: "Documents",
    description: "Shared document library",
    actions: ["read", "create", "update", "delete"],
  },
  tasks: {
    label: "Tasks",
    description: "Personal & assigned tasks",
    actions: ["read", "create", "update", "delete"],
  },
  inventory: {
    label: "Inventory",
    description: "Stock movements & warehouses",
    actions: ["read", "create", "update"],
  },
  vault: {
    label: "Vault",
    description: "Encrypted credentials & secrets",
    actions: ["read", "create", "update", "delete"],
  },
  portal: {
    label: "Portal Access",
    description: "Client portal accounts & invitations",
    actions: ["read", "create", "update", "delete", "invite"],
  },
  kyc: {
    label: "KYC",
    description: "Know-your-customer review & approval",
    actions: ["read", "approve", "reject"],
  },
  users: {
    label: "Users",
    description: "Internal team members",
    actions: ["read", "create", "update", "delete"],
  },
  tenants: {
    label: "Tenants",
    description: "Platform companies (super-admin only)",
    actions: ["read", "create", "update", "delete"],
  },
  audit: {
    label: "Audit Log",
    description: "Activity history",
    actions: ["read", "export"],
  },
  settings: {
    label: "Settings",
    description: "Tenant + system configuration",
    actions: ["read", "update"],
  },
  reports: {
    label: "Reports",
    description: "Dashboards & analytics",
    actions: ["read", "export"],
  },
  erp: {
    label: "ERP / Accounting",
    description: "Chart of accounts, journal entries, fiscal periods",
    actions: ["read", "create", "update", "delete", "post", "reverse"],
  },
  commissions: {
    label: "Commissions",
    description: "Agents, deal commissions, payouts",
    actions: ["read", "create", "update", "approve", "pay"],
  },
  webhooks: {
    label: "Webhooks",
    description: "Outbound integrations",
    actions: ["read", "create", "update", "delete"],
  },
  api_keys: {
    label: "API Keys",
    description: "Programmatic access tokens",
    actions: ["read", "create", "update", "delete"],
  },
  mail: {
    label: "Mail Queue",
    description: "Outbound email queue",
    actions: ["read", "update", "delete"],
  },
};

export type Permissions = string[] | null;

interface PermissionTreeProps {
  value: Permissions;
  onChange: (value: Permissions) => void;
  /** When true, the tree is shown but inputs are disabled (read-only). */
  disabled?: boolean;
  /** Compact mode hides the per-module descriptions. */
  compact?: boolean;
}

/**
 * Grouped checkbox tree for picking granular permissions.
 *
 * - Checking a module header toggles all of its actions.
 * - Checking every action in a module promotes the header to "checked".
 * - The special "*" entry is exposed as a single "Full access" toggle at the
 *   top — turning it on clears everything else (since * already implies all).
 */
export function PermissionTree({
  value,
  onChange,
  disabled,
  compact,
}: PermissionTreeProps) {
  const t = useT();
  const selected = React.useMemo(
    () => new Set(value || []),
    [value]
  );

  const hasWildcard = selected.has("*");

  const update = React.useCallback(
    (next: Set<string>) => {
      const arr = Array.from(next);
      onChange(arr.length ? arr : null);
    },
    [onChange]
  );

  const toggleAction = (module: string, action: string) => {
    if (disabled) return;
    const key = `${module}.${action}`;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // If user manually picks something, drop the "*" wildcard
    next.delete("*");
    update(next);
  };

  const toggleModule = (module: string, allActions: string[]) => {
    if (disabled) return;
    const allChecked = allActions.every((a) => selected.has(`${module}.${a}`));
    const next = new Set(selected);
    next.delete("*");
    if (allChecked) {
      allActions.forEach((a) => next.delete(`${module}.${a}`));
    } else {
      allActions.forEach((a) => next.add(`${module}.${a}`));
    }
    update(next);
  };

  const toggleWildcard = () => {
    if (disabled) return;
    const next = new Set<string>();
    if (!hasWildcard) next.add("*");
    update(next);
  };

  return (
    <div className="space-y-3">
      {/* Top bar: full access + quick actions */}
      <div className="flex items-center justify-between gap-2 p-3 rounded-lg border border-border/60 bg-muted/30">
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <Checkbox
            checked={hasWildcard}
            onCheckedChange={toggleWildcard}
            disabled={disabled}
          />
          <span className="text-sm font-medium">{t("admin-perm-full-access")}</span>
          <Badge variant="secondary" className="text-[10px] font-mono">*</Badge>
        </label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={disabled || hasWildcard}
            onClick={() => {
              const next = new Set<string>();
              Object.entries(PERMISSION_CATALOG).forEach(([mod, def]) =>
                def.actions.forEach((a) => next.add(`${mod}.${a}`))
              );
              update(next);
            }}
          >
            {t("admin-perm-select-all")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={disabled || selected.size === 0}
            onClick={() => update(new Set())}
          >
            {t("admin-perm-clear")}
          </Button>
        </div>
      </div>

      {/* Module tree */}
      <div
        className={cn(
          "rounded-lg border border-border/60 divide-y divide-border/60",
          hasWildcard && "opacity-50 pointer-events-none"
        )}
      >
        {Object.entries(PERMISSION_CATALOG).map(([module, def]) => {
          const allActions = def.actions;
          const checkedCount = allActions.filter((a) =>
            selected.has(`${module}.${a}`)
          ).length;
          const allChecked = checkedCount === allActions.length;
          const someChecked = checkedCount > 0 && !allChecked;

          return (
            <ModuleRow
              key={module}
              module={module}
              label={def.label}
              description={def.description}
              actions={allActions}
              checkedCount={checkedCount}
              allChecked={allChecked}
              someChecked={someChecked}
              selected={selected}
              disabled={disabled}
              compact={compact}
              onToggleModule={() => toggleModule(module, allActions)}
              onToggleAction={(action) => toggleAction(module, action)}
            />
          );
        })}
      </div>

      {/* Summary footer */}
      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span>
          {hasWildcard
            ? t("admin-perm-full-access-desc")
            : t("admin-perm-count").replace("{n}", String(selected.size))}
        </span>
        {!hasWildcard && selected.size > 0 && (
          <button
            type="button"
            className="hover:text-foreground underline underline-offset-2"
            onClick={() => update(new Set())}
            disabled={disabled}
          >
            {t("admin-perm-reset")}
          </button>
        )}
      </div>
    </div>
  );
}

interface ModuleRowProps {
  module: string;
  label: string;
  description: string;
  actions: string[];
  checkedCount: number;
  allChecked: boolean;
  someChecked: boolean;
  selected: Set<string>;
  disabled?: boolean;
  compact?: boolean;
  onToggleModule: () => void;
  onToggleAction: (action: string) => void;
}

function ModuleRow({
  module,
  label,
  description,
  actions,
  checkedCount,
  allChecked,
  someChecked,
  selected,
  disabled,
  compact,
  onToggleModule,
  onToggleAction,
}: ModuleRowProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="bg-card">
      {/* Module header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground smooth shrink-0"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
        <Checkbox
          checked={allChecked ? true : someChecked ? "indeterminate" : false}
          onCheckedChange={onToggleModule}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between text-left smooth"
        >
          <div className="min-w-0">
            <span className="text-sm font-medium">{label}</span>
            {!compact && (
              <span className="ml-2 text-xs text-muted-foreground">
                {description}
              </span>
            )}
          </div>
          <Badge
            variant={checkedCount > 0 ? "default" : "secondary"}
            className="text-[10px] tabular-nums"
          >
            {checkedCount}/{actions.length}
          </Badge>
        </button>
      </div>

      {/* Actions list */}
      {open && (
        <div className="px-3 pb-3 pl-10 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {actions.map((action) => {
            const key = `${module}.${action}`;
            const isOn = selected.has(key);
            return (
              <label
                key={action}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer smooth",
                  isOn
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-muted/60 text-muted-foreground"
                )}
              >
                <Checkbox
                  checked={isOn}
                  onCheckedChange={() => onToggleAction(action)}
                  disabled={disabled}
                  className="size-3.5"
                />
                <span className="font-mono">{action}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
