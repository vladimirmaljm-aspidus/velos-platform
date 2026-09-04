"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CountrySelect } from "@/components/common/country-select";
import { GlobeMark } from "@/components/common/globe-mark";
import {
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useI18nStore, useT } from "@/lib/i18n/store";
import { EMAIL_RE } from "@/lib/validation/email";

interface RegisterViewProps {
  /** Switch back to the login surface (Sign In link on the homepage). */
  onSwitchToLogin?: () => void;
}


export function RegisterView({ onSwitchToLogin }: RegisterViewProps) {
  const setUser = useAppStore((s) => s.setUser);
  const t = useT();

  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [country, setCountry] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Client-side validation — server repeats each check (never trust the
    // client), but surfacing them here gives the user instant feedback and
    // avoids a round-trip for trivially-invalid input.
    if (!companyName.trim()) {
      setError(t("register-error-company"));
      return;
    }
    if (!contactName.trim()) {
      setError(t("register-error-contact"));
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError(t("register-error-email"));
      return;
    }
    if (!country) {
      setError(t("register-error-country"));
      return;
    }
    if (password.length < 8) {
      setError(t("register-password-placeholder"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("register-error-password-mismatch"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: companyName.trim(),
          contact_name: contactName.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          password,
          country,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("login-error-generic"));
        return;
      }
      // Server created the tenant + admin user + session cookie. Drop into
      // the app shell the same way the login route does — no full reload.
      setSuccess(true);
      if (data.user) {
        setUser(data.user);
        useI18nStore.getState().reset();
        useI18nStore.getState().hydrate();
      }
    } catch {
      setError(t("login-error-network"));
    } finally {
      setLoading(false);
    }
  }

  // What a new workspace ships with — numbered ledger rows, no icon bullets.
  const ledger = [
    t("register-lead-1"),
    t("register-lead-2"),
    t("register-lead-3"),
  ];

  // ── Success state — show a brief confirmation card before the AppShell
  //    mounts (the AppShell swap happens via setUser above; this card is the
  //    interstitial frame so the user sees "workspace created" feedback).
  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
        <Card className="w-full max-w-md border border-border shadow-soft">
          <CardContent className="px-6 py-8 text-center">
            <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <CheckCircle2 className="size-6" />
            </div>
            <h2 className="font-display text-xl font-medium tracking-tight">
              {t("register-success")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("register-desc")}
            </p>
            <div className="mt-6 flex items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      {/* ═══════════════════════════════════════════════════════════════════════
          LEFT — THE HOUSE LEDGER (ink panel, mirrors the login screen)
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="relative flex flex-col justify-between overflow-hidden bg-[oklch(0.25_0.032_42)] text-white px-6 py-6 lg:w-[45%] lg:min-h-screen lg:px-14 lg:py-12 xl:px-16 paper-grain">
        {/* Engraved globe — stationery watermark */}
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
          <h2 className="font-display max-w-md text-[2.1rem] leading-[1.15] tracking-[-0.01em] text-white">
            {t("register-title")}
          </h2>

          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/55">
            {t("register-desc")}
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
          RIGHT — THE REGISTRATION SHEET (paper)
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 items-center justify-center bg-background px-5 py-10 lg:min-h-screen lg:px-12 lg:py-12">
        <div className="mx-auto w-full max-w-[440px]">
          {/* Mobile-only brand row */}
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
            <h1 className="font-display mt-6 text-[1.7rem] font-medium leading-tight tracking-[-0.01em] text-foreground">
              {t("register-title")}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("register-desc")}
            </p>
          </div>

          {error && (
            <Alert
              variant="destructive"
              className="mb-5"
              role="alert"
              aria-live="assertive"
            >
              <AlertDescription className="text-sm font-medium">
                {error}
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={submit} className="space-y-4" noValidate>
            {/* Company name */}
            <div className="space-y-2">
              <Label
                htmlFor="reg-company"
                className="label-caps text-foreground/60"
              >
                {t("register-company-name")}
              </Label>
              <Input
                id="reg-company"
                type="text"
                autoComplete="organization"
                value={companyName}
                onChange={(e) => {
                  setCompanyName(e.target.value);
                  if (error) setError("");
                }}
                placeholder={t("register-company-name-placeholder")}
                disabled={loading}
                className="h-11"
              />
            </div>

            {/* Contact name */}
            <div className="space-y-2">
              <Label
                htmlFor="reg-contact"
                className="label-caps text-foreground/60"
              >
                {t("register-contact-name")}
              </Label>
              <Input
                id="reg-contact"
                type="text"
                autoComplete="name"
                value={contactName}
                onChange={(e) => {
                  setContactName(e.target.value);
                  if (error) setError("");
                }}
                placeholder={t("register-contact-name-placeholder")}
                disabled={loading}
                className="h-11"
              />
            </div>

            {/* Email + Phone (2-up on desktop) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="reg-email"
                  className="label-caps text-foreground/60"
                >
                  {t("register-email")}
                </Label>
                <Input
                  id="reg-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder={t("register-email-placeholder")}
                  disabled={loading}
                  className="h-11"
                />
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="reg-phone"
                  className="label-caps text-foreground/60"
                >
                  {t("register-phone")}
                </Label>
                <Input
                  id="reg-phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={t("register-phone-placeholder")}
                  disabled={loading}
                  className="h-11"
                />
              </div>
            </div>

            {/* Country */}
            <div className="space-y-2">
              <Label
                htmlFor="reg-country"
                className="label-caps text-foreground/60"
              >
                {t("register-country")}
              </Label>
              <CountrySelect
                value={country}
                onChange={(v) => {
                  setCountry(v);
                  if (error) setError("");
                }}
                placeholder={t("register-country")}
                disabled={loading}
                compact={false}
                className="h-11"
              />
            </div>

            {/* Password + Confirm (2-up on desktop) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label
                  htmlFor="reg-password"
                  className="label-caps text-foreground/60"
                >
                  {t("register-password")}
                </Label>
                <div className="relative">
                  <Input
                    id="reg-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError("");
                    }}
                    placeholder={t("register-password-placeholder")}
                    disabled={loading}
                    minLength={8}
                    className="h-11 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
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
              <div className="space-y-2">
                <Label
                  htmlFor="reg-confirm"
                  className="label-caps text-foreground/60"
                >
                  {t("register-confirm-password")}
                </Label>
                <Input
                  id="reg-confirm"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder={t("register-confirm-password-placeholder")}
                  disabled={loading}
                  minLength={8}
                  className="h-11"
                />
              </div>
            </div>

            {/* Submit */}
            <Button
              type="submit"
              className="mt-2 h-11 w-full text-sm font-medium"
              disabled={loading}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {t("register-creating")}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  {t("register-create")}
                  <ArrowRight className="size-4" />
                </span>
              )}
            </Button>
          </form>

          {/* Sign-in CTA — switches the homepage back to the login surface,
              OR navigates to /register (same component) on a deep link. */}
          <div className="mt-6 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            <span>{t("register-have-account")}</span>
            {onSwitchToLogin ? (
              <button
                type="button"
                onClick={onSwitchToLogin}
                className="font-medium text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors"
              >
                {t("register-signin-link")}
              </button>
            ) : (
              <Link
                href="/"
                className="font-medium text-primary hover:text-primary/80 underline-offset-4 hover:underline transition-colors"
              >
                {t("register-signin-link")}
              </Link>
            )}
          </div>

          <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground/70">
            {t("register-trial-note")}
          </p>

          {/* Copyright — mobile only (desktop panel has the colophon) */}
          <p className="mt-3 text-center text-xs text-muted-foreground/50 lg:hidden">
            © {new Date().getFullYear()} VELOS. {t("login-rights")}
          </p>
        </div>
      </div>
    </div>
  );
}
