/**
 * Forge a session JWT for local E2E testing against the production DB.
 * Usage: bun --env-file=.env.local scripts/forge-session.ts <id> <username> <role> <tenant_id|-> <token_version> [out.txt]
 * Output: the raw JWT on stdout (and written to the optional file).
 */
import { SignJWT } from "jose";

const [id, username, role, tenantArg, tvArg, outFile] = process.argv.slice(2);
if (!id || !username || !role || !tvArg) {
  console.error("usage: forge-session.ts <id> <username> <role> <tenant_id|-> <token_version> [out.txt]");
  process.exit(1);
}
const tenant_id = tenantArg && tenantArg !== "-" ? tenantArg : null;
const token_version = Number(tvArg);

const secret = process.env.JWT_SECRET_KEY || process.env.SECRET_KEY;
if (!secret || secret.length < 32) throw new Error("JWT_SECRET_KEY missing/short");

// super_admin gets a far-future absolute expiry (requireAuth exempts the
// TTL/idle checks for super_admin anyway); everyone else gets 8h.
const isSA = role === "super_admin";
const now = Date.now();
const expires_at = isSA ? now + 100 * 365 * 24 * 60 * 60 * 1000 : now + 8 * 60 * 60 * 1000;

const token = await new SignJWT({
  sub: id,
  username,
  role,
  token_version,
  tenant_id,
  expires_at,
  last_activity_at: now,
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("7d")
  .sign(new TextEncoder().encode(secret));

if (outFile) await Bun.write(outFile, token);
console.log(token);
