/**
 * VELOS — Theme Customization Store
 * Extends next-themes with custom accent colors and themes.
 *
 * The platform's brand identity is **copper** (Veles, god of earth & wealth —
 * see globals.css). Copper is the DEFAULT accent so the VELOS rebrand is
 * visible out-of-the-box, without requiring the user to opt in via the
 * topbar accent picker. Returning users who previously chose a different
 * accent keep their saved selection (see `loadConfig`).
 */
"use client";

import { create } from "zustand";

export type ThemeAccent = "copper" | "navy" | "slate" | "burgundy" | "forest";

export interface ThemeConfig {
  accent: ThemeAccent;
  radius: number; // 0.375 - 0.625
  sidebarDark: boolean;
}

// A restrained, corporate palette — deep, desaturated hues rather than
// bright consumer-app colors. **Copper** is the VELOS platform brand
// color (matching globals.css `--primary`); the others are alternates
// offered in the topbar accent picker.
//
// Each accent exposes a light + dark primary value plus a hue `h`, which
// `applyThemeVars` uses to derive the secondary tokens (--accent,
// --accent-foreground, --primary-foreground, --sidebar-primary, --ring,
// --chart-1, --sidebar-ring). All other CSS variables (--sidebar-accent,
// --sidebar-primary-foreground, --chart-2..5, --brand-gold, ...) keep their
// globals.css defaults, which are already copper-tinted for the brand.
const ACCENT_MAP: Record<ThemeAccent, { light: string; dark: string; h: number }> = {
  copper:   { light: "oklch(0.395 0.115 55)", dark: "oklch(0.68 0.14 58)",  h: 55 },
  navy:     { light: "oklch(0.33 0.085 258)", dark: "oklch(0.66 0.11 258)", h: 258 },
  slate:    { light: "oklch(0.36 0.02 255)",  dark: "oklch(0.68 0.02 255)", h: 255 },
  burgundy: { light: "oklch(0.38 0.11 18)",   dark: "oklch(0.62 0.13 18)",  h: 18 },
  forest:   { light: "oklch(0.4 0.08 152)",   dark: "oklch(0.62 0.1 152)",  h: 152 },
};

const ACCENT_LABELS: Record<ThemeAccent, string> = {
  copper: "Copper (VELOS)",
  navy: "Navy",
  slate: "Slate",
  burgundy: "Burgundy",
  forest: "Forest",
};

export { ACCENT_MAP, ACCENT_LABELS };

interface ThemeCustomState {
  config: ThemeConfig;
  setConfig: (c: Partial<ThemeConfig>) => void;
  applyTheme: (isDark?: boolean) => void;
}

// VELOS brand default — copper. Previously "navy" (the pre-rebrand
// platform default), which caused the copper --primary defined in
// globals.css to be overridden on every page mount by `applyThemeVars`.
// Copper here matches globals.css `--primary: oklch(0.395 0.115 55)` so
// the inline-style override is now a no-op for the brand default and
// the VELOS copper is finally visible to users.
const DEFAULT_CONFIG: ThemeConfig = { accent: "copper", radius: 0.5, sidebarDark: false };

function loadConfig(): ThemeConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const saved = localStorage.getItem("velos-theme-config");
    if (saved) {
      const parsed = JSON.parse(saved);
      // Migrate old consumer-palette accent names (emerald/ocean/sunset/rose/violet)
      // to the new corporate palette so returning users don't get stuck on a
      // value that no longer exists in ACCENT_MAP.
      //
      // Migration note (F-1): previously this fell back to "navy" (the old
      // platform default). It now falls back to "copper" (the VELOS brand
      // default) so users with a stale/corrupt saved config land on the
      // correct brand identity. Users with a valid saved accent (including
      // "navy" if they explicitly chose it) keep their selection.
      if (!(parsed.accent in ACCENT_MAP)) parsed.accent = "copper";
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {}
  return DEFAULT_CONFIG;
}

function isDarkNow(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export const useThemeCustomStore = create<ThemeCustomState>((set, get) => ({
  config: loadConfig(),
  setConfig: (partial) => {
    const config = { ...get().config, ...partial };
    if (typeof window !== "undefined") localStorage.setItem("velos-theme-config", JSON.stringify(config));
    set({ config });
    // Apply immediately
    applyThemeVars(config, isDarkNow());
  },
  applyTheme: (isDark) => {
    applyThemeVars(get().config, isDark ?? isDarkNow());
  },
}));

function applyThemeVars(config: ThemeConfig, isDark: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const accent = ACCENT_MAP[config.accent];
  if (!accent) return;
  const value = isDark ? accent.dark : accent.light;
  const fgLightness = isDark ? "0.125 0.005" : "0.99 0.002";

  root.style.setProperty("--primary", value);
  root.style.setProperty("--primary-foreground", `oklch(${fgLightness} ${accent.h})`);
  root.style.setProperty("--ring", value);
  root.style.setProperty("--accent", isDark ? `oklch(0.255 0.03 ${accent.h})` : `oklch(0.94 0.014 ${accent.h})`);
  root.style.setProperty("--accent-foreground", isDark ? `oklch(0.9 0.025 ${accent.h})` : `oklch(0.26 0.06 ${accent.h})`);
  root.style.setProperty("--chart-1", value);

  // Sidebar primary — matches the same accent, tuned per mode
  root.style.setProperty("--sidebar-primary", value);
  root.style.setProperty("--sidebar-ring", value);

  // Radius
  root.style.setProperty("--radius", `${config.radius}rem`);
}
