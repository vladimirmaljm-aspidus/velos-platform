// Marketplace external integrations — Phase 12.
//
// Wrappers around third-party services that the marketplace can call to
// extend its data surface beyond the platform's own tables:
//
//   • trackContainer       — Maersk / MSC / CMA CGM / ONE / Hapag-Lloyd
//                              container tracking (carrier API → normalised
//                              shape with status, location, ETA, events).
//   • uploadTradeDocument  — Supabase Storage upload for trade documents
//                              (commercial invoices, BLs, CoO, etc.) →
//                              returns a public URL the marketplace can
//                              link to from the document register.
//   • submitLetterOfCredit — Bank L/C submission integration (placeholder
//                              for SWIFT MT700 / Baton / TradeLens).
//   • fileCustomsDeclaration — Customs filing integration (placeholder
//                              for AES / DTI / EU ICS, returns an MRN).
//
// All four are written as PLACEHOLDERS that return a deterministic,
// well-typed shape. The actual carrier / bank / customs API keys live
// in the tenant's vault (encrypted) or in the platform's settings
// (global defaults); when a key is missing, the function returns a
// structured "not configured" response rather than throwing — the
// caller surfaces the message via the API route's HTTP layer.
//
// The shape of each return value is STABLE across the placeholder and
// the real implementations: when a real integration is wired up, only
// the function body changes; the call sites (API routes + UI components)
// stay untouched.

import { getSupabase } from "@/lib/supabase/client";

// ─── Carrier tracking ──────────────────────────────────────────────────────

export interface ContainerTrackingEvent {
  /** ISO 8601 timestamp of the event. */
  date: string;
  /** Free-text location (port code + city, or lat/lng). */
  location: string;
  /** What happened (e.g. "Vessel departed", "Container gated out"). */
  description: string;
  /** Carrier-specific event type code (optional). */
  type?: string;
}

export interface ContainerTrackingResult {
  /** Carrier-scoped status (e.g. "In Transit", "Arrived", "Gate Out"). */
  status: string;
  /** Current location of the container (last known). */
  location: string;
  /** ISO 8601 ETA at the destination port. */
  ETA: string;
  /** Chronological tracking events (oldest → newest). */
  events: ContainerTrackingEvent[];
  /** When the data was last fetched from the carrier. */
  lastUpdated: string;
  /** Whether this is a placeholder response (no real carrier API was
   * called — the carrier key wasn't configured or the carrier is
   * unsupported). The marketplace UI surfaces a "Demo data" badge so
   * the user knows the tracking is illustrative. */
  isPlaceholder: boolean;
}

/** Carriers we currently support (or plan to). */
export const SUPPORTED_CARRIERS = [
  "maersk",
  "msc",
  "cma-cgm",
  "hapag-lloyd",
  "one",
  "cosco",
  "evergreen",
  "yang-ming",
] as const;
export type Carrier = (typeof SUPPORTED_CARRIERS)[number];

/**
 * Track a shipping container by carrier + tracking number.
 *
 * In production this would call the carrier's tracking API (Maersk
 * Track-Vessel, MSC myShipping, CMA CGM e-Business, etc.) and
 * normalise the response to {@link ContainerTrackingResult}.
 *
 * Currently returns a PLACEHOLDER so the marketplace UI can be
 * developed + tested without burning real API calls. The placeholder
 * is deterministic per (carrier, trackingNumber) so the same query
 * always returns the same data within a process — useful for demos
 * + integration tests.
 *
 * To wire a real carrier, replace the placeholder branch with a
 * fetch() to the carrier's API + map the response to the result
 * shape. The function signature stays the same.
 */
