"use client";
import { create } from "zustand";
import type { Locale } from "@/lib/i18n/dictionaries";
import { t as translate } from "@/lib/i18n/dictionaries";

const VALID_LOCALES: Locale[] = ["en", "sr", "tr", "de", "ru"];
function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (VALID_LOCALES as string[]).includes(v);
}

// SSR-safe cookie helpers — the cookie is the ONLY locale source the
// SERVER can read, so it is what keeps SSR HTML and the client's first
// render in sync (audit26 hydration fix). localStorage stays in sync as
// a legacy mirror (portal-shell reads it in an effect).
const LOCALE_COOKIE = "velos-locale";
function writeLocaleCookie(locale: Locale) {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

interface I18nState {
  locale: Locale;
  hydrated: boolean;
  setLocale: (l: Locale) => void;
  hydrate: () => Promise<void>;
  reset: () => void;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  // audit26 hydration fix: ALWAYS "en" at module-eval. The previous code
  // read localStorage during module evaluation — on the server that's
  // "en", but on the client a saved locale ("sr"/"de"/…) produced a
  // DIFFERENT first render than the SSR HTML → React hydration error
  // #418 on EVERY page for every non-English user, and the server HTML
  // got thrown away. The saved locale is now injected pre-hydration by
  // <I18nLocaleBridge> (providers.tsx) using the value the SERVER read
  // from the cookie — both sides always agree.
  locale: "en",
  hydrated: false,

  setLocale: (locale) => {
    if (typeof window !== "undefined") {
      localStorage.setItem(LOCALE_COOKIE, locale);
      writeLocaleCookie(locale);
    }
    set({ locale });
    if (typeof window !== "undefined") {
      fetch("/api/user-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "locale", value: locale }),
      }).catch(() => {});
    }
  },

  // Clears any cached locale so the next hydrate() re-fetches from scratch.
  // Called on logout so a second user on the same browser/tab never inherits
  // the previous user's language before their own preference loads.
  reset: () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem(LOCALE_COOKIE);
      document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0; samesite=lax`;
    }
    set({ locale: "en", hydrated: false });
  },

  // Priority: user's saved preference -> tenant default -> localStorage cache -> "en"
  // Re-entrant per login: callers must reset() on logout so this can run again
  // for the next user without a full page reload (the app is an SPA).
  hydrate: async () => {
    if (get().hydrated || typeof window === "undefined") return;
    set({ hydrated: true });
    // Mirror the server-injected cookie locale into localStorage (legacy
    // mirror — portal-shell's effect reads it).
    try {
      const mirror = localStorage.getItem(LOCALE_COOKIE);
      if (isLocale(mirror)) writeLocaleCookie(mirror);
    } catch { /* ignore */ }
    try {
      const res = await fetch("/api/user-preferences");
      if (res.ok) {
        const data = await res.json();
        const saved = data?.map?.locale;
        if (isLocale(saved)) {
          localStorage.setItem(LOCALE_COOKIE, saved);
          writeLocaleCookie(saved);
          set({ locale: saved });
          return;
        }
      }
    } catch {
      // ignore, fall through
    }
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        if (isLocale(data?.default_locale)) {
          set({ locale: data.default_locale });
          localStorage.setItem(LOCALE_COOKIE, data.default_locale);
          writeLocaleCookie(data.default_locale);
        }
      }
    } catch {
      // ignore, keep localStorage/default value
    }
  },
}));

export function useT() {
  const locale = useI18nStore((s) => s.locale);
  return (key: string) => translate(locale, key);
}

export function getT(locale: Locale) {
  return (key: string) => translate(locale, key);
}
