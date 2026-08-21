"use client";

import { useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CountrySelect } from "@/components/common/country-select";
import {
  Loader2,
  Lock,
  Mail,
  ArrowRight,
  ShieldCheck,
  TrendingUp,
  Globe,
  Eye,
  EyeOff,
  Building2,
  Phone,
  User,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useI18nStore, useT } from "@/lib/i18n/store";

interface RegisterViewProps {
  /** Switch back to the login surface (Sign In link on the homepage). */
  onSwitchToLogin?: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const highlights = [
    { icon: Globe, text: "Multi-tenant workspace isolation" },
    { icon: TrendingUp, text: "Landed cost & margin engine" },
    { icon: ShieldCheck, text: "KYC compliance & document verification" },
  ];

  // ── Success state — show a brief confirmation card before the AppShell
  //    mounts (the AppShell swap happens via setUser above; this card is the
  //    interstitial frame so the user sees "workspace created" feedback).
  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-5 py-12">
        <Card className="w-full max-w-md border border-border/70 shadow-sm">
          <CardContent className="px-6 py-8 text-center">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <CheckCircle2 className="size-7" />
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
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
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* ═══════════════════════════════════════════════════════════════════════
          LEFT — BRANDING PANEL (mirrors the login screen's copper gradient)
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="relative flex flex-col justify-center overflow-hidden px-6 py-6 lg:w-[46%] lg:min-h-screen lg:px-16 lg:py-20 lg:justify-center xl:px-20">
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
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.35) 1px, transparent 0)",
            backgroundSize: "26px 26px",
          }}
        />
        <div
          aria-hidden
          className="absolute -top-24 -right-24 size-80 rounded-full bg-[oklch(0.55_0.12_55/0.25)] blur-3xl"
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -left-16 size-96 rounded-full bg-[oklch(0.685_0.105_82/0.18)] blur-3xl"
        />

        <div className="relative z-10 mx-auto w-full max-w-lg">
          {/* Logo */}
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

          <div className="hidden lg:block">
            <h2 className="mb-4 mt-10 text-3xl font-semibold leading-tight tracking-tight text-white lg:leading-[1.15]">
              {t("register-title")}
            </h2>

            <p className="mb-10 max-w-md text-base leading-relaxed text-white/60">
              {t("register-desc")}
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
          RIGHT — REGISTRATION FORM
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 items-center justify-center bg-background px-5 py-8 lg:min-h-screen lg:px-12 lg:py-12">
        <div className="w-full max-w-[460px]">
          {/* Mobile-only brand row */}
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
                {t("register-title")}
              </CardTitle>
              <CardDescription className="text-sm text-muted-foreground">
                {t("register-desc")}
              </CardDescription>
            </CardHeader>

            <CardContent className="px-6 pb-6">
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
                    className="text-sm font-medium text-foreground/80"
                  >
                    {t("register-company-name")}
                  </Label>
                  <div className="relative group">
                    <Building2 className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
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
                      className="h-11 pl-10 pr-4"
                    />
                  </div>
                </div>

                {/* Contact name */}
                <div className="space-y-2">
                  <Label
                    htmlFor="reg-contact"
                    className="text-sm font-medium text-foreground/80"
                  >
                    {t("register-contact-name")}
                  </Label>
                  <div className="relative group">
                    <User className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
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
                      className="h-11 pl-10 pr-4"
                    />
                  </div>
                </div>

                {/* Email + Phone (2-up on desktop) */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label
                      htmlFor="reg-email"
                      className="text-sm font-medium text-foreground/80"
                    >
                      {t("register-email")}
                    </Label>
                    <div className="relative group">
                      <Mail className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
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
                        className="h-11 pl-10 pr-4"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label
                      htmlFor="reg-phone"
                      className="text-sm font-medium text-foreground/80"
                    >
                      {t("register-phone")}
                    </Label>
                    <div className="relative group">
                      <Phone className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
                      <Input
                        id="reg-phone"
                        type="tel"
                        autoComplete="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder={t("register-phone-placeholder")}
                        disabled={loading}
                        className="h-11 pl-10 pr-4"
                      />
                    </div>
                  </div>
                </div>

                {/* Country */}
                <div className="space-y-2">
                  <Label
                    htmlFor="reg-country"
                    className="text-sm font-medium text-foreground/80"
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
                      className="text-sm font-medium text-foreground/80"
                    >
                      {t("register-password")}
                    </Label>
                    <div className="relative group">
                      <Lock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
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
                        className="h-11 pl-10 pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
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
                      className="text-sm font-medium text-foreground/80"
                    >
                      {t("register-confirm-password")}
                    </Label>
                    <div className="relative group">
                      <Lock className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors duration-200 group-focus-within:text-primary" />
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
                        className="h-11 pl-10 pr-4"
                      />
                    </div>
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

              <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
                <ShieldCheck className="size-3.5" />
                {t("register-trial-note")}
              </p>
            </CardContent>
          </Card>

          <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/50 lg:hidden">
            <Building2 className="size-3" />
            © {new Date().getFullYear()} VELOS. {t("login-rights")}
          </p>
        </div>
      </div>
    </div>
  );
}
