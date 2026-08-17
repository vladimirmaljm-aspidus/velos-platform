import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (document-register.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "document-register.read"); if (_d) return _d; } /* requirePermission wired */
  const tid = auth.tenantId!;
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || undefined;
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const result = await auth.store.listDocumentRegister(tid, { search, filters: { type, status } });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (document-register.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-register.create"); if (_d) return _d; } /* requirePermission wired */
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  body.tenant_id = auth.tenantId!;
  if (!body.created_by) body.created_by = auth.user.id;
  const created = await auth.store.upsertDocumentRegisterEntry(body);
  await audit(auth.store, auth.user, req, body.id ? "document.register.update" : "document.register.create", "document_register", created.id, { number: created.number });
  return NextResponse.json(created);
}
