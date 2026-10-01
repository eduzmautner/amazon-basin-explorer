// Towns and cities of the Amazon basin from GeoNames (cities500: populated places of 500+ people),
// for the settlement dots and the remoteness colouring of the river trails.
// Input:  data/raw/geonames/cities500.txt (https://download.geonames.org/export/dump/cities500.zip, CC BY 4.0)
//         data/work/amazon.ndjson (the river network: a place counts only if it is near one of our rivers)
//         data/raw/geonames/admin1CodesASCII.txt (province names), data/work/river-sections.json (from build-riverinfo.mjs)
// Output: public/settlements.json (GeoJSON points: name, pop, kind, country, admin1, elev, nearest named river) and data/work/settlements.json
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { OUTSIDE_LEVEL } from './config.mjs';

const IN = 'data/raw/geonames/cities500.txt';
const ADMIN1 = 'data/raw/geonames/admin1CodesASCII.txt';
const SECTIONS = 'data/work/river-sections.json';
const RIVER_SEARCH_KM = 60; // how far to look for a named river
const COUNTRY = { BR: 'Brazil', PE: 'Peru', BO: 'Bolivia', CO: 'Colombia', EC: 'Ecuador', VE: 'Venezuela', GY: 'Guyana', SR: 'Suriname', GF: 'French Guiana' };
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
  const [, name, , , latS, lonS, fclass, fcode, cc, , admin1, , , , popS, elevS, demS] = f;
  const lat = +latS, lon = +lonS, pop = +popS, elev = elevS !== '' ? +elevS : demS !== '' ? +demS : null;
  if (fclass !== 'P' || !KEEP.has(fcode) || pop < MIN_POP) continue;
  if (lon < BBOX.w || lon > BBOX.e || lat < BBOX.s || lat > BBOX.n) continue;
  if (!nearRiver(lon, lat)) continue;
  places.push({ name, lon, lat, pop, cc, admin1: admin1 ? `${cc}.${admin1}` : null, elev, inBasin: inBasin(lon, lat) });
}
places.sort((a, b) => b.pop - a.pop);
const km = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), a.lat - b.lat) * 111.32;
const kept = [];
for (const p of places) if (!kept.some((q) => km(p, q) < DEDUPE_KM)) kept.push(p);
console.log('places in bbox near rivers:', places.length, 'after dedupe:', kept.length, 'inside the basin:', kept.filter((p) => p.inBasin).length);
console.log('near but outside the basin (glow only, no dot):', kept.filter((p) => !p.inBasin && p.pop >= 50000).map((p) => p.name).join(', '));
console.log('cities (100k+):', kept.filter((p) => p.pop >= CITY_POP).map((p) => `${p.name} ${p.pop}`).join(', '));
const byCountry = {}; for (const p of kept) byCountry[p.cc] = (byCountry[p.cc] || 0) + 1; console.log(byCountry);

// province names
const admin1Name = new Map(fs.readFileSync(ADMIN1, 'utf8').split('\n').filter(Boolean).map((l) => { const [code, nm] = l.split('\t'); return [code, nm.replace(/ (Department|Region|Province|State)$/, '')]; }));

// nearest named river. Towns sit on a big river but even closer to some creek that drains through
// them, so of the named rivers within NEAR_KM the biggest (by upstream area) wins; failing that, the
// nearest within RIVER_SEARCH_KM. Looked up by reach vertices (HydroRIVERS vertices sit ~460 m apart).
const NEAR_KM = 10;
const sections = JSON.parse(fs.readFileSync(SECTIONS, 'utf8'));
const reachRiver = new Map(); // reach id -> { rid, name } of the longest river section through it
for (const s of sections) for (const id of s.reaches) { const cur = reachRiver.get(id); if (!cur || cur.lengthKm < s.lengthKm) reachRiver.set(id, { rid: s.rid, name: s.rid.slice(s.rid.indexOf('|') + 1), lengthKm: s.lengthKm }); }
const VCELL = 0.05;
const vgrid = new Map(); // cell -> [lon, lat, reachId, up]
for await (const line of readline.createInterface({ input: fs.createReadStream(RIVERS) })) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (!reachRiver.has(r.id)) continue;
  for (const [x, y] of r.c) { const k = Math.floor(x / VCELL) + ',' + Math.floor(y / VCELL); (vgrid.get(k) ?? vgrid.set(k, []).get(k)).push([x, y, r.id, r.up]); }
}
const nearestRiver = (lon, lat) => {
  const cosl = Math.cos((lat * Math.PI) / 180);
  const gx = Math.floor(lon / VCELL), gy = Math.floor(lat / VCELL);
  const byRiver = new Map(); // rid -> closest approach of that river, with its size
  const rings = Math.ceil(RIVER_SEARCH_KM / 111.32 / VCELL);
  for (let dx = -rings; dx <= rings; dx++) for (let dy = -rings; dy <= rings; dy++) {
    for (const [x, y, id, up] of vgrid.get((gx + dx) + ',' + (gy + dy)) ?? []) {
      const d = Math.hypot((x - lon) * cosl, y - lat) * 111.32;
      if (d > RIVER_SEARCH_KM) continue;
      const rv = reachRiver.get(id), cur = byRiver.get(rv.rid);
      if (!cur) byRiver.set(rv.rid, { km: d, up, ...rv });
      else { if (d < cur.km) cur.km = d; if (up > cur.up) cur.up = up; }
    }
  }
  const all = [...byRiver.values()];
  if (!all.length) return null;
  const near = all.filter((r) => r.km <= NEAR_KM);
  // creeks and canals rank below rivers whatever reach they were matched to
  const size = (r) => (/^(canal|igarap[eé]|quebrada|c[oó]rrego|arroyo|arroio|riacho|grot[aã]o?|furo)/i.test(r.name) ? 0 : r.up);
  const pick = near.length ? near.reduce((p, r) => (size(r) > size(p) ? r : p)) : all.reduce((p, r) => (r.km < p.km ? r : p));
  return pick;
};

const features = kept.filter((p) => p.inBasin).map((p) => ({
  type: 'Feature',
  properties: { name: p.name, pop: p.pop, kind: p.pop >= CITY_POP ? 'city' : 'town', country: COUNTRY[p.cc] ?? p.cc, admin1: p.admin1 ? admin1Name.get(p.admin1) ?? null : null, elev: p.elev, ...((r) => (r ? { river: r.name, riverRid: r.rid, riverKm: Math.round(r.km * 10) / 10 } : {}))(nearestRiver(p.lon, p.lat)) },
  geometry: { type: 'Point', coordinates: [Math.round(p.lon * 1e4) / 1e4, Math.round(p.lat * 1e4) / 1e4] },
}));
fs.writeFileSync('public/settlements.json', JSON.stringify({ type: 'FeatureCollection', features }));
fs.writeFileSync('data/work/settlements.json', JSON.stringify(kept));
console.log('wrote public/settlements.json:', features.length, 'places,', fs.statSync('public/settlements.json').size, 'bytes');
console.log('without a province:', features.filter((f) => !f.properties.admin1).length, '| without a river within', RIVER_SEARCH_KM, 'km:', features.filter((f) => !f.properties.river).length);
console.log('sample:', features.slice(0, 4).map((f) => JSON.stringify(f.properties)).join('\n        '));
