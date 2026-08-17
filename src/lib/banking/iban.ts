/**
 * IBAN validation + bank lookup utilities.
 *
 * - validateIBAN(iban) → checks checksum + structure
 * - ibanCountry(iban) → extracts ISO country code
 * - extractBankCode(iban) → extracts the bank identifier from the IBAN
 * - lookupBankByIBAN(iban) → returns bank name + suggested SWIFT/BIC
 *
 * The SWIFT/BIC database is a curated list of major banks per country.
 * It's not exhaustive — if we can't find a match, we return the bank code
 * from the IBAN so the user can look it up manually.
 */

interface BankInfo {
  bankName: string;
  swift: string;
  bic: string; // same as SWIFT — kept for clarity
  country: string;
  bankCode: string;
  /** Whether the bank is part of the SEPA scheme */
  sepa: boolean;
}

/**
 * Validate an IBAN checksum using the mod-97 algorithm.
 * Returns { valid, country, bankCode, accountNumber }
 */
export function validateIBAN(iban: string): {
  valid: boolean;
  country: string;
  bankCode: string;
  branchCode: string;
  accountNumber: string;
  formatted: string;
} {
  const clean = iban.replace(/\s/g, "").toUpperCase();
  const empty = { valid: false, country: "", bankCode: "", branchCode: "", accountNumber: "", formatted: clean };

  if (!clean || clean.length < 15) return empty;

  const country = clean.substring(0, 2);

  // IBAN structure per country — bank code length varies
  const structures: Record<string, { bankLen: number; branchLen: number; total: number }> = {
    AD: { bankLen: 4, branchLen: 4, total: 24 }, // Andorra
    AT: { bankLen: 5, branchLen: 0, total: 20 }, // Austria
    BE: { bankLen: 3, branchLen: 0, total: 16 }, // Belgium
    BA: { bankLen: 3, branchLen: 3, total: 20 }, // Bosnia
    BG: { bankLen: 4, branchLen: 4, total: 22 }, // Bulgaria
    HR: { bankLen: 7, branchLen: 0, total: 21 }, // Croatia
    CY: { bankLen: 3, branchLen: 5, total: 28 }, // Cyprus
    CZ: { bankLen: 4, branchLen: 6, total: 24 }, // Czech Republic
    DK: { bankLen: 4, branchLen: 0, total: 18 }, // Denmark
    EE: { bankLen: 2, branchLen: 0, total: 20 }, // Estonia
    FI: { bankLen: 6, branchLen: 0, total: 18 }, // Finland
    FR: { bankLen: 5, branchLen: 5, total: 27 }, // France
    DE: { bankLen: 8, branchLen: 0, total: 22 }, // Germany
    GI: { bankLen: 4, branchLen: 3, total: 23 }, // Gibraltar
    GR: { bankLen: 3, branchLen: 4, total: 27 }, // Greece
    HU: { bankLen: 3, branchLen: 4, total: 28 }, // Hungary
    IS: { bankLen: 2, branchLen: 0, total: 26 }, // Iceland
    IE: { bankLen: 4, branchLen: 6, total: 22 }, // Ireland
    IT: { bankLen: 5, branchLen: 5, total: 27 }, // Italy
    LV: { bankLen: 4, branchLen: 0, total: 21 }, // Latvia
    LI: { bankLen: 5, branchLen: 0, total: 21 }, // Liechtenstein
    LT: { bankLen: 5, branchLen: 0, total: 20 }, // Lithuania
    LU: { bankLen: 3, branchLen: 0, total: 20 }, // Luxembourg
    MT: { bankLen: 4, branchLen: 5, total: 31 }, // Malta
    MC: { bankLen: 5, branchLen: 5, total: 27 }, // Monaco
    NL: { bankLen: 4, branchLen: 0, total: 18 }, // Netherlands
    NO: { bankLen: 4, branchLen: 0, total: 15 }, // Norway
    PL: { bankLen: 3, branchLen: 0, total: 28 }, // Poland
    PT: { bankLen: 4, branchLen: 4, total: 25 }, // Portugal
    RO: { bankLen: 4, branchLen: 0, total: 24 }, // Romania
    SM: { bankLen: 5, branchLen: 5, total: 27 }, // San Marino
    RS: { bankLen: 3, branchLen: 0, total: 22 }, // Serbia
    SK: { bankLen: 4, branchLen: 0, total: 24 }, // Slovakia
    SI: { bankLen: 2, branchLen: 3, total: 19 }, // Slovenia
    ES: { bankLen: 4, branchLen: 4, total: 24 }, // Spain
    SE: { bankLen: 3, branchLen: 0, total: 24 }, // Sweden
    CH: { bankLen: 5, branchLen: 0, total: 21 }, // Switzerland
    TR: { bankLen: 5, branchLen: 0, total: 26 }, // Turkey
    GB: { bankLen: 4, branchLen: 6, total: 22 }, // United Kingdom
    AE: { bankLen: 3, branchLen: 0, total: 23 }, // UAE
    SA: { bankLen: 2, branchLen: 0, total: 24 }, // Saudi Arabia
  };

  const struct = structures[country];
  if (!struct) {
    // Unknown country — can't validate structure but can still check checksum
    const checksumOk = checkIBANChecksum(clean);
    return { ...empty, valid: checksumOk, country };
  }

  if (clean.length !== struct.total) {
    return { ...empty, valid: false, country };
  }

  const bankCode = clean.substring(4, 4 + struct.bankLen);
  const branchCode = struct.branchLen > 0
    ? clean.substring(4 + struct.bankLen, 4 + struct.bankLen + struct.branchLen)
    : "";
  const accountNumber = clean.substring(4 + struct.bankLen + struct.branchLen);

  const valid = checkIBANChecksum(clean);

  // Format with spaces every 4 chars for display
  const formatted = clean.replace(/(.{4})/g, "$1 ").trim();

  return { valid, country, bankCode, branchCode, accountNumber, formatted };
}

