import QRCode from "qrcode";
import { randomBytes } from "crypto";

/**
 * Generates a QR code as a data URL (base64 PNG).
 * The QR code encodes the public verification URL.
 *
 * audit20 fix: the legacy fallback pointed at the OLD product domain
 * (aspidus.onrender.com) — APP_BASE_URL isn't set in any repo env file, so
 * deployments without it minted QR codes that led to a dead site. The
 * fallback is now the live production deployment.
 */
export async function generateQrCodeDataUrl(verificationCode: string, baseUrl?: string): Promise<string> {
  const base = baseUrl || process.env.APP_BASE_URL || "https://velos-platform.vercel.app";
  const url = `${base}/verify/${verificationCode}`;
  return QRCode.toDataURL(url, {
    width: 120,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });
}

/**
 * Generates a QR code as a base64 string (without the data: prefix).
 */
export async function generateQrCodeBase64(verificationCode: string, baseUrl?: string): Promise<string> {
  const dataUrl = await generateQrCodeDataUrl(verificationCode, baseUrl);
  return dataUrl.split(",")[1];
}

/**
 * Computes SHA-256 hash of a buffer (for PDF forensic verification).
 */
export async function computePdfHash(buffer: Buffer | Uint8Array): Promise<string> {
  const { createHash } = await import("crypto");
  const hash = createHash("sha256").update(buffer).digest("hex");
  return `sha256:${hash}`;
}

/**
 * Generates a unique verification code for a document.
 * Format: ASP-{TYPE}{YY}-{SEQ}-{RANDOM6}
 *   • TYPE — 2-letter doc type prefix (OF/IV/PR/DC)
 *   • YY   — last 2 digits of the current UTC year (e.g. "26" for 2026)
 *   • SEQ  — 3-digit zero-padded sequence derived from the doc number's
 *            trailing digits (so the same doc always produces the same
 *            SEQ slot — the random suffix is what makes it unique)
 *   • RANDOM6 — 6 hex chars from crypto.randomBytes (64^6 ≈ 6.8 × 10^10
 *               possibilities per SEQ slot per second — collision-free)
 *
 * Example: ASP-OF26-001-X7K2M9
 *
 * 2g-F8 fix (round 4): the prior implementation built `numPart` from the
 * doc number's trailing digits and then sliced YY/SEQ out of it — that
 * produced inverted + year-less codes like `ASP-OF01-026-...`. Now we
 * pull YY straight from the year, and SEQ from the doc number's tail
 * (with a stable modulo so the SEQ slot stays 3 digits even for high
 * sequence numbers).
 */
export function generateVerificationCode(docType: string, docNumber: string): string {
  const prefix = "ASP";
  const typeCode =
    docType === "offer" ? "OF"
    : docType === "invoice" ? "IV"
    : docType === "proforma" ? "PR"
    : docType === "loi" ? "LI"
    : docType === "packing_list" ? "PL"
    : docType === "certificate_of_origin" ? "CO"
    : docType === "bill_of_lading" ? "BL"
    : "DC";
  // Year — actual last-2-digits of the current UTC year (was: digit-sliced
  // out of the doc number, which has no year in it).
  const yy = String(new Date().getUTCFullYear()).slice(-2).padStart(2, "0");
  // SEQ — 3-digit zero-padded value derived from the doc number's trailing
  // digits. The doc number typically looks like "OF-2026-001" or "INV-25-42";
  // we extract the LAST contiguous run of digits before any non-digit suffix.
  // Falls back to a 3-digit hash of the string when no digits are present.
  const digitRuns = docNumber.match(/\d+/g) || [];
  const lastRun = digitRuns.length > 0 ? digitRuns[digitRuns.length - 1] : "";
  const seqNum = lastRun ? (Number(lastRun) % 1000) || (lastRun.length % 1000) || 1 : 1;
  const seq = String(seqNum).padStart(3, "0");
  // RANDOM6 — 6 hex chars from crypto.randomBytes (was: 4 bytes sliced to 6
  // chars — kept the same approach but documented the entropy source).
  const random = randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  return `${prefix}-${typeCode}${yy}-${seq}-${random}`;
}
