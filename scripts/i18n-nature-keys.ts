/**
 * One-shot i18n injector — feature "goods vs services documents" (migration 103).
 *
 * Adds:
 *   • 24 "fin-nature-*" / "fin-service-*" keys → FINANCE domain
 *     (en/sr/tr/de/ru inline in domains/finance.ts +
 *      ar/el/es/fr/it/ja/pt/zh in lang/*.ts FINANCE exports)
 *   • 1 "misc-unit-service" key → MISC domain (same 13 locales)
 *
 * Idempotency: refuses to run twice (checks for fin-nature-goods).
 */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "/home/z/velos-platform/src/lib/i18n";

type Loc = string;
const LOCALES = ["en", "sr", "tr", "de", "ru", "fr", "it", "ar", "pt", "zh", "ja", "el", "es"] as const;

// ── key → translation per locale ────────────────────────────────────────────
const T: Record<string, Record<Loc, string>> = {
  "fin-nature-label": {
    en: "Document type", sr: "Vrsta dokumenta", tr: "Belge türü", de: "Dokumenttyp",
    ru: "Тип документа", fr: "Type de document", it: "Tipo di documento", es: "Tipo de documento",
    pt: "Tipo de documento", zh: "单据类型", ja: "書類タイプ", ar: "نوع المستند", el: "Τύπος εγγράφου",
  },
  "fin-nature-goods": {
    en: "Goods", sr: "Robe", tr: "Mal", de: "Waren", ru: "Товары", fr: "Marchandises",
    it: "Merci", es: "Mercancías", pt: "Mercadorias", zh: "货物", ja: "物品", ar: "بضائع", el: "Εμπορεύματα",
  },
  "fin-nature-services": {
    en: "Services", sr: "Usluge", tr: "Hizmetler", de: "Dienstleistungen", ru: "Услуги",
    fr: "Services", it: "Servizi", es: "Servicios", pt: "Serviços", zh: "服务", ja: "サービス",
    ar: "خدمات", el: "Υπηρεσίες",
  },
  "fin-nature-goods-desc": {
    en: "Physical goods — HS codes, origin & trade terms",
    sr: "Fizička roba — HS kodovi, poreklo i trgovački uslovi",
    tr: "Fiziksel mallar — HS kodları, menşe ve ticaret şartları",
    de: "Physische Waren — HS-Codes, Ursprung und Handelsbedingungen",
    ru: "Физические товары — коды ТН ВЭД, происхождение и условия сделки",
    fr: "Marchandises physiques — codes SH, origine et conditions commerciales",
    it: "Beni fisici — codici SA, origine e condizioni commerciali",
    es: "Mercancías físicas — códigos SA, origen y condiciones comerciales",
    pt: "Mercadorias físicas — códigos HS, origem e condições comerciais",
    zh: "实物货物 — HS编码、原产地及贸易条款",
    ja: "現物商品 — HSコード、原産地、取引条件",
    ar: "بضائع مادية — رموز النظام المنسق والمنشأ وشروط التجارة",
    el: "Φυσικά αγαθά — κωδικοί HS, προέλευση και εμπορικοί όροι",
  },
  "fin-nature-services-desc": {
    en: "Services only — period, time units & service location",
    sr: "Samo usluge — period, vremenske jedinice i mesto usluge",
    tr: "Yalnızca hizmetler — dönem, zaman birimleri ve hizmet yeri",
    de: "Nur Dienstleistungen — Zeitraum, Zeiteinheiten und Leistungsort",
    ru: "Только услуги — период, единицы времени и место оказания",
    fr: "Services uniquement — période, unités de temps et lieu de prestation",
    it: "Solo servizi — periodo, unità di tempo e luogo di prestazione",
    es: "Solo servicios — periodo, unidades de tiempo y lugar del servicio",
    pt: "Apenas serviços — período, unidades de tempo e local do serviço",
    zh: "仅服务 — 服务期、时间单位及服务地点",
    ja: "サービスのみ — 期間、時間単位、サービス提供場所",
    ar: "خدمات فقط — الفترة ووحدات الوقت ومكان تقديم الخدمة",
    el: "Μόνο υπηρεσίες — περίοδος, μονάδες χρόνου και τόπος παροχής",
  },
  "fin-nature-badge-goods": {
    en: "Goods", sr: "Robe", tr: "Mal", de: "Waren", ru: "Товары", fr: "Marchandises",
    it: "Merci", es: "Mercancías", pt: "Mercadorias", zh: "货物", ja: "物品", ar: "بضائع", el: "Εμπορεύματα",
  },
  "fin-nature-badge-services": {
    en: "Services", sr: "Usluge", tr: "Hizmet", de: "Leistung", ru: "Услуги",
    fr: "Services", it: "Servizi", es: "Servicios", pt: "Serviços", zh: "服务", ja: "サービス",
    ar: "خدمات", el: "Υπηρεσίες",
  },
  "fin-nature-filter": {
    en: "Type", sr: "Vrsta", tr: "Tür", de: "Typ", ru: "Тип", fr: "Type", it: "Tipo",
    es: "Tipo", pt: "Tipo", zh: "类型", ja: "タイプ", ar: "النوع", el: "Τύπος",
  },
  "fin-nature-all": {
    en: "All", sr: "Sve", tr: "Tümü", de: "Alle", ru: "Все", fr: "Tous", it: "Tutti",
    es: "Todos", pt: "Todos", zh: "全部", ja: "すべて", ar: "الكل", el: "Όλα",
  },
  "fin-nature-hint-services": {
    en: "No HS codes, origin or shipping fields — the document renders as a service document.",
    sr: "Bez HS kodova, porekla i otpremnih polja — dokument se renderuje kao dokument usluge.",
    tr: "HS kodu, menşe veya sevkiye alanı yok — belge bir hizmet belgesi olarak hazırlanır.",
    de: "Keine HS-Codes, Ursprungs- oder Versandfelder — das Dokument wird als Dienstleistungsdokument erzeugt.",
    ru: "Без кодов ТН ВЭД, происхождения и полей отгрузки — документ оформляется как документ на услуги.",
    fr: "Pas de codes SH, d'origine ni de champs d'expédition — le document est généré comme document de service.",
    it: "Nessun codice SA, origine o campi di spedizione — il documento viene generato come documento di servizi.",
    es: "Sin códigos SA, origen ni campos de envío — el documento se genera como documento de servicios.",
    pt: "Sem códigos HS, origem ou campos de envio — o documento é gerado como documento de serviços.",
    zh: "无HS编码、原产地或发货字段 — 单据将按服务单据生成。",
    ja: "HSコード・原産地・出荷フィールドなし — 書類はサービス書類として生成されます。",
    ar: "لا رموز نظام منسق ولا منشأ ولا حقول شحن — يُنشأ المستند كمستند خدمات.",
    el: "Χωρίς κωδικούς HS, προέλευση ή πεδία αποστολής — το έγγραφο δημιουργείται ως έγγραφο υπηρεσιών.",
  },
  "fin-service-details": {
    en: "Service Details", sr: "Detalji usluge", tr: "Hizmet Detayları", de: "Dienstleistungsdetails",
    ru: "Детали услуги", fr: "Détails de la prestation", it: "Dettagli del servizio",
    es: "Detalles del servicio", pt: "Detalhes do serviço", zh: "服务详情", ja: "サービス詳細",
    ar: "تفاصيل الخدمة", el: "Λεπτομέρειες υπηρεσίας",
  },
  "fin-service-period": {
    en: "Service period", sr: "Period usluge", tr: "Hizmet dönemi", de: "Leistungszeitraum",
    ru: "Период оказания услуг", fr: "Période de prestation", it: "Periodo di servizio",
    es: "Periodo del servicio", pt: "Período do serviço", zh: "服务期", ja: "サービス期間",
    ar: "فترة الخدمة", el: "Περίοδος υπηρεσίας",
  },
  "fin-service-period-from": {
    en: "From", sr: "Od", tr: "Başlangıç", de: "Von", ru: "С", fr: "Du", it: "Dal",
    es: "Desde", pt: "De", zh: "从", ja: "開始", ar: "من", el: "Από",
  },
  "fin-service-period-to": {
    en: "To", sr: "Do", tr: "Bitiş", de: "Bis", ru: "По", fr: "Au", it: "Al",
    es: "Hasta", pt: "Até", zh: "至", ja: "終了", ar: "إلى", el: "Έως",
  },
  "fin-service-period-hint": {
    en: "Overall period covered by this document", sr: "Ukupan period koji dokument pokriva",
    tr: "Bu belgenin kapsadığı toplam dönem", de: "Gesamtzeitraum, den dieses Dokument abdeckt",
    ru: "Общий период, который охватывает документ", fr: "Période globale couverte par ce document",
    it: "Periodo complessivo coperto da questo documento",
    es: "Periodo total cubierto por este documento", pt: "Período total abrangido por este documento",
    zh: "本单据覆盖的总期间", ja: "この書類がカバーする全期間",
    ar: "الفترة الإجمالية التي يغطيها هذا المستند", el: "Συνολική περίοδος που καλύπτει το έγγραφο",
  },
  "fin-service-location": {
    en: "Place of service", sr: "Mesto pružanja usluge", tr: "Hizmet yeri", de: "Leistungsort",
    ru: "Место оказания услуг", fr: "Lieu de prestation", it: "Luogo di prestazione",
    es: "Lugar del servicio", pt: "Local do serviço", zh: "服务地点", ja: "サービス提供場所",
    ar: "مكان تقديم الخدمة", el: "Τόπος παροχής υπηρεσίας",
  },
  "fin-service-location-ph": {
    en: "e.g. Client premises, Dubai, UAE", sr: "npr. Sedište klijenta, Dubai, UAE",
    tr: "örn. Müşteri binası, Dubai, BAE", de: "z. B. Räumlichkeiten des Kunden, Dubai, VAE",
    ru: "напр. офис клиента, Дубай, ОАЭ", fr: "ex. locaux du client, Dubaï, EAU",
    it: "es. sede del cliente, Dubai, Emirati Arabi Uniti",
    es: "ej. oficinas del cliente, Dubái, EAU", pt: "ex. instalações do cliente, Dubai, EAU",
    zh: "例如：客户场所，迪拜，阿联酋", ja: "例：顧客事業所、ドバイ、UAE",
    ar: "مثال: مقر العميل، دبي، الإمارات", el: "π.χ. εγκαταστάσεις πελάτη, Ντουμπάι, ΗΑΕ",
  },
  "fin-service-name": {
    en: "Service", sr: "Usluga", tr: "Hizmet", de: "Dienstleistung", ru: "Услуга", fr: "Service",
    it: "Servizio", es: "Servicio", pt: "Serviço", zh: "服务", ja: "サービス", ar: "الخدمة", el: "Υπηρεσία",
  },
  "fin-service-name-ph": {
    en: "e.g. Business consulting — market entry study", sr: "npr. Poslovni konsalting — studija ulaska na tržište",
    tr: "örn. İş danışmanlığı — pazara giriş çalışması",
    de: "z. B. Unternehmensberatung — Markteintrittsstudie",
    ru: "напр. Бизнес-консалтинг — исследование выхода на рынок",
    fr: "ex. Conseil aux entreprises — étude d'entrée sur le marché",
    it: "es. Consulenza aziendale — studio di ingresso sul mercato",
    es: "ej. Consultoría de negocio — estudio de entrada al mercado",
    pt: "ex. Consultoria de negócios — estudo de entrada no mercado",
    zh: "例如：商业咨询 — 市场准入研究", ja: "例：経営コンサルティング — 市場参入調査",
    ar: "مثال: استشارات أعمال — دراسة دخول السوق",
    el: "π.χ. επιχειρηματική συμβουλευτική — μελέτη εισόδου στην αγορά",
  },
  "fin-service-desc": {
    en: "Description", sr: "Opis", tr: "Açıklama", de: "Beschreibung", ru: "Описание",
    fr: "Description", it: "Descrizione", es: "Descripción", pt: "Descrição", zh: "描述",
    ja: "説明", ar: "الوصف", el: "Περιγραφή",
  },
  "fin-service-desc-ph": {
    en: "Optional details shown under the service name", sr: "Opcioni detalji ispod naziva usluge",
    tr: "Hizmet adı altında gösterilen isteğe bağlı ayrıntılar",
    de: "Optionale Angaben unter dem Dienstleistungsnamen",
    ru: "Необязательные подробности под названием услуги",
    fr: "Détails facultatifs affichés sous le nom du service",
    it: "Dettagli opzionali mostrati sotto il nome del servizio",
    es: "Detalles opcionales mostrados bajo el nombre del servicio",
    pt: "Detalhes opcionais exibidos sob o nome do serviço",
    zh: "在服务名称下方显示的可选详情", ja: "サービス名の下に表示される任意の詳細",
    ar: "تفاصيل اختيارية تظهر تحت اسم الخدمة", el: "Προαιρετικές λεπτομέρειες κάτω από το όνομα της υπηρεσίας",
  },
  "fin-service-line-period": {
    en: "Period", sr: "Period", tr: "Dönem", de: "Zeitraum", ru: "Период", fr: "Période",
    it: "Periodo", es: "Periodo", pt: "Período", zh: "期间", ja: "期間", ar: "الفترة", el: "Περίοδος",
  },
  "fin-service-line-period-ph": {
    en: "optional", sr: "opciono", tr: "isteğe bağlı", de: "optional", ru: "необязательно",
    fr: "facultatif", it: "opzionale", es: "opcional", pt: "opcional", zh: "可选", ja: "任意",
    ar: "اختياري", el: "προαιρετικό",
  },
  "fin-rate": {
    en: "Rate", sr: "Tarifa", tr: "Oran", de: "Satz", ru: "Ставка", fr: "Tarif", it: "Tariffa",
    es: "Tarifa", pt: "Tarifa", zh: "费率", ja: "単価", ar: "التعرفة", el: "Τιμή μονάδας",
  },
  "fin-qty-time": {
    en: "Qty / Time", sr: "Kol. / Vreme", tr: "Miktar / Süre", de: "Menge / Zeit",
    ru: "Кол-во / Время", fr: "Qté / Temps", it: "Qtà / Tempo", es: "Cant. / Tiempo",
    pt: "Qtd. / Tempo", zh: "数量 / 时间", ja: "数量 / 時間", ar: "الكمية / الوقت", el: "Ποσ. / Χρόνος",
  },
  "fin-service-lines": {
    en: "Service Lines", sr: "Stavke usluga", tr: "Hizmet Kalemleri", de: "Dienstleistungspositionen",
    ru: "Позиции услуг", fr: "Lignes de service", it: "Righe di servizio", es: "Líneas de servicio",
    pt: "Linhas de serviço", zh: "服务明细", ja: "サービス明細", ar: "بنود الخدمة", el: "Γραμμές υπηρεσιών",
  },
  "fin-linked-offer-nature-hint": {
    en: "The linked offer sets the document type", sr: "Povezana ponuda postavlja vrstu dokumenta",
    tr: "Bağlı teklif belge türünü belirler", de: "Das verknüpfte Angebot legt den Dokumenttyp fest",
    ru: "Связанное предложение задаёт тип документа",
    fr: "L'offre liée détermine le type de document",
    it: "L'offerta collegata imposta il tipo di documento",
    es: "La oferta vinculada establece el tipo de documento",
    pt: "A oferta vinculada define o tipo de documento",
    zh: "关联报价决定单据类型", ja: "リンクされた見積書が書類タイプを設定します",
    ar: "العرض المرتبط يحدد نوع المستند", el: "Η συνδεδεμένη προσφορά ορίζει τον τύπο του εγγράφου",
  },
  "fin-service-doc-note": {
    en: "Service document", sr: "Dokument usluge", tr: "Hizmet belgesi", de: "Dienstleistungsdokument",
    ru: "Документ на услуги", fr: "Document de service", it: "Documento di servizi",
    es: "Documento de servicios", pt: "Documento de serviços", zh: "服务单据", ja: "サービス書類",
    ar: "مستند خدمات", el: "Έγγραφο υπηρεσιών",
  },
  "misc-unit-service": {
    en: "Service / Time", sr: "Usluge / Vreme", tr: "Hizmet / Süre", de: "Dienstleistung / Zeit",
    ru: "Услуги / Время", fr: "Service / Temps", it: "Servizio / Tempo", es: "Servicio / Tiempo",
    pt: "Serviço / Tempo", zh: "服务 / 时间", ja: "サービス / 時間", ar: "خدمة / وقت", el: "Υπηρεσία / Χρόνος",
  },
};

