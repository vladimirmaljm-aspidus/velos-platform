import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError, resolveTenantId } from "@/lib/api/helpers";
import { uploadFile } from "@/lib/upload/service";
import { verifyFileContent } from "@/lib/upload/verify-file";
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_SIZE, MAX_UPLOAD_SIZE_LABEL } from "@/lib/upload/constants";
import type { DocumentRegisterEntry } from "@/lib/supabase/types";
import { getSupabase } from "@/lib/supabase/client";
import { nextDocRegisterNumber, bumpDocRegisterNumber } from "@/lib/api/doc-number";
// 31-f — shared request-body validation helpers (audit 30-a findings
// 30a-07/30a-08: JSON-path POST {} → document_register NOT NULL violation
// → 500, and {version: "one"} → PostgREST 22P02 integer cast → 500; now
// clean 400s before the DB write).
import { requireFields, assertNumeric } from "@/lib/api/validate";

export const runtime = "nodejs";

// ── FIX-TENANT-DOC: file-upload + verification + linking extensions ──
// The live `document_register` table has only the columns mirrored by the
// `DocumentRegisterEntry` core (id / number / type / version / reference_id
// / partner_id / title / status / created_by / metadata / created_at /
// updated_at). We deliberately did NOT add new DB columns (the task allowed
// us to skip migration if too complex). Instead, the file-upload + verify +
// linking fields are persisted inside the existing `metadata` JSONB column,
// and the helpers below merge them onto the row before returning it to the
// UI so the UI can treat them as first-class fields.

const VERIFICATION_KEYS = [
  "file_url",
  "file_name",
  "verification_status",
  "verified_by",
  "verified_at",
  "reject_reason",
  "linked_deal_id",
  "linked_invoice_id",
  "linked_offer_id",
] as const;

/** Merge metadata-stored extension fields onto the row so the UI can
 *  treat them as first-class fields. Legacy rows (no metadata key) get
 *  `null` / `undefined` defaults — the UI renders them as "unverified"
 *  (which it interprets as "verified for backward-compat"). */
