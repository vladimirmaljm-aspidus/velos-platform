"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store/app-store";
import { LoginView } from "@/components/auth/login-view";
import { RegisterView } from "@/components/auth/register-view";
import { AppShell } from "@/components/layout/app-shell";
import { PortalLogin } from "@/components/portal/portal-login";
import { PortalShell } from "@/components/portal/portal-shell";

type AuthView = "login" | "register";

/**
 * Shared SPA entry — the auth gate + shell swap.
 *
 * Extracted from src/app/page.tsx (audit 4-d P1-1) so the root route (" /
 * ") and the /app/* catch-all route render the EXACT same client surface:
 * the admin SPA is now addressable at /app/<view> (see app-store's
 * applyViewFromUrl), so a deep link must boot this same gate — logged out
 * it shows the login form at the deep-linked URL; once /api/auth/me
 * resolves, <AppShell/> mounts and reads the intended view from the URL.
 *
 * Problem 1 fix (UI-1): the previous version initialised `checking=true` and
 * rendered only a `<Loader2/>` spinner until `/api/auth/me` resolved. On
 * Vercel the SSR pass shipped a blank page with just a spinner, then the
 * client JS hydrated but the spinner never gave way to the login form (the
 * transition was gated on a network round-trip that could hang on cold
 * starts). Net effect: users saw a blank page that never resolved.
 *
 * Behaviour:
 *   - Render the LoginView IMMEDIATELY as the default state (no spinner).
 *   - Kick off the auth checks in the background.
 *   - If /api/auth/me returns a user, swap to <AppShell/> (same SPA
 *     transition as before — no full reload).
 *   - If /api/portal/me returns a portal session, swap to <PortalShell/>.
 *   - Otherwise stay on the auth screen.
 *   - A local `view` state toggles between LoginView and RegisterView so the
 *     Sign Up / Sign In links can flip between them with no navigation.
 *
 * This means: no blank page, no spinner, login form is visible on first paint.
 */
export default function AppEntry() {
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const portalAccess = useAppStore((s) => s.portalAccess);
  const setPortalAccess = useAppStore((s) => s.setPortalAccess);
  const appMode = useAppStore((s) => s.appMode);
  // Default to the login form — never render a loading spinner as the
  // initial state. The auth checks below swap us to the app shell if a
  // valid session is found, but until they resolve the user sees the
  // login form (the correct "logged-out" surface).
  const [view, setView] = useState<AuthView>("login");

  useEffect(() => {
    let mounted = true;
    // Check admin session — swap to AppShell on success.
    // audit26: retry transient failures (429/5xx) twice with backoff so a
    // momentary rate-limit/DB blip doesn't render the login screen for a
    // user whose session cookie is perfectly valid ("looks logged out").
    const fetchMe = (attempt: number) => {
      fetch("/api/auth/me")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => {
          if (mounted && data.user) setUser(data.user);
        })
        .catch(() => {
          if (mounted && attempt < 2) setTimeout(() => fetchMe(attempt + 1), 1200 * (attempt + 1));
        });
    };
    fetchMe(0);

    // Check portal session (in parallel) — swap to PortalShell on success.
    const fetchPortalMe = (attempt: number) => {
      fetch("/api/portal/me")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => {
          if (mounted && data.access) setPortalAccess(data.access);
        })
        .catch(() => {
          if (mounted && attempt < 2) setTimeout(() => fetchPortalMe(attempt + 1), 1200 * (attempt + 1));
        });
    };
    fetchPortalMe(0);
    return () => {
      mounted = false;
    };
  }, [setUser, setPortalAccess]);

  // Portal mode takes precedence if a portal session exists.
  if (appMode === "portal" || portalAccess) {
    return portalAccess ? <PortalShell /> : <PortalLogin />;
  }

  // Admin session present — drop into the app shell.
  if (user) return <AppShell />;

  // Default surface: render the auth screen (login or register) immediately.
  // No spinner, no blank page — the form is visible on first paint.
  return view === "register" ? (
    <RegisterView onSwitchToLogin={() => setView("login")} />
  ) : (
    <LoginView onSwitchToRegister={() => setView("register")} />
  );
}
