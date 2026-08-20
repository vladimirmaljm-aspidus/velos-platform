// Marketplace Phase 6 — logistics types.
//
// Backs the tables added in migration 047_marketplace_logistics.sql:
//   • marketplace_shipments         — one row per booked transport
//   • marketplace_shipment_events   — chronological status / tracking events
//
// A shipment tracks a real container's journey from the loading port to the
// discharge port, with carrier / B/L / vessel identifiers and ETA/ATA
// timestamps. The status column is denormalised from the events history —
// every status transition inserts an event row, and the API layer updates
// the shipment's `status` to match the latest event.
//
// The lifecycle:
//   pending → booked → loading → in_transit → arrived_port → customs
//          → delivered
// with `delayed` and `cancelled` as parallel terminal states.

// ─── Container type ──────────────────────────────────────────────────────

export type ContainerType =
  | "20gp"
  | "40gp"
  | "40hc"
  | "40ot"
  | "40fr"
  | "lcl"
  | "bulk"
  | "tank";

/**
 * Human-readable label for a container type. Used by the dropdowns on the
 * freight + container loadability calculators.
 */
export const CONTAINER_TYPE_LABELS: Record<ContainerType, string> = {
  "20gp": "20' GP (Dry)",
  "40gp": "40' GP (Dry)",
  "40hc": "40' HC (High Cube)",
  "40ot": "40' Open Top",
  "40fr": "40' Flat Rack",
  lcl: "LCL (Less than Container Load)",
  bulk: "Bulk",
  tank: "Tank",
};

/**
 * Physical specifications for a standard ISO container. Used by the
 * container-loadability + carbon calculators. Weights are in kg, volumes in
 * m³. The `max_payload` is the maximum cargo weight allowed (gross minus
 * tare); `max_volume` is the usable internal volume.
 */
export interface ContainerSpec {
  type: ContainerType;
  label: string;
  tare_kg: number;
  max_payload_kg: number;
  max_gross_kg: number;
  internal_length_m: number;
  internal_width_m: number;
  internal_height_m: number;
  max_volume_m3: number;
}

// ─── Shipment status ──────────────────────────────────────────────────────

export type ShipmentStatus =
  | "pending"
  | "booked"
  | "loading"
  | "in_transit"
  | "arrived_port"
  | "customs"
  | "delivered"
  | "delayed"
  | "cancelled";

/**
 * Canonical lifecycle order used by the shipment-tracker timeline. Indices
 * before the current status are "done"; indices after are "pending".
 * `delayed` and `cancelled` are off-ramps and rendered separately.
 */
export const SHIPMENT_LIFECYCLE: ShipmentStatus[] = [
  "pending",
  "booked",
  "loading",
  "in_transit",
  "arrived_port",
  "customs",
  "delivered",
];

// ─── marketplace_shipments ─────────────────────────────────────────────────

export interface Shipment {
  id: string;
  tenant_id: string;
  partner_id: string;
  post_id: string | null;
  negotiation_id: string | null;
  status: ShipmentStatus;
  carrier_name: string | null;
  carrier_tracking_number: string | null;
  container_number: string | null;
  bill_of_lading_number: string | null;
  loading_port: string | null;
  discharge_port: string | null;
  vessel_name: string | null;
  estimated_departure: string | null;
  actual_departure: string | null;
  estimated_arrival: string | null;
  actual_arrival: string | null;
  container_type: ContainerType | null;
  gross_weight: number | null;
  net_weight: number | null;
  volume: number | null;
  packages_count: number | null;
  temperature_controlled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentCreate {
  post_id?: string | null;
  negotiation_id?: string | null;
  status?: ShipmentStatus;
  carrier_name?: string | null;
  carrier_tracking_number?: string | null;
  container_number?: string | null;
  bill_of_lading_number?: string | null;
  loading_port?: string | null;
  discharge_port?: string | null;
  vessel_name?: string | null;
  estimated_departure?: string | null;
  actual_departure?: string | null;
  estimated_arrival?: string | null;
  actual_arrival?: string | null;
  container_type?: ContainerType | null;
  gross_weight?: number | null;
  net_weight?: number | null;
  volume?: number | null;
  packages_count?: number | null;
  temperature_controlled?: boolean;
  notes?: string | null;
}

export interface ShipmentUpdate {
  status?: ShipmentStatus;
  carrier_name?: string | null;
  carrier_tracking_number?: string | null;
  container_number?: string | null;
  bill_of_lading_number?: string | null;
  loading_port?: string | null;
  discharge_port?: string | null;
  vessel_name?: string | null;
  estimated_departure?: string | null;
  actual_departure?: string | null;
  estimated_arrival?: string | null;
  actual_arrival?: string | null;
  container_type?: ContainerType | null;
  gross_weight?: number | null;
  net_weight?: number | null;
  volume?: number | null;
  packages_count?: number | null;
  temperature_controlled?: boolean;
  notes?: string | null;
}

// ─── marketplace_shipment_events ───────────────────────────────────────────

export interface ShipmentEvent {
  id: string;
  shipment_id: string;
  status: string;
  location: string | null;
  event_date: string;
  description: string | null;
  created_by: string | null;
}

export interface ShipmentEventCreate {
  status: string;
  location?: string | null;
  event_date?: string | null;
  description?: string | null;
  created_by?: string | null;
}

// ─── Freight quote (estimated costs) ───────────────────────────────────────
//
// The freight + customs calculators return these shapes. They are pure
// functions on hardcoded data tables — no Supabase calls — so the API
// routes can serve them cheaply.

export interface FreightQuote {
  from_port: string;
  to_port: string;
  container_type: ContainerType;
  min: number;
  max: number;
  currency: string;
  transit_days: { min: number; max: number };
  distance_nm: number | null;
  notes: string;
}

export interface CustomsEstimate {
  hs_code: string;
  origin_country: string;
  destination_country: string;
  declared_value: number;
  duty_rate: number; // percentage (e.g. 5.0 = 5%)
  duty_amount: number;
  vat_rate: number; // percentage
  vat_amount: number;
  total_charges: number;
  currency: string;
  notes: string;
}

export interface ContainerLoadability {
  container_type: ContainerType;
  package_weight_kg: number;
  package_volume_m3: number;
  max_packages_by_weight: number;
  max_packages_by_volume: number;
  max_packages: number;
  total_weight_kg: number;
  total_volume_m3: number;
  weight_utilization_pct: number;
  volume_utilization_pct: number;
  utilization_pct: number; // min(weight, volume) — the binding constraint
  notes: string;
}

export interface CarbonEstimate {
  from_port: string;
  to_port: string;
  container_type: ContainerType;
  weight_tons: number;
  co2_tons: number;
  equivalent: string;
  distance_nm: number | null;
  suggestions: string[];
}
