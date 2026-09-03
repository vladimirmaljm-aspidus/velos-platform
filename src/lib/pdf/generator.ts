import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { buildPdfDocument } from "./templates";
import { generateQrCodeDataUrl, generateVerificationCode, computePdfHash } from "./qr";
import { resolveDocumentTemplate, buildPlaceholderData } from "./doc-template";
import { getStore } from "@/lib/data/store";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import type { Offer, Invoice, Proforma, LetterOfIntent, Partner, Tenant, MemorandumSettings, TenantSeal, DocumentTemplate, DocumentVerification, TenantLetterhead } from "@/lib/supabase/types";
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
  /** PERF (D2 fix): rows the CALLING ROUTE already fetched for its own
   *  tenant/ownership checks and filename build. When supplied (and the
   *  ids match), generatePdf skips re-fetching them — previously every
   * admin PDF request fetched the doc, partner and tenant TWICE (once in
   * route-factory, once here), i.e. 3 redundant DB round trips. */
  prefetched?: {
    doc?: Offer | Invoice | Proforma | LetterOfIntent;
    partner?: Partner | null;
    tenant?: Tenant | null;
  };
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
 *
 * PERF (D2 fix): resolution costs a storage signed-URL round trip PLUS a
 * full HTTP download of the image bytes. Uncached, that's 4 sequential
 * network round trips per request (logo + seal) — on a cross-region
 * deployment (e.g. Vercel fra1 → Supabase ap-southeast-2) that alone is
 * over a second of pure latency. Tenant logos and seals change rarely, so
 * the resolved data: URLs are cached per lambda instance (5 min TTL,
 * 60 s for failures) — the cache lives at module scope and is shared by
 * every request served by the instance.
 */
interface CachedLogo {
  dataUrl: string | null;
  ts: number;
}
const logoCache = new Map<string, CachedLogo>();
const LOGO_CACHE_TTL_MS = 5 * 60_000;
const LOGO_CACHE_NEGATIVE_TTL_MS = 60_000;

/** Cache lookup. Returns `undefined` when there is no fresh entry. */
function getCachedLogo(key: string): string | null | undefined {
  const hit = logoCache.get(key);
  if (!hit) return undefined;
  const ttl = hit.dataUrl ? LOGO_CACHE_TTL_MS : LOGO_CACHE_NEGATIVE_TTL_MS;
  if (Date.now() - hit.ts > ttl) {
    logoCache.delete(key);
    return undefined;
  }
  return hit.dataUrl;
}

async function resolveLogoUrl(logoUrl: string | null | undefined): Promise<string | null> {
  if (!logoUrl) return null;

  // data: URLs (logos & seals uploaded via the UI) work natively with
  // @react-pdf/renderer — pass them straight through.
  if (logoUrl.startsWith("data:")) return logoUrl;

  // PERF: warm cache — skip the signed-URL round trip + image download.
  const cached = getCachedLogo(logoUrl);
  if (cached !== undefined) return cached;

  const dataUrl = await resolveLogoUrlUncached(logoUrl);
  logoCache.set(logoUrl, { dataUrl, ts: Date.now() });
  return dataUrl;
}

