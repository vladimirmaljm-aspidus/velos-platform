/**
 * One-shot i18n injector — signature mode (migration 107).
 *
 * Adds 7 "fin-display-*" keys → FINANCE domain:
 *   • fin-display-sigmode-label    — "Signatures" group label
 *   • fin-display-sigmode-auto     — Auto (default for the doc type)
 *   • fin-display-sigmode-both     — both signature boxes
 *   • fin-display-sigmode-client   — client acceptance only
 *   • fin-display-sigmode-generated— no boxes, generated-validity line
 *   • fin-display-sigmode-hidden   — hidden completely
 *   • fin-display-sig-note-label   — custom validity note label
 *
 * 13 locales: en/sr/tr/de/ru inline in domains/finance.ts +
 * fr/it/ar/pt/zh/ja/el/es in lang/*.ts FINANCE exports.
 *
 * Idempotency: refuses to run twice (checks for fin-display-sigmode-label).
 */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "/home/z/velos-platform/src/lib/i18n";

type Loc = string;
const LOCALES = ["en", "sr", "tr", "de", "ru", "fr", "it", "ar", "pt", "zh", "ja", "el", "es"] as const;

// ── key → translation per locale ────────────────────────────────────────────
const FIN: Record<string, Record<Loc, string>> = {
  "fin-display-sigmode-label": {
    en: "Signatures", sr: "Potpisi", tr: "İmzalar", de: "Unterschriften", ru: "Подписи",
    fr: "Signatures", it: "Firme", es: "Firmas", pt: "Assinaturas", zh: "签名",
    ja: "署名", ar: "التوقيعات", el: "Υπογραφές",
  },
  "fin-display-sigmode-auto": {
    en: "Auto — default for this document type (invoice: validity line, no signatures)",
    sr: "Auto — podrazumevano za ovaj tip dokumenta (faktura: linija o važenju, bez potpisa)",
    tr: "Otomatik — bu belge türü için varsayılan (fatura: geçerlilik satırı, imzasız)",
    de: "Automatisch — Standard für diesen Dokumenttyp (Rechnung: Gültigkeitszeile, ohne Unterschriften)",
    ru: "Авто — по умолчанию для этого типа документа (инвойс: строка о действительности, без подписей)",
    fr: "Auto — valeur par défaut pour ce type de document (facture : ligne de validité, sans signatures)",
    it: "Auto — predefinito per questo tipo di documento (fattura: riga di validità, senza firme)",
    es: "Auto — predeterminado para este tipo de documento (factura: línea de validez, sin firmas)",
    pt: "Auto — padrão para este tipo de documento (fatura: linha de validade, sem assinaturas)",
    zh: "自动 — 此单据类型的默认值（发票：有效性说明行，无签名）",
    ja: "自動 — この書類タイプのデフォルト（請求書：有効性の一行、署名なし）",
    ar: "تلقائي — الافتراضي لهذا النوع من المستندات (الفاتورة: سطر الصلاحية، بدون توقيعات)",
    el: "Αυτόματο — προεπιλογή για αυτό τον τύπο εγγράφου (τιμολόγιο: γραμμή ισχύος, χωρίς υπογραφές)",
  },
  "fin-display-sigmode-both": {
    en: "Both parties sign", sr: "Potpisuju obe strane", tr: "Her iki taraf imzalar",
    de: "Beide Parteien unterschreiben", ru: "Подписывают обе стороны",
    fr: "Les deux parties signent", it: "Firma entrambe le parti",
    es: "Firman ambas partes", pt: "Ambas as partes assinam",
    zh: "双方签名", ja: "両者が署名", ar: "كلا الطرفين يوقّعان", el: "Υπογράφουν και τα δύο μέρη",
  },
  "fin-display-sigmode-client": {
    en: "Client acceptance only", sr: "Samo prihvatanje klijenta", tr: "Sadece müşteri onayı",
    de: "Nur Kundenannahme", ru: "Только согласие клиента",
    fr: "Acceptation du client uniquement", it: "Solo accettazione del cliente",
    es: "Solo aceptación del cliente", pt: "Apenas aceitação do cliente",
    zh: "仅客户签署确认", ja: "顧客の同意のみ", ar: "قبول العميل فقط", el: "Μό αποδοχή πελάτη",
  },
  "fin-display-sigmode-generated": {
    en: "No signatures — electronically generated & valid",
    sr: "Bez potpisa — elektronski generisan i važeći",
    tr: "İmzasız — elektronik olarak oluşturulmuş ve geçerli",
    de: "Keine Unterschriften — elektronisch erstellt und gültig",
    ru: "Без подписей — создан электронно и действителен",
    fr: "Sans signatures — généré électroniquement et valide",
    it: "Senza firme — generato elettronicamente e valido",
    es: "Sin firmas — generado electrónicamente y válido",
    pt: "Sem assinaturas — gerado eletronicamente e válido",
    zh: "无签名 — 电子生成且有效",
    ja: "署名なし — 電子的に生成され有効",
    ar: "بدون توقيعات — مُنشأ إلكترونيًا وصالح",
    el: "Χωρίς υπογραφές — δημιουργήθηκε ηλεκτρονικά και ισχύει",
  },
  "fin-display-sigmode-hidden": {
    en: "Hidden completely", sr: "Potpuno sakriveno", tr: "Tamamen gizli",
    de: "Vollständig ausgeblendet", ru: "Полностью скрыто", fr: "Masqué complètement",
    it: "Completamente nascosto", es: "Oculto por completo", pt: "Oculto completamente",
    zh: "完全隐藏", ja: "完全に非表示", ar: "مخفي بالكامل", el: "Πλήρως κρυφό",
  },
  "fin-display-sig-note-label": {
    en: "Validity note text", sr: "Tekst napomene o važenju", tr: "Geçerlilik notu metni",
    de: "Text des Gültigkeitshinweises", ru: "Текст примечания о действительности",
    fr: "Texte de la note de validité", it: "Testo della nota di validità",
    es: "Texto de la nota de validez", pt: "Texto da nota de validade",
    zh: "有效性说明文本", ja: "有効性注記テキスト", ar: "نص ملاحظة الصلاحية",
    el: "Κείμενο σημείωσης ισχύος",
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
  if (src.includes('"fin-display-sigmode-label"')) throw new Error("finance.ts already has signature-mode keys");
  const order = ["en", "sr", "tr", "de", "ru"];
  const anchorRe = /^(\s*)"fin-display-qr-label": ".*",$/gm;
  let i = 0;
  src = src.replace(anchorRe, (m) => {
    const loc = order[i++];
    return `${m}\n\n    // ── Signature mode (migration 107) ──\n${block(FIN_KEYS, FIN, loc, "    ")}`;
  });
  if (i !== 5) throw new Error(`finance.ts: expected 5 anchors, found ${i}`);
  writeFileSync(file, src);
  console.log(`finance.ts: inserted ${FIN_KEYS.length} keys x 5 locales`);
}

// ── 2. lang packs — FINANCE exports ─────────────────────────────────────────
for (const loc of ["fr", "it", "ar", "pt", "zh", "ja", "el", "es"]) {
  const file = `${ROOT}/lang/${loc}.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-display-sigmode-label"')) throw new Error(`${loc}.ts already has signature-mode keys`);

  const start = src.indexOf("export const FINANCE: Record<string, string> = {");
  if (start < 0) throw new Error(`${loc}.ts: FINANCE export not found`);
  const end = src.indexOf("};", start);
  if (end < 0) throw new Error(`${loc}.ts: FINANCE closing not found`);
  const blk = `\n  // ── Signature mode (migration 107) ──\n` + block(FIN_KEYS, FIN, loc, "  ") + `\n`;
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
