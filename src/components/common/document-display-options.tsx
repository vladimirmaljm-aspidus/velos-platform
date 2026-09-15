"use client";

import * as React from "react";
import { Settings2, ChevronDown, ChevronRight } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/store";
import type {
  DocumentNature,
  DocumentDisplayOptions,
  VatDisplayMode,
  TriStateVisibility,
} from "@/lib/supabase/types";

/**
 * DocumentDisplayOptions — per-document PDF controls (migration 105).
 *
 * What the generated document SHOWS and what it HIDES, saved onto the doc
 * row's display_options JSONB:
 *
 *   • Title      — custom wording ("Tax Invoice", "Fee Note"…) or the
 *                  default per doc type ("Invoice" / "Offer" / …).
 *   • Parties    — custom headers for the two party boxes. Services
 *                  documents default to SERVICE PROVIDER (CONSULTANT) /
 *                  CLIENT (not Seller/Buyer); goods keep FROM (SELLER) /
 *                  TO (BUYER). Free text — the issuer's wording wins.
 *   • VAT row    — Auto (factual amount only) / amount / the reverse-charge
 *                  legend / a custom note / hidden. The legend is an
 *                  explicit choice — it is never inferred from a zero
 *                  tax_total again.
 *   • Services   — period (cell + column, tri-state), place-of-service cell,
 *                  payment cell, quantity column.
 *   • Sections   — legal notice (+ custom text), amount in words, bank
 *                  details, signature block, QR verification code.
 *
 * Defaults are stored as ABSENT keys (auto/on) so legacy rows and untouched
 * documents keep the exact built-in rendering.
 */
