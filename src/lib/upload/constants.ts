/**
 * Shared upload size + MIME-type constants (audit P2-2 / task C-7).
 *
 * BEFORE this file existed, upload size limits were scattered across the
 * codebase as inline literals — and they DIDN'T agree:
 *   • `src/lib/upload/service.ts` `uploadFile()` had a hard 10 MB guard.
 *   • `src/app/api/documents/upload/route.ts` advertised 25 MB.
 *   • `src/app/api/portal/upload/route.ts` advertised 25 MB.
 *   • `src/app/api/portal/kyc/document/route.ts` had 10 MB (correct for KYC).
 *   • `src/components/portal/portal-messages.tsx` had a 25 MB client check.
 *   • `src/components/portal/portal-kyc.tsx` had a 10 MB client check.
 * The result: a 20 MB shared-document upload passed the route's 25 MB check
 * but then failed inside `uploadFile()`'s 10 MB guard — a confusing 500
 * for the user and an inconsistent contract for API consumers.
 *
 * This module is the single source of truth. All upload routes, the upload
 * service, and the client-side pre-flight checks import from here so the
 * limits can never drift again.
 *
 * Limits:
 *   • MAX_UPLOAD_SIZE       — general portal/shared-document uploads (25 MB).
 *   • MAX_KYC_UPLOAD_SIZE   — KYC identity documents, stricter (10 MB).
 *     KYC docs are typically small scans/photos; 10 MB is generous and
 *     keeps storage costs predictable for a high-volume table.
 *   • MAX_LOGO_UPLOAD_SIZE  — tenant logos / letterheads, very strict (2 MB).
 *     Logos are rendered on every public-facing document; 2 MB is plenty
 *     for a 1024×1024 PNG/WebP and keeps PDF generation fast.
 */

/** Max size for general portal / shared-document uploads (25 MB). */
export const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

/** Max size for KYC identity-document uploads (10 MB). */
export const MAX_KYC_UPLOAD_SIZE = 10 * 1024 * 1024;

/** Max size for tenant logo / letterhead uploads (2 MB). */
export const MAX_LOGO_UPLOAD_SIZE = 2 * 1024 * 1024;

/**
 * Allowed MIME types for general portal / shared-document uploads.
 * Mirrors the `PORTAL_ALLOWED` list in `verify-file.ts` — kept here as a
 * separate export so route handlers can return the list to the client
 * without depending on the magic-bytes verifier.
 */
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
];

/**
 * Allowed MIME types for KYC identity-document uploads.
 * Stricter than the general list: KYC documents should be PDF or raster
 * images only — no Office docs (which can carry macros), no plain text
 * (which could be anything), no GIF (which has no legitimate use for an
 * identity document).
 */
export const KYC_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];

/**
 * Allowed MIME types for tenant logo / letterhead uploads.
 * SVG is intentionally NOT included — it can carry <script> tags and is
 * a stored-XSS vector when rendered inline (see `verifyLogoUpload` in
 * `verify-file.ts`).
 */
export const LOGO_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Human-readable size labels for error messages. */
export const MAX_UPLOAD_SIZE_LABEL = "25 MB";
export const MAX_KYC_UPLOAD_SIZE_LABEL = "10 MB";
export const MAX_LOGO_UPLOAD_SIZE_LABEL = "2 MB";
