/**
 * One-shot i18n injector — party labels + QR toggle (migration 106).
 *
 * Adds 5 "fin-display-*" keys → FINANCE domain:
 *   • fin-display-group-parties — the "Parties" group header
 *   • fin-display-from-label    — From (issuer) box custom header label
 *   • fin-display-to-label      — To (recipient) box custom header label
 *   • fin-display-parties-hint  — hint under the two inputs
 *   • fin-display-qr-label      — QR verification code switch label
 *
 * 13 locales: en/sr/tr/de/ru inline in domains/finance.ts +
 * fr/it/ar/pt/zh/ja/el/es in lang/*.ts FINANCE exports.
 *
 * Idempotency: refuses to run twice (checks for fin-display-group-parties).
 */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "/home/z/velos-platform/src/lib/i18n";

type Loc = string;
const LOCALES = ["en", "sr", "tr", "de", "ru", "fr", "it", "ar", "pt", "zh", "ja", "el", "es"] as const;

// ── key → translation per locale ────────────────────────────────────────────
const FIN: Record<string, Record<Loc, string>> = {
  "fin-display-group-parties": {
    en: "Parties", sr: "Stranke", tr: "Tarafiar", de: "Parteien", ru: "Стороны",
    fr: "Parties", it: "Parti", es: "Partes", pt: "Partes", zh: "当事方",
    ja: "当事者", ar: "الأطراف", el: "Μέρη",
  },
  "fin-display-from-label": {
    en: "From (issuer) label", sr: "Oznaka pošiljaoca (izdavaoca)", tr: "Gönderen (düzenleyen) etiketi",
    de: "Beschriftung Von (Aussteller)", ru: "Подпись отправителя (эмитента)",
    fr: "Libellé De (émetteur)", it: "Etichetta Da (emittente)",
    es: "Etiqueta De (emisor)", pt: "Rótulo De (emitente)",
    zh: "发件方（出具方）标签", ja: "差出人（発行者）ラベル",
    ar: "تسمية المُصدر (المرسل)", el: "Ετικέτα Από (εκδότης)",
  },
  "fin-display-to-label": {
    en: "To (recipient) label", sr: "Oznaka primaoca (klijenta)", tr: "Alıcı (müşteri) etiketi",
    de: "Beschriftung An (Empfänger)", ru: "Подпись получателя (клиента)",
    fr: "Libellé À (destinataire)", it: "Etichetta A (destinatario)",
    es: "Etiqueta Para (destinatario)", pt: "Rótulo Para (destinatário)",
    zh: "收件方（客户）标签", ja: "宛先（顧客）ラベル",
    ar: "تسمية المستلم (العميل)", el: "Ετικέτα Προς (παραλήπτης)",
  },
  "fin-display-parties-hint": {
    en: "Custom headers for the two party boxes — leave empty for the default (services: SERVICE PROVIDER (CONSULTANT) / CLIENT, goods: FROM (SELLER) / TO (BUYER)). Rendered in upper case.",
    sr: "Posebni naslovi za dva bloka strana — ostavite prazno za podrazumevano (usluge: SERVICE PROVIDER (CONSULTANT) / CLIENT, robe: FROM (SELLER) / TO (BUYER)). Ispisano velikim slovima.",
    tr: "İki taraf kutusu için özel başlıklar — varsayılan için boş bırakın (hizmet: SERVICE PROVIDER (CONSULTANT) / CLIENT, mal: FROM (SELLER) / TO (BUYER)). Büyük harfle yazılır.",
    de: "Eigene Überschriften für die beiden Parteifelder — leer lassen für die Vorgabe (Dienstleistungen: SERVICE PROVIDER (CONSULTANT) / CLIENT, Waren: FROM (SELLER) / TO (BUYER)). Wird in Großbuchstaben gedruckt.",
    ru: "Свои заголовки для двух блоков сторон — оставьте пустым для значения по умолчанию (услуги: SERVICE PROVIDER (CONSULTANT) / CLIENT, товары: FROM (SELLER) / TO (BUYER)). Печатается заглавными буквами.",
    fr: "En-têtes personnalisés pour les deux blocs de parties — laissez vide pour la valeur par défaut (services : SERVICE PROVIDER (CONSULTANT) / CLIENT, marchandises : FROM (SELLER) / TO (BUYER)). Imprimé en majuscules.",
    it: "Intestazioni personalizzate per i due blocchi delle parti — lasciare vuoto per il valore predefinito (servizi: SERVICE PROVIDER (CONSULTANT) / CLIENT, beni: FROM (SELLER) / TO (BUYER)). Stampato in maiuscolo.",
    es: "Encabezados personalizados para los dos bloques de partes — dejar vacío para el valor predeterminado (servicios: SERVICE PROVIDER (CONSULTANT) / CLIENT, mercancías: FROM (SELLER) / TO (BUYER)). Se imprime en mayúsculas.",
    pt: "Cabeçalhos personalizados para os dois blocos de partes — deixe vazio para o padrão (serviços: SERVICE PROVIDER (CONSULTANT) / CLIENT, mercadorias: FROM (SELLER) / TO (BUYER)). Impresso em maiúsculas.",
    zh: "两个当事方区块的自定义标题 — 留空使用默认值（服务：SERVICE PROVIDER (CONSULTANT) / CLIENT，货物：FROM (SELLER) / TO (BUYER)）。以大写字母打印。",
    ja: "両当事者ブロックのカスタム見出し — 空欄でデフォルト（サービス: SERVICE PROVIDER (CONSULTANT) / CLIENT、物品: FROM (SELLER) / TO (BUYER)）。大文字で印刷されます。",
    ar: "عناوين مخصصة لكتلتي الأطراف — اتركه فارغًا للقيمة الافتراضية (الخدمات: SERVICE PROVIDER (CONSULTANT) / CLIENT، البضائع: FROM (SELLER) / TO (BUYER)). تُطبع بأحرف كبيرة.",
    el: "Προσαρμοσμένες επικεφαλίδες για τα δύο μπλοκ των μερών — αφήστε κενό για την προεπιλογή (υπηρεσίες: SERVICE PROVIDER (CONSULTANT) / CLIENT, αγαθά: FROM (SELLER) / TO (BUYER)). Εκτυπώνεται με κεφαλαία.",
  },
  "fin-display-qr-label": {
    en: "QR verification code", sr: "QR kod za verifikaciju", tr: "QR doğrulama kodu",
    de: "QR-Bestätigungscode", ru: "QR-код верификации", fr: "Code QR de vérification",
    it: "Codice QR di verifica", es: "Código QR de verificación", pt: "Código QR de verificação",
    zh: "QR 验证码", ja: "QR検証コード", ar: "رمز QR للتحقق", el: "Κωδικός επαλήθευσης QR",
  },
};

