"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ShieldCheck, Key, Lock } from "lucide-react";
import { toast } from "sonner";
import { useApiUrl } from "@/lib/hooks/use-api-url";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/store";
import {
  SettingsCardHeader,
  SectionLabel,
  SettingRow,
  PresetButtons,
  InfoNote,
  SuperAdminExemptNote,
  ReadOnlyField,
  LoadingCard,
  ErrorCard,
  dirtyEq,
} from "./_shared";

/* ───────────────────────────────────────────────────────────────────────
   SecuritySettings — D-AUDIT-3 redesign.

   Plain-language labels + descriptions + impact statements for every
   setting. Manual text inputs replaced by:
     • Dropdowns for session durations (1h / 4h / 8h / 12h / 24h / 7d)
     • Toggle switches for booleans (password char-class requirements)
     • Preset buttons for rate limits (Strict / Balanced / Relaxed / Custom)
     • Number inputs only where no enum makes sense (history count, expiry)

   Non-functional toggles removed:
     • CSRF "enforceOrigin" / "sameSiteStrict" → replaced with InfoNote
       explaining CSRF defense is always on (hard-coded in requireAuth).
     • Sentry "sampleRate" input → never reached this tab; that lives in
       MonitoringSettings where it's already shown as informational.
     • 2FA "force" toggles → replaced with InfoNote explaining 2FA is
       configured per-user, not via a platform-wide flag.
   ─────────────────────────────────────────────────────────────────────── */

interface SecurityConfig {
  totp: {
    forceSuperAdmin: boolean;
    forceAdmin: boolean;
    forceStaff: boolean;
    enrollmentGraceHours: number;
  };
  session: {
    superAdminTtlMinutes: number;
    adminTtlMinutes: number;
    userTtlMinutes: number;
    idleTimeoutMinutes: number;
    // FIX-V1 (Fix 6): maxConcurrentSessions removed from the UI — it
    // was saved to DB but never enforced (enforceConcurrentSessionLimit
    // hardcodes MAX_CONCURRENT_SESSIONS=5). Don't show settings that
    // don't work. Re-add when the runtime learns to read this field.
  };
  csrf: {
    enforceOrigin: boolean;
    sameSiteStrict: boolean;
  };
  passwordPolicy: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSymbols: boolean;
    // FIX-V1 (Fix 4): expiryDays + historyCount removed from the UI —
    // they were saved to DB but never read by any code (no
    // password_changed_at column, no password_history table). Don't
    // show settings that don't work. Re-add when the runtime learns to
    // enforce rotation / reuse prevention.
  };
}

/* Session-duration enum options (minutes). "Never" maps to a very large
   number that effectively means Infinity — the backend still exempts
   super-admin, but for staff/admin/user roles this is the dropdown. */
const SESSION_OPTIONS_MIN = [
  { value: 60, labelKey: "pf-sa-session-1h_short" },
  { value: 240, labelKey: "pf-sa-session-4h_short" },
  { value: 480, labelKey: "pf-sa-session-8h_short" },
  { value: 720, labelKey: "pf-sa-session-12h_short" },
  { value: 1440, labelKey: "pf-sa-session-24h_short" },
  { value: 10080, labelKey: "pf-sa-session-7d_short" },
];

const IDLE_OPTIONS_MIN = [
  { value: 30, labelKey: "pf-sa-session-30m_short" },
  { value: 60, labelKey: "pf-sa-session-1h_short" },
  { value: 240, labelKey: "pf-sa-session-4h_short" },
  { value: 480, labelKey: "pf-sa-session-8h_short" },
];

function nearestOption(value: number, options: { value: number }[]): number | null {
  const found = options.find((o) => o.value === value);
  return found ? found.value : null;
}

/* ─── Rate-limit presets ──────────────────────────────────────────────
   A preset is "active" when every IP limit matches it. The UI computes
   this dynamically and shows the matching preset (or "Custom"). */

type RatePreset = "strict" | "balanced" | "relaxed";