const FIN_KEYS = Object.keys(T).filter((k) => k.startsWith("fin-"));

function block(keys: string[], locale: string, indent: string): string {
  return keys
    .map((k) => `${indent}"${k}": ${JSON.stringify(T[k][locale])},`)
    .join("\n");
}

function esc(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

// ── 1. domains/finance.ts — en/sr/tr/de/ru inline sections ──────────────────
{
  const file = `${ROOT}/domains/finance.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-nature-goods"')) throw new Error("finance.ts already has nature keys");
  // Each inline locale section ends with the credit-hold-release-success line.
  // Insert the nature/service block after each, in file order = en,sr,tr,de,ru.
  const order = ["en", "sr", "tr", "de", "ru"];
  const anchorRe = /^(\s*)"credit-hold-release-success": ".*",$/gm;
  let i = 0;
  src = src.replace(anchorRe, (m, indent) => {
    const loc = order[i++];
    return `${m}\n\n    // ── Document nature — goods vs services (migration 103) ──\n${block(FIN_KEYS, loc, "    ")}`;
  });
  if (i !== 5) throw new Error(`finance.ts: expected 5 anchors, found ${i}`);
  writeFileSync(file, src);
  console.log(`finance.ts: inserted ${FIN_KEYS.length} keys x 5 locales`);
}

