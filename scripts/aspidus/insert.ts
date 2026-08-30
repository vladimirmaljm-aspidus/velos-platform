#!/usr/bin/env bun
/**
 * Aspidus DMCC — Product Catalog Insertion Script
 *
 * Usage:
 *   bun scripts/aspidus/insert.ts --dry-run              # validate only, no writes
 *   bun scripts/aspidus/insert.ts --dry-run --category=metals
 *   bun scripts/aspidus/insert.ts                         # real insert (all 333)
 *   bun scripts/aspidus/insert.ts --category=spices       # real insert one category
 *   bun scripts/aspidus/insert.ts --batch=25 --delay=300  # custom batch size + delay ms
 *
 * Env:
 *   ASPIDUS_API_KEY  (default: the provided key)
 *   ASPIDUS_API_URL  (default: https://aspidus.onrender.com)
 */
import { agricultureProducts } from "./cat-agriculture";
import { coffeeProducts } from "./cat-coffee";
import { fertilizerProducts } from "./cat-fertilizers";
import { chemicalProducts } from "./cat-chemicals";
import { metalProducts } from "./cat-metals";
import { oreProducts } from "./cat-ores";
import { spiceProducts } from "./cat-spices";
import { constructionProducts } from "./cat-construction";

interface SeedProduct {
  sku: string; name: string; category: string; unit: string;
  price: number; currency: string; cost: number;
  stock: number; reorder_level: number; active: boolean;
  description: string; hs_code: string;
  brand: null; shelf_life: string | null; image_url: null;
  logistics: { cap20: number | null; cap40: number | null };
  coa_params: { name: string; value: string }[];
  detailed_spec: string; tags: string[];
}

const ALL_PRODUCTS: SeedProduct[] = [
  ...agricultureProducts,
  ...coffeeProducts,
  ...fertilizerProducts,
  ...chemicalProducts,
  ...metalProducts,
  ...oreProducts,
  ...spiceProducts,
  ...constructionProducts,
];

const API_BASE = process.env.ASPIDUS_API_URL || "https://aspidus.onrender.com";
// Audit 2d-F1 fix: removed the hardcoded API key default
// `asp_f1386a...REDACTED` (full key redacted — see git history rev 939791c).
// committed to public git history (rev 939791c, 2026-08-30) and must be
// rotated on the platform. The script now REQUIRES ASPIDUS_API_KEY in the
// env — if unset, it throws immediately with instructions. Generate a new
// key via POST /api/api-keys (as a super_admin) and set it in your .env.
const API_KEY = process.env.ASPIDUS_API_KEY;
if (!API_KEY || API_KEY.length < 20) {
  console.error(
    "[insert] ASPIDUS_API_KEY env var is required (set it to a valid asp_... API key). " +
      "The previous hardcoded default was removed (audit 2d-F1 — credential committed to git history). " +
      "Generate a new key via POST /api/api-keys as a super_admin.",
  );
  process.exit(1);
}

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CATEGORY = (args.find((a) => a.startsWith("--category=")) || "").split("=")[1] || null;
const BATCH_SIZE = parseInt((args.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || "999");
const DELAY_MS = parseInt((args.find((a) => a.startsWith("--delay=")) || "").split("=")[1] || "250");
const LIMIT = parseInt((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || "0");

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmt(n: number) { return n.toLocaleString("en-US"); }

function log(line: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${line}`);
}

function validateProduct(p: SeedProduct, idx: number): string[] {
  const errs: string[] = [];
  if (!p.sku || p.sku.length < 5) errs.push("sku missing/short");
  if (!p.name) errs.push("name missing");
  if (!p.category) errs.push("category missing");
  if (!p.unit) errs.push("unit missing");
  if (typeof p.price !== "number" || p.price <= 0) errs.push(`price invalid (${p.price})`);
  if (!p.currency) errs.push("currency missing");
  if (!p.hs_code || String(p.hs_code).length !== 10) errs.push(`hs_code not 10-digit (${p.hs_code})`);
  if (!p.coa_params || p.coa_params.length < 6) errs.push(`coa_params < 6 (${p.coa_params?.length || 0})`);
  if (!p.detailed_spec || p.detailed_spec.length < 150) errs.push(`detailed_spec too short (${p.detailed_spec?.length || 0})`);
  if (!p.logistics || (p.logistics.cap20 === null && p.logistics.cap40 === null)) errs.push("logistics all null");
  return errs;
}

// ── Fetch existing SKUs to skip duplicates ──────────────────────────────────
async function fetchExistingSkus(): Promise<Set<string>> {
  const skus = new Set<string>();
  let offset = 0;
  for (;;) {
    const url = `${API_BASE}/api/products?limit=200&offset=${offset}`;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` }, signal: ctrl.signal });
    } catch (e) {
      log(`  ⚠ fetch error (continuing with empty set): ${(e as Error).message}`);
      clearTimeout(to);
      return skus;
    }
    clearTimeout(to);
    if (!res.ok) { log(`  ⚠ could not fetch existing (HTTP ${res.status})`); break; }
    const data = await res.json() as { items?: { sku: string }[]; total?: number };
    const items = data.items || [];
    items.forEach((i) => skus.add(i.sku));
    if (items.length < 200) break;
    offset += 200;
    await sleep(150);
  }
  return skus;
}

