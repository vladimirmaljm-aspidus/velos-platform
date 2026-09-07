/**
 * VELOS — i18n completeness & quality checker.
 *
 * Run: bun run scripts/i18n-check.ts [--verbose]
 *
 * Merges every dictionary (NAV / SECTIONS / UI / DASHBOARD + the 9 domain
 * dicts) and validates all locales against the English source:
 *   1. missing keys  — key exists in en but not in the locale
 *   2. extra keys    — key exists in the locale but not in en (stale)
 *   3. placeholders  — {var} placeholders present in en but lost in translation
 *   4. untranslated  — locale value is byte-identical to en (suspicious;
 *                      whitelist keeps legitimate as-is entries)
 *
 * Exit code 0 when no locale has missing keys or placeholder mismatches.
 */
import { NAV, SECTIONS, UI, DASHBOARD, LOCALE_LABELS, type Locale } from "../src/lib/i18n/dictionaries";
import { CRM } from "../src/lib/i18n/domains/crm";
import { FINANCE } from "../src/lib/i18n/domains/finance";
import { LOGISTICS } from "../src/lib/i18n/domains/logistics";
import { DOCUMENTS } from "../src/lib/i18n/domains/documents";
import { ADMINISTRATION } from "../src/lib/i18n/domains/administration";
import { PLATFORM } from "../src/lib/i18n/domains/platform";
import { MISC } from "../src/lib/i18n/domains/misc";
import { PORTAL } from "../src/lib/i18n/domains/portal";
import { ERROR_AUDIT } from "../src/lib/i18n/domains/error-audit";

const DICTS: Record<string, Record<Locale, Record<string, string>>> = {
  NAV, SECTIONS, UI, DASHBOARD, CRM, FINANCE, LOGISTICS, DOCUMENTS,
  ADMINISTRATION, PLATFORM, MISC, PORTAL, ERROR_AUDIT,
};

// Values that are legitimately identical to English (brand names, codes,
// universal abbreviations). Compared case-insensitively.
const SAME_AS_EN_OK = new Set([
  "kyc", "api", "erp", "crm", "velos", "aspidus", "webhooks", "rss",
  "eta", "etd", "hs code", "swift", "iban", "vat id", "eori", "iso",
  "pdf", "csv", "xls", "xlsx", "json", "id", "ip", "url", "ssl", "2fa",
  "sso", "b/l", "bl", "lc", "fob", "cif", "exw", "dap", "ddp", "cfr", "fas", "fca", "cip", "dpu", "daf",
]);

function isLegitimatelySameAsEn(en: string, loc: string): boolean {
  const a = en.trim().toLowerCase();
  const b = loc.trim().toLowerCase();
  if (a !== b) return false;
  // single tokens like "KYC", "API" or short lists of pure-latin acronyms
  if (/^[a-z0-9\s\/\.\-\+&%°'"(),:]+$/.test(a) && a.length <= 40) {
    // pure ASCII short string — only OK if every word is whitelisted
    const words = a.split(/[\s\/,]+/).filter(Boolean);
    if (words.length > 0 && words.every((w) => SAME_AS_EN_OK.has(w.replace(/[().,:'""]/g, "")))) return true;
  }
  return false;
}

function placeholders(s: string): string[] {
  return (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();
}

const locales = Object.keys(LOCALE_LABELS) as Locale[];
const verbose = process.argv.includes("--verbose");

// --missing <loc> [DictName]: dump ALL missing en keys for one locale
// (optionally limited to one dictionary) — used by translation agents.
const missingIdx = process.argv.indexOf("--missing");
if (missingIdx !== -1) {
  const loc = process.argv[missingIdx + 1] as Locale;
  const onlyDict = process.argv[missingIdx + 2];
  if (!loc || !locales.includes(loc)) {
    console.error("Usage: bun run scripts/i18n-check.ts --missing <loc> [DictName]");
    process.exit(2);
  }
  for (const [dictName, dict] of Object.entries(DICTS)) {
    if (onlyDict && dictName !== onlyDict) continue;
    const block = dict[loc] || {};
    const have = new Set(Object.keys(block));
    const missing = Object.keys(dict.en).filter((k) => !have.has(k));
    console.log(`### ${dictName} — ${missing.length} missing`);
    for (const k of missing) console.log(`${k}\t${dict.en[k]}`);
  }
  process.exit(0);
}
let anyFatal = false;

console.log(`VELOS i18n check — ${locales.length} locales\n`);

for (const dictName of Object.keys(DICTS)) {
  const dict = DICTS[dictName];
  const enKeys = Object.keys(dict.en);
  console.log(`■ ${dictName}  (${enKeys.length} en keys)`);
  for (const loc of locales) {
    if (loc === "en") continue;
    const block = dict[loc] || {};
    const missing: string[] = [];
    const extra: string[] = [];
    const badPh: string[] = [];
    const untranslated: string[] = [];
    const locKeys = new Set(Object.keys(block));
    for (const k of enKeys) {
      if (!locKeys.has(k)) { missing.push(k); continue; }
      const en = dict.en[k];
      const lv = block[k];
      if (placeholders(en).join("|") !== placeholders(lv).join("|")) badPh.push(k);
      else if (isLegitimatelySameAsEn(en, lv) === false && lv === en) untranslated.push(k);
    }
    for (const k of locKeys) if (!enKeys.includes(k)) extra.push(k);
    const parts: string[] = [];
    if (missing.length) parts.push(`missing=${missing.length}`);
    if (badPh.length) parts.push(`placeholder-mismatch=${badPh.length}`);
    if (untranslated.length) parts.push(`same-as-en=${untranslated.length}`);
    if (extra.length) parts.push(`stale=${extra.length}`);
    if (parts.length) {
      console.log(`   ${loc}: ${parts.join("  ")}`);
      if (missing.length || badPh.length) anyFatal = true;
      if (verbose) {
        if (missing.length) console.log(`      missing: ${missing.slice(0, 25).join(", ")}${missing.length > 25 ? ` … (+${missing.length - 25})` : ""}`);
        if (badPh.length) console.log(`      placeholder: ${badPh.slice(0, 25).join(", ")}`);
        if (untranslated.length) console.log(`      same-as-en: ${untranslated.slice(0, 15).join(", ")}${untranslated.length > 15 ? ` … (+${untranslated.length - 15})` : ""}`);
        if (extra.length) console.log(`      stale: ${extra.slice(0, 15).join(", ")}`);
      }
    } else {
      console.log(`   ${loc}: ✓ complete`);
    }
  }
  console.log("");
}

// Per-locale totals
console.log("── Totals per locale ──────────────────────────────");
const allEn = new Set<string>();
for (const dict of Object.values(DICTS)) for (const k of Object.keys(dict.en)) allEn.add(k);
console.log(`English source keys: ${allEn.size}`);
for (const loc of locales) {
  if (loc === "en") continue;
  const have = new Set<string>();
  for (const dict of Object.values(DICTS)) for (const k of Object.keys(dict[loc] || {})) have.add(k);
  let missing = 0;
  for (const k of allEn) if (!have.has(k)) missing++;
  console.log(`${loc} (${LOCALE_LABELS[loc]}): ${allEn.size - missing}/${allEn.size} keys${missing ? `  ⚠ ${missing} missing` : "  ✓ 100%"}`);
}

process.exit(anyFatal ? 1 : 0);