function normalizeEntry<T extends DocumentRegisterEntry>(row: T): T {
  if (!row) return row;
  const md = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  const merged: T = { ...row };
  for (const key of VERIFICATION_KEYS) {
    if (merged[key] === undefined && md[key] !== undefined) {
      // Surface the metadata value as a top-level field.
      (merged as Record<string, unknown>)[key] = md[key] ?? null;
    }
  }
  return merged;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (document-register.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-register.read"); if (_d) return _d; } /* requirePermission wired */
  const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context. Select a tenant or provide ?tenant_id=." }, { status: 400 });
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;
  // FIX-MARKET-UI / FIX 4 — pagination. Cap limit at 500; views default to 20.
  // The previous behavior (no limit param) loaded all rows — for tenants with
  // a long document history this was a multi-second round-trip.
  const limit = url.searchParams.get("limit")
    ? Math.min(Number(url.searchParams.get("limit")), 500)
    : 20;
  const offset = url.searchParams.get("offset")
    ? Math.max(Number(url.searchParams.get("offset")), 0)
    : 0;
  const result = await auth.store.listDocumentRegister(tid, {
    search,
    filters: { type, status },
    limit,
    offset,
  });
  // FIX-TENANT-DOC: surface metadata-stored extension fields onto each row
  // before returning so the UI can read them as first-class fields.
  result.items = result.items.map(normalizeEntry);
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (document-register.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-register.create"); if (_d) return _d; } /* requirePermission wired */

    const tid = resolveTenantId(auth, req);
    if (!tid) return NextResponse.json({ error: "No tenant context. Select a tenant or provide ?tenant_id=." }, { status: 400 });
    const contentType = req.headers.get("content-type") || "";

    // ── FIX-TENANT-DOC: multipart upload path ──
    // When the client posts multipart/form-data, the route parses a file +
    // metadata fields, uploads the file to the `documents` Supabase Storage
    // bucket, and stores the resulting public URL + filename + linking
    // IDs + verification_status="pending" inside the row's metadata JSONB.
    // The JSON path (below) is preserved for backward compat with the
    // existing "New Entry" dialog (which posts JSON without a file).
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided." }, { status: 400 });
      }

      // Size + MIME limits come from the shared `@/lib/upload/constants`
      // module (audit P2-2 / task C-7) so they stay in sync with
      // `uploadFile()` and `verifyFileContent()`.
      if (file.size > MAX_UPLOAD_SIZE) {
        return NextResponse.json(
          { error: `File too large. Max ${MAX_UPLOAD_SIZE_LABEL}.` },
          { status: 400 },
        );
      }
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        return NextResponse.json(
          { error: `Unsupported file type: ${file.type || "unknown"}.` },
          { status: 400 },
        );
      }

      // Verify actual content via magic bytes — the client-supplied
      // `file.type` is attacker-controlled and routinely spoofed. The
      // `verifyFileContent` helper returns the server-verified MIME which
      // `uploadFile` then uses to derive the stored file extension (audit
      // P2-16 prevents `evil.aspx` / `evil.htm` path pollution).
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const verification = verifyFileContent(buffer, file.type, ALLOWED_MIME_TYPES);
      if (!verification.isValid || !verification.detectedType) {
        return NextResponse.json(
          { error: verification.error || "File content verification failed." },
          { status: 400 },
        );
      }
      const verifiedMime = verification.detectedType;

      // Build the storage path. We use the tenant id as the top-level
      // folder so a future "list all docs in a tenant" storage query is a
      // simple prefix match, and the document_register entry's id as the
      // sub-folder so revisions of the same logical document co-locate.
      // The id is generated client-side (crypto.randomUUID) so we can
      // upload the file BEFORE inserting the row; if the client didn't
      // supply one we generate it here.
      const entryId = (formData.get("id") as string | null) || crypto.randomUUID();
      const safeName = (file.name || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${tid}/${entryId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

      // Upload to the `documents` Supabase Storage bucket. The
      // `uploadFile` helper falls back to a `data:` URL when Supabase
      // isn't configured (local dev / CI without env vars), so the route
      // remains testable end-to-end without a live Supabase project.
      const uploadResult = await uploadFile("documents", path, buffer, verifiedMime, file.size);

      // Parse the remaining form fields. Each is OPTIONAL except `title`
      // and `type` (the existing JSON path requires `title`; we keep the
      // same contract here). Defaults: version=1, status="current",
      // verification_status="pending".
      const title = (formData.get("title") as string | null)?.trim();
      if (!title) {
        return NextResponse.json({ error: "Title is required." }, { status: 400 });
      }
      const type = (formData.get("type") as string | null) as DocumentRegisterEntry["type"] | null;
      if (!type) {
        return NextResponse.json({ error: "Type is required." }, { status: 400 });
      }
      const partner_id = (formData.get("partner_id") as string | null) || null;
      const reference_id = (formData.get("reference_id") as string | null) || null;
      const version = Number(formData.get("version") ?? 1) || 1;
      // FIX-UX #1: server-side auto-numbering. If the client omitted the
      // number (or sent an empty string), generate one atomically from
      // per-tenant, per-type sequence. Prevents collisions from concurrent
      // uploads + the "number=null" footgun.
      const suppliedNumber = (formData.get("number") as string | null)?.trim() || "";
      const number = suppliedNumber || (await nextDocRegisterNumber(tid, type)) || "";
      const change_note = (formData.get("change_note") as string | null) || "";
      // Optional linking to existing deal / invoice / offer. Stored in
      // metadata so the UI's "Linked to" dropdown can populate.
      const linked_deal_id = (formData.get("linked_deal_id") as string | null) || null;
      const linked_invoice_id = (formData.get("linked_invoice_id") as string | null) || null;
      const linked_offer_id = (formData.get("linked_offer_id") as string | null) || null;

      // Build the row payload. The extension fields live inside
      // `metadata` so the existing `document_register` table schema is
      // untouched.
      const entry: Partial<DocumentRegisterEntry> & { id?: string } = {
        id: entryId,
        tenant_id: tid,
        number: number || "",
        type,
        version,
        reference_id,
        partner_id,
        title,
        status: "current",
        created_by: auth.user.id,
        metadata: {
          change_note: change_note || null,
          // Upload metadata
          file_url: uploadResult.url,
          file_name: file.name,
          // Verification workflow — every upload starts as "pending".
          verification_status: "pending",
          verified_by: null,
          verified_at: null,
          reject_reason: null,
          // Optional links to existing CRM/finance entities.
          linked_deal_id,
          linked_invoice_id,
          linked_offer_id,
        },
      };

      // Use direct INSERT (not smartUpsert which UPDATEs if id exists —
      // the pre-generated entryId doesn't exist yet so UPDATE fails with
      // "Record not found"). Retry on unique-key collision (23505) — rare
      // race when two concurrent uploads each read the same MAX(number)
      // and produce the same next number. Up to 5 retries with SEQ+1.
      const insertPayload = { ...entry } as Record<string, unknown>;
      delete insertPayload.id; // let the DB generate the id
      const sb = getSupabase();
      let created: DocumentRegisterEntry | null = null;
      let insertError: { message?: string } | null = null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        const candidateNumber = attempt === 0
          ? entry.number!
          : bumpDocRegisterNumber(entry.number!, attempt);
        insertPayload.number = candidateNumber;
        const { data: inserted, error } = await sb
          .from("document_register")
          .insert(insertPayload)
          .select()
          .single();
        if (error) {
          // 23505 = unique_violation. Bump SEQ and retry. Other errors
          // (including RLS denial / missing column) break out.
          if (error.code === "23505" && attempt < 4) {
            continue;
          }
          insertError = error;
          break;
        }
        created = inserted as DocumentRegisterEntry;
      }
      if (insertError || !created) {
        return NextResponse.json({ error: sanitizeError(insertError) || "Failed to create entry." }, { status: 500 });
      }
      await audit(
        auth.store,
        auth.user,
        req,
        "document.register.create",
        "document_register",
        created.id,
        { number: created.number, file_name: file.name, verification_status: "pending" },
      );
      return NextResponse.json(normalizeEntry(created));
    }

    // ── JSON path (backward compat with the existing "New Entry" dialog) ──
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    // 31-f — required-field + numeric validation BEFORE the upsert (audit
    // 30a-08: POST {} → 500 "Missing required field."; 30a-07:
    // {version: "one"} → 500). Mirrors the multipart branch's contract
    // ("Title is required." / "Type is required." above) for the JSON
    // path. `number` is auto-generated below, `version` / `status` have DB
    // defaults. Skipped on the update path (body.id).
    if (!body.id) {
      const bad = requireFields(body, ["title", "type"]);
      if (bad) return bad;
    }
    // version is an integer column — a junk string is a PostgREST 22P02,
    // so coerce-or-400 up front.
    {
      const bad = assertNumeric(body, ["version"]);
      if (bad) return bad;
    }
    body.tenant_id = tid;
    if (!body.created_by) body.created_by = auth.user.id;
    // FIX-UX #1: server-side auto-numbering for the JSON path too. If the
    // caller didn't supply a `number` (or supplied an empty string),
    // generate one. Only do this for CREATE (no body.id) — preserves
    // user-edited numbers on UPDATEs.
    if (!body.id) {
      const suppliedJsonNumber = typeof body.number === "string" ? body.number.trim() : "";
      if (!suppliedJsonNumber) {
        const generated = body.type
          ? (await nextDocRegisterNumber(tid, body.type))
          : null;
        body.number = generated || body.number || "";
      }
    }
    // Retry-on-collision loop for fresh inserts that go through the
    // smartUpsert path. On 23505, bump SEQ and retry up to 5 times.
    let created: DocumentRegisterEntry | null = null;
    let lastErr: unknown = null;
    const isCreate = !body.id;
    const originalNumber = body.number;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await auth.store.upsertDocumentRegisterEntry(body);
        break;
      } catch (e: any) {
        lastErr = e;
        // PGRST116 / 23505 → unique collision on the number. Bump and retry
        // if we have a generated number to bump; otherwise bail.
        const isCollision =
          (e?.code === "23505") ||
          /unique|duplicate|constraint/i.test(String(e?.message || ""));
        if (isCreate && attempt < 4 && isCollision && originalNumber) {
          body.number = bumpDocRegisterNumber(originalNumber, attempt + 1);
          continue;
        }
        break;
      }
    }
    if (!created) {
      return NextResponse.json(
        { error: sanitizeError(lastErr) || "Failed to create entry." },
        { status: 500 },
      );
    }
    await audit(auth.store, auth.user, req, body.id ? "document.register.update" : "document.register.create", "document_register", created.id, { number: created.number });
    return NextResponse.json(normalizeEntry(created));
  } catch (error: any) {
    console.error("[document-register POST]", error);
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
