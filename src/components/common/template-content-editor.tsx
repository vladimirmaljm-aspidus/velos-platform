"use client";
import * as React from "react";
import { Plus, Trash2, Bold, Italic, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useT } from "@/lib/i18n/store";

// Re-export types + helpers from shared lib (so server-side PDF code can import them too)
export type { ContentSegment, ContentConfig, PlaceholderData } from "@/lib/utils/content-config";
export { parseContentConfig, substitutePlaceholders, DEFAULT_HEADER_CONTENT_JSON, DEFAULT_FOOTER_CONTENT_JSON } from "@/lib/utils/content-config";

import type { ContentSegment, ContentConfig } from "@/lib/utils/content-config";
import { parseContentConfig } from "@/lib/utils/content-config";

// Default segments for the fallback in coerceConfig
const DEFAULT_HEADER_SEGMENTS: ContentSegment[] = [
  {
    id: "seg-1",
    text: "{company_name}",
    fontSize: 14,
    bold: true,
    italic: false,
    color: "#000000",
    alignment: "left",
  },
];

// ============================================================
// Types — re-exported from shared lib (see @/lib/utils/content-config)
// ============================================================

// ContentSegment, ContentConfig, PlaceholderData, parseContentConfig,
// substitutePlaceholders, DEFAULT_HEADER_CONTENT_JSON, DEFAULT_FOOTER_CONTENT_JSON
// are all re-exported above from @/lib/utils/content-config

// ============================================================
// Available placeholders (UI-only — for the placeholder chips)
// ============================================================

export const CONTENT_PLACEHOLDERS = [
  { key: "{company_name}", label: "Company Name", description: "Legal name from letterhead" },
  { key: "{company_address}", label: "Company Address", description: "Full address" },
  { key: "{company_city}", label: "City", description: "" },
  { key: "{company_country}", label: "Country", description: "" },
  { key: "{company_reg}", label: "Registration #", description: "" },
  { key: "{company_vat}", label: "VAT Number", description: "" },
  { key: "{company_tax_id}", label: "Tax ID", description: "" },
  { key: "{company_phone}", label: "Phone", description: "" },
  { key: "{company_email}", label: "Email", description: "" },
  { key: "{company_website}", label: "Website", description: "" },
  { key: "{bank_name}", label: "Bank Name", description: "" },
  { key: "{bank_iban}", label: "IBAN", description: "" },
  { key: "{bank_swift}", label: "SWIFT/BIC", description: "" },
  { key: "{doc_number}", label: "Document Number", description: "e.g., OF-2026-009" },
  { key: "{doc_date}", label: "Document Date", description: "" },
  { key: "{valid_until}", label: "Valid Until", description: "" },
  { key: "{due_date}", label: "Due Date", description: "" },
  { key: "{partner_name}", label: "Buyer Name", description: "" },
  { key: "{partner_address}", label: "Buyer Address", description: "" },
  { key: "{total}", label: "Total Amount", description: "" },
  { key: "{currency}", label: "Currency", description: "" },
  { key: "{page_number}", label: "Page Number", description: "e.g., 1" },
  { key: "{total_pages}", label: "Total Pages", description: "e.g., 3" },
];

// ============================================================
// Component
// ============================================================

interface TemplateContentEditorProps {
  value: string; // JSON string of ContentConfig
  onChange: (value: string) => void;
  label: string; // "Header Content" or "Footer Content"
  defaultSegments?: ContentSegment[];
}

