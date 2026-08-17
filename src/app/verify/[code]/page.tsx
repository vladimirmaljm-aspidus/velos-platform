import { getStore } from "@/lib/data/store";
import { getSupabase } from "@/lib/supabase/client";
import type { DocumentVerification } from "@/lib/supabase/types";
import { cipherName } from "@/lib/utils/name-cipher";
import { VerifyClient } from "@/components/verify/verify-client";

export const dynamic = "force-dynamic";

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  // CRITICAL FIX (audit P0-1/D-1): Do NOT pass the full verification object
  // as a prop to the Client Component. The RSC payload that ships in the
  // initial HTML would contain document_number, issued_at, etc. BEFORE any
  // client-side GPS check runs — defeating the GPS gate entirely.
  //
  // Instead, pass only a masked preview (document_type + whether it exists).
  // The client component will fetch the full payload via /api/verify/[code]?gps=1
  // AFTER the user shares GPS.
  let exists = false;
  let documentType: string | null = null;
  let cipheredRecipient = "—";

  try {
    const store = await getStore();
    const v = await store.getDocumentVerificationByCode(code);
    if (v) {
      exists = true;
      documentType = v.document_type;
      // Fetch partner name and cipher it for display
      if (v.issued_to_partner_id) {
        try {
          const sb = getSupabase();
          const { data: partner } = await sb
            .from("partners")
            .select("name")
            .eq("id", v.issued_to_partner_id)
            .maybeSingle();
          if (partner?.name) {
            cipheredRecipient = cipherName(partner.name);
          }
        } catch {
          // Non-fatal — cipher stays "—"
        }
      }
    }
  } catch (err) {
    console.warn("[VerifyPage] Error during verification lookup:", err);
  }

  return (
    <VerifyClient
      code={code}
      exists={exists}
      documentType={documentType}
      cipheredRecipient={cipheredRecipient}
    />
  );
}
