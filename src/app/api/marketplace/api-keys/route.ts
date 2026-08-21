import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { audit } from "@/lib/api/helpers";
import { randomBytes, createHash } from "crypto";
import { triggerWebhooks } from "@/lib/webhooks/deliver";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// ── Partner-level marketplace API keys ────────────────────────────────────
//
// POST /api/marketplace/api-keys — create a new marketplace API key for
//   the calling partner. The key is stored in the existing `api_keys`
//   table with `permissions: ['marketplace:read']` AND a `partner_id`
//   column binding (migration 053) so the partner's keys are visible
//   only to that partner (not to other portal partners in the same
//   tenant). The full key string is returned ONCE on creation; the
//   hashed form is what's stored.
//
// GET /api/marketplace/api-keys — list the calling partner's marketplace
//   API keys (without key_hash). Used by the partner's "API Keys" UI.
//
// DELETE /api/marketplace/api-keys?id=<keyId> — revoke (soft-delete) a
//   key. Only the partner that created the key (or a tenant admin via
//   the existing /api/api-keys route) can revoke it.
//
// Auth: portal session (getPortalSessionAccess). The partner_id is
// stamped from the session — never trusted from the body.

/** Permissions stamped on every marketplace API key. */
const MARKETPLACE_KEY_PERMISSIONS = ["marketplace:read"];

async function _get(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const store = await getStore();
    // listApiKeys is tenant-scoped; we filter to the caller's partner_id
    // in JS so the response only contains the partner's keys. (The
    // api_keys table gained a `partner_id` column in migration 053;
    // pre-Phase-12 keys have NULL partner_id and are tenant-admin
    // keys — those are NOT surfaced here.)
    const all = await store.listApiKeys(access.tenant_id);
    const mine = all.filter((k: any) => k.partner_id === access.partner_id);
    return NextResponse.json({
      items: mine.map(({ key_hash, ...k }: any) => k),
    });
  } catch (e: any) {
    console.error("[marketplace.api-keys.list]", e);
    return NextResponse.json({ error: "Failed to load API keys." }, { status: 500 });
  }
}

async function _post(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate required name field. We don't trust caller-supplied
  // permissions — they're stamped to ['marketplace:read'] regardless of
  // what the body says. This is the security boundary that keeps a
  // partner from minting an `offers:*` key via this route.
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }
  if (body.name.length > 200) {
    return NextResponse.json({ error: "Name is too long (max 200 chars)." }, { status: 400 });
  }

  // Generate the raw key string. Same format as the tenant-level route
  // (`asp_<24-byte hex>`). The prefix + hash are stored so future auth
  // lookups can find the row by prefix first (indexed) then verify the
  // hash.
  const raw = "asp_" + randomBytes(24).toString("hex");
  const key_prefix = raw.slice(0, 12);
  const key_hash = createHash("sha256").update(raw).digest("hex");

  // Optional expiry (ISO date string). Partners can mint short-lived
  // keys for testing without leaving a permanent credential around.
  let expires_at: string | null = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "Invalid expires_at — must be ISO 8601." }, { status: 400 });
    }
    if (d.getTime() <= Date.now()) {
      return NextResponse.json({ error: "expires_at must be in the future." }, { status: 400 });
    }
    expires_at = d.toISOString();
  }

  try {
    const store = await getStore();
    const created = await store.upsertApiKey({
      tenant_id: access.tenant_id,
      partner_id: access.partner_id, // Phase 12 — new column (migration 053)
      name: body.name.trim(),
      key_prefix,
      key_hash,
      permissions: MARKETPLACE_KEY_PERMISSIONS,
      active: true,
      expires_at,
    } as any);

    // Audit the creation. The partner's portal access row holds the
    // email + tenant — same convention as every other marketplace route.
    try {
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.api_key_created",
        "api_key",
        created.id,
        { name: created.name, partner_id: access.partner_id, permissions: MARKETPLACE_KEY_PERMISSIONS },
      );
    } catch (e) {
      console.error("[marketplace.api-keys.create] audit failed:", e);
    }

    // Fire-and-forget webhook so partners can monitor key issuance
    // (e.g. alert if a new key was created outside business hours).
    void triggerWebhooks(
      store,
      access.tenant_id,
      "marketplace.api_key_created",
      "api_key",
      created.id,
      {
        name: created.name,
        partner_id: access.partner_id,
        permissions: MARKETPLACE_KEY_PERMISSIONS,
        key_prefix,
      },
    ).catch(() => {});

    // Return the full raw key ONCE. The hashed form is what's stored;
    // the raw is unrecoverable from the hash.
    const { key_hash: _kh, ...safe } = created as any;
    void _kh;
    return NextResponse.json({ ...safe, full_key: raw });
  } catch (e: any) {
    console.error("[marketplace.api-keys.create]", e);
    return NextResponse.json({ error: e.message || "Failed to create API key." }, { status: 500 });
  }
}

async function _delete(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query param is required." }, { status: 400 });
  }

  try {
    const store = await getStore();
    // Verify the key belongs to the caller's tenant + partner. We
    // listApiKeys (tenant-scoped) and find by id, then check partner_id
    // matches the caller — same pattern as the existing
    // /api/api-keys/[id] DELETE route, plus the partner_id check.
    const all = await store.listApiKeys(access.tenant_id);
    const key = all.find((k: any) => k.id === id);
    if (!key) {
      return NextResponse.json({ error: "API key not found." }, { status: 404 });
    }
    if ((key as any).partner_id !== access.partner_id) {
      // Key belongs to a different partner (or is a tenant-admin key
      // with no partner binding) — return 404 to avoid leaking its
      // existence to a sibling partner.
      return NextResponse.json({ error: "API key not found." }, { status: 404 });
    }

    await store.deleteApiKey(id);
    try {
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.api_key_revoked",
        "api_key",
        id,
        { name: key.name },
      );
    } catch (e) {
      console.error("[marketplace.api-keys.delete] audit failed:", e);
    }

    // Fire-and-forget webhook.
    void triggerWebhooks(
      store,
      access.tenant_id,
      "marketplace.api_key_revoked",
      "api_key",
      id,
      { name: key.name, partner_id: access.partner_id },
    ).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[marketplace.api-keys.delete]", e);
    return NextResponse.json({ error: e.message || "Failed to revoke API key." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/api-keys");
export const POST = withApm(_post, "POST /api/marketplace/api-keys");
export const DELETE = withApm(_delete, "DELETE /api/marketplace/api-keys");
