"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Truck, Ship, Plane, Train, Package, Plus, Send, Trash2, MapPin, ArrowRight, Loader2, FileText, ChevronDown, ChevronRight, Copy, History, CheckCircle2, XCircle, Play, MessageSquare, ArrowRightCircle } from "lucide-react";
import { toast } from "sonner";
import { COUNTRIES, INCOTERMS } from "@/lib/data/reference";
import { fmtMoney, fmtNumber } from "@/lib/utils/format";
import { useT } from "@/lib/i18n/store";

type LogisticsMode = "sea_fcl" | "sea_lcl" | "road_ftl" | "road_ltl" | "air" | "rail" | "courier" | "multimodal";
interface PackingLine {
  description: string;
  hs_code?: string;
  packages?: number;
  package_type?: string;
  unit_weight_kg?: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  quantity?: number;
  unit?: string;
}
interface LogisticsRequest {
  id: string; number: string; status: string; mode: LogisticsMode;
  origin_country: string | null; origin_city: string | null;
  destination_country: string | null; destination_city: string | null;
  total_weight_kg: number | null; total_packages: number | null;
  quoted_price: number | null; quoted_currency: string | null; quoted_transit_days: number | null;
  tracking_number?: string | null; tracking_url?: string | null; carrier?: string | null;
  created_at: string;
}

const MODE_META: Record<LogisticsMode, { labelKey: string; icon: React.ComponentType<{ className?: string }> }> = {
  sea_fcl: { labelKey: "portal-logistics-mode-sea-fcl", icon: Ship },
  sea_lcl: { labelKey: "portal-logistics-mode-sea-lcl", icon: Ship },
  road_ftl: { labelKey: "portal-logistics-mode-road-ftl", icon: Truck },
  road_ltl: { labelKey: "portal-logistics-mode-road-ltl", icon: Truck },
  air: { labelKey: "portal-logistics-mode-air", icon: Plane },
  rail: { labelKey: "portal-logistics-mode-rail", icon: Train },
  courier: { labelKey: "portal-logistics-mode-courier", icon: Package },
  multimodal: { labelKey: "portal-logistics-mode-multimodal", icon: Truck },
};

