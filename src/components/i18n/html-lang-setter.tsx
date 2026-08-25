"use client";

import { useEffect } from "react";
import { useI18nStore } from "@/lib/i18n/store";

/**
 * Syncs the `<html lang="…">` attribute with the user's active locale in the
 * i18n Zustand store. The root `layout.tsx` is a server component and renders
 * `<html lang="en">` by default (so crawlers + first-paint SR users see English);
 * this client component runs after hydration and on every subsequent locale
 * change to keep `document.documentElement.lang` accurate for screen readers
 * and browser translation prompts.
 */
export function HtmlLangSetter() {
  const locale = useI18nStore((s) => s.locale);

  useEffect(() => {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  return null;
}