async function resolveLogoUrlUncached(logoUrl: string): Promise<string | null> {
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
  const t0 = Date.now();
  const store = await getStore();

  // Fetch the document — or reuse the row the calling route already fetched
  // for its tenant/ownership check (route-factory fetches it first to derive
  // tenant_id; re-fetching it here was a wasted DB round trip per request).
  // The id-check guards against a caller passing a prefetched row for a
  // different document — in that case we fall through to a real fetch.
  let doc: Offer | Invoice | Proforma | LetterOfIntent | null =
    opts.prefetched?.doc && opts.prefetched.doc.id === opts.docId ? opts.prefetched.doc : null;
  if (!doc) {
    if (opts.docType === "offer") doc = await store.getOffer(opts.docId);
    else if (opts.docType === "invoice") doc = await store.getInvoice(opts.docId);
    else if (opts.docType === "proforma") doc = await store.getProforma(opts.docId);
    else if (opts.docType === "loi") doc = await store.getLoi(opts.docId);
  }

  if (!doc) throw new Error(`${opts.docType} not found`);
  // Frozen const aliases for use inside the async IIFEs below — TS keeps the
  // null-narrowing only for consts captured by closures.
  const partnerId = doc.partner_id;

  // ── PERF (D2 fix): parallel data-fetch phase 1 ──────────────────────
  // partner, tenant, memorandum settings, document template and the
  // existing verification row are all INDEPENDENT given (doc, tenantId).
  // They used to run as 5 sequential awaits — on a cross-region deployment
  // (Vercel functions in fra1 ↔ Supabase in ap-southeast-2) every round
  // trip pays the full network RTT, so this waterfall alone cost seconds.
  // They now run concurrently via Promise.all; partner/tenant rows already
  // fetched by the caller (id-checked) skip the round trip entirely.
  const partnerFetch: Promise<Partner | null> = (async () => {
    if (!partnerId) return null;
    const pre = opts.prefetched?.partner;
    if (pre && pre.id === partnerId) return pre;
    return store.getPartner(partnerId);
  })();
  const tenantFetch: Promise<Tenant | null> = (async () => {
    const pre = opts.prefetched?.tenant;
    if (pre && pre.id === opts.tenantId) return pre;
    return store.getTenant(opts.tenantId);
  })();
  const memoFetch: Promise<MemorandumSettings | null> = getMemorandumSettings(opts.tenantId).catch(
    (memoErr: unknown) => {
      // Don't fail the whole PDF — fall back to built-in defaults.
      console.warn("[PDF] MemorandumSettings fetch failed — continuing with defaults:", memoErr);
      return null;
    },
  );
  // ── DocumentTemplate (audit20 / 20-a) ────────────────────────────────
  // The template the user edits in the Document Templates view — page size,
  // margins, header/footer segments, colours, table styling, letterhead +
  // seal links, QR placement, bank-account selection. Per-field precedence
  // in templates.tsx: template → memorandum_settings → built-in defaults,
  // so tenants without template rows render exactly as before.
  const templateFetch: Promise<DocumentTemplate | null> = (async () => {
    if (opts.templateOverride) return opts.templateOverride;
    try {
      return await resolveDocumentTemplate(store, opts.tenantId, opts.docType);
    } catch (tplErr) {
      console.warn("[PDF] DocumentTemplate resolution failed — continuing without template:", tplErr);
      return null;
    }
  })();
  // Existing verification row — needed by BOTH branches below (issue vs
  // re-render), fetched once, concurrently with the rest of phase 1.
  const verificationFetch: Promise<DocumentVerification | null> =
    store.getDocumentVerificationByDoc(opts.tenantId, opts.docType, opts.docId);

  const [rawPartner, tenant, memorandumSettings, template, existingVerification] = await Promise.all([
    partnerFetch,
    tenantFetch,
    memoFetch,
    templateFetch,
    verificationFetch,
  ]);

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

  // Handle verification (existingVerification was fetched in phase 1)
  let verificationCode: string | undefined;
  let qrCodeDataUrl: string | undefined;
  let pdfHash: string | undefined;
  let verificationId: string | undefined;

  if (opts.createVerification !== false) {
    // Check if verification already exists
    if (existingVerification && existingVerification.status === "active") {
      verificationCode = existingVerification.verification_code;
      verificationId = existingVerification.id;
    } else {
      verificationCode = generateVerificationCode(opts.docType, doc.number);
    }
  } else {
    // Even when NOT creating a new verification (portal-side PDF re-download),
    // if the admin already issued a verification for this document, we STILL
    // render its QR so scans keep working. Portal never creates a verification
    // but shouldn't strip an existing one either.
    if (existingVerification && existingVerification.status === "active") {
      verificationCode = existingVerification.verification_code;
      verificationId = existingVerification.id;
    }
  }

  // QR generation is pure local CPU (the `qrcode` npm lib — no network call),
  // kicked off NOW so it overlaps with the remaining network fetches instead
  // of sitting between them. Wrapped in catch — if the qrcode lib fails
  // (corrupt input, native module crash, etc.) we still produce a valid PDF
  // without the QR.
  const qrFetch: Promise<string | undefined> = verificationCode
    ? generateQrCodeDataUrl(verificationCode).catch((qrErr: unknown) => {
        console.warn("[PDF] QR code generation failed — continuing without QR:", qrErr);
        return undefined;
      })
    : Promise.resolve(undefined);

  // ── Letterhead (memorandum firme) + seal — parallel phase 2 ──────────
  // Both depend only on `template`, never on each other → fetched together
  // (was 2 sequential DB round trips).
  //
  // Template-linked letterhead wins; otherwise the tenant's own logo (the
  // pre-audit20 behaviour). The letterhead also carries curated company
  // fields used for {placeholder} substitution in header/footer segments.
  const letterheadFetch: Promise<TenantLetterhead | null> = (async () => {
    if (!template?.letterhead_id) return null;
    try {
      return await store.getLetterhead(template.letterhead_id);
    } catch (lhErr) {
      console.warn("[PDF] Letterhead fetch failed — continuing without it:", lhErr);
      return null;
    }
  })();

  // ── Seal (optional, branded stamp) ──────────────────────────────────
  // audit20: the template's seal wiring finally takes effect —
  //   • template.seal_enabled === false → NO seal (explicit opt-out)
  //   • template.seal_id → that specific seal
  //   • otherwise → the tenant's default seal (previous behaviour)
  const sealFetch: Promise<TenantSeal | null> = (async () => {
    if (template && template.seal_enabled === false) return null;
    try {
      return template?.seal_id
        ? await store.getSeal(template.seal_id)
        : await store.getDefaultSeal(opts.tenantId);
    } catch (sealErr) {
      console.warn("[PDF] Seal fetch failed — continuing without seal:", sealErr);
      return null;
    }
  })();

  const [letterhead, seal] = await Promise.all([letterheadFetch, sealFetch]);

  // Resolve the logo URL — the template-linked letterhead's logo wins, then
  // the tenant's own logo (tenant.logo_url). Resolution converts the storage
  // path into a data: URL so @react-pdf/renderer can render it without a
  // network round-trip. PERF (D2 fix): the logo and the seal image now
  // resolve CONCURRENTLY (was 4 sequential network round trips — 2
  // signed-URL calls + 2 image downloads), and each is memoised in the
  // module-scope logoCache across requests on the same lambda instance.
  const [resolvedLogoUrl, sealImageUrl, qrDataUrl] = await Promise.all([
    resolveLogoUrl(letterhead?.logo_url || tenant?.logo_url),
    seal ? resolveLogoUrl(seal.image_url) : Promise.resolve(null),
    qrFetch,
  ]);
  qrCodeDataUrl = qrDataUrl;

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

  // PERF (D2 fix): the document-register version lookup is independent of
  // the render and of the verification write — start it NOW so it overlaps
  // with renderToBuffer's CPU work instead of adding another sequential DB
  // round trip after it. The promise never rejects (the store method returns
  // 0 on error) and the UNIQUE index from migration 075 + the retry loop
  // below still guard the rare concurrent-slot race.
  const nextVersionFetch: Promise<number> | null = opts.createVerification !== false
    ? store.getMaxDocumentRegisterVersion(opts.tenantId, opts.docId, opts.docType)
    : null;

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
    const nextVersion = (await (nextVersionFetch ?? Promise.resolve(0))) + 1;
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

  // PERF telemetry (D2): one structured line per PDF render so the
  // serverless logs show the end-to-end generation time (data fetch +
  // render + verification/register writes) — grep "[pdf.perf]" in Vercel
  // logs to track the effect of the D2 fixes after deploy.
  console.log(`[pdf.perf] ${opts.docType} ${opts.docId} rendered in ${Date.now() - t0}ms (${buffer.length} bytes)`);

  return { buffer, verificationCode, pdfHash, verificationId };
}
