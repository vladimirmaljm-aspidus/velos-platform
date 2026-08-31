import { NextResponse } from "next/server";
import { requireSuperAdmin, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// Super-admin: list all users across all tenants
export async function GET() {
  try {
    const auth = await requireSuperAdmin();
    if (auth instanceof NextResponse) return auth;
    const users = await auth.store.listUsers("");
    // strip hashes
    const safe = users.map(({ password_hash, totp_secret, ...u }) => u);
    return NextResponse.json({ items: safe });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error)}, { status: 500 });
  }
}
