import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, resolveTenantId, sanitizeError } from "@/lib/api/helpers";
import { getSupabase } from "@/lib/supabase/client";
// migration 105 — the canonical bank-account shape + parser.
import { parseTenantBankAccounts, type TenantBankAccount } from "@/lib/utils/bank-accounts";

export const runtime = "nodejs";

/**
 * Tenant bank accounts (the `tenants.bank_accounts` JSONB array) — the
 * accounts rendered on offer / proforma / invoice PDFs and offered in the
 * document forms' bank pickers.
 *
 *   GET /api/bank-accounts            → { accounts: TenantBankAccount[] }
 *   PUT /api/bank-accounts            → { accounts: [...] }  (full replace)
 *
 * Migration 105 added the ACCOUNT HOLDER (naziv korisnika računa) and the
 * optional bank address per account — this route is the only writer, so the
 * array stays shape-validated (unknown keys dropped, strings trimmed and
 * length-capped, max 10 accounts).
 *
 * Access: tenant admins (settings.update permission) manage THEIR OWN
 * tenant's accounts; super-admins may pass ?tenant_id=… to manage any.
 */

const MAX_ACCOUNTS = 10;
const cap = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function sanitizeAccount(raw: unknown): TenantBankAccount | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const acct: TenantBankAccount = {};
  const bankName = cap(r.bankName ?? r.bank_name, 120);
  const accountNumber = cap(r.accountNumber ?? r.account_number, 64);
  const iban = cap(r.iban, 64);
  const swift = cap(r.swiftCode ?? r.swift_code, 32);
  const currency = cap(r.currency, 8).toUpperCase();
  const accountHolder = cap(r.accountHolder ?? r.account_holder ?? r.holder, 160);
  const bankAddress = cap(r.bankAddress ?? r.bank_address, 240);
  if (bankName) acct.bankName = bankName;
  if (accountNumber) acct.accountNumber = accountNumber;
  if (iban) acct.iban = iban;
  if (swift) acct.swiftCode = swift;
  if (currency) acct.currency = currency;
  if (accountHolder) acct.accountHolder = accountHolder;
  if (bankAddress) acct.bankAddress = bankAddress;
  // An account with NOTHING set is dropped (an empty editor row).
  return Object.keys(acct).length > 0 ? acct : null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "settings.read");
    if (denied) return denied;
  }
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    if (auth.isSuperAdmin) return NextResponse.json({ accounts: [] });
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("tenants")
      .select("bank_accounts")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    return NextResponse.json({ accounts: parseTenantBankAccounts(data?.bank_accounts ?? null) });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  {
    const { requirePermission } = await import("@/lib/permissions/can");
    const denied = requirePermission(auth, "settings.update");
    if (denied) return denied;
  }
  if (!auth.isSuperAdmin && auth.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant context." }, { status: 400 });
  }

  let body: { accounts?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.accounts)) {
    return NextResponse.json({ error: "`accounts` must be an array." }, { status: 400 });
  }
  if (body.accounts.length > MAX_ACCOUNTS) {
    return NextResponse.json(
      { error: `Too many bank accounts (max ${MAX_ACCOUNTS}).` },
      { status: 400 },
    );
  }
  const accounts: TenantBankAccount[] = body.accounts
    .map(sanitizeAccount)
    .filter((a): a is TenantBankAccount => a !== null);

  try {
    const sb = getSupabase();
    const { error } = await sb
      .from("tenants")
      .update({ bank_accounts: accounts })
      .eq("id", tenantId);
    if (error) return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
    await audit(auth.store, auth.user, req, "tenant.bank_accounts.update", "tenant", tenantId, {
      count: accounts.length,
    });
    return NextResponse.json({ accounts });
  } catch (error: any) {
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
