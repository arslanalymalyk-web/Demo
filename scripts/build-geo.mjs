// Builds the bundled base geography for the map from Natural Earth (public domain) via the world-atlas package.
// The output is pre-projected SVG path data, so the app needs no map library and no network. Run: node scripts/build-geo.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";

const EXTENT = { lonMin: 32, lonMax: 66, latMin: 11, latMax: 34 };
const WIDTH = 1000;
const NAMES = ["Saudi Arabia", "United Arab Emirates", "Kuwait", "Qatar", "Bahrain", "Oman", "Iraq", "Iran", "Yemen", "Jordan", "Syria", "Egypt", "Sudan", "Eritrea", "Djibouti", "Ethiopia", "Somalia", "Somaliland", "Pakistan", "Israel", "Lebanon", "Turkey", "Afghanistan", "Turkmenistan", "Palestine", "Cyprus", "Libya", "South Sudan", "Uzbekistan"];

const rad = d => d * Math.PI / 180;
const my = lat => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
const R = WIDTH / rad(EXTENT.lonMax - EXTENT.lonMin);
const project = (lon, lat) => [(rad(lon - EXTENT.lonMin)) * R, (my(EXTENT.latMax) - my(lat)) * R];
const HEIGHT = Math.round(project(EXTENT.lonMin, EXTENT.latMin)[1]);

const topo = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/countries-50m.json", import.meta.url), "utf8"));
const fc = feature(topo, topo.objects.countries);
const found = new Set();
const countries = [];
for (const f of fc.features) {
  if (!NAMES.includes(f.properties.name)) continue;
  found.add(f.properties.name);
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  let d = "";
  for (const poly of polys) for (const ring of poly) {
    // skip rings that lie wholly outside the view, with a margin
    if (ring.every(([lon, lat]) => lon < EXTENT.lonMin - 4 || lon > EXTENT.lonMax + 4 || lat < EXTENT.latMin - 4 || lat > EXTENT.latMax + 4)) continue;
    d += ring.map(([lon, lat], i) => { const [x, y] = project(lon, lat); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join("") + "Z";
  }
  if (d) countries.push({ name: f.properties.name, d });
}
const missing = NAMES.filter(n => !found.has(n));
if (missing.length) console.warn("not in the dataset:", missing.join(", "));
const out = { extent: EXTENT, width: WIDTH, height: HEIGHT, radius: R, source: "Natural Earth, public domain, via the world-atlas package (ISC)", countries };
writeFileSync(new URL("../apps/web/src/geo/gulf.json", import.meta.url), JSON.stringify(out));
console.log(`countries: ${countries.length}, size: ${(JSON.stringify(out).length / 1024).toFixed(0)} KB, view ${WIDTH}x${HEIGHT}`);
