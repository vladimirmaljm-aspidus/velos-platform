"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, Save, RotateCcw, HelpCircle, Info } from "lucide-react";
import { useT } from "@/lib/i18n/store";

/* ───────────────────────────────────────────────────────────────────────
   Shared helpers for the super-admin settings tabs.

   D-AUDIT-3 redesign: every setting now exposes:
     • a plain-language title (not "TTL", not "maxAttempts")
     • a description of what it does
     • an "impact" line explaining what happens if you change it
     • a help-tooltip with more detail
     • a default-value badge where relevant
     • a unit suffix in human-readable form (minutes / hours / attempts)

   The new primitives below (`HelpTooltip`, `SettingRow`, `PresetButtons`,
   `InfoNote`, `SuperAdminExemptNote`, `ReadOnlyField`) enforce these
   invariants in a single place — the per-tab files just supply keys.
   ─────────────────────────────────────────────────────────────────────── */

export function SettingsCardHeader({
  title,
  description,
  dirty,
  saving,
  onSave,
  onReset,
  resetLabel,
  saveLabel,
}: {
  title: string;
  description: string;
  dirty: boolean;
  saving: boolean;
  onSave?: () => void;
  onReset?: () => void;
  resetLabel?: string;
  saveLabel?: string;
}) {
  const t = useT();
  const reset = resetLabel ?? t("pf-sa-reset");
  const save = saveLabel ?? t("pf-sa-save");
  return (
    <CardHeader className="pb-3">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base flex items-center gap-2">
            {title}
            {dirty && (
              <Badge
                variant="outline"
                className="text-xs uppercase tracking-wider bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
              >
                {t("pf-sa-unsaved")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs max-w-prose">{description}</CardDescription>
        </div>
        {(onSave || onReset) && (
          <div className="flex items-center gap-2 shrink-0">
            {onReset && (
              <Button variant="outline" size="sm" onClick={onReset} disabled={saving || !dirty}>
                <RotateCcw className="size-3.5 mr-1" /> {reset}
              </Button>
            )}
            {onSave && (
              <Button
                size="sm"
                onClick={onSave}
                disabled={saving || !dirty}
                className={dirty ? "bg-gradient-emerald text-white" : ""}
              >
                {saving ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Save className="size-3.5 mr-1" />}
                {save}
              </Button>
            )}
          </div>
        )}
      </div>
    </CardHeader>
  );
}

export function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-4 first:mt-0">
      <h4 className="text-sm font-medium">{children}</h4>
      <div className="h-px flex-1 bg-border/60" />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * HelpTooltip — small "?" icon button that surfaces a tooltip with
 * additional context for a setting. Used everywhere the description
 * doesn't tell the whole story.
 */
export function HelpTooltip({ content }: { content: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="More information"
            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            <HelpCircle className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs leading-relaxed">{content}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * SettingRow — the canonical layout for one configurable setting.
 *
 * Layout:
 *   ┌──────────────────────────────┬───────────────┐
 *   │ Label  (?)  [Default badge]  │  [Input]      │
 *   │ What it does (description)   │  unit         │
 *   │ What changes if you tweak it │               │
 *   └──────────────────────────────┴───────────────┘
 */
export function SettingRow({
  label,
  description,
  impact,
  tooltip,
  defaultBadge,
  recommended,
  unit,
  children,
}: {
  label: string;
  description?: string;
  impact?: string;
  tooltip?: string;
  defaultBadge?: string;
  recommended?: boolean;
  unit?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-start gap-3 py-2 border-b border-border/40 last:border-0">
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm font-medium">{label}</label>
          {tooltip && <HelpTooltip content={tooltip} />}
          {defaultBadge && (
            <Badge variant="outline" className="text-[9px] uppercase tracking-wider bg-muted/40 text-muted-foreground border-border">
              {t("pf-sa-default")}: {defaultBadge}
            </Badge>
          )}
          {recommended && (
            <Badge variant="outline" className="text-[9px] uppercase tracking-wider bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30">
              {t("pf-sa-recommended")}
            </Badge>
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground leading-snug">{description}</p>}
        {impact && (
          <p className="text-xs text-muted-foreground/80 leading-snug">
            <span className="font-medium text-foreground/70">{t("pf-sa-impact-label")} </span>
            {impact}
          </p>
        )}
      </div>
      <div className="md:w-44 flex items-center gap-2 justify-self-end">
        {children}
        {unit && <span className="text-xs text-muted-foreground whitespace-nowrap">{unit}</span>}
      </div>
    </div>
  );
}

/**
 * PresetButtons — a row of preset buttons (Strict / Balanced / Relaxed / Custom).
 * Active preset is highlighted. Clicking applies a set of values via the
 * `onApply` callback and lets the parent know which preset is currently
 * active via the `active` prop.
 */
export function PresetButtons<T extends string>({
  presets,
  active,
  onApply,
}: {
  presets: Array<{ value: T; label: string; recommended?: boolean }>;
  active: T | "custom";
  onApply: (preset: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      {presets.map((p) => {
        const isActive = active === p.value;
        return (
          <Button
            key={p.value}
            type="button"
            size="sm"
            variant={isActive ? "default" : "outline"}
            onClick={() => onApply(p.value)}
            className={isActive ? "bg-gradient-emerald text-white" : ""}
          >
            {p.label}
            {p.recommended && !isActive && (
              <span className="ml-1.5 text-[9px] uppercase tracking-wider bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 rounded px-1">
                rec
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * InfoNote — a non-editable card section that explains a setting the
 * super-admin can't actually change (e.g., CSRF defense is always on,
 * Sentry sample-rate is env-only). Replaces what used to be a
 * non-functional toggle.
 */
export function InfoNote({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1">
      <div className="flex items-start gap-2">
        <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="space-y-1">
          {title && <p className="text-sm font-medium">{title}</p>}
          {description && <p className="text-xs text-muted-foreground leading-snug">{description}</p>}
          {children && <div className="text-xs text-muted-foreground leading-snug">{children}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * SuperAdminExemptNote — the standard "ℹ️ These settings don't apply
 * to Super Admin" footnote shown under every security-related card.
 */
export function SuperAdminExemptNote() {
  const t = useT();
  return <InfoNote description={t("pf-sa-superadmin-exempt")} />;
}

/**
 * ReadOnlyField — shows a value as a read-only badge, used for
 * settings whose actual value comes from the environment / is hardcoded.
 */
export function ReadOnlyField({ value, tone = "info" }: { value: string; tone?: "info" | "ok" | "warn" | "critical" }) {
  const cls = {
    ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
    info: "bg-primary/10 text-primary border-primary/30",
    critical: "bg-destructive/10 text-destructive border-destructive/30",
  }[tone];
  return (
    <Badge variant="outline" className={`text-xs ${cls}`}>
      {value}
    </Badge>
  );
}

/**
 * FieldRow — the legacy grid layout (kept for tabs not yet migrated
 * to the new SettingRow primitive).
 */
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] items-start gap-3 py-1.5">
      <div className="space-y-1">
        <label className="text-sm font-medium">{label}</label>
        {hint && <p className="text-xs text-muted-foreground leading-snug">{hint}</p>}
      </div>
      <div className="md:w-40 flex items-center gap-2">{children}</div>
    </div>
  );
}

export function LoadingCard({ title }: { title: string }) {
  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 w-full rounded-md bg-muted/40 animate-pulse" />
        ))}
      </CardContent>
    </Card>
  );
}

export function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-destructive">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-destructive/90">{message}</p>
      </CardContent>
    </Card>
  );
}

export function dirtyEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
