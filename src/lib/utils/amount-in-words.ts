/**
 * Convert a numeric amount into English words (e.g. 171000 → "SAY: ONE
 * HUNDRED SEVENTY-ONE THOUSAND US DOLLARS ONLY").
 *
 * AUDIT19 (dedup #5) — the single canonical implementation. Previously the
 * PDF generator (src/lib/pdf/shared.ts) and the offer form
 * (src/components/views/offers-view.tsx) each carried their own copy, and
 * they DRIFTED: the form previewed "Minus One Hundred US Dollars and
 * 25/100 Only" while the PDF printed "SAY: NEGATIVE ONE HUNDRED US DOLLARS
 * AND 25/100 ONLY" — the legal "Amount in Words" line could disagree with
 * the printed document. Both now import this module (pdf/shared re-exports
 * it for backward compatibility).
 *
 * This module is intentionally dependency-free so it can be imported from
 * BOTH client components and the react-pdf server bundle.
 */

const CURRENCY_NAMES: Record<string, string> = {
  USD: "US DOLLARS",
  EUR: "EUROS",
  GBP: "POUNDS STERLING",
  CHF: "SWISS FRANCS",
  AED: "UAE DIRHAMS",
  CNY: "CHINESE YUAN",
  INR: "INDIAN RUPEES",
  RUB: "RUSSIAN RUBLES",
  JPY: "JAPANESE YEN",
  SAR: "SAUDI RIYALS",
  BRL: "BRAZILIAN REAL",
  ZAR: "SOUTH AFRICAN RAND",
  TRY: "TURKISH LIRA",
  SGD: "SINGAPORE DOLLARS",
  HKD: "HONG KONG DOLLARS",
};

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
const TEENS = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function threeDigitsToWords(n: number): string {
  if (n === 0) return "";
  let str = "";
  const hundred = Math.floor(n / 100);
  const remainder = n % 100;
  if (hundred > 0) str += ONES[hundred] + " Hundred";
  if (remainder > 0) {
    if (str) str += " ";
    if (remainder < 10) str += ONES[remainder];
    else if (remainder < 20) str += TEENS[remainder - 10];
    else {
      const t = Math.floor(remainder / 10);
      const o = remainder % 10;
      str += TENS[t];
      if (o > 0) str += "-" + ONES[o];
    }
  }
  return str;
}

/**
 * Convert a numeric amount into English words (e.g. 171000 → "SAY: ONE
 * HUNDRED SEVENTY-ONE THOUSAND US DOLLARS ONLY"). Used by the "Amount in
 * Words" line that international trade documents (invoices, proformas,
 * offers) legally require. Handles up to billions, negative values, cents.
 */
export function amountInWords(amount: number, currency = "USD"): string {
  const currName = CURRENCY_NAMES[currency] ?? currency;

  if (!isFinite(amount)) {
    return `SAY: ZERO ${currName} ONLY`;
  }

  const negative = amount < 0;
  const absAmount = Math.abs(amount);
  const whole = Math.floor(absAmount);
  const cents = Math.round((absAmount - whole) * 100);

  let words: string;
  if (whole === 0) {
    words = "Zero";
  } else {
    const billions = Math.floor(whole / 1000000000);
    const millions = Math.floor((whole % 1000000000) / 1000000);
    const thousands = Math.floor((whole % 1000000) / 1000);
    const remainder = whole % 1000;

    const parts: string[] = [];
    if (billions > 0) parts.push(threeDigitsToWords(billions) + " Billion");
    if (millions > 0) parts.push(threeDigitsToWords(millions) + " Million");
    if (thousands > 0) parts.push(threeDigitsToWords(thousands) + " Thousand");
    if (remainder > 0) parts.push(threeDigitsToWords(remainder));
    words = parts.join(" ");
  }

  let result = `SAY: ${negative ? "NEGATIVE " : ""}${words} ${currName}`;
  if (cents > 0) result += ` AND ${cents}/100`;
  result += " ONLY";
  return result;
}
