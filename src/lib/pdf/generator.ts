import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { buildPdfDocument } from "./templates";
import { generateQrCodeDataUrl, generateVerificationCode, computePdfHash } from "./qr";
import { resolveDocumentTemplate, buildPlaceholderData } from "./doc-template";
import { getStore } from "@/lib/data/store";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import type { Offer, Invoice, Proforma, LetterOfIntent, Partner, Tenant, MemorandumSettings, TenantSeal, DocumentTemplate, TenantLetterhead } from "@/lib/supabase/types";
// P0-3 / Feature 2: partner PII (contact_email, phone, tax_id, vat_number)
// is stored encrypted (enc: prefix). The PDF generator fetches the partner
// via store.getPartner which returns the raw row — so tax_id shows as
// "enc:v1:..." in the PDF. We decrypt here so the PDF shows plaintext.
import { decryptFieldMasked, isEncrypted } from "@/lib/crypto/field-encryption";

export interface GeneratePdfOptions {
  docType: "offer" | "invoice" | "proforma" | "loi";
  docId: string;
  tenantId: string;
  createVerification?: boolean; // if true, creates a verification record with QR + hash
  /** audit23: render with THIS template instead of the resolved one — used
   *  by the Template Studio's live "Preview PDF" so the admin sees exactly
   *  how the (possibly unsaved) form would look on a real document. The
   *  override never writes verifications (createVerification is forced off). */
  templateOverride?: DocumentTemplate | null;
}

export interface GeneratePdfResult {
  buffer: Buffer;
  verificationCode?: string;
  pdfHash?: string;
  verificationId?: string;
}

/**
 * Resolve an image URL (tenant logo or seal image) into a form that
 * @react-pdf/renderer can fetch reliably.
 *
 * Cases handled:
 *  1. null / undefined → null
 *  2. data: URL → return as-is. <Image> handles these natively and re-fetching
 *     a large base64 payload is wasteful (logos & seals uploaded via the UI
 *     are stored as data: URLs).
 *  3. Full public URL (http…) → try to get a signed URL (works for private
 *     buckets); fall back to the original URL if signing fails.
 *  4. Relative storage path (e.g. "tenant-id/logo.png") → build a signed URL;
 *     fall back to constructing the public URL from SUPABASE_URL.
 *
 * For non-data: URLs we also fetch the bytes and re-encode as a data: URL.
 * This is critical because @react-pdf/renderer has no error boundary around
 * the <Image> component — if the remote URL returns a 404, a non-image
 * content type, or the network is unreachable, the entire PDF render throws
 * and the user sees a 500 instead of a PDF. By converting to a data: URL
 * ourselves we can detect failures early and gracefully fall back to the
 * no-logo layout.
 */
