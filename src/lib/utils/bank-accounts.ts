/**
 * Tenant bank-account parsing/normalization.
 *
 * AUDIT19 (dedup #11) — the tenant `bank_accounts` JSONB column is parsed
 * and camelCase↔snake_case-normalized in TWO places that had drifted:
 * offers-view.tsx (interface + parseTenantBankAccounts + formatter) and
 * bank-account-selector.tsx (a narrower interface + an inline JSON.parse
 * fallback in useMemo). Adding a bank field previously had to be done
 * twice or the PDF bank block and the selector disagreed.
 *
 * This module is the single owner of the shape + parse. Both components
 * import it (client-safe: no dependencies).
 */

export interface TenantBankAccount {
  bankName?: string;
  bank_name?: string;
  accountNumber?: string;
  account_number?: string;
  swiftCode?: string;
  swift_code?: string;
  iban?: string;
  currency?: string;
  holder?: string;
  account_holder?: string;
  // migration 105 — the account holder (naziv korisnika računa) shown as
  // the first row of the PDF's Bank Details card. `holder` above stays for
  // legacy rows; editors now write accountHolder (camelCase, matching
  // bankName/swiftCode).
  accountHolder?: string;
  /** Optional bank branch address — rendered as a "Bank Address" row. */
  bankAddress?: string;
  bank_address?: string;
}

/**
 * Parse the tenant `bank_accounts` column (JSONB stored as a JSON string,
 * an already-parsed array, or null) into a TenantBankAccount[].
 * Resilient to legacy data: non-array JSON and malformed strings → [].
 */
export function parseTenantBankAccounts(
  raw: string | TenantBankAccount[] | null | undefined,
): TenantBankAccount[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as TenantBankAccount[];
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TenantBankAccount[]) : [];
  } catch {
    return [];
  }
}

/**
 * Format a single bank account as the multi-line string saved into the
 * offer's `bank_details` column. The PDF renders this verbatim.
 * migration 105: the account holder leads (naziv korisnika računa) and the
 * bank address (when present) closes.
 */
export function formatBankDetailsForOffer(acct: TenantBankAccount): string {
  const bankName = acct.bankName || acct.bank_name || "";
  const accountNumber = acct.accountNumber || acct.account_number || acct.iban || "";
  const swift = acct.swiftCode || acct.swift_code || "";
  const holder = acct.accountHolder || acct.holder || acct.account_holder || "";
  const currency = acct.currency || "";
  const bankAddress = acct.bankAddress || acct.bank_address || "";
  const lines: string[] = [];
  if (bankName) lines.push(bankName);
  if (holder) lines.push(`Account holder: ${holder}`);
  if (accountNumber) lines.push(`Account: ${accountNumber}`);
  if (swift) lines.push(`SWIFT: ${swift}`);
  if (currency) lines.push(`Currency: ${currency}`);
  if (bankAddress) lines.push(`Bank address: ${bankAddress}`);
  return lines.join("\n");
}
