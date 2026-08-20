"use client";

import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Loader2, Send } from "lucide-react";
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
import type { MarketplacePostType, MarketplacePriceType, MarketplacePostStatus, MarketplaceVisibility } from "@/lib/supabase/marketplace-types";

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

  const [form, setForm] = useState({
    post_type: "sell" as MarketplacePostType,
    product_name: "",
    product_category: "",
    product_subcategory: "",
    quantity: "",
    unit: "MT",
    target_price: "",
    price_max: "",
    price_visible: true,
    currency: "USD",
    price_type: "fixed" as MarketplacePriceType,
    delivery_location: "",
    delivery_country: "",
    delivery_date: "",
    incoterm: "",
    origin_country: "",
    packaging: "",
    payment_terms: "",
    description: "",
    status: "active" as MarketplacePostStatus,
    visibility: "public" as MarketplaceVisibility,
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm({ ...form, [k]: v });
  }

  const create = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        post_type: form.post_type,
        product_name: form.product_name,
        quantity: Number(form.quantity),
        unit: form.unit,
        currency: form.currency,
        price_type: form.price_type,
        price_visible: form.price_visible,
        status: form.status,
        visibility: form.visibility,
        description: form.description || null,
      };
      if (form.product_category) payload.product_category = form.product_category;
      if (form.product_subcategory) payload.product_subcategory = form.product_subcategory;
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
    onSuccess: (created: { id: string }) => {
      toast.success(t("marketplace-post-created"));
      qc.invalidateQueries({ queryKey: ["marketplace-list"] });
      onOpenChange(false);
      // Reset form.
      setForm({
        post_type: "sell", product_name: "", product_category: "",
        product_subcategory: "", quantity: "", unit: "MT",
        target_price: "", price_max: "", price_visible: true,
        currency: "USD", price_type: "fixed",
        delivery_location: "", delivery_country: "", delivery_date: "",
        incoterm: "", origin_country: "", packaging: "",
        payment_terms: "", description: "",
        status: "active", visibility: "public",
      });
      // Drill into the new post's detail view (SPA-style — same pattern
      // as the partner-360 drill-down: set selectedId, view stays).
      setSelectedId(created.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmit = form.product_name.trim().length > 0 &&
    Number(form.quantity) > 0 &&
    !create.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("marketplace-create-post")}</DialogTitle>
          <DialogDescription>{t("marketplace-create-post-desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Post type */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t("marketplace-post-type")}</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(["sell", "buy", "auction", "contract"] as MarketplacePostType[]).map((tp) => (
                <Button
                  key={tp}
                  type="button"
                  variant={form.post_type === tp ? "default" : "outline"}
                  size="sm"
                  onClick={() => set("post_type", tp)}
                >
                  {t(`marketplace-${tp}`)}
                </Button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Product */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t("marketplace-section-product")}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <Label htmlFor="p-name">{t("marketplace-product-name")} *</Label>
                <Input id="p-name" value={form.product_name} onChange={(e) => set("product_name", e.target.value)} maxLength={500} />
              </div>
              <div>
                <Label htmlFor="p-cat">{t("marketplace-product-category")}</Label>
                <Select value={form.product_category} onValueChange={(v) => set("product_category", v)}>
                  <SelectTrigger id="p-cat"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_CATEGORIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="p-subcat">{t("marketplace-product-subcategory")}</Label>
                <Input id="p-subcat" value={form.product_subcategory} onChange={(e) => set("product_subcategory", e.target.value)} />
              </div>
            </div>
          </div>

          <Separator />

          {/* Quantity */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t("marketplace-section-quantity")}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="p-qty">{t("marketplace-quantity")} *</Label>
                <Input id="p-qty" type="number" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} />
              </div>
              <div>
                <Label htmlFor="p-unit">{t("marketplace-unit")}</Label>
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
          </div>

          <Separator />

          {/* Price */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t("marketplace-section-price")}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label htmlFor="p-ptype">{t("marketplace-price-type")}</Label>
                <Select value={form.price_type} onValueChange={(v) => set("price_type", v as MarketplacePriceType)}>
                  <SelectTrigger id="p-ptype"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">{t("marketplace-price-fixed")}</SelectItem>
                    <SelectItem value="range">{t("marketplace-price-range")}</SelectItem>
                    <SelectItem value="on_request">{t("marketplace-price-on-request")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="p-price">{t("marketplace-target-price")}</Label>
                <Input id="p-price" type="number" value={form.target_price} onChange={(e) => set("target_price", e.target.value)} disabled={form.price_type === "on_request"} />
              </div>
              {form.price_type === "range" && (
                <div>
                  <Label htmlFor="p-pmax">{t("marketplace-price-max")}</Label>
                  <Input id="p-pmax" type="number" value={form.price_max} onChange={(e) => set("price_max", e.target.value)} />
                </div>
              )}
              <div>
                <Label htmlFor="p-curr">{t("marketplace-currency")}</Label>
                <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                  <SelectTrigger id="p-curr"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.slice(0, 12).map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-3">
                <Label className="flex items-center gap-2 text-sm font-normal cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.price_visible}
                    onChange={(e) => set("price_visible", e.target.checked)}
                    className="h-4 w-4"
                  />
                  {t("marketplace-price-visible")}
                </Label>
              </div>
            </div>
          </div>

          <Separator />

          {/* Delivery */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t("marketplace-section-delivery")}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="p-dloc">{t("marketplace-delivery-location")}</Label>
                <Input id="p-dloc" value={form.delivery_location} onChange={(e) => set("delivery_location", e.target.value)} />
              </div>
              <div>
                <Label htmlFor="p-dcountry">{t("marketplace-delivery-country")}</Label>
                <Select value={form.delivery_country} onValueChange={(v) => set("delivery_country", v)}>
                  <SelectTrigger id="p-dcountry"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="p-ddate">{t("marketplace-delivery-date")}</Label>
                <Input id="p-ddate" type="date" value={form.delivery_date} onChange={(e) => set("delivery_date", e.target.value)} />
              </div>
              <div>
                <Label htmlFor="p-inco">{t("marketplace-incoterm")}</Label>
                <Select value={form.incoterm} onValueChange={(v) => set("incoterm", v)}>
                  <SelectTrigger id="p-inco"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {INCOTERMS.map((i) => (
                      <SelectItem key={i.code} value={i.code}>{i.code} — {i.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="p-orig">{t("marketplace-origin-country")}</Label>
                <Select value={form.origin_country} onValueChange={(v) => set("origin_country", v)}>
                  <SelectTrigger id="p-orig"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="p-pack">{t("marketplace-packaging")}</Label>
                <Input id="p-pack" value={form.packaging} onChange={(e) => set("packaging", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="p-pay">{t("marketplace-payment-terms")}</Label>
                <Input id="p-pay" value={form.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} placeholder="L/C, T/T 30%, etc." />
              </div>
            </div>
          </div>

          <Separator />

          {/* Description */}
          <div className="space-y-3">
            <Label htmlFor="p-desc" className="text-sm font-medium">{t("marketplace-description")}</Label>
            <Textarea id="p-desc" rows={4} value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={5000} />
          </div>

          <Separator />

          {/* Visibility / Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="p-vis">{t("marketplace-visibility")}</Label>
              <Select value={form.visibility} onValueChange={(v) => set("visibility", v as MarketplaceVisibility)}>
                <SelectTrigger id="p-vis"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">{t("marketplace-visibility-public")}</SelectItem>
                  <SelectItem value="private">{t("marketplace-visibility-private")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="p-stat">{t("marketplace-status")}</Label>
              <Select value={form.status} onValueChange={(v) => set("status", v as MarketplacePostStatus)}>
                <SelectTrigger id="p-stat"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t("marketplace-status-active")}</SelectItem>
                  <SelectItem value="draft">{t("marketplace-status-draft")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button onClick={() => create.mutate()} disabled={!canSubmit}>
              {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
              {t("marketplace-publish")}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("portal-action-cancel")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
