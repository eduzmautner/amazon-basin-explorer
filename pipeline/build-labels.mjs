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
const OSM_RELATIONS = 'data/work/osm-relations.ndjson'; // member ways of named river relations (optional)
const RIVERS = 'data/work/amazon.ndjson';
const OUT = 'public/labels';
const MIN_Z = 3, MAX_Z = 11;
const MATCH_KM = 1.5;      // max distance from an OSM vertex to a HydroRIVERS reach
const MATCH_KM_WIDE = 6;   // fallback for the widest rivers, whose OSM centreline can sit far from HydroRIVERS'
// Names that denote creeks, side channels or lakes cannot be big rivers; matches onto reaches above
// this upstream area are strays (a floodplain creek snapping to the main stem beside it).
const MINOR_NAME = /^(igarap[eé]|furo|paran[aáã]|canal|bra[cç]o|quebrada|ca[nñ]o|lago|lagoa|entrada|sacado|riacho|c[oó]rrego|arroyo|demarca)/i;
const MINOR_MAX_UP = 20000;
// A line this long is a big river; along big rivers the nearest reach is often a floodplain side
// channel, so for long lines take the largest reach within range instead of the nearest.
const LONG_LINE_KM = 200;
const GRID_DEG = 0.05;     // spatial hash cell for reach lookup
// Label paths are generalised hard (extent units, 8 units = 1px at 512px tiles): MapLibre refuses to
// place text along lines that wiggle more than text-max-angle within a label length.
const LABEL_SIMPLIFY_PX = 10; // generalisation tolerance in screen pixels at each zoom

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------- 1. OSM ways ----------
const ways = [];
{
  const seen = new Set();
  // named ways first so a way's own name wins over a relation's; relation members fill the gaps
  for (const file of [OSM, OSM_RELATIONS]) {
    if (!fs.existsSync(file)) continue;
    let n = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    for await (const line of rl) {
      if (!line) continue;
      const f = JSON.parse(line);
      if (seen.has(f.properties.id)) continue; // chunk overlaps / already named
      seen.add(f.properties.id);
      ways.push({ name: f.properties.name.trim(), kind: f.properties.kind, c: f.geometry.coordinates });
      n++;
    }
    log(`${file}: ${n} ways`);
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
const grid = new Map(); // "gx,gy" -> array of [x1,y1,x2,y2,up,id]
const reachInfo = new Map(); // id -> { down, up }
{
  const rl = readline.createInterface({ input: fs.createReadStream(RIVERS) });
  let segs = 0;
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    reachInfo.set(r.id, { down: r.down, up: r.up });
    for (let k = 0; k < r.c.length - 1; k++) {
      const [x1, y1] = r.c[k], [x2, y2] = r.c[k + 1];
      const gx0 = Math.floor(Math.min(x1, x2) / GRID_DEG), gx1 = Math.floor(Math.max(x1, x2) / GRID_DEG);
      const gy0 = Math.floor(Math.min(y1, y2) / GRID_DEG), gy1 = Math.floor(Math.max(y1, y2) / GRID_DEG);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        const k2 = gx + ',' + gy;
        (grid.get(k2) ?? grid.set(k2, []).get(k2)).push([x1, y1, x2, y2, r.up, r.id]);
      }
      segs++;
    }
  }
  log('reach segments indexed:', segs, 'cells:', grid.size);
}
const KM_PER_DEG = 111.32;
function largestUpWithin(lon, lat, maxKm) {
  const cosl = Math.cos((lat * Math.PI) / 180);
  const rDeg = maxKm / KM_PER_DEG;
  const gx0 = Math.floor((lon - rDeg) / GRID_DEG), gx1 = Math.floor((lon + rDeg) / GRID_DEG);
  const gy0 = Math.floor((lat - rDeg) / GRID_DEG), gy1 = Math.floor((lat + rDeg) / GRID_DEG);
  const max2 = (maxKm / KM_PER_DEG) ** 2;
  let bestUp = -1, bestId = 0;
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const cell = grid.get(gx + ',' + gy);
    if (!cell) continue;
    for (const [x1, y1, x2, y2, up, id] of cell) {
      if (up <= bestUp) continue;
      const ax = (x1 - lon) * cosl, ay = y1 - lat, bx = (x2 - lon) * cosl, by = y2 - lat;
      const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy;
      let t = ll > 0 ? -(ax * dx + ay * dy) / ll : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx, ey = ay + t * dy;
      if (ex * ex + ey * ey <= max2) { bestUp = up; bestId = id; }
    }
  }
  return bestUp >= 0 ? [bestUp, bestId] : null;
}
function nearestUp(lon, lat, maxKm = MATCH_KM) {
  const cosl = Math.cos((lat * Math.PI) / 180);
  const rDeg = maxKm / KM_PER_DEG;
  const gx0 = Math.floor((lon - rDeg) / GRID_DEG), gx1 = Math.floor((lon + rDeg) / GRID_DEG);
  const gy0 = Math.floor((lat - rDeg) / GRID_DEG), gy1 = Math.floor((lat + rDeg) / GRID_DEG);
  let best = Infinity, bestUp = -1, bestId = 0;
  for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
    const cell = grid.get(gx + ',' + gy);
    if (!cell) continue;
    for (const [x1, y1, x2, y2, up, id] of cell) {
      const ax = (x1 - lon) * cosl, ay = y1 - lat, bx = (x2 - lon) * cosl, by = y2 - lat;
      const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy;
      let t = ll > 0 ? -(ax * dx + ay * dy) / ll : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx, ey = ay + t * dy, d2 = ex * ex + ey * ey;
      if (d2 < best) { best = d2; bestUp = up; bestId = id; }
    }
  }
  return Math.sqrt(best) * KM_PER_DEG <= maxKm ? [bestUp, bestId] : null;
}
const features = [];
let unmatched = 0;
for (const l of lines) {
  const n = l.c.length, samples = Math.min(n, 16);
  // median of the nearest reach sizes along the line: a tributary that hugs a big river near its
  // mouth would otherwise inherit the big river's size from one or two samples
  let lineKm = 0;
  for (let i = 1; i < n; i++) { const [x0, y0] = l.c[i - 1], [x1, y1] = l.c[i]; lineKm += Math.hypot((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0) * KM_PER_DEG; }
  const matcher = lineKm >= LONG_LINE_KM ? (lon, lat) => largestUpWithin(lon, lat, MATCH_KM_WIDE) : nearestUp;
  const sample = (maxKm) => {
    const hits = [];
    for (let s = 0; s < samples; s++) {
      const [lon, lat] = l.c[Math.floor((s * (n - 1)) / Math.max(1, samples - 1))];
      const h = matcher(lon, lat, maxKm);
      if (h) hits.push(h);
    }
    return hits;
  };
  const minor = MINOR_NAME.test(l.name);
  const plausible = (hs) => (minor ? hs.filter((h) => h[0] <= MINOR_MAX_UP) : hs);
  let hits = plausible(sample(MATCH_KM));
  // wide rivers: the OSM line may run along one channel of a braided, multi-km-wide river
  if (hits.length < Math.max(1, samples / 2)) hits = plausible(sample(MATCH_KM_WIDE));
  if (hits.length < Math.max(1, samples / 2)) { unmatched++; continue; }
  const ups = hits.map((h) => h[0]).sort((a, b) => a - b);
  const up = ups[Math.floor(ups.length / 2)];
  const reachIds = [...new Set(hits.map((h) => h[1]))];
  // map zoom at which this river's corridor becomes visible (imagery tile zoom = map zoom + 1)
  let minz = MAX_MASK_LEVEL - 1;
  for (const [z, thr] of Object.entries(REVEAL_THRESHOLD_BY_ZOOM)) if (up >= thr) { minz = Math.max(MIN_Z, Number(z) - 1); break; }
  features.push({ type: 'Feature', properties: { name: l.name, up: Math.round(up), minz, reachIds, lineKm }, geometry: { type: 'LineString', coordinates: l.c } });
}
log('matched lines:', features.length, 'unmatched (outside basin or no reach nearby):', unmatched);

// ---------- 3b. river identity ----------
// Chains as in build-rivers.mjs: at each confluence the largest upstream reach continues. Lines that
// share a name and sit on the same chain are one river; the id is "<chain mouth reach>|<name>", so
// two different "Rio Preto"s stay apart while the many OSM pieces of one river collapse together.
const mainPred = new Map();
for (const [id, r] of reachInfo) {
  if (!reachInfo.has(r.down)) continue;
  const cur = mainPred.get(r.down);
  if (cur === undefined || reachInfo.get(cur).up < r.up) mainPred.set(r.down, id);
}
const chainMouthCache = new Map();
const chainMouth = (id) => {
  if (chainMouthCache.has(id)) return chainMouthCache.get(id);
  const path = [id]; let cur = id;
  for (;;) { const next = reachInfo.get(cur).down; if (!reachInfo.has(next) || mainPred.get(next) !== cur) break; cur = next; path.push(cur); }
  for (const p of path) chainMouthCache.set(p, cur);
  return cur;
};
const rivers = new Map(); // rid -> { name, reaches: Set, lineUps: [] } (lineUps: one median size per OSM line)
for (const f of features) {
  const p = f.properties;
  const best = p.reachIds.reduce((a, b) => (reachInfo.get(b).up > reachInfo.get(a).up ? b : a));
  const rid = chainMouth(best) + '|' + p.name;
  p.rid = rid;
  const r = rivers.get(rid) ?? rivers.set(rid, { name: p.name, reaches: new Set(), lineUps: [] }).get(rid);
  for (const id of p.reachIds) r.reaches.add(id);
  r.lineUps.push([p.up, p.lineKm]); // [size, length km]: length-weighted, so a river's long main line outweighs bank-side pieces
  delete p.reachIds; delete p.lineKm;
}
// Side channels (paranás) of a big river carry the river's name in OSM but sit on their own short
// chains. Fold a name's minor groups into its dominant group when their chain flows straight into it.
const ridsByName = new Map();
for (const [rid, r] of rivers) (ridsByName.get(r.name) ?? ridsByName.set(r.name, []).get(r.name)).push(rid);
const alias = new Map();
for (const [, rids] of ridsByName) {
  if (rids.length < 2) continue;
  const dominant = rids.reduce((a, b) => (rivers.get(b).reaches.size > rivers.get(a).reaches.size ? b : a));
  const domMouth = Number(dominant.split('|')[0]);
  const domChain = new Set(); // every reach on the dominant chain, from its mouth back up the main path
  for (let cur = domMouth; cur !== undefined; cur = mainPred.get(cur)) domChain.add(cur);
  for (const rid of rids) {
    if (rid === dominant) continue;
    const mouth = Number(rid.split('|')[0]);
    // walk downstream a little: a paraná may join another paraná before rejoining the main river
    let into = reachInfo.get(mouth)?.down, joins = false;
    for (let hops = 0; hops < 40 && into !== undefined && reachInfo.has(into); hops++) { if (domChain.has(into)) { joins = true; break; } into = reachInfo.get(into).down; }
    if (joins && rivers.get(rid).reaches.size <= rivers.get(dominant).reaches.size) {
      alias.set(rid, dominant);
      for (const id of rivers.get(rid).reaches) rivers.get(dominant).reaches.add(id);
      rivers.get(dominant).lineUps.push(...rivers.get(rid).lineUps);
      rivers.delete(rid);
    }
  }
}
for (const f of features) if (alias.has(f.properties.rid)) f.properties.rid = alias.get(f.properties.rid);
log('side channels folded into their river:', alias.size);
fs.writeFileSync('data/work/label-rivers.json', JSON.stringify([...rivers].map(([rid, r]) => ({ rid, name: r.name, reaches: [...r.reaches], lineUps: r.lineUps }))));
log('distinct rivers (name on a chain):', rivers.size, '-> data/work/label-rivers.json');

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
