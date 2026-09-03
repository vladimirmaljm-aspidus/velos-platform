import React from "react";
import { Document, Page, Text, View, StyleSheet, Image, Font } from "@react-pdf/renderer";
import type { Offer, Invoice, Proforma, LetterOfIntent, OfferLineItem, Partner, Tenant, MemorandumSettings, TenantSeal, DocumentTemplate, TenantLetterhead } from "@/lib/supabase/types";
import { substitutePlaceholders, hasPagePlaceholders, normalizeSegment, type ContentSegment, type PlaceholderData } from "@/lib/utils/content-config";
import { parseStyleConfig, type TemplateStyleConfig } from "@/lib/utils/style-config";
import { templateSegments, readTemplateQrConfig, readTemplateLayout, type TemplateFieldLayout } from "@/lib/pdf/doc-template";

// ── Shared helpers (audit12 dedup) ─────────────────────────────────────────
// mmToPoints, mapFont, boldVariant, lightenHex, fmtMoney, amountInWords,
// countryName, the ISO date formatter, the Watermark component and the
// watermark-status resolver now live in src/lib/pdf/shared.ts — the single
// source of truth shared with packing-list.ts and marketplace/document-pdf.ts
// so all three PDF template families are uniform by construction.
import {
  fmtQty,
  mmToPoints,
  mapFont,
  boldVariant,
  lightenHex,
  fmtMoney,
  amountInWords,
  countryName,
  remainingAddressParts,
  fmtDateIso as fmtDate,
  normalizeLineItems,
  Watermark,
  tradeWatermarkText,
} from "@/lib/pdf/shared";

// Allow very long "words" (SKUs, HS codes like 1006.30.10.00, IBANs) to break
// across lines. Short words are kept intact so normal prose still looks clean.
Font.registerHyphenationCallback((word) => {
  if (word.length > 18) {
    const parts = word.match(/.{1,18}/g);
    return parts && parts.length > 1 ? parts : [word];
  }
  return [word];
});

interface PdfDocData {
  doc: Offer | Invoice | Proforma | LetterOfIntent;
  docType: "offer" | "invoice" | "proforma" | "loi";
  partner: Partner | null;
  tenant: Tenant | null;
  /** Per-tenant header/footer/body configuration (memorandum_settings).
   *  audit20: now the FALLBACK layer — when a DocumentTemplate row exists
   *  for this docType its values take precedence per field; fields the
   *  template lacks (header fonts, logo geometry, footer column widths,
   *  body text colour) still come from here. Null → built-in defaults. */
  memorandumSettings: MemorandumSettings | null;
  /** audit20 / 20-a: the DocumentTemplate row resolved for (tenant, docType)
   *  — what the Document Templates editor saves. Null = no template row →
   *  render exactly as before (memorandum fallback). */
  template?: DocumentTemplate | null;
  /** The letterhead linked to the template (template.letterhead_id). Its
   *  logo wins over tenant.logo_url and its curated company fields feed
   *  {placeholder} substitution. Null when unlinked/unresolvable. */
  letterhead?: TenantLetterhead | null;
  /** Substitution values for {token} placeholders in template segments
   *  (built by the generator via buildPlaceholderData). When absent the
   *  renderer builds a minimal set from tenant/partner/doc inline. */
  placeholderData?: PlaceholderData | null;
  verificationCode?: string;
  qrCodeDataUrl?: string;
  logoUrl?: string | null;
  /** Resolved seal image URL (data: URL or fetched+re-encoded). Null when no
   *  seal is configured or the seal image couldn't be loaded — the renderer
   *  must skip the seal element entirely in that case. */
  sealImageUrl?: string | null;
  /** Optional TenantSeal row (used for placement / opacity / rotation).
   *  Null when the tenant has no seal configured. */
  seal?: TenantSeal | null;
  /** Optional metadata for PDF properties (Author, Title, Subject, etc.) */
  pdfMeta?: {
    author?: string;
    title?: string;
    subject?: string;
    creator?: string;
    keywords?: string;
  };
}

// mmToPoints / mapFont / boldVariant / lightenHex / fmtMoney / amountInWords
// moved to @/lib/pdf/shared.ts (audit12 dedup).

