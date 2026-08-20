import { NextRequest, NextResponse } from "next/server";
import { getPortalSessionAccess } from "@/lib/auth/portal-session";
import {
  getOwnCompanyProfile,
  upsertCompanyProfile,
} from "@/lib/data/marketplace-profile-store";
import { sanitizeFields } from "@/lib/security/sanitize-input";
import { audit } from "@/lib/api/helpers";
import { getStore } from "@/lib/data/store";
import { withApm } from "@/lib/monitoring/apm";

export const runtime = "nodejs";

// GET /api/marketplace/profiles/me — fetch the caller's own profile (raw
// row, including tenant_id — the caller IS the owner). Used by the
// "Edit my profile" editor.
async function _get() {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  try {
    const profile = await getOwnCompanyProfile(access.tenant_id, access.partner_id);
    return NextResponse.json({ profile });
  } catch (e: any) {
    console.error("[marketplace.profile.me.get]", e);
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }
}

// PUT /api/marketplace/profiles/me — create or update the caller's own
// profile. tenant_id / partner_id are stamped from the auth context —
// body-supplied identity fields are ignored. Counters + verification_*
// are NEVER writable here (they're owned by the system / super-admin).
async function _put(req: NextRequest) {
  const access = await getPortalSessionAccess();
  if (!access) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate year_established (optional 4-digit integer).
  if (body.year_established !== undefined && body.year_established !== null && body.year_established !== "") {
    const y = Number(body.year_established);
    const cy = new Date().getFullYear();
    if (!Number.isInteger(y) || y < 1800 || y > cy) {
      return NextResponse.json(
        { error: `Year established must be an integer between 1800 and ${cy}.` },
        { status: 400 },
      );
    }
    body.year_established = y;
  } else if (body.year_established === "") {
    body.year_established = null;
  }

  // Validate number_of_employees length.
  if (body.number_of_employees && typeof body.number_of_employees === "string" && body.number_of_employees.length > 50) {
    return NextResponse.json(
      { error: "Number of employees text is too long (max 50 chars)." },
      { status: 400 },
    );
  }

  // Validate JSONB array fields (certifications, export_markets, main_products).
  // Each must be an array (or null/absent).
  for (const k of ["certifications", "export_markets", "main_products"]) {
    if (body[k] !== undefined && body[k] !== null) {
      if (!Array.isArray(body[k])) {
        return NextResponse.json(
          { error: `${k} must be an array.` },
          { status: 400 },
        );
      }
      // Cap each array at 50 entries to avoid pathological payloads.
      if (body[k].length > 50) {
        return NextResponse.json(
          { error: `${k} cannot have more than 50 entries.` },
          { status: 400 },
        );
      }
    }
  }

  // Validate website + linkedin_url (must start with http:// or https:// if set).
  for (const k of ["website", "linkedin_url"]) {
    if (body[k] && typeof body[k] === "string") {
      if (!/^https?:\/\//i.test(body[k])) {
        return NextResponse.json(
          { error: `${k} must be a full URL starting with http:// or https://.` },
          { status: 400 },
        );
      }
      if (body[k].length > 500) {
        return NextResponse.json(
          { error: `${k} is too long (max 500 chars).` },
          { status: 400 },
        );
      }
    }
  }

  // Cap company_description length.
  if (body.company_description && typeof body.company_description === "string" && body.company_description.length > 10000) {
    return NextResponse.json(
      { error: "Company description is too long (max 10000 chars)." },
      { status: 400 },
    );
  }

  // XSS prevention on free-text fields.
  body = sanitizeFields(body, [
    "company_description",
    "number_of_employees",
    "website",
    "linkedin_url",
  ]);

  // Strip caller-supplied identity / counter / verification fields — the
  // store stamps these from the auth context or the system.
  const FORBIDDEN = [
    "id", "tenant_id", "partner_id",
    "verification_level", "verified_at", "verified_by",
    "total_posts", "total_responses", "successful_deals",
    "rating_average", "rating_count",
    "created_at", "updated_at",
  ];
  for (const f of FORBIDDEN) delete body[f];

  try {
    const updated = await upsertCompanyProfile(access.tenant_id, access.partner_id, body);
    try {
      const store = await getStore();
      await audit(
        store,
        { id: undefined, username: access.portal_email || `portal:${access.id}`, tenant_id: access.tenant_id },
        req,
        "marketplace.profile_updated",
        "marketplace_company_profile",
        updated.id,
        { partner_id: access.partner_id },
      );
    } catch (e) {
      console.error("[marketplace.profile.me.put] audit failed:", e);
    }
    return NextResponse.json({ profile: updated });
  } catch (e: any) {
    console.error("[marketplace.profile.me.put]", e);
    return NextResponse.json({ error: e.message || "Failed to update profile." }, { status: 500 });
  }
}

export const GET = withApm(_get, "GET /api/marketplace/profiles/me");
export const PUT = withApm(_put, "PUT /api/marketplace/profiles/me");
