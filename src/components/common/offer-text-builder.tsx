"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/store";

interface OfferTextBuilderProps {
  value: string;
  onChange: (value: string) => void;
  currency?: string;
  total?: number;
  validUntil?: string;
  incoterm?: string;
  paymentTerms?: string;
  leadTime?: string;
  /** Loading port (POL) — used by the FOB template. */
  pol?: string;
  /** Discharge port (POD) — used by the CIF template. */
  pod?: string;
  /** Country of origin — used by the formal/CIF/FOB templates. */
  origin?: string;
  /** Packaging description — used by the formal/CIF/FOB templates. */
  packaging?: string;
}

interface TemplateContext {
  currency?: string;
  total?: number;
  validUntil?: string;
  incoterm?: string;
  paymentTerms?: string;
  leadTime?: string;
  pol?: string;
  pod?: string;
  origin?: string;
  packaging?: string;
}

const TEXT_TEMPLATES: { id: string; label: string; template: (ctx: TemplateContext) => string }[] = [
  {
    id: "standard",
    label: "Standard Offer",
    template: (ctx) => `We are pleased to submit our offer as per the following specifications:

${ctx.incoterm ? `Delivery Terms: ${ctx.incoterm}\n` : ""}${ctx.leadTime ? `Lead Time: ${ctx.leadTime}\n` : ""}${ctx.paymentTerms ? `Payment Terms: ${ctx.paymentTerms}\n` : ""}${ctx.validUntil ? `This offer is valid until: ${ctx.validUntil}\n` : ""}
Prices are in ${ctx.currency || "USD"} and are subject to our general terms and conditions.

We remain at your disposal for any further information.

Best regards,`,
  },
  {
    id: "formal",
    label: "Formal Business Offer",
    template: (ctx) => `Dear Valued Customer,

Thank you for your interest in our products. We are pleased to quote the following:

COMMODITY: As specified above
QUALITY: As per specifications attached
${ctx.origin ? `ORIGIN: ${ctx.origin}\n` : ""}${ctx.incoterm ? `DELIVERY TERMS: ${ctx.incoterm}\n` : ""}${ctx.packaging ? `PACKING: ${ctx.packaging}\n` : ""}${ctx.leadTime ? `SHIPMENT: ${ctx.leadTime}\n` : ""}${ctx.paymentTerms ? `PAYMENT: ${ctx.paymentTerms}\n` : ""}${ctx.validUntil ? `VALIDITY: This offer is valid until ${ctx.validUntil}\n` : ""}
INSPECTION: By SGS or equivalent at loading port
DOCUMENTATION: Commercial Invoice, Packing List, Bill of Lading, Certificate of Origin, Phytosanitary Certificate (if applicable), Certificate of Analysis/Quality

We look forward to your favorable reply.

Yours faithfully,`,
  },
  {
    id: "short",
    label: "Short & Direct",
    template: (ctx) => `Quotation as above.

${ctx.incoterm ? `Terms: ${ctx.incoterm} | ` : ""}${ctx.paymentTerms ? `Payment: ${ctx.paymentTerms} | ` : ""}${ctx.leadTime ? `Lead time: ${ctx.leadTime}` : ""}

${ctx.validUntil ? `Valid until ${ctx.validUntil}. ` : ""}Subject to prior sale and final confirmation.

Best regards,`,
  },
  {
    id: "cif",
    label: "CIF Offer (with insurance)",
    template: (ctx) => `We offer CIF ${ctx.pod || "destination port"} as follows:

Commodity and quality as specified in the table above.
${ctx.origin ? `Origin: ${ctx.origin}\n` : ""}${ctx.packaging ? `Packing: ${ctx.packaging}\n` : ""}${ctx.leadTime ? `Shipment period: ${ctx.leadTime}\n` : ""}${ctx.paymentTerms ? `Payment: ${ctx.paymentTerms}\n` : ""}
Insurance: Covered by seller under CIF terms (110% of invoice value).
Inspection: Quality and quantity certified at loading port by SGS or equivalent.

${ctx.validUntil ? `This offer is valid until ${ctx.validUntil}. ` : ""}Subject to vessel availability and final confirmation.

Regards,`,
  },
  {
    id: "fob",
    label: "FOB Offer",
    template: (ctx) => `FOB ${ctx.pol || "loading port"}, packed for export.

Commodity: As specified above
Quality: As per attached specifications
${ctx.origin ? `Origin: ${ctx.origin}\n` : ""}${ctx.packaging ? `Packing: ${ctx.packaging}\n` : ""}${ctx.leadTime ? `Shipment: ${ctx.leadTime}\n` : ""}${ctx.paymentTerms ? `Payment: ${ctx.paymentTerms}\n` : ""}
Buyer to arrange vessel and notify seller of shipping schedule. Seller to load within the agreed laycan.

${ctx.validUntil ? `Valid until ${ctx.validUntil}. ` : ""}Subject to final confirmation.

Best regards,`,
  },
  {
    id: "blank",
    label: "Blank (start from scratch)",
    template: () => "",
  },
];

