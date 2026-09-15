/**
 * One-shot i18n injector — "per-document display options" (migration 105).
 *
 * Adds:
 *   • 28 "fin-display-*" keys → FINANCE domain
 *     (en/sr/tr/de/ru inline in domains/finance.ts +
 *      fr/it/ar/pt/zh/ja/el/es in lang/*.ts FINANCE exports)
 *   • 15 "adm-bank-*" keys → ADMINISTRATION domain (same 13 locales)
 *     — the tenant bank-accounts editor (account holder = naziv korisnika
 *     računa, bank address, …)
 *
 * Idempotency: refuses to run twice (checks for fin-display-options).
 */
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "/home/z/velos-platform/src/lib/i18n";

type Loc = string;
const LOCALES = ["en", "sr", "tr", "de", "ru", "fr", "it", "ar", "pt", "zh", "ja", "el", "es"] as const;

// ── key → translation per locale ────────────────────────────────────────────
const FIN: Record<string, Record<Loc, string>> = {
  "fin-display-options": {
    en: "PDF display options", sr: "Opcije prikaza PDF-a", tr: "PDF görünüm seçenekleri",
    de: "PDF-Anzeigeoptionen", ru: "Настройки отображения PDF", fr: "Options d'affichage PDF",
    it: "Opzioni di visualizzazione PDF", es: "Opciones de visualización PDF",
    pt: "Opções de exibição do PDF", zh: "PDF显示选项", ja: "PDF表示オプション",
    ar: "خيارات عرض PDF", el: "Επιλογές εμφάνισης PDF",
  },
  "fin-display-options-hint": {
    en: "Choose what this document shows — saved with the document",
    sr: "Izaberite šta ovaj dokument prikazuje — čuva se uz dokument",
    tr: "Bu belgede ne görüneceğini seçin — belgeyle birlikte kaydedilir",
    de: "Wählen Sie, was dieses Dokument zeigt — wird mit dem Dokument gespeichert",
    ru: "Выберите, что показывает этот документ — сохраняется вместе с документом",
    fr: "Choisissez ce que ce document affiche — enregistré avec le document",
    it: "Scegli cosa mostra questo documento — salvato con il documento",
    es: "Elige qué muestra este documento — se guarda con el documento",
    pt: "Escolha o que este documento exibe — salvo com o documento",
    zh: "选择此单据显示的内容 — 随单据一起保存",
    ja: "この書類に表示する内容を選択 — 書類と一緒に保存されます",
    ar: "اختر ما يعرضه هذا المستند — يُحفظ مع المستند",
    el: "Επιλέξτε τι εμφανίζει αυτό το έγγραφο — αποθηκεύεται μαζί του",
  },
  "fin-display-title-label": {
    en: "Document title", sr: "Naslov dokumenta", tr: "Belge başlığı", de: "Dokumenttitel",
    ru: "Заголовок документа", fr: "Titre du document", it: "Titolo del documento",
    es: "Título del documento", pt: "Título do documento", zh: "单据标题", ja: "書類タイトル",
    ar: "عنوان المستند", el: "Τίτλος εγγράφου",
  },
  "fin-display-title-ph": {
    en: "Leave empty for the default title",
    sr: "Ostavite prazno za podrazumevani naslov",
    tr: "Varsayılan başlık için boş bırakın",
    de: "Für den Standardtitel leer lassen",
    ru: "Оставьте пустым для заголовка по умолчанию",
    fr: "Laisser vide pour le titre par défaut",
    it: "Lascia vuoto per il titolo predefinito",
    es: "Dejar vacío para el título predeterminado",
    pt: "Deixar vazio para o título padrão",
    zh: "留空使用默认标题", ja: "空欄でデフォルトのタイトルを使用",
    ar: "اتركه فارغًا للعنوان الافتراضي", el: "Αφήστε κενό για τον προεπιλεγμένο τίτλο",
  },
  "fin-display-vat-label": {
    en: "VAT display", sr: "Prikaz PDV-a", tr: "KDV görünümü", de: "USt.-Anzeige",
    ru: "Отображение НДС", fr: "Affichage de la TVA", it: "Visualizzazione IVA",
    es: "Visualización del IVA", pt: "Exibição do IVA", zh: "增值税显示", ja: "消費税表示",
    ar: "عرض ضريبة القيمة المضافة", el: "Εμφάνιση ΦΠΑ",
  },
  "fin-display-vat-auto": {
    en: "Auto — factual amount",
    sr: "Auto — stvarni iznos",
    tr: "Otomatik — gerçek tutar",
    de: "Automatisch — tatsächlicher Betrag",
    ru: "Авто — фактическая сумма",
    fr: "Auto — montant factuel",
    it: "Auto — importo effettivo",
    es: "Auto — importe real",
    pt: "Auto — valor real",
    zh: "自动 — 实际金额", ja: "自動 — 実際の金額",
    ar: "تلقائي — المبلغ الفعلي", el: "Αυτόματο — πραγματικό ποσό",
  },
  "fin-display-vat-amount": {
    en: "Show amount (even 0)", sr: "Prikaži iznos (i 0)", tr: "Tutarı göster (0 bile)",
    de: "Betrag anzeigen (auch 0)", ru: "Показывать сумму (даже 0)",
    fr: "Afficher le montant (même 0)", it: "Mostra importo (anche 0)",
    es: "Mostrar importe (incluso 0)", pt: "Exibir valor (mesmo 0)",
    zh: "显示金额（含0）", ja: "金額を表示（0も）", ar: "عرض المبلغ (حتى 0)", el: "Εμφάνιση ποσού (και 0)",
  },
  "fin-display-vat-reverse": {
    en: "Reverse charge note", sr: "Napomena o reverznom oporezivanju",
    tr: "Ters yük notu", de: "Verlagerungshinweis",
    ru: "Примечание о переносе налога", fr: "Mention d'autoliquidation",
    it: "Nota inversione", es: "Nota de inversión del sujeto pasivo",
    pt: "Nota de autoliquidação", zh: "反向征收说明", ja: "リバースチャージ注記",
    ar: "ملاحظة الاحتساب العكسي", el: "Σημείωση αντεστραμμένης επιβολής",
  },
  "fin-display-vat-custom": {
    en: "Custom note", sr: "Posebna napomena", tr: "Özel not", de: "Eigene Notiz",
    ru: "Своя заметка", fr: "Note personnalisée", it: "Nota personalizzata",
    es: "Nota personalizada", pt: "Nota personalizada", zh: "自定义备注", ja: "カスタム注記",
    ar: "ملاحظة مخصصة", el: "Προσαρμοσμένη σημείωση",
  },
  "fin-display-vat-hidden": {
    en: "Hide VAT row", sr: "Sakrij red PDV-a", tr: "KDV satırını gizle",
    de: "USt.-Zeile ausblenden", ru: "Скрыть строку НДС", fr: "Masquer la ligne TVA",
    it: "Nascondi riga IVA", es: "Ocultar fila de IVA", pt: "Ocultar linha do IVA",
    zh: "隐藏增值税行", ja: "消費税行を非表示", ar: "إخفاء سطر ضريبة القيمة المضافة",
    el: "Απόκρυψη γραμμής ΦΠΑ",
  },
  "fin-display-vat-note-label": {
    en: "Custom VAT note", sr: "Posebna PDV napomena", tr: "Özel KDV notu",
    de: "Eigene USt.-Notiz", ru: "Своя заметка по НДС", fr: "Note TVA personnalisée",
    it: "Nota IVA personalizzata", es: "Nota de IVA personalizada", pt: "Nota de IVA personalizada",
    zh: "自定义增值税备注", ja: "カスタム消費税注記", ar: "ملاحظة ضريبة مخصصة",
    el: "Προσαρμοσμένη σημείωση ΦΠΑ",
  },
  "fin-display-vat-note-ph": {
    en: "e.g. Zero-rated supply — no VAT charged",
    sr: "npr. Poresko oslobođenje — PDV se ne naplaćuje",
    tr: "örn. Sıfır oranlı teslim — KDV tahsil edilmez",
    de: "z. B. Nullsteuer — keine USt. berechnet",
    ru: "напр. Нулевая ставка — НДС не взимается",
    fr: "ex. Livraison à taux zéro — TVA non facturée",
    it: "es. Fornitura a zero aliquota — IVA non addebitata",
    es: "ej. Suministro a tipo cero — IVA no cobrado",
    pt: "ex. Fornecimento isento — IVA não cobrado",
    zh: "例如：零税率供应 — 不收取增值税",
    ja: "例：軽減対象外 — 消費税は請求されません",
    ar: "مثال: توريد بصفر النسبة — لا تُفرض ضريبة",
    el: "π.χ. Μηδενικός συντελεστής — δεν επιβάλλεται ΦΠΑ",
  },
  "fin-display-period-label": {
    en: "Service period", sr: "Period usluge", tr: "Hizmet dönemi", de: "Leistungszeitraum",
    ru: "Период услуги", fr: "Période de service", it: "Periodo di servizio",
    es: "Periodo de servicio", pt: "Período de serviço", zh: "服务期间", ja: "サービス期間",
    ar: "فترة الخدمة", el: "Περίοδος υπηρεσίας",
  },
  "fin-display-period-auto": {
    en: "Auto — show when dates exist",
    sr: "Auto — prikaži kada datumi postoje",
    tr: "Otomatik — tarih varsa göster",
    de: "Automatisch — anzeigen, wenn Daten vorhanden",
    ru: "Авто — показывать при наличии дат",
    fr: "Auto — afficher si des dates existent",
    it: "Auto — mostra se sono presenti date",
    es: "Auto — mostrar si hay fechas",
    pt: "Auto — exibir se houver datas",
    zh: "自动 — 有日期时显示", ja: "自動 — 日付があれば表示",
    ar: "تلقائي — يُعرض عند وجود تواريخ", el: "Αυτόματο — εμφάνιση όταν υπάρχουν ημερομηνίες",
  },
  "fin-display-period-show": {
    en: "Always show", sr: "Uvek prikaži", tr: "Her zaman göster", de: "Immer anzeigen",
    ru: "Всегда показывать", fr: "Toujours afficher", it: "Mostra sempre",
    es: "Mostrar siempre", pt: "Sempre exibir", zh: "始终显示", ja: "常に表示",
    ar: "عرض دائمًا", el: "Πάντα εμφάνιση",
  },
  "fin-display-period-hide": {
    en: "Hide", sr: "Sakrij", tr: "Gizle", de: "Ausblenden", ru: "Скрыть",
    fr: "Masquer", it: "Nascondi", es: "Ocultar", pt: "Ocultar", zh: "隐藏",
    ja: "非表示", ar: "إخفاء", el: "Απόκρυψη",
  },
  "fin-display-location-label": {
    en: "Place of service cell", sr: "Polje mesta usluge", tr: "Hizmet yeri hücresi",
    de: "Feld Leistungsort", ru: "Ячейка места услуги", fr: "Case lieu de prestation",
    it: "Cella luogo di servizio", es: "Celda del lugar del servicio",
    pt: "Célula do local do serviço", zh: "服务地点单元格", ja: "サービス提供場所セル",
    ar: "خلية مكان الخدمة", el: "Κελί τόπου παροχής",
  },
  "fin-display-payment-label": {
    en: "Payment terms cell", sr: "Polje uslova plaćanja", tr: "Ödeme koşulları hücresi",
    de: "Feld Zahlungsbedingungen", ru: "Ячейка условий оплаты", fr: "Case conditions de paiement",
    it: "Cella condizioni di pagamento", es: "Celda de condiciones de pago",
    pt: "Célula de condições de pagamento", zh: "付款条件单元格", ja: "支払条件セル",
    ar: "خلية شروط الدفع", el: "Κελί όρων πληρωμής",
  },
  "fin-display-qty-label": {
    en: "Quantity column", sr: "Kolona količine", tr: "Miktar sütunu",
    de: "Mengenspalte", ru: "Колонка количества", fr: "Colonne quantité",
    it: "Colonna quantità", es: "Columna de cantidad", pt: "Coluna de quantidade",
    zh: "数量列", ja: "数量列", ar: "عمود الكمية", el: "Στήλη ποσότητας",
  },
  "fin-display-notice-label": {
    en: "Legal notice", sr: "Pravna napomena", tr: "Yasal not", de: "Rechtlicher Hinweis",
    ru: "Правовое примечание", fr: "Mention légale", it: "Nota legale",
    es: "Aviso legal", pt: "Aviso legal", zh: "法律声明", ja: "法的注記",
    ar: "إشعار قانوني", el: "Νομική σημείωση",
  },
  "fin-display-notice-text-label": {
    en: "Custom notice text", sr: "Tekst posebne napomene", tr: "Özel not metni",
    de: "Eigener Hinweistext", ru: "Свой текст примечания", fr: "Texte de mention personnalisé",
    it: "Testo nota personalizzata", es: "Texto de aviso personalizado",
    pt: "Texto de aviso personalizado", zh: "自定义声明文本", ja: "カスタム注記テキスト",
    ar: "نص الإشعار المخصص", el: "Προσαρμοσμένο κείμενο σημείωσης",
  },
  "fin-display-notice-ph": {
    en: "Replaces the default legal notice",
    sr: "Zamenjuje podrazumevanu pravnu napomenu",
    tr: "Varsayılan yasal notun yerine geçer",
    de: "Ersetzt den Standardhinweis",
    ru: "Заменяет примечание по умолчанию",
    fr: "Remplace la mention légale par défaut",
    it: "Sostituisce la nota legale predefinita",
    es: "Reemplaza el aviso legal predeterminado",
    pt: "Substitui o aviso legal padrão",
    zh: "替换默认法律声明", ja: "デフォルトの法的注記を置き換えます",
    ar: "يستبدل الإشعار القانوني الافتراضي", el: "Αντικαθιστά την προεπιλεγμένη νομική σημείωση",
  },
  "fin-display-words-label": {
    en: "Amount in words", sr: "Iznos rečima", tr: "Yazıyla tutar", de: "Betrag in Worten",
    ru: "Сумма прописью", fr: "Montant en lettres", it: "Importo in lettere",
    es: "Importe en palabras", pt: "Valor por extenso", zh: "大写金额", ja: "金額の文字表記",
    ar: "المبلغ بالكلمات", el: "Ποσό με λέξεις",
  },
  "fin-display-bank-label": {
    en: "Bank details", sr: "Podaci banke", tr: "Banka bilgileri", de: "Bankdaten",
    ru: "Банковские реквизиты", fr: "Coordonnées bancaires", it: "Dati bancari",
    es: "Datos bancarios", pt: "Dados bancários", zh: "银行信息", ja: "銀行情報",
    ar: "بيانات البنك", el: "Τραπεζικά στοιχεία",
  },
  "fin-display-signatures-label": {
    en: "Signature block", sr: "Blok za potpise", tr: "İmza bloğu", de: "Unterschriftenblock",
    ru: "Блок подписей", fr: "Bloc de signatures", it: "Blocco firme",
    es: "Bloque de firmas", pt: "Bloco de assinaturas", zh: "签名栏", ja: "署名欄",
    ar: "قسم التوقيعات", el: "Τμήμα υπογραφών",
  },
  "fin-display-group-doc": {
    en: "Document", sr: "Dokument", tr: "Belge", de: "Dokument", ru: "Документ",
    fr: "Document", it: "Documento", es: "Documento", pt: "Documento", zh: "单据",
    ja: "書類", ar: "المستند", el: "Έγγραφο",
  },
  "fin-display-group-svc": {
    en: "Service fields", sr: "Polja usluge", tr: "Hizmet alanları", de: "Leistungsfelder",
    ru: "Поля услуги", fr: "Champs de service", it: "Campi servizio",
    es: "Campos de servicio", pt: "Campos de serviço", zh: "服务字段", ja: "サービス項目",
    ar: "حقول الخدمة", el: "Πεδία υπηρεσίας",
  },
  "fin-display-group-sec": {
    en: "Sections", sr: "Sekcije", tr: "Bölümler", de: "Abschnitte", ru: "Разделы",
    fr: "Sections", it: "Sezioni", es: "Secciones", pt: "Seções", zh: "板块",
    ja: "セクション", ar: "الأقسام", el: "Ενότητες",
  },
};

