/**
 * Country-border crossing detection for land route legs.
 *
 * Uses a bundled Natural Earth 50m country boundary dataset (world-atlas,
 * via topojson-client) so this works fully offline — no external API calls,
 * no rate limits, no key. Bundled once at module load and reused for every
 * request within this server process.
 */
import * as topojson from "topojson-client";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon, BBox } from "geojson";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const countriesTopo = require("world-atlas/countries-50m.json");

interface CountryFeature {
  name: string;
  bbox: BBox;
  feature: Feature<Polygon | MultiPolygon>;
}

let countries: CountryFeature[] | null = null;

function loadCountries(): CountryFeature[] {
  if (countries) return countries;
  const geo = topojson.feature(
    countriesTopo,
    countriesTopo.objects.countries,
  ) as unknown as { features: Feature<Polygon | MultiPolygon>[] };
  countries = geo.features
    .filter((f) => !!f.properties?.name)
    .map((f) => ({
      name: f.properties!.name as string,
      bbox: turf.bbox(f),
      feature: f,
    }));
  return countries;
}

function bboxContains(bbox: BBox, lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Look up which country a point falls in. Returns null over open ocean / gaps. */
export function countryNameAt(lng: number, lat: number): string | null {
  const list = loadCountries();
  const pt = turf.point([lng, lat]);
  for (const c of list) {
    if (!bboxContains(c.bbox, lng, lat)) continue;
    if (turf.booleanPointInPolygon(pt, c.feature)) return c.name;
  }
  return null;
}

export interface BorderCrossing {
  fromCountry: string;
  toCountry: string;
  at: [number, number]; // [lng, lat]
  distanceKm: number; // distance along the line from the start
}

/**
 * Walk a route line (array of [lng, lat] pairs) and detect every point
 * where it passes from one country's territory into another's.
 * Samples the line at a fixed interval rather than relying on OSRM's
 * vertex density, so results are consistent regardless of geometry detail.
 */
export function detectBorderCrossings(
  lineCoords: [number, number][],
  sampleIntervalKm = 5,
): BorderCrossing[] {
  if (lineCoords.length < 2) return [];

  const line = turf.lineString(lineCoords);
  const totalKm = turf.length(line, { units: "kilometers" });
  if (totalKm === 0) return [];

  const steps = Math.max(2, Math.ceil(totalKm / sampleIntervalKm));
  const crossings: BorderCrossing[] = [];
  let lastCountry: string | null = null;

  for (let i = 0; i <= steps; i++) {
    const distKm = (i / steps) * totalKm;
    const pt = turf.along(line, distKm, { units: "kilometers" });
    const [lng, lat] = pt.geometry.coordinates;
    const country = countryNameAt(lng, lat);

    if (country && lastCountry && country !== lastCountry) {
      crossings.push({
        fromCountry: lastCountry,
        toCountry: country,
        at: [lng, lat],
        distanceKm: Math.round(distKm),
      });
    }
    if (country) lastCountry = country;
  }

  return crossings;
}
