import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit } from "@/lib/api/helpers";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "document-register.update"); if (_d) return _d; }
  if (!auth.tenantId) return NextResponse.json({ error: "Tenant context required." }, { status: 400 });
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  body.tenant_id = auth.tenantId;
  if (!body.created_by) body.created_by = auth.user.id;
  const created = await auth.store.addDocumentRevision(body);
  await audit(auth.store, auth.user, req, "document.revision.create", "document_revision", created.id, {
    document_id: created.document_id,
    version: created.version,
  });
  return NextResponse.json(created);
}
