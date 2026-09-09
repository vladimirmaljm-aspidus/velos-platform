// E2E helper — bcrypt hash for portal test users (cost 12).
// NOTE (lesson from previous sessions): `bunx -e` silently fails for
// bcrypt — MUST be a script file run via `bun run`.
import bcrypt from "bcryptjs";

const pw = process.argv[2] || "E2E-Wf-102!x";
const hash = await bcrypt.hash(pw, 12);
console.log(hash);
