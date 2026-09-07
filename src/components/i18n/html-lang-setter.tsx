"use client";

import { useEffect } from "react";
import { useI18nStore } from "@/lib/i18n/store";
import { RTL_LOCALES } from "@/lib/i18n/dictionaries";
import type { Locale } from "@/lib/i18n/dictionaries";

/**
 * Syncs the `<html lang="…">` and `<html dir="…">` attributes with the
 * user's active locale in the i18n Zustand store. The root `layout.tsx`
 * is a server component and renders `<html lang="en" dir="ltr">` by default
 * (so crawlers + first-paint SR users see English); this client component
 * runs after hydration and on every subsequent locale change to keep both
 * attributes accurate for screen readers, browser translation prompts and
 * right-to-left mirroring (Arabic).
 */
export function HtmlLangSetter() {
  const locale = useI18nStore((s) => s.locale);

  useEffect(() => {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = locale;
      document.documentElement.dir = isRtl(locale) ? "rtl" : "ltr";
    }
  }, [locale]);

  return null;
}

function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}
