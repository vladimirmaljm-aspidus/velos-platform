"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
};

export function MarketplaceCreatePost({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const setSelectedId = useAppStore((s) => s.setSelectedId);
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);

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
        const match = PRODUCT_CATEGORIES.find((c) =>
          c.name.toLowerCase().includes(data.category!.toLowerCase()) ||
          c.code.toLowerCase() === data.category!.toLowerCase(),
        );
        if (match) out.product_category = match.code;
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

  // ── Save / publish mutation ───────────────────────────────────────────
  const create = useMutation({
    mutationFn: async (mode: "publish" | "draft") => {
      const payload: Record<string, unknown> = {
        post_type: form.post_type,
        product_name: form.product_name,
        quantity: Number(form.quantity),
        unit: form.unit,
        currency: form.currency,
        price_type: form.price_type,
        price_visible: form.price_visible,
        status: mode === "draft" ? "draft" : form.status,
        visibility: form.visibility,
        description: form.description || null,
      };
      if (form.product_category) payload.product_category = form.product_category;
      if (form.product_subcategory) payload.product_subcategory = form.product_subcategory;
      if (Object.keys(form.specifications).length > 0) {
        payload.specifications = form.specifications;
      }
      if (form.quality_specs.length > 0) {
        payload.quality_specs = form.quality_specs;
      }
      if (form.target_price) payload.target_price = Number(form.target_price);
      if (form.price_max) payload.price_max = Number(form.price_max);
      if (form.delivery_location) payload.delivery_location = form.delivery_location;
      if (form.delivery_country) payload.delivery_country = form.delivery_country;
      if (form.delivery_date) payload.delivery_date = new Date(form.delivery_date).toISOString();
      if (form.incoterm) payload.incoterm = form.incoterm;
      if (form.origin_country) payload.origin_country = form.origin_country;
      if (form.packaging) payload.packaging = form.packaging;
      if (form.payment_terms) payload.payment_terms = form.payment_terms;

      const r = await fetch("/api/marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to create post.");
      }
      return r.json();
    },
    onSuccess: (created: { id: string }, mode) => {
      toast.success(
        mode === "draft" ? t("marketplace-wizard-draft-saved") : t("marketplace-post-created"),
      );
      qc.invalidateQueries({ queryKey: ["marketplace-list"] });
      onOpenChange(false);
      setForm(DEFAULT_FORM);
      setStep(0);
      // Drill into the new post only when publishing — drafts stay list-only.
      if (mode === "publish") setSelectedId(created.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Per-step gating ───────────────────────────────────────────────────
  const stepErrors: Record<number, string | null> = {
    0: form.product_name.trim().length === 0 ? t("marketplace-wizard-required-product") : null,
    1: !(Number(form.quantity) > 0) ? t("marketplace-wizard-required-quantity") : null,
    2: null,
    3: null,
    4: null,
  };
  const canContinue = (s: number) => !stepErrors[s];
  const canPublish = stepErrors[0] === null && stepErrors[1] === null && !create.isPending;

  function next() {
    if (!canContinue(step)) {
      toast.error(stepErrors[step] as string);
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStep((s) => Math.max(s - 1, 0));
  }
  function reset() {
    setForm(DEFAULT_FORM);
    setStep(0);
  }

  // Reset everything when the dialog closes so reopening starts fresh.
  function handleOpenChange(o: boolean) {
    if (!o) {
      setForm(DEFAULT_FORM);
      setStep(0);
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
            {t("marketplace-create-post")}
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
                      {PRODUCT_CATEGORIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
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
                <Select value={form.visibility} onValueChange={(v) => set("visibility", v as MarketplaceVisibility)}>
                  <SelectTrigger id="p-vis"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">{t("marketplace-visibility-public")}</SelectItem>
                    <SelectItem value="private">{t("marketplace-visibility-private")}</SelectItem>
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
            </div>
          )}
        </div>

        {/* ─── Wizard navigation ─────────────────────────────────────────── */}
        <div className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4 space-y-2">
        <Separator />
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
                filled in at least the product name. */}
            {step >= 1 && step !== 4 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => create.mutate("draft")}
                disabled={create.isPending || !form.product_name.trim()}
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
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {t("marketplace-wizard-publish")}
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
              Reset form
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
