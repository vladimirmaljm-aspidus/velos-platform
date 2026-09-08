"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Loader2,
  Send,
  ChevronLeft,
  ChevronRight,
  Check,
  Save,
  Sparkles,
  Package,
  Coins,
  Truck,
  ClipboardList,
  CheckCircle2,
  Tag,
  Ruler,
  FileText,
  Gavel,
  Clock,
  Info,
  AlertTriangle,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { useAppStore } from "@/lib/store/app-store";
import { toast } from "sonner";
import {
  COUNTRIES,
  PRODUCT_CATEGORIES,
  UNITS_OF_MEASURE,
  INCOTERMS,
  CURRENCIES,
} from "@/lib/data/reference";
import { cn } from "@/lib/utils";
import type { MarketplacePostType, MarketplacePriceType, MarketplacePostStatus, MarketplaceVisibility } from "@/lib/supabase/marketplace-types";
import type { AuctionType } from "@/lib/supabase/marketplace-auction-types";
import { SmartPricing } from "./smart-pricing";
import { DocumentScanner, type DocumentScannerFillPayload } from "./document-scanner";

/**
 * UI-3 step 4 — Create-post wizard.
 *
 * Replaces the Phase-1 single-form layout with a 5-step wizard:
 *   1. Type (Buy/Sell) + Product name + Category
 *   2. Quantity + Unit + Price
 *   3. Delivery (location, date, incoterm)
 *   4. Specifications (optional)
 *   5. Review and Publish
 *
 * Each step shows a progress indicator + a back/continue pair. The
 * DocumentScanner (Phase 5) still lives on Step 1 so a scanned CoA can
 * pre-fill the whole form; SmartPricing stays on Step 2 next to the price.
 * A "Save as draft" button on Step 5 lets the user publish later.
 */
const STEPS = [
  { key: "type", icon: Tag, titleKey: "marketplace-wizard-step-1" },
  { key: "quantity", icon: Ruler, titleKey: "marketplace-wizard-step-2" },
  { key: "delivery", icon: Truck, titleKey: "marketplace-wizard-step-3" },
  { key: "specs", icon: ClipboardList, titleKey: "marketplace-wizard-step-4" },
  { key: "review", icon: CheckCircle2, titleKey: "marketplace-wizard-step-5" },
] as const;

/** A handful of common commodity product names used for autosuggest. */
const COMMON_PRODUCTS: string[] = [
  "Refined White Sugar ICUMSA 45",
  "Raw Brown Sugar ICUMSA 600",
  "Sunflower Oil Refined",
  "Soybean Oil Crude",
  "Wheat Hard Red Winter",
  "Yellow Corn Grade 2",
  "Portland Cement 42.5 N",
  "Hot Rolled Steel Coil",
  "Cold Rolled Steel Coil",
  "Aluminium Ingot A7",
  "Copper Cathode Grade A",
  "Urea 46% N",
  "Diesel Gas Oil 0.2% Sulfur",
  "Coal Anthracite",
  "Cement Clinker",
  "Reinforcing Steel Bars",
  "White Cement 52.5 N",
  "Palm Oil RBD",
  "Refined Sunflower Oil Bottled",
  "White Maize",
];

interface FormState {
  post_type: MarketplacePostType;
  product_name: string;
  product_category: string;
  product_subcategory: string;
  quantity: string;
  unit: string;
  target_price: string;
  price_max: string;
  price_visible: boolean;
  currency: string;
  price_type: MarketplacePriceType;
  delivery_location: string;
  delivery_country: string;
  delivery_date: string;
  incoterm: string;
  origin_country: string;
  packaging: string;
  payment_terms: string;
  description: string;
  specifications: Record<string, string>;
  quality_specs: string[];
  status: MarketplacePostStatus;
  visibility: MarketplaceVisibility;
  // ── Auction parameters (100 — only submitted when post_type ===
  //    "auction"; type + start + ends are REQUIRED for auctions, mirroring
  //    the shared validateAuctionParams on POST/PUT). Stored as strings —
  //    they come from text inputs and are coerced at submit time.
  auction_type: AuctionType;
  auction_start_price: string;
  auction_reserve_price: string;
  /** datetime-local value (converted to ISO at submit). */
  auction_ends_at: string;
  auction_min_increment: string;
}

/** GET /api/marketplace/categories — active curated taxonomy (099). */
interface MarketplaceCategoryItem {
  id: string;
  name: string;
  slug: string;
}

/** GET /api/marketplace/settings — the caller's tenant policy (099). */
interface MarketplaceSettingsResponse {
  settings: {
    enabled: boolean;
    posting_policy: string;
    require_approval: boolean;
    default_visibility: string;
    allow_private_posts: boolean;
  };
}

/**
 * Edit-mode source post — the shape GET /api/marketplace/[id] returns for
 * the post OWNER (the full row). Every field except `id` is optional so
 * the My-Posts row (a subset) also satisfies it; the wizard re-fetches
 * the full detail on open and merges it over the prop before prefilling.
 */
export interface MarketplaceEditPost {
  id: string;
  post_type?: MarketplacePostType;
  product_name?: string;
  product_category?: string | null;
  product_subcategory?: string | null;
  quantity?: number;
  unit?: string;
  target_price?: number | null;
  price_max?: number | null;
  price_visible?: boolean;
  price_type?: MarketplacePriceType;
  currency?: string;
  delivery_location?: string | null;
  delivery_country?: string | null;
  delivery_date?: string | null;
  incoterm?: string | null;
  origin_country?: string | null;
  packaging?: string | null;
  payment_terms?: string | null;
  description?: string | null;
  specifications?: Record<string, unknown> | null;
  quality_specs?: unknown[] | null;
  status?: string;
  visibility?: MarketplaceVisibility;
  auction_type?: AuctionType | null;
  auction_start_price?: number | null;
  auction_reserve_price?: number | null;
  auction_ends_at?: string | null;
  auction_min_increment?: number | null;
}

