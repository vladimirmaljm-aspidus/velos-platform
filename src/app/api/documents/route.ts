import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, resolveTenantId } from "@/lib/api/helpers";
import { uploadFile } from "@/lib/upload/service";
import { verifyFileContent } from "@/lib/upload/verify-file";
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_LABEL } from "@/lib/upload/constants";
import type { SharedDocument } from "@/lib/supabase/types";
import { getSupabase } from "@/lib/supabase/client";

export const runtime = "nodejs";

// Storage bucket for shared documents. MUST match the bucket name used by
// the download route at `src/app/api/documents/[id]/route.ts` — that route
// reads `storage_path` from this row and calls `sb.storage.from(BUCKET).
// createSignedUrl(path, 300)` to produce the download URL. If these two
// constants drift the uploaded file won't be retrievable.
const BUCKET = "shared-documents";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (documents.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.read"); if (_d) return _d; } /* requirePermission wired */

    // FIX-DOCS-CHECK: was `auth.tenantId!` — broke for super_admin (whose
    // tenantId is null at the platform level). Super-admins now MUST pass
    // `?tenant_id=xxx`; regular admins keep their own tenant scope.
    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context. Select a tenant or provide ?tenant_id=." }, { status: 400 });

    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const partner_id = url.searchParams.get("partner_id") || undefined;
    const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const result = await auth.store.listDocuments(tid, { search, limit, offset, filters: { partner_id } });
    // Defense-in-depth: even though SupabaseStore filters by tenant_id,
    // this post-filter provides an extra safety layer. Do NOT remove.
    if (!auth.isSuperAdmin && auth.tenantId) {
      const before = result.items.length;
      result.items = result.items.filter((d) => d.tenant_id === auth.tenantId);
      result.total = result.total - (before - result.items.length);
    }
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[documents GET]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (documents.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "documents.create"); if (_d) return _d; } /* requirePermission wired */

    // FIX-DOCS-CHECK: was `auth.tenantId!` — broke for super_admin (whose
    // tenantId is null at the platform level). Super-admins now MUST pass
    // `?tenant_id=xxx` (or impersonate); regular admins keep their own
    // tenant scope.
    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context. Select a tenant or provide ?tenant_id=." }, { status: 400 });

    const contentType = req.headers.get("content-type") || "";

    // ── FIX-DOCS-CHECK: multipart upload path ──
    // The previous implementation only accepted a JSON body — so the user
    // had to type `mime_type`, `size`, and `storage_path` by hand. The
    // front-end `documents-view.tsx` `DocumentFormDialog` already sends
    // `multipart/form-data` (real file picker), but the route consumed it
    // as JSON → the upload silently broke (the JSON parser rejected the
    // multipart body, returning a 400). The multipart path mirrors the
    // pattern in `src/app/api/document-register/route.ts`:
    //   1. Validate size + MIME against the shared `@/lib/upload/constants`.
    //   2. Verify actual content via magic bytes (the client-supplied
    //      `file.type` is attacker-controlled and routinely spoofed).
    //   3. Upload to the `shared-documents` Supabase Storage bucket
    //      (path: `<tenantId>/<docId>/<timestamp>-<rand>-<safeName>`).
    //   4. INSERT a `shared_documents` row with the storage_path + URL +
    //      filename + mime_type + size set from the verified upload.
    // The JSON path (below) is preserved for backward compat with any
    // caller that still posts metadata-only rows (no file attached).
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided." }, { status: 400 });
      }

      // Size + MIME limits come from the shared `@/lib/upload/constants`
      // module so they stay in sync with `uploadFile()` + `verifyFileContent()`.
      if (file.size > MAX_UPLOAD_SIZE) {
        return NextResponse.json(
          { error: `File too large. Max ${MAX_UPLOAD_SIZE_LABEL}.` },
          { status: 400 },
        );
      }
      const claimedMime = file.type || "application/octet-stream";
      if (!ALLOWED_MIME_TYPES.includes(claimedMime)) {
        return NextResponse.json(
          { error: `Unsupported file type: ${claimedMime}.` },
          { status: 400 },
        );
      }

      // Verify actual content via magic bytes — the client-supplied
      // `file.type` is attacker-controlled and routinely spoofed.
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const verification = verifyFileContent(buffer, claimedMime, ALLOWED_MIME_TYPES);
      if (!verification.isValid || !verification.detectedType) {
        return NextResponse.json(
          { error: verification.error || "File content verification failed." },
          { status: 400 },
        );
      }
      const verifiedMime = verification.detectedType;

      // Build the storage path. We use the tenant id as the top-level
      // folder so a future "list all docs in a tenant" storage query is a
      // simple prefix match, and the document id as the sub-folder so
      // revisions of the same logical document co-locate.
      const docId = crypto.randomUUID();
      const safeName = (file.name || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${tid}/${docId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

      // Upload to the `shared-documents` Supabase Storage bucket. The
      // `uploadFile` helper falls back to a `data:` URL when Supabase
      // isn't configured (local dev / CI without env vars), so the route
      // remains testable end-to-end without a live Supabase project.
      const uploadResult = await uploadFile(BUCKET, path, buffer, verifiedMime, file.size);

      // Parse the remaining form fields. Each is OPTIONAL except
      // `partner_id` and `category` (the SharedDocument schema requires
      // both — the form enforces this client-side; we re-check here).
      const partner_id = (formData.get("partner_id") as string | null)?.trim() || "";
      if (!partner_id) {
        return NextResponse.json({ error: "Partner is required." }, { status: 400 });
      }
      const categoryRaw = (formData.get("category") as string | null) || "other";
      const validCategories: SharedDocument["category"][] = ["contract", "invoice", "spec", "other"];
      if (!validCategories.includes(categoryRaw as SharedDocument["category"])) {
        return NextResponse.json({ error: `Invalid category: ${categoryRaw}.` }, { status: 400 });
      }
      const category = categoryRaw as SharedDocument["category"];
      const visible_to_partner = (formData.get("visible_to_partner") as string | null) === "true";
      // Optional display name — overrides the on-disk filename in the
      // `shared_documents.filename` column (see documents-view.tsx
      // comment: useful when the file name is "scan_001.pdf" but the user
      // wants to show "Q1 2026 contract").
      const subject = (formData.get("subject") as string | null)?.trim() || "";
      const filename = subject || file.name;

      // Quota gate (monthly_documents) — only on CREATE.
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", auth.isSuperAdmin);
      if (denied) return denied;

      const sb = getSupabase();
      const { data: created, error: insertError } = await sb
        .from("shared_documents")
        .insert({
          id: docId,
          tenant_id: tid,
          partner_id,
          filename,
          mime_type: verifiedMime,
          size: file.size,
          storage_path: uploadResult.path,
          category,
          uploaded_by: auth.user.id,
          visible_to_partner,
        })
        .select()
        .single();
      if (insertError || !created) {
        return NextResponse.json({ error: sanitizeError(insertError) || "Failed to create document." }, { status: 500 });
      }
      const doc = created as SharedDocument;
      await audit(
        auth.store,
        auth.user,
        req,
        "document.upload",
        "document",
        doc.id,
        { filename: doc.filename, category: doc.category, size: doc.size },
      );
      return NextResponse.json(doc);
    }

    // ── JSON path (backward compat with metadata-only callers) ──
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    body.tenant_id = tid;
    if (!body.uploaded_by) body.uploaded_by = auth.user.id;
    // Quota gate (monthly_documents) — only on CREATE, never on UPDATE.
    if (!body.id) {
      const { enforceQuota } = await import("@/lib/api/plan-limits");
      const denied = await enforceQuota(tid, "monthly_documents", auth.isSuperAdmin);
      if (denied) return denied;
    }
    const created = await auth.store.upsertDocument(body);
    await audit(auth.store, auth.user, req, body.id ? "document.update" : "document.upload", "document", created.id, { filename: created.filename });
    return NextResponse.json(created);
  } catch (e: any) {
    console.error("[documents POST]", e);
    return NextResponse.json(
      { error: sanitizeError(e) },
      { status: 500 },
    );
  }
}
