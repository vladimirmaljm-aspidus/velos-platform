import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api/helpers";
import { COUNTRIES } from "@/lib/data/geo/countries";

export const runtime = "nodejs";

/**
 * GET /api/integrations/countries
 *
 * Returns all countries from our embedded database.
 * No external API dependency — always works, always fast.
 *
 * Each country includes:
 *   - ISO alpha-2 code (RS, AE, US, ...)
 *   - ISO alpha-3 code (SRB, ARE, USA, ...)
 *   - Name, official name
 *   - Flag emoji
 *   - Currency (code, name, symbol)
 *   - Capital
 *   - Phone calling code
 *   - Region, subregion
 *   - 15+ major cities
 */

export async function GET() {
  try {
    const auth = await requireAuth();
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json({
      items: COUNTRIES,
      total: COUNTRIES.length,
      source: "embedded",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