/**
 * Offer text builder — lets users assemble the cover-letter / terms text for
 * an offer from a set of international-trade templates, then append common
 * contractual clauses (documentation, inspection, force majeure, arbitration)
 * with a single click.
 *
 * The text the user composes here flows into `form.terms` on the offer form,
 * which the PDF generator renders as the "Offer Text" section.
 */
export function OfferTextBuilder({
  value,
  onChange,
  currency,
  total,
  validUntil,
  incoterm,
  paymentTerms,
  leadTime,
  pol,
  pod,
  origin,
  packaging,
}: OfferTextBuilderProps) {
  const [selectedTemplate, setSelectedTemplate] = React.useState<string>("");
  const t = useT();

  const applyTemplate = (templateId: string) => {
    const tpl = TEXT_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const text = tpl.template({
      currency,
      total,
      validUntil: validUntil ? String(validUntil).slice(0, 10) : undefined,
      incoterm,
      paymentTerms,
      leadTime,
      pol,
      pod,
      origin,
      packaging,
    });
    onChange(text);
    setSelectedTemplate(templateId);
  };

  const appendText = (text: string) => {
    onChange(value ? `${value}\n\n${text}` : text);
  };

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">{t("misc-otb-quick-templates")}</Label>
        <Select value={selectedTemplate} onValueChange={(v) => applyTemplate(v)}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder={t("misc-otb-choose-template")} />
          </SelectTrigger>
          <SelectContent>
            {TEXT_TEMPLATES.map((tpl) => (
              <SelectItem key={tpl.id} value={tpl.id}>{tpl.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs">{t("misc-otb-offer-text")}</Label>
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("misc-otb-write-placeholder")}
          rows={8}
          className="mt-1 font-mono text-sm"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => appendText("Documentation: Commercial Invoice, Packing List, Bill of Lading, Certificate of Origin, Certificate of Analysis.")}
        >
          <Plus className="h-3 w-3 mr-1" /> {t("misc-otb-add-doc-clause")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => appendText("Inspection: Quality and quantity to be final at loading port by SGS or equivalent independent surveyor.")}
        >
          <Plus className="h-3 w-3 mr-1" /> {t("misc-otb-add-inspection-clause")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => appendText("Force Majeure: Seller shall not be liable for failure to perform due to causes beyond reasonable control including natural disasters, war, strikes, government actions.")}
        >
          <Plus className="h-3 w-3 mr-1" /> {t("misc-otb-add-force-majeure")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => appendText("Arbitration: Any dispute arising from this contract shall be settled amicably. Failing agreement, the case shall be referred to arbitration per ICC rules.")}
        >
          <Plus className="h-3 w-3 mr-1" /> {t("misc-otb-add-arbitration")}
        </Button>
      </div>
    </div>
  );
}
