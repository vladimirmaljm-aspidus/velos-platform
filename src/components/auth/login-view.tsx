"use client";

import { useState } from "react";
import Image from "next/image";
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
} from "lucide-react";
import { useAppStore } from "@/lib/store/app-store";
import { useI18nStore, useT } from "@/lib/i18n/store";

export function LoginView() {
  const setUser = useAppStore((s) => s.setUser);
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!username.trim()) {
      setError("Please enter your username.");
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
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
      setError("Network error. Please check your connection and try again.");
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
          LEFT — BRANDING PANEL
          On mobile: compact header strip (logo only) so the login form is
          reachable without scrolling.
          On desktop (lg+): full-height solid navy panel, restrained copy.
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="relative flex flex-col justify-center overflow-hidden bg-[oklch(0.16_0.03_258)] px-6 py-6 lg:w-[46%] lg:min-h-screen lg:px-16 lg:py-20 lg:justify-center xl:px-20">
        {/* Content */}
        <div className="relative z-10 mx-auto w-full max-w-lg">
          {/* Logo — always visible, compact on mobile */}
          <div className="lg:mb-14">
            <div className="inline-flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-md bg-white/10 ring-1 ring-white/15 overflow-hidden lg:size-11">
                <Image src="/logo.svg" alt="VELOS" width={44} height={44} priority className="w-full h-full object-cover" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-white lg:text-2xl">
                  VELOS Trade
                </h1>
                <p className="hidden text-sm text-white/45 lg:block">
                  Trade Management Platform
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

            <p className="mb-10 max-w-md text-base leading-relaxed text-white/55">
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
                    <Icon className="size-4 shrink-0 text-white/45" />
                    <span className="text-sm text-white/75">{h.text}</span>
                  </div>
                );
              })}
            </div>

            <p className="mt-14 text-xs text-white/30">
              © {new Date().getFullYear()} VELOS. All rights reserved.
            </p>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          RIGHT — LOGIN FORM
          ═══════════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 items-center justify-center bg-background px-6 py-8 lg:min-h-screen lg:px-12 lg:py-12">
        <div className="w-full max-w-[400px]">
          <Card className="border-0 bg-transparent shadow-none">
            <CardHeader className="mb-2 space-y-2 px-0 text-left">
              <CardTitle className="text-2xl font-semibold tracking-tight text-foreground">
                {t("login-welcome")}
              </CardTitle>
              <CardDescription className="text-base text-muted-foreground">
                {t("login-signin-desc")}
              </CardDescription>
            </CardHeader>

            <CardContent className="px-0">
              {/* Error alert */}
              {error && (
                <Alert
                  variant="destructive"
                  className="mb-6"
                  role="alert"
                  aria-live="assertive"
                >
                  <AlertDescription className="text-sm font-medium">
                    {error}
                  </AlertDescription>
                </Alert>
              )}

              {/* Form */}
              <form onSubmit={submit} className="space-y-5" noValidate>
                {/* {t("login-username")} */}
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

                {/* {t("login-password")} */}
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
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>

                {/* Submit */}
                <Button
                  type="submit"
                  className="h-11 w-full text-sm font-medium"
                  disabled={loading}
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

              {/* Bottom note */}
              <p className="mt-8 text-center text-xs text-muted-foreground/50">
                {t("login-secure-note")}
              </p>
              {/* Copyright — shown here on mobile only; the desktop branding
                  panel already has its own copyright line. */}
              <p className="mt-4 text-center text-[11px] text-muted-foreground/40 lg:hidden">
                © {new Date().getFullYear()} VELOS. {t("login-rights")}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
