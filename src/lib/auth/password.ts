import bcrypt from "bcryptjs";

/**
 * Verifies a password against a stored hash.
 * Handles both mock hashes (prefixed "mock$") and real bcrypt hashes.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (hash.startsWith("mock$")) {
    // SEC-M2: `mock$`-prefixed hashes are base64 (non-constant-time) and
    // only ever exist in dev/test seeds. Production must reject them so
    // a leaked dev DB dump or a stray `mock$` row can't authenticate a
    // real attacker who knows the base64-decoding trick.
    if (process.env.NODE_ENV === "production") return false;
    return Buffer.from(plain).toString("base64") === hash.slice(5);
  }
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  // SEC-M1: OWASP/NIST recommends bcrypt cost ≥ 12. The extra ~150ms per
  // login is negligible for a B2B SaaS and meaningfully raises the cost
  // of an offline brute-force run if the hash column is ever leaked.
  return bcrypt.hash(plain, 12);
}
