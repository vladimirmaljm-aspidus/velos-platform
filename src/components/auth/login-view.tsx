"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { GlobeMark } from "@/components/common/globe-mark";
import { Loader2, ArrowRight, Eye, EyeOff, Clock } from "lucide-react";
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
  // audit25 (random-logout fix) — the app shell redirects to /?reason=
  // session_expired when the idle / absolute TTL / revocation kills the
  // session. We read it once (window.location — no useSearchParams, so
  // no Suspense boundary requirement) and show an amber explainer banner
  // instead of the previous silent bounce ("app logs me out for no reason").
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("reason") === "session_expired") {
// eslint-disable-next-line react-hooks/set-state-in-effect
      setSessionExpired(true);
    }
  }, []);

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

  // The ledger — what the house actually handles, one line per trade
  // document. Numbered rows with hairline rules; no icon bullets.
  const ledger = [
    t("login-lead-1"),
    t("login-lead-2"),
    t("login-lead-3"),
    t("login-lead-4"),
  ];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-background">
      {/* ═══════════════════════════════════════════════════════════════════════
          LEFT — THE HOUSE LEDGER (ink panel)
          A solid espresso-copper ground with a faint paper tooth, the serif
          wordmark, the headline, and a numbered ledger of what VELOS runs.
          On mobile: compact brand strip only — the form stays reachable.
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="relative flex flex-col justify-between overflow-hidden bg-[oklch(0.25_0.032_42)] text-white px-6 py-6 lg:w-[45%] lg:min-h-screen lg:px-14 lg:py-12 xl:px-16 paper-grain">
        {/* Engraved globe — stationery watermark, not a blob */}
        <GlobeMark className="pointer-events-none absolute -right-28 -bottom-28 hidden size-[26rem] text-[oklch(0.80_0.10_62)] opacity-[0.13] lg:block" />

        {/* Brand */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/[0.06] ring-1 ring-white/15">
            <Image
              src="/logo.svg"
              alt="VELOS"
              width={40}
              height={40}
              priority
              className="w-full h-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <p className="font-display text-lg leading-none font-medium">VELOS</p>
            <p className="label-caps mt-1.5 text-white/45">{t("login-brand-tagline")}</p>
          </div>
        </div>

        {/* Headline + ledger — desktop only */}
        <div className="relative z-10 hidden lg:block">
          <h2 className="font-display max-w-md text-[2.35rem] leading-[1.12] tracking-[-0.01em] text-white xl:text-[2.6rem]">
            {t("login-headline")}
            <br />
            <span className="text-[oklch(0.80_0.10_62)]">{t("login-headline-2")}</span>
          </h2>

          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/55">
            {t("login-tagline")}
          </p>

          <div className="mt-9 max-w-md border-t border-white/10">
            {ledger.map((item, i) => (
              <div
                key={i}
                className="flex items-baseline gap-4 border-b border-white/10 py-3"
              >
                <span className="font-mono text-[11px] tabular text-[oklch(0.80_0.10_62)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-sm text-white/75">{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Colophon */}
        <div className="relative z-10 hidden items-center gap-2 lg:flex">
          <span className="label-caps text-white/30">
            © {new Date().getFullYear()} VELOS · {t("login-rights")}
          </span>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          RIGHT — THE SIGN-IN SHEET (paper)
          The form sits directly on the paper — no glass card. Small-caps
          labels, hairline fields, a short double rule as the stationery
          mark above the heading.
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 items-center justify-center bg-background px-5 py-10 lg:min-h-screen lg:px-12 lg:py-12">
        <div className="mx-auto w-full max-w-[400px]">
          {/* Mobile-only brand row (desktop has the ink panel) */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-border">
              <Image
                src="/logo.svg"
                alt="VELOS"
                width={36}
                height={36}
                priority
                className="w-full h-full object-cover"
              />
            </div>
            <div>
              <p className="font-display text-base font-medium leading-none text-foreground">
                VELOS
              </p>
              <p className="label-caps mt-1 text-muted-foreground">
                {t("login-brand-tagline")}
              </p>
            </div>
          </div>

          {/* Sheet header — double rule + serif heading */}
          <div className="mb-7">
            <div className="rule-double w-9" aria-hidden />
            <h1 className="font-display mt-6 text-[1.8rem] font-medium leading-tight tracking-[-0.01em] text-foreground">
              {t("login-welcome")}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("login-signin-desc")}
            </p>
          </div>

          {/* Error alert — FIX-AUDIT3 #8: when a 429 / 423 lockout
              countdown is running, `displayError` carries the live
              "Try again in 2m 15s" message (re-computed every tick
              by the `lockCountdown` state). When the countdown
              reaches 0, the effect above clears `error` +
              `lockCountdown`, so this alert naturally disappears too. */}
          {/* audit25 — explain WHY the user landed here when their
              session expired (idle / absolute TTL / revoked). Amber
              info alert, not destructive — nothing they did was wrong. */}
          {sessionExpired && !displayError && (
            <Alert className="mb-5 border-warning/40 bg-warning/10" role="status">
              <Clock className="h-4 w-4 text-warning" aria-hidden />
              <AlertDescription className="text-sm text-warning-foreground">
                {t("login-session-expired")}
              </AlertDescription>
            </Alert>
          )}

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
                className="label-caps text-foreground/60"
              >
                {t("login-username")}
              </Label>
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
                className="h-11"
              />
            </div>

            {/* Password */}
            <div className="space-y-2">
              <Label
                htmlFor="login-password"
                className="label-caps text-foreground/60"
              >
                {t("login-password")}
              </Label>
              <div className="relative">
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
                  className="h-11 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
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
          <div className="mt-6 border-t border-border pt-4">
            <div className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
              <span>{t("login-client-portal-q")}</span>
              <a
                href="/portal"
                className="font-medium text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors"
              >
                {t("login-client-portal-link")} →
              </a>
            </div>
          </div>

          {/* Bottom note — quiet, honest */}
          <p className="mt-7 text-center text-xs text-muted-foreground/70">
            {t("login-secure-note")}
          </p>

          {/* Copyright — shown here on mobile only; the desktop ink
              panel carries its own colophon. */}
          <p className="mt-3 text-center text-xs text-muted-foreground/50 lg:hidden">
            © {new Date().getFullYear()} VELOS. {t("login-rights")}
          </p>
        </div>
      </div>
    </div>
  );
}
