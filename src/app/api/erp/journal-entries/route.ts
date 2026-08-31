import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveTenantId, audit, sanitizeError } from "@/lib/api/helpers";

export const runtime = "nodejs";

// GET /api/erp/journal-entries — List journal entries
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
    // Permission gate (erp.read)
    { const { requirePermission } = await import("@/lib/permissions/can");
      const _d = requirePermission(auth, "erp.read"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) return NextResponse.json({ items: [], total: 0 });

  try {
    const url = new URL(req.url);
    const search = url.searchParams.get("search") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const date_from = url.searchParams.get("date_from") || undefined;
    const date_to = url.searchParams.get("date_to") || undefined;
    const reference_type = url.searchParams.get("reference_type") || undefined;
    // FIX-MARKET-UI / FIX 4 — pagination. Cap limit at 500 (matches the
    // commission-payouts route's defensive cap).
    const limit = url.searchParams.get("limit")
      ? Math.min(Number(url.searchParams.get("limit")), 500)
      : undefined;
    const offset = url.searchParams.get("offset")
      ? Math.max(Number(url.searchParams.get("offset")), 0)
      : undefined;

    const result = await auth.store.listErpJournalEntries(tenantId, {
      search,
      filters: { status, date_from, date_to, reference_type },
      limit,
      offset,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

// POST /api/erp/journal-entries — Create journal entry (with lines array)
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Permission gate (erp.create)
  { const { requirePermission } = await import("@/lib/permissions/can");
    const _d = requirePermission(auth, "erp.create"); if (_d) return _d; } /* requirePermission wired */
  // Feature gate (module_finance)
  { const { requireFeature } = await import("@/lib/api/feature-guard");
    const _f = await requireFeature(auth.tenantId, "module_finance", auth.isSuperAdmin); if (_f) return _f; } /* requireFeature wired */


  const tenantId = resolveTenantId(auth, req);
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant ID required." }, { status: 400 });
  }

  try {
    const body = await req.json();

    // Validate lines exist
    if (!body.lines || !Array.isArray(body.lines) || body.lines.length === 0) {
      return NextResponse.json({ error: "Journal entry must have at least one line." }, { status: 400 });
    }

    // P2-12: Validate each line's debit/credit BEFORE the balance check.
    // `reduce` propagates NaN (NaN + x = NaN, Math.abs(NaN - NaN) > 0.01 === false),
    // so a single malformed line would silently bypass the balance gate. Negative
    // amounts are nonsensical in accounting and must also be rejected up-front.
    // We normalize the values so downstream code sees clean finite numbers.
    //
    // F-TWO deep-audit fix: use `Number(l.debit)` WITHOUT the `|| 0` fallback.
    // The previous form `Number(l.debit) || 0` silently coerced non-numeric
    // input (e.g. `"abc"`, `null`, `undefined`) to 0 because `NaN || 0 === 0`,
    // which then passed the `Number.isFinite(d)` check (0 is finite) and
    // entered the balance computation as a 0-debit line — masking typos and
    // allowing malformed POST bodies to persist silent zero-amount lines.
    // The bare `Number(l.debit)` returns NaN for invalid input, which the
    // `!Number.isFinite(d)` check now correctly rejects.
    for (const l of body.lines) {
      const d = Number(l.debit);
      const c = Number(l.credit);
      if (!Number.isFinite(d) || d < 0) {
        return NextResponse.json({ error: "Invalid debit amount." }, { status: 400 });
      }
      if (!Number.isFinite(c) || c < 0) {
        return NextResponse.json({ error: "Invalid credit amount." }, { status: 400 });
      }
      // Normalize to clean numbers
      l.debit = d;
      l.credit = c;
    }

    // Validate debit/credit balance
    const totalDebit = body.lines.reduce((sum: number, l: any) => sum + (l.debit || 0), 0);
    const totalCredit = body.lines.reduce((sum: number, l: any) => sum + (l.credit || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return NextResponse.json({ error: "Journal entry must be balanced (debits must equal credits)." }, { status: 400 });
    }

    // Fix 11 (Re-Audit-2 P0/journal): validate that every `account_id` on the
    // lines actually exists in `erp_accounts` for this tenant BEFORE inserting
    // the journal entry. A non-existent FK would otherwise trigger a 500 mid-
    // insert (after we've already validated + started persisting the header)
    // and produce an opaque error message. We resolve the set of unique
    // account_ids, fetch them in a single query, and 400 with the offending id
    // if any are missing.
    const accountIds = Array.from(
      new Set(
        body.lines
          .map((l: any) => l.account_id)
          .filter((id: any) => typeof id === "string" && id.length > 0),
      ),
    ) as string[];
    if (accountIds.length > 0) {
      const { getSupabase } = await import("@/lib/supabase/client");
      const sb = getSupabase();
      const { data: validAccounts, error: accErr } = await sb
        .from("erp_accounts")
        .select("id")
        .eq("tenant_id", tenantId)
        .in("id", accountIds);
      if (accErr) {
        return NextResponse.json(
          { error: `Failed to validate account_ids: ${accErr.message}` },
          { status: 500 },
        );
      }
      const validSet = new Set((validAccounts || []).map((a: any) => a.id));
      const missing = accountIds.filter((id) => !validSet.has(id));
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: `Invalid account_id(s): ${missing.join(", ")}. Each line's account_id must reference an existing erp_accounts row in this tenant.`,
          },
          { status: 400 },
        );
      }
    }

    // E-8: refuse to create a journal entry whose date falls inside a CLOSED
    // fiscal period. The store-level `postErpJournalEntry` already enforces
    // this at post-time, but without this earlier check the user could
    // create a draft entry in a closed period (and then be confused when
    // they can never post it). Mirroring the store's lookup: filter by
    // tenant_id so tenant A's closed period can't block tenant B. If no
    // period is configured for the date, we allow (don't block on missing
    // config — same behaviour as the post-time check).
    // AUDIT17 / P1 — the store always writes a date
    // (`entryFields.date ?? new Date()…`), so the previous `if (body.date)`
    // gate let a caller dodge the closed-period check by simply omitting
    // body.date. Validate the EFFECTIVE date.
    const effectiveDate = body.date || new Date().toISOString();
    {
      const { getSupabase } = await import("@/lib/supabase/client");
      const { data: period, error: periodErr } = await getSupabase()
        .from("fiscal_periods")
        .select("id, status")
        .eq("tenant_id", tenantId)
        .lte("start_date", effectiveDate)
        .gte("end_date", effectiveDate)
        .maybeSingle();
      if (periodErr) {
        return NextResponse.json(
          { error: `Failed to validate fiscal period: ${periodErr.message}` },
          { status: 500 },
        );
      }
      if (period && period.status === "closed") {
        return NextResponse.json(
          { error: "Cannot create journal entry in a closed fiscal period." },
          { status: 409 },
        );
      }
    }

    // AUDIT17 / P0 — cross-tenant IDOR + posted-entry rewrite via body.id.
    // The RPC upsert_journal_entry (migration 038) matches the UPDATE purely
    // on `WHERE id = v_id` with NO tenant filter, and even reassigns
    // tenant_id from the payload — a POST carrying a victim entry's id
    // silently MOVED that entry (and deleted/replaced its lines) into the
    // caller's tenant. The same POST path also bypassed PUT's
    // `status !== "draft"` guard, rewriting POSTED ledger rows.
    // Defense here (route-level, works without a migration):
    //   1. body.id present → the entry must exist, belong to THIS tenant,
    //      and still be a draft. Otherwise 404/403/409.
    //   2. status / posted_by / posted_at are STRIPPED — only the dedicated
    //      /post route (erp.post permission + SoD + balance re-validation)
    //      may set them. This closes the SoD bypass where a user with only
    //      erp.create flipped drafts straight to "posted".
    if (body.id) {
      const existing = await auth.store.getErpJournalEntry(body.id);
      if (!existing || existing.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Journal entry not found." }, { status: 404 });
      }
      if ((existing as any).status !== "draft") {
        return NextResponse.json(
          { error: "Only draft journal entries can be modified. Use the post/reverse endpoints for posted entries." },
          { status: 409 },
        );
      }
    }
    // AUDIT17 / P1 — strip the mass-assignment vector (only /post may set
    // these; forging posted_by/posted_at also corrupts the audit trail).
    delete body.status;
    delete body.posted_by;
    delete body.posted_at;

    const created = await auth.store.upsertErpJournalEntry({
      ...body,
      tenant_id: tenantId,
      created_by: auth.user.id,
      debit_total: totalDebit,
      credit_total: totalCredit,
    });
    await audit(auth.store, auth.user, req, "journal_entry.create", "erp_journal_entry", created.id, {
      entry_number: created.entry_number,
      debit_total: totalDebit,
      credit_total: totalCredit,
    });
    return NextResponse.json(created);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