/** Mod-97 checksum validation */
function checkIBANChecksum(iban: string): boolean {
  // Move first 4 chars to end
  const rearranged = iban.substring(4) + iban.substring(0, 4);
  // Convert letters to numbers (A=10, B=11, ...)
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  // Calculate mod 97
  let remainder = 0;
  for (let i = 0; i < numeric.length; i++) {
    remainder = (remainder * 10 + parseInt(numeric[i], 10)) % 97;
  }
  return remainder === 1;
}

/**
 * Curated database of major banks by country + bank code prefix.
 * Used to suggest bank name + SWIFT/BIC from an IBAN.
 */
const BANK_DATABASE: Record<string, Array<{ code: string; name: string; swift: string; sepa: boolean }>> = {
  RS: [
    { code: "160", name: "Banca Intesa", swift: "DBRSRSBG", sepa: false },
    { code: "170", name: "UniCredit Bank Serbia", swift: "BACXRSBG", sepa: false },
    { code: "190", name: "Raiffeisen Bank Serbia", swift: "RZBSRSBG", sepa: false },
    { code: "205", name: "Komercijalna Banka", swift: "KOBBRSBG", sepa: false },
    { code: "220", name: "OTP Bank Serbia", swift: "OTPVRSBG", sepa: false },
    { code: "265", name: "Halkbank", swift: "HALKRSBG", sepa: false },
    { code: "275", name: "Societe Generale Bank", swift: "SOGBRSBG", sepa: false },
    { code: "285", name: "AIK Banka", swift: "AIKBRSBG", sepa: false },
    { code: "295", name: "ProCredit Bank", swift: "PRCBRSBG", sepa: false },
    { code: "320", name: "Erste Bank", swift: "GIBARSBG", sepa: false },
    { code: "340", name: "Postanska Stedionica", swift: "POSBRSBG", sepa: false },
  ],
  AE: [
    { code: "021", name: "Emirates NBD", swift: "EBILAEAD", sepa: false },
    { code: "023", name: "Abu Dhabi Commercial Bank", swift: "ADCBAEAA", sepa: false },
    { code: "024", name: "Abu Dhabi Islamic Bank", swift: "ABUBAEAD", sepa: false },
    { code: "026", name: "Dubai Islamic Bank", swift: "DIBLAEAD", sepa: false },
    { code: "027", name: "Mashreq Bank", swift: "BOMLAEAD", sepa: false },
    { code: "031", name: "First Abu Dhabi Bank (FAB)", swift: "NBADAEAA", sepa: false },
    { code: "033", name: "Standard Chartered", swift: "SCBLAEAD", sepa: false },
    { code: "040", name: "HSBC Middle East", swift: "BBMEAEAD", sepa: false },
    { code: "042", name: "Citibank", swift: "CITIAEAD", sepa: false },
    { code: "046", name: "Commercial Bank of Dubai", swift: "CBDUAEAD", sepa: false },
  ],
  DE: [
    { code: "50010517", name: "ING-DiBa", swift: "INGDDEFFXXX", sepa: true },
    { code: "50070010", name: "Deutsche Bank", swift: "DEUTDEFFXXX", sepa: true },
    { code: "70020270", name: "Commerzbank", swift: "COBADEFFXXX", sepa: true },
    { code: "70080000", name: "DZ Bank", swift: "GENODEFFXXX", sepa: true },
    { code: "10000000", name: "Bundesbank", swift: "MARKDEF1000", sepa: true },
    { code: "37040044", name: "Commerzbank Köln", swift: "COBADEFF370", sepa: true },
    { code: "70150000", name: "Stadtsparkasse München", swift: "SSKMDEMMXXX", sepa: true },
  ],
  GB: [
    { code: "BARC", name: "Barclays", swift: "BARCGB22XXX", sepa: false },
    { code: "HSBC", name: "HSBC UK", swift: "HBUKGB4BXXX", sepa: false },
    { code: "MIDL", name: "HSBC (formerly Midland)", swift: "MIDLGB22XXX", sepa: false },
    { code: "NATW", name: "NatWest", swift: "NWBKGB2LXXX", sepa: false },
    { code: "LOYD", name: "Lloyds Bank", swift: "LOYDGB2LXXX", sepa: false },
    { code: "CPBK", name: "Co-operative Bank", swift: "CPBKGB22XXX", sepa: false },
    { code: "SBIC", name: "Santander UK", swift: "ABBEGB2LXXX", sepa: false },
  ],
  FR: [
    { code: "30002", name: "BNP Paribas", swift: "BNPAFRPPXXX", sepa: true },
    { code: "30004", name: "BNP Paribas (ex-Banque Nationale de Paris)", swift: "BNPAFRPPXXX", sepa: true },
    { code: "30027", name: "Société Générale", swift: "SOGEFRPPXXX", sepa: true },
    { code: "10057", name: "Banque Populaire", swift: "CCBPFRPPXXX", sepa: true },
    { code: "18719", name: "Crédit Mutuel", swift: "CMCIFR2AXXX", sepa: true },
    { code: "20041", name: "Banque Populaire Val de France", swift: "CCBPFRPPXXX", sepa: true },
  ],
  IT: [
    { code: "01000", name: "UniCredit Banca", swift: "UNCRITMMXXX", sepa: true },
    { code: "01005", name: "Intesa Sanpaolo", swift: "BCITITMMXXX", sepa: true },
    { code: "02008", name: "Banca Nazionale del Lavoro", swift: "BNLIITRRXXX", sepa: true },
    { code: "03175", name: "Banca Monte dei Paschi di Siena", swift: "PASCITMMXXX", sepa: true },
    { code: "05387", name: "Banca Popolare di Sondrio", swift: "POSOIT22XXX", sepa: true },
    { code: "03230", name: "Banco BPM", swift: "MEDIITMMXXX", sepa: true },
  ],
  NL: [
    { code: "ABNA", name: "ABN AMRO", swift: "ABNANL2AXXX", sepa: true },
    { code: "INGB", name: "ING Bank", swift: "INGBNL2AXXX", sepa: true },
    { code: "RABO", name: "Rabobank", swift: "RABONL2UXXX", sepa: true },
    { code: "SNSB", name: "SNS Bank", swift: "SNSBNL2AXXX", sepa: true },
    { code: "ASNB", name: "ASN Bank", swift: "ASNBNL21XXX", sepa: true },
    { code: "KNAB", name: "Knab Bank", swift: "KNABNL2HXXX", sepa: true },
  ],
  CH: [
    { code: "00729", name: "UBS Switzerland", swift: "UBSWCHZH80A", sepa: false },
    { code: "00763", name: "Credit Suisse", swift: "CRESCHZZ80A", sepa: false },
    { code: "00787", name: "Zürcher Kantonalbank", swift: "ZKBKCHZZ80A", sepa: false },
    { code: "09000", name: "PostFinance", swift: "POFICHBEXXX", sepa: true },
  ],
  TR: [
    { code: "00046", name: "İş Bankası (İşbank)", swift: "ISBKTRISXXX", sepa: false },
    { code: "00012", name: "Türkiye Garanti Bankası", swift: "TGBATRISXXX", sepa: false },
    { code: "00134", name: "Ziraat Bankası", swift: "TCZBTR2AXXX", sepa: false },
    { code: "00135", name: "Akbank", swift: "AKBKTRISXXX", sepa: false },
    { code: "00146", name: "Yapı Kredi Bankası", swift: "YAPITRISXXX", sepa: false },
    { code: "00152", name: "VakıfBank", swift: "TVBTRISAXXX", sepa: false },
    { code: "00111", name: "Halkbank", swift: "HLBKTRISAXXX", sepa: false },
  ],
  SA: [
    { code: "10", name: "National Commercial Bank (NCB)", swift: "NCBKSAJE", sepa: false },
    { code: "20", name: "Samba Financial Group", swift: "SAMBSARI", sepa: false },
    { code: "40", name: "Saudi British Bank (SABB)", swift: "SABBSARI", sepa: false },
    { code: "80", name: "Al Rajhi Bank", swift: "RJHISARI", sepa: false },
    { code: "45", name: "Riyad Bank", swift: "RIBLSARI", sepa: false },
    { code: "70", name: "Alinma Bank", swift: "ALMASARI", sepa: false },
  ],
};