/** ISO timestamp → "YYYY-MM-DDTHH:mm" for datetime-local inputs. */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO timestamp → "YYYY-MM-DD" for date inputs. */
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Prefill the wizard from an (owner-view) post object. */
function formFromPost(p: MarketplaceEditPost): FormState {
  const specs =
    p.specifications && typeof p.specifications === "object" && !Array.isArray(p.specifications)
      ? (p.specifications as Record<string, string>)
      : {};
  const qualitySpecs = Array.isArray(p.quality_specs)
    ? p.quality_specs.filter((s): s is string => typeof s === "string")
    : [];
  return {
    post_type: p.post_type ?? "sell",
    product_name: p.product_name ?? "",
    product_category: p.product_category ?? "",
    product_subcategory: p.product_subcategory ?? "",
    quantity: p.quantity != null ? String(p.quantity) : "",
    unit: p.unit || "MT",
    target_price: p.target_price != null ? String(p.target_price) : "",
    price_max: p.price_max != null ? String(p.price_max) : "",
    price_visible: p.price_visible !== false,
    currency: p.currency || "USD",
    price_type: p.price_type ?? "fixed",
    delivery_location: p.delivery_location ?? "",
    delivery_country: p.delivery_country ?? "",
    delivery_date: isoToDateInput(p.delivery_date),
    incoterm: p.incoterm ?? "",
    origin_country: p.origin_country ?? "",
    packaging: p.packaging ?? "",
    payment_terms: p.payment_terms ?? "",
    description: p.description ?? "",
    specifications: specs,
    quality_specs: qualitySpecs,
    status: (p.status as MarketplacePostStatus) ?? "active",
    visibility: p.visibility ?? "public",
    auction_type: p.auction_type ?? "english",
    auction_start_price: p.auction_start_price != null ? String(p.auction_start_price) : "",
    auction_reserve_price: p.auction_reserve_price != null ? String(p.auction_reserve_price) : "",
    auction_ends_at: isoToLocalInput(p.auction_ends_at),
    auction_min_increment: p.auction_min_increment != null ? String(p.auction_min_increment) : "1",
  };
}

/**
 * Build the wizard's API payload from the current form (shared by the
 * create POST and the edit PUT). Auction parameters are included ONLY
 * for auction posts — the server 400s ("Auction parameters can only be
 * set on auction posts.") when they appear on any other type.
 */
function buildFormPayload(
  f: FormState,
  opts: { visibility: MarketplaceVisibility; status: MarketplacePostStatus },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    post_type: f.post_type,
    product_name: f.product_name,
    quantity: Number(f.quantity),
    unit: f.unit,
    currency: f.currency,
    price_type: f.price_type,
    price_visible: f.price_visible,
    status: opts.status,
    visibility: opts.visibility,
    description: f.description || null,
  };
  if (f.product_category) payload.product_category = f.product_category;
  if (f.product_subcategory) payload.product_subcategory = f.product_subcategory;
  if (Object.keys(f.specifications).length > 0) {
    payload.specifications = f.specifications;
  }
  if (f.quality_specs.length > 0) {
    payload.quality_specs = f.quality_specs;
  }
  if (f.target_price) payload.target_price = Number(f.target_price);
  if (f.price_max) payload.price_max = Number(f.price_max);
  if (f.delivery_location) payload.delivery_location = f.delivery_location;
  if (f.delivery_country) payload.delivery_country = f.delivery_country;
  if (f.delivery_date) payload.delivery_date = new Date(f.delivery_date).toISOString();
  if (f.incoterm) payload.incoterm = f.incoterm;
  if (f.origin_country) payload.origin_country = f.origin_country;
  if (f.packaging) payload.packaging = f.packaging;
  if (f.payment_terms) payload.payment_terms = f.payment_terms;
  if (f.post_type === "auction") {
    // Contract (1-a): type + start + ends REQUIRED for auctions;
    // reserve ≥ 0 optional; increment ≥ 1 (default 1). Client-side
    // validation (auctionFieldErrors) gates the submit buttons, so these
    // values are trusted here.
    payload.auction_type = f.auction_type;
    if (f.auction_start_price) payload.auction_start_price = Number(f.auction_start_price);
    if (f.auction_reserve_price !== "") {
      payload.auction_reserve_price = Number(f.auction_reserve_price);
    }
    if (f.auction_ends_at) {
      payload.auction_ends_at = new Date(f.auction_ends_at).toISOString();
    }
    if (f.auction_min_increment) {
      payload.auction_min_increment = Number(f.auction_min_increment);
    }
  }
  return payload;
}

/**
 * Form keys whose cleared value ("") means "remove the stored value" —
 * in edit mode the PUT must send an explicit null for them, otherwise an
 * absent key is simply not patched and the old value silently survives.
 */
const CLEARABLE_FIELDS = [
  "product_category",
  "product_subcategory",
  "target_price",
  "price_max",
  "delivery_location",
  "delivery_country",
  "delivery_date",
  "incoterm",
  "origin_country",
  "packaging",
  "payment_terms",
  "description",
] as const;

/**
 * Edit-mode payload diff: send ONLY the keys whose underlying FORM value
 * changed vs the prefill snapshot (all payload keys map 1:1 onto FormState
 * keys of the same name, so the comparison happens at the form level and
 * the payload value is emitted verbatim). Beyond bandwidth, this is what
 * keeps the PUT from tripping the pre-bid auction lock: untouched auction
 * parameters are simply not sent, so editing the description of an
 * auction post that already has bids stays legal — the server only 400s
 * ("Cannot change auction parameters after bids are placed.") when an
 * auction parameter is actually present in the body.
 */
