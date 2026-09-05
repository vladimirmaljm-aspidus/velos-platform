import type { Metadata } from "next";
import { LegalShell } from "@/components/legal/legal-document";
import { PrivacyPolicy, PRIVACY_SECTIONS } from "@/components/legal/privacy-policy";
import { PRIVACY_POLICY } from "@/components/legal/legal-meta";

export const metadata: Metadata = {
  title: "Privacy Policy — VELOS",
  description:
    "How VELOS collects, uses, shares and protects personal data: collected categories, legal bases, processors, transfers, retention, security measures and your rights.",
  robots: { index: true, follow: true },
};

/**
 * /legal/privacy — the authoritative VELOS Privacy Policy.
 *
 * Public, deep-linkable, printable, and referenced from the registration
 * consent checkbox. The document describes only what the platform actually
 * processes (verified against the codebase) — see the header comment of
 * privacy-policy.tsx.
 */
export default function PrivacyPage() {
  return (
    <LegalShell meta={PRIVACY_POLICY} toc={PRIVACY_SECTIONS}>
      <PrivacyPolicy />
    </LegalShell>
  );
}
