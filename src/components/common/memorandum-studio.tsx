"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MemorandumStudio (audit33) — the dedicated editor for the document FRAME.
//
// The memorandum is the single source of truth for the letterhead applied
// to EVERY generated PDF (offer / invoice / proforma / LOI):
//   header:  company name (left) + logo (right)
//   footer:  company address (left) + QR code (center) + page number (right)
// plus page setup (size + margins) and the body base typography.
//
// It is intentionally LOCKED from the document-template editor: what you
// edit here applies everywhere, and document templates only style the
// BODY (sections, order, tables, banks).
//
// Mount points: Document Templates view (first tab) and Settings →
// Memorandum. Both render this self-fetching component.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2, Eye, FileDown, Image as ImageIcon, Loader2, Lock, Palette,
  QrCode, RotateCcw, Ruler, Save, Type, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useApiUrl, useTenantKey } from "@/lib/hooks/use-api-url";
import { useT } from "@/lib/i18n/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { MemorandumSettings, Tenant, TenantLetterhead } from "@/lib/supabase/types";

// ─── Defaults (mirror migration 003 + 090 column defaults) ───────────────────

const DEFAULT_MEMO: MemorandumSettings = {
  id: "", tenant_id: "", created_at: "", updated_at: "",
  header_enabled: true, header_height_mm: 30, header_bg_color: "#ffffff",
  header_left_font_family: "NotoSans", header_left_font_size: 14,
  header_left_font_color: "#0d9488", header_left_font_bold: true,
  logo_enabled: true, logo_max_width_mm: 50, logo_max_height_mm: 20,
  logo_position_x_mm: 0, logo_position_y_mm: 0, logo_fit_mode: "contain",
  footer_enabled: true, footer_height_mm: 25, footer_bg_color: "#ffffff",
  qr_enabled: true, qr_size_mm: 15, qr_position_x_mm: 0, qr_position_y_mm: 0,
  footer_center_font_family: "NotoSans", footer_center_font_size: 7,
  footer_center_font_color: "#888888", footer_center_alignment: "center",
  footer_right_font_family: "NotoSans", footer_right_font_size: 8,
  footer_right_font_color: "#666666",
  footer_left_width_pct: 30, footer_center_width_pct: 40, footer_right_width_pct: 30,
  body_font_family: "NotoSans", body_font_size: 9, body_line_height: 1.4,
  body_text_color: "#1a1a1a", primary_color: "#0d9488",
  // audit33 frame columns
  page_size: "A4",
  margin_top_mm: 20, margin_bottom_mm: 20, margin_left_mm: 15, margin_right_mm: 15,
  header_border_enabled: true, header_border_color: null, header_border_width: 2,
  header_show_subtitle: false, logo_side: "right",
  footer_left_enabled: true, footer_left_font_family: "NotoSans",
  footer_left_font_size: 8, footer_left_font_color: "#666666",
  footer_address_source: "tenant", footer_address_custom: "",
  footer_show_contact: false,
  qr_position: "center", qr_opacity: 1,
  footer_border_enabled: true, footer_border_color: "#cccccc",
  page_number_enabled: true,
};

// ─── Font helpers ────────────────────────────────────────────────────────────

const FONT_OPTIONS = [
  { value: "NotoSans", label: "Noto Sans", css: "Noto Sans, Inter, system-ui, sans-serif" },
  { value: "Times-Roman", label: "Times", css: "'Times New Roman', Times, serif" },
  { value: "Courier", label: "Courier", css: "'Courier New', Courier, monospace" },
];

function fontCss(family: string | null | undefined): string {
  return FONT_OPTIONS.find((f) => f.value === family)?.css
    ?? FONT_OPTIONS.find((f) => f.value === (family || "").split(",")[0].trim())?.css
    ?? FONT_OPTIONS[0].css;
}

// ─── Small control primitives ────────────────────────────────────────────────