const ADM: Record<string, Record<Loc, string>> = {
  "adm-bank-accounts-title": {
    en: "Company bank accounts", sr: "Bankovni računi kompanije", tr: "Şirket banka hesapları",
    de: "Bankkonten des Unternehmens", ru: "Банковские счета компании",
    fr: "Comptes bancaires de la société", it: "Conti bancari aziendali",
    es: "Cuentas bancarias de la empresa", pt: "Contas bancárias da empresa",
    zh: "公司银行账户", ja: "会社の銀行口座", ar: "الحسابات البنكية للشركة", el: "Τραπεζικοί λογαριασμοί εταιρείας",
  },
  "adm-bank-accounts-desc": {
    en: "Payment details shown on offers, proformas and invoices — the account holder leads each block.",
    sr: "Podaci za plaćanje na ponudama, predračunima i fakturama — naziv korisnika računa vodi svaki blok.",
    tr: "Teklif, proforma ve faturalarda gösterilen ödeme bilgileri — her blokta hesap sahibi önce gelir.",
    de: "Zahlungsdaten auf Angeboten, Proforma-Rechnungen und Rechnungen — der Kontoinhaber steht jeweils voran.",
    ru: "Платёжные реквизиты в предложениях, профаймах и инвойсах — владелец счёта указывается первым.",
    fr: "Coordonnées de paiement sur les offres, proformas et factures — le titulaire du compte figure en tête.",
    it: "Dati di pagamento su offerte, proforma e fatture — l'intestatario del conto apre ogni blocco.",
    es: "Datos de pago en ofertas, proformas y facturas — el titular de la cuenta encabeza cada bloque.",
    pt: "Dados de pagamento em ofertas, proformas e faturas — o titular da conta lidera cada bloco.",
    zh: "显示在报价、形式发票和发票上的付款信息 — 每个区块以账户持有人开头。",
    ja: "見積書・プロフォーマ・請求書に表示される支払情報 — 各ブロックの先頭は口座名義人です。",
    ar: "بيانات الدفع المعروضة في العروض والفواتير المبدئية والفواتير — يتصدر كل قسم صاحب الحساب.",
    el: "Στοιχεία πληρωμής σε προσφορές, προφορμα και τιμολόγια — ο κάτοχος του λογαριασμού προηγείται σε κάθε μπλοκ.",
  },
  "adm-bank-add": {
    en: "Add account", sr: "Dodaj račun", tr: "Hesap ekle", de: "Konto hinzufügen",
    ru: "Добавить счёт", fr: "Ajouter un compte", it: "Aggiungi conto",
    es: "Añadir cuenta", pt: "Adicionar conta", zh: "添加账户", ja: "口座を追加",
    ar: "إضافة حساب", el: "Προσθήκη λογαριασμού",
  },
  "adm-bank-holder": {
    en: "Account holder", sr: "Korisnik računa", tr: "Hesap sahibi", de: "Kontoinhaber",
    ru: "Владелец счёта", fr: "Titulaire du compte", it: "Intestatario del conto",
    es: "Titular de la cuenta", pt: "Titular da conta", zh: "账户持有人", ja: "口座名義人",
    ar: "صاحب الحساب", el: "Κάτοχος λογαριασμού",
  },
  "adm-bank-holder-ph": {
    en: "e.g. ASPIDUS DMCC (defaults to the company name)",
    sr: "npr. ASPIDUS DMCC (podrazumevano naziv kompanije)",
    tr: "örn. ASPIDUS DMCC (varsayılan şirket adı)",
    de: "z. B. ASPIDUS DMCC (standardmäßig der Firmenname)",
    ru: "напр. ASPIDUS DMCC (по умолчанию — название компании)",
    fr: "ex. ASPIDUS DMCC (par défaut le nom de la société)",
    it: "es. ASPIDUS DMCC (predefinito il nome della società)",
    es: "ej. ASPIDUS DMCC (por defecto el nombre de la empresa)",
    pt: "ex. ASPIDUS DMCC (padrão: nome da empresa)",
    zh: "例如 ASPIDUS DMCC（默认为公司名称）",
    ja: "例：ASPIDUS DMCC（デフォルトは会社名）",
    ar: "مثال ASPIDUS DMCC (افتراضيًا اسم الشركة)",
    el: "π.χ. ASPIDUS DMCC (προεπιλογή η επωνυμία της εταιρείας)",
  },
  "adm-bank-name-label": {
    en: "Bank name", sr: "Naziv banke", tr: "Banka adı", de: "Bankname",
    ru: "Название банка", fr: "Nom de la banque", it: "Nome della banca",
    es: "Nombre del banco", pt: "Nome do banco", zh: "银行名称", ja: "銀行名",
    ar: "اسم البنك", el: "Όνομα τράπεζας",
  },
  "adm-bank-number": {
    en: "Account number / IBAN", sr: "Broj računa / IBAN", tr: "Hesap numarası / IBAN",
    de: "Kontonummer / IBAN", ru: "Номер счёта / IBAN", fr: "Numéro de compte / IBAN",
    it: "Numero di conto / IBAN", es: "Número de cuenta / IBAN", pt: "Número da conta / IBAN",
    zh: "账号 / IBAN", ja: "口座番号 / IBAN", ar: "رقم الحساب / IBAN", el: "Αριθμός λογαριασμού / IBAN",
  },
  "adm-bank-swift": {
    en: "SWIFT / BIC", sr: "SWIFT / BIC", tr: "SWIFT / BIC", de: "SWIFT / BIC",
    ru: "SWIFT / BIC", fr: "SWIFT / BIC", it: "SWIFT / BIC", es: "SWIFT / BIC",
    pt: "SWIFT / BIC", zh: "SWIFT / BIC", ja: "SWIFT / BIC", ar: "SWIFT / BIC", el: "SWIFT / BIC",
  },
  "adm-bank-currency": {
    en: "Currency", sr: "Valuta", tr: "Para birimi", de: "Währung", ru: "Валюта",
    fr: "Devise", it: "Valuta", es: "Moneda", pt: "Moeda", zh: "币种", ja: "通貨",
    ar: "العملة", el: "Νόμισμα",
  },
  "adm-bank-address": {
    en: "Bank address (optional)", sr: "Adresa banke (opciono)", tr: "Banka adresi (isteğe bağlı)",
    de: "Bankadresse (optional)", ru: "Адрес банка (опционально)", fr: "Adresse de la banque (facultatif)",
    it: "Indirizzo della banca (facoltativo)", es: "Dirección del banco (opcional)",
    pt: "Endereço do banco (opcional)", zh: "银行地址（可选）", ja: "銀行住所（任意）",
    ar: "عنوان البنك (اختياري)", el: "Διεύθυνση τράπεζας (προαιρετικό)",
  },
  "adm-bank-address-ph": {
    en: "Branch address shown on the document",
    sr: "Adresa filijale prikazana na dokumentu",
    tr: "Belgede gösterilen şube adresi",
    de: "Filialadresse, die auf dem Dokument erscheint",
    ru: "Адрес отделения, отображаемый в документе",
    fr: "Adresse de l'agence affichée sur le document",
    it: "Indirizzo della filiale mostrato sul documento",
    es: "Dirección de la sucursal mostrada en el documento",
    pt: "Endereço da agência exibido no documento",
    zh: "显示在单据上的分行地址", ja: "書類に表示される支店住所",
    ar: "عنوان الفرع المعروض على المستند", el: "Διεύθυνση υποκαταστήματος που εμφανίζεται στο έγγραφο",
  },
  "adm-bank-remove": {
    en: "Remove", sr: "Ukloni", tr: "Kaldır", de: "Entfernen", ru: "Удалить",
    fr: "Supprimer", it: "Rimuovi", es: "Quitar", pt: "Remover", zh: "移除", ja: "削除",
    ar: "إزالة", el: "Αφαίρεση",
  },
  "adm-bank-saved": {
    en: "Bank accounts saved", sr: "Bankovni računi sačuvani", tr: "Banka hesapları kaydedildi",
    de: "Bankkonten gespeichert", ru: "Банковские счета сохранены",
    fr: "Comptes bancaires enregistrés", it: "Conti bancari salvati",
    es: "Cuentas bancarias guardadas", pt: "Contas bancários salvos",
    zh: "银行账户已保存", ja: "銀行口座を保存しました", ar: "تم حفظ الحسابات البنكية",
    el: "Οι τραπεζικοί λογαριασμοί αποθηκεύτηκαν",
  },
  "adm-bank-save-failed": {
    en: "Could not save bank accounts", sr: "Greška pri čuvanju bankovnih računa",
    tr: "Banka hesapları kaydedilemedi", de: "Bankkonten konnten nicht gespeichert werden",
    ru: "Не удалось сохранить банковские счета", fr: "Impossible d'enregistrer les comptes bancaires",
    it: "Impossibile salvare i conti bancari", es: "No se pudieron guardar las cuentas bancarias",
    pt: "Não foi possível salvar as contas bancárias", zh: "无法保存银行账户",
    ja: "銀行口座を保存できませんでした", ar: "تعذّر حفظ الحسابات البنكية",
    el: "Αποτυχία αποθήκευσης τραπεζικών λογαριασμών",
  },
  "adm-bank-empty": {
    en: "No bank accounts yet — add the accounts clients can pay into.",
    sr: "Još nema bankovnih računa — dodajte račune na koje klijenti mogu plaćati.",
    tr: "Henüz banka hesabı yok — müşterilerin ödeme yapabileceği hesapları ekleyin.",
    de: "Noch keine Bankkonten — fügen Sie die Konten hinzu, auf die Kunden zahlen können.",
    ru: "Банковских счетов пока нет — добавьте счета, на которые клиенты смогут платить.",
    fr: "Aucun compte bancaire — ajoutez les comptes sur lesquels les clients peuvent payer.",
    it: "Nessun conto bancario — aggiungi i conti su cui i clienti possono pagare.",
    es: "Aún no hay cuentas bancarias — añade las cuentas a las que los clientes pueden pagar.",
    pt: "Ainda não há contas bancárias — adicione as contas para onde os clientes podem pagar.",
    zh: "暂无银行账户 — 添加客户可付款的账户。",
    ja: "銀行口座がまだありません — 顧客が支払える口座を追加してください。",
    ar: "لا توجد حسابات بنكية بعد — أضف الحسابات التي يمكن للعملاء الدفع إليها.",
    el: "Δεν υπάρχουν τραπεζικοί λογαριασμοί — προσθέστε τους λογαριασμούς στους οποίους μπορούν να πληρώσουν οι πελάτες.",
  },
};