function genId() {
  return `seg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function coerceConfig(value: string, fallback: ContentSegment[]): ContentConfig {
  const parsed = parseContentConfig(value);
  if (parsed) return parsed;
  return { segments: fallback.length > 0 ? fallback : [{ ...DEFAULT_HEADER_SEGMENTS[0], id: genId() }] };
}

export function TemplateContentEditor({ value, onChange, label, defaultSegments }: TemplateContentEditorProps) {
  const fallback = defaultSegments || DEFAULT_HEADER_SEGMENTS;
  const t = useT();

  const [config, setConfig] = React.useState<ContentConfig>(() => coerceConfig(value, fallback));
  const [selectedSegId, setSelectedSegId] = React.useState<string | null>(config.segments[0]?.id || null);
  const [dragOverSegId, setDragOverSegId] = React.useState<string | null>(null);

  // Keep in sync if the parent swaps the value (e.g., user selects a different
  // template in the dialog). We compare on a stringified snapshot to avoid
  // deep-equal overhead but still detect real changes.
  const valueSig = React.useMemo(() => {
    const parsed = parseContentConfig(value);
    return parsed ? JSON.stringify(parsed) : "";
  }, [value]);

  React.useEffect(() => {
    if (!valueSig) return;
    setConfig((prev) => {
      if (JSON.stringify(prev) === valueSig) return prev;
      const parsed = parseContentConfig(value);
      return parsed || prev;
    });
  }, [valueSig, value]);

  const updateConfig = React.useCallback(
    (newConfig: ContentConfig) => {
      setConfig(newConfig);
      onChange(JSON.stringify(newConfig));
    },
    [onChange],
  );

  // Always have a valid selected segment — recompute on each render so we
  // gracefully fall back to the first segment after a delete.
  const selectedSeg = config.segments.find((s) => s.id === selectedSegId) || config.segments[0] || null;

  const addSegment = () => {
    const newSeg: ContentSegment = {
      id: genId(),
      text: t("misc-tce-new-text"),
      fontSize: 9,
      bold: false,
      italic: false,
      color: "#666666",
      alignment: "left",
    };
    updateConfig({ segments: [...config.segments, newSeg] });
    setSelectedSegId(newSeg.id);
  };

  const removeSegment = (id: string) => {
    const remaining = config.segments.filter((s) => s.id !== id);
    updateConfig({ segments: remaining });
    if (selectedSegId === id) {
      setSelectedSegId(remaining[0]?.id || null);
    }
  };

  const updateSegment = (id: string, updates: Partial<ContentSegment>) => {
    updateConfig({
      segments: config.segments.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    });
  };

  // Click-to-add fallback (kept for keyboard / mouse users who prefer click).
  // Drag-and-drop is the primary interaction (see chips below + drop targets on each line).
  const addPlaceholder = (placeholder: string) => {
    if (!selectedSeg) return;
    const current = selectedSeg.text;
    const next = current.length === 0 ? placeholder : `${current} ${placeholder}`;
    updateSegment(selectedSeg.id, { text: next });
  };

  return (
    <div className="space-y-3 border rounded-lg p-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        <Button size="sm" variant="outline" onClick={addSegment}>
          <Plus className="size-3 mr-1" /> {t("misc-tce-add-line")}
        </Button>
      </div>

      {/* Segments list — each segment is a DROP TARGET for placeholder chips */}
      <div className="space-y-2">
        {config.segments.map((seg, idx) => (
          <div
            key={seg.id}
            className={cn(
              "relative border rounded p-2 transition-shadow",
              selectedSeg?.id === seg.id ? "border-primary bg-primary/5" : "border-border",
              dragOverSegId === seg.id && "ring-2 ring-primary ring-offset-1 border-primary",
            )}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragOverSegId(seg.id);
            }}
            onDragLeave={(e) => {
              // Only clear if we've truly left the segment (not entering a child).
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOverSegId((prev) => (prev === seg.id ? null : prev));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const placeholder = e.dataTransfer.getData("text/plain");
              if (placeholder) {
                const next = seg.text.trim() ? `${seg.text} ${placeholder}` : placeholder;
                updateSegment(seg.id, { text: next });
                setSelectedSegId(seg.id);
              }
              setDragOverSegId(null);
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground">{t("misc-tce-line").replace("{n}", String(idx + 1))}</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 ml-auto"
                onClick={() => removeSegment(seg.id)}
                title={t("misc-tce-remove-line")}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
            <Input
              value={seg.text}
              onChange={(e) => updateSegment(seg.id, { text: e.target.value })}
              onFocus={() => setSelectedSegId(seg.id)}
              placeholder={t("misc-tce-placeholder")}
              className="text-sm"
              style={{
                fontWeight: seg.bold ? 700 : 400,
                fontStyle: seg.italic ? "italic" : "normal",
                color: seg.color,
                textAlign: seg.alignment,
              }}
            />
            {dragOverSegId === seg.id && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-primary/5 text-[10px] font-medium text-primary">
                {t("misc-tce-drop-here").replace("{n}", String(idx + 1))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Selected segment styling */}
      {selectedSeg && (
        <>
          <Separator />
          <div className="grid grid-cols-4 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("misc-tce-size")}</Label>
              <Input
                type="number"
                value={selectedSeg.fontSize}
                onChange={(e) => updateSegment(selectedSeg.id, { fontSize: Number(e.target.value) || 0 })}
                className="h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("misc-tce-color")}</Label>
              <Input
                type="color"
                value={selectedSeg.color}
                onChange={(e) => updateSegment(selectedSeg.id, { color: e.target.value })}
                className="h-8 p-1"
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">{t("misc-tce-alignment")}</Label>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={selectedSeg.alignment === "left" ? "default" : "outline"}
                  onClick={() => updateSegment(selectedSeg.id, { alignment: "left" })}
                >
                  <AlignLeft className="size-3" />
                </Button>
                <Button
                  size="sm"
                  variant={selectedSeg.alignment === "center" ? "default" : "outline"}
                  onClick={() => updateSegment(selectedSeg.id, { alignment: "center" })}
                >
                  <AlignCenter className="size-3" />
                </Button>
                <Button
                  size="sm"
                  variant={selectedSeg.alignment === "right" ? "default" : "outline"}
                  onClick={() => updateSegment(selectedSeg.id, { alignment: "right" })}
                >
                  <AlignRight className="size-3" />
                </Button>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={selectedSeg.bold ? "default" : "outline"}
              onClick={() => updateSegment(selectedSeg.id, { bold: !selectedSeg.bold })}
            >
              <Bold className="size-3" /> {t("misc-tce-bold")}
            </Button>
            <Button
              size="sm"
              variant={selectedSeg.italic ? "default" : "outline"}
              onClick={() => updateSegment(selectedSeg.id, { italic: !selectedSeg.italic })}
            >
              <Italic className="size-3" /> {t("misc-tce-italic")}
            </Button>
          </div>
        </>
      )}

      {/* Placeholders — DRAG onto a line above (click also works as a fallback) */}
      <Separator />
      <div className="space-y-1">
        <Label className="text-xs">{t("misc-tce-placeholders")}</Label>
        <div className="flex flex-wrap gap-1 mt-1 max-h-32 overflow-y-auto">
          {CONTENT_PLACEHOLDERS.map((ph) => (
            <div
              key={ph.key}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", ph.key);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => addPlaceholder(ph.key)}
              className="text-xs px-2 py-1 border rounded cursor-grab hover:bg-primary/5 hover:border-primary/40 active:cursor-grabbing select-none"
              title={ph.description ? `Drag to a line: ${ph.description}` : `Drag to a line: ${ph.label}`}
            >
              {ph.label}
            </div>
          ))}
        </div>
      </div>

      {/* Live preview */}
      <Separator />
      <div className="space-y-1">
        <Label className="text-xs">{t("misc-tce-preview")}</Label>
        <div className="border rounded p-2 bg-white mt-1 space-y-1" style={{ minHeight: 40 }}>
          {config.segments.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t("misc-tce-no-content")}</span>
          ) : (
            config.segments.map((seg) => (
              <div
                key={seg.id}
                style={{
                  fontSize: seg.fontSize,
                  fontWeight: seg.bold ? 700 : 400,
                  fontStyle: seg.italic ? "italic" : "normal",
                  color: seg.color,
                  textAlign: seg.alignment,
                  lineHeight: 1.3,
                }}
              >
                {seg.text || <span className="text-muted-foreground italic">(empty)</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