export function PortalLogistics() {
  const t = useT();
  const qc = useQueryClient();
  const [showForm, setShowForm] = React.useState(false);
  const [prefill, setPrefill] = React.useState<any>(null);
  const [openTimelineId, setOpenTimelineId] = React.useState<string | null>(null);
  const listQ = useQuery({
    queryKey: ["portal-logistics"],
    queryFn: async () => {
      const r = await fetch("/api/portal/logistics");
      if (!r.ok) throw new Error("Failed to load requests");
      return r.json() as Promise<{ items: any[] }>;
    },
  });
  // Load partner profile so we can pre-fill the origin address on the first request.
  const profileQ = useQuery({
    queryKey: ["portal-profile-for-logistics"],
    queryFn: async () => {
      const r = await fetch("/api/portal/profile");
      return r.ok ? r.json() : null;
    },
  });
  const items = listQ.data?.items || [];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("portal-logistics-title")}</h1>
          <p className="text-sm text-muted-foreground">{t("portal-logistics-intro")}</p>
        </div>
        <Button onClick={() => { setPrefill(null); setShowForm(true); }} className="gap-2"><Plus className="size-4" /> {t("portal-logistics-new-request")}</Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("portal-logistics-your-requests")}</CardTitle>
          <CardDescription>{t("portal-logistics-your-requests-desc")}</CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {listQ.isLoading && <p className="text-sm text-muted-foreground">{t("portal-loading-dots")}</p>}
          {!listQ.isLoading && items.length === 0 && (
            <div className="text-center py-10 text-muted-foreground">
              <Truck className="size-8 mx-auto opacity-40 mb-2" />
              <p className="text-sm" dangerouslySetInnerHTML={{ __html: t("portal-logistics-empty") }} />
            </div>
          )}
          <div className="space-y-2">
            {items.map((r) => {
              const Icon = MODE_META[r.mode]?.icon || Package;
              const open = openTimelineId === r.id;
              return (
                <div key={r.id} className="rounded-lg border border-border/60 hover:border-primary/40 smooth">
                  <div className="flex items-center gap-3 p-3">
                    <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="size-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{r.number}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                        <MapPin className="size-3 shrink-0" />
                        {r.origin_city || "?"}, {r.origin_country || "?"}
                        <ArrowRight className="size-3 mx-1" />
                        {r.destination_city || "?"}, {r.destination_country || "?"}
                      </p>
                    </div>
                    <div className="text-right shrink-0 flex items-center gap-2">
                      <div>
                        <Badge variant="outline" className="capitalize">{r.status.replace(/_/g, " ")}</Badge>
                        {r.quoted_price != null && (
                          <p className="text-xs font-medium mt-1 tabular">
                            {fmtMoney(r.quoted_price, r.quoted_currency || "USD")}
                            {r.quoted_transit_days != null && ` · ${r.quoted_transit_days}d`}
                          </p>
                        )}
                      </div>
                      <a
                        href={`/api/portal/logistics/${r.id}/packing-list.pdf`}
                        target="_blank" rel="noopener noreferrer"
                        title={t("portal-logistics-download-packing-list")}
                        className="inline-flex items-center justify-center size-9 rounded-md hover:bg-accent smooth"
                      ><FileText className="size-4" /></a>
                      <Button
                        size="icon" variant="ghost" title={open ? t("portal-logistics-hide-timeline") : t("portal-logistics-show-timeline")}
                        onClick={() => setOpenTimelineId(open ? null : r.id)}
                      ><History className="size-4" /></Button>
                      <Button
                        size="icon" variant="ghost" title={t("portal-logistics-duplicate")}
                        onClick={(e) => {
                          e.stopPropagation();
                          const { id, number, status, created_at, quoted_price, quoted_currency, quoted_transit_days, tracking_number, tracking_url, carrier, shipped_at, delivered_at, ...rest } = r as any;
                          setPrefill(rest); setShowForm(true);
                        }}
                      ><Copy className="size-4" /></Button>
                    </div>
                  </div>
                  {(r.tracking_number || r.carrier) && (
                    <div className="px-4 pb-3 -mt-1 text-xs flex flex-wrap gap-3">
                      {r.carrier && <span><span className="text-muted-foreground">{t("portal-logistics-carrier")}</span> <strong>{r.carrier}</strong></span>}
                      {r.tracking_number && (
                        r.tracking_url
                          ? <a href={r.tracking_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("portal-logistics-track").replace("{number}", r.tracking_number)}</a>
                          : <span><span className="text-muted-foreground">{t("portal-logistics-tracking")}</span> <strong>{r.tracking_number}</strong></span>
                      )}
                    </div>
                  )}
                  {open && (
                    <div className="border-t border-border/60 px-4 py-3 bg-muted/20">
                      <PortalTimeline requestId={r.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <LogisticsRequestForm
        open={showForm}
        onClose={() => setShowForm(false)}
        onCreated={() => { qc.invalidateQueries({ queryKey: ["portal-logistics"] }); setShowForm(false); }}
        prefill={prefill}
        profile={profileQ.data}
      />
    </div>
  );
}

function LogisticsRequestForm({ open, onClose, onCreated, prefill, profile }: { open: boolean; onClose: () => void; onCreated: () => void; prefill?: any; profile?: any }) {
  const t = useT();
  // Sensible default: origin address from the partner's profile (client is
  // usually shipping FROM their own location) — user can overwrite.
  const initialForm = React.useCallback(() => {
    const base: any = {
      mode: "sea_fcl", container_type: "20FT", incoterm: "CIF", urgency: "normal",
      origin_country: "", origin_city: "", origin_postal_code: "", origin_address_line: "",
      origin_company: "", origin_contact_name: "", origin_contact_phone: "", origin_contact_email: "", origin_port: "",
      destination_country: "", destination_city: "", destination_postal_code: "", destination_address_line: "",
      destination_company: "", destination_contact_name: "", destination_contact_phone: "", destination_contact_email: "", destination_port: "",
      target_pickup_date: "", target_delivery_date: "",
      cargo_description: "", hs_codes: "", cargo_value: "" as number | "", cargo_currency: "USD",
      total_weight_kg: "" as number | "", total_volume_cbm: "" as number | "", total_packages: "" as number | "",
      is_hazardous: false, is_temperature_controlled: false, temperature_range: "", insurance_required: false,
      special_instructions: "",
      packing_list: [] as PackingLine[],
    };
    // Prefer explicit prefill (duplicate flow) over profile defaults.
    if (prefill) return { ...base, ...prefill, packing_list: prefill.packing_list || [] };
    const partner = profile?.partner;
    if (partner) {
      base.origin_company = partner.name || "";
      base.origin_country = partner.country || "";
      base.origin_city = partner.city || "";
      base.origin_address_line = partner.address_line || partner.address || "";
      base.origin_postal_code = partner.postal_code || "";
      base.origin_contact_name = partner.contact_name || "";
      base.origin_contact_phone = partner.phone || "";
    }
    return base;
  }, [prefill, profile]);
  const [f, setF] = React.useState<any>(initialForm);
// eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => { if (open) setF(initialForm()); }, [open, initialForm]);
  const [submitting, setSubmitting] = React.useState(false);
  const [openSec, setOpenSec] = React.useState({ transport: true, origin: true, destination: true, cargo: true, packing: false, extras: false });

  function set<K extends keyof typeof f>(k: K, v: any) { setF((s: any) => ({ ...s, [k]: v })); }
  function addLine() { set("packing_list", [...(f.packing_list as PackingLine[]), { description: "", packages: 1, package_type: "carton" }]); }
  function updLine(i: number, patch: Partial<PackingLine>) {
    const arr = [...(f.packing_list as PackingLine[])]; arr[i] = { ...arr[i], ...patch }; set("packing_list", arr);
  }
  function delLine(i: number) { const arr = [...(f.packing_list as PackingLine[])]; arr.splice(i, 1); set("packing_list", arr); }

  // Auto-compute totals from packing list when packing changes
  React.useEffect(() => {
    const list = f.packing_list as PackingLine[];
    if (!list.length) return;
    const w = list.reduce((a, l) => a + (Number(l.unit_weight_kg) * Number(l.packages || 0) || 0), 0);
    const v = list.reduce((a, l) => a + ((Number(l.length_cm) * Number(l.width_cm) * Number(l.height_cm) * Number(l.packages || 0)) / 1_000_000 || 0), 0);
    const p = list.reduce((a, l) => a + Number(l.packages || 0), 0);
// eslint-disable-next-line react-hooks/set-state-in-effect
    setF((s: any) => ({ ...s, total_weight_kg: w > 0 ? Number(w.toFixed(2)) : s.total_weight_kg, total_volume_cbm: v > 0 ? Number(v.toFixed(3)) : s.total_volume_cbm, total_packages: p > 0 ? p : s.total_packages }));
  }, [JSON.stringify(f.packing_list)]);

  async function submit() {
    if (!f.mode) return toast.error(t("portal-logistics-toast-mode"));
    if (!f.origin_country || !f.destination_country) return toast.error(t("portal-logistics-toast-countries"));
    if (!f.cargo_description) return toast.error(t("portal-logistics-toast-cargo"));
    setSubmitting(true);
    try {
      const payload = { ...f,
        cargo_value: f.cargo_value === "" ? null : Number(f.cargo_value),
        total_weight_kg: f.total_weight_kg === "" ? null : Number(f.total_weight_kg),
        total_volume_cbm: f.total_volume_cbm === "" ? null : Number(f.total_volume_cbm),
        total_packages: f.total_packages === "" ? null : Number(f.total_packages),
      };
      const r = await fetch("/api/portal/logistics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Failed");
      toast.success(t("portal-logistics-toast-submitted"));
      onCreated();
    } catch (e: any) { toast.error(e.message); } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[88vh] flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2"><Truck className="size-5 text-primary" /> {t("portal-logistics-dialog-title")}</DialogTitle>
          <DialogDescription>{t("portal-logistics-dialog-desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* Transport */}
          <Section title={t("portal-logistics-section-transport")} open={openSec.transport} onToggle={() => setOpenSec({ ...openSec, transport: !openSec.transport })}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Fld label={t("portal-logistics-mode-label")}><Select value={f.mode} onValueChange={(v) => set("mode", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(MODE_META).map(([k, m]) => <SelectItem key={k} value={k}>{t(m.labelKey)}</SelectItem>)}</SelectContent></Select></Fld>
              {f.mode.startsWith("sea") && (<Fld label={t("portal-logistics-container-type")}><Select value={f.container_type ?? ""} onValueChange={(v) => set("container_type", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["20FT","40FT","40HC","45HC","LCL"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></Fld>)}
              <Fld label={t("portal-logistics-incoterm")}><Select value={f.incoterm ?? ""} onValueChange={(v) => set("incoterm", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{INCOTERMS.map((i) => <SelectItem key={i.code} value={i.code}>{i.code} — {i.name}</SelectItem>)}</SelectContent></Select></Fld>
              <Fld label={t("portal-logistics-urgency")}><Select value={f.urgency ?? "normal"} onValueChange={(v) => set("urgency", v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="flexible">{t("portal-rfq-dialog-flexible")}</SelectItem><SelectItem value="normal">{t("portal-rfq-dialog-normal")}</SelectItem><SelectItem value="urgent">{t("portal-rfq-dialog-urgent")}</SelectItem></SelectContent></Select></Fld>
              <Fld label={t("portal-logistics-pickup-date")}><Input type="date" value={f.target_pickup_date} onChange={(e) => set("target_pickup_date", e.target.value)} /></Fld>
              <Fld label={t("portal-logistics-delivery-date")}><Input type="date" value={f.target_delivery_date} onChange={(e) => set("target_delivery_date", e.target.value)} /></Fld>
            </div>
          </Section>

          {/* Origin */}
          <Section title={t("portal-logistics-section-origin")} open={openSec.origin} onToggle={() => setOpenSec({ ...openSec, origin: !openSec.origin })}>
            <AddressBlock prefix="origin" f={f} set={set} />
          </Section>

          {/* Destination */}
          <Section title={t("portal-logistics-section-destination")} open={openSec.destination} onToggle={() => setOpenSec({ ...openSec, destination: !openSec.destination })}>
            <AddressBlock prefix="destination" f={f} set={set} />
          </Section>

          {/* Cargo */}
          <Section title={t("portal-logistics-section-cargo")} open={openSec.cargo} onToggle={() => setOpenSec({ ...openSec, cargo: !openSec.cargo })}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2"><Fld label={t("portal-logistics-cargo-desc-label")}><Textarea rows={2} value={f.cargo_description} onChange={(e) => set("cargo_description", e.target.value)} placeholder="e.g. bagged sugar ICUMSA-45, 25kg PP bags" /></Fld></div>
              <Fld label={t("portal-logistics-hs-codes")}><Input value={f.hs_codes} onChange={(e) => set("hs_codes", e.target.value)} placeholder="1701.14, 1701.99" /></Fld>
              <Fld label={t("portal-logistics-cargo-value")}><div className="flex gap-1"><Input type="number" step="any" value={f.cargo_value} onChange={(e) => set("cargo_value", e.target.value === "" ? "" : Number(e.target.value))} /><Select value={f.cargo_currency ?? "USD"} onValueChange={(v) => set("cargo_currency", v)}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent>{["USD","EUR","AED","GBP"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></div></Fld>
              <Fld label={t("portal-logistics-total-weight")}><Input type="number" step="any" value={f.total_weight_kg} onChange={(e) => set("total_weight_kg", e.target.value === "" ? "" : Number(e.target.value))} /></Fld>
              <Fld label={t("portal-logistics-total-volume")}><Input type="number" step="any" value={f.total_volume_cbm} onChange={(e) => set("total_volume_cbm", e.target.value === "" ? "" : Number(e.target.value))} /></Fld>
              <Fld label={t("portal-logistics-total-packages")}><Input type="number" value={f.total_packages} onChange={(e) => set("total_packages", e.target.value === "" ? "" : Number(e.target.value))} /></Fld>
              <div className="md:col-span-2 flex flex-wrap gap-4 pt-2">
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.is_hazardous} onCheckedChange={(v) => set("is_hazardous", v === true)} /> {t("portal-logistics-hazardous")}</label>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.is_temperature_controlled} onCheckedChange={(v) => set("is_temperature_controlled", v === true)} /> {t("portal-logistics-temp-controlled")}</label>
                <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.insurance_required} onCheckedChange={(v) => set("insurance_required", v === true)} /> {t("portal-logistics-insurance")}</label>
              </div>
              {f.is_temperature_controlled && (
                <div className="md:col-span-2"><Fld label={t("portal-logistics-temp-range")}><Input value={f.temperature_range} onChange={(e) => set("temperature_range", e.target.value)} placeholder="e.g. 2 to 8 °C" /></Fld></div>
              )}
            </div>
          </Section>

          {/* Packing list */}
          <Section title={t("portal-logistics-packing-list-with-count").replace("{n}", String((f.packing_list as PackingLine[]).length))} open={openSec.packing} onToggle={() => setOpenSec({ ...openSec, packing: !openSec.packing })}>
            <div className="space-y-2">
              {(f.packing_list as PackingLine[]).length === 0 && <p className="text-xs text-muted-foreground">{t("portal-logistics-packing-hint")}</p>}
              {(f.packing_list as PackingLine[]).map((line, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center rounded-md border p-2">
                  <div className="col-span-12 md:col-span-4"><Input placeholder={t("portal-logistics-packing-desc-placeholder")} value={line.description} onChange={(e) => updLine(i, { description: e.target.value })} /></div>
                  <div className="col-span-4 md:col-span-1"><Input placeholder={t("portal-logistics-packing-hs")} value={line.hs_code || ""} onChange={(e) => updLine(i, { hs_code: e.target.value })} /></div>
                  <div className="col-span-4 md:col-span-1"><Input type="number" placeholder={t("portal-logistics-packing-pkgs")} value={line.packages ?? ""} onChange={(e) => updLine(i, { packages: Number(e.target.value) || 0 })} /></div>
                  <div className="col-span-4 md:col-span-1"><Input placeholder={t("portal-logistics-packing-type")} value={line.package_type || ""} onChange={(e) => updLine(i, { package_type: e.target.value })} /></div>
                  <div className="col-span-4 md:col-span-1"><Input type="number" placeholder={t("portal-logistics-packing-weight")} step="any" value={line.unit_weight_kg ?? ""} onChange={(e) => updLine(i, { unit_weight_kg: Number(e.target.value) || 0 })} /></div>
                  <div className="col-span-2 md:col-span-1"><Input type="number" placeholder={t("portal-logistics-packing-length")} value={line.length_cm ?? ""} onChange={(e) => updLine(i, { length_cm: Number(e.target.value) || 0 })} /></div>
                  <div className="col-span-2 md:col-span-1"><Input type="number" placeholder={t("portal-logistics-packing-width")} value={line.width_cm ?? ""} onChange={(e) => updLine(i, { width_cm: Number(e.target.value) || 0 })} /></div>
                  <div className="col-span-2 md:col-span-1"><Input type="number" placeholder={t("portal-logistics-packing-height")} value={line.height_cm ?? ""} onChange={(e) => updLine(i, { height_cm: Number(e.target.value) || 0 })} /></div>
                  <div className="col-span-2 md:col-span-1"><Button size="icon" variant="ghost" onClick={() => delLine(i)}><Trash2 className="size-4 text-destructive" /></Button></div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addLine}><Plus className="size-3.5 mr-1" /> {t("portal-logistics-add-packing-line")}</Button>
            </div>
          </Section>

          {/* Extras */}
          <Section title={t("portal-logistics-section-extras")} open={openSec.extras} onToggle={() => setOpenSec({ ...openSec, extras: !openSec.extras })}>
            <Textarea rows={3} value={f.special_instructions} onChange={(e) => set("special_instructions", e.target.value)} placeholder={t("portal-logistics-extras-placeholder")} />
          </Section>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
          <Button variant="outline" onClick={onClose} disabled={submitting}>{t("portal-action-cancel")}</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Send className="size-4 mr-2" />}
            {t("portal-logistics-submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PortalTimeline({ requestId }: { requestId: string }) {
  const t = useT();
  interface EventItem {
    id: string;
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    actor_role: string;
    message: string | null;
    created_at: string;
  }
  const q = useQuery({
    queryKey: ["portal-logistics-events", requestId],
    queryFn: async () => {
      const r = await fetch(`/api/portal/logistics/${requestId}/events`);
      if (!r.ok) return { items: [] as EventItem[] };
      return r.json() as Promise<{ items: EventItem[] }>;
    },
    refetchInterval: 20_000,
  });
  const events = q.data?.items || [];
  if (q.isLoading) return <p className="text-xs text-muted-foreground">{t("portal-logistics-loading-timeline")}</p>;
  if (!events.length) return <p className="text-xs text-muted-foreground">{t("portal-logistics-no-events")}</p>;

  const iconFor = (eventType: string) => {
    switch (eventType) {
      case "created": return { Icon: Send, color: "text-primary" };
      case "quoted": return { Icon: FileText, color: "text-blue-600" };
      case "accepted": return { Icon: CheckCircle2, color: "text-emerald-600" };
      case "rejected": return { Icon: XCircle, color: "text-destructive" };
      case "in_progress": return { Icon: Play, color: "text-indigo-600" };
      case "completed": return { Icon: CheckCircle2, color: "text-emerald-700" };
      case "cancelled": return { Icon: XCircle, color: "text-muted-foreground" };
      case "converted_to_offer": return { Icon: ArrowRightCircle, color: "text-primary" };
      case "note": return { Icon: MessageSquare, color: "text-muted-foreground" };
      default: return { Icon: History, color: "text-muted-foreground" };
    }
  };
  return (
    <ol className="relative border-l border-border ml-2 space-y-2 pl-4">
      {events.map((e) => {
        const { Icon, color } = iconFor(e.event_type);
        return (
          <li key={e.id} className="relative">
            <span className={`absolute -left-[22px] top-0 size-4 rounded-full bg-background border border-border flex items-center justify-center ${color}`}>
              <Icon className="size-2.5" />
            </span>
            <div className="text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium capitalize">{e.event_type.replace(/_/g, " ")}</span>
                {e.from_status && e.to_status && e.from_status !== e.to_status && (
                  <span className="text-muted-foreground">{e.from_status} → {e.to_status}</span>
                )}
                <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
              </div>
              {e.message && <p className="text-muted-foreground mt-0.5">{e.message}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-muted/30 smooth">
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <span className="text-sm font-semibold">{title}</span>
      </button>
      {open && <div className="p-4 pt-2 border-t border-border/60">{children}</div>}
    </div>
  );
}
function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-xs">{label}</Label>{children}</div>;
}

function AddressBlock({ prefix, f, set }: { prefix: "origin" | "destination"; f: any; set: (k: string, v: any) => void }) {
  const t = useT();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Fld label={t("portal-logistics-company")}>
        <Input value={f[`${prefix}_company`]} onChange={(e) => set(`${prefix}_company`, e.target.value)} />
      </Fld>
      <Fld label={t("portal-logistics-contact-name")}>
        <Input value={f[`${prefix}_contact_name`]} onChange={(e) => set(`${prefix}_contact_name`, e.target.value)} />
      </Fld>
      <Fld label={t("portal-logistics-contact-phone")}>
        <Input value={f[`${prefix}_contact_phone`]} onChange={(e) => set(`${prefix}_contact_phone`, e.target.value)} />
      </Fld>
      <Fld label={t("portal-logistics-contact-email")}>
        <Input type="email" value={f[`${prefix}_contact_email`] || ""} onChange={(e) => set(`${prefix}_contact_email`, e.target.value)} />
      </Fld>
      <Fld label={t("portal-logistics-country-required")}>
        <Select value={f[`${prefix}_country`] || ""} onValueChange={(v) => set(`${prefix}_country`, v)}>
          <SelectTrigger><SelectValue placeholder={t("portal-logistics-choose-country")} /></SelectTrigger>
          <SelectContent className="max-h-[300px]">
            {COUNTRIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Fld>
      <Fld label={t("portal-logistics-state-province")}>
        <Input value={f[`${prefix}_state`] || ""} onChange={(e) => set(`${prefix}_state`, e.target.value)} />
      </Fld>
      <Fld label={t("portal-logistics-city")}>
        <Input value={f[`${prefix}_city`]} onChange={(e) => set(`${prefix}_city`, e.target.value)} />
      </Fld>
      <Fld label={t("portal-logistics-postal-code")}>
        <Input value={f[`${prefix}_postal_code`]} onChange={(e) => set(`${prefix}_postal_code`, e.target.value)} placeholder={t("portal-logistics-postal-placeholder")} />
      </Fld>
      <div className="md:col-span-2">
        <Fld label={t("portal-logistics-address-line")}>
          <Input value={f[`${prefix}_address_line`]} onChange={(e) => set(`${prefix}_address_line`, e.target.value)} placeholder={t("portal-logistics-address-placeholder")} />
        </Fld>
      </div>
      <div className="md:col-span-2">
        <Fld label={t("portal-logistics-port-terminal")}>
          <Input value={f[`${prefix}_port`] || ""} onChange={(e) => set(`${prefix}_port`, e.target.value)} placeholder={t("portal-logistics-port-placeholder")} />
        </Fld>
      </div>
    </div>
  );
}
