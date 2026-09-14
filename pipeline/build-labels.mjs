// Builds river-name vector tiles.
//  1. read named OSM waterways (data/work/osm-names.ndjson)
//  2. chain ways that share a name and touch end-to-end into longer lines
//  3. match every line to the nearest HydroRIVERS reach to inherit its upstream area (size)
//  4. cut into vector tiles with geojson-vt, keeping in each zoom only rivers revealed at that zoom
// Output: public/labels/{z}/{x}/{y}.pbf and public/labels/index.json
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { REVEAL_THRESHOLD_BY_ZOOM, MAX_MASK_LEVEL } from './config.mjs';

const OSM = 'data/work/osm-names.ndjson';
const RIVERS = 'data/work/amazon.ndjson';
const OUT = 'public/labels';
const MIN_Z = 3, MAX_Z = 11;
const MATCH_KM = 1.5;      // max distance from an OSM vertex to a HydroRIVERS reach
const GRID_DEG = 0.05;     // spatial hash cell for reach lookup
// Label paths are generalised hard (extent units, 8 units = 1px at 512px tiles): MapLibre refuses to
// place text along lines that wiggle more than text-max-angle within a label length.
const LABEL_SIMPLIFY_PX = 10; // generalisation tolerance in screen pixels at each zoom

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------- 1. OSM ways ----------
const ways = [];
{
  const rl = readline.createInterface({ input: fs.createReadStream(OSM) });
  const seen = new Set();
  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    if (seen.has(f.properties.id)) continue; // chunk overlaps
    seen.add(f.properties.id);
    ways.push({ name: f.properties.name.trim(), kind: f.properties.kind, c: f.geometry.coordinates });
  }
}
log('OSM named ways:', ways.length);

// ---------- 2. chain ways by name ----------
const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const byName = new Map();
for (const w of ways) { if (!byName.has(w.name)) byName.set(w.name, []); byName.get(w.name).push(w); }
const lines = [];
for (const [name, group] of byName) {
  const used = new Uint8Array(group.length);
  const startIdx = new Map(), endIdx = new Map();
  group.forEach((w, i) => {
    const s = key(w.c[0]), e = key(w.c[w.c.length - 1]);
    (startIdx.get(s) ?? startIdx.set(s, []).get(s)).push(i);
    (endIdx.get(e) ?? endIdx.set(e, []).get(e)).push(i);
  });
  const take = (idx, i) => { const arr = idx.get(key(i)); return arr?.find((j) => !used[j]); };
  for (let i = 0; i < group.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let coords = group[i].c.slice();
    // extend forward
    for (;;) { const j = take(startIdx, coords[coords.length - 1]); if (j === undefined) break; used[j] = 1; coords = coords.concat(group[j].c.slice(1)); }
    // extend backward
    for (;;) { const j = take(endIdx, coords[0]); if (j === undefined) break; used[j] = 1; coords = group[j].c.slice(0, -1).concat(coords); }
    lines.push({ name, kind: group[i].kind, c: coords });
  }
}
log('chained lines:', lines.length, 'distinct names:', byName.size);