export function buildPdfDocument({
  doc,
  docType,
  partner,
  tenant,
  memorandumSettings,
  template,
  letterhead,
  placeholderData,
  verificationCode,
  qrCodeDataUrl,
  logoUrl,
  sealImageUrl,
  seal,
  pdfMeta,
}: PdfDocData) {
  // ── Memorandum settings (with built-in defaults) ───────────────────
  // Every field has a sensible fallback so the PDF still renders when the
  // tenant has no memorandum_settings row (mock/dev mode, fresh tenant,
  // migration pending, etc.). Fields NOT in the migration (page_size,
  // page margins, accent_color, table styling, selected_bank_accounts,
  // seal_enabled/seal_id) use built-in defaults — they're intentionally
  // out of memorandum_settings' scope so the schema stays simple.
  // ── Settings resolution (audit20): template → memorandum → default ──
  //
  // Before audit20 this function read memorandum_settings ONLY — the
  // DocumentTemplate the user edited in the Document Templates view was
  // never consulted, so every saved field (page size, margins, header/footer
  // segments, table styling, QR placement, bank selection) was dead config.
  // Now the template wins per field; memorandum_settings remains the
  // fallback for template-less tenants; built-ins are the last resort so
  // the renderer always produces a professional document.
  const m = memorandumSettings;
  const tpl = template ?? null;
  const primaryColor = tpl?.primary_color || m?.primary_color || "#0d9488";
  const accentColor = tpl?.accent_color || "#666666";
  const bodyTextColor = m?.body_text_color || "#1a1a1a";

  // ── audit22/27: visual layout (layout_json) — parsed FIRST so every ──
  // later block (logo gate, body section order) can consult it.
  // Body-section visibility + custom absolute-position text/image
  // overlays + the body section ORDER (y = sort key). Null → built-in
  // layout (all sections visible, canonical order, no custom overlays
  // — previous behaviour).
  const layout = readTemplateLayout(tpl?.layout_json);
  const layoutFields = layout?.fields ?? [];
  const layoutHidden = (type: string): boolean => {
    if (layoutFields.length === 0) return false;
    const f = layoutFields.find((x) => x.type === type);
    return f ? !f.visible : false;
  };
  const customOverlays = layoutFields.filter(
    (f) => f.visible && (f.type === "custom_text" || f.type === "custom_image"),
  );

  // ── audit27: body section ORDER (layout_json y = sort key) ─────────
  // The Template Studio's Layout tab is a REAL editor now: dragging a
  // section up/down reorders it in the generated PDF. Each field's y
  // coordinate acts as the sort key; sections missing from layout_json
  // keep the canonical order for the doc type (index × 10). The y values
  // are relative keys, not absolute page positions — the body still
  // flows top→bottom so multi-page tables paginate correctly.
  // LOI's canonical order differs from offers/invoices: the letter intro
  // (offer_text) sits directly after the parties, BEFORE the specs and
  // delivery terms — matching the pre-audit27 LOI layout exactly.
  const canonicalOrder = docType === "loi"
    ? ["doc_title", "from_box", "to_box", "offer_text", "specifications", "trade_terms", "signatures"]
    : ["doc_title", "from_box", "to_box", "trade_terms", "line_items_table",
       "specifications", "totals", "amount_in_words", "offer_text",
       "bank_details", "signatures"];
  const layoutYOf = (type: string): number => {
    const f = layoutFields.find((x) => x.type === type);
    if (f) return f.y;
    const idx = canonicalOrder.indexOf(type);
    return idx >= 0 ? idx * 10 : 9999;
  };
  // The FROM/TO boxes render as ONE parties row — they share a sort key
  // (the smaller y wins so dragging either box reorders the row).
  const partiesSortY = Math.min(layoutYOf("from_box"), layoutYOf("to_box"));

  // ── Typography ──────────────────────────────────────────────────────
  const fontFamily = mapFont(tpl?.body_font_family ?? m?.body_font_family, "NotoSans");
  const headingFontFamily = boldVariant(fontFamily);
  // Header company-name font (header_left_*). Defaults to the body font.
  const headerFontBase = mapFont(m?.header_left_font_family, fontFamily);
  const companyNameFontFamily = m?.header_left_font_bold === false
    ? headerFontBase
    : boldVariant(headerFontBase);
  const companyNameColor = m?.header_left_font_color || primaryColor;
  const companyNameSize = m?.header_left_font_size ?? 14;

  // Footer column fonts (footer_right_* — the page-number column).
  // audit14: footer_center_* fonts no longer drive any rendered text —
  // the center column is an empty spacer now (the address/contact it used
  // to carry duplicated the party boxes on every page).
  const footerRightFontFamily = mapFont(m?.footer_right_font_family, fontFamily);
  const footerRightFontSize = m?.footer_right_font_size ?? 8;
  const footerRightFontColor = m?.footer_right_font_color || "#666666";

  const fontSize = tpl?.body_font_size ?? m?.body_font_size ?? 9;
  const lineHeight = tpl?.body_line_height ?? m?.body_line_height ?? 1.4;

  // ── Page size (audit20: template-driven; A4 default) ────────────────
  const pageSize = tpl?.page_size === "Letter" ? "LETTER" : "A4";

  // ── Page margins (mm → points) — template wins, memo-era defaults ────
  const marginTop = mmToPoints(tpl?.page_margin_top ?? 20);
  const marginBottom = mmToPoints(tpl?.page_margin_bottom ?? 20);
  const marginLeft = mmToPoints(tpl?.page_margin_left ?? 15);
  const marginRight = mmToPoints(tpl?.page_margin_right ?? 15);

  // ── Header (repeats on every page) ──────────────────────────────────
  // Template mode: header_enabled + header_height + header_content segments
  // (styled lines with {placeholders}) + show flags. Segments replace the
  // auto company-name header when present; otherwise the auto header
  // renders (company name gated by header_show_company_name, contact line
  // by header_show_contact). Memorandum fallback keeps its own header_*.
  const headerEnabled = tpl
    ? tpl.header_enabled !== false
    : m?.header_enabled !== false;
  const headerSegments = tpl ? templateSegments(tpl.header_content) : [];
  const hasHeaderSegments = headerSegments.length > 0;
  const headerHeightPts = headerEnabled ? mmToPoints(tpl?.header_height ?? m?.header_height_mm ?? 22) : 0;
  // audit13: apply the header_bg_color setting the UI saves (white default).
  const headerBgColor = m?.header_bg_color || "#ffffff";

  // ── Logo (header right column) ──────────────────────────────────────
  // Logo is NEVER distorted — objectFit: "contain" preserves aspect ratio.
  // Dimensions come from settings (mm → pts); position offsets are also mm.
  // audit20: the template's header_show_logo gates the logo (memo mode
  // keeps its logo_enabled).
  const logoEnabled = tpl
    ? tpl.header_show_logo !== false
    : m?.logo_enabled !== false;
  const logoWidthPts = mmToPoints(m?.logo_max_width_mm ?? 30);
  const logoHeightPts = mmToPoints(m?.logo_max_height_mm ?? 20);
  const logoOffsetXPts = mmToPoints(m?.logo_position_x_mm ?? 0);
  const logoOffsetYPts = mmToPoints(m?.logo_position_y_mm ?? 0);
  // audit27: layout_json "logo" eye-toggle gates the rendered logo.
  const showLogo = logoEnabled && !!logoUrl && !layoutHidden("logo");

  // ── Footer (repeats on every page) ──────────────────────────────────
  // audit20 redesign — three-zone footer driven by the template:
  //   [LEFT zone]   QR (qr_position=footer-left) + left-aligned segments
  //   [CENTER zone] QR (footer-center) + centered segments + bank/tax lines
  //   [RIGHT zone]  right-aligned segments + QR (footer-right) + page number
  // Segments come from template.footer_content with their own
  // fontSize/bold/italic/colour/alignment; {page_number}/{total_pages}
  // resolve per page via the Text render prop. The bank-details and tax-id
  // flags append compact centred lines (the classic trade-document footer).
  // Without a template the layout degrades to the audit14 memo footer:
  // QR left + "Page X of Y" right — pixel-identical to the previous output.
  const footerEnabled = tpl
    ? tpl.footer_enabled !== false
    : m?.footer_enabled !== false;
  const footerSegments = tpl ? templateSegments(tpl.footer_content) : [];
  const qrCfg = tpl ? readTemplateQrConfig(tpl.footer_content) : null;
  const qrPosition = qrCfg?.position ?? "footer-left";
  const qrOpacity = qrCfg?.opacity ?? 1;
  const footerHeightPts = footerEnabled ? mmToPoints(tpl?.footer_height ?? m?.footer_height_mm ?? 18) : 0;
  // audit13: apply the footer_bg_color setting the UI saves.
  const footerBgColor = m?.footer_bg_color || "#ffffff";
  // audit13: apply the QR position offsets (mm) the memo UI saves.
  const qrOffsetXPts = mmToPoints(m?.qr_position_x_mm ?? 0);
  const qrOffsetYPts = mmToPoints(m?.qr_position_y_mm ?? 0);

  // Page number flag: template-driven when a template exists (memo mode
  // always showed it — keep that behaviour).
  const showPageNumber = tpl ? tpl.footer_show_page_number !== false : true;

  // ── QR code (placement zone) ────────────────────────────────────────
  // Template mode: qr_position/size/opacity from footer_content._qrConfig
  // (footer-right default — matches the template editor's default).
  // Memo mode: footer-left with the memo QR size (previous behaviour).
  const qrEnabled = tpl
    ? qrPosition !== "none"
    : m?.qr_enabled !== false;
  const qrSizePts = mmToPoints(qrCfg?.size ?? m?.qr_size_mm ?? 15);
  const showQr = qrEnabled && !!qrCodeDataUrl;

  // ── Table styling (audit20: template-driven) ────────────────────────
  const tableHeaderBg = tpl?.table_header_bg || primaryColor;
  const tableHeaderColor = tpl?.table_header_color || "#ffffff";
  const tableBorderColor = tpl?.table_border_color || "#e5e7eb";
  const tableStripe = tpl ? tpl.table_stripe !== false : true;
  // Stripe row background: a very light tint of the header color so it
  // matches the document's branding instead of being a flat grey.
  const stripeBg = lightenHex(tableHeaderBg, 0.92);

  // ── audit22: Template Studio style_json — EXTENDED styling layer ────
  // Font sizes, cell padding, column widths, header treatment, party
  // boxes, totals block, doc title, notice box, body colours. Scalar
  // template columns above stay primary for the fields they cover; the
  // style config fills everything else. parseStyleConfig degrades to
  // built-in defaults when the column is NULL — pre-audit22 templates keep
  // their exact current output.
  const st: TemplateStyleConfig = parseStyleConfig(tpl?.style_json);
  const stTableHeaderBg = tpl?.table_header_bg || st.table.headerBg;
  const stTableHeaderColor = tpl?.table_header_color || st.table.headerColor;
  const stTableBorderColor = tpl?.table_border_color || st.table.borderColor;
  const stStripe = tpl ? (tpl.table_stripe !== false && st.table.stripe !== false) : st.table.stripe;
  const stStripeBg = tpl?.style_json ? st.table.stripeColor : stripeBg;

  // ── audit22: line-items column widths (percent → flex) ──────────────
  const cw = st.table.columnWidths;
  const colFlex = (key: string, fallback: number): number => {
    const pct = cw[key];
    return typeof pct === "number" && pct > 0 ? pct / 100 : fallback;
  };
  const flexRowNum = colFlex("rowNum", 0.3);
  const flexDescription = colFlex("description", 3);
  const flexHsCode = colFlex("hsCode", 1.1);
  const flexOrigin = colFlex("origin", 0.9);
  const flexQuantity = colFlex("quantity", 1.1);
  const flexUnitPrice = colFlex("unitPrice", 1);
  const flexTotal = colFlex("total", 1.1);
  const numericAlign = st.table.numericAlign;

  // ── audit23: custom watermark (style_json.watermark) ────────────────
  // When enabled, the tenant's own watermark text (e.g. CONFIDENTIAL)
  // replaces the automatic status watermark on every page — a sent offer
  // can carry "CONFIDENTIAL" while a DRAFT keeps the automatic DRAFT stamp
  // only when no custom watermark is set.
  const wm = st.watermark;
  const customWatermarkText = wm.enabled && wm.text.trim() ? wm.text.trim() : "";
  const statusWatermarkText = tradeWatermarkText(
    (doc as any).status,
    (doc as any).document_data?.priceUnconfirmed === true,
  );
  // Rotation origin: centre of the content-width strip the text sits in.
  const pageWidthPts = pageSize === "A4" ? 595.28 : 612;
  const watermarkOriginX = (pageWidthPts - marginLeft - marginRight) / 2;

  // ── Derived layout — content area must clear the absolutely ─────────
  //    positioned header/footer.
  const headerGap = 6;  // breathing room between header bottom and body
  const footerGap = 6;  // breathing room between body and footer top
  const paddingTop = headerEnabled
    ? Math.max(marginTop, headerHeightPts + headerGap)
    : marginTop;
  const paddingBottom = footerEnabled
    ? Math.max(marginBottom, footerHeightPts + footerGap)
    : marginBottom;

  const styles = StyleSheet.create({
    page: {
      fontSize,
      // audit12 CRITICAL FIX: lineHeight removed from the PAGE style. Any
      // lineHeight in a render-prop Text's ancestry chain silently breaks
      // @react-pdf/renderer's `render` prop — the render function runs but
      // its output never reaches the PDF. This is why "Page X of Y" NEVER
      // rendered on offers/invoices/proformas/LOIs (the footer's render-prop
      // Text inherited the page's lineHeight). The body line height now
      // lives on the bodyBlock wrapper below (header/footer don't need it —
      // their Texts are single-line and carry their own styles).
      paddingTop,
      paddingBottom,
      paddingLeft: marginLeft,
      paddingRight: marginRight,
      fontFamily,
      color: bodyTextColor,
    },

    // Body wrapper carries the configured line height for all body text
    // (moved off the page style — see the audit12 note above).
    bodyBlock: {
      lineHeight,
    },

    // ── HEADER (memorandum — repeats on every page) ────────────────────
    // [Company Name]                [LOGO]
    // Bottom border in primary_color separates the memorandum from the body.
    header: {
      position: "absolute",
      top: 0,
      left: marginLeft,
      right: marginRight,
      height: headerHeightPts,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 4,
      paddingBottom: 8,
      borderBottomWidth: 2,
      borderBottomColor: primaryColor,
      // audit13: header_bg_color setting (white default → no visual change
      // for existing tenants, but configured values now actually apply).
      backgroundColor: headerBgColor,
    },
    headerLeft: {
      flex: 1,
      flexDirection: "column",
      justifyContent: "center",
      paddingRight: 12,
    },
    companyName: {
      fontSize: companyNameSize,
      fontFamily: companyNameFontFamily,
      color: companyNameColor,
      marginBottom: 2,
    },
    // Right column wraps the logo. Width is fixed to the configured logo
    // width so the logo sits at the right edge of the header without
    // pushing the company name off to the left.
    headerLogoWrap: {
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "flex-end",
      width: logoWidthPts,
      // Offset the logo within the header (position_x_mm / position_y_mm).
      // translate is supported by react-pdf via the `transform` style.
      marginLeft: logoOffsetXPts,
      marginTop: logoOffsetYPts,
    },
    // objectFit: "contain" is THE key — it preserves aspect ratio and
    // never distorts the logo even when width/height don't match the
    // image's intrinsic dimensions.
    headerLogo: {
      width: logoWidthPts,
      height: logoHeightPts,
      objectFit: "contain",
    },

    // ── FOOTER (memorandum — pinned to the bottom, repeats on every page)
    // audit14: absolute bottom:0 anchoring — the footer used to flow after
    // the body content (mid-page whenever the last content block ended
    // above the bottom, e.g. every "page 2+"). Mirrors the header's
    // absolute top:0 and the packing-list/marketplace footerFixed pattern.
    // Content: [QR] …spacer… [Page X of Y] — nothing that duplicates the
    // party boxes (address/contact) or the title meta block (number/date).
    footer: {
      position: "absolute",
      bottom: 0,
      left: marginLeft,
      right: marginRight,
      height: footerHeightPts,
      paddingTop: 6,
      borderTopWidth: 1,
      borderTopColor: accentColor,
      flexDirection: "row",
      alignItems: "flex-start",
      // audit13: footer_bg_color setting.
      backgroundColor: footerBgColor,
    },
    // audit20: three-zone footer. LEFT/CENTER zones are flexible content
    // columns (segments stack, QR anchors per its configured zone); the
    // RIGHT zone stacks right-aligned content + QR (footer-right) + the
    // page number. Zone widths: fixed anchors left/right (~30%), flexible
    // center — no percentage math, no ×100 flexBasis drift (the old code
    // emitted "2500%" for a configured 25 — react-pdf happened to render
    // it correctly, but the code contradicted its own comment; the new
    // zones use plain flexGrow/flexBasis in POINTS-free relative terms).
    footerZoneLeft: {
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "flex-start",
      alignSelf: "stretch",
      flexBasis: "30%",
      flexGrow: 0,
      flexShrink: 1,
    },
    footerZoneCenter: {
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      alignSelf: "stretch",
      flexBasis: "30%",
      flexGrow: 1,
      flexShrink: 1,
    },
    footerZoneRight: {
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "flex-end",
      alignSelf: "stretch",
      flexBasis: "30%",
      flexGrow: 0,
      flexShrink: 1,
    },
    // Right zone can host QR + page number side by side (footer-right):
    // a row keeps them on one line so a 15mm QR + label + page text fits
    // a 20mm footer.
    footerZoneRightRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    footerQrWrap: {
      flexDirection: "column",
      alignItems: "center",
      gap: 2,
      // audit13: qr_position_x_mm / qr_position_y_mm settings.
      marginLeft: qrOffsetXPts,
      marginTop: qrOffsetYPts,
    },
    footerQrLabel: { fontSize: 6, color: "#aaa", textAlign: "center" },
    footerPage: {
      fontSize: footerRightFontSize,
      color: footerRightFontColor,
      fontFamily: footerRightFontFamily,
      textAlign: "right",
    },
    // audit20: template footer segment line — each segment carries its own
    // fontSize / bold / italic / colour / alignment; the base style keeps
    // the vertical rhythm tight so several lines fit the footer band.
    footerSegment: {
      fontSize: 7.5,
      marginBottom: 1,
      textAlign: "left",
    },
    footerBankLine: {
      fontSize: 6.5,
      color: "#888888",
      textAlign: "center",
      marginBottom: 1,
    },
    // audit20: template header segment line — same styling model as the
    // footer segments but sized for the letterhead band.
    headerSegment: {
      fontSize: 9,
      marginBottom: 1,
      textAlign: "left",
    },
    // audit20: compact contact line under the auto company name (gated by
    // header_show_contact) — city/country only, never the full street
    // address (the FROM/TO party boxes already carry it; audit14 removed
    // the full-address duplication from the footer for the same reason).
    headerContactLine: {
      fontSize: 7.5,
      color: "#666666",
      marginBottom: 1,
    },

    // ── Document title block ──────────────────────────────────────────
    // audit21 design polish: the meta block (Document No. / Date / Currency)
    // used to float right-aligned with no container — visually detached from
    // the title, reading like an afterthought (design audit finding). A
    // subtle card (light bg + hairline border) anchors it to the grid and
    // gives the title row a professional two-card composition.
    // audit22: doc title treatment from style_json — size / colour /
    // letter spacing / transform / underline / rule line under the row.
    docTitleRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "stretch",
      marginBottom: 14,
      marginTop: 0,
      borderBottomWidth: st.title.showRule ? 1 : 0,
      borderBottomColor: st.title.ruleColor,
      paddingBottom: st.title.showRule ? st.title.spacingAfter : 0,
    },
    docTitleBlock: { flexDirection: "column", justifyContent: "center", flex: 1 },
    docTitle: {
      fontSize: st.title.fontSize,
      fontFamily: headingFontFamily,
      color: st.title.color,
      textTransform: st.title.transform,
      letterSpacing: st.title.letterSpacing,
      textDecoration: st.title.underline ? "underline" : undefined,
    },
    docSubtitle: { fontSize: 8.5, color: "#888", marginTop: 3 },
    docMetaBlock: {
      flexDirection: "column",
      alignItems: "flex-end",
      backgroundColor: "#f8fafc",
      borderWidth: 0.5,
      borderColor: "#e2e8f0",
      borderRadius: 3,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    docMetaRow: { flexDirection: "row", marginBottom: 2 },
    docMetaLabel: { fontSize: 8, color: "#888", marginRight: 4 },
    docMetaValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333" },

    // ── Proforma banner ("PROFORMA — NOT A TAX INVOICE") ──────────────
    proformaBanner: {
      borderWidth: 1,
      borderColor: "#cc0000",
      backgroundColor: "#fff5f5",
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 3,
      marginBottom: 10,
    },
    proformaBannerText: { fontSize: 8, fontFamily: headingFontFamily, color: "#cc0000", textTransform: "uppercase", textAlign: "center", letterSpacing: 0.5 },

    // ── Section header (FROM/TO/TRADE TERMS/LINE ITEMS/SPECIFICATIONS/...)
    sectionHeader: {
      fontSize: 9,
      fontFamily: headingFontFamily,
      color: accentColor,
      textTransform: "uppercase",
      paddingBottom: 4,
      borderBottomWidth: 1,
      borderBottomColor: tableBorderColor,
      marginBottom: 8,
      letterSpacing: 0.5,
    },

    // ── FROM / TO party boxes (audit22: style_json party styling) ────
    partiesSection: { flexDirection: "row", gap: mmToPoints(st.party.gap), marginBottom: 14 },
    partyBox: { flex: 1, borderWidth: st.party.borderWidth, borderColor: st.party.borderColor, borderRadius: st.party.borderRadius, overflow: "hidden", backgroundColor: st.party.bgColor },
    partyHeader: { backgroundColor: st.party.bgColor === "#ffffff" ? "#f5f5f5" : st.party.bgColor, paddingVertical: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: st.party.borderColor },
    partyHeaderText: { fontSize: 8, fontFamily: headingFontFamily, color: st.party.labelColor, textTransform: "uppercase", letterSpacing: 0.5 },
    partyBody: { padding: 8 },
    partyName: { fontSize: 9.5, fontFamily: headingFontFamily, color: st.party.valueColor, marginBottom: 3 },
    partyAddr: { fontSize: 8, color: st.party.labelColor, lineHeight: 1.4, marginBottom: 1 },

    // ── Trade Terms box (3-column grid) ───────────────────────────────
    tradeTerms: { marginBottom: 14, borderWidth: 1, borderColor: tableBorderColor, borderRadius: 3, overflow: "hidden" },
    tradeTermsRow: { flexDirection: "row", borderBottomWidth: 0.25, borderBottomColor: tableBorderColor },
    tradeTermsCell: { flex: 1, flexDirection: "row", paddingHorizontal: 8, paddingVertical: 5, borderRightWidth: 0.25, borderRightColor: tableBorderColor },
    tradeTermsCellLast: { flex: 1, flexDirection: "row", paddingHorizontal: 8, paddingVertical: 5 },
    tradeTermsLabel: { fontSize: 7, color: "#999", textTransform: "uppercase", marginRight: 4, fontFamily: headingFontFamily },
    tradeTermsValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333", flex: 1 },

    // ── Line items table ──────────────────────────────────────────────
    // audit22: header font size / padding / cell padding / border width /
    // stripe colour / body text colour now come from style_json (st).
    table: { marginBottom: 10, borderWidth: st.table.borderWidth, borderColor: stTableBorderColor, borderRadius: 3, overflow: "hidden" },
    tableHeader: {
      flexDirection: "row",
      backgroundColor: stTableHeaderBg,
      paddingVertical: mmToPoints(st.table.headerPaddingY),
    },
    th: {
      fontSize: st.table.headerFontSize,
      fontFamily: st.table.headerBold === false ? fontFamily : headingFontFamily,
      color: stTableHeaderColor,
      paddingHorizontal: 4,
      textTransform: st.table.headerTransform,
    },
    tableRow: {
      flexDirection: "row",
      paddingVertical: mmToPoints(st.table.cellPaddingY),
      borderBottomWidth: st.table.borderWidth,
      borderBottomColor: stTableBorderColor,
      alignItems: "stretch",
    },
    // Zebra-stripe background — applied to every other data row when
    // table_stripe is true. Uses a very light tint of the header
    // background so it blends with the document's branding.
    tableRowEven: {
      backgroundColor: stStripeBg,
    },
    td: { fontSize: st.table.cellFontSize, paddingHorizontal: 4, color: st.body.textColor },

    // ── Specifications (per product key/value table + free text) ──────
    specSection: { marginTop: 12, marginBottom: 10 },
    specItem: { marginTop: 6, marginBottom: 4 },
    specItemTitle: { fontSize: 8.5, fontFamily: headingFontFamily, color: primaryColor, marginBottom: 3 },
    specTable: { borderWidth: 0.5, borderColor: tableBorderColor, borderRadius: 3, overflow: "hidden" },
    specRow: { flexDirection: "row", borderBottomWidth: 0.25, borderBottomColor: tableBorderColor },
    specName: { flex: 1, fontSize: 8, paddingVertical: 3, paddingHorizontal: 6, color: "#666", fontFamily: headingFontFamily },
    specValue: { flex: 1, fontSize: 8, paddingVertical: 3, paddingHorizontal: 6, color: "#333" },
    specDetail: { fontSize: 7.5, color: "#555", lineHeight: 1.4, marginTop: 3, paddingHorizontal: 6 },

    // ── Totals (audit22: style_json totals styling) ──────────────
    totals: { marginTop: 12, alignSelf: "flex-end", width: 250 },
    totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
    totalLabel: { fontSize: 8.5, color: st.totals.labelColor },
    totalValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: st.totals.valueColor },
    grandTotal: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 8,
      marginTop: 4,
      borderTopWidth: 2,
      borderTopColor: st.totals.grandBgColor !== "#ecfdf5" ? st.totals.borderColor : primaryColor,
      backgroundColor: st.totals.grandBgColor,
    },
    grandTotalLabel: { fontSize: 10, fontFamily: st.totals.grandBold === false ? fontFamily : headingFontFamily, color: st.totals.grandColor },
    grandTotalValue: { fontSize: 13, fontFamily: st.totals.grandBold === false ? fontFamily : headingFontFamily, color: st.totals.grandColor },
    amountInWords: {
      marginTop: 6,
      paddingVertical: 6,
      paddingHorizontal: 8,
      backgroundColor: "#fafafa",
      borderRadius: 3,
      borderWidth: 0.5,
      borderColor: tableBorderColor,
    },
    amountInWordsLabel: { fontSize: 7, color: "#999", textTransform: "uppercase", marginBottom: 2, fontFamily: headingFontFamily },
    amountInWordsValue: { fontSize: 8.5, fontFamily: headingFontFamily, color: "#333", textTransform: "uppercase" },

    // ── Offer Text / Terms / Bank Details ─────────────────────────────
    termsBox: { marginTop: 14, marginBottom: 8 },
    termsText: { fontSize: 8.5, color: "#444", lineHeight: 1.5, marginBottom: 4 },

    // ── Bank Details — rendered as a clean vertical list (not a cramped grid) ──
    // One row per account: bank name + currency on line 1, account + SWIFT on line 2.
    bankList: {
      flexDirection: "column",
      gap: 6,
      marginTop: 4,
    },
    bankAccountRow: {
      flexDirection: "column",
      paddingBottom: 4,
      borderBottomWidth: 0.5,
      borderBottomColor: tableBorderColor,
      marginBottom: 2,
    },
    bankAccountName: {
      fontSize: 8.5,
      fontFamily: headingFontFamily,
      color: "#333",
      marginBottom: 1,
    },
    bankAccountDetails: {
      fontSize: 8,
      color: "#555",
      lineHeight: 1.4,
    },

    // ── Authorized Signatures ─────────────────────────────────────────
    signatureWrap: { position: "relative" },
    signatureBlock: { marginTop: 20, flexDirection: "row", justifyContent: "space-between", gap: 24 },
    signatureCol: { flex: 1, flexDirection: "column" },
    signatureParty: { fontSize: 8, color: "#555", marginBottom: 2, fontFamily: headingFontFamily },
    signatureLine: { marginTop: 26, borderBottomWidth: 1, borderBottomColor: "#333" },
    signatureLabel: { fontSize: 8, color: "#666", marginTop: 3, textAlign: "center", fontFamily: headingFontFamily },

    // ── Company Seal (Zigled) ─────────────────────────────────────────
    // Absolutely positioned over the signature area. Placement comes from the
    // TenantSeal.position field; offsets are in millimetres converted to points.
    // @react-pdf/renderer supports `transform` for rotation but does NOT support
    // per-axis translate — we use left/right/top/bottom + margins instead.
    sealOverlay: {
      position: "absolute",
      // Sensible defaults; overridden inline per-placement below.
      bottom: 0,
      right: 0,
      width: 90,
      height: 90,
      opacity: 0.85,
    },
    sealImage: {
      width: "100%",
      height: "100%",
      objectFit: "contain",
    },

    // ── Document Notice (legally required disclaimer per doc type) ────
    // audit22: notice treatment from style_json (st.notice).
    noticeBox: {
      marginTop: 14,
      paddingVertical: 6,
      paddingHorizontal: 10,
      backgroundColor: st.notice.bgColor,
      borderLeftWidth: 3,
      borderLeftColor: st.notice.borderColor,
      borderRadius: 2,
    },
    noticeText: { fontSize: st.notice.fontSize, color: st.notice.textColor, fontStyle: "italic", lineHeight: 1.4 },
  });

  const docTitleMap = {
    offer: "Offer",
    invoice: "Commercial Invoice",
    proforma: "Proforma Invoice",
    loi: "LETTER OF INTENT",
  } as const;
  // LOI has no `items` array (it carries a single product inline on the
  // doc row), so we normalise to an empty array for the line-items-driven
  // branch below. The cast through `any` keeps TS happy across the union.
  //
  // audit21 — CRITICAL crash fix: production invoice rows exist whose
  // `items` column holds a JSON *STRING* (e.g. "[]") rather than a parsed
  // array (legacy writes / certain automation paths). A string passes the
  // old `|| []` fallback (truthy) and even `length === 0` checks ("[]".length
  // is 2), then `items.map(...)` throws "items.map is not a function" —
  // which react-pdf surfaces as "Cannot read properties of null (reading
  // 'props')" and the whole PDF render 500s. normalizeLineItems (shared.ts)
  // guarantees every downstream consumer gets a real array.
  const items = normalizeLineItems<OfferLineItem>((doc as any).items);
  const currency = doc.currency || "USD";

  // ── Pull trade / shipping fields off the doc ───────────────────────
  // Offer carries these typed; invoice/proforma may carry them via the
  // extended DB row (we read defensively via `any`).
  const tradeFields = doc as any;
  // F-FINAL / P1: default incoterm + payment_terms to "—" (em-dash) instead
  // of the previous fake defaults "EXW" and "T/T in Advance". A default of
  // "EXW" made it look like the seller had committed to an ExWorks shipment
  // when in fact the field was simply empty — that's a legally meaningful
  // incoterm that imposes specific obligations on the buyer (loading, export
  // clearance, etc.). Same for "T/T in Advance" — a specific payment
  // instrument + timing the seller may not have agreed to. The em-dash
  // makes the missing-field state visually obvious on the rendered PDF.
  //
  // 2g-F18 fix (round 4): the Trade Terms grid used to render POL TWICE —
  // once appended to the Incoterm cell ("FOB · Rotterdam") and once in its
  // own POL cell. Now the Incoterm cell shows ONLY the incoterm code so
  // the grid is non-redundant.
  //
  // 2g-F19 fix (round 4): the Trade Terms grid used to fall back to
  // items[0]?.packaging / items[0]?.origin_country etc., which silently
  // misrepresented multi-line offers with different packaging per line.
  // Now the helpers detect multi-line divergence and show "Multiple" when
  // the values differ across line items — the reader knows they need to
  // look at the per-line table for the specifics.
  const incoterm: string = tradeFields.incoterm || (items[0] as any)?.incoterm || "—";
  const pol: string = tradeFields.pol || "—";
  const pod: string = tradeFields.pod || "—";
  const vessel: string = tradeFields.vessel || "—";
  const containerNo: string = tradeFields.container_no || "—";
  const leadTime: string = tradeFields.lead_time || "—";
  /** Pull a field from every line item and either return the common value
   *  or "Multiple" when the values diverge (so the Trade Terms grid never
   *  silently shows just the first item's value for a multi-line offer). */
  const commonLineValue = (extractor: (it: OfferLineItem) => string | null | undefined): string => {
    if (!items || items.length === 0) return "—";
    const vals = items.map(extractor).filter((v): v is string => Boolean(v));
    if (vals.length === 0) return "—";
    const first = vals[0];
    const allSame = vals.every((v) => v === first);
    return allSame ? first : `Multiple (${vals.length})`;
  };
  const packaging: string = tradeFields.packaging || commonLineValue((it: any) => it.packaging);
  const paymentTerms: string = tradeFields.payment_terms || tradeFields.terms || "—";
  // 2g-F19 fix: Trade Terms "Origin" cell now shows the COMMON origin
  // (or "Multiple") instead of just the first item's origin. The per-line
  // Origin column in the line-items table already shows the per-item value,
  // so when origins differ the reader looks at the table for the specifics.
  const originCountry: string = commonLineValue((it: any) => (it as any).origin_country);
  const bankDetails: string = tradeFields.bank_details || "";

  // ── Bank accounts (modern JSON array on tenant) ─────────────────────
  // The DB column is typed as `string | null` (jsonb), but in practice it
  // holds a JSON array of { bankName, currency, swiftCode, accountNumber }.
  // Normalise to a plain array so the JSX below can `.map()` cleanly.
  const parsedBankAccounts: any[] = (() => {
    const raw = tenant?.bank_accounts as unknown;
    if (Array.isArray(raw)) return raw as any[];
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  // ── Bank accounts list ────────────────────────────────────────────
  // If the document has a specific bank_details override (user selected
  // a specific bank account in the offer/invoice form), show ONLY that.
  // Otherwise:
  //   • template.selected_bank_accounts = [0,2] → show only those indexes
  //     into the tenant bank_accounts array (audit20 — the field finally
  //     has a column and now actually filters)
  //   • null/empty/absent → show all tenant accounts (previous behaviour)
  const selectedIdx = tpl?.selected_bank_accounts;
  const filteredBankAccounts: any[] = Array.isArray(selectedIdx) && selectedIdx.length > 0
    ? parsedBankAccounts.filter((_: any, i: number) => selectedIdx.includes(i))
    : parsedBankAccounts;
  const bankAccountsList: any[] = bankDetails ? [] : filteredBankAccounts;

  // ── Party box helper (used for FROM / TO) ──────────────────────────
  const PartyBox = ({
    title,
    name,
    addressLine,
    city,
    postal,
    country,
    taxId,
    vat,
    reg,
    email,
    phone,
    website,
  }: {
    title: string;
    name: string;
    addressLine?: string | null;
    city?: string | null;
    postal?: string | null;
    country?: string | null;
    taxId?: string | null;
    vat?: string | null;
    reg?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
  }) => (
    <View style={styles.partyBox}>
      <View style={styles.partyHeader}>
        <Text style={styles.partyHeaderText}>{title}</Text>
      </View>
      <View style={styles.partyBody}>
        <Text style={styles.partyName}>{name}</Text>
        {/* audit13: dedup — line 2 carries ONLY the postal/city/country parts
            the free-text address line doesn't already contain. Production
            data e.g. "GoldCrest …, Dubai, UAE" + city "Dubai" + country "AE"
            used to render a second "Dubai, United Arab Emirates" line under
            an address that already ended with "Dubai, UAE". */}
        {addressLine && <Text style={styles.partyAddr}>{addressLine}</Text>}
        {(() => {
          const rest = remainingAddressParts(addressLine, { postal, city, country });
          return rest ? <Text style={styles.partyAddr}>{rest}</Text> : null;
        })()}
        {reg && <Text style={styles.partyAddr}>Reg#: {reg}</Text>}
        {taxId && <Text style={styles.partyAddr}>Tax ID: {taxId}</Text>}
        {vat && <Text style={styles.partyAddr}>VAT#: {vat}</Text>}
        {(phone || email || website) && (
          <Text style={styles.partyAddr}>
            {[phone, email, website].filter(Boolean).join("  ·  ")}
          </Text>
        )}
      </View>
    </View>
  );

  // ── Document notice (legally required disclaimer) per doc type ─────
  const docNotice =
    docType === "invoice"
      ? "This is a computer-generated commercial invoice and is valid without signature."
      : docType === "proforma"
      ? "This proforma invoice is issued for customs/bank purposes only and is not a tax invoice."
      : docType === "loi"
      ? "This Letter of Intent is a non-binding expression of intent to purchase. It does not constitute a legally binding contract until a definitive purchase agreement is executed by both parties."
      : "This offer is valid until the date specified above. Prices are subject to confirmation at time of order.";

  // Verification code lives ONLY in the PDF metadata (subject/keywords) — never visible.
  const verificationMeta = verificationCode ? ` Verification: ${verificationCode}.` : "";

  // ── Placeholder substitution data (audit20) ───────────────────────
  // The generator passes curated values (letterhead-aware); when absent
  // (e.g. tests rendering buildPdfDocument directly) build a minimal set
  // inline so {tokens} still resolve.
  const phData: PlaceholderData = placeholderData ?? {
    company_name: tenant?.name || "",
    company_legal_name: tenant?.legal_name || tenant?.name || "",
    company_address: tenant?.address_line || "",
    company_city: tenant?.city || "",
    company_country: tenant?.country ? countryName(tenant.country) : "",
    company_postal_code: tenant?.postal_code || "",
    company_reg: tenant?.registration_number || "",
    company_vat: tenant?.vat_number || "",
    company_tax_id: tenant?.tax_id || "",
    company_phone: tenant?.phone || "",
    company_email: tenant?.email || "",
    company_website: tenant?.website || "",
    bank_name: tenant?.bank_name || "",
    bank_iban: tenant?.bank_iban || "",
    bank_swift: tenant?.bank_swift || "",
    doc_number: doc.number || "",
    doc_date: fmtDate((doc as any).issue_date || doc.created_at),
    valid_until: fmtDate((doc as any).valid_until || (doc as any).validity_until || null),
    due_date: fmtDate((doc as any).due_date || null),
    partner_name: partner?.name || "",
    partner_address: partner?.address_line || "",
    partner_city: partner?.city || "",
    partner_country: partner?.country ? countryName(partner.country) : "",
    total: typeof (doc as any).total === "number" ? fmtMoney((doc as any).total, currency) : "",
    currency,
  };

  // ── Segment renderer (audit22 "Template Studio") ──────────────────
  // Renders one template header/footer segment with the FULL Word-grade
  // property set: per-segment font family/size, bold/italic/underline/
  // strike, colour + background, letter & line spacing, spacing before/
  // after, padding, box + bottom borders, radius, text transform, opacity.
  // {page_number}/{total_pages} resolve per page via the Text render prop.
  //
  // The segment's paragraph chrome (spacing/bg/border/padding) lives on a
  // wrapping View; the typography lives on the Text. Both derive from the
  // SAME normalizeSegment() the browser preview uses — WYSIWYG by design.
  const SegmentText = ({ seg }: { seg: ContentSegment }) => {
    const s = normalizeSegment(seg);
    // Font resolution: per-segment family → template body family. Bold and
    // italic resolve to the registered NotoSans variants (or the built-in
    // Times/Courior italic/bold families).
    const segFamily =
      s.fontFamily === "Times-Roman" || s.fontFamily === "Courier" ? s.fontFamily : fontFamily;
    let segFont: string;
    if (s.bold && s.italic) {
      segFont = segFamily === "NotoSans" ? "NotoSans-BoldOblique"
        : segFamily === "Times-Roman" ? "Times-BoldItalic"
        : "Courier-BoldOblique";
    } else if (s.bold) {
      segFont = boldVariant(segFamily);
    } else if (s.italic) {
      segFont = segFamily === "NotoSans" ? "NotoSans-Oblique"
        : segFamily === "Times-Roman" ? "Times-Italic"
        : "Courier-Oblique";
    } else {
      segFont = segFamily;
    }

    // Paragraph chrome — spacing, background, borders, padding, radius.
    // Only set what the segment actually carries so the base vertical
    // rhythm (footerSegment/headerSegment marginBottom) stays intact for
    // legacy 6-prop segments.
     
    const wrapStyle: any = {};
    if (s.spacingBefore > 0) wrapStyle.marginTop = mmToPoints(s.spacingBefore);
    if (s.spacingAfter > 0) wrapStyle.marginBottom = mmToPoints(s.spacingAfter);
    if (s.bgColor) wrapStyle.backgroundColor = s.bgColor;
    if (s.paddingY > 0) { wrapStyle.paddingTop = mmToPoints(s.paddingY); wrapStyle.paddingBottom = mmToPoints(s.paddingY); }
    if (s.paddingX > 0) { wrapStyle.paddingLeft = mmToPoints(s.paddingX); wrapStyle.paddingRight = mmToPoints(s.paddingX); }
    if (s.border) {
      wrapStyle.borderWidth = s.border.width;
      wrapStyle.borderColor = s.border.color;
      wrapStyle.borderStyle = s.border.style;
    }
    if (s.borderBottom) {
      wrapStyle.borderBottomWidth = s.borderBottom.width;
      wrapStyle.borderBottomColor = s.borderBottom.color;
      wrapStyle.borderBottomStyle = s.borderBottom.style;
    }
    if (s.borderRadius > 0) wrapStyle.borderRadius = s.borderRadius;

    const textStyle: any = {
      fontSize: s.fontSize,
      fontFamily: segFont,
      color: s.color,
      textAlign: s.alignment,
    };
    if (s.lineHeight !== 1.35) textStyle.lineHeight = s.lineHeight;
    if (s.letterSpacing !== 0) textStyle.letterSpacing = s.letterSpacing;
    if (s.textTransform !== "none") textStyle.textTransform = s.textTransform;
    if (s.underline && s.strike) textStyle.textDecoration = "underline line-through";
    else if (s.underline) textStyle.textDecoration = "underline";
    else if (s.strike) textStyle.textDecoration = "line-through";
    if (s.opacity < 1) textStyle.opacity = s.opacity;

    const hasChrome = Object.keys(wrapStyle).length > 0;
    const inner = hasPagePlaceholders(s.text) ? (
      <Text
        style={textStyle}
        render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          substitutePlaceholders(s.text, { ...(phData as any), page_number: pageNumber, total_pages: totalPages })
        }
      />
    ) : (
      <Text style={textStyle}>{substitutePlaceholders(s.text, phData as any)}</Text>
    );

    // Empty text + no chrome → a spacer paragraph (Word's empty line).
    if (!s.text && !hasChrome) return <View style={{ height: mmToPoints(3) }} />;
    if (hasChrome) {
      return <View style={wrapStyle}>{inner}</View>;
    }
    return inner;
  };

  // ── QR block (audit20 zones) ──────────────────────────────────────
  // The QR image + "Scan to verify" label, wrapped for the zone layout.
  // audit20: applies the template's qr_opacity (_qrConfig) — previously
  // only the memo path could offset it.
  const QrBlock = () => (
    <View style={styles.footerQrWrap}>
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <Image
        style={{
          width: qrSizePts,
          height: qrSizePts,
          objectFit: "contain",
          opacity: qrOpacity,
        }}
        src={qrCodeDataUrl!}
      />
      <Text style={styles.footerQrLabel}>Scan to verify</Text>
    </View>
  );

  // ── Footer bank / tax compact lines (audit20) ─────────────────────
  // template.footer_show_bank_details → one compact line per shown bank
  // account (max 2, the account list is already template-filtered);
  // template.footer_show_tax_id → one Tax ID line. Centred, 6.5pt, muted —
  // the classic trade-document payment-reference footer. Only rendered in
  // template mode; the memo footer stays minimal (audit14).
  // audit20 dedup: when a template footer SEGMENT already carries the
  // legal notice text (the proforma starter ships its customs disclaimer as
  // footer_content), the body noticeBox would repeat the same sentence on
  // the last page while the footer shows it on EVERY page. Skip the body
  // notice when the footer already covers it (normalised containment).
  const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normNotice = normText(docNotice);
  const footerCoversNotice = footerSegments.some((seg) => {
    const t = normText(substitutePlaceholders(seg.text, phData as any));
    return t.length >= 20 && (normNotice.includes(t) || t.includes(normNotice));
  });

  const footerBankLines: string[] = [];
  if (tpl) {
    if (tpl.footer_show_bank_details && bankAccountsList.length > 0 && !bankDetails) {
      for (const acct of bankAccountsList.slice(0, 2)) {
        footerBankLines.push(
          `${acct.bankName || acct.bank_name || "Bank"}: ${acct.accountNumber || acct.account_number || "—"} · SWIFT ${acct.swiftCode || acct.swift_code || "—"}`,
        );
      }
    }
    if (tpl.footer_show_tax_id) {
      const taxId = letterhead?.company_tax_id || tenant?.tax_id;
      if (taxId) footerBankLines.push(`Tax ID: ${taxId}`);
    }
  }

  // ── audit27: build the ordered body sections ───────────────────────────
  // Each body section becomes a { key, y, node } entry; the node JSX is the
  // exact markup that used to sit inline in the body. `y` comes from
  // layout_json (the Template Studio's Layout tab) — the sections render
  // top→bottom in that order, so dragging a section there REALLY reorders
  // the generated PDF. Sections the doc type doesn't use are never added;
  // unknown/missing y values fall back to the canonical order.
  const bodySections: Array<{ key: string; y: number; node: React.ReactNode }> = [];

  // ── LOI-specific values (lifted from the old inline IIFE so each LOI
  //    body section can be ordered + gated individually) ──────────────────
  const loiDoc = docType === "loi" ? (doc as LetterOfIntent) : null;
  const loiBuyerName = loiDoc ? (loiDoc.buyer_name || tenant?.legal_name || tenant?.name || "the Buyer") : "";
  const loiSellerName = loiDoc ? (partner?.name || "the Seller") : "";
  const loiValidUntilStr = loiDoc ? fmtDate(loiDoc.validity_until) : "";
  const loiDefaultIntro = loiDoc
    ? `Dear ${loiSellerName},\n\n` +
      `We, ${loiBuyerName}, hereby express our firm intention to purchase the following goods under the terms and conditions stated in this Letter of Intent. This LOI is non-binding and serves as a formal expression of our intent to proceed with the purchase, subject to the execution of a definitive purchase agreement.\n\n` +
      `We look forward to your response by ${loiValidUntilStr}.`
    : "";
  const loiCoaEntries: [string, string][] = loiDoc && loiDoc.coa_params && typeof loiDoc.coa_params === "object"
    ? Object.entries(loiDoc.coa_params as Record<string, unknown>)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => [k, String(v)] as [string, string])
    : [];
  const loiSpecSource = loiDoc ? (loiDoc.specifications as any) : null;
  let loiSpecEntries: [string, string][] = [];
  if (Array.isArray(loiSpecSource)) {
    loiSpecEntries = loiSpecSource
      .filter((s: any) => s && s.name && s.value != null)
      .map((s: any) => [String(s.name), String(s.value)] as [string, string]);
  } else if (loiSpecSource && typeof loiSpecSource === "object") {
    loiSpecEntries = Object.entries(loiSpecSource)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => [k, String(v)] as [string, string]);
  }

  const hasItemSpecs = items.some((it: any) => {
    const specs = it.specifications;
    const hasSpecs = Array.isArray(specs)
      ? specs.length > 0
      : (specs && typeof specs === "object" && Object.keys(specs).length > 0);
    return hasSpecs || it.detailed_spec;
  });

  // ── 1. Document title & meta (the proforma banner travels with it) ─────
  if (!layoutHidden("doc_title")) {
    bodySections.push({
      key: "doc_title",
      y: layoutYOf("doc_title"),
      node: (<>
        <View style={styles.docTitleRow}>
          <View style={styles.docTitleBlock}>
            <Text style={styles.docTitle}>{docTitleMap[docType]}</Text>
            {doc.subject && <Text style={styles.docSubtitle}>{doc.subject}</Text>}
          </View>
          <View style={styles.docMetaBlock}>
            <View style={styles.docMetaRow}>
              <Text style={styles.docMetaLabel}>Document No.:</Text>
              <Text style={styles.docMetaValue}>{doc.number}</Text>
            </View>
            <View style={styles.docMetaRow}>
              <Text style={styles.docMetaLabel}>Date of Issue:</Text>
              <Text style={styles.docMetaValue}>
                {fmtDate((doc as any).issue_date || doc.created_at)}
              </Text>
            </View>
            {docType === "offer" && (doc as Offer).valid_until && (
              <View style={styles.docMetaRow}>
                <Text style={styles.docMetaLabel}>Valid Until:</Text>
                <Text style={styles.docMetaValue}>
                  {fmtDate((doc as Offer).valid_until as string)}
                </Text>
              </View>
            )}
            {docType === "loi" && (doc as LetterOfIntent).validity_until && (
              <View style={styles.docMetaRow}>
                <Text style={styles.docMetaLabel}>Valid Until:</Text>
                <Text style={styles.docMetaValue}>
                  {fmtDate((doc as LetterOfIntent).validity_until as string)}
                </Text>
              </View>
            )}
            {(docType === "invoice" || docType === "proforma") && (doc as any).due_date && (
              <View style={styles.docMetaRow}>
                <Text style={styles.docMetaLabel}>Due Date:</Text>
                <Text style={styles.docMetaValue}>
                  {fmtDate((doc as any).due_date)}
                </Text>
              </View>
            )}
            <View style={styles.docMetaRow}>
              <Text style={styles.docMetaLabel}>Currency:</Text>
              <Text style={styles.docMetaValue}>{currency}</Text>
            </View>
          </View>
        </View>
        {/* Proforma banner — clearly marked "PROFORMA — NOT A TAX INVOICE" */}
        {docType === "proforma" && (
          <View style={styles.proformaBanner}>
            <Text style={styles.proformaBannerText}>PROFORMA — NOT A TAX INVOICE</Text>
          </View>
        )}
      </>),
    });
  }

  // ── 2. Parties (FROM/TO boxes render as ONE row — one sort key) ────────
  if (!layoutHidden("from_box") || !layoutHidden("to_box")) {
    bodySections.push({
      key: "parties",
      y: partiesSortY,
      node: (
        <View style={styles.partiesSection}>
          {!layoutHidden("from_box") && (
          <PartyBox
            title={docType === "loi" ? "FROM (BUYER)" : "FROM (SELLER)"}
            name={tenant?.legal_name || tenant?.name || "Company"}
            addressLine={tenant?.address_line}
            city={tenant?.city}
            postal={tenant?.postal_code}
            country={tenant?.country}
            reg={tenant?.registration_number}
            vat={tenant?.vat_number}
            taxId={tenant?.tax_id}
            phone={tenant?.phone}
            email={tenant?.email}
            website={tenant?.website}
          />
          )}
          {!layoutHidden("to_box") && (
          <PartyBox
            title={docType === "loi" ? "TO (SELLER)" : "TO (BUYER)"}
            name={partner?.name || "—"}
            addressLine={partner?.address_line}
            city={partner?.city}
            postal={partner?.postal_code}
            country={partner?.country}
            reg={partner?.registration_number}
            vat={partner?.vat_number}
            taxId={partner?.tax_id}
            phone={partner?.phone}
            email={partner?.email}
            website={partner?.website}
          />
          )}
        </View>
      ),
    });
  }

  if (docType !== "loi") {
    // ── 3. Trade terms ──
    if (!layoutHidden("trade_terms")) {
      bodySections.push({
        key: "trade_terms",
        y: layoutYOf("trade_terms"),
        node: (<>
        <Text style={styles.sectionHeader}>Trade Terms</Text>
        <View style={styles.tradeTerms} wrap={false}>
          <View style={styles.tradeTermsRow}>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Incoterm</Text>
              {/* 2g-F18 fix (round 4): only the incoterm code here — POL has its own cell below. */}
              <Text style={styles.tradeTermsValue}>{incoterm}</Text>
            </View>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Origin</Text>
              {/* 2g-F19 fix (round 4): common origin (or "Multiple") instead of first-item-only. */}
              <Text style={styles.tradeTermsValue}>{originCountry === "—" ? "—" : (originCountry.startsWith("Multiple") ? originCountry : countryName(originCountry))}</Text>
            </View>
            <View style={styles.tradeTermsCellLast}>
              <Text style={styles.tradeTermsLabel}>Payment</Text>
              <Text style={styles.tradeTermsValue}>{paymentTerms}</Text>
            </View>
          </View>
          <View style={styles.tradeTermsRow}>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>POL</Text>
              <Text style={styles.tradeTermsValue}>{pol}</Text>
            </View>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>POD</Text>
              <Text style={styles.tradeTermsValue}>{pod}</Text>
            </View>
            <View style={styles.tradeTermsCellLast}>
              <Text style={styles.tradeTermsLabel}>Lead Time</Text>
              <Text style={styles.tradeTermsValue}>{leadTime}</Text>
            </View>
          </View>
          <View style={styles.tradeTermsRow}>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Packaging</Text>
              <Text style={styles.tradeTermsValue}>{packaging}</Text>
            </View>
            <View style={styles.tradeTermsCell}>
              <Text style={styles.tradeTermsLabel}>Vessel</Text>
              <Text style={styles.tradeTermsValue}>{vessel}</Text>
            </View>
            <View style={styles.tradeTermsCellLast}>
              <Text style={styles.tradeTermsLabel}>Container</Text>
              <Text style={styles.tradeTermsValue}>{containerNo}</Text>
            </View>
          </View>
        </View>
        </>),
      });
    }

    // ── 4. Line items table ──
    if (!layoutHidden("line_items_table")) {
      bodySections.push({
        key: "line_items_table",
        y: layoutYOf("line_items_table"),
        node: (<>
        <Text style={styles.sectionHeader}>Line Items</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={[styles.th, { flex: flexRowNum }]}>#</Text>
            <Text style={[styles.th, { flex: flexDescription }]}>Description</Text>
            <Text style={[styles.th, { flex: flexHsCode }]}>HS Code</Text>
            <Text style={[styles.th, { flex: flexOrigin }]}>Origin</Text>
            <Text style={[styles.th, { flex: flexQuantity }]}>Quantity</Text>
            <Text style={[styles.th, { flex: flexUnitPrice, textAlign: numericAlign }]}>Unit Price</Text>
            <Text style={[styles.th, { flex: flexTotal, textAlign: numericAlign }]}>Total</Text>
          </View>
          {items.map((item, i) => {
            // 2g-F7 fix (round 4): the "Total" column previously rendered
            // `item.total` verbatim — but for offers/invoices/proformas the
            // backend stores the line total as the TAX-INCLUSIVE amount
            // (lineTotal = net + tax in invoices-view.ts), while the
            // Subtotal row sums TAX-EXCLUSIVE line totals. The column
            // therefore didn't foot to the Subtotal. Now we render the
            // per-line tax-EXCLUSIVE amount (qty × unit_price) so the
            // column visually sums to the Subtotal row — matching the
            // tax breakdown below (Tax / VAT line then adds to Grand Total).
            const lineNet = (typeof item.unit_price === "number" && typeof item.quantity === "number")
              ? item.unit_price * item.quantity
              : (typeof item.total === "number" ? item.total : 0);
            return (
              <View
                key={i}
                style={[styles.tableRow, ...(tableStripe && i % 2 === 1 ? [styles.tableRowEven] : [])]}
              >
                <Text style={[styles.td, { flex: flexRowNum }]}>{i + 1}</Text>
                <Text style={[styles.td, { flex: flexDescription }]}>
                  {item.product_name}
                  {item.sku ? `\nSKU: ${item.sku}` : ""}
                  {item.brand ? `\nBrand: ${item.brand}` : ""}
                </Text>
                <Text style={[styles.td, { flex: flexHsCode }]}>{(item as any).hs_code || "—"}</Text>
                <Text style={[styles.td, { flex: flexOrigin }]}>{countryName((item as any).origin_country)}</Text>
                <Text style={[styles.td, { flex: flexQuantity, textAlign: numericAlign }]}>
                  {fmtQty(item.quantity)} {item.unit || "kg"}
                </Text>
                <Text style={[styles.td, { flex: flexUnitPrice, textAlign: numericAlign }]}>
                  {fmtMoney(item.unit_price, currency)}
                </Text>
                <Text style={[styles.td, { flex: flexTotal, textAlign: numericAlign, fontFamily: headingFontFamily }]}>
                  {fmtMoney(lineNet, currency)}
                </Text>
              </View>
            );
          })}
        </View>
        </>),
      });
    }

    // ── 5. Specifications ──
    if (!layoutHidden("specifications") && hasItemSpecs) {
      bodySections.push({
        key: "specifications",
        y: layoutYOf("specifications"),
        node: (
          <View style={styles.specSection}>
            <Text style={styles.sectionHeader}>Specifications</Text>
            {items.map((item: any, i: number) => {
              const specs = item.specifications;
              const specArray: Array<{ name: string; value: string }> = Array.isArray(specs)
                ? specs
                : (specs && typeof specs === "object"
                    ? Object.entries(specs).map(([k, v]) => ({ name: k, value: String(v) }))
                    : []);
              return (specArray.length > 0 || item.detailed_spec) ? (
                <View key={`spec-${i}`} style={styles.specItem}>
                  <View wrap={false}>
                    <Text style={styles.specItemTitle}>{item.product_name}</Text>
                    {specArray.length > 0 && (
                      <View style={styles.specTable}>
                        {specArray.map((spec, j) => (
                          <View key={j} style={styles.specRow}>
                            <Text style={styles.specName}>{spec.name}</Text>
                            <Text style={styles.specValue}>{spec.value}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                  {item.detailed_spec && (
                    <Text style={styles.specDetail}>{item.detailed_spec}</Text>
                  )}
                </View>
              ) : null;
            })}
          </View>
        ),
      });
    }

    // ── 6. Totals (amount-in-words gated inside the node) ──
    if (!layoutHidden("totals")) {
      bodySections.push({
        key: "totals",
        y: layoutYOf("totals"),
        node: (
        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal:</Text>
            <Text style={styles.totalValue}>{fmtMoney((doc as any).subtotal, currency)}</Text>
          </View>
          {(doc as any).discount_total > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Discount:</Text>
              <Text style={styles.totalValue}>-{fmtMoney((doc as any).discount_total, currency)}</Text>
            </View>
          )}
          {(doc as any).tax_total > 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{docType === "offer" ? "Tax / VAT:" : "VAT:"}</Text>
              <Text style={styles.totalValue}>{fmtMoney((doc as any).tax_total, currency)}</Text>
            </View>
          ) : (doc as any).tax_total === 0 ? (
            /* 2g-F11: when tax_total is EXPLICITLY 0 on a commercial
               invoice/proforma/offer, this is a reverse-charge (B2B
               cross-border) scenario. Tax authorities require the "Reverse
               charge" legend — omitting it makes the document look like a
               tax-exempt consumer sale.
               audit20 fix: the legend used to print when tax_total was
               null/undefined too (unknown ≠ zero) — a missing tax field
               asserted a legally-weighty statement the issuer never made.
               Unknown tax now renders NO VAT row at all. */
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>VAT:</Text>
              <Text style={styles.totalValue}>Reverse charge — VAT settled by recipient</Text>
            </View>
          ) : null}
          <View style={styles.grandTotal}>
            <Text style={styles.grandTotalLabel}>GRAND TOTAL:</Text>
            <Text style={styles.grandTotalValue}>{fmtMoney((doc as any).total, currency)}</Text>
          </View>
          {/* audit27: amount-in-words has its own eye-toggle — hiding it
              no longer removes the whole totals table. */}
          {!layoutHidden("amount_in_words") && (
          <View style={styles.amountInWords}>
            <Text style={styles.amountInWordsLabel}>Amount in Words</Text>
            <Text style={styles.amountInWordsValue}>{amountInWords((doc as any).total, currency)}</Text>
          </View>
          )}
        </View>
        ),
      });
    }

    // ── 7. Offer text / terms & conditions ──
    if (!layoutHidden("offer_text") && ((doc as any).terms || doc.notes)) {
      bodySections.push({
        key: "offer_text",
        y: layoutYOf("offer_text"),
        node: (
          <View style={styles.termsBox}>
            <Text style={styles.sectionHeader} wrap={false}>
              {docType === "offer" ? "Offer Text / Terms" : "Terms & Conditions"}
            </Text>
            {(doc as any).terms && <Text style={styles.termsText}>{(doc as any).terms}</Text>}
            {doc.notes && (doc as any).terms !== doc.notes && (
              <Text style={styles.termsText}>{doc.notes}</Text>
            )}
          </View>
        ),
      });
    }

    // ── 8. Bank details ──
    if (!layoutHidden("bank_details") && (bankAccountsList.length > 0 || bankDetails ||
      (!bankDetails && (tenant?.bank_name || tenant?.bank_iban || tenant?.bank_swift)))) {
      bodySections.push({
        key: "bank_details",
        y: layoutYOf("bank_details"),
        node: (
          <View style={styles.termsBox}>
            <Text style={styles.sectionHeader} wrap={false}>Bank Details</Text>

            {/* If document has a specific bank_details override (user selected
                one account in the form), show ONLY that — not all accounts. */}
            {bankDetails ? (
              <View style={styles.bankList}>
                <View style={styles.bankAccountRow} wrap={false}>
                  <Text style={styles.bankAccountDetails}>{bankDetails}</Text>
                </View>
              </View>
            ) : bankAccountsList.length > 0 ? (
              /* Modern: render every tenant account as its own row. */
              <View style={styles.bankList}>
                {bankAccountsList.map((acct: any, i: number) => (
                  <View key={i} style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountName}>
                      {acct.bankName || acct.bank_name || "Bank"}
                      {acct.currency ? ` (${acct.currency})` : ""}
                    </Text>
                    <Text style={styles.bankAccountDetails}>
                      Account: {acct.accountNumber || acct.account_number || "—"}
                      {"   "}
                      SWIFT: {acct.swiftCode || acct.swift_code || "—"}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              /* Legacy: tenant has only single-bank fields. */
              <View style={styles.bankList}>
                {tenant?.bank_name && (
                  <View style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountName}>{tenant.bank_name}</Text>
                  </View>
                )}
                {tenant?.bank_iban && (
                  <View style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountDetails}>IBAN: {tenant.bank_iban}</Text>
                  </View>
                )}
                {tenant?.bank_swift && (
                  <View style={styles.bankAccountRow} wrap={false}>
                    <Text style={styles.bankAccountDetails}>SWIFT/BIC: {tenant.bank_swift}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        ),
      });
    }
  } else if (loiDoc) {
    // ── LOI body — each piece is an orderable, gateable section ──────────
    // (LOI does NOT render the line items table / totals / bank details.)
    if (!layoutHidden("offer_text")) {
      bodySections.push({
        key: "offer_text",
        y: layoutYOf("offer_text"),
        node: (
                  <View style={styles.termsBox}>
                    <Text style={styles.termsText}>{loiDoc.terms_text || loiDefaultIntro}</Text>
                  </View>
        ),
      });
    }
    if (!layoutHidden("specifications")) {
      bodySections.push({
        key: "specifications",
        y: layoutYOf("specifications"),
        node: (<>
                  {/* Product Specifications — single product, key/value rows.
                      audit13: header + table wrapped in a wrap={false} View so
                      the section header can never be orphaned at the bottom of
                      a page while its table starts on the next. */}
                  <View wrap={false}>
                    <Text style={styles.sectionHeader}>Product Specifications</Text>
                    <View style={styles.specTable} wrap={false}>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Product Name</Text>
                      <Text style={styles.specValue}>{loiDoc.product_name}</Text>
                    </View>
                    {loiDoc.product_description ? (
                      <View style={styles.specRow}>
                        <Text style={styles.specName}>Description</Text>
                        <Text style={styles.specValue}>{loiDoc.product_description}</Text>
                      </View>
                    ) : null}
                    {loiDoc.hs_code ? (
                      <View style={styles.specRow}>
                        <Text style={styles.specName}>HS Code</Text>
                        <Text style={styles.specValue}>{loiDoc.hs_code}</Text>
                      </View>
                    ) : null}
                    {loiDoc.origin_country ? (
                      <View style={styles.specRow}>
                        <Text style={styles.specName}>Origin Country</Text>
                        <Text style={styles.specValue}>{countryName(loiDoc.origin_country)}</Text>
                      </View>
                    ) : null}
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Quantity</Text>
                      <Text style={styles.specValue}>{fmtQty(loiDoc.quantity)} {loiDoc.unit}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Unit Price</Text>
                      <Text style={styles.specValue}>{fmtMoney(loiDoc.unit_price, currency)}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Total Value</Text>
                      <Text style={[styles.specValue, { fontFamily: headingFontFamily }]}>
                        {fmtMoney(loiDoc.total_value, currency)}
                      </Text>
                    </View>
                  </View>
                  </View>

                  {/* COA (Certificate of Analysis) — rendered only when data
                      exists. audit13: keep header + table together. */}
                  {loiCoaEntries.length > 0 ? (
                    <View wrap={false}>
                      <Text style={styles.sectionHeader}>Certificate of Analysis (COA)</Text>
                      <View style={styles.specTable} wrap={false}>
                        {loiCoaEntries.map(([key, val], idx) => (
                          <View key={`coa-${idx}`} style={styles.specRow}>
                            <Text style={styles.specName}>{key}</Text>
                            <Text style={styles.specValue}>{val}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  {/* Technical Specifications — rendered only when data
                      exists. audit13: keep header + table together. */}
                  {loiSpecEntries.length > 0 ? (
                    <View wrap={false}>
                      <Text style={styles.sectionHeader}>Technical Specifications</Text>
                      <View style={styles.specTable} wrap={false}>
                        {loiSpecEntries.map(([key, val], idx) => (
                          <View key={`spec-${idx}`} style={styles.specRow}>
                            <Text style={styles.specName}>{key}</Text>
                            <Text style={styles.specValue}>{val}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ) : null}
        </>),
      });
    }
    if (!layoutHidden("trade_terms")) {
      bodySections.push({
        key: "trade_terms",
        y: layoutYOf("trade_terms"),
        node: (<>
                  {/* Delivery & Payment Terms. audit13: keep header + table
                      together (was orphaned at the bottom of page 1 with its
                      table on page 2). */}
                  <View wrap={false}>
                  <Text style={styles.sectionHeader}>Delivery &amp; Payment Terms</Text>
                  <View style={styles.specTable} wrap={false}>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Delivery Terms</Text>
                      <Text style={styles.specValue}>{loiDoc.delivery_terms || "—"}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Delivery Date</Text>
                      <Text style={styles.specValue}>{fmtDate(loiDoc.delivery_date)}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Payment Terms</Text>
                      <Text style={styles.specValue}>{loiDoc.payment_terms || "—"}</Text>
                    </View>
                    <View style={styles.specRow}>
                      <Text style={styles.specName}>Valid Until</Text>
                      <Text style={styles.specValue}>{loiValidUntilStr}</Text>
                    </View>
                  </View>
                  </View>
        </>),
      });
    }
  }

  // ── 9. Authorized signatures + company seal ──
  if (!layoutHidden("signatures")) {
    bodySections.push({
      key: "signatures",
      y: layoutYOf("signatures"),
      node: (
        <View style={styles.signatureWrap} wrap={false}>
          <View style={styles.signatureBlock}>
            <View style={styles.signatureCol}>
              <Text style={styles.signatureParty}>For {tenant?.legal_name || tenant?.name || "Company"}:</Text>
              <View style={styles.signatureLine} />
              <Text style={styles.signatureLabel}>{docType === "loi" ? "Buyer Signature" : "Authorized Signature"}</Text>
            </View>
            <View style={styles.signatureCol}>
              <Text style={styles.signatureParty}>For {partner?.name || (docType === "loi" ? "Seller" : "Buyer")}:</Text>
              <View style={styles.signatureLine} />
              <Text style={styles.signatureLabel}>{docType === "loi" ? "Seller Acceptance" : "Accepted & Signed"}</Text>
            </View>
          </View>

          {/* Company seal (zigled) — only rendered when a seal image is
              available. Placement / opacity / rotation come from the
              TenantSeal relation (passed in via the `seal` prop), with
              sensible defaults. memorandum_settings doesn't carry a
              seal_enabled flag — the seal is rendered whenever the tenant
              has a default seal configured (resolved by the generator). */}
          {sealImageUrl && seal && (() => {
            const position = seal.position || "bottom-right";
            const opacity = typeof seal.opacity === "number" ? seal.opacity : 1;
            const rotation = typeof seal.rotation_deg === "number" ? seal.rotation_deg : 0;
            // Seal dimensions in mm → points; fall back to a 30mm square.
            const wPts = mmToPoints(seal.image_width_mm || 30);
            const hPts = mmToPoints(seal.image_height_mm || 30);
            const offXPts = mmToPoints(seal.offset_x_mm || 0);
            const offYPts = mmToPoints(seal.offset_y_mm || 0);

            // Translate position + offset into left/top/right/bottom anchors.
            const placement: Record<string, any> = {
              "bottom-right": { right: 10 + offXPts, bottom: 0 + offYPts },
              "bottom-left":  { left:  10 + offXPts, bottom: 0 + offYPts },
              "bottom-center": { left: "50%", marginLeft: -wPts / 2 + offXPts, bottom: 0 + offYPts },
              "top-right":    { right: 10 + offXPts, top:    0 + offYPts },
              "top-left":     { left:  10 + offXPts, top:    0 + offYPts },
              "top-center":   { left: "50%", marginLeft: -wPts / 2 + offXPts, top: 0 + offYPts },
            };
            const posStyle = placement[position] || placement["bottom-right"];

            // @react-pdf/renderer accepts a `transform` string array; older
            // builds only honour a single string. We use a single string for
            // broad compatibility — a 0deg rotation produces an identity
            // transform, so omitting it is also fine.
            const transform = rotation ? `rotate(${rotation}deg)` : undefined;

            return (
              <View
                style={[
                  styles.sealOverlay,
                  posStyle,
                  { width: wPts, height: hPts, opacity },
                  transform ? ({ transform } as any) : {},
                ]}
                wrap={false}
              >
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image style={styles.sealImage} src={sealImageUrl} />
              </View>
            );
          })()}
        </View>
      ),
    });
  }

  // ── LOI notes — trailing block (not orderable) ──
  if (loiDoc?.notes) {
    bodySections.push({
      key: "loi_notes",
      y: 9995,
      node: (
                    <View style={styles.termsBox}>
                      <Text style={styles.sectionHeader} wrap={false}>Notes</Text>
                      <Text style={styles.termsText}>{loiDoc.notes}</Text>
                    </View>
      ),
    });
  }

  // Sort by the layout's y key (stable sort → ties keep insertion order,
  // which is the canonical order) and materialize the fragment list.
  const orderedBody = [...bodySections]
    .sort((a, b) => a.y - b.y)
    .map((s) => <React.Fragment key={s.key}>{s.node}</React.Fragment>);

  return (
    <Document
      title={pdfMeta?.title || `${docTitleMap[docType]} ${doc.number}`}
      author={pdfMeta?.author || tenant?.legal_name || tenant?.name || "VELOS CRM"}
      subject={pdfMeta?.subject || `${docTitleMap[docType]} ${doc.number} — ${partner?.name || "client"}.${verificationMeta}`}
      creator={pdfMeta?.creator || "VELOS CRM System"}
      keywords={pdfMeta?.keywords || `${docType}, ${doc.number}, ${partner?.name || ""}, ${currency}${verificationCode ? `, verification: ${verificationCode}` : ""}`}
      producer="VELOS CRM"
    >
      <Page size={pageSize} style={styles.page}>
        {/* 2g-F2: status watermark — stamps DRAFT/PAID/VOID/CANCELLED/OVERDUE
            (or PRICE NOT CONFIRMED for marketplace target-price-derived docs)
            across every page so the document's legal standing is unmissable.
            audit12: the shared <Watermark /> component keeps this pixel-identical
            to the packing-list and marketplace templates.
            audit23: a custom template watermark (style_json.watermark, e.g.
            "CONFIDENTIAL") REPLACES the status watermark — sent/issued docs
            can carry the tenant's own notice instead of nothing. */}
        {customWatermarkText ? (
          <View
            fixed
            style={{
              position: "absolute",
              top: "38%",
              left: 0,
              right: 0,
              zIndex: 0,
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                fontSize: wm.fontSize,
                fontFamily: "NotoSans-Bold",
                color: wm.color,
                opacity: wm.opacity,
                textAlign: "center",
                transform: `rotate(${wm.rotation}deg, ${watermarkOriginX}, ${wm.fontSize / 3})`,
              }}
            >
              {customWatermarkText}
            </Text>
          </View>
        ) : (
          <Watermark text={statusWatermarkText} />
        )}

        {/* ── audit22: custom overlays from layout_json ─────────────────
            Word-style absolutely-positioned text boxes / images the user
            placed on the page canvas in the Template Studio. They repeat
            on every page (fixed), like Word header text boxes. Empty when
            the template has no custom fields (default). */}
        {customOverlays.length > 0 && customOverlays.map((f) => {
          if (f.type === "custom_text") {
            // audit22: the visual editor writes props.content (legacy) or
            // props.text (studio) — accept both.
            const raw = typeof f.props?.text === "string"
              ? (f.props.text as string)
              : (typeof f.props?.content === "string" ? (f.props.content as string) : "");
            if (!raw.trim()) return null;
            const seg = normalizeSegment({
              ...(typeof f.props?.style === "object" && f.props.style ? f.props.style : {}),
              text: raw,
            } as any);
            const segFont = seg.bold
              ? boldVariant(seg.fontFamily === "Times-Roman" || seg.fontFamily === "Courier" ? seg.fontFamily : fontFamily)
              : (seg.fontFamily === "Times-Roman" || seg.fontFamily === "Courier" ? seg.fontFamily : fontFamily);
            return (
              <View
                key={f.id}
                fixed
                style={{
                  position: "absolute",
                  left: mmToPoints(f.x),
                  top: mmToPoints(f.y),
                  width: mmToPoints(f.width),
                  backgroundColor: seg.bgColor || undefined,
                  borderWidth: seg.border ? seg.border.width : 0,
                  borderColor: seg.border ? seg.border.color : undefined,
                  borderStyle: seg.border ? seg.border.style : undefined,
                  borderRadius: seg.borderRadius || undefined,
                  paddingTop: mmToPoints(seg.paddingY),
                  paddingBottom: mmToPoints(seg.paddingY),
                  paddingLeft: mmToPoints(seg.paddingX),
                  paddingRight: mmToPoints(seg.paddingX),
                  opacity: seg.opacity,
                }}
              >
                {hasPagePlaceholders(raw) ? (
                  <Text
                    style={{
                      fontSize: seg.fontSize,
                      fontFamily: seg.italic ? (segFont === "NotoSans" ? "NotoSans-Oblique" : `${segFont}Italic`) : segFont,
                      color: seg.color,
                      textAlign: seg.alignment,
                      lineHeight: seg.lineHeight,
                      letterSpacing: seg.letterSpacing || undefined,
                      textTransform: seg.textTransform !== "none" ? seg.textTransform : undefined,
                      textDecoration: seg.underline ? "underline" : undefined,
                    }}
                    render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
                      substitutePlaceholders(raw, { ...(phData as any), page_number: pageNumber, total_pages: totalPages })
                    }
                  />
                ) : (
                  <Text
                    style={{
                      fontSize: seg.fontSize,
                      fontFamily: seg.italic ? (segFont === "NotoSans" ? "NotoSans-Oblique" : `${segFont}Italic`) : segFont,
                      color: seg.color,
                      textAlign: seg.alignment,
                      lineHeight: seg.lineHeight,
                      letterSpacing: seg.letterSpacing || undefined,
                      textTransform: seg.textTransform !== "none" ? seg.textTransform : undefined,
                      textDecoration: seg.underline ? "underline" : undefined,
                    }}
                  >
                    {substitutePlaceholders(raw, phData as any)}
                  </Text>
                )}
              </View>
            );
          }
          if (f.type === "custom_image") {
            // audit22: accept props.src (studio) or props.imageUrl (visual editor).
            const src = typeof f.props?.src === "string"
              ? (f.props.src as string)
              : (typeof f.props?.imageUrl === "string" ? (f.props.imageUrl as string) : null);
            if (!src) return null;
            return (
              <View
                key={f.id}
                fixed
                style={{
                  position: "absolute",
                  left: mmToPoints(f.x),
                  top: mmToPoints(f.y),
                  width: mmToPoints(f.width),
                  height: mmToPoints(f.height),
                }}
              >
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image style={{ width: "100%", height: "100%", objectFit: "contain" }} src={src} />
              </View>
            );
          }
          return null;
        })}
        {/* ── HEADER (memorandum — fixed, repeats on every page) ────────
            IMPORTANT: header + footer MUST be inlined directly as
            <View fixed> children of <Page>. @react-pdf/renderer only
            recognizes the `fixed` prop on direct View children of Page.
            Do NOT wrap them in a function component and do NOT conditionally
            render them with {condition && (<View fixed>)} — the conditional
            can cause the renderer to lose the fixed signal on pages 2+. */}
        <View style={styles.header} fixed>
          <View style={styles.headerLeft}>
            {hasHeaderSegments ? (
              /* audit20: template header segments — styled lines with
                 {placeholders} (company name / address / reg / VAT…), each
                 with its own fontSize / bold / italic / colour / alignment.
                 Replaces the auto company-name header; {page_number} etc.
                 resolve per page via the render prop. */
              headerSegments.map((seg) => <SegmentText key={seg.id} seg={seg} />)
            ) : (
              <>
                {(tpl?.header_show_company_name !== false) && (
                  <Text style={styles.companyName}>{tenant?.legal_name || tenant?.name || "Company"}</Text>
                )}
                {/* audit20: header_show_contact renders the compact
                    city/country line (letterhead-style). Template mode ONLY —
                    the memo-era header stays company-name-only (audit13/14
                    dedup: city/country already live in the FROM party box,
                    and the header contact line would repeat them on every
                    page of a multi-page doc). */}
                {tpl && tpl.header_show_contact !== false && (tenant?.city || tenant?.country) && (
                  <Text style={styles.headerContactLine}>
                    {[tenant?.city, countryName(tenant?.country)].filter(Boolean).join(", ")}
                  </Text>
                )}
              </>
            )}
          </View>
          {showLogo && logoUrl ? (
            <View style={styles.headerLogoWrap}>
              {/* eslint-disable-next-line jsx-a11y/alt-text */}
              <Image style={styles.headerLogo} src={logoUrl} />
            </View>
          ) : null}
        </View>

        {/* audit12: body wrapper — carries the line height that used to sit
            on the page style. Everything between the fixed header and the
            fixed footer (title block, parties, trade terms, tables, totals,
            signatures, notices) renders inside it. */}
        <View style={styles.bodyBlock}>

        {/* audit27: ordered body sections — every section is built above as
            a node and rendered in the order the Template Studio's Layout tab
            defines (layout_json y). The header + footer stay fixed on every
            page and multi-page tables still paginate naturally. */}
        {orderedBody}

        {/* DOCUMENT NOTICE — legally required disclaimer per doc type.
            audit20: skipped when a template footer segment already carries
            the same text (it repeats on every page — the legal line is
            covered without the body duplicate). */}
        {!footerCoversNotice && (
        <View style={styles.noticeBox} wrap={false}>
          <Text style={styles.noticeText}>{docNotice}</Text>
        </View>
        )}
        </View>

        {/* ── FOOTER (memorandum — pinned to the bottom, repeats on every page)
            Inlined directly as <View fixed> (NOT wrapped in a component,
            NOT conditionally rendered) so @react-pdf/renderer recognizes
            the fixed prop on ALL pages. The page-number Text render prop
            only works inside a fixed View that's a direct child of Page.
            audit14: absolute bottom:0 pinning + the content is minimal by
            design — QR (left) and Page X of Y (right). The address/contact
            that used to sit in the center column duplicated the party
            boxes on every page, and the doc number + date in the right
            column duplicated the title meta block. */}
        {/* audit20: three-zone footer. QR anchors to its configured zone
            (footer-left / footer-center / footer-right / none — from the
            template's footer_content._qrConfig; memo mode keeps QR-left,
            the pre-audit20 look). Template segments render with their own
            alignment; the bank-details / tax-id flags append compact
            centred lines. Page number stays bottom-right (reading
            convention). Memo mode (no template): QR left + page# right —
            pixel-identical to the audit14 output. */}
        <View style={styles.footer} fixed>
            {/* LEFT zone — QR (footer-left) + left-aligned segments */}
            <View style={styles.footerZoneLeft}>
              {showQr && qrPosition === "footer-left" && qrCodeDataUrl ? (
                <QrBlock />
              ) : null}
              {footerSegments.filter((s) => s.alignment === "left").map((seg) => (
                <SegmentText key={seg.id} seg={seg} />
              ))}
            </View>

            {/* CENTER zone — QR (footer-center) + centered segments +
                the template's bank-details / tax-id compact lines.
                (audit14 dedup preserved: these render only when a template
                explicitly asks for them — the memo-era footer never
                duplicated the party boxes.) */}
            <View style={styles.footerZoneCenter}>
              {footerSegments.filter((s) => s.alignment === "center").map((seg) => (
                <SegmentText key={seg.id} seg={seg} />
              ))}
              {footerBankLines.map((line, i) => (
                <Text key={`fb-${i}`} style={styles.footerBankLine}>{line}</Text>
              ))}
              {showQr && qrPosition === "footer-center" && qrCodeDataUrl ? (
                <QrBlock />
              ) : null}
            </View>

            {/* RIGHT zone — right-aligned segments + QR (footer-right,
                side by side with the page number so a 15mm QR fits a 20mm
                footer) + "Page X of Y".
                2g-F4: react-pdf v4 supports the `render` prop on <Text>
                inside a `fixed` View — correct per-page numbering. */}
            <View style={styles.footerZoneRight}>
              <View style={styles.footerZoneRightRow}>
                {showQr && qrPosition === "footer-right" && qrCodeDataUrl ? (
                  <QrBlock />
                ) : null}
                {showPageNumber ? (
                  <Text
                    style={styles.footerPage}
                    render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
                  />
                ) : null}
              </View>
              {footerSegments.filter((s) => s.alignment === "right").map((seg) => (
                <SegmentText key={seg.id} seg={seg} />
              ))}
            </View>
        </View>
      </Page>
    </Document>
  );
}
