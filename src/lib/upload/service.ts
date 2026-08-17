import { getSupabase, isSupabaseConfigured } from "@/lib/supabase/client";
import { MAX_UPLOAD_SIZE, MAX_KYC_UPLOAD_SIZE } from "@/lib/upload/constants";

export interface UploadResult { url: string; path: string; }

/**
 * Whitelist of allowed file extensions, keyed by the server-verified MIME type
 * (the result of the magic-bytes check in `verify-file.ts`). The client-supplied
 * filename extension is NEVER trusted — an attacker can name a file `logo.aspx`
 * or `invoice.htm` and have it stored with that extension, which some downstream
 * systems (e.g. static file servers, antiviruses) may treat as executable or
 * HTML. Deriving the extension from the verified MIME type closes that hole.
 */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv",
};

/**
 * Upload a file to a Supabase Storage bucket.
 *
 * Size limit: defaults to `MAX_UPLOAD_SIZE` (25 MB) — the shared constant
 * from `@/lib/upload/constants`. Callers that need a stricter limit
 * (e.g. `uploadKycDocument` passes `MAX_KYC_UPLOAD_SIZE` = 10 MB) can
 * pass `maxSize` explicitly. This closes audit P2-2: previously
 * `uploadFile` had a hard-coded 10 MB guard that conflicted with the
 * 25 MB advertised by `documents/upload` and `portal/upload` routes,
 * so a 20 MB file passed the route check and then failed inside
 * `uploadFile` with a confusing 500.
 */
export async function uploadFile(
  bucket: string,
  path: string,
  buffer: Buffer,
  contentType: string,
  size: number,
  maxSize: number = MAX_UPLOAD_SIZE,
): Promise<UploadResult> {
  if (size > maxSize) {
    // Compute a human-readable label for the error message. We round to
    // the nearest MB so the message matches what the route handler
    // advertises (e.g. "Max 25MB" / "Max 10MB").
    const mb = Math.round(maxSize / (1024 * 1024));
    throw new Error(`File too large. Max ${mb}MB.`);
  }
  if (!isSupabaseConfigured()) {
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${contentType};base64,${base64}`;
    return { url: dataUrl, path };
  }
  const sb = getSupabase();
  const { error } = await sb.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data: publicData } = sb.storage.from(bucket).getPublicUrl(path);
  if (publicData?.publicUrl) return { url: publicData.publicUrl, path };
  const { data: signedData, error: signedError } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (signedError || !signedData?.signedUrl) return { url: path, path };
  return { url: signedData.signedUrl, path };
}

/**
 * Upload a KYC document.
 *
 * Enforces the stricter `MAX_KYC_UPLOAD_SIZE` (10 MB) — KYC docs are
 * typically small scans/photos and don't need the headroom of the
 * general 25 MB upload limit.
 *
 * `contentType` MUST be the server-verified MIME type (i.e. the
 * `detectedType` returned by `verifyKycUpload`), NOT the raw client-supplied
 * `file.type`. Callers already run the magic-bytes check before calling this,
 * so passing the verified MIME here means the stored file extension is derived
 * from the actual file content rather than the attacker-controlled filename.
 */
export async function uploadKycDocument(submissionId: string, fileName: string, buffer: Buffer, contentType: string, size: number): Promise<UploadResult> {
  const detectedMime = contentType;
  const ext = (detectedMime && MIME_TO_EXT[detectedMime]) || "bin";
  const path = `${submissionId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return uploadFile("kyc-documents", path, buffer, contentType, size, MAX_KYC_UPLOAD_SIZE);
}

/**
 * Delete a file from Supabase Storage.
 *
 * P1 / task C-4 Fix 5: previously this function logged storage-delete
 * failures at `console.warn` level and returned silently, so callers
 * had no way to know the delete failed — producing silent storage
 * orphans (DB row soft-deleted but the file in the `kyc-documents`
 * bucket lives on forever). We now log at `console.error` level with
 * the bucket + path so ops can spot orphan patterns. The function
 * still does NOT throw (callers in the portal-delete path prefer to
 * complete the DB soft-delete and log the storage failure rather than
 * fail the whole request) — but the error is now visible.
 */
export async function deleteFile(bucket: string, path: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const sb = getSupabase();
  const { error } = await sb.storage.from(bucket).remove([path]);
  if (error) {
    // P1 Fix 5: log at error level (not warn) so orphaned storage
    // objects are visible in error monitoring. The path + bucket are
    // included so ops can manually clean up the orphan if needed.
    console.error(
      `[upload] STORAGE ORPHAN: failed to delete ${path} from bucket ${bucket}: ${error.message}`,
    );
  }
}

/** Fresh short-lived signed URL for admin download. */
export async function getSignedDownloadUrl(bucket: string, path: string, ttlSeconds = 300): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const sb = getSupabase();
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, ttlSeconds, { download: true });
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Upload any portal file. Path pattern: <tenant>/<partner>/<category>/<timestamp>-<rand>.<ext>
 *
 * `contentType` MUST be the server-verified MIME type (i.e. the
 * `detectedType` returned by `verifyPortalUpload`), NOT the raw client-supplied
 * `file.type`. The stored extension is derived from this verified MIME via the
 * `MIME_TO_EXT` whitelist, so an attacker cannot influence the on-disk extension
 * by naming their file `evil.aspx` / `evil.htm`.
 */
export async function uploadPortalFile(opts: {
  tenantId: string;
  partnerId: string;
  category: string;
  fileName: string;
  buffer: Buffer;
  contentType: string;
  size: number;
  bucket?: string;
}): Promise<UploadResult> {
  const bucket = opts.bucket || "portal-uploads";
  const detectedMime = opts.contentType;
  const ext = (detectedMime && MIME_TO_EXT[detectedMime]) || "bin";
  const safeCat = opts.category.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = `${opts.tenantId}/${opts.partnerId}/${safeCat}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return uploadFile(bucket, path, opts.buffer, opts.contentType, opts.size);
}