async function resolveLogoUrl(logoUrl: string | null | undefined): Promise<string | null> {
  if (!logoUrl) return null;

  // data: URLs (logos & seals uploaded via the UI) work natively with
  // @react-pdf/renderer — pass them straight through.
  if (logoUrl.startsWith("data:")) return logoUrl;

  // If Supabase is not configured, fetch as data URL (dev/mock mode)
  if (!isSupabaseConfigured()) return fetchAsDataUrl(logoUrl);

  let resolvedUrl: string | null = null;

  try {
    const sb = getSupabase();
    const supabaseUrl = process.env.SUPABASE_URL || "";

    // Determine the storage path inside the "tenant-logos" bucket
    let storagePath: string | null = null;

    if (logoUrl.startsWith("http")) {
      // Full URL — extract the path after the bucket segment
      // Public URL format: https://{ref}.supabase.co/storage/v1/object/public/tenant-logos/{path}
      // Signed URL format: https://{ref}.supabase.co/storage/v1/object/sign/tenant-logos/{path}?token=...
      const publicPrefix = `/storage/v1/object/public/tenant-logos/`;
      const signedPrefix = `/storage/v1/object/sign/tenant-logos/`;
      const idx1 = logoUrl.indexOf(publicPrefix);
      const idx2 = logoUrl.indexOf(signedPrefix);

      if (idx1 !== -1) {
        storagePath = decodeURIComponent(logoUrl.substring(idx1 + publicPrefix.length)).split("?")[0];
      } else if (idx2 !== -1) {
        storagePath = decodeURIComponent(logoUrl.substring(idx2 + signedPrefix.length)).split("?")[0];
      } else {
        // Not a Supabase storage URL — return as-is (could be an external logo)
        resolvedUrl = logoUrl;
      }
    } else {
      // Relative path — e.g. "tenant-id/logo.png"
      storagePath = logoUrl;
    }

    if (storagePath && !resolvedUrl) {
      // Try to get a signed URL (works for both public and private buckets)
      const { data, error } = await sb.storage
        .from("tenant-logos")
        .createSignedUrl(storagePath, 3600); // 1 hour expiry

      if (!error && data?.signedUrl) {
        resolvedUrl = data.signedUrl;
      } else {
        // Fallback: construct the public URL manually
        console.warn(`[PDF] Signed URL failed for logo path "${storagePath}": ${error?.message}. Falling back to public URL.`);
        resolvedUrl = `${supabaseUrl}/storage/v1/object/public/tenant-logos/${storagePath}`;
      }
    }
  } catch (err) {
    console.warn("[PDF] Error resolving logo URL:", err);
    resolvedUrl = logoUrl;
  }

  // Last resort — return the original URL
  if (!resolvedUrl) resolvedUrl = logoUrl;

  // Fetch the bytes and re-encode as data: URL so @react-pdf/renderer doesn't
  // have to perform a network fetch during render (which would throw on 404).
  return fetchAsDataUrl(resolvedUrl);
}

/**
 * Fetch a remote image URL and re-encode it as a base64 data: URL.
 * Returns null on any failure (HTTP error, network error, non-image content)
 * so the caller can gracefully skip rendering the logo.
 */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`[PDF] Logo fetch returned ${res.status} for ${url}`);
      return null;
    }
    const contentType = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      console.warn(`[PDF] Logo URL returned non-image content-type ${contentType} — skipping`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      console.warn(`[PDF] Logo URL returned empty body — skipping`);
      return null;
    }
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn(`[PDF] Logo fetch failed for ${url}:`, err);
    return null;
  }
}

/**
 * Fetch the per-tenant MemorandumSettings row. Auto-creates a default row
 * when none exists so a fresh tenant still gets a branded PDF without any
 * setup. Returns null on any error (missing table, network failure, etc.)
 * — the PDF renderer falls back to built-in defaults in that case.
 */
async function getMemorandumSettings(tenantId: string): Promise<MemorandumSettings | null> {
  // If Supabase isn't configured (dev/mock mode), there's no row to fetch.
  if (!isSupabaseConfigured()) return null;

  const sb = getSupabase();

  const { data, error } = await sb
    .from("memorandum_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    // The most common cause: the `memorandum_settings` table hasn't been
    // migrated yet. Log + fall back to defaults — don't crash the PDF.
    console.warn("[getMemorandumSettings] error:", error.message);
    return null;
  }

  // Auto-create defaults if none exist
  if (!data) {
    const { data: created, error: insErr } = await sb
      .from("memorandum_settings")
      .insert({ tenant_id: tenantId })
      .select("*")
      .maybeSingle();
    if (insErr) {
      console.warn("[getMemorandumSettings] auto-create failed:", insErr.message);
      return null;
    }
    return (created as MemorandumSettings | null) ?? null;
  }

  return data as MemorandumSettings;
}