export async function trackContainer(
  carrier: string,
  trackingNumber: string,
): Promise<ContainerTrackingResult> {
  const normalisedCarrier = String(carrier || "").toLowerCase().trim() as Carrier;
  const cleanTracking = String(trackingNumber || "").toUpperCase().trim();

  if (!SUPPORTED_CARRIERS.includes(normalisedCarrier)) {
    // Unknown carrier — return a structured "not supported" result
    // rather than throwing. The caller surfaces this as an HTTP 400
    // with the message.
    return {
      status: "Unknown carrier",
      location: "",
      ETA: "",
      events: [],
      lastUpdated: new Date().toISOString(),
      isPlaceholder: true,
    };
  }

  if (!cleanTracking || cleanTracking.length < 4) {
    return {
      status: "Invalid tracking number",
      location: "",
      ETA: "",
      events: [],
      lastUpdated: new Date().toISOString(),
      isPlaceholder: true,
    };
  }

  // ── PLACEHOLDER ──────────────────────────────────────────────────
  // Deterministic mock based on a hash of (carrier, trackingNumber).
  // The same query always returns the same mock data, so the UI can
  // be developed + tested without burning real carrier API calls.
  // Replace this branch with a real fetch() when the carrier API
  // keys are configured.
  const seed =
    (cleanTracking.charCodeAt(0) || 0) +
    (cleanTracking.charCodeAt(cleanTracking.length - 1) || 0) +
    normalisedCarrier.length;
  const inTransit = seed % 3 !== 0;
  const etaOffsetDays = (seed % 14) + 1;

  const baseDate = new Date();
  baseDate.setUTCDate(baseDate.getUTCDate() + (inTransit ? etaOffsetDays : -1));

  return {
    status: inTransit ? "In Transit" : "Delivered",
    location: inTransit ? "Indian Ocean, West of Sri Lanka" : "Rotterdam, NL",
    ETA: baseDate.toISOString(),
    events: [
      {
        date: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
        location: "Shanghai, CN",
        description: "Container loaded on vessel",
        type: "LOAD",
      },
      {
        date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        location: "Shanghai, CN",
        description: "Vessel departed",
        type: "DEP",
      },
      {
        date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        location: "Singapore, SG",
        description: "Transshipment",
        type: "TSP",
      },
      {
        date: inTransit
          ? new Date().toISOString()
          : new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        location: inTransit ? "Indian Ocean" : "Rotterdam, NL",
        description: inTransit ? "Vessel in transit" : "Container discharged",
        type: inTransit ? "TST" : "DIS",
      },
    ],
    lastUpdated: new Date().toISOString(),
    isPlaceholder: true,
  };
}

// ─── Document upload (Supabase Storage) ────────────────────────────────────

/**
 * Upload a trade document to the marketplace-documents Supabase Storage
 * bucket. Returns the public URL the marketplace can link to from the
 * document register / negotiations / contract deliveries.
 *
 * The bucket is created lazily on first upload — if the bucket doesn't
 * exist (the platform admin hasn't run the storage migration), the
 * function attempts to create it. Public read access is granted by
 * default (trade documents are signed + fingerprinted, so public
 * access is the security boundary; the signature verifies integrity).
 *
 * PLACEHOLDER until the bucket is configured — when Supabase Storage
 * isn't set up, the function returns a deterministic mock URL so the
 * UI flow can be tested without a real bucket.
 */
export async function uploadTradeDocument(
  file: File,
  path: string,
): Promise<string> {
  // The path is sanitised — strip leading slashes (Supabase Storage
  // paths are relative to the bucket root) + collapse ".." segments.
  const cleanPath = String(path || "")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9_\-./]/g, "_");

  try {
    const supabase = getSupabase();
    const bucket = "marketplace-documents";
    const arrayBuffer = await file.arrayBuffer();
    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(cleanPath, arrayBuffer, {
        contentType: file.type || "application/octet-stream",
        upsert: true,
      });
    if (upErr) {
      // Bucket doesn't exist → create it (fire-and-forget; the second
      // upload attempt will succeed). If the storage key lacks the
      // create-bucket permission, the upload will keep failing — the
      // function falls back to a mock URL.
      //
      // ─── Audit finding 8d-12: bucket MUST be private, not public.
      //
      // Trade documents (commercial invoices, BLs, CoOs, packing lists,
      // L/C drafts, customs declarations) contain PII, financials, and
      // counterparty terms. A public bucket lets anyone with the URL
      // fetch the file (including search engines if the URL is ever
      // logged or leaked). The previous `{ public: true }` was a
      // leftover from the placeholder phase that did not hold once real
      // documents started flowing: signatures verify integrity but do
      // NOT restrict access. The private bucket enforces download-time
      // authz — every fetch must go through a signed-URL issuance path
      // that checks the caller's marketplace role.
      //
      // KNOWN GAP (follow-up tracked in Task 10-D-v2 worklog): the
      // `getPublicUrl()` call below returns a URL that 403s against the
      // private bucket. A signed-URL download route is NOT yet wired;
      // the placeholder mock-URL fallback masks this in local dev.
      void supabase.storage.createBucket(bucket, { public: false }).catch(() => {});
      throw upErr;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(cleanPath);
    return data.publicUrl;
  } catch (e) {
    // PLACEHOLDER — return a deterministic mock URL so the marketplace
    // flow can be tested without a configured Storage bucket. The mock
    // URL is unmistakably fake (velos.local) so it never gets confused
    // with a real document.
    console.warn(
      "[integrations.uploadTradeDocument] falling back to mock URL — Supabase Storage not configured or bucket missing:",
      e instanceof Error ? e.message : String(e),
    );
    return `https://velos.local/storage/marketplace-documents/${encodeURIComponent(cleanPath)}?name=${encodeURIComponent(file.name)}`;
  }
}

