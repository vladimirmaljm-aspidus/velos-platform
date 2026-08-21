"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Send, Building2, User, MapPin, DollarSign, Truck, Info } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n/store";
import type { ProductCatalogEntry } from "@/lib/supabase/types";

/**
 * Full RFQ intake form used by the portal. Prompts for every field the sales
 * team needs to prepare a good offer: quantity, target price, delivery
 * schedule (one-time or recurring), payment method, target market, end-use,
 * certifications, and — crucially — whether the buyer is the requester's own
 * company or a third party they're sourcing for.
 */
export function RfqFormDialog({
  open,
  onClose,
  product,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  product: ProductCatalogEntry | null;
  onCreated?: () => void;
}) {
  const t = useT();
  const [form, setForm] = React.useState({
    // Basics (prefilled from product)
    product_name: "",
    product_description: "",
    category: "",
    unit: "MT",
    quantity: 1,
    target_price: "" as number | "",
    currency: "USD",

    // Delivery
    delivery_country: "",
    delivery_port: "",
    delivery_date: "",
    incoterm: "CIF",
    delivery_schedule: "one_time" as "one_time" | "monthly" | "quarterly" | "annually",
    per_shipment_qty: "" as number | "",
    shipments_per_period: "" as number | "",
    contract_duration_months: "" as number | "",

    // Commercial
    payment_method: "wire" as "wire" | "lc" | "escrow" | "cash" | "other",
    payment_terms: "",
    urgency: "normal" as "flexible" | "normal" | "urgent",

    // Use case
    target_market: "",
    end_use: "",
    quality_standard: "",
    certifications_required: "",
    packaging_requirements: "",
    specifications: "",

    // Buyer identity
    buyer_type: "self" as "self" | "third_party",
    third_party_company_name: "",
    third_party_business_type: "",
    third_party_country: "",
    third_party_contact_email: "",
    third_party_contact_phone: "",
    third_party_tax_id: "",
    third_party_website: "",

    notes: "",
  });

  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open && product) {
      setForm((f) => ({
        ...f,
        product_name: product.name || "",
        product_description: product.description || "",
        category: product.category || "",
        unit: product.base_unit || "MT",
        specifications: typeof product.specifications === "string" ? product.specifications : "",
      }));
    }
    if (!open) setSubmitting(false);
  }, [open, product]);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const isRecurring = form.delivery_schedule !== "one_time";
  const isThirdParty = form.buyer_type === "third_party";

  async function submit() {
    if (!form.product_name.trim()) return toast.error(t("portal-rfq-dialog-toast-product-required"));
    if (Number(form.quantity) <= 0) return toast.error(t("portal-rfq-dialog-toast-quantity-required"));
    if (isRecurring && Number(form.per_shipment_qty) <= 0) return toast.error(t("portal-rfq-dialog-toast-per-shipment"));
    if (isThirdParty && !form.third_party_company_name.trim()) return toast.error(t("portal-rfq-dialog-toast-tp-name"));

    setSubmitting(true);
    try {
      const payload = {
        product_id: product?.id || null,
        product_name: form.product_name,
        product_description: form.product_description || null,
        category: form.category || null,
        unit: form.unit,
        quantity: Number(form.quantity),
        target_price: form.target_price === "" ? null : Number(form.target_price),
        currency: form.currency,
        delivery_country: form.delivery_country || null,
        delivery_port: form.delivery_port || null,
        delivery_date: form.delivery_date || null,
        incoterm: form.incoterm || null,
        delivery_schedule: form.delivery_schedule,
        per_shipment_qty: isRecurring && form.per_shipment_qty !== "" ? Number(form.per_shipment_qty) : null,
        shipments_per_period: isRecurring && form.shipments_per_period !== "" ? Number(form.shipments_per_period) : null,
        contract_duration_months: isRecurring && form.contract_duration_months !== "" ? Number(form.contract_duration_months) : null,
        payment_method: form.payment_method,
        payment_terms: form.payment_terms || null,
        urgency: form.urgency,
        target_market: form.target_market || null,
        end_use: form.end_use || null,
        quality_standard: form.quality_standard || null,
        certifications_required: form.certifications_required || null,
        packaging_requirements: form.packaging_requirements || null,
        specifications: form.specifications || null,
        buyer_type: form.buyer_type,
        third_party_company_name: isThirdParty ? form.third_party_company_name : null,
        third_party_business_type: isThirdParty ? form.third_party_business_type || null : null,
        third_party_country: isThirdParty ? form.third_party_country || null : null,
        third_party_contact_email: isThirdParty ? form.third_party_contact_email || null : null,
        third_party_contact_phone: isThirdParty ? form.third_party_contact_phone || null : null,
        third_party_tax_id: isThirdParty ? form.third_party_tax_id || null : null,
        third_party_website: isThirdParty ? form.third_party_website || null : null,
        notes: form.notes || null,
        source: product ? "catalog" : "form",
      };
      const r = await fetch("/api/portal/rfqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to submit RFQ");
      }
      toast.success(t("portal-rfq-dialog-toast-submitted"));
      onClose();
      onCreated?.();
    } catch (e: any) {
      toast.error(e.message || t("portal-rfq-dialog-toast-submit-failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2"><Send className="size-5 text-primary" /> {t("portal-rfq-dialog-title")}</DialogTitle>
          <DialogDescription>{t("portal-rfq-dialog-intro")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
          {/* PRODUCT */}
          <section>
            <SectionTitle icon={Info} label={t("portal-rfq-section-product")} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("portal-rfq-dialog-product-service")}><Input value={form.product_name} onChange={(e) => set("product_name", e.target.value)} /></Field>
              <Field label={t("portal-rfq-category")}><Input value={form.category} onChange={(e) => set("category", e.target.value)} /></Field>
              <Field label={t("portal-rfq-dialog-quantity-required")}><Input type="number" min={0} step="any" value={form.quantity} onChange={(e) => set("quantity", Number(e.target.value))} className="tabular" /></Field>
              <Field label={t("portal-rfq-unit")}><Input value={form.unit} onChange={(e) => set("unit", e.target.value)} placeholder="MT, PCS, KG, L…" /></Field>
              <Field label={t("portal-rfq-dialog-target-price-unit")}><Input type="number" min={0} step="any" value={form.target_price} onChange={(e) => set("target_price", e.target.value === "" ? "" : Number(e.target.value))} className="tabular" /></Field>
              <Field label={t("portal-rfq-currency")}>
                <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{["USD","EUR","AED","GBP","CHF"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <div className="md:col-span-2"><Field label={t("portal-rfq-dialog-detailed-specs")}><Textarea rows={2} value={form.specifications} onChange={(e) => set("specifications", e.target.value)} placeholder="Grade, purity, tolerances, packaging size…" /></Field></div>
            </div>
          </section>

          {/* DELIVERY */}
          <section>
            <SectionTitle icon={Truck} label={t("portal-rfq-section-delivery")} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("portal-rfq-dialog-delivery-country-required")}><Input value={form.delivery_country} onChange={(e) => set("delivery_country", e.target.value)} placeholder="e.g. Serbia" /></Field>
              <Field label={t("portal-rfq-dialog-delivery-port-city")}><Input value={form.delivery_port} onChange={(e) => set("delivery_port", e.target.value)} placeholder="Port Klaipeda / Belgrade warehouse…" /></Field>
              <Field label={t("portal-rfq-dialog-preferred-date")}><Input type="date" value={form.delivery_date} onChange={(e) => set("delivery_date", e.target.value)} /></Field>
              <Field label={t("portal-rfq-incoterm")}>
                <Select value={form.incoterm} onValueChange={(v) => set("incoterm", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{["EXW","FCA","FAS","FOB","CFR","CIF","CPT","CIP","DAP","DPU","DDP"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label={t("portal-rfq-dialog-delivery-schedule")}>
                <Select value={form.delivery_schedule} onValueChange={(v) => set("delivery_schedule", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">{t("portal-rfq-dialog-schedule-one-time")}</SelectItem>
                    <SelectItem value="monthly">{t("portal-rfq-dialog-schedule-monthly")}</SelectItem>
                    <SelectItem value="quarterly">{t("portal-rfq-dialog-schedule-quarterly")}</SelectItem>
                    <SelectItem value="annually">{t("portal-rfq-dialog-schedule-annually")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("portal-rfq-dialog-urgency")}>
                <Select value={form.urgency} onValueChange={(v) => set("urgency", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="flexible">{t("portal-rfq-dialog-flexible")}</SelectItem>
                    <SelectItem value="normal">{t("portal-rfq-dialog-normal")}</SelectItem>
                    <SelectItem value="urgent">{t("portal-rfq-dialog-urgent")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {isRecurring && (
                <>
                  <Field label={t("portal-rfq-dialog-per-shipment-qty")}><Input type="number" min={0} step="any" value={form.per_shipment_qty} onChange={(e) => set("per_shipment_qty", e.target.value === "" ? "" : Number(e.target.value))} className="tabular" /></Field>
                  <Field label={t("portal-rfq-dialog-shipments-per-period")}><Input type="number" min={1} step="1" value={form.shipments_per_period} onChange={(e) => set("shipments_per_period", e.target.value === "" ? "" : Number(e.target.value))} className="tabular" placeholder="e.g. 2" /></Field>
                  <Field label={t("portal-rfq-dialog-contract-duration")}><Input type="number" min={1} step="1" value={form.contract_duration_months} onChange={(e) => set("contract_duration_months", e.target.value === "" ? "" : Number(e.target.value))} className="tabular" placeholder="12" /></Field>
                </>
              )}
              <div className="md:col-span-2"><Field label={t("portal-rfq-dialog-packaging")}><Input value={form.packaging_requirements} onChange={(e) => set("packaging_requirements", e.target.value)} placeholder="Bulk, big-bags 1 MT, palletized 25kg…" /></Field></div>
            </div>
          </section>

          {/* COMMERCIAL */}
          <section>
            <SectionTitle icon={DollarSign} label={t("portal-rfq-dialog-commercial-terms")} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("portal-rfq-dialog-payment-method")}>
                <Select value={form.payment_method} onValueChange={(v) => set("payment_method", v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wire">{t("portal-rfq-dialog-payment-wire")}</SelectItem>
                    <SelectItem value="lc">{t("portal-rfq-dialog-payment-lc")}</SelectItem>
                    <SelectItem value="escrow">{t("portal-rfq-dialog-payment-escrow")}</SelectItem>
                    <SelectItem value="cash">{t("portal-rfq-dialog-payment-cash")}</SelectItem>
                    <SelectItem value="other">{t("portal-rfq-dialog-payment-other")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("portal-rfq-dialog-payment-terms")}><Input value={form.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} placeholder="30% advance, 70% against BL copy" /></Field>
            </div>
          </section>

          {/* USE CASE */}
          <section>
            <SectionTitle icon={MapPin} label={t("portal-rfq-dialog-use-case")} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label={t("portal-rfq-dialog-target-market")}><Input value={form.target_market} onChange={(e) => set("target_market", e.target.value)} placeholder="Construction, food, automotive…" /></Field>
              <Field label={t("portal-rfq-dialog-quality-standard")}><Input value={form.quality_standard} onChange={(e) => set("quality_standard", e.target.value)} placeholder="ISO 9001, ASTM, EN…" /></Field>
              <div className="md:col-span-2"><Field label={t("portal-rfq-dialog-end-use")}><Textarea rows={2} value={form.end_use} onChange={(e) => set("end_use", e.target.value)} /></Field></div>
              <div className="md:col-span-2"><Field label={t("portal-rfq-dialog-certifications")}><Input value={form.certifications_required} onChange={(e) => set("certifications_required", e.target.value)} placeholder="Halal, FDA, RoHS, non-GMO…" /></Field></div>
            </div>
          </section>

          {/* BUYER IDENTITY */}
          <section>
            <SectionTitle icon={Building2} label={t("portal-rfq-dialog-buyer")} />
            <RadioGroup value={form.buyer_type} onValueChange={(v) => set("buyer_type", v as any)} className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${form.buyer_type === "self" ? "border-primary/60 bg-primary/5" : "border-border/60"}`}>
                <RadioGroupItem value="self" className="mt-0.5" />
                <div><p className="text-sm font-medium flex items-center gap-1.5"><User className="size-3.5" /> {t("portal-rfq-dialog-buyer-self-title")}</p><p className="text-xs text-muted-foreground">{t("portal-rfq-dialog-buyer-self-desc")}</p></div>
              </label>
              <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${form.buyer_type === "third_party" ? "border-primary/60 bg-primary/5" : "border-border/60"}`}>
                <RadioGroupItem value="third_party" className="mt-0.5" />
                <div><p className="text-sm font-medium flex items-center gap-1.5"><Building2 className="size-3.5" /> {t("portal-rfq-dialog-buyer-third-title")}</p><p className="text-xs text-muted-foreground">{t("portal-rfq-dialog-buyer-third-desc")}</p></div>
              </label>
            </RadioGroup>

            {isThirdParty && (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-border/60 p-3">
                <Field label={t("portal-rfq-dialog-tp-company-name")}><Input value={form.third_party_company_name} onChange={(e) => set("third_party_company_name", e.target.value)} /></Field>
                <Field label={t("portal-rfq-dialog-tp-business-type")}><Input value={form.third_party_business_type} onChange={(e) => set("third_party_business_type", e.target.value)} placeholder="Manufacturer, distributor…" /></Field>
                <Field label={t("portal-rfq-dialog-tp-country")}><Input value={form.third_party_country} onChange={(e) => set("third_party_country", e.target.value)} /></Field>
                <Field label={t("portal-rfq-dialog-tp-tax-id")}><Input value={form.third_party_tax_id} onChange={(e) => set("third_party_tax_id", e.target.value)} /></Field>
                <Field label={t("portal-rfq-dialog-tp-contact-email")}><Input type="email" value={form.third_party_contact_email} onChange={(e) => set("third_party_contact_email", e.target.value)} /></Field>
                <Field label={t("portal-rfq-dialog-tp-contact-phone")}><Input value={form.third_party_contact_phone} onChange={(e) => set("third_party_contact_phone", e.target.value)} /></Field>
                <div className="md:col-span-2"><Field label={t("portal-rfq-dialog-tp-website")}><Input value={form.third_party_website} onChange={(e) => set("third_party_website", e.target.value)} placeholder="https://…" /></Field></div>
              </div>
            )}
          </section>

          {/* NOTES */}
          <section>
            <SectionTitle icon={Info} label={t("portal-rfq-dialog-anything-else")} />
            <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder={t("portal-rfq-dialog-notes-placeholder")} />
          </section>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={onClose} disabled={submitting}>{t("portal-action-cancel")}</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Send className="size-4 mr-2" />}
            {t("portal-rfq-dialog-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <div className="size-6 rounded-md bg-primary/10 flex items-center justify-center"><Icon className="size-3.5 text-primary" /></div>
      <h3 className="text-sm font-semibold">{label}</h3>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