const PRESET_VALUES: Record<RatePreset, {
  loginMaxAttempts: number;
  loginWindowMin: number;
  portalLoginMaxAttempts: number;
  portalLoginWindowMin: number;
  forgotPasswordMaxAttempts: number;
  forgotPasswordWindowMin: number;
  setupPasswordMaxAttempts: number;
  setupPasswordWindowMin: number;
}> = {
  strict: {
    loginMaxAttempts: 5, loginWindowMin: 15,
    portalLoginMaxAttempts: 5, portalLoginWindowMin: 15,
    forgotPasswordMaxAttempts: 3, forgotPasswordWindowMin: 15,
    setupPasswordMaxAttempts: 5, setupPasswordWindowMin: 15,
  },
  balanced: {
    loginMaxAttempts: 20, loginWindowMin: 15,
    portalLoginMaxAttempts: 20, portalLoginWindowMin: 15,
    forgotPasswordMaxAttempts: 5, forgotPasswordWindowMin: 15,
    setupPasswordMaxAttempts: 10, setupPasswordWindowMin: 15,
  },
  relaxed: {
    loginMaxAttempts: 50, loginWindowMin: 15,
    portalLoginMaxAttempts: 50, portalLoginWindowMin: 15,
    forgotPasswordMaxAttempts: 10, forgotPasswordWindowMin: 15,
    setupPasswordMaxAttempts: 20, setupPasswordWindowMin: 15,
  },
};

interface RateForm {
  loginMaxAttempts: number;
  loginWindowMin: number;
  portalLoginMaxAttempts: number;
  portalLoginWindowMin: number;
  forgotPasswordMaxAttempts: number;
  forgotPasswordWindowMin: number;
  setupPasswordMaxAttempts: number;
  setupPasswordWindowMin: number;
  // FIX-V1 (Fix 5): middlewareLoginMaxRequests + middlewarePortalLoginMaxRequests
  // removed from the form — they were persisted to DB but never read by the
  // middleware (the middleware hardcodes 30/min for hot-path performance).
  // A read-only informational display below explains the hardcoded cap.
}

function detectPreset(form: RateForm): RatePreset | "custom" {
  for (const key of Object.keys(PRESET_VALUES) as RatePreset[]) {
    const p = PRESET_VALUES[key];
    if (
      form.loginMaxAttempts === p.loginMaxAttempts &&
      form.loginWindowMin === p.loginWindowMin &&
      form.portalLoginMaxAttempts === p.portalLoginMaxAttempts &&
      form.portalLoginWindowMin === p.portalLoginWindowMin &&
      form.forgotPasswordMaxAttempts === p.forgotPasswordMaxAttempts &&
      form.forgotPasswordWindowMin === p.forgotPasswordWindowMin &&
      form.setupPasswordMaxAttempts === p.setupPasswordMaxAttempts &&
      form.setupPasswordWindowMin === p.setupPasswordWindowMin
    ) {
      return key;
    }
  }
  return "custom";
}

const MS_PER_MIN = 60 * 1000;