// ---------- 3. match to HydroRIVERS ----------
const grid = new Map(); // "gx,gy" -> array of [x1,y1,x2,y2,up]
{
  const rl = readline.createInterface({ input: fs.createReadStream(RIVERS) });
  let segs = 0;
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    for (let k = 0; k < r.c.length - 1; k++) {
      const [x1, y1] = r.c[k], [x2, y2] = r.c[k + 1];
      const gx0 = Math.floor(Math.min(x1, x2) / GRID_DEG), gx1 = Math.floor(Math.max(x1, x2) / GRID_DEG);
      const gy0 = Math.floor(Math.min(y1, y2) / GRID_DEG), gy1 = Math.floor(Math.max(y1, y2) / GRID_DEG);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        const k2 = gx + ',' + gy;
        (grid.get(k2) ?? grid.set(k2, []).get(k2)).push([x1, y1, x2, y2, r.up]);
      }
      segs++;
    }
  }
  log('reach segments indexed:', segs, 'cells:', grid.size);
}
const KM_PER_DEG = 111.32;
function nearestUp(lon, lat) {
  const cosl = Math.cos((lat * Math.PI) / 180);
  const rDeg = MATCH_KM / KM_PER_DEG;
  const gx0 = Math.floor((lon - rDeg) / GRID_DEG), gx1 = Math.floor((lon + rDeg) / GRID_DEG);
  const gy0 = Math.floor((lat - rDeg) / GRID_DEG), gy1 = Math.floor((lat + rDeg) / GRID_DEG);
  let best = Infinity, bestUp = -1;
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const cell = grid.get(gx + ',' + gy);
    if (!cell) continue;
    for (const [x1, y1, x2, y2, up] of cell) {
      const ax = (x1 - lon) * cosl, ay = y1 - lat, bx = (x2 - lon) * cosl, by = y2 - lat;
      const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy;
      let t = ll > 0 ? -(ax * dx + ay * dy) / ll : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx, ey = ay + t * dy, d2 = ex * ex + ey * ey;
      if (d2 < best) { best = d2; bestUp = up; }
    }
  }
  return Math.sqrt(best) * KM_PER_DEG <= MATCH_KM ? bestUp : -1;
}
const features = [];
let unmatched = 0;
for (const l of lines) {
  const n = l.c.length, samples = Math.min(n, 16);
  // median of the nearest reach sizes along the line: a tributary that hugs a big river near its
  // mouth would otherwise inherit the big river's size from one or two samples
  const ups = [];
  for (let s = 0; s < samples; s++) {
    const [lon, lat] = l.c[Math.floor((s * (n - 1)) / Math.max(1, samples - 1))];
    const u = nearestUp(lon, lat);
    if (u >= 0) ups.push(u);
  }
  if (ups.length < Math.max(1, samples / 2)) { unmatched++; continue; }
  ups.sort((a, b) => a - b);
  const up = ups[Math.floor(ups.length / 2)];
  // map zoom at which this river's corridor becomes visible (imagery tile zoom = map zoom + 1)
  let minz = MAX_MASK_LEVEL - 1;
  for (const [z, thr] of Object.entries(REVEAL_THRESHOLD_BY_ZOOM)) if (up >= thr) { minz = Math.max(MIN_Z, Number(z) - 1); break; }
  features.push({ type: 'Feature', properties: { name: l.name, up: Math.round(up), minz }, geometry: { type: 'LineString', coordinates: l.c } });
}
log('matched lines:', features.length, 'unmatched (outside basin or no reach nearby):', unmatched);

// ---------- 4. tiles ----------
// Douglas-Peucker in degrees (longitude scaled by cos(lat) so the tolerance is roughly isotropic)
function simplify(coords, tol) {
  if (coords.length <= 2) return coords;
  const cosl = Math.cos((coords[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(coords.length); keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = coords[a][0] * cosl, ay = coords[a][1], bx = coords[b][0] * cosl, by = coords[b][1];
    const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy;
    let best = -1, bestD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][0] * cosl, py = coords[i][1];
      let t = ll > 0 ? ((px - ax) * dx + (py - ay) * dy) / ll : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}
// Chaikin corner cutting: turns the generalised polyline into a gentle curve so text flows along it
function smooth(coords, iterations) {
  let c = coords;
  for (let k = 0; k < iterations && c.length > 2; k++) {
    const out = [c[0]];
    for (let i = 0; i < c.length - 1; i++) {
      const [x0, y0] = c[i], [x1, y1] = c[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(c[c.length - 1]);
    c = out;
  }
  return c;
}

fs.rmSync(OUT, { recursive: true, force: true });
let written = 0, bytes = 0;
const keys = [];
const thrForMapZoom = (z) => REVEAL_THRESHOLD_BY_ZOOM[Math.min(MAX_MASK_LEVEL, z + 1)] ?? 0;
for (let z = MIN_Z; z <= MAX_Z; z++) {
  const thr = thrForMapZoom(z);
  const degPerPx = 360 / (512 * 2 ** z);
  const zoomFeatures = features
    .filter((f) => f.properties.up >= thr)
    .map((f) => ({ ...f, geometry: { type: 'LineString', coordinates: smooth(simplify(f.geometry.coordinates, LABEL_SIMPLIFY_PX * degPerPx), 2) } }));
  const index = geojsonvt({ type: 'FeatureCollection', features: zoomFeatures }, { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, tolerance: 1, buffer: 128, extent: 4096 });
  let n = 0;
  for (const id of Object.keys(index.tiles)) {
    const raw = index.tiles[id];
    if (raw.z !== z || !raw.numFeatures) continue;
    // getTile() converts the internal flat geometry into the [x, y] pairs vt-pbf expects
    const t = index.getTile(raw.z, raw.x, raw.y);
    if (!t) continue;
    const feats = t.features;
    if (!feats.length) continue;
    const buf = vtpbf.fromGeojsonVt({ rivers: { ...t, features: feats } }, { version: 2, extent: 4096 });
    const dir = path.join(OUT, String(z), String(t.x));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${t.y}.pbf`), buf);
    keys.push(`${z}/${t.x}/${t.y}`);
    written++; bytes += buf.length; n++;
  }
  log(`z${z}: ${n} tiles (threshold ${thr} km²)`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ minzoom: MIN_Z, maxzoom: MAX_Z, tiles: written, names: byName.size, lines: features.length, keys }));
log(`wrote ${written} tiles, ${(bytes / 1048576).toFixed(1)} MB`);
