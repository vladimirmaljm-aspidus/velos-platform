"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Send,
  Loader2,
  Package,
  ShoppingCart,
  ChevronDown,
  ChevronRight,
  Inbox,
  MapPin,
  Globe2,
  Calendar,
  Coins,
  Ruler,
  Layers,
  FileText,
  StickyNote,
  Truck,
  Clock,
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtMoney, fmtDate, fmtDateTime } from "@/lib/utils/format";
import {
  COUNTRIES,
  PRODUCT_CATEGORIES,
  UNITS_OF_MEASURE,
  INCOTERMS,
  CURRENCIES,
} from "@/lib/data/reference";
import type { PortalRfq, PortalRfqStatus } from "@/lib/supabase/types";

// ============================================================
// Constants
// ============================================================

const STATUS_META: Record<
  PortalRfqStatus,
  {
    labelKey: string;
    className: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  pending: {
    labelKey: "portal-rfq-status-pending",
    className:
      "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    icon: Clock,
  },
  quoted: {
    labelKey: "portal-rfq-status-quoted",
    className: "border-transparent bg-primary/15 text-primary",
    icon: MessageSquare,
  },
  accepted: {
    labelKey: "portal-rfq-status-accepted",
    className: "border-transparent bg-emerald-600 text-white",
    icon: CheckCircle2,
  },
  declined: {
    labelKey: "portal-rfq-status-declined",
    className:
      "border-transparent bg-destructive text-destructive-foreground",
    icon: XCircle,
  },
  expired: {
    labelKey: "portal-rfq-status-expired",
    className: "bg-muted text-muted-foreground",
    icon: AlertCircle,
  },
};

interface RfqFormState {
  product_name: string;
  product_description: string;
  category: string;
  quantity: string;
  unit: string;
  target_price: string;
  currency: string;
  delivery_country: string;
  delivery_port: string;
  delivery_date: string;
  incoterm: string;
  specifications: string;
  notes: string;
  // Third-party delivery (when requesting for another company)
  is_third_party: boolean;
  third_party_company_name: string;
  third_party_country: string;
  third_party_address: string;
  third_party_contact_name: string;
  third_party_contact_email: string;
  third_party_contact_phone: string;
  third_party_tax_id: string;
}

const EMPTY_FORM: RfqFormState = {
  product_name: "",
  product_description: "",
  category: "",
  quantity: "",
  unit: "",
  target_price: "",
  currency: "USD",
  delivery_country: "",
  delivery_port: "",
  delivery_date: "",
  incoterm: "",
  specifications: "",
  notes: "",
  is_third_party: false,
  third_party_company_name: "",
  third_party_country: "",
  third_party_address: "",
  third_party_contact_name: "",
  third_party_contact_email: "",
  third_party_contact_phone: "",
  third_party_tax_id: "",
};

// ============================================================
// Main component
// ============================================================

