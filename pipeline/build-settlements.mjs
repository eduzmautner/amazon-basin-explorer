// Towns and cities of the Amazon basin from GeoNames (cities500: populated places of 500+ people),
// for the settlement dots and the remoteness colouring of the river trails.
// Input:  data/raw/geonames/cities500.txt (https://download.geonames.org/export/dump/cities500.zip, CC BY 4.0)
//         data/work/amazon.ndjson (the river network: a place counts only if it is near one of our rivers)
// Output: public/settlements.json (GeoJSON points: name, pop, kind) and data/work/settlements.json
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { OUTSIDE_LEVEL } from './config.mjs';

const IN = 'data/raw/geonames/cities500.txt';
const RIVERS = 'data/work/amazon.ndjson';
const MIN_POP = 2000;            // "a small town and above"
const CITY_POP = 100000;         // drawn with a name at every zoom
const NEAR_RIVER_DEG = 0.15;     // ~16 km: keeps places on the basin's rivers, drops the rest of the continent
const DEDUPE_KM = 3;             // GeoNames sometimes lists a town and its municipality seat as two points
const BBOX = { w: -82, e: -44, s: -22, n: 8 };
// populated-place codes to keep; PPLX (a neighbourhood), PPLQ/PPLW (abandoned) and PPLH (historical) are dropped
const KEEP = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLF', 'PPLG', 'PPLL', 'PPLR', 'PPLS']);

// inside the basin? the reveal grid (public/mask) marks cells outside the basin with OUTSIDE_LEVEL
const maskIndex = JSON.parse(fs.readFileSync('public/mask/index.json', 'utf8'));
const F = maskIndex.finest;
const packed = zlib.gunzipSync(fs.readFileSync('public/mask/' + F.file));
const inBasin = (lon, lat) => {
  const n = 2 ** F.maskZoom, sn = Math.sin((lat * Math.PI) / 180);
  const cx = Math.floor(((lon + 180) / 360) * n) - F.x0, cy = Math.floor((0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n) - F.y0;
  if (cx < 0 || cy < 0 || cx >= F.w || cy >= F.h) return false;
  const i = cy * F.w + cx, b = packed[i >> 1];
  return ((i & 1) ? (b & 15) : (b >> 4)) !== OUTSIDE_LEVEL;
};

// cells (0.15°) touched by any river vertex
const cells = new Set();
for await (const line of readline.createInterface({ input: fs.createReadStream(RIVERS) })) {
  if (!line) continue;
  const r = JSON.parse(line);
  for (const [x, y] of r.c) cells.add(Math.floor(x / NEAR_RIVER_DEG) + ',' + Math.floor(y / NEAR_RIVER_DEG));
}
const nearRiver = (lon, lat) => {
  const gx = Math.floor(lon / NEAR_RIVER_DEG), gy = Math.floor(lat / NEAR_RIVER_DEG);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (cells.has((gx + dx) + ',' + (gy + dy))) return true;
  return false;
};

const places = [];
for (const line of fs.readFileSync(IN, 'utf8').split('\n')) {
  const f = line.split('\t');
  if (f.length < 15) continue;
  const [, name, , , latS, lonS, fclass, fcode, cc, , , , , , popS] = f;
  const lat = +latS, lon = +lonS, pop = +popS;
  if (fclass !== 'P' || !KEEP.has(fcode) || pop < MIN_POP) continue;
  if (lon < BBOX.w || lon > BBOX.e || lat < BBOX.s || lat > BBOX.n) continue;
  if (!nearRiver(lon, lat)) continue;
  places.push({ name, lon, lat, pop, cc, inBasin: inBasin(lon, lat) });
}
places.sort((a, b) => b.pop - a.pop);
const km = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), a.lat - b.lat) * 111.32;
const kept = [];
for (const p of places) if (!kept.some((q) => km(p, q) < DEDUPE_KM)) kept.push(p);
console.log('places in bbox near rivers:', places.length, 'after dedupe:', kept.length, 'inside the basin:', kept.filter((p) => p.inBasin).length);
console.log('near but outside the basin (glow only, no dot):', kept.filter((p) => !p.inBasin && p.pop >= 50000).map((p) => p.name).join(', '));
console.log('cities (100k+):', kept.filter((p) => p.pop >= CITY_POP).map((p) => `${p.name} ${p.pop}`).join(', '));
const byCountry = {}; for (const p of kept) byCountry[p.cc] = (byCountry[p.cc] || 0) + 1; console.log(byCountry);

const features = kept.filter((p) => p.inBasin).map((p) => ({
  type: 'Feature',
  properties: { name: p.name, pop: p.pop, kind: p.pop >= CITY_POP ? 'city' : 'town' },
  geometry: { type: 'Point', coordinates: [Math.round(p.lon * 1e4) / 1e4, Math.round(p.lat * 1e4) / 1e4] },
}));
fs.writeFileSync('public/settlements.json', JSON.stringify({ type: 'FeatureCollection', features }));
fs.writeFileSync('data/work/settlements.json', JSON.stringify(kept));
console.log('wrote public/settlements.json:', features.length, 'places,', fs.statSync('public/settlements.json').size, 'bytes');
