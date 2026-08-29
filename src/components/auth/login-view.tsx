"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  Lock,
  User,
  ArrowRight,
  ShieldCheck,
  TrendingUp,
  Globe,
  Eye,
  EyeOff,
  Building2,
  Sparkles,
  Store,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useI18nStore, useT } from "@/lib/i18n/store";

interface LoginViewProps {
  /** Switch to the registration surface (Sign Up link on the homepage). */
  onSwitchToRegister?: () => void;
}

export function LoginView({ onSwitchToRegister }: LoginViewProps) {
  const setUser = useAppStore((s) => s.setUser);
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // FIX-AUDIT3 #8 — 429 / 423 lockout countdown. When the API returns
  // a `Retry-After` (HTTP header, seconds) OR `retry_after` (JSON,
  // seconds) OR `locked_until` (JSON, ISO timestamp for 423), we
  // start a 1-second interval that decrements `lockCountdown` until
  // it reaches 0. While `lockCountdown > 0`, the inline error alert
  // shows a live "Try again in 2m 15s" message (re-computed every
  // tick) and the submit button is disabled. The user can still
  // click the existing "Forgot password?" link to reset.
  // `lockIsAccount` distinguishes the 423 (account temporarily
  // locked) message from the 429 (per-IP / per-user rate limit)
  // message — both flow through the same countdown UI.
  const [lockCountdown, setLockCountdown] = useState<number | null>(null);
  const [lockIsAccount, setLockIsAccount] = useState(false);
  const lockIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lockCountdown === null || lockCountdown <= 0) {
      if (lockIntervalRef.current) {
        clearTimeout(lockIntervalRef.current);
        lockIntervalRef.current = null;
      }
      if (lockCountdown === 0) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError("");
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLockCountdown(null);
      }
      return;
    }
    lockIntervalRef.current = setTimeout(() => {
      setLockCountdown((s) => (s ?? 0) - 1);
    }, 1000);
    return () => {
      if (lockIntervalRef.current) {
        clearTimeout(lockIntervalRef.current);
        lockIntervalRef.current = null;
      }
    };
  }, [lockCountdown]);

  function formatLockCountdown(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m >= 1) {
      return t("login-locked-countdown-h")
        .replace("${m}", String(m))
        .replace("${s}", String(r));
    }
    return t("login-locked-countdown-s").replace("${s}", String(r));
  }

  // Live "Try again in ${time}" message, re-computed every render.
  // When `lockCountdown` is null / 0 this is null and the inline alert
  // falls back to `error` (the original behaviour for 401/403/etc).
  const liveLockMessage =
    lockCountdown !== null && lockCountdown > 0
      ? (lockIsAccount
          ? t("login-locked-account")
          : t("login-locked-too-many")
        ).replace("${time}", formatLockCountdown(lockCountdown))
      : null;
  const displayError = liveLockMessage ?? error;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // FIX-AUDIT3 #8 — clear any previous lockout countdown when the
    // user submits fresh credentials. (If they're still locked out the
    // API will return 429/423 again and we'll re-arm the countdown.)
    if (lockIntervalRef.current) {
      clearTimeout(lockIntervalRef.current);
      lockIntervalRef.current = null;
    }
    setLockCountdown(null);

    if (!username.trim()) {
      setError(t("login-error-username"));
      return;
    }
    if (!password) {
      setError(t("login-error-password"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      });
      const data = await res.json();
      if (!res.ok) {
        // FIX-AUDIT3 #8 — surface 429 (too-many-attempts) and 423
        // (account-locked) with a live countdown. Both responses
        // carry a `Retry-After` HTTP header (seconds) and a
        // `retry_after` JSON field; 423 also carries `locked_until`
        // (ISO timestamp). Falls back to the header when the JSON
        // field is missing, and to `locked_until` when both are
        // missing (the auth/login route always sets one of the two).
        if (res.status === 429 || res.status === 423) {
          const retryAfterJson = Number(data?.retry_after);
          const retryAfterHeader = Number(res.headers.get("Retry-After"));
          const lockedUntil = data?.locked_until;
          let secs = Number.isFinite(retryAfterJson) && retryAfterJson > 0
            ? retryAfterJson
            : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
              ? retryAfterHeader
              : 0;
          if (secs <= 0 && lockedUntil) {
            const ms = new Date(lockedUntil).getTime() - Date.now();
            if (ms > 0) secs = Math.ceil(ms / 1000);
          }
          const isAccount = res.status === 423 || !!lockedUntil;
          setLockIsAccount(isAccount);
          if (secs > 0) {
            setLockCountdown(secs);
          }
          const template = isAccount
            ? t("login-locked-account")
            : t("login-locked-too-many");
          const msg = template.replace("${time}", formatLockCountdown(secs));
          setError(msg);
          return;
        }
        setError(data.error || t("login-signin-failed"));
        return;
      }
      setUser(data.user);
      // SPA transition (no page reload) — force a fresh locale hydrate so
      // this user's own saved language loads instead of whatever the
      // previous session on this browser left behind.
      useI18nStore.getState().reset();
      useI18nStore.getState().hydrate();
    } catch {
      setError(t("login-error-network"));
    } finally {
      setLoading(false);
    }
  }

  const highlights = [
    { icon: Globe, text: "Multi-tenant workspace isolation" },
    { icon: TrendingUp, text: "Landed cost & margin engine" },
    { icon: ShieldCheck, text: "KYC compliance & document verification" },
  ];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* ═══════════════════════════════════════════════════════════════════════
          LEFT — BRANDING PANEL (VELOS copper gradient)
          On mobile: compact header strip (logo + tagline) so the login form is
          reachable without scrolling.
          On desktop (lg+): full-height gradient panel, restrained copy.
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="relative flex flex-col justify-center overflow-hidden px-6 py-6 lg:w-[46%] lg:min-h-screen lg:px-16 lg:py-20 lg:justify-center xl:px-20">
        {/* Copper gradient background — uses the platform's --primary token
            layered over a deep navy base so it reads as "VELOS copper" in both
            light and dark mode (the canvas behind the gradient is opaque). */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[oklch(0.16_0.03_258)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(900px 500px at 15% 0%, oklch(0.46 0.13 55 / 0.55), transparent 60%)," +
              "radial-gradient(700px 600px at 90% 100%, oklch(0.685 0.105 82 / 0.40), transparent 55%)," +
              "linear-gradient(135deg, oklch(0.20 0.04 258) 0%, oklch(0.16 0.03 258) 100%)",
          }}
        />
        {/* Subtle dotted texture overlay */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.35) 1px, transparent 0)",
            backgroundSize: "26px 26px",
          }}
        />
        {/* Floating accent blobs for depth */}
        <div
          aria-hidden
          className="absolute -top-24 -right-24 size-80 rounded-full bg-[oklch(0.55_0.12_55/0.25)] blur-3xl"
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -left-16 size-96 rounded-full bg-[oklch(0.685_0.105_82/0.18)] blur-3xl"
        />

        {/* Content */}
        <div className="relative z-10 mx-auto w-full max-w-lg">
          {/* Logo — always visible, compact on mobile */}
          <div className="lg:mb-14">
            <div className="inline-flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20 overflow-hidden shadow-lg shadow-black/20 lg:size-12">
                <Image
                  src="/logo.svg"
                  alt="VELOS"
                  width={44}
                  height={44}
                  priority
                  className="w-full h-full object-cover"
                />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-white lg:text-2xl">
                  VELOS
                </h1>
                <p className="text-xs text-white/60 lg:text-sm">
                  {t("login-brand-tagline")}
                </p>
              </div>
            </div>
          </div>

          {/* Headline, tagline, highlights, footer — desktop only. */}
          <div className="hidden lg:block">
            <h2 className="mb-4 mt-10 text-3xl font-semibold leading-tight tracking-tight text-white lg:leading-[1.15]">
              {t("login-headline")}
              <br />
              {t("login-headline-2")}
            </h2>

            <p className="mb-10 max-w-md text-base leading-relaxed text-white/60">
              {t("login-tagline")}
            </p>

            <div className="space-y-0.5 border-t border-white/10">
              {highlights.map((h, i) => {
                const Icon = h.icon;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-3 border-b border-white/10 py-3.5"
                  >
                    <Icon className="size-4 shrink-0 text-[oklch(0.685_0.105_82)]" />
                    <span className="text-sm text-white/80">{h.text}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-14 flex items-center gap-2 text-xs text-white/40">
              <Sparkles className="size-3.5" />
              <span>
                © {new Date().getFullYear()} VELOS. {t("login-rights")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          RIGHT — LOGIN FORM
          Mobile: shows logo + brand tagline at top so the brand panel above
          isn't the only place the VELOS identity appears on a small screen.
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 items-center justify-center bg-background px-5 py-8 lg:min-h-screen lg:px-12 lg:py-12">
        <div className="w-full max-w-[420px]">
          {/* Mobile-only brand row (desktop has the gradient panel) */}
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <div className="flex size-10 items-center justify-center rounded-md overflow-hidden ring-1 ring-border">
              <Image
                src="/logo.svg"
                alt="VELOS"
                width={40}
                height={40}
                priority
                className="w-full h-full object-cover"
              />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight text-foreground">
                VELOS
              </p>
              <p className="text-xs text-muted-foreground">
                {t("login-brand-tagline")}
              </p>
            </div>
          </div>

          <Card className="border border-border/70 bg-card/80 backdrop-blur-sm shadow-sm">
            <CardHeader className="mb-2 space-y-2 px-6 pt-6 text-left">
              <CardTitle className="text-2xl font-semibold tracking-tight text-foreground">
                {t("login-welcome")}
              </CardTitle>
              <CardDescription className="text-sm text-muted-foreground">
                {t("login-signin-desc")}
              </CardDescription>
            </CardHeader>

            <CardContent className="px-6 pb-6">
              {/* Error alert — FIX-AUDIT3 #8: when a 429 / 423 lockout
                  countdown is running, `displayError` carries the live
                  "Try again in 2m 15s" message (re-computed every tick
                  by the `lockCountdown` state). When the countdown
                  reaches 0, the effect above clears `error` +
                  `lockCountdown`, so this alert naturally disappears too. */}
              {displayError && (
                <Alert
                  variant="destructive"
                  className="mb-5"
                  role="alert"
                  aria-live="assertive"
                >
                  <AlertDescription className="text-sm font-medium">
                    {displayError}
                  </AlertDescription>
                </Alert>
              )}

              {/* FIX-AUDIT3 #8 — when locked out, surface a hint about
                  the existing "Forgot password?" link in the form row
                  below so the user has an actionable escape without
                  waiting for the countdown to expire. */}
              {lockCountdown !== null && lockCountdown > 0 && (
                <p className="mb-5 text-xs text-muted-foreground leading-relaxed">
                  {t("login-locked-forgot-help")}
                </p>
              )}

              {/* Form */}
              <form onSubmit={submit} className="space-y-5" noValidate>
                {/* Username */}
                <div className="space-y-2">
                  <Label
                    htmlFor="login-username"
                    className="text-sm font-medium text-foreground/80"
                  >
                    {t("login-username")}
                  </Label>
                  <div className="relative group">
                    <User className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
                    <Input
                      id="login-username"
                      type="text"
                      autoComplete="username"
                      value={username}
                      onChange={(e) => {
                        setUsername(e.target.value);
                        if (error) setError("");
                      }}
                      placeholder={t("login-username-placeholder")}
                      disabled={loading}
                      aria-required="true"
                      aria-label={t("login-username")}
                      className="h-11 pl-10 pr-4"
                    />
                  </div>
                </div>

                {/* Password */}
                <div className="space-y-2">
                  <Label
                    htmlFor="login-password"
                    className="text-sm font-medium text-foreground/80"
                  >
                    {t("login-password")}
                  </Label>
                  <div className="relative group">
                    <Lock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
                    <Input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (error) setError("");
                      }}
                      placeholder={t("login-password-placeholder")}
                      disabled={loading}
                      aria-required="true"
                      aria-label={t("login-password")}
                      className="h-11 pl-10 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Remember me + Forgot password */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="login-remember"
                      checked={remember}
                      onCheckedChange={(v) => setRemember(v === true)}
                      disabled={loading}
                    />
                    <Label
                      htmlFor="login-remember"
                      className="text-sm font-normal text-muted-foreground cursor-pointer"
                    >
                      {t("login-remember")}
                    </Label>
                  </div>
                  <Link
                    href="/portal/forgot-password"
                    className="text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline transition-colors"
                  >
                    {t("login-forgot-password")}
                  </Link>
                </div>

                {/* Submit */}
                <Button
                  type="submit"
                  className="h-11 w-full text-sm font-medium"
                  // FIX-AUDIT3 #8 — keep the button disabled while the
                  // 429 / 423 lockout countdown is running so a
                  // frustrated user can't keep re-submitting (which
                  // would just re-receive 429 / 423 and reset the
                  // countdown).
                  disabled={loading || (lockCountdown !== null && lockCountdown > 0)}
                  aria-label={t("login-signin-aria")}
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      {t("login-signing-in")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      {t("login-signin")}
                      <ArrowRight className="size-4" />
                    </span>
                  )}
                </Button>
              </form>

              {/* Sign-up CTA — switches the homepage to the register surface */}
              {onSwitchToRegister && (
                <div className="mt-6 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                  <span>{t("login-no-account")}</span>
                  <button
                    type="button"
                    onClick={onSwitchToRegister}
                    className="font-medium text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors"
                  >
                    {t("login-switch-to-register")}
                  </button>
                </div>
              )}

              {/* Client Portal link — clients log in here, not the admin app */}
              <div className="mt-3 flex items-center justify-center gap-1.5 text-sm text-muted-foreground border-t pt-4">
                <Store className="size-4 text-muted-foreground/70" />
                <span>Are you a client?</span>
                <a
                  href="/portal"
                  className="font-medium text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors"
                >
                  Go to Client Portal →
                </a>
              </div>

              {/* Bottom note */}
              <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
                <ShieldCheck className="size-3.5" />
                {t("login-secure-note")}
              </p>
            </CardContent>
          </Card>

          {/* Copyright — shown here on mobile only; the desktop branding
              panel already has its own copyright line. */}
          <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/50 lg:hidden">
            <Building2 className="size-3" />
            © {new Date().getFullYear()} VELOS. {t("login-rights")}
          </p>
        </div>
      </div>
    </div>
  );
}
