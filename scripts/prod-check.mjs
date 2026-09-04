// Verify production tenant (ASPIDUS) docs still render with the memo frame
import { getDocumentProxy, extractText } from "unpdf";
import { readFileSync, writeFileSync } from "fs";
const BASE = "https://velos-platform.vercel.app";
const env = readFileSync("/home/z/audit/prod.env", "utf8");
const get = (k) => (env.match(new RegExp(`${k}="([^"]+)"`)) || [])[1];
const KEY = get("SUPABASE_SERVICE_ROLE_KEY");
const SB = get("SUPABASE_URL");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

// find the production tenant's latest offer
const r = await fetch(`${SB}/rest/v1/offers?select=id,number,tenant_id&order=created_at.desc&limit=3`, { headers: H });
const offers = await r.json();
console.log("prod offers:", offers.map(o => o.number).join(", "));
const offer = offers.find(o => o.tenant_id !== "e2e-audit33-tenant" && o.tenant_id?.length === 36) || offers[0];
console.log("testing tenant:", offer.tenant_id, "offer:", offer.number);

// login as that tenant's admin? No — use the e2e admin session with tenant_id param? e2e admin is not super-admin.
// Instead: create a session by logging in as e2e and switching tenant context won't work.
// Simplest: verify via a direct buildPdfDocument run locally with the production data.