export function SecuritySettings() {
  const api = useApiUrl();
  const qc = useQueryClient();
  const t = useT();

  const [config, setConfig] = React.useState<SecurityConfig | null>(null);
  const [defaults, setDefaults] = React.useState<SecurityConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Rate limits state — loaded/saved via /api/settings/rate-limits
  const [rateForm, setRateForm] = React.useState<RateForm | null>(null);
  const [rateDefaults, setRateDefaults] = React.useState<RateForm | null>(null);
  const [rateSaving, setRateSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [secRes, rateRes] = await Promise.all([
        fetch(api("/api/admin/security-settings"), { cache: "no-store" }),
        fetch(api("/api/settings/rate-limits"), { cache: "no-store" }),
      ]);
      if (!secRes.ok) throw new Error(`HTTP ${secRes.status}`);
      const sec = await secRes.json();
      setConfig(sec.config);
      setDefaults(sec.defaults);

      if (rateRes.ok) {
        const rd = await rateRes.json();
        const c = rd.config;
        const form: RateForm = {
          loginMaxAttempts: c.loginMaxAttempts,
          loginWindowMin: Math.round(c.loginWindowMs / MS_PER_MIN),
          portalLoginMaxAttempts: c.portalLoginMaxAttempts,
          portalLoginWindowMin: Math.round(c.portalLoginWindowMs / MS_PER_MIN),
          forgotPasswordMaxAttempts: c.forgotPasswordMaxAttempts,
          forgotPasswordWindowMin: Math.round(c.forgotPasswordWindowMs / MS_PER_MIN),
          setupPasswordMaxAttempts: c.setupPasswordMaxAttempts,
          setupPasswordWindowMin: Math.round(c.setupPasswordWindowMs / MS_PER_MIN),
        };
        setRateForm(form);
        const d = rd.defaults;
        setRateDefaults({
          loginMaxAttempts: d.loginMaxAttempts,
          loginWindowMin: Math.round(d.loginWindowMs / MS_PER_MIN),
          portalLoginMaxAttempts: d.portalLoginMaxAttempts,
          portalLoginWindowMin: Math.round(d.portalLoginWindowMs / MS_PER_MIN),
          forgotPasswordMaxAttempts: d.forgotPasswordMaxAttempts,
          forgotPasswordWindowMin: Math.round(d.forgotPasswordWindowMs / MS_PER_MIN),
          setupPasswordMaxAttempts: d.setupPasswordMaxAttempts,
          setupPasswordWindowMin: Math.round(d.setupPasswordWindowMs / MS_PER_MIN),
        });
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load security config");
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  function patchNested<K extends keyof SecurityConfig, SK extends keyof SecurityConfig[K]>(
    key: K, sub: SK, value: any,
  ) {
    setConfig((c) => {
      if (!c) return c;
      return { ...c, [key]: { ...(c[key] as any), [sub]: value } };
    });
  }

  function patchRateField<K extends keyof RateForm>(key: K, value: number) {
    setRateForm((f) => f ? { ...f, [key]: value } : f);
  }

  const dirty = config && defaults ? !dirtyEq(config, defaults) : false;
  const rateDirty = rateForm && rateDefaults ? !dirtyEq(rateForm, rateDefaults) : false;

  async function saveSecurity() {
    if (!config) return;
    setSaving(true);
    try {
      const r = await fetch(api("/api/admin/security-settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setConfig(d.config);
      toast.success(t("pf-sa-saved"), {
        description: t("pf-sa-sec-desc"),
      });
      qc.invalidateQueries({ queryKey: ["security-config"] });
    } catch (e: any) {
      toast.error("Failed to save security settings", { description: e?.message });
    } finally {
      setSaving(false);
    }
  }

  async function saveRateLimits() {
    if (!rateForm) return;
    setRateSaving(true);
    try {
      const payload = {
        loginMaxAttempts: rateForm.loginMaxAttempts,
        loginWindowMs: rateForm.loginWindowMin * MS_PER_MIN,
        portalLoginMaxAttempts: rateForm.portalLoginMaxAttempts,
        portalLoginWindowMs: rateForm.portalLoginWindowMin * MS_PER_MIN,
        forgotPasswordMaxAttempts: rateForm.forgotPasswordMaxAttempts,
        forgotPasswordWindowMs: rateForm.forgotPasswordWindowMin * MS_PER_MIN,
        setupPasswordMaxAttempts: rateForm.setupPasswordMaxAttempts,
        setupPasswordWindowMs: rateForm.setupPasswordWindowMin * MS_PER_MIN,
      };
      const r = await fetch(api("/api/settings/rate-limits"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.errors?.join(" ") || d.error || `HTTP ${r.status}`);
      const c = d.config;
      setRateForm({
        loginMaxAttempts: c.loginMaxAttempts,
        loginWindowMin: Math.round(c.loginWindowMs / MS_PER_MIN),
        portalLoginMaxAttempts: c.portalLoginMaxAttempts,
        portalLoginWindowMin: Math.round(c.portalLoginWindowMs / MS_PER_MIN),
        forgotPasswordMaxAttempts: c.forgotPasswordMaxAttempts,
        forgotPasswordWindowMin: Math.round(c.forgotPasswordWindowMs / MS_PER_MIN),
        setupPasswordMaxAttempts: c.setupPasswordMaxAttempts,
        setupPasswordWindowMin: Math.round(c.setupPasswordWindowMs / MS_PER_MIN),
      });
      toast.success(t("pf-sa-saved"), {
        description: t("pf-sa-sec-login-desc"),
      });
    } catch (e: any) {
      toast.error("Failed to save rate limits", { description: e?.message });
    } finally {
      setRateSaving(false);
    }
  }

  if (loading) return <LoadingCard title={t("pf-sa-sec-title")} />;
  if (error || !config) return <ErrorCard title={t("pf-sa-sec-title")} message={error || "No data"} />;

  const activePreset = rateForm ? detectPreset(rateForm) : "custom";

  return (
    <div className="space-y-6">
      {/* ── Login Protection (rate limits) ───────────────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-sec-login-title")}
          description={t("pf-sa-sec-login-desc")}
          dirty={!!rateDirty}
          saving={rateSaving}
          onSave={saveRateLimits}
          onReset={() => rateDefaults && setRateForm(rateDefaults)}
        />
        <CardContent className="space-y-4">
          <PresetButtons<RatePreset | "custom">
            active={activePreset}
            onApply={(p) => {
              if (p === "custom") return;
              setRateForm((f) => f ? { ...f, ...PRESET_VALUES[p] } : f);
            }}
            presets={[
              { value: "strict", label: t("pf-sa-sec-preset-strict") },
              { value: "balanced", label: t("pf-sa-sec-preset-balanced"), recommended: true },
              { value: "relaxed", label: t("pf-sa-sec-preset-relaxed") },
            ]}
          />
          <div className="text-[11px] text-muted-foreground leading-snug">
            {activePreset === "strict" && t("pf-sa-sec-preset-strict-desc")}
            {activePreset === "balanced" && t("pf-sa-sec-preset-balanced-desc")}
            {activePreset === "relaxed" && t("pf-sa-sec-preset-relaxed-desc")}
            {activePreset === "custom" && t("pf-sa-sec-preset-custom-desc")}
          </div>

          {rateForm && (
            <>
              <SectionLabel>{t("pf-sa-sec-staff-login-label")}</SectionLabel>
              <SettingRow
                label={t("pf-sa-sec-staff-login-label")}
                description={t("pf-sa-sec-staff-login-desc")}
                impact={t("pf-sa-sec-staff-login-impact")}
                tooltip={t("pf-sa-sec-staff-login-desc")}
                defaultBadge={String(rateDefaults?.loginMaxAttempts ?? 20)}
                unit={t("pf-sa-sec-attempts-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.loginMaxAttempts)}
                  onChange={(e) => patchRateField("loginMaxAttempts", Number(e.target.value))}
                />
              </SettingRow>
              <SettingRow
                label={t("pf-sa-sec-window-label")}
                description={t("pf-sa-sec-window-desc")}
                defaultBadge={`${rateDefaults?.loginWindowMin ?? 15}m`}
                unit={t("pf-sa-sec-minutes-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.loginWindowMin)}
                  onChange={(e) => patchRateField("loginWindowMin", Number(e.target.value))}
                />
              </SettingRow>

              <SectionLabel>{t("pf-sa-sec-portal-login-label")}</SectionLabel>
              <SettingRow
                label={t("pf-sa-sec-portal-login-label")}
                description={t("pf-sa-sec-portal-login-desc")}
                impact={t("pf-sa-sec-portal-login-impact")}
                defaultBadge={String(rateDefaults?.portalLoginMaxAttempts ?? 20)}
                unit={t("pf-sa-sec-attempts-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.portalLoginMaxAttempts)}
                  onChange={(e) => patchRateField("portalLoginMaxAttempts", Number(e.target.value))}
                />
              </SettingRow>
              <SettingRow
                label={t("pf-sa-sec-window-label")}
                description={t("pf-sa-sec-window-desc")}
                defaultBadge={`${rateDefaults?.portalLoginWindowMin ?? 15}m`}
                unit={t("pf-sa-sec-minutes-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.portalLoginWindowMin)}
                  onChange={(e) => patchRateField("portalLoginWindowMin", Number(e.target.value))}
                />
              </SettingRow>

              <SectionLabel>{t("pf-sa-sec-forgot-pwd-label")}</SectionLabel>
              <SettingRow
                label={t("pf-sa-sec-forgot-pwd-label")}
                description={t("pf-sa-sec-forgot-pwd-desc")}
                impact={t("pf-sa-sec-forgot-pwd-impact")}
                defaultBadge={String(rateDefaults?.forgotPasswordMaxAttempts ?? 5)}
                unit={t("pf-sa-sec-attempts-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.forgotPasswordMaxAttempts)}
                  onChange={(e) => patchRateField("forgotPasswordMaxAttempts", Number(e.target.value))}
                />
              </SettingRow>
              <SettingRow
                label={t("pf-sa-sec-window-label")}
                description={t("pf-sa-sec-window-desc")}
                defaultBadge={`${rateDefaults?.forgotPasswordWindowMin ?? 15}m`}
                unit={t("pf-sa-sec-minutes-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.forgotPasswordWindowMin)}
                  onChange={(e) => patchRateField("forgotPasswordWindowMin", Number(e.target.value))}
                />
              </SettingRow>

              <SectionLabel>{t("pf-sa-sec-setup-pwd-label")}</SectionLabel>
              <SettingRow
                label={t("pf-sa-sec-setup-pwd-label")}
                description={t("pf-sa-sec-setup-pwd-desc")}
                impact={t("pf-sa-sec-setup-pwd-impact")}
                defaultBadge={String(rateDefaults?.setupPasswordMaxAttempts ?? 10)}
                unit={t("pf-sa-sec-attempts-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.setupPasswordMaxAttempts)}
                  onChange={(e) => patchRateField("setupPasswordMaxAttempts", Number(e.target.value))}
                />
              </SettingRow>
              <SettingRow
                label={t("pf-sa-sec-window-label")}
                description={t("pf-sa-sec-window-desc")}
                defaultBadge={`${rateDefaults?.setupPasswordWindowMin ?? 15}m`}
                unit={t("pf-sa-sec-minutes-unit")}
              >
                <Input
                  type="number"
                  min={1}
                  className="w-24 tabular"
                  value={String(rateForm.setupPasswordWindowMin)}
                  onChange={(e) => patchRateField("setupPasswordWindowMin", Number(e.target.value))}
                />
              </SettingRow>

              {/* Per-user lockout (informational — wired in /api/auth/login) */}
              <SectionLabel>{t("pf-sa-sec-peruser-label")}</SectionLabel>
              <SettingRow
                label={t("pf-sa-sec-peruser-label")}
                description={t("pf-sa-sec-peruser-desc")}
                impact={t("pf-sa-sec-peruser-impact")}
                defaultBadge="5"
                unit={t("pf-sa-sec-attempts-unit")}
              >
                <ReadOnlyField value="5 / 15 min" tone="info" />
              </SettingRow>

              {/* FIX-V1 (Fix 5): middleware-level rate limit is hardcoded at
                  30 req/min for hot-path performance. The edge middleware
                  can't await a DB query per request without measurable
                  latency — so the cap is a transport-level defence. */}
              <SettingRow
                label="Middleware-level login cap (hardcoded)"
                description="Edge-middleware rate cap on /api/auth/login + /api/portal/login. Applied before the request reaches your app code, so it can't read DB-backed settings."
                impact="Defence-in-depth against a flood of login attempts at the edge. Tunable per-route caps above are enforced at the route handler (DB-backed)."
                tooltip="The edge middleware hardcodes 30 req/min per IP for login endpoints. This is intentional for hot-path performance — making the middleware await a DB query per request would add latency to every login."
              >
                <ReadOnlyField value="30 / 60s" tone="info" />
              </SettingRow>
            </>
          )}

          <SuperAdminExemptNote />
        </CardContent>
      </Card>

      {/* ── Session Duration ────────────────────────────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-session-title")}
          description={t("pf-sa-session-desc")}
          dirty={!dirtyEq(config.session, defaults?.session)}
          saving={saving}
          onSave={saveSecurity}
          onReset={() => defaults && patchNested("session", "adminTtlMinutes", defaults.session.adminTtlMinutes)}
        />
        <CardContent className="space-y-3">
          <SettingRow
            label={t("pf-sa-session-admin-label")}
            description={t("pf-sa-session-admin-desc")}
            impact={t("pf-sa-session-impact")}
            tooltip={t("pf-sa-session-admin-desc")}
            defaultBadge={`${Math.round((defaults?.session.adminTtlMinutes ?? 480) / 60)}h`}
          >
            <Select
              value={String(nearestOption(config.session.adminTtlMinutes, SESSION_OPTIONS_MIN) ?? "custom")}
              onValueChange={(v) => v !== "custom" && patchNested("session", "adminTtlMinutes", Number(v))}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SESSION_OPTIONS_MIN.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>{t(o.labelKey)}</SelectItem>
                ))}
                {nearestOption(config.session.adminTtlMinutes, SESSION_OPTIONS_MIN) === null && (
                  <SelectItem value="custom">{config.session.adminTtlMinutes}m</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label={t("pf-sa-session-user-label")}
            description={t("pf-sa-session-user-desc")}
            impact={t("pf-sa-session-impact")}
            tooltip={t("pf-sa-session-user-desc")}
            defaultBadge={`${Math.round((defaults?.session.userTtlMinutes ?? 480) / 60)}h`}
          >
            <Select
              value={String(nearestOption(config.session.userTtlMinutes, SESSION_OPTIONS_MIN) ?? "custom")}
              onValueChange={(v) => v !== "custom" && patchNested("session", "userTtlMinutes", Number(v))}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SESSION_OPTIONS_MIN.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>{t(o.labelKey)}</SelectItem>
                ))}
                {nearestOption(config.session.userTtlMinutes, SESSION_OPTIONS_MIN) === null && (
                  <SelectItem value="custom">{config.session.userTtlMinutes}m</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label={t("pf-sa-session-idle-label")}
            description={t("pf-sa-session-idle-desc")}
            impact={t("pf-sa-session-idle-impact")}
            tooltip={t("pf-sa-session-idle-desc")}
            defaultBadge={`${defaults?.session.idleTimeoutMinutes ?? 30}m`}
          >
            <Select
              value={String(nearestOption(config.session.idleTimeoutMinutes, IDLE_OPTIONS_MIN) ?? "custom")}
              onValueChange={(v) => v !== "custom" && patchNested("session", "idleTimeoutMinutes", Number(v))}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {IDLE_OPTIONS_MIN.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>{t(o.labelKey)}</SelectItem>
                ))}
                {nearestOption(config.session.idleTimeoutMinutes, IDLE_OPTIONS_MIN) === null && (
                  <SelectItem value="custom">{config.session.idleTimeoutMinutes}m</SelectItem>
                )}
              </SelectContent>
            </Select>
          </SettingRow>

          <SuperAdminExemptNote />
        </CardContent>
      </Card>

      {/* ── Two-Factor Authentication (informational) ───────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-2fa-title")}
          description={t("pf-sa-2fa-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-3">
          <InfoNote description={t("pf-sa-2fa-info")} />
          <p className="text-[11px] text-muted-foreground">{t("pf-sa-2fa-learn-more")}</p>
          <SuperAdminExemptNote />
        </CardContent>
      </Card>

      {/* ── Password Requirements ────────────────────────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-pwd-title")}
          description={t("pf-sa-pwd-desc")}
          dirty={!dirtyEq(config.passwordPolicy, defaults?.passwordPolicy)}
          saving={saving}
          onSave={saveSecurity}
          onReset={() => defaults && patchNested("passwordPolicy", "minLength", defaults.passwordPolicy.minLength)}
        />
        <CardContent className="space-y-3">
          <SettingRow
            label={t("pf-sa-pwd-min-length-label")}
            description={t("pf-sa-pwd-min-length-desc")}
            impact={t("pf-sa-pwd-min-length-impact")}
            tooltip={t("pf-sa-pwd-min-length-desc")}
            defaultBadge={String(defaults?.passwordPolicy.minLength ?? 8)}
          >
            <Input
              type="number"
              min={4}
              max={256}
              className="w-24 tabular"
              value={String(config.passwordPolicy.minLength)}
              onChange={(e) => patchNested("passwordPolicy", "minLength", Number(e.target.value))}
            />
          </SettingRow>

          <SettingRow
            label={t("pf-sa-pwd-req-upper-label")}
            description={t("pf-sa-pwd-req-upper-desc")}
            tooltip={t("pf-sa-pwd-req-upper-desc")}
          >
            <Switch
              checked={config.passwordPolicy.requireUppercase}
              onCheckedChange={(v) => patchNested("passwordPolicy", "requireUppercase", v)}
            />
          </SettingRow>

          <SettingRow
            label={t("pf-sa-pwd-req-lower-label")}
            description={t("pf-sa-pwd-req-lower-desc")}
            tooltip={t("pf-sa-pwd-req-lower-desc")}
          >
            <Switch
              checked={config.passwordPolicy.requireLowercase}
              onCheckedChange={(v) => patchNested("passwordPolicy", "requireLowercase", v)}
            />
          </SettingRow>

          <SettingRow
            label={t("pf-sa-pwd-req-num-label")}
            description={t("pf-sa-pwd-req-num-desc")}
            tooltip={t("pf-sa-pwd-req-num-desc")}
          >
            <Switch
              checked={config.passwordPolicy.requireNumbers}
              onCheckedChange={(v) => patchNested("passwordPolicy", "requireNumbers", v)}
            />
          </SettingRow>

          <SettingRow
            label={t("pf-sa-pwd-req-sym-label")}
            description={t("pf-sa-pwd-req-sym-desc")}
            impact={t("pf-sa-pwd-req-sym-impact")}
            tooltip={t("pf-sa-pwd-req-sym-desc")}
          >
            <Switch
              checked={config.passwordPolicy.requireSymbols}
              onCheckedChange={(v) => patchNested("passwordPolicy", "requireSymbols", v)}
            />
          </SettingRow>

          {/* FIX-V1 (Fix 4): expiryDays + historyCount inputs removed —
              they were saved to DB but never read by any code (no
              password_changed_at column on users, no password_history
              table). Don't show settings that don't work. Re-add when
              the runtime learns to enforce rotation / reuse
              prevention. The audit's verdict on both was
              "❌ DOESN'T WORK". */}
          <InfoNote description="Password rotation (expiry) and reuse prevention (history) are not enforced yet. The above minimum length + character-class toggles are the only policy knobs that take effect at password-set time." />
        </CardContent>
      </Card>

      {/* ── CSRF Defense (informational — always on) ────────────────── */}
      <Card className="border-border/60 shadow-soft rounded-xl">
        <SettingsCardHeader
          title={t("pf-sa-csrf-title")}
          description={t("pf-sa-csrf-desc")}
          dirty={false}
          saving={false}
        />
        <CardContent className="space-y-3">
          <SettingRow
            label={t("pf-sa-csrf-cookie-label")}
            description={t("pf-sa-csrf-cookie-desc")}
            tooltip={t("pf-sa-csrf-cookie-desc")}
          >
            <ReadOnlyField value={t("pf-sa-csrf-cookie-value")} tone="ok" />
          </SettingRow>
          <InfoNote description={t("pf-sa-csrf-desc")} />
        </CardContent>
      </Card>
    </div>
  );
}