function ColorField({ label, value, onChange, allowEmpty }: {
  label: string; value: string | null | undefined; onChange: (v: string) => void; allowEmpty?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <div className="relative size-8 shrink-0 overflow-hidden rounded-md border border-input">
          <input
            type="color"
            value={value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            aria-label={label}
          />
          <div className="size-full" style={{ backgroundColor: value || "transparent" }} />
        </div>
        <Input
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={allowEmpty ? "auto" : "#rrggbb"}
          className="h-8 flex-1 font-mono text-xs"
        />
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, min, max, step, suffix }: {
  label: string; value: number | undefined; onChange: (v: number) => void;
  min: number; max: number; step?: number; suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        {label}{suffix ? <span className="ml-1 opacity-60">{suffix}</span> : null}
      </Label>
      <Input
        type="number"
        value={value ?? 0}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="h-8"
      />
    </div>
  );
}

function ToggleRow({ label, checked, onChange, hint }: {
  label: string; checked: boolean | undefined; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch checked={checked ?? false} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function FontField({ label, value, onChange }: {
  label: string; value: string | null | undefined; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value ?? "NotoSans"} onValueChange={onChange}>
        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
        <SelectContent>
          {FONT_OPTIONS.map((f) => (
            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SectionCard({ icon: Icon, title, desc, children, badge }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string; desc?: string; children: React.ReactNode; badge?: React.ReactNode;
}) {
  return (
    <Card className="border-border/60 shadow-soft rounded-xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4 text-primary" />
          {title}
          {badge ? <span className="ml-auto">{badge}</span> : null}
        </CardTitle>
        {desc ? <CardDescription className="text-xs leading-relaxed">{desc}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

// ─── Live paper preview ──────────────────────────────────────────────────────

function MemorandumPaper({ settings, tenant, letterhead }: {
  settings: MemorandumSettings; tenant: Tenant | null; letterhead: TenantLetterhead | null;
}) {
  const t = useT();
  const pageW = settings.page_size === "Letter" ? 216 : 210;
  const pageH = settings.page_size === "Letter" ? 279 : 297;
  const scale = 1.9; // px per mm — fits ~420px preview width
  const mm = (v: number) => Math.max(0, v * scale);
  const pt = (v: number) => Math.max(4, v * 0.3528 * scale);

  const companyName = letterhead?.company_legal_name || letterhead?.company_name
    || tenant?.legal_name || tenant?.name || "Company";
  const subtitle = [letterhead?.company_city || tenant?.city, letterhead?.company_country || tenant?.country]
    .filter(Boolean).join(", ");

  const addressLines: string[] = [];
  if (settings.footer_address_source === "custom") {
    String(settings.footer_address_custom || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6)
      .forEach((l) => addressLines.push(l));
  } else {
    const lh = letterhead;
    const addr = lh?.company_address_line || tenant?.address_line || "";
    if (addr) addressLines.push(addr);
    const city = lh?.company_city || tenant?.city || "";
    const postal = lh?.company_postal_code || tenant?.postal_code || "";
    const country = lh?.company_country || tenant?.country || "";
    if (city || postal || country) {
      addressLines.push([[city, postal].filter(Boolean).join(" "), country].filter(Boolean).join(", "));
    }
    if (settings.footer_show_contact) {
      const phone = lh?.company_phone || tenant?.phone || "";
      const email = lh?.company_email || tenant?.email || "";
      if (phone || email) addressLines.push([phone, email].filter(Boolean).join(" · "));
      const web = lh?.company_website || tenant?.website || "";
      if (web) addressLines.push(web);
    }
  }

  const logoUrl = letterhead?.logo_url || tenant?.logo_url || null;
  const primary = settings.primary_color || "#0d9488";
  const nameColor = settings.header_left_font_color || primary;
  const headerBorderColor = settings.header_border_color || primary;
  const leftPct = Math.max(15, Math.min(60, settings.footer_left_width_pct || 30));
  const centerPct = Math.max(15, Math.min(60, settings.footer_center_width_pct || 40));
  const rightPct = Math.max(15, Math.min(60, settings.footer_right_width_pct || 30));
  const pctSum = leftPct + centerPct + rightPct;
  const qrHere = (zone: string) => settings.qr_enabled !== false && (settings.qr_position || "center") === zone;

  return (
    <div
      className="relative mx-auto flex flex-col overflow-hidden rounded-[2px] border border-border bg-white shadow-lg"
      style={{
        width: mm(pageW),
        minHeight: mm(pageH),
        fontFamily: fontCss(settings.body_font_family),
        color: settings.body_text_color || "#1a1a1a",
        backgroundColor: "#ffffff",
      }}
      role="img"
      aria-label={t("memo-live-preview")}
    >
      {/* Header — canonical: company name left + logo right */}
      {settings.header_enabled !== false && (
        <div
          className="flex shrink-0 items-center justify-between"
          style={{
            height: mm(settings.header_height_mm ?? 30),
            backgroundColor: settings.header_bg_color || "#ffffff",
            borderBottom: settings.header_border_enabled !== false
              ? `${Math.max(0.5, (settings.header_border_width ?? 2) * 0.3528 * scale)}px solid ${headerBorderColor}`
              : "none",
            paddingLeft: mm(settings.margin_left_mm ?? 15),
            paddingRight: mm(settings.margin_right_mm ?? 15),
          }}
        >
          <div className={cn("flex min-w-0 flex-col", (settings.logo_side === "left") ? "items-end pr-3" : "items-start")}>
            <div
              style={{
                fontSize: pt(settings.header_left_font_size ?? 14),
                fontFamily: fontCss(settings.header_left_font_family),
                fontWeight: settings.header_left_font_bold === false ? 400 : 700,
                color: nameColor,
                lineHeight: 1.2,
              }}
              className="truncate"
            >
              {companyName}
            </div>
            {settings.header_show_subtitle && subtitle ? (
              <div style={{ fontSize: pt(7.5), color: "#666", marginTop: 2 }}>{subtitle}</div>
            ) : null}
          </div>
          {settings.logo_enabled !== false && logoUrl ? (
            <div className={cn("shrink-0", (settings.logo_side === "left") ? "order-first pl-3" : "")}>
              <img
                src={logoUrl}
                alt=""
                style={{
                  maxWidth: mm(settings.logo_max_width_mm ?? 50),
                  maxHeight: mm(settings.logo_max_height_mm ?? 20),
                  objectFit: settings.logo_fit_mode === "cover" || settings.logo_fit_mode === "fill"
                    ? settings.logo_fit_mode : "contain",
                  marginLeft: mm(settings.logo_position_x_mm ?? 0),
                  marginTop: mm(settings.logo_position_y_mm ?? 0),
                }}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Body — sample content */}
      <div
        className="flex flex-1 flex-col gap-3"
        style={{
          paddingTop: 10, paddingBottom: 10,
          paddingLeft: mm(settings.margin_left_mm ?? 15),
          paddingRight: mm(settings.margin_right_mm ?? 15),
          fontSize: pt(settings.body_font_size ?? 9),
        }}
      >
        <div style={{ fontSize: pt(14), fontWeight: 700, color: primary, letterSpacing: 0.5 }}>
          {t("memo-preview-body-title")}
        </div>
        <div className="flex gap-2">
          <div className="flex-1 space-y-1.5">
            {[92, 100, 96, 88, 64].map((w, i) => (
              <div key={i} className="h-[3px] rounded-full bg-border" style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="w-[34%] space-y-1.5 rounded border border-border/70 p-2">
            {[100, 70, 85].map((w, i) => (
              <div key={i} className="h-[3px] rounded-full bg-border" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          {[100, 100, 74].map((w, i) => (
            <div key={i} className="h-[3px] rounded-full bg-border" style={{ width: `${w}%` }} />
          ))}
        </div>
        <div
          className="rounded border border-border/70 px-2 py-1.5 text-center"
          style={{ fontSize: pt(6.5), color: "#999" }}
        >
          {t("memo-preview-body-note")}
        </div>
      </div>

      {/* Footer — canonical: address left · QR center · page number right */}
      {settings.footer_enabled !== false && (
        <div
          className="flex shrink-0 items-start"
          style={{
            height: mm(settings.footer_height_mm ?? 25),
            backgroundColor: settings.footer_bg_color || "#ffffff",
            borderTop: settings.footer_border_enabled !== false
              ? `1px solid ${settings.footer_border_color || "#cccccc"}` : "none",
            paddingLeft: mm(settings.margin_left_mm ?? 15),
            paddingRight: mm(settings.margin_right_mm ?? 15),
            paddingTop: 5,
          }}
        >
          {/* LEFT zone */}
          <div style={{ width: `${(leftPct / pctSum) * 100}%` }} className="flex min-w-0 flex-col gap-[2px] pr-2">
            {qrHere("left") ? <QrPlaceholder settings={settings} /> : null}
            {settings.footer_left_enabled !== false && addressLines.map((l, i) => (
              <div
                key={i}
                style={{
                  fontSize: pt(settings.footer_left_font_size ?? 8),
                  fontFamily: fontCss(settings.footer_left_font_family),
                  color: settings.footer_left_font_color || "#666",
                  lineHeight: 1.25,
                }}
                className="truncate"
              >
                {l}
              </div>
            ))}
          </div>
          {/* CENTER zone */}
          <div style={{ width: `${(centerPct / pctSum) * 100}%` }} className="flex min-w-0 flex-col items-center gap-[2px]">
            {qrHere("center") ? <QrPlaceholder settings={settings} /> : null}
            <div
              style={{
                fontSize: pt(settings.footer_center_font_size ?? 7),
                fontFamily: fontCss(settings.footer_center_font_family),
                color: settings.footer_center_font_color || "#888",
              }}
              className="max-w-full truncate text-center"
            >
              This document is computer generated… (template note)
            </div>
          </div>
          {/* RIGHT zone */}
          <div style={{ width: `${(rightPct / pctSum) * 100}%` }} className="flex min-w-0 flex-col items-end gap-[2px] pl-2">
            {qrHere("right") ? <QrPlaceholder settings={settings} /> : null}
            {settings.page_number_enabled !== false ? (
              <div
                style={{
                  fontSize: pt(settings.footer_right_font_size ?? 8),
                  fontFamily: fontCss(settings.footer_right_font_family),
                  color: settings.footer_right_font_color || "#666",
                }}
              >
                Page 1 of 2
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function QrPlaceholder({ settings }: { settings: MemorandumSettings }) {
  const mm = (v: number) => Math.max(0, v * 1.9);
  return (
    <div
      className="flex flex-col items-center gap-[2px]"
      style={{ marginLeft: mm(settings.qr_position_x_mm ?? 0), marginTop: mm(settings.qr_position_y_mm ?? 0) }}
    >
      <div
        className="flex items-center justify-center rounded-[1px] border border-border bg-white"
        style={{ width: mm(settings.qr_size_mm ?? 15), height: mm(settings.qr_size_mm ?? 15), opacity: settings.qr_opacity ?? 1 }}
      >
        <QrCode className="text-foreground/60" style={{ width: "70%", height: "70%" }} aria-hidden />
      </div>
      <div style={{ fontSize: 4.5, color: "#aaa" }} className="text-center leading-none">Scan to verify</div>
    </div>
  );
}

// ─── The studio ──────────────────────────────────────────────────────────────

export function MemorandumStudio() {
  const api = useApiUrl();
  const tenantKey = useTenantKey();
  const t = useT();

  const [settings, setSettings] = useState<MemorandumSettings | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [letterhead, setLetterhead] = useState<TenantLetterhead | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [snapshot, setSnapshot] = useState("");
  const formSig = useMemo(() => JSON.stringify(settings), [settings]);
  const dirty = loading || formSig !== snapshot;

  const [previewMode, setPreviewMode] = useState<"draft" | "pdf">("draft");
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfSnapshot, setPdfSnapshot] = useState("");
  const pdfStale = !!previewUrl && formSig !== pdfSnapshot;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [memoRes, tenantRes, lhRes] = await Promise.all([
        fetch(api("/api/memorandum-settings")).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(api("/api/tenants")).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(api("/api/letterheads")).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (memoRes && typeof memoRes === "object") {
        // Merge DB row over defaults so pre-migration rows get the new
        // frame columns as client-side defaults.
        const merged = { ...DEFAULT_MEMO, ...memoRes } as MemorandumSettings;
        setSettings(merged);
        setSnapshot(JSON.stringify(merged));
      }
      if (tenantRes?.items?.length) setTenant(tenantRes.items[0] as Tenant);
      const lhItems: TenantLetterhead[] = lhRes?.items ?? [];
      setLetterhead(lhItems.find((l) => l.is_default) ?? lhItems[0] ?? null);
    } finally {
      setLoading(false);
    }
     
  }, [tenantKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
  }, [fetchAll]);

  // Revoke the blob when it changes/unmounts (state-closure pattern — the
  // repo forbids reading refs during render).
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function set<K extends keyof MemorandumSettings>(k: K, v: MemorandumSettings[K]) {
    setSettings((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const r = await fetch(api("/api/memorandum-settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to save");
      }
      const updated = await r.json();
      const merged = { ...DEFAULT_MEMO, ...updated } as MemorandumSettings;
      setSettings(merged);
      setSnapshot(JSON.stringify(merged));
      toast.success(t("memo-saved"));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message || t("memo-save-failed") : t("memo-save-failed"));
    } finally {
      setSaving(false);
    }
  }

  function restoreDefaults() {
    const restored = { ...DEFAULT_MEMO, id: settings?.id ?? "", tenant_id: settings?.tenant_id ?? "" };
    setSettings(restored);
    toast.info(t("memo-restore-defaults"));
  }

  async function generateRealPdf() {
    if (!settings || previewing) return;
    setPreviewing(true);
    try {
      const r = await fetch(api("/api/memorandum-settings/preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType: "offer", settings }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        toast.error((err as { error?: string }).error || t("memo-save-failed"));
        return;
      }
      const blob = await r.blob();
      if (!blob || blob.type !== "application/pdf" || blob.size < 500) {
        toast.error(t("memo-save-failed"));
        return;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      setPdfSnapshot(JSON.stringify(settings));
    } catch {
      toast.error(t("memo-save-failed"));
    } finally {
      setPreviewing(false);
    }
  }

  function handleModeSwitch(m: "draft" | "pdf") {
    setPreviewMode(m);
    if (m === "pdf" && !previewUrl && !previewing) void generateRealPdf();
  }

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(360px,460px)_1fr]">
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="hidden h-[720px] w-full rounded-xl lg:block" />
      </div>
    );
  }

  if (!settings) {
    return (
      <Card className="border-border/60 shadow-soft rounded-xl">
        <CardContent className="flex items-center gap-3 p-6">
          <Lock className="size-5 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground">
            Select a tenant context to configure the memorandum.
          </p>
        </CardContent>
      </Card>
    );
  }

  const widthSum = (settings.footer_left_width_pct ?? 30) + (settings.footer_center_width_pct ?? 40) + (settings.footer_right_width_pct ?? 30);

  return (
    <div className="space-y-4">
      {/* ── Header: title + actions ── */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold leading-tight">
            <Building2 className="size-5 text-primary" />
            {t("memo-studio-title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("memo-studio-desc")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && !loading && (
            <Badge variant="outline" className="gap-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {t("memo-dirty")}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={restoreDefaults}>
            <RotateCcw className="size-4" />
            <span className="ml-1.5 hidden sm:inline">{t("memo-restore-defaults")}</span>
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            <span className="ml-1.5">{t("memo-save")}</span>
          </Button>
        </div>
      </div>

      {/* ── Body: settings | live preview ── */}
      <div className="grid gap-6 xl:grid-cols-[minmax(360px,480px)_minmax(0,1fr)]">
        {/* LEFT — settings */}
        <div className="custom-scroll max-h-[min(78vh,860px)] space-y-4 overflow-y-auto pr-1">

          {/* Page setup */}
          <SectionCard icon={Ruler} title={t("memo-page-setup")}>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("memo-page-size")}</Label>
                <Select value={settings.page_size ?? "A4"} onValueChange={(v) => set("page_size", v)}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A4">A4 (210 × 297 mm)</SelectItem>
                    <SelectItem value="Letter">Letter (216 × 279 mm)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumField label={t("memo-margin-top")} suffix="mm" value={settings.margin_top_mm} onChange={(v) => set("margin_top_mm", v)} min={5} max={60} />
                <NumField label={t("memo-margin-bottom")} suffix="mm" value={settings.margin_bottom_mm} onChange={(v) => set("margin_bottom_mm", v)} min={5} max={60} />
                <NumField label={t("memo-margin-left")} suffix="mm" value={settings.margin_left_mm} onChange={(v) => set("margin_left_mm", v)} min={5} max={50} />
                <NumField label={t("memo-margin-right")} suffix="mm" value={settings.margin_right_mm} onChange={(v) => set("margin_right_mm", v)} min={5} max={50} />
              </div>
            </div>
          </SectionCard>

          {/* Header */}
          <SectionCard icon={Eye} title={t("memo-header-section")} desc={t("memo-header-desc")}>
            <ToggleRow label={t("memo-header-section")} checked={settings.header_enabled} onChange={(v) => set("header_enabled", v)} />
            {settings.header_enabled !== false && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <NumField label={t("memo-height-mm")} suffix="mm" value={settings.header_height_mm} onChange={(v) => set("header_height_mm", v)} min={10} max={80} />
                  <ColorField label={t("memo-bg-color")} value={settings.header_bg_color ?? "#ffffff"} onChange={(v) => set("header_bg_color", v)} />
                </div>
                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-company-name")}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <FontField label={t("memo-font")} value={settings.header_left_font_family} onChange={(v) => set("header_left_font_family", v)} />
                    <NumField label={t("memo-font-size")} suffix="pt" value={settings.header_left_font_size} onChange={(v) => set("header_left_font_size", v)} min={8} max={28} />
                    <ColorField label={t("memo-color")} value={settings.header_left_font_color} onChange={(v) => set("header_left_font_color", v)} />
                    <ToggleRow label={t("memo-bold")} checked={settings.header_left_font_bold} onChange={(v) => set("header_left_font_bold", v)} />
                  </div>
                  <ToggleRow label={t("memo-show-subtitle")} hint={t("memo-subtitle-preview")} checked={settings.header_show_subtitle} onChange={(v) => set("header_show_subtitle", v)} />
                </div>
                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-logo")}</div>
                  <ToggleRow label={t("memo-logo")} checked={settings.logo_enabled} onChange={(v) => set("logo_enabled", v)} hint={t("memo-no-logo")} />
                  {settings.logo_enabled !== false && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">{t("memo-logo-side")}</Label>
                          <Select value={settings.logo_side ?? "right"} onValueChange={(v) => set("logo_side", v)}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="right">{t("memo-logo-side-right")}</SelectItem>
                              <SelectItem value="left">{t("memo-logo-side-left")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">{t("memo-logo-fit")}</Label>
                          <Select value={settings.logo_fit_mode ?? "contain"} onValueChange={(v) => set("logo_fit_mode", v)}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="contain">{t("memo-fit-contain")}</SelectItem>
                              <SelectItem value="cover">{t("memo-fit-cover")}</SelectItem>
                              <SelectItem value="fill">{t("memo-fit-fill")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        <NumField label="W" suffix="mm" value={settings.logo_max_width_mm} onChange={(v) => set("logo_max_width_mm", v)} min={10} max={120} />
                        <NumField label="H" suffix="mm" value={settings.logo_max_height_mm} onChange={(v) => set("logo_max_height_mm", v)} min={5} max={60} />
                        <NumField label="ΔX" suffix="mm" value={settings.logo_position_x_mm} onChange={(v) => set("logo_position_x_mm", v)} min={-50} max={50} />
                        <NumField label="ΔY" suffix="mm" value={settings.logo_position_y_mm} onChange={(v) => set("logo_position_y_mm", v)} min={-50} max={50} />
                      </div>
                    </>
                  )}
                </div>
                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-border")}</div>
                  <ToggleRow label={t("memo-border")} checked={settings.header_border_enabled} onChange={(v) => set("header_border_enabled", v)} />
                  {settings.header_border_enabled !== false && (
                    <div className="grid grid-cols-2 gap-3">
                      <ColorField label={t("memo-border-color")} allowEmpty value={settings.header_border_color} onChange={(v) => set("header_border_color", v || null)} />
                      <NumField label={t("memo-border-width")} suffix="pt" value={settings.header_border_width} onChange={(v) => set("header_border_width", v)} min={0.25} max={6} step={0.25} />
                    </div>
                  )}
                </div>
              </>
            )}
          </SectionCard>

          {/* Footer */}
          <SectionCard icon={FileDown} title={t("memo-footer-section")} desc={t("memo-footer-desc")}>
            <ToggleRow label={t("memo-footer-section")} checked={settings.footer_enabled} onChange={(v) => set("footer_enabled", v)} />
            {settings.footer_enabled !== false && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <NumField label={t("memo-height-mm")} suffix="mm" value={settings.footer_height_mm} onChange={(v) => set("footer_height_mm", v)} min={10} max={60} />
                  <ColorField label={t("memo-bg-color")} value={settings.footer_bg_color ?? "#ffffff"} onChange={(v) => set("footer_bg_color", v)} />
                </div>
                <div className="rounded-lg border border-border/60 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-footer-widths")}</div>
                    <Badge variant="outline" className={cn("text-xs", Math.abs(widthSum - 100) > 2 && "border-amber-500/40 text-amber-600")}>
                      {t("memo-width-sum")}: {widthSum}%
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <NumField label={t("memo-footer-left")} value={settings.footer_left_width_pct} onChange={(v) => set("footer_left_width_pct", v)} min={15} max={60} suffix="%" />
                    <NumField label={t("memo-footer-center")} value={settings.footer_center_width_pct} onChange={(v) => set("footer_center_width_pct", v)} min={15} max={60} suffix="%" />
                    <NumField label={t("memo-footer-right")} value={settings.footer_right_width_pct} onChange={(v) => set("footer_right_width_pct", v)} min={15} max={60} suffix="%" />
                  </div>
                </div>

                {/* LEFT zone — address */}
                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-footer-left")}</div>
                  <ToggleRow label={t("memo-footer-left")} checked={settings.footer_left_enabled} onChange={(v) => set("footer_left_enabled", v)} />
                  {settings.footer_left_enabled !== false && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">{t("memo-address-source")}</Label>
                          <Select value={settings.footer_address_source ?? "tenant"} onValueChange={(v) => set("footer_address_source", v)}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="tenant">{t("memo-address-tenant")}</SelectItem>
                              <SelectItem value="custom">{t("memo-address-custom")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <FontField label={t("memo-font")} value={settings.footer_left_font_family} onChange={(v) => set("footer_left_font_family", v)} />
                        </div>
                      </div>
                      {settings.footer_address_source === "custom" ? (
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">{t("memo-address-custom")}</Label>
                          <Textarea
                            value={settings.footer_address_custom ?? ""}
                            onChange={(e) => set("footer_address_custom", e.target.value)}
                            placeholder={t("memo-address-custom-ph")}
                            rows={3}
                            className="text-sm"
                          />
                        </div>
                      ) : (
                        <ToggleRow label={t("memo-show-contact")} checked={settings.footer_show_contact} onChange={(v) => set("footer_show_contact", v)} />
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <NumField label={t("memo-font-size")} suffix="pt" value={settings.footer_left_font_size} onChange={(v) => set("footer_left_font_size", v)} min={5} max={12} />
                        <ColorField label={t("memo-color")} value={settings.footer_left_font_color} onChange={(v) => set("footer_left_font_color", v)} />
                      </div>
                    </>
                  )}
                </div>

                {/* CENTER zone — QR */}
                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-footer-center")}</div>
                  <ToggleRow label={t("memo-qr-code")} checked={settings.qr_enabled} onChange={(v) => set("qr_enabled", v)} />
                  {settings.qr_enabled !== false && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">{t("memo-qr-position")}</Label>
                          <Select value={settings.qr_position ?? "center"} onValueChange={(v) => set("qr_position", v)}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="center">{t("memo-qr-center")}</SelectItem>
                              <SelectItem value="left">{t("memo-qr-left")}</SelectItem>
                              <SelectItem value="right">{t("memo-qr-right")}</SelectItem>
                              <SelectItem value="none">{t("memo-qr-none")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <NumField label={t("memo-qr-size")} suffix="mm" value={settings.qr_size_mm} onChange={(v) => set("qr_size_mm", v)} min={8} max={30} />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <NumField label={t("memo-qr-opacity")} value={Math.round((settings.qr_opacity ?? 1) * 100)} onChange={(v) => set("qr_opacity", Math.min(100, Math.max(0, v)) / 100)} min={0} max={100} suffix="%" />
                        <NumField label="ΔX" suffix="mm" value={settings.qr_position_x_mm} onChange={(v) => set("qr_position_x_mm", v)} min={-30} max={30} />
                        <NumField label="ΔY" suffix="mm" value={settings.qr_position_y_mm} onChange={(v) => set("qr_position_y_mm", v)} min={-30} max={30} />
                      </div>
                    </>
                  )}
                  <div className="grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
                    <FontField label={t("memo-font")} value={settings.footer_center_font_family} onChange={(v) => set("footer_center_font_family", v)} />
                    <NumField label={t("memo-font-size")} suffix="pt" value={settings.footer_center_font_size} onChange={(v) => set("footer_center_font_size", v)} min={5} max={10} />
                    <ColorField label={t("memo-color")} value={settings.footer_center_font_color} onChange={(v) => set("footer_center_font_color", v)} />
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">{t("memo-footer-note-lines")}</p>
                </div>

                {/* RIGHT zone — page number */}
                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-footer-right")}</div>
                  <ToggleRow label={t("memo-page-number")} checked={settings.page_number_enabled} onChange={(v) => set("page_number_enabled", v)} />
                  {settings.page_number_enabled !== false && (
                    <div className="grid grid-cols-3 gap-2">
                      <FontField label={t("memo-font")} value={settings.footer_right_font_family} onChange={(v) => set("footer_right_font_family", v)} />
                      <NumField label={t("memo-font-size")} suffix="pt" value={settings.footer_right_font_size} onChange={(v) => set("footer_right_font_size", v)} min={5} max={12} />
                      <ColorField label={t("memo-color")} value={settings.footer_right_font_color} onChange={(v) => set("footer_right_font_color", v)} />
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("memo-border")}</div>
                  </div>
                  <ToggleRow label={t("memo-border")} checked={settings.footer_border_enabled} onChange={(v) => set("footer_border_enabled", v)} />
                  {settings.footer_border_enabled !== false && (
                    <div className="grid grid-cols-2 gap-3">
                      <ColorField label={t("memo-border-color")} value={settings.footer_border_color} onChange={(v) => set("footer_border_color", v)} />
                    </div>
                  )}
                </div>
              </>
            )}
          </SectionCard>

          {/* Body base */}
          <SectionCard icon={Type} title={t("memo-body-base")} desc={t("memo-body-base-desc")}>
            <div className="grid grid-cols-2 gap-3">
              <FontField label={t("memo-font")} value={settings.body_font_family} onChange={(v) => set("body_font_family", v)} />
              <NumField label={t("memo-font-size")} suffix="pt" value={settings.body_font_size} onChange={(v) => set("body_font_size", v)} min={7} max={14} />
              <ColorField label={t("memo-color")} value={settings.body_text_color} onChange={(v) => set("body_text_color", v)} />
              <ColorField label={t("memo-color") + " (brand)"} value={settings.primary_color} onChange={(v) => set("primary_color", v)} />
            </div>
          </SectionCard>
        </div>

        {/* RIGHT — preview */}
        <div className="xl:sticky xl:top-0 xl:self-start">
          <Tabs value={previewMode} onValueChange={(m) => handleModeSwitch(m as "draft" | "pdf")}>
            <div className="flex items-center gap-2">
              <TabsList>
                <TabsTrigger value="draft" className="gap-1.5">
                  <Zap className="size-3.5" /> {t("memo-live-preview")}
                </TabsTrigger>
                <TabsTrigger value="pdf" className="gap-1.5">
                  <FileDown className="size-3.5" /> {t("memo-real-pdf")}
                </TabsTrigger>
              </TabsList>
              {pdfStale && previewMode === "pdf" ? (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">{t("memo-dirty")}</Badge>
              ) : null}
            </div>
            <TabsContent value="draft" className="mt-4">
              <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4 sm:p-6">
                <MemorandumPaper settings={settings} tenant={tenant} letterhead={letterhead} />
              </div>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {tenant?.legal_name || tenant?.name || letterhead?.company_name || "—"}
              </p>
            </TabsContent>
            <TabsContent value="pdf" className="mt-4">
              <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/30">
                {previewing ? (
                  <div className="flex h-[720px] items-center justify-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Loader2 className="size-6 animate-spin" />
                      <span className="text-sm">Rendering…</span>
                    </div>
                  </div>
                ) : previewUrl ? (
                  <iframe title={t("memo-real-pdf")} src={previewUrl} className="h-[720px] w-full bg-white" />
                ) : (
                  <div className="flex h-[720px] items-center justify-center text-sm text-muted-foreground">
                    {t("memo-real-pdf-hint")}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
