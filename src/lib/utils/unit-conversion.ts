/**
 * Unit conversion engine for trade documents.
 * Converts between units of the same category (weight↔weight, volume↔volume).
 * Returns null if units are in different categories or unknown.
 */

// Base unit for each category (everything converts through the base)
const WEIGHT_BASE = "kg"; // 1 kg = 1
const VOLUME_BASE = "L"; // 1 L = 1
const LENGTH_BASE = "m"; // 1 m = 1
const AREA_BASE = "m2"; // 1 m² = 1

// Conversion factors TO base unit (1 unit = X base units)
const WEIGHT_FACTORS: Record<string, number> = {
  mg: 0.000001,
  g: 0.001,
  kg: 1,
  MT: 1000, // metric ton
  ton: 1000, // alias
  t: 1000, // alias
  lb: 0.453592,
  oz: 0.0283495,
};

const VOLUME_FACTORS: Record<string, number> = {
  mL: 0.001,
  ml: 0.001,
  L: 1,
  l: 1,
  m3: 1000, // cubic meter = 1000 liters
  "m³": 1000,
  gal: 3.78541, // US gallon
  bbl: 158.987, // oil barrel
};

const LENGTH_FACTORS: Record<string, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  ft: 0.3048,
  in: 0.0254,
};

const AREA_FACTORS: Record<string, number> = {
  "mm2": 0.000001,
  "cm2": 0.0001,
  "m2": 1,
  "m²": 1,
  "ft2": 0.092903,
  "ft²": 0.092903,
  ha: 10000, // hectare
  acre: 4046.86,
};

type Category = "weight" | "volume" | "length" | "area" | "count" | "other";

function getCategory(unit: string): Category {
  if (unit in WEIGHT_FACTORS) return "weight";
  if (unit in VOLUME_FACTORS) return "volume";
  if (unit in LENGTH_FACTORS) return "length";
  if (unit in AREA_FACTORS) return "area";
  // Count units (piece, bag, drum, pallet, etc.) — no conversion
  if (["piece", "pcs", "bag", "drum", "pallet", "container", "crate", "box", "carton", "roll", "coil", "bundle", "case", "set", "lot"].includes(unit)) return "count";
  return "other";
}

function getFactor(unit: string): number | null {
  if (unit in WEIGHT_FACTORS) return WEIGHT_FACTORS[unit];
  if (unit in VOLUME_FACTORS) return VOLUME_FACTORS[unit];
  if (unit in LENGTH_FACTORS) return LENGTH_FACTORS[unit];
  if (unit in AREA_FACTORS) return AREA_FACTORS[unit];
  return null;
}

// Suppress unused-variable warnings for the BASE constants — they document
// the convention used to derive the factor tables above.
void WEIGHT_BASE;
void VOLUME_BASE;
void LENGTH_BASE;
void AREA_BASE;

/**
 * Convert a quantity from one unit to another.
 * Returns the converted quantity, or null if conversion is not possible
 * (different categories, or unknown units).
 *
 * Examples:
 *   convertUnit(1, "MT", "kg") → 1000
 *   convertUnit(1000, "kg", "MT") → 1
 *   convertUnit(500, "kg", "L") → null (different categories)
 *   convertUnit(2, "m3", "L") → 2000
 */
export function convertUnit(
  quantity: number,
  fromUnit: string,
  toUnit: string
): number | null {
  if (fromUnit === toUnit) return quantity;

  const fromCat = getCategory(fromUnit);
  const toCat = getCategory(toUnit);

  // Different categories — cannot convert
  if (fromCat !== toCat) return null;

  // Count units — only convert if same unit
  if (fromCat === "count" || fromCat === "other") {
    return fromUnit === toUnit ? quantity : null;
  }

  const fromFactor = getFactor(fromUnit);
  const toFactor = getFactor(toUnit);

  if (fromFactor == null || toFactor == null) return null;

  // Convert: quantity_in_base = quantity * fromFactor
  //          result = quantity_in_base / toFactor
  return (quantity * fromFactor) / toFactor;
}

/**
 * Convert a unit price from one unit to another.
 * If conversion is not possible, returns null.
 *
 * Examples:
 *   convertUnitPrice(0.50, "kg", "MT") → 500  ($0.50/kg = $500/MT)
 *   convertUnitPrice(500, "MT", "kg") → 0.50  ($500/MT = $0.50/kg)
 */
export function convertUnitPrice(
  pricePerFromUnit: number,
  fromUnit: string,
  toUnit: string
): number | null {
  const factor = convertUnit(1, fromUnit, toUnit);
  if (factor == null) return null;
  return pricePerFromUnit * factor;
}

/**
 * Get a human-readable conversion description.
 * Returns null if conversion is not possible.
 *
 * Example: describeConversion("kg", "MT") → "1 MT = 1,000 kg"
 */
export function describeConversion(fromUnit: string, toUnit: string): string | null {
  if (fromUnit === toUnit) return null;
  const factor = convertUnit(1, fromUnit, toUnit);
  if (factor == null) return null;

  // Format: if factor is large, show "1 toUnit = X fromUnit"
  //         if factor is small, show "1 fromUnit = X toUnit"
  if (factor >= 1) {
    return `1 ${toUnit} = ${factor.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${fromUnit}`;
  } else {
    const inverse = 1 / factor;
    return `1 ${fromUnit} = ${inverse.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${toUnit}`;
  }
}

/**
 * Check if two units can be converted between each other.
 */
export function canConvert(fromUnit: string, toUnit: string): boolean {
  if (fromUnit === toUnit) return true;
  const fromCat = getCategory(fromUnit);
  const toCat = getCategory(toUnit);
  if (fromCat !== toCat) return false;
  if (fromCat === "count" || fromCat === "other") return fromUnit === toUnit;
  return getFactor(fromUnit) != null && getFactor(toUnit) != null;
}

/**
 * Get the category of a unit (for UI grouping).
 */
export function getUnitCategory(unit: string): Category {
  return getCategory(unit);
}
