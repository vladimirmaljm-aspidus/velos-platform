"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Truck,
  Ship,
  Package,
  Clock,
  MapPin,
  ExternalLink,
  Loader2,
  Plus,
  CheckCircle2,
  Circle,
  AlertTriangle,
  FileText,
  Thermometer,
  History,
} from "lucide-react";
import { useT } from "@/lib/i18n/store";
import { toast } from "sonner";
import { fmtDateTime } from "@/lib/utils/format";
import type {
  Shipment,
  ShipmentEvent,
  ShipmentStatus,
} from "@/lib/supabase/marketplace-logistics-types";
import { SHIPMENT_LIFECYCLE } from "@/lib/supabase/marketplace-logistics-types";
import { canTransitionStatus } from "@/lib/data/marketplace-logistics-store";

interface ShipmentTrackerProps {
  shipmentId: string;
  /** When true, the caller is the booking partner — they see the "Add
   *  tracking event" + "Edit shipment" controls. */
  isBookingPartner: boolean;
}

interface ShipmentDetailResponse {
  shipment: Shipment;
  events: ShipmentEvent[];
  is_booking_partner: boolean;
}

const STATUS_LABEL_KEY: Record<ShipmentStatus, string> = {
  pending: "marketplace-shipment-status-pending",
  booked: "marketplace-shipment-status-booked",
  loading: "marketplace-shipment-status-loading",
  in_transit: "marketplace-shipment-status-in-transit",
  arrived_port: "marketplace-shipment-status-arrived-port",
  customs: "marketplace-shipment-status-customs",
  delivered: "marketplace-shipment-status-delivered",
  delayed: "marketplace-shipment-status-delayed",
  cancelled: "marketplace-shipment-status-cancelled",
};

const STATUS_BADGE_CLASS: Record<ShipmentStatus, string> = {
  pending: "border-transparent bg-muted text-muted-foreground",
  booked: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  loading: "border-transparent bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  in_transit: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400",
  arrived_port: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  customs: "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400",
  delivered: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  delayed: "border-transparent bg-rose-500/15 text-rose-700 dark:text-rose-400",
  cancelled: "border-transparent bg-muted text-muted-foreground line-through",
};

/**
 * ShipmentTracker — visual tracking panel for a single shipment.
 *
 * Renders:
 *   • The current status (badge) + ETA countdown (when estimated_arrival
 *     is in the future).
 *   • The lifecycle timeline (pending → booked → loading → in_transit →
 *     arrived_port → customs → delivered) with the current status
 *     highlighted. `delayed` and `cancelled` render as off-ramps.
 *   • Container / carrier / B/L / vessel info cards.
 *   • The carrier-tracking link (opens the carrier's website in a new
 *     tab — derived from the carrier_name + tracking_number via the
 *     CARRIER_TRACKING_URLS map below).
 *   • The events history (chronological list).
 *   • (Booking partner only) "Add tracking event" dialog + inline edit
 *     for the carrier / container / B/L fields.
 */
