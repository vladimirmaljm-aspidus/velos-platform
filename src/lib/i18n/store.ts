"use client";
import { create } from "zustand";
import type { Locale } from "@/lib/i18n/dictionaries";
import { t as translate } from "@/lib/i18n/dictionaries";

const VALID_LOCALES: Locale[] = ["en", "sr", "tr", "de", "ru"];
function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (VALID_LOCALES as string[]).includes(v);
}

interface I18nState {
  locale: Locale;
  hydrated: boolean;
  setLocale: (l: Locale) => void;
  hydrate: () => Promise<void>;
  reset: () => void;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  locale: (typeof window !== "undefined" && (localStorage.getItem("velos-locale") as Locale)) || "en",
  hydrated: false,

  setLocale: (locale) => {
    if (typeof window !== "undefined") localStorage.setItem("velos-locale", locale);
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
    if (typeof window !== "undefined") localStorage.removeItem("velos-locale");
    set({ locale: "en", hydrated: false });
  },

  // Priority: user's saved preference -> tenant default -> localStorage cache -> "en"
  // Re-entrant per login: callers must reset() on logout so this can run again
  // for the next user without a full page reload (the app is an SPA).
  hydrate: async () => {
    if (get().hydrated || typeof window === "undefined") return;
    set({ hydrated: true });
    try {
      const res = await fetch("/api/user-preferences");
      if (res.ok) {
        const data = await res.json();
        const saved = data?.map?.locale;
        if (isLocale(saved)) {
          localStorage.setItem("velos-locale", saved);
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
          localStorage.setItem("velos-locale", data.default_locale);
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
