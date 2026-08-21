#!/usr/bin/env node
/**
 * Regenerates the static assets Trade Globe's basemap depends on:
 *   - public/map/countries-110m.geojson  (world country outlines)
 *   - public/map/maplibre-gl-worker.mjs  (MapLibre's tile-processing worker)
 *   - public/map/maplibre-gl-shared.mjs  (worker's shared runtime chunk)
 *
 * The worker/shared files must be copied from node_modules rather than
 * loaded from MapLibre's default `import.meta.url`-relative path: under
 * Turbopack/webpack that module is bundled into a hashed chunk, so the
 * auto-detected worker URL 404s and every GeoJSON-backed source (route
 * lines, country fills) hangs forever with no error surfaced. Serving our
 * own copy and pointing `maplibregl.setWorkerUrl()` at it sidesteps that.
 *
 * Re-run this after bumping the `maplibre-gl` or `world-atlas` version.
 */
const fs = require("fs");
const path = require("path");
const topojson = require("topojson-client");

const outDir = path.join(__dirname, "..", "public", "map");
fs.mkdirSync(outDir, { recursive: true });

const topo = require("world-atlas/countries-110m.json");
const geo = topojson.feature(topo, topo.objects.countries);
fs.writeFileSync(path.join(outDir, "countries-110m.geojson"), JSON.stringify(geo));

const maplibreDist = path.join(__dirname, "..", "node_modules", "maplibre-gl", "dist");
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  fs.copyFileSync(path.join(maplibreDist, file), path.join(outDir, file));
}

console.log("Wrote public/map/{countries-110m.geojson,maplibre-gl-worker.mjs,maplibre-gl-shared.mjs}");