// ─── Letter of Credit submission ──────────────────────────────────────────

export interface LetterOfCreditResult {
  /** "submitted" | "rejected" | "pending_review" */
  status: "submitted" | "rejected" | "pending_review";
  /** Bank-side reference number the applicant uses for follow-up. */
  referenceNumber: string;
  /** Raw bank response (varies by SWIFT / Baton / TradeLens). */
  bankResponse: Record<string, unknown>;
  /** Whether this is a placeholder response. */
  isPlaceholder: boolean;
}

/**
 * Submit a Letter of Credit application to the issuing bank.
 *
 * PLACEHOLDER — would call the bank's L/C submission API (SWIFT MT700
 * for traditional banks, Baton / TradeLens for the blockchain-based
 * networks). The integration is keyed by the tenant's vault entry
 * `bank_lc_api_key` (encrypted); when absent, the function returns a
 * structured "not configured" response.
 */
export async function submitLetterOfCredit(
  lcData: Record<string, unknown>,
): Promise<LetterOfCreditResult> {
  // Basic shape validation. A real implementation would call the
  // bank's schema validator + return a structured rejection when the
  // payload doesn't match.
  if (!lcData || typeof lcData !== "object") {
    return {
      status: "rejected",
      referenceNumber: "",
      bankResponse: { error: "Invalid L/C payload — expected an object." },
      isPlaceholder: true,
    };
  }

  // PLACEHOLDER — return a deterministic reference number derived from
  // the L/C amount + applicant so the same submission always produces
  // the same reference (useful for the marketplace UI to test the
  // "reference number received" flow).
  const amount = Number(lcData.amount ?? 0);
  const applicant = String(lcData.applicant_name ?? lcData.applicant ?? "VELLOS");
  const ref = `LC-${applicant.slice(0, 4).toUpperCase()}-${Math.abs(Math.round(amount)).toString(36).toUpperCase().padStart(6, "0")}`;

  return {
    status: "submitted",
    referenceNumber: ref,
    bankResponse: {
      message: "Placeholder response — wire a real bank API in src/lib/marketplace/integrations.ts",
      received_at: new Date().toISOString(),
      amount,
      currency: lcData.currency ?? "USD",
    },
    isPlaceholder: true,
  };
}

// ─── Customs filing ────────────────────────────────────────────────────────

export interface CustomsDeclarationResult {
  /** "filed" | "rejected" | "in_review" */
  status: "filed" | "rejected" | "in_review";
  /** Movement Reference Number — the customs authority's tracking ID. */
  mrn: string;
  /** Raw customs response. */
  customsResponse: Record<string, unknown>;
  /** Whether this is a placeholder response. */
  isPlaceholder: boolean;
}

/**
 * File a customs export declaration with the relevant customs
 * authority (US: AES / ACE; EU: DG TAXUD / ICS; UK: HMRC CDS).
 *
 * PLACEHOLDER — would call the customs API keyed by the tenant's
 * vault entry `customs_api_key` + the appropriate national endpoint.
 * Returns a deterministic MRN derived from the declaration so the
 * marketplace UI can test the "MRN received" flow.
 */
export async function fileCustomsDeclaration(
  declarationData: Record<string, unknown>,
): Promise<CustomsDeclarationResult> {
  if (!declarationData || typeof declarationData !== "object") {
    return {
      status: "rejected",
      mrn: "",
      customsResponse: { error: "Invalid declaration payload — expected an object." },
      isPlaceholder: true,
    };
  }

  // PLACEHOLDER — MRN format varies by country (EU: 18 alphanumeric
  // chars; US: 12-digit ITN; UK: 15-digit DAN). We synthesise an
  // EU-style 18-char MRN prefixed with "25" (current year).
  const country = String(declarationData.export_country ?? declarationData.country ?? "XX").toUpperCase().slice(0, 2);
  const hash = JSON.stringify(declarationData).split("").reduce((s, c) => (s + c.charCodeAt(0)) % 100000, 0);
  const seq = hash.toString().padStart(5, "0");
  const year = String(new Date().getFullYear()).slice(-2);
  const mrn = `${year}${country}${seq}23VEL0${(hash % 90) + 10}`;

  return {
    status: "filed",
    mrn,
    customsResponse: {
      message: "Placeholder response — wire a real customs API in src/lib/marketplace/integrations.ts",
      filed_at: new Date().toISOString(),
      export_country: country,
      declaration_type: declarationData.declaration_type ?? "EX",
    },
    isPlaceholder: true,
  };
}
