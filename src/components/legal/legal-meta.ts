/**
 * VELOS legal document metadata — the single source of truth for the
 * documents' identity (version, effective date, operator details).
 *
 * Why a single module:
 * 1. The register flow pins the EXACT version the user accepted into the
 *    audit trail ("legal.consent" entries) — importing the constant here
 *    guarantees the recorded version always matches the published
 *    document, even after future amendments.
 * 2. The /legal/terms and /legal/privacy pages render the same values,
 *    so the document header, the API check, and the consent record can
 *    never drift apart.
 *
 * When amending either document: bump the version, update the effective
 * date, and (if the change is material) re-consent existing tenants via
 * a notice banner. The audit trail keeps every historical version.
 */

// ── Operator / controller identity ─────────────────────────────────────────
// The platform operates under a DMCC licence. Update the registered-office
// line if the licence address changes (DMCC re-issues unit numbers on
// relocation, so this lives in ONE place).
export const LEGAL_OPERATOR = {
  legalEntity: "ASPIDUS DMCC",
  tradingName: "VELOS",
  registeredOffice: "Dubai Multi Commodities Centre (DMCC), Dubai, United Arab Emirates",
  jurisdiction: "Dubai, United Arab Emirates",
  // Dedicated mailboxes for data-protection and legal notices. TODO: point
  // these at the live mailboxes once DNS/MX is configured for the domain.
  contactEmail: "legal@aspidus.ae",
  privacyEmail: "privacy@aspidus.ae",
} as const;

// ── Document identity ──────────────────────────────────────────────────────
export const TERMS_OF_SERVICE = {
  title: "Terms of Service",
  ref: "VELOS-LEGAL-TOS",
  version: "1.0",
  effectiveDate: "2026-09-05",
  effectiveDateLabel: "5 September 2026",
} as const;

export const PRIVACY_POLICY = {
  title: "Privacy Policy",
  ref: "VELOS-LEGAL-PRIV",
  version: "1.0",
  effectiveDate: "2026-09-05",
  effectiveDateLabel: "5 September 2026",
} as const;

// The trial terms the registration flow references (must match the
// TRIAL_DAYS constant in /api/auth/register and the approval route).
export const TRIAL_TERMS = {
  days: 14,
  startsOnApproval: true,
  requiresApproval: true,
  maxUsers: 5,
} as const;