export function PortalRfq() {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState<RfqFormState>(EMPTY_FORM);

  const rfqsQ = useQuery<{ items: PortalRfq[] }>({
    queryKey: ["portal-rfqs"],
    queryFn: async () => {
      const r = await fetch("/api/portal/rfqs");
      if (!r.ok) throw new Error("Failed to load requests");
      return r.json();
    },
  });

  const createMut = useMutation({
    mutationFn: async (body: Partial<PortalRfq>) => {
      const r = await fetch("/api/portal/rfqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to submit request");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(
        t("portal-rfq-toast-submitted")
      );
      qc.invalidateQueries({ queryKey: ["portal-rfqs"] });
      setForm(EMPTY_FORM);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function update<K extends keyof RfqFormState>(key: K, value: RfqFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.product_name.trim()) {
      toast.error(t("portal-rfq-toast-product-name"));
      return;
    }
    if (!form.quantity || Number(form.quantity) <= 0) {
      toast.error(t("portal-rfq-toast-quantity"));
      return;
    }
    if (!form.unit) {
      toast.error(t("portal-rfq-toast-unit"));
      return;
    }
    // Validate third-party company info if enabled
    if (form.is_third_party) {
      if (!form.third_party_company_name.trim()) {
        toast.error(t("portal-rfq-toast-tp-name"));
        return;
      }
      if (!form.third_party_country) {
        toast.error(t("portal-rfq-toast-tp-country"));
        return;
      }
      if (!form.third_party_contact_email.trim()) {
        toast.error(t("portal-rfq-toast-tp-email"));
        return;
      }
    }
    createMut.mutate({
      product_name: form.product_name.trim(),
      product_description: form.product_description.trim() || null,
      category: form.category || null,
      quantity: Number(form.quantity),
      unit: form.unit,
      target_price: form.target_price ? Number(form.target_price) : null,
      currency: form.currency,
      delivery_country: form.delivery_country || null,
      delivery_port: form.delivery_port.trim() || null,
      delivery_date: form.delivery_date || null,
      incoterm: form.incoterm || null,
      specifications: form.specifications.trim() || null,
      notes: form.notes.trim() || null,
      buyer_type: form.is_third_party ? "third_party" : "self",
      ...(form.is_third_party ? {
        third_party_company_name: form.third_party_company_name.trim() || null,
        third_party_country: form.third_party_country || null,
        third_party_address: form.third_party_address.trim() || null,
        third_party_contact_name: form.third_party_contact_name.trim() || null,
        third_party_contact_email: form.third_party_contact_email.trim() || null,
        third_party_contact_phone: form.third_party_contact_phone.trim() || null,
        third_party_tax_id: form.third_party_tax_id.trim() || null,
      } : {}),
    });
  }

  const items = rfqsQ.data?.items || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("portal-rfq-title").split(" ")[0]} <span className="text-gradient-emerald">{t("portal-rfq-title").split(" ").slice(1).join(" ")}</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("portal-rfq-intro")}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Form */}
        <div className="lg:col-span-3">
          <Card className="card-premium shadow-soft-lg">
            <CardHeader className="border-b bg-muted/20">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <ShoppingCart className="size-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base">{t("portal-rfq-new-request")}</CardTitle>
                  <CardDescription className="text-xs mt-0.5">
                    {t("portal-rfq-new-request-desc")}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <form onSubmit={handleSubmit}>
              <CardContent className="p-6 sm:p-8 space-y-6">
                {/* Product section */}
                <FormSection
                  icon={Package}
                  title={t("portal-rfq-section-product")}
                  description={t("portal-rfq-section-product-desc")}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                      <FieldText
                        label={t("portal-rfq-product-name")}
                        required
                        icon={Package}
                        value={form.product_name}
                        onChange={(v) => update("product_name", v)}
                        placeholder="e.g. ICUMSA 45 refined white sugar"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <FieldTextarea
                        label={t("portal-rfq-description")}
                        icon={FileText}
                        value={form.product_description}
                        onChange={(v) => update("product_description", v)}
                        placeholder="Detailed description — origin, grade, packaging preferences, etc."
                      />
                    </div>
                    <FieldSelect
                      label={t("portal-rfq-category")}
                      icon={Layers}
                      value={form.category}
                      onChange={(v) => update("category", v)}
                      options={PRODUCT_CATEGORIES.map((c) => ({
                        value: c.code,
                        label: c.name,
                      }))}
                      placeholder={t("portal-rfq-select-category")}
                    />
                  </div>
                </FormSection>

                <Separator />

                {/* Quantity & Price */}
                <FormSection
                  icon={Coins}
                  title={t("portal-rfq-section-quantity-price")}
                  description={t("portal-rfq-section-quantity-price-desc")}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <FieldText
                      label={t("portal-rfq-quantity")}
                      required
                      type="number"
                      icon={Ruler}
                      value={form.quantity}
                      onChange={(v) => update("quantity", v)}
                      placeholder="e.g. 500"
                    />
                    <FieldSelect
                      label={t("portal-rfq-unit")}
                      required
                      icon={Ruler}
                      value={form.unit}
                      onChange={(v) => update("unit", v)}
                      options={UNITS_OF_MEASURE.map((u) => ({
                        value: u.code,
                        label: `${u.code} — ${u.name}`,
                      }))}
                      placeholder={t("portal-rfq-select-unit")}
                    />
                    <FieldText
                      label={t("portal-rfq-target-price")}
                      type="number"
                      icon={Coins}
                      value={form.target_price}
                      onChange={(v) => update("target_price", v)}
                      placeholder={t("portal-rfq-optional")}
                    />
                    <FieldSelect
                      label={t("portal-rfq-currency")}
                      icon={Coins}
                      value={form.currency}
                      onChange={(v) => update("currency", v)}
                      options={CURRENCIES.map((c) => ({
                        value: c.value,
                        label: c.label,
                      }))}
                    />
                  </div>
                </FormSection>

                <Separator />

                {/* Delivery */}
                <FormSection
                  icon={Truck}
                  title={t("portal-rfq-section-delivery")}
                  description={t("portal-rfq-section-delivery-desc")}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FieldSelect
                      label={t("portal-rfq-delivery-country")}
                      icon={Globe2}
                      value={form.delivery_country}
                      onChange={(v) => update("delivery_country", v)}
                      options={COUNTRIES.map((c) => ({
                        value: c.code,
                        label: c.name,
                      }))}
                      placeholder={t("portal-rfq-select-country")}
                    />
                    <FieldText
                      label={t("portal-rfq-delivery-port")}
                      icon={MapPin}
                      value={form.delivery_port}
                      onChange={(v) => update("delivery_port", v)}
                      placeholder={t("portal-rfq-delivery-port-placeholder")}
                    />
                    <FieldText
                      label={t("portal-rfq-delivery-date")}
                      type="date"
                      icon={Calendar}
                      value={form.delivery_date}
                      onChange={(v) => update("delivery_date", v)}
                    />
                    <FieldSelect
                      label={t("portal-rfq-incoterm")}
                      icon={Truck}
                      value={form.incoterm}
                      onChange={(v) => update("incoterm", v)}
                      options={INCOTERMS.map((i) => ({
                        value: i.code,
                        label: `${i.code} — ${i.name}`,
                      }))}
                      placeholder={t("portal-rfq-select-incoterm")}
                    />
                  </div>
                </FormSection>

                <Separator />

                {/* Additional */}
                <FormSection
                  icon={StickyNote}
                  title={t("portal-rfq-section-additional")}
                  description={t("portal-rfq-section-additional-desc")}
                >
                  <div className="grid grid-cols-1 gap-4">
                    <FieldTextarea
                      label={t("portal-rfq-specifications")}
                      icon={FileText}
                      value={form.specifications}
                      onChange={(v) => update("specifications", v)}
                      placeholder="Quality, grade, packaging, certification requirements, etc."
                      rows={3}
                    />
                    <FieldTextarea
                      label={t("portal-rfq-notes")}
                      icon={StickyNote}
                      value={form.notes}
                      onChange={(v) => update("notes", v)}
                      placeholder="Any additional context for our sourcing team."
                      rows={2}
                    />
                  </div>
                </FormSection>

                {/* Third-party delivery option */}
                <FormSection title={t("portal-rfq-section-destination")} description={t("portal-rfq-section-destination-desc")} icon={Globe2}>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.is_third_party}
                        onChange={(e) => update("is_third_party", e.target.checked)}
                        className="size-4 rounded border-border"
                      />
                      <span className="text-sm">{t("portal-rfq-third-party-toggle")}</span>
                    </label>
                    {form.is_third_party && (
                      <div className="space-y-3 p-3 rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
                        <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                          <AlertCircle className="size-3.5" />
                          {t("portal-rfq-third-party-notice")}
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-company-name")}</Label>
                            <Input value={form.third_party_company_name} onChange={(e) => update("third_party_company_name", e.target.value)} placeholder="ABC Trading LLC" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-country")}</Label>
                            <Select value={form.third_party_country} onValueChange={(v) => update("third_party_country", v)}>
                              <SelectTrigger className="h-10"><SelectValue placeholder={t("portal-rfq-select-country")} /></SelectTrigger>
                              <SelectContent className="max-h-60">
                                {COUNTRIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-address")}</Label>
                            <Input value={form.third_party_address} onChange={(e) => update("third_party_address", e.target.value)} placeholder="Street, city, postal code" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-tax-id")}</Label>
                            <Input value={form.third_party_tax_id} onChange={(e) => update("third_party_tax_id", e.target.value)} placeholder="Tax registration number" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-contact-name")}</Label>
                            <Input value={form.third_party_contact_name} onChange={(e) => update("third_party_contact_name", e.target.value)} placeholder="John Smith" />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-contact-email")}</Label>
                            <Input type="email" value={form.third_party_contact_email} onChange={(e) => update("third_party_contact_email", e.target.value)} placeholder="contact@company.com" />
                          </div>
                          <div className="space-y-1.5 sm:col-span-2">
                            <Label className="text-xs text-muted-foreground">{t("portal-rfq-tp-contact-phone")}</Label>
                            <Input value={form.third_party_contact_phone} onChange={(e) => update("third_party_contact_phone", e.target.value)} placeholder="+971 50 123 4567" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </FormSection>
              </CardContent>

              <div className="border-t bg-muted/20 px-6 sm:px-8 py-4 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground hidden sm:block">
                  {t("portal-rfq-response-time")}
                </p>
                <Button
                  type="submit"
                  disabled={createMut.isPending}
                  className="gap-1.5 ml-auto"
                >
                  {createMut.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {t("portal-rfq-submit")}
                </Button>
              </div>
            </form>
          </Card>
        </div>

        {/* Right: List of submitted RFQs */}
        <div className="lg:col-span-2">
          <div className="lg:sticky lg:top-20 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
                <Inbox className="size-4 text-primary" />
                {t("portal-rfq-your-requests")}
              </h2>
              {rfqsQ.data && (
                <Badge variant="outline" className="tabular text-xs">
                  {t("portal-rfq-total").replace("{n}", String(items.length))}
                </Badge>
              )}
            </div>

            {rfqsQ.isLoading ? (
              <Card className="shadow-soft">
                <CardContent className="py-12 flex items-center justify-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </CardContent>
              </Card>
            ) : items.length === 0 ? (
              <EmptyRfqState />
            ) : (
              <div className="space-y-3 max-h-[calc(100vh-12rem)] overflow-y-auto custom-scroll lg:pr-1">
                {items.map((rfq) => (
                  <RfqCard key={rfq.id} rfq={rfq} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// RFQ card — expandable
// ============================================================

function RfqCard({ rfq }: { rfq: PortalRfq }) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const meta = STATUS_META[rfq.status] ?? STATUS_META.pending;
  const StatusIcon = meta?.icon ?? Clock;

  return (
    <Card
      className={cn(
        "card-premium shadow-soft transition-all",
        expanded && "shadow-soft-md"
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-4 flex items-start gap-3"
        aria-expanded={expanded}
      >
        <div
          className={cn(
            "size-9 rounded-lg flex items-center justify-center shrink-0 transition-colors",
            rfq.status === "accepted"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : rfq.status === "declined"
                ? "bg-destructive/15 text-destructive"
                : rfq.status === "expired"
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary/10 text-primary"
          )}
        >
          <Package className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-muted-foreground tabular">
              {rfq.number}
            </span>
            <Badge className={cn("text-xs py-0 h-4 gap-0.5", meta.className)}>
              <StatusIcon className="size-2.5" />
              {t(meta.labelKey)}
            </Badge>
          </div>
          <p className="text-sm font-medium truncate mt-1">{rfq.product_name}</p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground tabular">
            <span>
              {rfq.quantity} {rfq.unit}
            </span>
            {rfq.target_price ? (
              <span>· {fmtMoney(rfq.target_price, rfq.currency)}</span>
            ) : null}
            <span>· {fmtDate(rfq.created_at)}</span>
          </div>
        </div>
        <div className="shrink-0 mt-1">
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/20 px-4 py-4 space-y-3 animate-in fade-in-0 slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <DetailRow label={t("portal-rfq-detail-category")} value={categoryName(rfq.category)} />
            <DetailRow
              label={t("portal-rfq-detail-quantity")}
              value={`${rfq.quantity} ${rfq.unit}`}
              mono
            />
            <DetailRow
              label={t("portal-rfq-detail-target-price")}
              value={
                rfq.target_price
                  ? fmtMoney(rfq.target_price, rfq.currency)
                  : "—"
              }
              mono
            />
            <DetailRow label={t("portal-rfq-detail-incoterm")} value={rfq.incoterm || "—"} mono />
            <DetailRow
              label={t("portal-rfq-detail-delivery-country")}
              value={countryName(rfq.delivery_country)}
            />
            <DetailRow label={t("portal-rfq-detail-delivery-port")} value={rfq.delivery_port || "—"} />
            <DetailRow
              label={t("portal-rfq-detail-delivery-date")}
              value={rfq.delivery_date ? fmtDate(rfq.delivery_date) : "—"}
            />
            <DetailRow label={t("portal-rfq-detail-submitted")} value={fmtDateTime(rfq.created_at)} />
          </div>

          {rfq.product_description && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground/70 font-medium mb-0.5">
                {t("portal-rfq-detail-description")}
              </p>
              <p className="text-xs text-foreground leading-relaxed">
                {rfq.product_description}
              </p>
            </div>
          )}

          {rfq.specifications && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground/70 font-medium mb-0.5">
                {t("portal-rfq-detail-specifications")}
              </p>
              <p className="text-xs text-foreground leading-relaxed">
                {rfq.specifications}
              </p>
            </div>
          )}

          {rfq.notes && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground/70 font-medium mb-0.5">
                {t("portal-rfq-detail-notes")}
              </p>
              <p className="text-xs text-foreground leading-relaxed">
                {rfq.notes}
              </p>
            </div>
          )}

          {/* Admin response */}
          {rfq.admin_notes && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-primary mb-1">
                <MessageSquare className="size-3.5" />
                {t("portal-rfq-response-from-team")}
              </div>
              <p className="text-xs text-foreground leading-relaxed">
                {rfq.admin_notes}
              </p>
            </div>
          )}

          {rfq.status === "quoted" && !rfq.admin_notes && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-start gap-2">
              <MessageSquare className="size-3.5 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-foreground/80 leading-relaxed">
                {t("portal-rfq-quoted-notice")}
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Empty state
// ============================================================

function EmptyRfqState() {
  const t = useT();
  return (
    <Card className="border-dashed border-border/60 shadow-soft">
      <CardContent className="py-12 flex flex-col items-center justify-center text-center">
        <div className="size-12 rounded-full bg-muted flex items-center justify-center mb-3 text-muted-foreground">
          <Inbox className="size-5" />
        </div>
        <p className="text-sm font-medium">{t("portal-rfq-empty-title")}</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs">
          {t("portal-rfq-empty-desc")}
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Shared field components (RFQ-specific)
// ============================================================

function FormSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

function FieldText({
  label,
  required,
  icon: Icon,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  required?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "email" | "number" | "date";
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10"
      />
    </div>
  );
}

function FieldTextarea({
  label,
  icon: Icon,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {label}
      </Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="resize-y"
      />
    </div>
  );
}

function FieldSelect({
  label,
  required,
  icon: Icon,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  required?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Icon className="size-3.5" />
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-10 w-full">
          <SelectValue placeholder={placeholder || "Select…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wider text-muted-foreground/70 font-medium">
        {label}
      </p>
      <p
        className={cn(
          "text-xs mt-0.5 break-words",
          mono && "font-mono tabular",
          !value && "text-muted-foreground italic"
        )}
      >
        {value || "—"}
      </p>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function countryName(code: string | null | undefined): string {
  if (!code) return "—";
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

function categoryName(code: string | null | undefined): string {
  if (!code) return "—";
  return PRODUCT_CATEGORIES.find((c) => c.code === code)?.name ?? code;
}
