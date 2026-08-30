import { NextRequest, NextResponse } from "next/server";
import { requireAuth, audit, sanitizeError } from "@/lib/api/helpers";
// 8d-4: RBAC gate — `lois/[id]` previously called `requireAuth(req)` only,
// which authorised the call but did NOT check the caller had the right
// permission for the action. Any authenticated tenant user (even one with a
// `user` role whose permissions exclude `lois.*`) could read/update/delete
// any LOI in their tenant. Now gates GET / PUT / DELETE on `lois.read` /
// `lois.update` / `lois.delete` respectively — super_admin bypasses via
// `can()`'s rule 1.
import { requirePermission } from "@/lib/permissions/can";
import { getStore } from "@/lib/data/store";
import { CURRENCY_CODES } from "@/lib/data/reference";
import type { LetterOfIntent } from "@/lib/supabase/types";

export const runtime = "nodejs";

/** Whitelist fields a PUT caller is allowed to modify. Blocks audit-trail +
 *  lifecycle columns (sent_at, responded_at, created_by, etc.). */
function whitelistLoiFields(body: any): any {
  const allowed: Record<string, unknown> = {};
  const permit = [
    "partner_id", "buyer_name", "buyer_address", "buyer_contact", "subject",
    "product_name", "product_description", "hs_code", "origin_country",
    "quantity", "unit", "unit_price", "currency", "delivery_terms",
    "delivery_date", "payment_terms", "validity_until", "status",
    "notes", "terms_text", "deal_id", "offer_id",
  ];
  for (const k of permit) {
    if (k in body) allowed[k] = body[k];
  }
  return allowed;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // 8d-4: RBAC gate.
    const denied = requirePermission(auth, "lois.read");
    if (denied) return denied;
    const { id } = await params;
    const store = await getStore();
    const loi = await store.getLoi(id);
    if (!loi) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && loi.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(loi);
  } catch (e: any) {
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // 8d-4: RBAC gate.
    const denied = requirePermission(auth, "lois.update");
    if (denied) return denied;
    const { id } = await params;
    const store = await getStore();
    const existing = await store.getLoi(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Validate currency if provided
    if (body.currency && !CURRENCY_CODES.includes(body.currency as any)) {
      return NextResponse.json({ error: "Invalid currency code." }, { status: 400 });
    }

    // Validate quantity / unit_price if provided
    if (body.quantity != null) {
      const q = Number(body.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        return NextResponse.json({ error: "Quantity must be a positive number." }, { status: 400 });
      }
    }
    if (body.unit_price != null) {
      const up = Number(body.unit_price);
      if (!Number.isFinite(up) || up <= 0) {
        return NextResponse.json({ error: "Unit price must be a positive number." }, { status: 400 });
      }
    }

    // Validate status transition
    const VALID_TRANSITIONS: Record<string, string[]> = {
      draft: ["sent", "cancelled"],
      sent: ["accepted", "rejected", "expired", "cancelled"],
      accepted: [],
      rejected: [],
      expired: [],
      cancelled: [],
    };
    const newStatus = body.status;
    if (newStatus && newStatus !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(newStatus)) {
        return NextResponse.json(
          { error: `Cannot transition from ${existing.status} to ${newStatus}.` },
          { status: 400 },
        );
      }
    }

    const safe = whitelistLoiFields(body);
    const updated = await store.upsertLoi({
      ...safe,
      id,
      tenant_id: existing.tenant_id,
      // Server-side total_value recompute
      total_value: (Number(safe.quantity ?? existing.quantity)) * (Number(safe.unit_price ?? existing.unit_price)),
    } as Partial<LetterOfIntent> & { id?: string });

    await audit(auth.store, auth.user, req, "loi.update", "loi", id, {
      number: existing.number,
      changes: Object.keys(safe),
    });

    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[lois.update]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAuth(req);
    if (auth instanceof NextResponse) return auth;
    // 8d-4: RBAC gate.
    const denied = requirePermission(auth, "lois.delete");
    if (denied) return denied;
    const { id } = await params;
    const store = await getStore();
    const existing = await store.getLoi(id);
    if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!auth.isSuperAdmin && existing.tenant_id !== auth.tenantId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Only draft / cancelled LOIs can be hard-deleted
    if (!["draft", "cancelled"].includes(existing.status)) {
      return NextResponse.json(
        { error: `Cannot delete an LOI with status ${existing.status}. Cancel it first.` },
        { status: 400 },
      );
    }

    await store.deleteLoi(id);
    await audit(auth.store, auth.user, req, "loi.delete", "loi", id, {
      number: existing.number,
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[lois.delete]", e);
    return NextResponse.json({ error: sanitizeError(e) }, { status: 500 });
  }
}