// ── 2. domains/misc.ts — en/sr/tr/de/ru inline sections ─────────────────────
{
  const file = `${ROOT}/domains/misc.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"misc-unit-service"')) throw new Error("misc.ts already has unit-service");
  const order = ["en", "sr", "tr", "de", "ru"];
  const anchorRe = /^(\s*)"misc-unit-other": ".*",$/gm;
  let i = 0;
  src = src.replace(anchorRe, (m) => {
    const loc = order[i++];
    return `${m}\n    "misc-unit-service": ${JSON.stringify(T["misc-unit-service"][loc])},`;
  });
  if (i !== 5) throw new Error(`misc.ts: expected 5 anchors, found ${i}`);
  writeFileSync(file, src);
  console.log("misc.ts: inserted misc-unit-service x 5 locales");
}

// ── 3. lang packs — FINANCE export + misc-unit-service ─────────────────────
for (const loc of ["fr", "it", "ar", "pt", "zh", "ja", "el", "es"]) {
  const file = `${ROOT}/lang/${loc}.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-nature-goods"')) throw new Error(`${loc}.ts already has nature keys`);

  // FINANCE export: insert before its closing "};"
  const finStart = src.indexOf("export const FINANCE: Record<string, string> = {");
  if (finStart < 0) throw new Error(`${loc}.ts: FINANCE export not found`);
  const finEnd = src.indexOf("};", finStart);
  if (finEnd < 0) throw new Error(`${loc}.ts: FINANCE closing not found`);
  const finBlock =
    `\n  // ── Document nature — goods vs services (migration 103) ──\n` +
    block(FIN_KEYS, loc, "  ") + `\n`;
  src = src.slice(0, finEnd) + finBlock + src.slice(finEnd);

  // misc-unit-service after misc-unit-other (lang packs are flat, 2-space indent)
  const miscAnchor = src.match(/^(\s*)"misc-unit-other": ".*",$/m);
  if (!miscAnchor) throw new Error(`${loc}.ts: misc-unit-other not found`);
  src = src.replace(
    /^(\s*)"misc-unit-other": ".*",$/m,
    (m) => `${m}\n  "misc-unit-service": "${esc(T["misc-unit-service"][loc])}",`,
  );

  writeFileSync(file, src);
  console.log(`${loc}.ts: inserted ${FIN_KEYS.length} fin keys + misc-unit-service`);
}

// ── Sanity: every locale covered for every key ──────────────────────────────
for (const key of Object.keys(T)) {
  for (const loc of LOCALES) {
    if (!T[key][loc]) throw new Error(`Missing translation: ${key}/${loc}`);
  }
}
console.log("OK — all keys x 13 locales verified");