function diffEditPayload(
  full: Record<string, unknown>,
  form: FormState,
  initial: FormState | null,
): Record<string, unknown> {
  if (!initial) return full;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    if (k in initial && form[k as keyof FormState] !== initial[k as keyof FormState]) {
      out[k] = v;
    }
  }
  for (const fk of CLEARABLE_FIELDS) {
    if (form[fk] === "" && initial[fk] !== "") out[fk] = null;
  }
  return out;
}

const DEFAULT_FORM: FormState = {
  post_type: "sell",
  product_name: "",
  product_category: "",
  product_subcategory: "",
  quantity: "",
  unit: "MT",
  target_price: "",
  price_max: "",
  price_visible: true,
  currency: "USD",
  price_type: "fixed",
  delivery_location: "",
  delivery_country: "",
  delivery_date: "",
  incoterm: "",
  origin_country: "",
  packaging: "",
  payment_terms: "",
  description: "",
  specifications: {},
  quality_specs: [],
  status: "active",
  visibility: "public",
  auction_type: "english",
  auction_start_price: "",
  auction_reserve_price: "",
  auction_ends_at: "",
  auction_min_increment: "1",
};

export function MarketplaceCreatePost({
  open,
  onOpenChange,
  editPost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the wizard runs in EDIT mode: the title becomes "Edit
   *  post", all five steps prefill from the post (the full owner-view row
   * is re-fetched on open — the My-Posts row alone lacks the heavy
   *  fields), and the submit becomes a PATCH-style PUT that only sends
   *  changed fields. Create mode stays 100% intact when omitted. */
  editPost?: MarketplaceEditPost;
}) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  // 099 — tenant policy awareness. `visibilityChosen` tracks whether the
  // user explicitly picked a visibility in the wizard; until then the
  // tenant's default_visibility (when private is allowed) wins.
  const [visibilityChosen, setVisibilityChosen] = useState(false);
  // 100 — auction inline errors appear after the user tries to leave step
  // 2 (or submit) with invalid auction data, not while they type.
  const [showAuctionErrors, setShowAuctionErrors] = useState(false);
  // 2-a — edit mode prefill: the post id + the FormState snapshot it
  // produced. The PUT diff (diffEditPayload) and the auction validation
  // compare the live form against the snapshot; null = create mode (send
  // the whole payload / validate everything). Kept in STATE (not a ref)
  // because the validation memo reads it during render.
  const [prefill, setPrefill] = useState<{ id: string; form: FormState } | null>(null);

  // ── Edit mode: full post detail (2-a) ───────────────────────────────
  // The editPost prop may be just the My-Posts row (no description /
  // specs / delivery / auction fields) — fetch the full owner-view row
  // from GET /api/marketplace/[id] and merge it over the prop before
  // prefilling, so all five steps (and the auction section) prefill.
  const editQ = useQuery<{ post: Record<string, unknown> }>({
    queryKey: ["marketplace-edit-post", editPost?.id],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/${editPost!.id}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: open && !!editPost,
    staleTime: 30_000,
    retry: 0,
  });

  // Prefill once per (post id, settled fetch) when the dialog opens in
  // edit mode. The settled full detail is authoritative; when the fetch
  // fails we fall back to whatever fields the prop carries. The per-id
  // guard keeps a background query refetch from clobbering user edits.
  // (An effect is unavoidable here: useState cannot initialize from a
  // fetch that resolves after mount — the same sanctioned pattern as the
  // browser's ?create=1 auto-open effect, which carries the identical
  // disable.)
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !editPost) return;
    if (editQ.isPending) return;
    if (prefill?.id === editPost.id) return;
    const fetched = (editQ.data?.post ?? {}) as Partial<MarketplaceEditPost>;
    const source: MarketplaceEditPost = { ...editPost, ...fetched };
    const prefilled = formFromPost(source);
    setPrefill({ id: editPost.id, form: prefilled });
    setForm(prefilled);
    setVisibilityChosen(true); // the post's own visibility is explicit
    setStep(0);
    setShowAuctionErrors(false);
  }, [open, editPost, editQ.isPending, editQ.data, prefill]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Categories from the API (099) ───────────────────────────────────────
  // The admin-curated marketplace_categories taxonomy replaces the hardcoded
  // PRODUCT_CATEGORIES list; on failure/empty the static list stays as the
  // fallback so the form always has options.
  const categoriesQ = useQuery<{ items: MarketplaceCategoryItem[] }>({
    queryKey: ["marketplace-categories"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/categories");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const categoryOptions = useMemo(() => {
    const apiItems = categoriesQ.data?.items ?? [];
    if (apiItems.length > 0) {
      return apiItems.map((c) => ({ value: c.name, label: c.name }));
    }
    // 2-a — posts store taxonomy NAMES since 099 (migration 100
    // normalised the legacy codes), so the fallback VALUE must be the
    // name too — a post saved with a code would be invisible to every
    // name-based feed filter.
    return PRODUCT_CATEGORIES.map((c) => ({ value: c.name, label: c.name }));
  }, [categoriesQ.data]);

  // ── Tenant settings (099) ────────────────────────────────────────────────
  // Fail-open on error (server still enforces the policy on submit): private
  // stays selectable and no approval notice is shown until we KNOW otherwise.
  const settingsQ = useQuery<MarketplaceSettingsResponse>({
    queryKey: ["marketplace-settings"],
    queryFn: async () => {
      const r = await fetch("/api/marketplace/settings");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
    retry: 1,
  });
  const tenantSettings = settingsQ.data?.settings ?? null;
  const allowPrivatePosts = tenantSettings?.allow_private_posts ?? true;
  const requireApproval = tenantSettings?.require_approval ?? false;

  // Effective visibility — derived, never stored twice:
  //   • private disallowed by the tenant → forced public
  //   • user hasn't chosen + tenant default is private (and private is
  //     allowed) → private
  //   • otherwise whatever the user picked ("public" until then)
  const effectiveVisibility: MarketplaceVisibility = !allowPrivatePosts
    ? "public"
    : !visibilityChosen && tenantSettings?.default_visibility === "private"
      ? "private"
      : form.visibility;

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // ── Document scanner → form pre-fill ──────────────────────────────────
  function applyDocumentScan(data: DocumentScannerFillPayload) {
    setForm((next) => {
      const out = { ...next };
      if (data.productName && data.productName.trim()) {
        out.product_name = data.productName.trim();
      }
      if (data.category) {
        // Prefer a category that actually exists in the current options
        // (API taxonomy first, static fallback codes second) so the
        // pre-filled value matches what the Select offers.
        const apiMatch = categoryOptions.find((c) =>
          c.label.toLowerCase().includes(data.category!.toLowerCase()),
        );
        if (apiMatch) {
          out.product_category = apiMatch.value;
        } else {
          const match = PRODUCT_CATEGORIES.find((c) =>
            c.name.toLowerCase().includes(data.category!.toLowerCase()) ||
            c.code.toLowerCase() === data.category!.toLowerCase(),
          );
          // 2-a — .name (not .code): the Select's option values are names
          // (posts store taxonomy names since 099).
          if (match) out.product_category = match.name;
        }
      }
      if (data.specifications && Object.keys(data.specifications).length > 0) {
        out.specifications = { ...out.specifications, ...data.specifications };
      }
      if (data.parameters && data.parameters.length > 0) {
        const asStrings = data.parameters
          .filter((p) => p.name || p.value)
          .map((p) => (p.name && p.value ? `${p.name}: ${p.value}` : p.name || p.value));
        out.quality_specs = Array.from(new Set([...out.quality_specs, ...asStrings]));
      }
      return out;
    });
  }

  // ── Product name autosuggest ──────────────────────────────────────────
  const productSuggestions = useMemo(() => {
    const q = form.product_name.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return COMMON_PRODUCTS.filter((p) => p.toLowerCase().includes(q)).slice(0, 5);
  }, [form.product_name]);

  // ── Auction validation (100) ────────────────────────────────────────
  // Mirrors validateAuctionParams on POST/PUT (type + start + ends
  // REQUIRED for auctions, start > 0, reserve ≥ 0, ends > now + 1h,
  // increment ≥ 1) with clear inline errors.
  //
  // EDIT-mode semantics (the server likewise only validates fields
  // PRESENT in the PUT body):
  //   • a field is REQUIRED while creating, while CONVERTING a non-auction
  //     post to an auction, or after the user CLEARED a stored value;
  //   • the ends-at "≥ now + 1h" rule applies only to fields the user
  //     actually changed — an untouched (possibly already-running)
  //     auction whose stored end date is near must not block an
  //     unrelated description edit (and it is simply not sent: see
  //     diffEditPayload).
  const auctionFieldErrors = useMemo(() => {
    const empty = { start: null, reserve: null, ends: null, increment: null };
    if (form.post_type !== "auction") return empty;
    const initial = prefill?.form ?? null;
    const createMode = !initial;
    // Creating, or converting a non-auction post into an auction.
    const becomesAuction = createMode || initial!.post_type !== "auction";
    const changed = (k: keyof FormState) => createMode || form[k] !== initial![k];
    const out: { start: string | null; reserve: string | null; ends: string | null; increment: string | null } = {
      ...empty,
    };
    // Start price — required (create / conversion / cleared), always > 0.
    if (!form.auction_start_price) {
      if (becomesAuction || initial!.auction_start_price !== "") {
        out.start = t("marketplace-auction-error-start-required");
      }
    } else if (!(Number(form.auction_start_price) > 0)) {
      out.start = t("marketplace-auction-error-start-invalid");
    }
    // Reserve — optional, never negative.
    if (
      form.auction_reserve_price !== "" &&
      Number(form.auction_reserve_price) < 0
    ) {
      out.reserve = t("marketplace-auction-error-reserve");
    }
    // End date — required (create / conversion / cleared); must be a valid
    // datetime ≥ now + 1h when it matters (changed or new).
    if (!form.auction_ends_at) {
      if (becomesAuction || initial!.auction_ends_at !== "") {
        out.ends = t("marketplace-auction-error-ends-required");
      }
    } else if (becomesAuction || changed("auction_ends_at")) {
      const d = new Date(form.auction_ends_at);
      if (Number.isNaN(d.getTime())) {
        out.ends = t("marketplace-auction-error-ends-required");
      } else if (d.getTime() <= Date.now() + 60 * 60 * 1000) {
        out.ends = t("marketplace-auction-error-ends-future");
      }
    }
    // Min increment — optional, ≥ 1 when set.
    if (
      form.auction_min_increment !== "" &&
      !(Number(form.auction_min_increment) >= 1)
    ) {
      out.increment = t("marketplace-auction-error-increment");
    }
    return out;
  }, [form, t, prefill]);
  const auctionHasErrors =
    auctionFieldErrors.start != null ||
    auctionFieldErrors.reserve != null ||
    auctionFieldErrors.ends != null ||
    auctionFieldErrors.increment != null;

  // ── Save / publish mutation (create POST) + edit PUT (2-a) ───────────
  const create = useMutation({
    mutationFn: async (mode: "publish" | "draft") => {
      const full = buildFormPayload(form, {
        visibility: effectiveVisibility,
        status: mode === "draft" ? "draft" : form.status,
      });

      if (editPost) {
        // Edit mode — PATCH-style PUT: only the changed keys (plus explicit
        // nulls for cleared optional fields). An empty diff is a no-op.
        const payload = diffEditPayload(full, form, prefill?.form ?? null);
        // When the post is BECOMING an auction (post_type is in the diff),
        // the server requires the whole defining set (type + start + ends)
        // in the body — the diff may have dropped an unchanged default
        // (e.g. the "english" type default), so merge the full auction
        // set back in. For an already-auction post whose post_type is NOT
        // in the diff, untouched auction params stay out of the body,
        // keeping pre-bid/with-bid edits of unrelated fields legal.
        if (payload.post_type === "auction") {
          for (const k of [
            "auction_type",
            "auction_start_price",
            "auction_reserve_price",
            "auction_ends_at",
            "auction_min_increment",
          ]) {
            if (k in full) payload[k] = full[k];
          }
        }
        if (Object.keys(payload).length === 0) {
          return { id: editPost.id, unchanged: true as const };
        }
        const r = await fetch(`/api/marketplace/${editPost.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || "Failed to update post.");
        }
        return r.json();
      }

      const r = await fetch("/api/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(full),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create post.");
      }
      return r.json();
    },
    onSuccess: (created: { id?: string; status?: string; unchanged?: boolean }, mode) => {
      if (editPost) {
        // Edit success — refresh the lists + the cached edit source, no
        // drill-down (the user is already looking at their own post row).
        toast.success(t("marketplace-post-updated"));
        qc.invalidateQueries({ queryKey: ["marketplace-my-posts"] });
        qc.invalidateQueries({ queryKey: ["marketplace-list"] });
        qc.invalidateQueries({ queryKey: ["marketplace-edit-post"] });
        onOpenChange(false);
        return;
      }
      // 099 — moderated tenants: the server converts an "active" create into
      // "pending" (awaiting admin approval). Toast the approval message
      // instead of the plain "created" one so the poster isn't surprised the
      // post hasn't appeared in the feed yet.
      toast.success(
        mode === "draft"
          ? t("marketplace-wizard-draft-saved")
          : created.status === "pending"
            ? t("marketplace-publish-pending")
            : t("marketplace-post-created"),
      );
      qc.invalidateQueries({ queryKey: ["marketplace-list"] });
      qc.invalidateQueries({ queryKey: ["marketplace-my-posts"] });
      onOpenChange(false);
      setForm(DEFAULT_FORM);
      setVisibilityChosen(false);
      setStep(0);
      // Drill into the new post only when publishing — drafts stay list-only.
      if (mode === "publish" && created.id) setSelectedId(created.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Per-step gating ───────────────────────────────────────────────────
  const stepErrors: Record<number, string | null> = {
    0: form.product_name.trim().length === 0 ? t("marketplace-wizard-required-product") : null,
    1:
      !(Number(form.quantity) > 0)
        ? t("marketplace-wizard-required-quantity")
        : form.post_type === "auction" && auctionHasErrors
          ? t("marketplace-auction-error-summary")
          : null,
    2: null,
    3: null,
    4: null,
  };
  const canContinue = (s: number) => !stepErrors[s];
  // Auction drafts are impossible (the server validates the defining
  // params on EVERY auction create regardless of status) — gate the
  // draft button the same way as publish.
  const canPublish =
    stepErrors[0] === null && stepErrors[1] === null && !create.isPending;

  function next() {
    if (!canContinue(step)) {
      if (step === 1 && form.post_type === "auction") setShowAuctionErrors(true);
      toast.error(stepErrors[step] as string);
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStep((s) => Math.max(s - 1, 0));
  }
  function reset() {
    if (editPost && prefill) {
      // Edit mode — restore the prefilled snapshot.
      setForm(prefill.form);
      setStep(0);
      setShowAuctionErrors(false);
      return;
    }
    setForm(DEFAULT_FORM);
    setVisibilityChosen(false);
    setStep(0);
    setShowAuctionErrors(false);
  }

  // Reset everything when the dialog closes so reopening starts fresh.
  function handleOpenChange(o: boolean) {
    if (!o) {
      setForm(DEFAULT_FORM);
      setVisibilityChosen(false);
      setStep(0);
      setShowAuctionErrors(false);
      setPrefill(null);
    }
    onOpenChange(o);
  }

  const StepIcon = STEPS[step].icon;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[98vw] max-w-4xl max-h-[92vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2">
            <StepIcon className="size-5 text-emerald-700 dark:text-emerald-400" />
            {editPost ? t("marketplace-edit-post") : t("marketplace-create-post")}
          </DialogTitle>
          <DialogDescription>{t("marketplace-create-post-desc")}</DialogDescription>
        </DialogHeader>

        {/* ─── Progress indicator ──────────────────────────────────────── */}
        <div className="shrink-0 px-6 pt-4 space-y-2">
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const done = i < step;
            const active = i === step;
            return (
              <div key={s.key} className="flex items-center gap-1.5 flex-1">
                <div
                  className={cn(
                    "size-7 rounded-full flex items-center justify-center shrink-0 smooth border text-xs font-semibold tabular",
                    done && "bg-emerald-500 border-emerald-500 text-white",
                    active && "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
                    !done && !active && "bg-muted border-border text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                </div>
                <div className="flex-1 hidden sm:block">
                  <p
                    className={cn(
                      "text-xs font-medium truncate",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {t(s.titleKey)}
                  </p>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={cn("h-px flex-1 mx-1 hidden sm:block", done ? "bg-emerald-500" : "bg-border")} />
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground text-center sm:text-left">
          {t("marketplace-wizard-progress").replace("{n}", String(step + 1)).replace("{total}", String(STEPS.length))}
        </p>
        </div>

        <Separator />

        {/* ─── Step content ────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
          {/* 2-a — edit mode: the full-detail fetch is in flight. Render a
              loader INSTEAD of the (empty) form so the prefill can never
              clobber anything the user typed. */}
          {editPost && editQ.isPending && prefill?.id !== editPost.id ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">{t("marketplace-skeleton-loading")}</p>
            </div>
          ) : (
          <>
          {/* STEP 1 — type + product + category */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold">{t("marketplace-wizard-step-1-title")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{t("marketplace-wizard-step-1-sub")}</p>
              </div>

              {/* Phase 5: DocumentScanner */}
              <DocumentScanner onFill={applyDocumentScan} />

              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("marketplace-post-type")}</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(["sell", "buy", "auction", "contract"] as MarketplacePostType[]).map((tp) => {
                    const active = form.post_type === tp;
                    return (
                      <Button
                        key={tp}
                        type="button"
                        variant={active ? "default" : "outline"}
                        size="sm"
                        onClick={() => set("post_type", tp)}
                        className={cn(active && "shadow-soft")}
                      >
                        {t(`marketplace-${tp}`)}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="p-name" className="text-sm font-medium">
                  {t("marketplace-product-name")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="p-name"
                  value={form.product_name}
                  onChange={(e) => set("product_name", e.target.value)}
                  maxLength={500}
                  placeholder={t("marketplace-product-name")}
                />
                {/* Auto-suggest */}
                {productSuggestions.length > 0 && (
                  <div className="rounded-lg border border-border/60 bg-card p-2 space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1.5 inline-flex items-center gap-1">
                      <Sparkles className="size-3" />
                      {t("marketplace-wizard-product-suggestions")}
                    </p>
                    {productSuggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => set("product_name", s)}
                        className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-accent smooth truncate"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="p-cat" className="text-sm font-medium">{t("marketplace-product-category")}</Label>
                  <Select value={form.product_category} onValueChange={(v) => set("product_category", v)}>
                    <SelectTrigger id="p-cat"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      {categoryOptions.map((c) => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-subcat" className="text-sm font-medium">{t("marketplace-product-subcategory")}</Label>
                  <Input
                    id="p-subcat"
                    value={form.product_subcategory}
                    onChange={(e) => set("product_subcategory", e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 2 — quantity + price */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold">{t("marketplace-wizard-step-2-title")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{t("marketplace-wizard-step-2-sub")}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="p-qty" className="text-sm font-medium">
                    {t("marketplace-quantity")} <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="p-qty"
                    type="number"
                    value={form.quantity}
                    onChange={(e) => set("quantity", e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-unit" className="text-sm font-medium">{t("marketplace-unit")}</Label>
                  <Select value={form.unit} onValueChange={(v) => set("unit", v)}>
                    <SelectTrigger id="p-unit"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {UNITS_OF_MEASURE.map((u) => (
                        <SelectItem key={u.code} value={u.code}>{u.name} ({u.code})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("marketplace-price-type")}</Label>
                <Select value={form.price_type} onValueChange={(v) => set("price_type", v as MarketplacePriceType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">{t("marketplace-price-fixed")}</SelectItem>
                    <SelectItem value="range">{t("marketplace-price-range")}</SelectItem>
                    <SelectItem value="on_request">{t("marketplace-price-on-request")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.price_type !== "on_request" && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="p-price" className="text-sm font-medium">{t("marketplace-target-price")}</Label>
                    <Input
                      id="p-price"
                      type="number"
                      value={form.target_price}
                      onChange={(e) => set("target_price", e.target.value)}
                      placeholder="0.00"
                    />
                  </div>
                  {form.price_type === "range" && (
                    <div className="space-y-2">
                      <Label htmlFor="p-pmax" className="text-sm font-medium">{t("marketplace-price-max")}</Label>
                      <Input
                        id="p-pmax"
                        type="number"
                        value={form.price_max}
                        onChange={(e) => set("price_max", e.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="p-curr" className="text-sm font-medium">{t("marketplace-currency")}</Label>
                    <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                      <SelectTrigger id="p-curr"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.slice(0, 12).map((c) => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.price_visible}
                  onChange={(e) => set("price_visible", e.target.checked)}
                  className="h-4 w-4"
                />
                {t("marketplace-price-visible")}
              </label>

              {/* 100 — auction parameters (ONLY for auction posts; the
                  server 400s when they appear on any other type). Contract:
                  type + start + ends REQUIRED, start > 0, reserve ≥ 0,
                  ends > now + 1h, increment ≥ 1 (default 1). */}
              {form.post_type === "auction" && (
                <div className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-3.5">
                  <div className="flex items-center gap-1.5">
                    <Gavel className="size-4 text-primary" aria-hidden="true" />
                    <p className="text-sm font-semibold">{t("marketplace-auction-settings-title")}</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="p-auction-type" className="text-sm font-medium">
                        {t("marketplace-auction-type")}
                      </Label>
                      <Select
                        value={form.auction_type}
                        onValueChange={(v) => set("auction_type", v as AuctionType)}
                      >
                        <SelectTrigger id="p-auction-type"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="english">{t("marketplace-auction-type-english")}</SelectItem>
                          <SelectItem value="dutch">{t("marketplace-auction-type-dutch")}</SelectItem>
                          <SelectItem value="sealed">{t("marketplace-auction-type-sealed")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="p-auction-start" className="text-sm font-medium">
                        {t("marketplace-auction-start-price")} <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="p-auction-start"
                        type="number"
                        min="0"
                        step="any"
                        value={form.auction_start_price}
                        onChange={(e) => set("auction_start_price", e.target.value)}
                        placeholder="0.00"
                      />
                      {showAuctionErrors && auctionFieldErrors.start && (
                        <p className="text-xs text-destructive">{auctionFieldErrors.start}</p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="p-auction-reserve" className="text-sm font-medium">
                        {t("marketplace-auction-reserve-price")}
                      </Label>
                      <Input
                        id="p-auction-reserve"
                        type="number"
                        min="0"
                        step="any"
                        value={form.auction_reserve_price}
                        onChange={(e) => set("auction_reserve_price", e.target.value)}
                        placeholder="—"
                      />
                      {showAuctionErrors && auctionFieldErrors.reserve && (
                        <p className="text-xs text-destructive">{auctionFieldErrors.reserve}</p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="p-auction-ends" className="text-sm font-medium">
                        {t("marketplace-auction-ends-at")} <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="p-auction-ends"
                        type="datetime-local"
                        min={isoToLocalInput(new Date(Date.now() + 60 * 60 * 1000).toISOString())}
                        value={form.auction_ends_at}
                        onChange={(e) => set("auction_ends_at", e.target.value)}
                      />
                      {showAuctionErrors && auctionFieldErrors.ends && (
                        <p className="text-xs text-destructive">{auctionFieldErrors.ends}</p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="p-auction-incr" className="text-sm font-medium">
                        {t("marketplace-auction-min-increment")}
                      </Label>
                      <Input
                        id="p-auction-incr"
                        type="number"
                        min="1"
                        step="1"
                        value={form.auction_min_increment}
                        onChange={(e) => set("auction_min_increment", e.target.value)}
                      />
                      {showAuctionErrors && auctionFieldErrors.increment && (
                        <p className="text-xs text-destructive">{auctionFieldErrors.increment}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {form.price_type !== "on_request" && (
                <SmartPricing
                  productName={form.product_name}
                  targetPrice={form.target_price ? Number(form.target_price) : null}
                  currency={form.currency}
                />
              )}
            </div>
          )}

          {/* STEP 3 — delivery */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold">{t("marketplace-wizard-step-3-title")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{t("marketplace-wizard-step-3-sub")}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="p-dloc" className="text-sm font-medium">{t("marketplace-delivery-location")}</Label>
                  <Input
                    id="p-dloc"
                    value={form.delivery_location}
                    onChange={(e) => set("delivery_location", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-dcountry" className="text-sm font-medium">{t("marketplace-delivery-country")}</Label>
                  <Select value={form.delivery_country} onValueChange={(v) => set("delivery_country", v)}>
                    <SelectTrigger id="p-dcountry"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-ddate" className="text-sm font-medium">{t("marketplace-delivery-date")}</Label>
                  <Input
                    id="p-ddate"
                    type="date"
                    value={form.delivery_date}
                    onChange={(e) => set("delivery_date", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-inco" className="text-sm font-medium">{t("marketplace-incoterm")}</Label>
                  <Select value={form.incoterm} onValueChange={(v) => set("incoterm", v)}>
                    <SelectTrigger id="p-inco"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      {INCOTERMS.map((i) => (
                        <SelectItem key={i.code} value={i.code}>{i.code} — {i.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-orig" className="text-sm font-medium">{t("marketplace-origin-country")}</Label>
                  <Select value={form.origin_country} onValueChange={(v) => set("origin_country", v)}>
                    <SelectTrigger id="p-orig"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="p-pack" className="text-sm font-medium">{t("marketplace-packaging")}</Label>
                  <Input
                    id="p-pack"
                    value={form.packaging}
                    onChange={(e) => set("packaging", e.target.value)}
                    placeholder="25 kg bags, 1 ton pallets, etc."
                  />
                </div>
                <div className="sm:col-span-2 space-y-2">
                  <Label htmlFor="p-pay" className="text-sm font-medium">{t("marketplace-payment-terms")}</Label>
                  <Input
                    id="p-pay"
                    value={form.payment_terms}
                    onChange={(e) => set("payment_terms", e.target.value)}
                    placeholder="L/C, T/T 30%, etc."
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP 4 — specifications (optional) */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold">{t("marketplace-wizard-step-4-title")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{t("marketplace-wizard-step-4-sub")}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="p-desc" className="text-sm font-medium">{t("marketplace-description")}</Label>
                <Textarea
                  id="p-desc"
                  rows={4}
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  maxLength={5000}
                  placeholder={t("marketplace-description")}
                />
              </div>

              <Separator />

              {/* Quality specs as comma-separated strings — same JSONB array
                  shape the API expects. */}
              <div className="space-y-2">
                <Label htmlFor="p-qspec" className="text-sm font-medium">
                  {t("marketplace-quality-specs")}
                </Label>
                <Input
                  id="p-qspec"
                  value={form.quality_specs.join(", ")}
                  onChange={(e) =>
                    set(
                      "quality_specs",
                      e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="Moisture: 14% max, Protein: 12% min, …"
                />
                <p className="text-xs text-muted-foreground">
                  Separate specs with commas — they'll show up as badges on the post.
                </p>
                {form.quality_specs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {form.quality_specs.map((s, i) => (
                      <Badge
                        key={i}
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400 font-normal"
                      >
                        <CheckCircle2 className="size-3 mr-1" />
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="p-vis" className="text-sm font-medium">{t("marketplace-visibility")}</Label>
                {/* 099 — tenant policy: the "Private — only via direct link"
                    option disappears when the tenant disallows private posts
                    (the derived effectiveVisibility is then forced public). */}
                <Select
                  value={effectiveVisibility}
                  onValueChange={(v) => {
                    set("visibility", v as MarketplaceVisibility);
                    setVisibilityChosen(true);
                  }}
                >
                  <SelectTrigger id="p-vis"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">{t("marketplace-visibility-public")}</SelectItem>
                    {allowPrivatePosts && (
                      <SelectItem value="private">{t("marketplace-visibility-private")}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* STEP 5 — review & publish */}
          {step === 4 && (
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold">{t("marketplace-wizard-review-title")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{t("marketplace-wizard-review-subtitle")}</p>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/20 divide-y divide-border/40">
                <ReviewRow icon={Tag} label={t("marketplace-post-type")} value={t(`marketplace-${form.post_type}`)} />
                <ReviewRow icon={Package} label={t("marketplace-product-name")} value={form.product_name || "—"} />
                <ReviewRow
                  icon={Coins}
                  label={t("marketplace-quantity")}
                  value={form.quantity ? `${Number(form.quantity).toLocaleString()} ${form.unit}` : "—"}
                />
                <ReviewRow
                  icon={Coins}
                  label={t("marketplace-price")}
                  value={
                    form.price_type === "on_request"
                      ? t("marketplace-price-on-request")
                      : form.target_price
                        ? `${fmtPreview(form.target_price, form.currency)}${
                            form.price_type === "range" && form.price_max ? " – " + fmtPreview(form.price_max, form.currency) : ""
                          }`
                        : "—"
                  }
                />
                <ReviewRow
                  icon={Truck}
                  label={t("marketplace-delivery")}
                  value={[form.delivery_location, form.delivery_country].filter(Boolean).join(", ") || "—"}
                />
                {form.incoterm && (
                  <ReviewRow icon={FileText} label={t("marketplace-incoterm")} value={form.incoterm} />
                )}
                {/* 100 — auction summary lines. */}
                {form.post_type === "auction" && (
                  <>
                    <ReviewRow
                      icon={Gavel}
                      label={t("marketplace-auction-type")}
                      value={t(`marketplace-auction-type-${form.auction_type}`)}
                    />
                    <ReviewRow
                      icon={Gavel}
                      label={t("marketplace-auction-start-price")}
                      value={
                        form.auction_start_price
                          ? fmtPreview(form.auction_start_price, form.currency)
                          : "—"
                      }
                    />
                    {form.auction_reserve_price !== "" && (
                      <ReviewRow
                        icon={Gavel}
                        label={t("marketplace-auction-reserve-price")}
                        value={fmtPreview(form.auction_reserve_price, form.currency)}
                      />
                    )}
                    <ReviewRow
                      icon={Clock}
                      label={t("marketplace-auction-ends-at")}
                      value={
                        form.auction_ends_at
                          ? new Date(form.auction_ends_at).toLocaleString()
                          : "—"
                      }
                    />
                    {form.auction_min_increment && (
                      <ReviewRow
                        icon={Gavel}
                        label={t("marketplace-auction-min-increment")}
                        value={form.auction_min_increment}
                      />
                    )}
                  </>
                )}
                {form.quality_specs.length > 0 && (
                  <ReviewRow
                    icon={CheckCircle2}
                    label={t("marketplace-quality-specs")}
                    value={`${form.quality_specs.length} spec${form.quality_specs.length === 1 ? "" : "s"}`}
                  />
                )}
              </div>

              {form.quality_specs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.quality_specs.map((s, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400 font-normal"
                    >
                      <CheckCircle2 className="size-3 mr-1" />
                      {s}
                    </Badge>
                  ))}
                </div>
              )}

              {/* 100 — invalid auction data reached the review step: show
                  why Save/Publish is disabled and point back to step 2. */}
              {step === 4 && form.post_type === "auction" && auctionHasErrors && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
                  <AlertTriangle className="size-4 shrink-0 text-destructive mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    {t("marketplace-auction-error-summary")}
                  </p>
                </div>
              )}
            </div>
          )}
          </>
          )}
        </div>

        {/* ─── Wizard navigation ─────────────────────────────────────────── */}
        <div className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4 space-y-2">
        <Separator />
        {/* 099 — moderated tenants: approval notice next to the submit
            button on the review step so the poster knows what happens
            after they hit Publish. */}
        {step === STEPS.length - 1 && requireApproval && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
            <Info className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              {t("marketplace-approval-notice")}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={back}
              disabled={step === 0 || create.isPending}
              className="gap-1"
            >
              <ChevronLeft className="size-4" />
              {t("marketplace-wizard-back")}
            </Button>
          </div>

          <div className="flex gap-2 ml-auto">
            {/* Save as draft — visible from step 2 onwards so the user has
                filled in at least the product name. Hidden in edit mode:
                switching an existing post's status is a state-machine
                transition (e.g. active→draft is invalid — 409), and the
                My-Posts "Publish" button already handles draft→active. */}
            {!editPost && step >= 1 && step !== 4 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => create.mutate("draft")}
                disabled={
                  create.isPending ||
                  !form.product_name.trim() ||
                  (form.post_type === "auction" && auctionHasErrors)
                }
                className="gap-1"
              >
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t("marketplace-wizard-save-draft")}
              </Button>
            )}

            {step < STEPS.length - 1 ? (
              <Button onClick={next} size="sm" disabled={create.isPending} className="gap-1">
                {t("marketplace-wizard-next")}
                <ChevronRight className="size-4" />
              </Button>
            ) : (
              <Button
                onClick={() => create.mutate("publish")}
                disabled={!canPublish}
                size="sm"
                className="gap-1"
              >
                {create.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : editPost ? (
                  <Save className="size-4" />
                ) : (
                  <Send className="size-4" />
                )}
                {editPost
                  ? t("portal-action-save-changes")
                  : t("marketplace-wizard-publish")}
              </Button>
            )}
          </div>
        </div>

        {/* Reset link — only on step 1, subtle. */}
        {step === 0 && (
          <p className="text-xs text-muted-foreground text-center">
            <button
              type="button"
              onClick={reset}
              className="hover:text-foreground smooth underline-offset-2 hover:underline"
            >
              {t("marketplace-wizard-reset-form")}
            </button>
          </p>
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function fmtPreview(price: string, currency: string): string {
  const n = Number(price);
  if (!isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function ReviewRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-xs text-muted-foreground inline-flex items-center gap-2">
        <Icon className="size-3.5" />
        {label}
      </span>
      <span className="text-sm font-medium text-right truncate max-w-[60%]">{value}</span>
    </div>
  );
}