const FIN_KEYS = Object.keys(FIN);
const ADM_KEYS = Object.keys(ADM);

function block(keys: string[], dict: Record<string, Record<Loc, string>>, locale: string, indent: string): string {
  return keys.map((k) => `${indent}"${k}": ${JSON.stringify(dict[k][locale])},`).join("\n");
}

// ── 1. domains/finance.ts — en/sr/tr/de/ru inline sections ──────────────────
{
  const file = `${ROOT}/domains/finance.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-display-options"')) throw new Error("finance.ts already has display keys");
  const order = ["en", "sr", "tr", "de", "ru"];
  const anchorRe = /^(\s*)"fin-service-doc-note": ".*",$/gm;
  let i = 0;
  src = src.replace(anchorRe, (m) => {
    const loc = order[i++];
    return `${m}\n\n    // ── Per-document display options (migration 105) ──\n${block(FIN_KEYS, FIN, loc, "    ")}`;
  });
  if (i !== 5) throw new Error(`finance.ts: expected 5 anchors, found ${i}`);
  writeFileSync(file, src);
  console.log(`finance.ts: inserted ${FIN_KEYS.length} keys x 5 locales`);
}

// ── 2. domains/administration.ts — en/sr/tr/de/ru inline sections ───────────
{
  const file = `${ROOT}/domains/administration.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"adm-bank-accounts-title"')) throw new Error("administration.ts already has bank keys");
  const order = ["en", "sr", "tr", "de", "ru"];
  const anchorRe = /^(\s*)"admin-settings-company-logo": ".*",$/gm;
  let i = 0;
  src = src.replace(anchorRe, (m) => {
    const loc = order[i++];
    return `${m}\n\n    // ── Company bank accounts editor (migration 105) ──\n${block(ADM_KEYS, ADM, loc, "    ")}`;
  });
  if (i !== 5) throw new Error(`administration.ts: expected 5 anchors, found ${i}`);
  writeFileSync(file, src);
  console.log(`administration.ts: inserted ${ADM_KEYS.length} keys x 5 locales`);
}

