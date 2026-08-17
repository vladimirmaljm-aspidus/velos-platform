/**
 * File content verification using magic bytes.
 * Checks the ACTUAL file content, not the client-supplied MIME type.
 * This prevents attackers from uploading malicious files with spoofed MIME types.
 */

import {
  ALLOWED_MIME_TYPES,
  KYC_ALLOWED_MIME_TYPES,
  LOGO_ALLOWED_MIME_TYPES,
} from "@/lib/upload/constants";

interface FileVerification {
  isValid: boolean;
  detectedType: string | null;
  error?: string;
}

// Magic byte signatures for allowed file types
const MAGIC_BYTES: Record<string, { offset: number; bytes: number[]; mime: string; ext: string }> = {
  pdf:     { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf", ext: "pdf" },           // %PDF
  png:     { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], mime: "image/png", ext: "png" }, // \x89PNG
  jpeg:    { offset: 0, bytes: [0xFF, 0xD8, 0xFF], mime: "image/jpeg", ext: "jpg" },                        // \xFF\xD8\xFF
  gif:     { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif", ext: "gif" },                  // GIF8
  webp:    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp", ext: "webp" },                  // RIFF (check for WEBP after)
  // Office documents (check via OLE/OOXML magic bytes)
  doc:     { offset: 0, bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], mime: "application/msword", ext: "doc" }, // OLE2
  docx:    { offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" }, // ZIP (PK)
  xls:     { offset: 0, bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], mime: "application/vnd.ms-excel", ext: "xls" }, // OLE2
  xlsx:    { offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" }, // ZIP (PK)
  txt:     { offset: 0, bytes: [], mime: "text/plain", ext: "txt" }, // No magic bytes — check if printable
  csv:     { offset: 0, bytes: [], mime: "text/csv", ext: "csv" }, // No magic bytes — check if printable
};

// Allowed MIME types per upload context — sourced from the shared
// `@/lib/upload/constants` module (audit P2-2 / task C-7) so the magic-
// bytes verifier, the route guards, and the client-side pre-flight
// checks can never drift out of sync.
const PORTAL_ALLOWED = ALLOWED_MIME_TYPES;
const KYC_ALLOWED = KYC_ALLOWED_MIME_TYPES;
const LOGO_ALLOWED = LOGO_ALLOWED_MIME_TYPES;

function checkMagicBytes(buffer: Buffer, signature: { offset: number; bytes: number[] }): boolean {
  if (signature.bytes.length === 0) return true; // No magic bytes to check (txt, csv)
  if (buffer.length < signature.offset + signature.bytes.length) return false;
  for (let i = 0; i < signature.bytes.length; i++) {
    if (buffer[signature.offset + i] !== signature.bytes[i]) return false;
  }
  return true;
}

function isPrintableText(buffer: Buffer): boolean {
  // Check first 512 bytes — if mostly printable ASCII, it's likely text
  const sample = buffer.subarray(0, Math.min(512, buffer.length));
  let printable = 0;
  for (const byte of sample) {
    if ((byte >= 0x20 && byte <= 0x7E) || byte === 0x0A || byte === 0x0D || byte === 0x09) {
      printable++;
    }
  }
  return printable / sample.length > 0.8;
}

/**
 * Verify a file's actual content matches its claimed MIME type.
 * @param buffer - File content as Buffer
 * @param claimedMime - MIME type from file.type (client-supplied, can be spoofed)
 * @param allowedMimes - Array of allowed MIME types for this upload context
 * @returns Verification result with detected type
 */
export function verifyFileContent(buffer: Buffer, claimedMime: string, allowedMimes: string[]): FileVerification {
  // Check if claimed MIME is in allowed list
  if (!allowedMimes.includes(claimedMime)) {
    return { isValid: false, detectedType: null, error: `File type ${claimedMime} is not allowed.` };
  }

  // For text files (txt, csv), check if content is printable
  if (claimedMime === "text/plain" || claimedMime === "text/csv") {
    if (!isPrintableText(buffer)) {
      return { isValid: false, detectedType: null, error: "File claims to be text but contains binary data." };
    }
    return { isValid: true, detectedType: claimedMime };
  }

  // Check magic bytes for each type
  for (const [name, sig] of Object.entries(MAGIC_BYTES)) {
    if (sig.mime === claimedMime) {
      if (checkMagicBytes(buffer, sig)) {
        // Special case: RIFF could be WAV or AVI, not just WEBP
        if (name === "webp" && buffer.length >= 12) {
          const format = buffer.subarray(8, 12).toString("ascii");
          if (format !== "WEBP") {
            return { isValid: false, detectedType: null, error: "File is RIFF but not WebP." };
          }
        }
        // Special case: PK could be any ZIP-based format
        if (name === "docx" || name === "xlsx") {
          // Both are ZIP-based — check for [Content_Types].xml in the ZIP
          // For simplicity, accept PK signature as valid for Office formats
        }
        // Special case: OLE2 could be DOC or XLS
        if (name === "doc" || name === "xls") {
          // Both use OLE2 — accept based on claimed MIME
        }
        return { isValid: true, detectedType: claimedMime };
      } else {
        return { isValid: false, detectedType: null, error: `File claims to be ${claimedMime} but content doesn't match.` };
      }
    }
  }

  // Unknown type — reject
  return { isValid: false, detectedType: null, error: `Unknown file type: ${claimedMime}` };
}

/** Verify portal upload */
export function verifyPortalUpload(buffer: Buffer, claimedMime: string): FileVerification {
  return verifyFileContent(buffer, claimedMime, PORTAL_ALLOWED);
}

/** Verify KYC document upload */
export function verifyKycUpload(buffer: Buffer, claimedMime: string): FileVerification {
  return verifyFileContent(buffer, claimedMime, KYC_ALLOWED);
}

/** Verify logo upload (SVG is BANNED for security) */
export function verifyLogoUpload(buffer: Buffer, claimedMime: string): FileVerification {
  // SVG is explicitly banned — it can contain <script> tags (stored XSS)
  if (claimedMime === "image/svg+xml") {
    return { isValid: false, detectedType: null, error: "SVG files are not allowed for security reasons. Please use PNG, JPEG, or WebP." };
  }
  return verifyFileContent(buffer, claimedMime, LOGO_ALLOWED);
}
