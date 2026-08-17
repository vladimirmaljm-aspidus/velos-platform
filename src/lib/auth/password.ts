import bcrypt from "bcryptjs";

/**
 * Verifies a password against a stored hash.
 * Handles both mock hashes (prefixed "mock$") and real bcrypt hashes.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (hash.startsWith("mock$")) {
    return Buffer.from(plain).toString("base64") === hash.slice(5);
  }
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
