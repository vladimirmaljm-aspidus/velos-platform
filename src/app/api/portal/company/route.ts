import { NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import { getStore } from "@/lib/data/store";
import { sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Portal: view tenant (company) info
export async function GET() {
  try {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!access.can_view_company_info) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const store = await getStore();
  const tenant = await store.getTenant(access.tenant_id);
  return NextResponse.json({ tenant });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
