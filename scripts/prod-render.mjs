// Local render of a PRODUCTION tenant's latest LOI with its real memo + template (read-only)
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { getDocumentProxy, extractText } from "unpdf";
import { readFileSync, writeFileSync } from "fs";
import { buildPdfDocument } from "./src/lib/pdf/templates.tsx";
import { resolveDocumentTemplate } from "./src/lib/pdf/doc-template.ts";
import { generateQrCodeDataUrl, generateVerificationCode } from "./src/lib/pdf/qr.ts";

const env = readFileSync("/home/z/audit/prod.env", "utf8");
const get = (k) => (env.match(new RegExp(`${k}="([^"]+)"`)) || [])[1];
const SB = get("SUPABASE_URL");
const KEY = get("SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sb = (path) => `${SB}/rest/v1/${path}`;

// 1. Find production tenant with memo row (skip e2e)
const memos = await (await fetch(sb("memorandum_settings?select=tenant_id&limit=10"), { headers: H })).json();
const tenants = await (await fetch(sb("tenants?select=id,name,legal_name&limit=20"), { headers: H })).json();
const prodTenant = tenants.find(t => t.id === "c889572d-d35b-43ec-bca1-a5359d95603d") || tenants.find(t => memos.some(m => m.tenant_id === t.id) && t.id?.length === 36);
console.log("prod tenant:", prodTenant?.id, prodTenant?.name);

// 2. Latest LOI for that tenant
const lois = await (await fetch(sb(`lois?tenant_id=eq.${prodTenant.id}&select=*&order=created_at.desc&limit=1`), { headers: H })).json();
const loi = lois[0];
if (!loi) { console.log("no LOI found — trying offers"); }
const doc = loi || (await (await fetch(sb(`offers?tenant_id=eq.${prodTenant.id}&select=*&order=created_at.desc&limit=1`), { headers: H })).json())[0];
console.log("doc:", doc?.number);

// 3. Partner + tenant full + memo + templates
const partner = doc?.partner_id ? (await (await fetch(sb(`partners?id=eq.${doc.partner_id}&select=*&limit=1`), { headers: H })).json())[0] : null;
const tenant = (await (await fetch(sb(`tenants?id=eq.${prodTenant.id}&select=*&limit=1`), { headers: H })).json())[0];
const memo = (await (await fetch(sb(`memorandum_settings?tenant_id=eq.${prodTenant.id}&select=*&limit=1`), { headers: H })).json())[0];
const templates = await (await fetch(sb(`document_templates?tenant_id=eq.${prodTenant.id}&select=*`), { headers: H })).json();
console.log("memo:", memo ? `qr=${memo.qr_position} pn=${memo.page_number_enabled} left=${memo.footer_left_enabled}` : "none");
console.log("templates:", templates.length);

// 4. Resolve template like the generator does
const docType = loi ? "loi" : "offer";
const tpl = resolveDocumentTemplate({ listDocumentTemplates: async () => templates }, prodTenant.id, docType);
console.log("resolved template:", tpl?.name, tpl?.type);

// 5. Letterhead + seal (if linked)
let letterhead = null, seal = null, sealImageUrl = null;
if (tpl?.letterhead_id) letterhead = (await (await fetch(sb(`tenant_letterheads?id=eq.${tpl.letterhead_id}&select=*&limit=1`), { headers: H })).json())[0];
if (tpl?.seal_id !== null && tpl?.seal_id) { seal = (await (await fetch(sb(`tenant_seals?id=eq.${tpl.seal_id}&select=*&limit=1`), { headers: H })).json())[0]; }
if (seal?.image_url) sealImageUrl = seal.image_url;

// 6. QR
const code = generateVerificationCode(docType, doc.number);
const qr = await generateQrCodeDataUrl(code);

// 7. Render
const el = React.createElement(buildPdfDocument, {
  doc, docType, partner, tenant, memorandumSettings: memo, template: tpl,
  letterhead, verificationCode: code, qrCodeDataUrl: qr,
  logoUrl: letterhead?.logo_url || tenant?.logo_url || null,
  sealImageUrl, seal,
});
const buf = await renderToBuffer(el);
writeFileSync("/home/z/audit/screens/prod-tenant-render.pdf", buf);
const pdf = await getDocumentProxy(new Uint8Array(buf));
const { text } = await extractText(pdf, { mergePages: false });
const all = (text).map(String).join("\n");
const norm = all.replace(/\s+/g, " ");
console.log("PDF bytes:", buf.length, "pages:", pdf.numPages);
console.log("header name:", /ASPIDUS|Velos|VELOS/i.test(norm) ? "found" : "?");
console.log("footer address:", /GoldCrest|Dubai|Belgrade|Beograd/i.test(norm) ? "found (address in footer)" : "no address");
console.log("page numbers:", /Page 1 of \d+/.test(all) ? "yes" : "no");
console.log("QR label:", /Scan to verify/.test(all) ? "yes" : "no");
