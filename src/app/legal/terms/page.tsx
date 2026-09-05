import type { Metadata } from "next";
import { LegalShell } from "@/components/legal/legal-document";
import { TermsOfService, TOS_SECTIONS } from "@/components/legal/terms-of-service";
import { TERMS_OF_SERVICE } from "@/components/legal/legal-meta";

export const metadata: Metadata = {
  title: "Terms of Service — VELOS",
  description:
    "The legal terms governing use of the VELOS trade-management platform, including trial, subscriptions, acceptable use, sanctions compliance, liability and dispute resolution.",
  robots: { index: true, follow: true },
};

/**
 * /legal/terms — the authoritative VELOS Terms of Service.
 *
 * Public, deep-linkable, printable, and referenced from the registration
 * consent checkbox (the exact version the user accepts is pinned in the
 * audit trail by /api/auth/register — see legal-meta.ts).
 */
export default function TermsPage() {
  return (
    <LegalShell meta={TERMS_OF_SERVICE} toc={TOS_SECTIONS}>
      <TermsOfService />
    </LegalShell>
  );
}
