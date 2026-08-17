// Formatting helpers shared across views.
//
// Date formatters (`fmtDate`, `fmtDateShort`, `fmtDateTime`) honour the user's
// active locale from the `useI18nStore` (Serbian / Turkish / German / Russian
// users see their native month/day names). On the server (during SSR or from
// non-React contexts where the store isn't hydrated yet) they fall back to
// "en-US" so rendering never throws.

import { useI18nStore } from "@/lib/i18n/store";
import type { Locale } from "@/lib/i18n/dictionaries";

/** BCP-47 region tags the Intl APIs accept for each platform locale. */
const LOCALE_TAG: Record<Locale, string> = {
  en: "en-US",
  sr: "sr-Latn-RS",
  tr: "tr-TR",
  de: "de-DE",
  ru: "ru-RU",
};

/**
 * Synchronously read the active user locale from the i18n store. Returns
 * "en-US" if the store is unavailable (SSR, non-browser) or hasn't hydrated
 * yet — call sites keep working instead of throwing.
 */
function activeDateLocale(): string {
  try {
    const l = useI18nStore.getState?.()?.locale;
    if (l && LOCALE_TAG[l]) return LOCALE_TAG[l];
  } catch {
    // store unavailable (SSR or non-React context) — fall through
  }
  return "en-US";
}

/**
 * Format a money value with exactly 2 decimal places.
 * This is the default money formatter — always shows 2 decimals so that
 * prices like 1.15 are displayed correctly (not rounded to 1).
 */
export function fmtMoney(n: number | null | undefined, currency = "USD"): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  try {
    // Thousands separators kept — readability at large amounts (1,000,000).
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${Number(n).toFixed(2)} ${currency}`;
  }
}

/**
 * Detailed money formatter — same as fmtMoney (2 decimals).
 * Kept for backward compatibility.
 */
export function fmtMoneyDetailed(n: number | null | undefined, currency = "USD"): string {
  return fmtMoney(n, currency);
}

/**
 * Format a number with up to 2 decimal places (trailing zeros removed).
 * Use this for quantities, rates, percentages.
 */
export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

export function fmtDate(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(activeDateLocale(), opts || {
    day: "2-digit", month: "short", year: "numeric",
  }).format(new Date(iso));
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(activeDateLocale(), { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(activeDateLocale(), {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
