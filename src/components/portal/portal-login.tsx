"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Loader2,
  Lock,
  Mail,
  ArrowRight,
  FileText,
  Download,
  BookOpen,
  Receipt,
  KeyRound,
  ShieldCheck,
  Eye,
  EyeOff,
  Store,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store/app-store";
import { cn } from "@/lib/utils";
import { useT, useI18nStore } from "@/lib/i18n/store";

const FIRM_NAME = "VELOS";

// FIX-ALL-2 / Fix 2 — the dedicated /portal/forgot-password and
// /portal/setup-password routes render this component and pass an
// `initialDialog` prop so the appropriate dialog auto-opens on mount.
// Without this prop the user lands on the bare login form (no dialog),
// which is what the audit found ("nothing happens" after clicking the
// "Forgot your password?" link that redirected to the admin SPA).
type InitialDialog = "forgot" | "setup" | null;

export function PortalLogin({ initialDialog = null }: { initialDialog?: InitialDialog } = {}) {
  const t = useT();
  const setPortalAccess = useAppStore((s) => s.setPortalAccess);
  const setAppMode = useAppStore((s) => s.setAppMode);
  const searchParams = useSearchParams();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // UI-1 — surface login errors INLINE (above the form) in addition to the
  // toast. A toast that vanishes after 3s was the root cause of the original
  // "nothing happens" reports — the user missed it and clicked again.
  const [loginError, setLoginError] = useState<string | null>(null);

  // Setup-password dialog state
  const [setupOpen, setSetupOpen] = useState(false);
  const [accessId, setAccessId] = useState("");
  // Audit F-6/P1-3: invite emails now arrive with ?setup_token=xxx (a
  // single-use, 7-day-expiring token) instead of the permanent ?access_id.
  // The setup-password API accepts either; we prefer setup_token when present.
  const [setupToken, setSetupToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Forgot password state
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotResult, setForgotResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Reset password state
  const [resetToken, setResetToken] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetResult, setResetResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Pre-fill email from URL params + check for reset token / setup token
  useEffect(() => {
    const emailParam = searchParams.get("email");
    if (emailParam) setEmail(emailParam);
    // Audit F-6/P1-3: prefer ?setup_token=xxx (single-use, 7-day-expiring)
    // over the legacy ?access_id=xxx (permanent UUID, never expired).
    const setupTokenParam = searchParams.get("setup_token");
    // Hoisted so the `initialDialog` branch below can read it without
    // entering the `else` block above (the access_id URL param is a
    // legacy fallback for invite emails issued before the setup_token
    // migration — see audit F-6/P1-3).
    const accessIdParam = searchParams.get("access_id");
    if (setupTokenParam) {
      setSetupToken(setupTokenParam);
      setAccessId("");
      setSetupOpen(true);
    } else if (accessIdParam) {
      setAccessId(accessIdParam);
      setSetupOpen(true);
    }
    const resetTokenParam = searchParams.get("reset_token");
    if (resetTokenParam) {
      setResetToken(resetTokenParam);
      setNewPassword(""); // clear for new entry
    }
    // FIX-ALL-2 / Fix 2 — when the dedicated /portal/forgot-password or
    // /portal/setup-password route renders this component, the
    // `initialDialog` prop tells us which dialog to auto-open. URL
    // params (?setup_token / ?reset_token) above take precedence over
    // the prop so a deep link to /portal/setup-password?setup_token=…
    // still opens the setup dialog (not the forgot one). Only run this
    // when no URL param has already opened a dialog.
    if (initialDialog === "forgot" && !setupTokenParam && !resetTokenParam) {
      setForgotOpen(true);
    } else if (initialDialog === "setup" && !setupTokenParam && !accessIdParam && !resetTokenParam) {
      setSetupOpen(true);
    }
  }, [searchParams, initialDialog]);

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!forgotEmail) return;
    setForgotLoading(true);
    setForgotResult(null);
    try {
      const res = await fetch("/api/portal/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await res.json();
      setForgotResult({ ok: true, message: data.message || t("portal-login-toast-reset-link") });
    } catch {
      setForgotResult({ ok: false, message: t("portal-login-toast-network") });
    } finally {
      setForgotLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!resetToken || !newPassword) return;
    if (newPassword.length < 8) {
      setResetResult({ ok: false, message: t("portal-login-toast-pw-too-short") });
      return;
    }
    setResetLoading(true);
    setResetResult(null);
    try {
      const res = await fetch("/api/portal/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset_token: resetToken, password: newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setResetResult({ ok: true, message: data.message || t("portal-login-toast-reset-success") });
        setTimeout(() => {
          setResetToken("");
          window.history.replaceState({}, "", "/portal/login");
        }, 2000);
      } else {
        setResetResult({ ok: false, message: data.error || t("portal-login-toast-reset-failed") });
      }
    } catch {
      setResetResult({ ok: false, message: t("portal-login-toast-network") });
    } finally {
      setResetLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Client-side validation with inline errors — surfaces missing fields
    // instantly without a round-trip. The server repeats every check.
    setLoginError(null);
    if (!email.trim()) {
      setLoginError(t("portal-login-error-enter-email"));
      return;
    }
    if (!password) {
      setLoginError(t("portal-login-error-enter-password"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Inline error is the primary surface — toast is kept as a
        // secondary signal so a user who scrolled away still sees it.
        const msg =
          data.error ||
          (res.status === 401
            ? t("portal-login-error-credentials")
            : t("portal-login-toast-signin-failed"));
        setLoginError(msg);
        toast.error(msg);
        return;
      }
      setPortalAccess(data.access);
      setAppMode("portal");
      toast.success(t("portal-login-toast-welcome"));
      // Portal login lives at /portal/login — that route always renders
      // <PortalLogin/> regardless of store state, so we have to navigate
      // ourselves. Without this the user stays on the login page after
      // a successful sign-in ('welcome toast but nothing happens').
      router.push("/portal/dashboard");
    } catch {
      const msg = t("portal-login-error-network");
      setLoginError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function setupPassword(e: React.FormEvent) {
    e.preventDefault();
    setSetupError(null);
    if (!accessId && !setupToken) {
      setSetupError(t("portal-login-toast-missing-access-id"));
      return;
    }
    if (!newPassword) {
      setSetupError(t("portal-login-toast-enter-password"));
      return;
    }
    if (newPassword.length < 8) {
      setSetupError(t("portal-login-toast-pw-too-short"));
      return;
    }
    setSetupLoading(true);
    try {
      const res = await fetch("/api/portal/setup-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Audit F-6/P1-3: send setup_token (preferred) OR access_id (legacy).
        // The server validates the token's hash + 7-day expiry; legacy
        // access_id is only honoured for staff sessions or for invite
        // emails issued before this fix (within 7 days of invited_at).
        body: JSON.stringify(
          setupToken
            ? { setup_token: setupToken, password: newPassword }
            : { access_id: accessId, password: newPassword }
        ),
      });
      let data: any = {};
      try { data = await res.json(); } catch { /* non-JSON response */ }
      if (!res.ok) {
        // Show the error INLINE in the dialog — a toast that vanishes after
        // 3 seconds is why users kept saying "nothing happened".
        setSetupError(data.error || t("portal-login-toast-setup-failed").replace("{status}", String(res.status)));
        return;
      }
      // Success — the server auto-signed us in (data.auto_signed_in). Just
      // hydrate the client state and drop the user into their portal.
      setSetupOpen(false);
      setAccessId("");
      setSetupToken("");
      setNewPassword("");
      if (data.access) {
        setPortalAccess(data.access);
        setAppMode("portal");
        toast.success(t("portal-login-toast-password-set-welcome"));
        router.push("/portal/dashboard");
      } else {
        // Rare fallback (server didn't return access): treat as normal login.
        toast.success(t("portal-login-toast-password-set-signin"));
        setEmail(searchParams.get("email") || "");
        // Remove the ?access_id= from the URL so a refresh doesn't re-open the dialog.
        window.history.replaceState({}, "", "/portal/login");
      }
    } catch (err: any) {
      setSetupError(t("portal-login-toast-network-setup"));
    } finally {
      setSetupLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Left — login form with mesh background */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 lg:p-10 bg-mesh-portal relative">
        {/* VELOS copper gradient overlay — layers the brand colour under the
            existing dotted mesh so the login screen reads as VELOS, not as a
            generic white card. The overlay is opaque enough to feel branded
            but transparent enough that the underlying bg-mesh-portal texture
            still shows through. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(800px 400px at 0% 0%, oklch(0.395 0.115 55 / 0.06), transparent 60%)," +
              "radial-gradient(700px 500px at 100% 100%, oklch(0.685 0.105 82 / 0.04), transparent 60%)",
          }}
        />
        <div className="w-full max-w-md relative z-10">
          {/* Brand — VELOS client portal mark */}
          <div className="flex items-center gap-3 mb-10">
            <div className="size-12 rounded-xl overflow-hidden shadow-soft-md ring-1 ring-border">
              <Image src="/logo.svg" alt="VELOS" width={48} height={48} priority />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t("portal-brand-title")}</h1>
              <p className="text-sm text-muted-foreground">{FIRM_NAME}</p>
            </div>
          </div>

          {/* Card with animated gradient border */}
          <div className="border-gradient shadow-soft-lg">
            <div className="bg-card rounded-[calc(var(--radius-xl)-1px)] p-7 sm:p-8">
              <div className="space-y-1.5 mb-6">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {t("portal-login-welcome")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("portal-login-signin-desc")}
                </p>
              </div>

              {/* ── How to sign in (UI-1 — clear instructions) ───────────────
                  Compact info card so a brand-new portal client knows exactly
                  what to do without reading the help docs. Sits above the
                  form, dismissible visually by the eye once the user starts
                  typing (it doesn't dismiss itself — the instructions stay
                  available if the user scrolls back up). */}
              <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-primary/15 bg-primary/[0.04] p-3 text-xs text-muted-foreground">
                <Info className="size-4 shrink-0 text-primary mt-0.5" />
                <div>
                  <p className="font-medium text-foreground/80 mb-0.5">
                    {t("portal-login-instructions-title")}
                  </p>
                  <p className="leading-relaxed">
                    {t("portal-login-instructions-desc")}
                  </p>
                </div>
              </div>

              {/* Inline error — surfaces ABOVE the form fields so the user
                  sees the failure reason without having to scroll, and it
                  stays visible until the user starts typing again. */}
              {loginError && (
                <Alert
                  variant="destructive"
                  className="mb-5"
                  role="alert"
                  aria-live="assertive"
                >
                  <AlertDescription className="text-sm font-medium">
                    {loginError}
                  </AlertDescription>
                </Alert>
              )}

              <form onSubmit={submit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-medium">
                    {t("portal-login-email")}
                  </Label>
                  <div className="relative group">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (loginError) setLoginError(null);
                      }}
                      className="pl-10 h-11 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
                      placeholder="you@company.com"
                      disabled={loading}
                      aria-required="true"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="text-sm font-medium">
                    {t("portal-login-password")}
                  </Label>
                  <div className="relative group">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (loginError) setLoginError(null);
                      }}
                      className="pl-10 pr-10 h-11 smooth focus-visible:ring-primary/40 focus-visible:border-primary/40"
                      placeholder="••••••••"
                      disabled={loading}
                      aria-required="true"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      tabIndex={-1}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground smooth"
                      aria-label={showPassword ? t("portal-login-hide-password") : t("portal-login-show-password")}
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full h-11 text-sm font-medium shadow-soft hover:shadow-soft-md smooth"
                  disabled={loading}
                >
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      {t("portal-login-signin")}
                      <ArrowRight className="size-4 ml-1" />
                    </>
                  )}
                </Button>

                <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className="block mx-auto text-xs text-muted-foreground hover:text-primary underline underline-offset-4 smooth"
                    >
                      {t("portal-login-setup-link")}
                    </button>
                  </DialogTrigger>
                  <DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
                    <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
                      <DialogTitle className="flex items-center gap-2">
                        <KeyRound className="size-4 text-primary" />
                        {t("portal-login-setup-title")}
                      </DialogTitle>
                      <DialogDescription>
                        {t("portal-login-setup-desc")}
                      </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={setupPassword} className="flex-1 min-h-0 flex flex-col">
                      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="access_id">{t("portal-login-access-id")}</Label>
                        <Input
                          id="access_id"
                          value={accessId}
                          onChange={(e) => setAccessId(e.target.value)}
                          placeholder="pa_..."
                          disabled={setupLoading}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="new_password">{t("portal-login-new-password")}</Label>
                        <Input
                          id="new_password"
                          type="password"
                          value={newPassword}
                          onChange={(e) => { setNewPassword(e.target.value); setSetupError(null); }}
                          placeholder={t("portal-login-at-least-8")}
                          minLength={8}
                          autoComplete="new-password"
                          disabled={setupLoading}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("portal-login-new-password-hint")}
                        </p>
                      </div>
                      {setupError && (
                        <div className="p-3 rounded-lg text-sm bg-destructive/10 text-destructive border border-destructive/30">
                          {setupError}
                        </div>
                      )}
                      </div>
                      <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setSetupOpen(false)}
                          disabled={setupLoading}
                        >
                          {t("portal-action-cancel")}
                        </Button>
                        <Button type="submit" disabled={setupLoading}>
                          {setupLoading ? (
                            <Loader2 className="size-4 animate-spin mr-1" />
                          ) : null}
                          {t("portal-login-set-password")}
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </form>

              {/* Forgot password link */}
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-xs text-muted-foreground hover:text-primary underline underline-offset-4 smooth"
                >
                  {t("portal-login-forgot-link")}
                </button>
              </div>

              {/* Forgot password dialog */}
              <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
                <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
                  <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
                    <DialogTitle className="flex items-center gap-2">
                      <KeyRound className="size-4 text-primary" />
                      {t("portal-login-forgot-title")}
                    </DialogTitle>
                    <DialogDescription>
                      {t("portal-login-forgot-desc")}
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleForgotPassword} className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email">{t("portal-login-email-address")}</Label>
                      <Input
                        id="forgot-email"
                        type="email"
                        value={forgotEmail}
                        onChange={(e) => setForgotEmail(e.target.value)}
                        placeholder="you@company.com"
                        disabled={forgotLoading}
                        required
                      />
                    </div>
                    {forgotResult && (
                      <div className={`p-3 rounded-lg text-sm ${forgotResult.ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-destructive/10 text-destructive"}`}>
                        {forgotResult.message}
                      </div>
                    )}
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setForgotOpen(false)}>{t("portal-action-close")}</Button>
                      <Button type="submit" disabled={forgotLoading || !forgotEmail}>
                        {forgotLoading ? <Loader2 className="size-4 animate-spin" /> : t("portal-login-send-reset-link")}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

              {/* Reset password dialog (triggered by URL param) */}
              <Dialog open={!!resetToken} onOpenChange={(o) => { if (!o) { setResetToken(""); window.history.replaceState({}, "", "/portal/login"); } }}>
                <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
                  <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
                    <DialogTitle className="flex items-center gap-2">
                      <KeyRound className="size-4 text-primary" />
                      {t("portal-login-reset-title")}
                    </DialogTitle>
                    <DialogDescription>
                      {t("portal-login-reset-desc")}
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleResetPassword} className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="new-password-reset">{t("portal-login-new-password")}</Label>
                      <Input
                        id="new-password-reset"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="••••••••"
                        disabled={resetLoading}
                        required
                        minLength={8}
                      />
                    </div>
                    {resetResult && (
                      <div className={`p-3 rounded-lg text-sm ${resetResult.ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-destructive/10 text-destructive"}`}>
                        {resetResult.message}
                      </div>
                    )}
                    <DialogFooter>
                      <Button type="submit" disabled={resetLoading || !newPassword}>
                        {resetLoading ? <Loader2 className="size-4 animate-spin" /> : t("portal-login-set-new-password")}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>

            </div>
          </div>

          {/* ── Marketplace link (UI-1) ────────────────────────────────────
              Lets a prospective client window-shop the public marketplace
              without signing in — converts more visitors into sign-ups.
              Styled as a subtle ghost-link card so it doesn't compete with
              the primary sign-in CTA but is still discoverable. */}
          <Link
            href="/portal/marketplace"
            className="mt-6 group flex items-center gap-3 rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.04] smooth"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary group-hover:bg-primary/15 smooth">
              <Store className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                {t("portal-login-marketplace-link")}
              </span>
              <span className="block text-xs text-muted-foreground leading-snug">
                {t("portal-login-marketplace-desc")}
              </span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 smooth" />
          </Link>

          {/* ── Need an account? Contact your account manager ─────────── */}
          <p className="mt-5 text-center text-xs text-muted-foreground">
            {t("portal-login-need-account")}{" "}
            <a
              href={`mailto:hello@velos.trade?subject=${encodeURIComponent(
                "Portal access request",
              )}`}
              className="font-medium text-primary hover:underline underline-offset-4"
            >
              {t("portal-login-contact-us")}
            </a>
          </p>

          <p className="text-center text-xs text-muted-foreground mt-6">
            © {new Date().getFullYear()} {FIRM_NAME} · {t("portal-login-secure-workspace")}
          </p>

          {/* Language selector on login page — lets new clients choose their
              language before logging in. Preference is saved to localStorage
              and picked up by the portal shell after login. */}
          <PortalLoginLanguageSelector />
        </div>
      </div>

      {/* Right — emerald gradient welcome panel */}
      <div className="hidden lg:flex flex-1 bg-gradient-emerald relative overflow-hidden">
        {/* Subtle pattern overlay */}
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.18) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />
        {/* Floating accent shapes */}
        <div className="absolute -top-32 -right-32 size-96 rounded-full bg-white/[0.08] blur-3xl" />
        <div className="absolute -bottom-40 -left-20 size-96 rounded-full bg-white/[0.06] blur-3xl" />

        <div className="relative z-10 flex flex-col justify-center p-12 xl:p-16 max-w-2xl text-primary-foreground">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/15 text-xs font-medium w-fit mb-8 backdrop-blur-sm">
            <ShieldCheck className="size-3.5" />
            {t("portal-login-encrypted")}
          </div>

          <h2 className="text-4xl xl:text-5xl font-semibold tracking-tight mb-5 leading-[1.1]">
            {t("portal-login-hero-title")}
            <br />
            <span className="text-white/90">{t("portal-login-hero-title-2")}</span>
          </h2>
          <p className="text-white/80 text-lg leading-relaxed mb-12 max-w-md">
            {t("portal-login-hero-desc").replace("{firm}", FIRM_NAME)}
          </p>

          <div className="space-y-5">
            {[
              {
                icon: FileText,
                title: t("portal-login-feature-offers-title"),
                desc: t("portal-login-feature-offers-desc"),
              },
              {
                icon: Download,
                title: t("portal-login-feature-docs-title"),
                desc: t("portal-login-feature-docs-desc"),
              },
              {
                icon: BookOpen,
                title: t("portal-login-feature-catalog-title"),
                desc: t("portal-login-feature-catalog-desc"),
              },
              {
                icon: Receipt,
                title: t("portal-login-feature-invoices-title"),
                desc: t("portal-login-feature-invoices-desc"),
              },
            ].map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="flex items-start gap-4 group">
                  <div className="size-11 rounded-xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0 backdrop-blur-sm smooth group-hover:bg-white/15">
                    <Icon className="size-5 text-white" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-white text-sm">{f.title}</p>
                    <p className="text-sm text-white/70 leading-relaxed">
                      {f.desc}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-12 pt-8 border-t border-white/15 flex items-center gap-2 text-xs text-white/60">
            <ShieldCheck className="size-3.5" />
            <span>{t("portal-login-security-badges")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Language selector for the login page ─────────────────────────────────
// Compact dropdown that lets portal clients pick their language before
// logging in. Saves to localStorage (picked up by portal-shell on login).
function PortalLoginLanguageSelector() {
  const { locale, setLocale } = useI18nStore();
  if (typeof window === "undefined") return null;
  const flags: Record<string, string> = { en: "🇬🇧", sr: "🇷🇸", tr: "🇹🇷", de: "🇩🇪", ru: "🇷🇺" };
  const labels: Record<string, string> = { en: "English", sr: "Srpski", tr: "Türkçe", de: "Deutsch", ru: "Русский" };
  return (
    <div className="flex items-center justify-center gap-1 mt-4">
      {(Object.keys(labels)).map((loc) => (
        <button
          key={loc}
          onClick={() => setLocale(loc as any)}
          className={cn(
            "px-2 py-1 rounded-md text-xs transition-colors",
            locale === loc
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
          title={labels[loc]}
        >
          <span className="text-base">{flags[loc]}</span>
        </button>
      ))}
    </div>
  );
}