// ── Insert one product (with retry) ─────────────────────────────────────────
async function insertOneRetry(p: SeedProduct, maxRetries = 2): Promise<{ ok: boolean; status: number; id?: string; error?: string; duplicate?: string }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`${API_BASE}/api/products`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(p),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      const body = await res.json().catch(() => ({})) as any;
      if (res.ok) return { ok: true, status: 200, id: body.id };
      // Don't retry on 409 (dup) or 402 (quota) — return immediately
      if (res.status === 409 || res.status === 402) {
        return { ok: false, status: res.status, error: body.error || `HTTP ${res.status}`, duplicate: body.duplicate };
      }
      // Retry on 5xx and network errors
      if (attempt < maxRetries && (res.status >= 500 || res.status === 0)) {
        log(`    retry ${attempt + 1}/${maxRetries} for ${p.sku} (HTTP ${res.status})`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return { ok: false, status: res.status, error: body.error || `HTTP ${res.status}`, duplicate: body.duplicate };
    } catch (e) {
      clearTimeout(to);
      if (attempt < maxRetries) {
        log(`    retry ${attempt + 1}/${maxRetries} for ${p.sku} (network: ${(e as Error).message})`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return { ok: false, status: 0, error: (e as Error).message };
    }
  }
  return { ok: false, status: 0, error: "max retries exceeded" };
}

// ── Insert one product (legacy, kept for compat) ────────────────────────────
async function insertOne(p: SeedProduct): Promise<{ ok: boolean; status: number; id?: string; error?: string; duplicate?: string }> {
  return insertOneRetry(p);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Aspidus DMCC — Product Catalog Seeding                ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  API:        ${API_BASE}`);
  console.log(`  API Key:    ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  console.log(`  Mode:       ${DRY_RUN ? "🔍 DRY-RUN (no writes)" : "⚡ REAL INSERT"}`);
  console.log(`  Category:   ${CATEGORY || "ALL"}`);
  console.log(`  Batch:      ${BATCH_SIZE}`);
  console.log(`  Delay:      ${DELAY_MS}ms`);
  console.log("");

  // Filter
  let products = CATEGORY ? ALL_PRODUCTS.filter((p) => p.category === CATEGORY) : ALL_PRODUCTS.slice();
  if (LIMIT > 0) products = products.slice(0, LIMIT);
  console.log(`  Total products to process: ${fmt(products.length)}`);
  console.log("");

  // ── Local validation pass ─────────────────────────────────────────────────
  log("Phase 1: Local validation");
  const invalid: { idx: number; sku: string; errs: string[] }[] = [];
  products.forEach((p, idx) => {
    const errs = validateProduct(p, idx);
    if (errs.length) invalid.push({ idx, sku: p.sku, errs });
  });
  if (invalid.length) {
    console.log(`  ✗ ${invalid.length} products failed local validation:`);
    invalid.slice(0, 20).forEach((v) => console.log(`    [${v.idx}] ${v.sku}: ${v.errs.join("; ")}`));
    if (invalid.length > 20) console.log(`    ... and ${invalid.length - 20} more`);
    console.log("");
    console.log("Fix validation errors before inserting. Aborting.");
    process.exit(1);
  }
  log(`  ✓ All ${fmt(products.length)} products passed local validation`);

  // Per-category breakdown
  const catCounts: Record<string, number> = {};
  products.forEach((p) => catCounts[p.category] = (catCounts[p.category] || 0) + 1);
  console.log("  Per category:");
  Object.entries(catCounts).forEach(([c, n]) => console.log(`    ${c.padEnd(15)} ${fmt(n)}`));
  console.log("");

  if (DRY_RUN) {
    log("DRY-RUN complete — no API writes performed.");
    console.log("");
    console.log("To perform real insert, run WITHOUT --dry-run:");
    console.log(`  bun scripts/aspidus/insert.ts${CATEGORY ? ` --category=${CATEGORY}` : ""}`);
    return;
  }

  // ── Fetch existing SKUs ───────────────────────────────────────────────────
  log("Phase 2: Fetching existing products from tenant (to skip duplicates)");
  const existingSkus = await fetchExistingSkus();
  log(`  ✓ Found ${fmt(existingSkus.size)} existing products in tenant`);

  const skippedDupes = products.filter((p) => existingSkus.has(p.sku));
  if (skippedDupes.length) {
    console.log(`  ⚠ ${skippedDupes.length} products already exist (will skip):`);
    skippedDupes.slice(0, 10).forEach((p) => console.log(`    ${p.sku}  ${p.name}`));
    if (skippedDupes.length > 10) console.log(`    ... and ${skippedDupes.length - 10} more`);
  }
  console.log("");

  // ── Real insert ───────────────────────────────────────────────────────────
  log("Phase 3: Real insert via POST /api/products");
  const toInsert = products.filter((p) => !existingSkus.has(p.sku));
  log(`  Inserting ${fmt(toInsert.length)} products (skipping ${fmt(skippedDupes.length)} existing)`);

  const results: { sku: string; name: string; ok: boolean; status: number; error?: string; id?: string }[] = [];
  let success = 0, failed = 0, dupName = 0;
  const errors: { sku: string; name: string; status: number; error: string }[] = [];

  for (let i = 0; i < toInsert.length; i++) {
    const p = toInsert[i];
    const r = await insertOne(p);
    results.push({ sku: p.sku, name: p.name, ok: r.ok, status: r.status, error: r.error, id: r.id });

    if (r.ok) {
      success++;
      if ((i + 1) % 10 === 0 || i === toInsert.length - 1) {
        log(`  [${fmt(i + 1)}/${fmt(toInsert.length)}] ✓ ${success} ok, ${failed} failed, ${dupName} name-dupe`);
      }
    } else if (r.status === 409 && r.duplicate === "name") {
      dupName++;
      // Retry with force:true
      const res2 = await fetch(`${API_BASE}/api/products`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...p, force: true }),
      });
      const b2 = await res2.json().catch(() => ({})) as any;
      if (res2.ok) {
        success++;
      } else {
        failed++;
        errors.push({ sku: p.sku, name: p.name, status: res2.status, error: b2.error || `HTTP ${res2.status}` });
      }
    } else {
      failed++;
      errors.push({ sku: p.sku, name: p.name, status: r.status, error: r.error || "unknown" });
      if (r.status === 402) {
        log(`  ✗ Subscription/quota issue (402). Stopping to avoid further failures.`);
        log(`    Error: ${r.error}`);
        break;
      }
    }
    if (DELAY_MS > 0 && (i + 1) % BATCH_SIZE === 0) {
      log(`  ... batch boundary, sleeping ${DELAY_MS}ms`);
      await sleep(DELAY_MS);
    } else if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   INSERT SUMMARY                                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Total processed:    ${fmt(toInsert.length)}`);
  console.log(`  ✓ Success:          ${fmt(success)}`);
  console.log(`  ✗ Failed:           ${fmt(failed)}`);
  console.log(`  ↻ Name-dupes:       ${fmt(dupName)} (retried with force:true)`);
  console.log(`  ⊘ Skipped (exists): ${fmt(skippedDupes.length)}`);
  console.log("");

  if (errors.length) {
    console.log(`  Errors (${errors.length}):`);
    errors.slice(0, 30).forEach((e) => console.log(`    [${e.status}] ${e.sku} — ${e.error.slice(0, 80)}`));
    if (errors.length > 30) console.log(`    ... and ${errors.length - 30} more`);
    console.log("");
  }

  // Write log file
  const logFile = `/home/z/my-project/scripts/aspidus/insert-log-${Date.now()}.json`;
  await Bun.write(logFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    mode: DRY_RUN ? "dry-run" : "real",
    apiBase: API_BASE,
    category: CATEGORY || "ALL",
    total: toInsert.length,
    success, failed, dupName, skipped: skippedDupes.length,
    results, errors,
  }, null, 2));
  console.log(`  Log written: ${logFile}`);

  // Verify by re-fetching count
  if (!DRY_RUN) {
    log("Phase 4: Verify insert via read-back");
    const finalSkus = await fetchExistingSkus();
    log(`  ✓ Tenant now has ${fmt(finalSkus.size)} products (was ${fmt(existingSkus.size)}, +${fmt(finalSkus.size - existingSkus.size)})`);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