export function DocumentDisplayOptions({
  value,
  onChange,
  nature,
  defaultTitle,
  className,
}: {
  value: DocumentDisplayOptions | null | undefined;
  onChange: (opts: DocumentDisplayOptions | null) => void;
  /** Services documents get the period / place / quantity controls. */
  nature: DocumentNature;
  /** Placeholder for the custom-title input ("Invoice", "Offer"…). */
  defaultTitle: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const isServices = nature === "services";
  const v = value || {};

  /** Merge a patch into the stored options. */
  const set = React.useCallback(
    (patch: Partial<DocumentDisplayOptions>) => {
      onChange({ ...v, ...patch });
    },
    [v, onChange],
  );
  /** Remove a key (back to the default) — drops the object when empty. */
  const clear = React.useCallback(
    (key: keyof DocumentDisplayOptions) => {
      const next = { ...v } as Record<string, unknown>;
      delete next[key as string];
      onChange(Object.keys(next).length > 0 ? (next as DocumentDisplayOptions) : null);
    },
    [v, onChange],
  );
  /** Boolean section switch, default ON: off stores false, on removes the key. */
  const sectionSwitch = (
    key: "show_notice" | "show_amount_words" | "show_bank_details" | "show_signatures" | "show_service_location" | "show_payment_terms" | "show_qr_code",
    label: string,
  ) => (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card px-3 py-2">
      <Label className="text-xs font-normal leading-snug">{label}</Label>
      <Switch
        checked={v[key] !== false}
        onCheckedChange={(on) => (on ? clear(key) : set({ [key]: false } as Partial<DocumentDisplayOptions>))}
        aria-label={label}
      />
    </div>
  );

  const vatMode: VatDisplayMode = v.vat_mode ?? "auto";
  const periodMode: TriStateVisibility = v.show_period ?? "auto";
  const activeCount = Object.keys(v).length;

  // Party box defaults per nature — services call the parties what they
  // are (SERVICE PROVIDER (CONSULTANT) / CLIENT); goods keep the classic
  // trade FROM (SELLER) / TO (BUYER). Shown as placeholders; typing
  // anything else overrides the PDF headers 1:1 (rendered uppercase).
  const defaultFromLabel = isServices ? "SERVICE PROVIDER (CONSULTANT)" : "FROM (SELLER)";
  const defaultToLabel = isServices ? "CLIENT" : "TO (BUYER)";

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
        <Settings2 className="size-4 text-muted-foreground" />
        <span>{t("fin-display-options")}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {t("fin-display-options-hint")}
        </span>
        {activeCount > 0 && (
          <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-4 rounded-lg border border-border/60 bg-muted/20 p-3">
          {/* ── Document group ── */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("fin-display-group-doc")}
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("fin-display-title-label")}</Label>
                <Input
                  className="h-9"
                  value={v.custom_title || ""}
                  onChange={(e) =>
                    e.target.value.trim()
                      ? set({ custom_title: e.target.value })
                      : clear("custom_title")
                  }
                  placeholder={defaultTitle}
                  aria-label={t("fin-display-title-label")}
                />
                <p className="text-[11px] text-muted-foreground">{t("fin-display-title-ph")}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("fin-display-vat-label")}</Label>
                <Select
                  value={vatMode}
                  onValueChange={(mode) =>
                    mode === "auto" ? clear("vat_mode") : set({ vat_mode: mode as VatDisplayMode })
                  }
                >
                  <SelectTrigger className="h-9" aria-label={t("fin-display-vat-label")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t("fin-display-vat-auto")}</SelectItem>
                    <SelectItem value="amount">{t("fin-display-vat-amount")}</SelectItem>
                    <SelectItem value="reverse_charge">{t("fin-display-vat-reverse")}</SelectItem>
                    <SelectItem value="custom">{t("fin-display-vat-custom")}</SelectItem>
                    <SelectItem value="hidden">{t("fin-display-vat-hidden")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {vatMode === "custom" && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("fin-display-vat-note-label")}</Label>
                <Input
                  className="h-9"
                  value={v.vat_custom_note || ""}
                  onChange={(e) =>
                    e.target.value.trim()
                      ? set({ vat_custom_note: e.target.value })
                      : clear("vat_custom_note")
                  }
                  placeholder={t("fin-display-vat-note-ph")}
                />
              </div>
            )}
          </div>

          {/* ── Parties group — custom headers for the two party boxes ── */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("fin-display-group-parties")}
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("fin-display-from-label")}</Label>
                <Input
                  className="h-9"
                  value={v.from_label || ""}
                  onChange={(e) =>
                    e.target.value.trim()
                      ? set({ from_label: e.target.value })
                      : clear("from_label")
                  }
                  placeholder={defaultFromLabel}
                  aria-label={t("fin-display-from-label")}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("fin-display-to-label")}</Label>
                <Input
                  className="h-9"
                  value={v.to_label || ""}
                  onChange={(e) =>
                    e.target.value.trim()
                      ? set({ to_label: e.target.value })
                      : clear("to_label")
                  }
                  placeholder={defaultToLabel}
                  aria-label={t("fin-display-to-label")}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("fin-display-parties-hint")}</p>
          </div>

          {/* ── Service fields group (services nature only) ── */}
          {isServices && (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("fin-display-group-svc")}
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("fin-display-period-label")}</Label>
                  <Select
                    value={periodMode}
                    onValueChange={(mode) =>
                      mode === "auto"
                        ? clear("show_period")
                        : set({ show_period: mode as TriStateVisibility })
                    }
                  >
                    <SelectTrigger className="h-9" aria-label={t("fin-display-period-label")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("fin-display-period-auto")}</SelectItem>
                      <SelectItem value="show">{t("fin-display-period-show")}</SelectItem>
                      <SelectItem value="hide">{t("fin-display-period-hide")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card px-3 py-2">
                  <Label className="text-xs font-normal leading-snug">{t("fin-display-qty-label")}</Label>
                  <Switch
                    checked={v.show_quantity !== "hide"}
                    onCheckedChange={(on) =>
                      on ? clear("show_quantity") : set({ show_quantity: "hide" })
                    }
                    aria-label={t("fin-display-qty-label")}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {sectionSwitch("show_service_location", t("fin-display-location-label"))}
                {sectionSwitch("show_payment_terms", t("fin-display-payment-label"))}
              </div>
            </div>
          )}

          {/* ── Sections group ── */}
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("fin-display-group-sec")}
            </p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {sectionSwitch("show_notice", t("fin-display-notice-label"))}
              {sectionSwitch("show_amount_words", t("fin-display-words-label"))}
              {sectionSwitch("show_bank_details", t("fin-display-bank-label"))}
              {sectionSwitch("show_signatures", t("fin-display-signatures-label"))}
              {sectionSwitch("show_qr_code", t("fin-display-qr-label"))}
            </div>
            {v.show_notice !== false && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("fin-display-notice-text-label")}</Label>
                <Textarea
                  rows={2}
                  value={v.custom_notice || ""}
                  onChange={(e) =>
                    e.target.value.trim()
                      ? set({ custom_notice: e.target.value })
                      : clear("custom_notice")
                  }
                  placeholder={t("fin-display-notice-ph")}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
