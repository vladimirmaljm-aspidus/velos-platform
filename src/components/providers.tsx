"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, ReactNode, useEffect } from "react";
import { useTheme } from "next-themes";
import { useThemeCustomStore } from "@/lib/store/theme-store";
import { useI18nStore } from "@/lib/i18n/store";

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

function I18nInitializer() {
  const hydrate = useI18nStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
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
      <I18nInitializer />
      {children}
    </QueryClientProvider>
  );
}