// ── 3. lang packs — FINANCE + ADMINISTRATION exports ────────────────────────
for (const loc of ["fr", "it", "ar", "pt", "zh", "ja", "el", "es"]) {
  const file = `${ROOT}/lang/${loc}.ts`;
  let src = readFileSync(file, "utf8");
  if (src.includes('"fin-display-options"')) throw new Error(`${loc}.ts already has display keys`);

  const insertInto = (exportName: string, keys: string[], dict: Record<string, Record<Loc, string>>, comment: string) => {
    const start = src.indexOf(`export const ${exportName}: Record<string, string> = {`);
    if (start < 0) throw new Error(`${loc}.ts: ${exportName} export not found`);
    const end = src.indexOf("};", start);
    if (end < 0) throw new Error(`${loc}.ts: ${exportName} closing not found`);
    const blk = `\n  // ${comment}\n` + block(keys, dict, loc, "  ") + `\n`;
    src = src.slice(0, end) + blk + src.slice(end);
  };

  insertInto("FINANCE", FIN_KEYS, FIN, "── Per-document display options (migration 105) ──");
  insertInto("ADMINISTRATION", ADM_KEYS, ADM, "── Company bank accounts editor (migration 105) ──");
  writeFileSync(file, src);
  console.log(`${loc}.ts: inserted ${FIN_KEYS.length} fin + ${ADM_KEYS.length} adm keys`);
}

// ── Sanity: every locale covered for every key ──────────────────────────────
for (const dict of [FIN, ADM]) {
  for (const key of Object.keys(dict)) {
    for (const loc of LOCALES) {
      if (!dict[key][loc]) throw new Error(`Missing translation: ${key}/${loc}`);
    }
  }
}
console.log("OK — all keys x 13 locales verified");
