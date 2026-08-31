import { NextRequest, NextResponse } from "next/server";
import { requireAuth, sanitizeError } from "@/lib/api/helpers";
import { validateIBAN, lookupBankByIBAN, getAccountHolderType, getRequiredKycDocuments } from "@/lib/banking/iban";

export const runtime = "nodejs";

/**
 * POST /api/banking/validate-iban
 * Body: { iban: "RS35260005601001611239" }
 *
 * Returns:
 *   {
 *     valid: boolean,
 *     country: "RS",
 *     bankCode: "260",
 *     bankName: "Banca Intesa",
 *     swift: "DBRSRSBG",
 *     bic: "DBRSRSBG",
 *     sepa: false,
 *     formatted: "RS35 2600 0560 1001 6112 39"
 *   }
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.create)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.read"); if (_d) return _d; } /* requirePermission wired */
    // Feature gate (module_finance)
    { const { requireFeature } = await import("@/lib/api/feature-guard");
      const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


    let body: { iban?: string; entity_type?: string } = {};
    try { body = await req.json(); } catch { /* ok */ }

    const iban = (body.iban || "").trim();
    if (!iban) {
      return NextResponse.json({ error: "IBAN is required." }, { status: 400 });
    }

    const result = validateIBAN(iban);
    const bankInfo = lookupBankByIBAN(iban);

    const holderType = body.entity_type ? getAccountHolderType(body.entity_type) : undefined;
    const requiredDocs = body.entity_type ? getRequiredKycDocuments(body.entity_type) : undefined;

    return NextResponse.json({
      valid: result.valid,
      country: result.country,
      bankCode: result.bankCode,
      branchCode: result.branchCode,
      accountNumber: result.accountNumber,
      formatted: result.formatted,
      bankName: bankInfo?.bankName || "",
      swift: bankInfo?.swift || "",
      bic: bankInfo?.bic || "",
      sepa: bankInfo?.sepa || false,
      accountHolderType: holderType,
      requiredDocuments: requiredDocs,
    });
  } catch (e: any) {
    console.error("[banking.validate-iban.POST]", e);
    return NextResponse.json({ error: sanitizeError(e)}, { status: 500 });
  }
}
