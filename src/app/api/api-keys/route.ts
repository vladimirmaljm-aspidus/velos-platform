import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, audit } from "@/lib/api/helpers";
import { randomBytes, createHash } from "crypto";

export const runtime = "nodejs";

/** List all API keys for the current tenant */
export async function GET() {
  const auth = await requireAdmin();
  if (auth instanceof NextResponse) return auth;
    // Permission gate (api-keys.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "api-keys.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_api_keys)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_api_keys", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  const tid = auth.tenantId!;
  const keys = await auth.store.listApiKeys(tid);
  // strip key_hash
  return NextResponse.json({ items: keys.map(({ key_hash, ...k }) => k) });
}

/** Create a new API key */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (api-keys.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "api-keys.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_api_keys)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_api_keys", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate required fields
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }

  body.tenant_id = auth.tenantId!;

  // Parse permissions
  let permissions: string[] = [];
  if (body.permissions) {
    if (typeof body.permissions === "string") {
      permissions = body.permissions.split(",").map((s: string) => s.trim()).filter(Boolean);
    } else if (Array.isArray(body.permissions)) {
      permissions = body.permissions;
    }
  }
  body.permissions = permissions;

  // Generate a real key
  const raw = "asp_" + randomBytes(24).toString("hex");
  body.key_prefix = raw.slice(0, 12);
  body.key_hash = createHash("sha256").update(raw).digest("hex");
  body.active = true;

  // Set expiration if provided
  if (body.expires_at) {
    body.expires_at = new Date(body.expires_at).toISOString();
  }

  // Remove id if not provided (force create, not update)
  delete body.id;

  const created = await auth.store.upsertApiKey(body);
  await audit(auth.store, auth.user, req, "api_key.create", "api_key", created.id, { name: created.name });

  const { key_hash, ...safe } = created;
  // return full key only on create
  const response: Record<string, unknown> = { ...safe, full_key: raw };
  return NextResponse.json(response);
}