export function ShipmentTracker({ shipmentId, isBookingPartner }: ShipmentTrackerProps) {
  const t = useT();
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [eventOpen, setEventOpen] = useState(false);
  const [eventForm, setEventForm] = useState({
    status: "in_transit" as ShipmentStatus,
    location: "",
    description: "",
  });

  // Tick every 60s for the ETA countdown (no need for 1s — ETA is a date).
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, []);

  const q = useQuery<ShipmentDetailResponse>({
    queryKey: ["marketplace-shipment", shipmentId],
    queryFn: async () => {
      const r = await fetch(`/api/marketplace/shipments/${shipmentId}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to load shipment.");
      }
      return r.json();
    },
  });

  const addEvent = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/marketplace/shipments/${shipmentId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: eventForm.status,
          location: eventForm.location || null,
          description: eventForm.description || null,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "Failed to add event.");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(t("marketplace-shipment-event-added"));
      setEventOpen(false);
      setEventForm({ status: "in_transit", location: "", description: "" });
      qc.invalidateQueries({ queryKey: ["marketplace-shipment", shipmentId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shipment = q.data?.shipment;
  const events = q.data?.events ?? [];

  // Lifecycle progress: index of the current status in SHIPMENT_LIFECYCLE.
  const currentIndex = useMemo(() => {
    if (!shipment) return -1;
    return SHIPMENT_LIFECYCLE.indexOf(shipment.status as ShipmentStatus);
  }, [shipment]);

  const etaMs = shipment?.estimated_arrival
    ? new Date(shipment.estimated_arrival).getTime() - now
    : null;

  if (q.isLoading) {
    return (
      <Card>
        <CardContent className="py-10 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (q.isError || !shipment) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("marketplace-shipment-not-found")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            <Ship className="h-4 w-4" />
            {t("marketplace-shipment-title")}
          </span>
          <Badge variant="outline" className={STATUS_BADGE_CLASS[shipment.status as ShipmentStatus]}>
            {t(STATUS_LABEL_KEY[shipment.status as ShipmentStatus])}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Carrier / tracking summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <InfoCell label={t("marketplace-shipment-carrier")} value={shipment.carrier_name} icon={Truck} />
          <InfoCell label={t("marketplace-shipment-tracking-number")} value={shipment.carrier_tracking_number} icon={Package} />
          <InfoCell label={t("marketplace-shipment-container")} value={shipment.container_number} icon={Package} />
          <InfoCell label={t("marketplace-shipment-bol")} value={shipment.bill_of_lading_number} icon={FileText} />
        </div>

        {/* Carrier tracking link */}
        {shipment.carrier_tracking_number && shipment.carrier_name && (
          <CarrierTrackingLink
            carrier={shipment.carrier_name}
            trackingNumber={shipment.carrier_tracking_number}
          />
        )}

        {/* Route */}
        <div className="flex items-center justify-between gap-2 text-sm bg-muted/30 rounded-md p-3">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-emerald-600" />
            <div>
              <p className="text-xs uppercase text-muted-foreground">{t("marketplace-shipment-loading-port")}</p>
              <p className="font-medium">{shipment.loading_port || "—"}</p>
            </div>
          </div>
          <div className="flex-1 border-t-2 border-dashed border-muted mx-2 relative">
            <Ship className="h-4 w-4 text-muted-foreground absolute left-1/2 -translate-x-1/2 -top-2 bg-background px-1" />
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-rose-600" />
            <div className="text-right">
              <p className="text-xs uppercase text-muted-foreground">{t("marketplace-shipment-discharge-port")}</p>
              <p className="font-medium">{shipment.discharge_port || "—"}</p>
            </div>
          </div>
        </div>

        {/* ETA countdown */}
        {shipment.status !== "delivered" && shipment.status !== "cancelled" && (
          <div className="flex items-center gap-2 text-sm bg-blue-500/10 rounded-md p-3">
            <Clock className="h-4 w-4 text-blue-600" />
            {etaMs !== null && etaMs > 0 ? (
              <span className="text-blue-700 dark:text-blue-400">
                {t("marketplace-shipment-eta-in").replace(
                  "{n}",
                  formatDuration(etaMs),
                )}
              </span>
            ) : shipment.estimated_arrival ? (
              <span className="text-amber-700 dark:text-amber-400">
                {t("marketplace-shipment-eta-overdue").replace(
                  "{n}",
                  formatDuration(-etaMs!),
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("marketplace-shipment-eta-unknown")}</span>
            )}
            {shipment.estimated_arrival && (
              <span className="text-xs text-muted-foreground ml-auto">
                {fmtDateTime(shipment.estimated_arrival)}
              </span>
            )}
          </div>
        )}

        {/* Lifecycle timeline */}
        {shipment.status !== "delayed" && shipment.status !== "cancelled" && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("marketplace-shipment-lifecycle")}
            </p>
            <div className="flex items-center justify-between gap-1">
              {SHIPMENT_LIFECYCLE.map((s, i) => {
                const done = i < currentIndex;
                const isCurrent = i === currentIndex;
                const Icon = done ? CheckCircle2 : Circle;
                return (
                  <div key={s} className="flex-1 flex flex-col items-center text-center gap-1">
                    <Icon
                      className={`h-5 w-5 ${
                        done
                          ? "text-emerald-500"
                          : isCurrent
                            ? "text-blue-600"
                            : "text-muted-foreground/40"
                      }`}
                    />
                    <span
                      className={`text-[9px] uppercase tracking-wide ${
                        done
                          ? "text-emerald-700 dark:text-emerald-400"
                          : isCurrent
                            ? "text-blue-700 dark:text-blue-400 font-medium"
                            : "text-muted-foreground/60"
                      }`}
                    >
                      {t(STATUS_LABEL_KEY[s])}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Vessel + cargo details */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <InfoCell label={t("marketplace-shipment-vessel")} value={shipment.vessel_name} icon={Ship} />
          <InfoCell label={t("marketplace-shipment-container-type")} value={shipment.container_type?.toUpperCase()} />
          <InfoCell label={t("marketplace-shipment-packages")} value={shipment.packages_count?.toLocaleString()} />
          <InfoCell label={t("marketplace-shipment-gross-weight")} value={shipment.gross_weight != null ? `${Number(shipment.gross_weight).toLocaleString()} kg` : null} />
          <InfoCell label={t("marketplace-shipment-net-weight")} value={shipment.net_weight != null ? `${Number(shipment.net_weight).toLocaleString()} kg` : null} />
          <InfoCell label={t("marketplace-shipment-volume")} value={shipment.volume != null ? `${Number(shipment.volume).toLocaleString()} m³` : null} />
        </div>

        {shipment.temperature_controlled && (
          <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 rounded-md p-2">
            <Thermometer className="h-3 w-3" />
            {t("marketplace-shipment-temperature-controlled")}
          </div>
        )}

        {/* Dates */}
        {(shipment.estimated_departure || shipment.actual_departure || shipment.actual_arrival) && (
          <>
            <Separator />
            <div className="grid grid-cols-2 gap-3 text-xs">
              <DateCell label={t("marketplace-shipment-est-departure")} value={shipment.estimated_departure} />
              <DateCell label={t("marketplace-shipment-act-departure")} value={shipment.actual_departure} />
              <DateCell label={t("marketplace-shipment-est-arrival")} value={shipment.estimated_arrival} />
              <DateCell label={t("marketplace-shipment-act-arrival")} value={shipment.actual_arrival} />
            </div>
          </>
        )}

        {/* Events history */}
        {events.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <History className="h-3 w-3" />
                {t("marketplace-shipment-events-history")}
              </p>
              <div className="space-y-2 max-h-64 overflow-auto pr-1">
                {events.map((e) => (
                  <div key={e.id} className="flex items-start gap-3 text-xs border-l-2 border-muted pl-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={`text-xs h-5 ${STATUS_BADGE_CLASS[e.status as ShipmentStatus] || ""}`}>
                          {t(STATUS_LABEL_KEY[e.status as ShipmentStatus] || e.status)}
                        </Badge>
                        {e.location && (
                          <span className="text-muted-foreground flex items-center gap-0.5">
                            <MapPin className="h-3 w-3" />
                            {e.location}
                          </span>
                        )}
                        <span className="text-muted-foreground ml-auto">{fmtDateTime(e.event_date)}</span>
                      </div>
                      {e.description && (
                        <p className="text-muted-foreground mt-0.5">{e.description}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Notes */}
        {shipment.notes && (
          <>
            <Separator />
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">{t("marketplace-shipment-notes")}</p>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap">{shipment.notes}</p>
            </div>
          </>
        )}

        {/* Booking partner controls */}
        {isBookingPartner && (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setEventOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t("marketplace-shipment-add-event")}
            </Button>
          </div>
        )}
      </CardContent>

      {/* Add tracking event dialog */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
            <DialogTitle>{t("marketplace-shipment-add-event-title")}</DialogTitle>
            <DialogDescription>{t("marketplace-shipment-add-event-desc")}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-4 pb-4">
            <div>
              <Label htmlFor="e-status">{t("marketplace-col-status")}</Label>
              <Select
                value={eventForm.status}
                onValueChange={(v) => setEventForm({ ...eventForm, status: v as ShipmentStatus })}
              >
                <SelectTrigger id="e-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHIPMENT_LIFECYCLE.filter(
                    (s) => s !== shipment.status && canTransitionStatus(shipment.status as ShipmentStatus, s),
                  ).map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(STATUS_LABEL_KEY[s])}
                    </SelectItem>
                  ))}
                  {canTransitionStatus(shipment.status as ShipmentStatus, "delayed") && (
                    <SelectItem value="delayed">{t(STATUS_LABEL_KEY.delayed)}</SelectItem>
                  )}
                  {canTransitionStatus(shipment.status as ShipmentStatus, "cancelled") && (
                    <SelectItem value="cancelled">{t(STATUS_LABEL_KEY.cancelled)}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="e-location">{t("marketplace-shipment-event-location")}</Label>
              <Input
                id="e-location"
                value={eventForm.location}
                onChange={(e) => setEventForm({ ...eventForm, location: e.target.value })}
                placeholder="Rotterdam / Hamburg / vessel MV …"
                maxLength={500}
              />
            </div>
            <div>
              <Label htmlFor="e-desc">{t("marketplace-shipment-event-description")}</Label>
              <Input
                id="e-desc"
                value={eventForm.description}
                onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
                placeholder="Departed on schedule"
                maxLength={2000}
              />
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border/60 px-6 pt-4 pb-4">
            <Button variant="outline" onClick={() => setEventOpen(false)}>
              {t("portal-action-cancel")}
            </Button>
            <Button onClick={() => addEvent.mutate()} disabled={addEvent.isPending}>
              {addEvent.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              {t("marketplace-shipment-add-event")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function InfoCell({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | null | undefined;
  icon?: typeof Truck;
}) {
  return (
    <div className="rounded-md bg-muted/30 p-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="font-medium mt-0.5 truncate" title={value ?? undefined}>
        {value || "—"}
      </p>
    </div>
  );
}

function DateCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium mt-0.5">{value ? fmtDateTime(value) : "—"}</p>
    </div>
  );
}

/**
 * Carrier-tracking URL map — common carriers' public tracking pages.
 * Falls back to a Google search when the carrier isn't in the map.
 */
const CARRIER_TRACKING_URLS: Record<string, (tracking: string) => string> = {
  maersk: (t) => `https://www.maersk.com/tracking/${encodeURIComponent(t)}`,
  msc: (t) => `https://www.msc.com/en/track-a-shipment?agencyPath=USA&trackingNumber=${encodeURIComponent(t)}`,
  cma_cgm: (t) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=BL&Reference=${encodeURIComponent(t)}`,
  hapag_lloyd: (t) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-booking.html?bookingNumber=${encodeURIComponent(t)}`,
  cosco: (t) => `https://elines.coscoshipping.com/ebusiness/tracking?cartNumber=${encodeURIComponent(t)}`,
  evergreen: (t) => `https://www.evergreen-line.com/tp3/jsp/Tracking.jsp?q=${encodeURIComponent(t)}`,
  yang_ming: (t) => `https://www.yangming.com/e-service/track_trace/track_trace_cargo.aspx?q=${encodeURIComponent(t)}`,
  one: (t) => `https://www.one-line.com/en/track-shipment?q=${encodeURIComponent(t)}`,
  zim: (t) => `https://www.zim.com/tools/track-shipment?q=${encodeURIComponent(t)}`,
  hmm: (t) => `https://www.hmm21.com/cms/business/ebiz/trackTrace/trackTrace/index.jsp?cdnNo=${encodeURIComponent(t)}`,
  dhl: (t) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(t)}`,
  fedex: (t) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`,
  ups: (t) => `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`,
};

function CarrierTrackingLink({
  carrier,
  trackingNumber,
}: {
  carrier: string;
  trackingNumber: string;
}) {
  const norm = carrier.toLowerCase().replace(/[\s-]+/g, "_");
  const builder = CARRIER_TRACKING_URLS[norm];
  const href =
    builder?.(trackingNumber) ??
    `https://www.google.com/search?q=${encodeURIComponent(`${carrier} tracking ${trackingNumber}`)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
    >
      <ExternalLink className="h-3 w-3" />
      {carrier}: {trackingNumber}
    </a>
  );
}

/**
 * Format a millisecond duration into a compact human string:
 *   "3d 4h" / "12h" / "45m".
 */
function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