const FIN_KEYS = Object.keys(FIN);

function block(keys: string[], dict: Record<string, Record<Loc, string>>, locale: string, indent: string): string {
  return keys.map((k) => `${indent}"${k}": ${JSON.stringify(dict[k][locale])},`).join("\n");
}

// ── 1. domains/finance.ts — en/sr/tr/de/ru inline sections ──────────────────
{
  const file = `${ROOT}/domains/finance.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-display-group-parties"')) throw new Error("finance.ts already has party keys");
  const order = ["en", "sr", "tr", "de", "ru"];
  const anchorRe = /^(\s*)"fin-display-group-sec": ".*",$/gm;
  let i = 0;
  src = src.replace(anchorRe, (m) => {
    const loc = order[i++];
    return `${m}\n\n    // ── Party labels + QR toggle (migration 106) ──\n${block(FIN_KEYS, FIN, loc, "    ")}`;
  });
  if (i !== 5) throw new Error(`finance.ts: expected 5 anchors, found ${i}`);
  writeFileSync(file, src);
  console.log(`finance.ts: inserted ${FIN_KEYS.length} keys x 5 locales`);
}

// ── 2. lang packs — FINANCE exports ─────────────────────────────────────────
for (const loc of ["fr", "it", "ar", "pt", "zh", "ja", "el", "es"]) {
  const file = `${ROOT}/lang/${loc}.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-display-group-parties"')) throw new Error(`${loc}.ts already has party keys`);

  const start = src.indexOf("export const FINANCE: Record<string, string> = {");
  if (start < 0) throw new Error(`${loc}.ts: FINANCE export not found`);
  const end = src.indexOf("};", start);
  if (end < 0) throw new Error(`${loc}.ts: FINANCE closing not found`);
  const blk = `\n  // ── Party labels + QR toggle (migration 106) ──\n` + block(FIN_KEYS, FIN, loc, "  ") + `\n`;
  src = src.slice(0, end) + blk + src.slice(end);
  writeFileSync(file, src);
  console.log(`${loc}.ts: inserted ${FIN_KEYS.length} fin keys`);
}

// ── Sanity: every locale covered for every key ──────────────────────────────
for (const key of Object.keys(FIN)) {
  for (const loc of LOCALES) {
    if (!FIN[key][loc]) throw new Error(`Missing translation: ${key}/${loc}`);
  }
}
console.log("OK — all keys x 13 locales verified");