export async function generatePdf(opts: GeneratePdfOptions): Promise<GeneratePdfResult> {
  const store = await getStore();

  // Fetch the document
  let doc: Offer | Invoice | Proforma | LetterOfIntent | null = null;
  if (opts.docType === "offer") doc = await store.getOffer(opts.docId);
  else if (opts.docType === "invoice") doc = await store.getInvoice(opts.docId);
  else if (opts.docType === "proforma") doc = await store.getProforma(opts.docId);
  else if (opts.docType === "loi") doc = await store.getLoi(opts.docId);

  if (!doc) throw new Error(`${opts.docType} not found`);

  // Fetch partner + tenant + memorandum settings
  const rawPartner = doc.partner_id ? await store.getPartner(doc.partner_id) : null;
  const tenant = await store.getTenant(opts.tenantId);

  // ── Decrypt partner PII for PDF display ─────────────────────────────
  // partner.contact_email, phone, tax_id, vat_number are stored encrypted
  // (enc: prefix, AES-256-GCM). store.getPartner returns the raw row, so
  // without this decrypt pass the PDF would show "enc:v1:..." ciphertext
  // in the party box (Tax ID, phone, email). We clone + decrypt here so
  // the PDF templates receive plaintext PII. This mirrors the decryption
  // the /api/partners/[id] GET route does for the admin UI.
  const partner: Partner | null = rawPartner ? (() => {
    const p = { ...rawPartner } as any;
    // audit26: masked decrypt — a failed decryption (rotated key) must never
    // print raw `enc:...` ciphertext inside a client-facing PDF.
    if (p.tax_id && typeof p.tax_id === "string" && isEncrypted(p.tax_id)) {
      try { p.tax_id = decryptFieldMasked(p.tax_id); } catch { p.tax_id = ""; }
    }
    if (p.vat_number && typeof p.vat_number === "string" && isEncrypted(p.vat_number)) {
      try { p.vat_number = decryptFieldMasked(p.vat_number); } catch { p.vat_number = ""; }
    }
    if (p.contact_email && typeof p.contact_email === "string" && isEncrypted(p.contact_email)) {
      try { p.contact_email = decryptFieldMasked(p.contact_email); } catch { p.contact_email = ""; }
    }
    if (p.phone && typeof p.phone === "string" && isEncrypted(p.phone)) {
      try { p.phone = decryptFieldMasked(p.phone); } catch { p.phone = ""; }
    }
    // AUDIT16 — contact_phone parity (portal profile PUT encrypts it).
    if (p.contact_phone && typeof p.contact_phone === "string" && isEncrypted(p.contact_phone)) {
      try { p.contact_phone = decryptFieldMasked(p.contact_phone); } catch { p.contact_phone = ""; }
    }
    // Strip internal HMAC columns (never shown in PDF)
    delete p.tax_id_hmac;
    delete p.vat_number_hmac;
    delete p.portal_token;
    return p as Partner;
  })() : null;

  let memorandumSettings: MemorandumSettings | null = null;
  try {
    memorandumSettings = await getMemorandumSettings(opts.tenantId);
  } catch (memoErr) {
    // Don't fail the whole PDF — fall back to built-in defaults.
    console.warn("[PDF] MemorandumSettings fetch failed — continuing with defaults:", memoErr);
  }

  // ── DocumentTemplate (audit20 / 20-a) ────────────────────────────────
  // The template the user edits in the Document Templates view — page size,
  // margins, header/footer segments, colours, table styling, letterhead +
  // seal links, QR placement, bank-account selection. Per-field precedence
  // in templates.tsx: template → memorandum_settings → built-in defaults,
  // so tenants without template rows render exactly as before.
  let template: DocumentTemplate | null = null;
  try {
    template = opts.templateOverride ?? await resolveDocumentTemplate(store, opts.tenantId, opts.docType);
  } catch (tplErr) {
    console.warn("[PDF] DocumentTemplate resolution failed — continuing without template:", tplErr);
  }

  // ── Letterhead (memorandum firme) ─────────────────────────────────────
  // Template-linked letterhead wins; otherwise the tenant's own logo (the
  // pre-audit20 behaviour). The letterhead also carries curated company
  // fields used for {placeholder} substitution in header/footer segments.
  let letterhead: TenantLetterhead | null = null;
  if (template?.letterhead_id) {
    try {
      letterhead = await store.getLetterhead(template.letterhead_id);
    } catch (lhErr) {
      console.warn("[PDF] Letterhead fetch failed — continuing without it:", lhErr);
    }
  }

  // Handle verification
  let verificationCode: string | undefined;
  let qrCodeDataUrl: string | undefined;
  let pdfHash: string | undefined;
  let verificationId: string | undefined;

  if (opts.createVerification !== false) {
    // Check if verification already exists
    const existing = await store.getDocumentVerificationByDoc(opts.tenantId, opts.docType, opts.docId);
    if (existing && existing.status === "active") {
      verificationCode = existing.verification_code;
      verificationId = existing.id;
    } else {
      verificationCode = generateVerificationCode(opts.docType, doc.number);
    }
    // Wrap QR generation in try/catch — if the qrcode lib fails (corrupt
    // input, native module crash, etc.) we still produce a valid PDF
    // without the QR.
    try {
      qrCodeDataUrl = await generateQrCodeDataUrl(verificationCode);
    } catch (qrErr) {
      console.warn("[PDF] QR code generation failed — continuing without QR:", qrErr);
      qrCodeDataUrl = undefined;
    }
  } else {
    // Even when NOT creating a new verification (portal-side PDF re-download),
    // if the admin already issued a verification for this document, we STILL
    // render its QR so scans keep working. Portal never creates a verification
    // but shouldn't strip an existing one either.
    const existing = await store.getDocumentVerificationByDoc(opts.tenantId, opts.docType, opts.docId);
    if (existing && existing.status === "active") {
      verificationCode = existing.verification_code;
      verificationId = existing.id;
      try {
        qrCodeDataUrl = await generateQrCodeDataUrl(verificationCode);
      } catch (qrErr) {
        console.warn("[PDF] QR code generation failed — continuing without QR:", qrErr);
        qrCodeDataUrl = undefined;
      }
    }
  }

  // Resolve the logo URL — the template-linked letterhead's logo wins, then
  // the tenant's own logo (tenant.logo_url). Resolution converts the storage
  // path into a data: URL so @react-pdf/renderer can render it without a
  // network round-trip.
  const resolvedLogoUrl = await resolveLogoUrl(letterhead?.logo_url || tenant?.logo_url);

  // ── Seal (optional, branded stamp) ──────────────────────────────────
  // audit20: the template's seal wiring finally takes effect —
  //   • template.seal_enabled === false → NO seal (explicit opt-out)
  //   • template.seal_id → that specific seal
  //   • otherwise → the tenant's default seal (previous behaviour)
  let seal: TenantSeal | null = null;
  if (template && template.seal_enabled === false) {
    seal = null;
  } else {
    try {
      seal = template?.seal_id
        ? await store.getSeal(template.seal_id)
        : await store.getDefaultSeal(opts.tenantId);
    } catch (sealErr) {
      console.warn("[PDF] Seal fetch failed — continuing without seal:", sealErr);
    }
  }
  const sealImageUrl = seal ? await resolveLogoUrl(seal.image_url) : null;

  // Build PDF metadata (visible in the PDF document properties dialog)
  // LOI doesn't have a `total` field — it has `total_value` (quantity × unit_price).
  // For the document register metadata we normalise to a single `total` value
  // so the audit-trail JSON is consistent across doc types.
  const docTitleLabel = opts.docType === "offer" ? "Offer" : opts.docType === "invoice" ? "Invoice" : opts.docType === "proforma" ? "Proforma" : "Letter of Intent";
  const pdfMeta = {
    title: `${docTitleLabel} ${doc.number} — ${tenant?.name || "VELOS"}`,
    author: tenant?.name || "VELOS CRM",
    subject: `${docTitleLabel} issued to ${partner?.name || "client"} on ${new Date().toLocaleDateString("en-US")}`,
    creator: "VELOS CRM System",
    keywords: [opts.docType, doc.number, partner?.name, doc.currency, verificationCode].filter(Boolean).join(", "),
  };

  // Build + render the PDF
  const element = React.createElement(buildPdfDocument, {
    doc,
    docType: opts.docType,
    partner,
    tenant,
    memorandumSettings,
    template,
    letterhead,
    placeholderData: buildPlaceholderData({ doc, tenant, partner, letterhead }),
    verificationCode,
    qrCodeDataUrl,
    logoUrl: resolvedLogoUrl,
    sealImageUrl,
    seal,
    pdfMeta,
  });
  const buffer = await renderToBuffer(element as any);

  // Compute hash + create verification record
  if (opts.createVerification !== false && verificationCode) {
    pdfHash = await computePdfHash(buffer);
    if (!verificationId) {
      const v = await store.createDocumentVerification({
        tenant_id: opts.tenantId,
        document_type: opts.docType,
        document_id: opts.docId,
        document_number: doc.number,
        verification_code: verificationCode,
        pdf_hash: pdfHash,
        pdf_size: buffer.length,
        issued_to_partner_id: doc.partner_id,
        issued_at: new Date().toISOString(),
      });
      verificationId = v.id;
    } else {
      // 2h-F3 fix (round 4): the existing verification record was created
      // on a PRIOR render — its stored pdf_hash matches the OLD PDF, not
      // the one we just generated. Refresh it so the forensic-equality
      // check at /api/document-verify/forensic still passes after a
      // regeneration. Without this, every regenerated PDF reports as
      // "tampered" because the stored hash is the first render's hash.
      await store.updateDocumentVerificationHash(verificationId, pdfHash, buffer.length);
    }
  }

  // ── Auto-register in Document Register ───────────────────────────────
  // Every issued document (offer/invoice/proforma/LOI) must be recorded in
  // the document register with a sequential version number so the firm has
  // a complete audit trail of all outbound documents INCLUDING regenerations.
  //
  // audit20 fix: portal partner RE-DOWNLOADS (createVerification === false)
  // no longer append a register entry. Previously every download minted a
  // new "-V{n}" row — 10 downloads = 10 junk versions polluting the audit
  // trail with byte-identical copies. Only issuance events register now:
  // admin renders, email sends and mail-queue retries (they all run with
  // createVerification !== false).
  if (opts.createVerification !== false) {
  // 2g-F1 fix (round 4): the prior `count + 1` logic produced wrong
  // versions when (a) an older version was deleted, or (b) the tenant had
  // >1000 doc-register entries for the same reference_id (the list-all
  // path was capped). Now we ask the DB directly for max(version) and add
  // 1 — and rely on the UNIQUE INDEX from migration 075 to prevent a
  // race-condition duplicate. The retry loop handles the rare race where
  // two concurrent renders both compute the same nextVersion.
  try {
    const nextVersion = (await store.getMaxDocumentRegisterVersion(opts.tenantId, opts.docId, opts.docType)) + 1;
    let attempts = 0;
    let lastErr: unknown = null;
    let registered = false;
    // Retry up to 3 times in case of UNIQUE-constraint collision (rare race
    // between two concurrent regens of the same doc — second one bumps to
    // nextVersion+1 after the first one wins the slot).
    while (attempts < 3 && !registered) {
      try {
        await store.upsertDocumentRegisterEntry({
          tenant_id: opts.tenantId,
          number: `${doc.number}-V${nextVersion + attempts}`,
          type: opts.docType as any,
          version: nextVersion + attempts,
          reference_id: opts.docId,
          partner_id: doc.partner_id,
          title: `${docTitleLabel} ${doc.number}`,
          status: "current",
          created_by: null,
          metadata: {
            verification_code: verificationCode,
            verification_id: verificationId,
            pdf_hash: pdfHash,
            pdf_size: buffer.length,
            currency: doc.currency,
            // LOI stores the document value as `total_value` (quantity × unit_price),
            // not `total`. Normalise so the register's metadata.total is consistent
            // across doc types — offer/invoice/proforma use `.total`, LOI uses
            // `.total_value`.
            total: (doc as any).total ?? (doc as any).total_value ?? 0,
            partner_name: partner?.name,
            generated_at: new Date().toISOString(),
          },
        } as any);
        registered = true;
      } catch (e) {
        lastErr = e;
        // 23505 = unique_violation in Postgres. If we hit it, the version
        // slot is taken — retry with the next slot. Other errors propagate.
        const msg = String((e as any)?.message || e);
        if (!/unique|23505|duplicate key/i.test(msg)) break;
        attempts++;
      }
    }
    if (!registered) {
      console.error("[pdf.generator] Document register write failed after retries:", lastErr);
    }
  } catch (regErr) {
    // Don't fail the PDF generation if the register write fails — log it.
    console.error("[pdf.generator] Document register version lookup failed:", regErr);
  }
  } // end createVerification !== false (audit20 register gating)

  return { buffer, verificationCode, pdfHash, verificationId };
}
