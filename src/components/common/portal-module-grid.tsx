"use client";

/**
 * PORTAL MODULE GRID — shared tri-state editor for the 099 portal module
 * permission system. Used by BOTH admin editors:
 *
 *   • partner-360-view.tsx  — per-USER overrides on a portal_access row
 *     (PUT /api/portal-access/[id]/permissions)
 *   • settings-view.tsx     — per-TENANT defaults in tenant_portal_defaults
 *     (GET/PUT /api/admin/portal-defaults)
 *
 * State contract: the draft is a `Record<string, boolean>` where a PRESENT
 * key is an explicit Allow(true) / Deny(false) and an ABSENT key means
 * "Inherit" — the exact wire format both APIs persist (inherit keys are
 * simply omitted; an empty draft clears the row with `null`).
 *
 * The module list, groups and label keys all come from the pure,
 * client-safe catalog in src/lib/portal/module-catalog.ts.
 */

import {
  PORTAL_MODULES,
  PORTAL_MODULE_KEYS,
  PORTAL_MODULE_GROUP_LABEL_KEYS,
  portalModuleLabelKey,
  type PortalModuleDef,
} from "@/lib/portal/module-catalog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";

// ─── Draft helpers (pure, exported for the two editors) ────────────────────

/** Draft map: present key = explicit override, absent key = inherit. */
export type ModulePermDraft = Record<string, boolean>;

/** Tri-state values used by the per-module Select. */
export type ModulePermValue = "inherit" | "allow" | "deny";

/** Fixed group render order (matches the catalog order). */
const PORTAL_MODULE_GROUP_ORDER: PortalModuleDef["group"][] = [
  "core", "documents", "trading", "marketplace", "comms", "logistics", "finance",
];

/**
 * Copy a server-side map (portal_access.module_permissions or
 * tenant_portal_defaults.modules) into a clean draft: known module keys
 * with boolean values only. Unknown / malformed entries are dropped —
 * defensive parity with the server-side sanitiser.
 */
export function initModulePermDraft(
  current: Record<string, boolean> | null | undefined,
): ModulePermDraft {
  const out: ModulePermDraft = {};
  if (!current || typeof current !== "object" || Array.isArray(current)) return out;
  for (const [k, v] of Object.entries(current)) {
    if (PORTAL_MODULE_KEYS.has(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * Build the request payload from a draft. Inherit keys are already absent
 * by construction; when NOTHING is overridden the result is `null`, which
 * both APIs treat as "clear the overrides / delete the defaults row" (the
 * tenant defaults / legacy booleans / open-by-default chain applies again).
 */
export function buildModulePermissionsPayload(
  draft: ModulePermDraft,
): ModulePermDraft | null {
  const out = initModulePermDraft(draft);
  return Object.keys(out).length > 0 ? out : null;
}

// ─── Grid component ────────────────────────────────────────────────────────

export function PortalModuleGrid({
  value,
  onChange,
  disabled,
}: {
  /** Current draft (present keys = explicit allow/deny). */
  value: ModulePermDraft;
  /** Called with the next draft whenever a module's tri-state changes. */
  onChange: (next: ModulePermDraft) => void;
  /** Disable every Select (e.g. while saving). */
  disabled?: boolean;
}) {
  const t = useT();

  function setKey(moduleKey: string, next: ModulePermValue) {
    const out = { ...value };
    if (next === "inherit") {
      delete out[moduleKey]; // back to inherited behaviour
    } else {
      out[moduleKey] = next === "allow";
    }
    onChange(out);
  }

  return (
    <div className="space-y-4">
      {PORTAL_MODULE_GROUP_ORDER.map((group) => {
        const mods = PORTAL_MODULES.filter((m) => m.group === group);
        if (mods.length === 0) return null;
        return (
          <div key={group} className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(PORTAL_MODULE_GROUP_LABEL_KEYS[group]) || group}
            </p>
            <div className="rounded-lg border border-border/60 divide-y divide-border/60 overflow-hidden">
              {mods.map((m) => (
                <div key={m.key}>
                  <ModuleRow
                    moduleKey={m.key}
                    value={value[m.key]}
                    onChange={(v) => setKey(m.key, v)}
                    disabled={disabled}
                    legacy={m.legacy}
                  />
                  {m.children?.map((child) => (
                    <ModuleRow
                      key={child}
                      moduleKey={child}
                      value={value[child]}
                      onChange={(v) => setKey(child, v)}
                      disabled={disabled}
                      submodule
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Row (label + tri-state Select) ────────────────────────────────────────

function ModuleRow({
  moduleKey, value, onChange, disabled, submodule, legacy,
}: {
  moduleKey: string;
  value: boolean | undefined;
  onChange: (v: ModulePermValue) => void;
  disabled?: boolean;
  submodule?: boolean;
  legacy?: boolean;
}) {
  const t = useT();
  const current: ModulePermValue =
    typeof value === "boolean" ? (value ? "allow" : "deny") : "inherit";

  return (
    <div
      className={cn(
        // Submodules are indented (pl-4) under their parent row and dimmed
        // so the hierarchy reads at a glance.
        "flex items-center justify-between gap-3 py-2 pr-3",
        submodule ? "pl-4 bg-muted/40" : "pl-3",
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            "text-sm truncate",
            submodule ? "text-muted-foreground" : "font-medium",
          )}
          title={moduleKey}
        >
          {t(portalModuleLabelKey(moduleKey)) || moduleKey}
        </span>
        {/* Modules whose fallback is one of the legacy 8 portal_access
            booleans — "Inherit" means "use the legacy flag". */}
        {legacy && !submodule && (
          <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
            {t("portal-module-legacy-flag") || "legacy"}
          </Badge>
        )}
      </div>
      <Select
        value={current}
        onValueChange={(v) => onChange(v as ModulePermValue)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-32 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">{t("portal-modules-inherit")}</SelectItem>
          <SelectItem value="allow">{t("portal-modules-allow")}</SelectItem>
          <SelectItem value="deny">{t("portal-modules-deny")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
