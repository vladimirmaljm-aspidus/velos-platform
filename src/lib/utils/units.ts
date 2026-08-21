/**
 * Comprehensive units of measure for international trade.
 *
 * Used by the UnitSelect component (offer / invoice / proforma / trade
 * calculator forms) so the user can pick from a full list rather than typing
 * a unit code by hand.
 *
 * Categories follow common trade conventions:
 *   - weight     → kg, MT, ton, lb, oz…
 *   - volume     → L, m³, gal, bbl…
 *   - length     → m, cm, mm, ft, in…
 *   - area       → m², ft², ha, acre
 *   - count      → piece, bag, drum, pallet, container…
 *   - other      → set, lot
 */

export type UnitCategory =
  | "weight"
  | "volume"
  | "length"
  | "area"
  | "count"
  | "other";

export interface UnitOption {
  value: string;
  label: string;
  category: UnitCategory;
}

export const UNITS_OF_MEASURE: UnitOption[] = [
  // ── Weight ──
  { value: "kg", label: "Kilogram (kg)", category: "weight" },
  { value: "g", label: "Gram (g)", category: "weight" },
  { value: "MT", label: "Metric Ton (MT)", category: "weight" },
  { value: "ton", label: "Ton (ton)", category: "weight" },
  { value: "lb", label: "Pound (lb)", category: "weight" },
  { value: "oz", label: "Ounce (oz)", category: "weight" },

  // ── Volume ──
  { value: "L", label: "Liter (L)", category: "volume" },
  { value: "mL", label: "Milliliter (mL)", category: "volume" },
  { value: "m3", label: "Cubic Meter (m³)", category: "volume" },
  { value: "gal", label: "Gallon (gal)", category: "volume" },
  { value: "bbl", label: "Barrel (bbl)", category: "volume" },

  // ── Length ──
  { value: "m", label: "Meter (m)", category: "length" },
  { value: "cm", label: "Centimeter (cm)", category: "length" },
  { value: "mm", label: "Millimeter (mm)", category: "length" },
  { value: "ft", label: "Foot (ft)", category: "length" },
  { value: "in", label: "Inch (in)", category: "length" },

  // ── Area ──
  { value: "m2", label: "Square Meter (m²)", category: "area" },
  { value: "ft2", label: "Square Foot (ft²)", category: "area" },
  { value: "ha", label: "Hectare (ha)", category: "area" },
  { value: "acre", label: "Acre", category: "area" },

  // ── Count / packaging ──
  { value: "piece", label: "Piece (pcs)", category: "count" },
  { value: "bag", label: "Bag", category: "count" },
  { value: "drum", label: "Drum", category: "count" },
  { value: "pallet", label: "Pallet", category: "count" },
  { value: "container", label: "Container (20ft/40ft)", category: "count" },
  { value: "crate", label: "Crate", category: "count" },
  { value: "box", label: "Box", category: "count" },
  { value: "carton", label: "Carton", category: "count" },
  { value: "roll", label: "Roll", category: "count" },
  { value: "coil", label: "Coil", category: "count" },
  { value: "bundle", label: "Bundle", category: "count" },
  { value: "case", label: "Case", category: "count" },

  // ── Other ──
  { value: "set", label: "Set", category: "other" },
  { value: "lot", label: "Lot", category: "other" },
];

/** Resolve a unit value (e.g. "MT") to its human-readable label. */
export function getUnitLabel(value: string): string {
  return UNITS_OF_MEASURE.find((u) => u.value === value)?.label || value;
}

/** Return all units that belong to a given category. */
export function getUnitsByCategory(category: UnitCategory): UnitOption[] {
  return UNITS_OF_MEASURE.filter((u) => u.category === category);
}
