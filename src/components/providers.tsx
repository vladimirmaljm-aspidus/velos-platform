"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, ReactNode, useEffect } from "react";
import { useTheme } from "next-themes";
import { useThemeCustomStore } from "@/lib/store/theme-store";
import { useI18nStore } from "@/lib/i18n/store";
import type { Locale } from "@/lib/i18n/dictionaries";
// 8-c (error audit): silent client-side error capture — window "error" +
// "unhandledrejection" listeners POSTing to /api/client-errors. Mounted
// once here (renders null, no visual UI).
import { ErrorReporter } from "@/components/error-reporter";

function ThemeInitializer() {
  const applyTheme = useThemeCustomStore((s) => s.applyTheme);
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    // Re-apply the custom accent whenever light/dark mode changes — the
    // accent's dark-mode value differs from its light-mode value, and both
    // are pushed as an inline style (so they win over the stylesheet
    // defaults), so this must be re-run on every mode switch, not just once.
    applyTheme(resolvedTheme === "dark");
  }, [applyTheme, resolvedTheme]);
  return null;
}

/**
 * audit26 hydration fix — injects the locale the SERVER read from the
 * `velos-locale` cookie into the store BEFORE the first client render.
 *
 * The store initializes to "en" (SSR-safe); the layout (server component)
 * reads the same cookie and renders with that locale, so the client's
 * first render matches the SSR HTML exactly. Without this bridge a saved
 * non-English locale produced React hydration error #418 on every page.
 */
function I18nLocaleBridge({ initialLocale }: { initialLocale: Locale }) {
  useState(() => {
    if (initialLocale !== "en") useI18nStore.setState({ locale: initialLocale });
    return true;
  });
  return null;
}

function I18nInitializer() {
  const hydrate = useI18nStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  return null;
}

export function Providers({
  children,
  initialLocale = "en",
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <ThemeInitializer />
      <I18nLocaleBridge initialLocale={initialLocale} />
      <I18nInitializer />
      <ErrorReporter />
      {children}
    </QueryClientProvider>
  );
}