/** SEPA countries (Single Euro Payments Area) */
const SEPA_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GI",
  "GR", "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "MC", "NL",
  "NO", "PL", "PT", "RO", "SM", "SK", "SI", "ES", "SE", "CH", "GB",
]);

/**
 * Look up bank information from an IBAN.
 * Returns bank name + suggested SWIFT/BIC if found in the database.
 */
export function lookupBankByIBAN(iban: string): BankInfo | null {
  const { valid, country, bankCode } = validateIBAN(iban);
  if (!country) return null;

  const banks = BANK_DATABASE[country];
  if (!banks) {
    return {
      bankName: "",
      swift: "",
      bic: "",
      country,
      bankCode,
      sepa: SEPA_COUNTRIES.has(country),
    };
  }

  // Try exact match on bank code
  const match = banks.find((b) => bankCode.startsWith(b.code) || b.code.startsWith(bankCode));

  if (match) {
    return {
      bankName: match.name,
      swift: match.swift,
      bic: match.swift,
      country,
      bankCode: match.code,
      sepa: match.sepa,
    };
  }

  // No match — return what we have
  return {
    bankName: "",
    swift: "",
    bic: "",
    country,
    bankCode,
    sepa: SEPA_COUNTRIES.has(country),
  };
}

/**
 * Detect account holder type from KYC entity_type.
 * "individual" → personal account (no trade license needed)
 * "company" → corporate account (trade license required)
 */
export function getAccountHolderType(entityType: string): "personal" | "corporate" {
  return entityType === "individual" ? "personal" : "corporate";
}

/**
 * Required KYC documents based on entity type.
 * Individuals: passport/ID only.
 * Companies: trade license, registration, tax certificate, etc.
 */
export function getRequiredKycDocuments(entityType: string): string[] {
  if (entityType === "individual") {
    return ["passport", "id_card"]; // personal — passport or ID card
  }
  // Company
  return [
    "trade_license",
    "company_registration",
    "tax_certificate",
    "vat_certificate",
    "bank_statement",
    "beneficial_owner_declaration",
  ];
}
