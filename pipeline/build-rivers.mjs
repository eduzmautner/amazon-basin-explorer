// River centrelines (HydroRIVERS) as vector tiles for the "River Trails" overlay.
// Low zooms carry only the bigger rivers so tiles stay small; z10 carries every reach and is
// overzoomed beyond that (the source is ~460 m resolution, so nothing is lost).
// Output: public/rivers/{z}/{x}/{y}.pbf + public/rivers/index.json
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

const IN = 'data/work/amazon.ndjson';
const OUT = 'public/rivers';
const MIN_Z = 3, MAX_Z = 10;
const THRESHOLD = { 3: 40000, 4: 40000, 5: 15000, 6: 5000, 7: 1500, 8: 500, 9: 100, 10: 0 }; // km² upstream
const SETTLEMENTS = 'data/work/settlements.json'; // from build-settlements.mjs (optional)

// Remoteness: every town casts a glow that fades with distance; a stretch of river takes the strongest
// glow reaching it, scored 0 (no town in reach) .. 99 (in a big city) and drawn white .. orange.
//   strength S(pop): 0.3 for a 2,000 town rising on a log scale to 1 at 2.2 million (Manaus)
//   reach R(pop): 7.5 km for a 2,000 town, growing with the cube root of population (~77 km for Manaus)
//   glow = S * exp(-d / R), d = straight-line distance from the reach's midpoint
const REM_LEVELS = 100, REM_POP0 = 2000, REM_POP1 = 2.2e6, REM_S0 = 0.3, REM_R0_KM = 7.5, REM_FLOOR = 0.005;
const KM_PER_DEG = 111.32;
const settlements = fs.existsSync(SETTLEMENTS) ? JSON.parse(fs.readFileSync(SETTLEMENTS, 'utf8')).map((p) => {
  const S = REM_S0 + (1 - REM_S0) * Math.min(1, Math.max(0, Math.log10(p.pop / REM_POP0) / Math.log10(REM_POP1 / REM_POP0)));
  const R = REM_R0_KM * Math.cbrt(p.pop / REM_POP0);
  const reachKm = R * Math.log(S / REM_FLOOR); // beyond this the glow is below the floor: skip the distance
  return { lon: p.lon, lat: p.lat, cosl: Math.cos((p.lat * Math.PI) / 180), S, R, reachDeg: reachKm / KM_PER_DEG };
}) : [];
function remoteness(lon, lat) {
  let best = 0;
  for (const s of settlements) {
    const dy = lat - s.lat; if (dy > s.reachDeg || dy < -s.reachDeg) continue;
    const dx = (lon - s.lon) * s.cosl; if (dx > s.reachDeg || dx < -s.reachDeg) continue;
    const g = s.S * Math.exp(-(Math.hypot(dx, dy) * KM_PER_DEG) / s.R);
    if (g > best) best = g;
  }
  return Math.min(REM_LEVELS - 1, Math.round(best * (REM_LEVELS - 1)));
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
// 1. load reaches
const reaches = new Map(); // id -> { down, up, ord, c }
{
  const rl = readline.createInterface({ input: fs.createReadStream(IN) });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    const mid = r.c[Math.floor(r.c.length / 2)];
    reaches.set(r.id, { down: r.down, up: r.up, ord: r.stra, c: r.c, rem: remoteness(mid[0], mid[1]) });
  }
}
log('reaches:', reaches.size, 'settlements for remoteness:', settlements.length);
{
  const hist = new Array(10).fill(0);
  for (const r of reaches.values()) hist[Math.min(9, Math.floor(r.rem / 10))]++;
  log('remoteness levels by decile (0-9, 10-19, ...):', hist.join(' '));
}

// 2. chain reaches into continuous rivers. At each confluence the largest upstream reach continues
//    the line; the others end there. So a river is one feature from its head to where it joins a
//    bigger one, and line ends only overlap at real confluences instead of every 4 km.
//    Each chain is then cut into runs of constant Strahler order (the style fades lines by order),
//    after smoothing so the cut falls on the curve, with the cut vertex shared by both runs.
const mainPred = new Map(); // downstream id -> id of its largest upstream reach
for (const [id, r] of reaches) {
  if (!reaches.has(r.down)) continue;
  const cur = mainPred.get(r.down);
  if (cur === undefined || reaches.get(cur).up < r.up) mainPred.set(r.down, id);
}
const isMainPredOfSomething = new Set(mainPred.values());
const hasUpstream = new Set(mainPred.keys());
const chains = []; // { up, runs: [{ ord, rem, c, km }] }, runs in downstream order sharing their end vertices
for (const [id] of reaches) {
  if (hasUpstream.has(id)) continue; // not a headwater: some chain passes through it
  const coords = [];
  const runs = []; // { ord, rem, start }: index in coords of the run's first vertex
  let cur = id, maxUp = 0;
  for (;;) {
    const r = reaches.get(cur);
    maxUp = Math.max(maxUp, r.up);
    const start = coords.length ? coords.length - 1 : 0;
    const last = runs[runs.length - 1];
    if (!last || last.ord !== r.ord || last.rem !== r.rem) runs.push({ ord: r.ord, rem: r.rem, start });
    for (let i = coords.length ? 1 : 0; i < r.c.length; i++) coords.push(r.c[i]);
    const next = r.down;
    if (!reaches.has(next) || mainPred.get(next) !== cur) break;
    cur = next;
  }
  // smooth() maps source vertex i to smoothed vertex 2i per pass (endpoints stay put), so a run
  // boundary at source vertex b sits at smoothed vertex b * (smoothed.length / coords.length)
  const sm = smooth(coords, 2);
  const f = sm.length / coords.length; // 4 after two passes, 1 when the chain was too short to smooth
  const up = Math.round(maxUp); // the chain's size at its mouth, on every run, so big rivers draw whole at low zoom
  const chain = { up, runs: [] };
  for (let k = 0; k < runs.length; k++) {
    const a = runs[k].start * f, b = k + 1 < runs.length ? runs[k + 1].start * f : sm.length - 1;
    const seg = sm.slice(a, b + 1);
    if (seg.length < 2) continue;
    chain.runs.push({ ord: runs[k].ord, rem: runs[k].rem, c: seg, km: lengthKm(seg) });
  }
  if (chain.runs.length) chains.push(chain);
}
void isMainPredOfSomething;
log('chains:', chains.length, 'runs after cutting by order and remoteness:', chains.reduce((n, ch) => n + ch.runs.length, 0));

function lengthKm(c) {
  let km = 0;
  for (let i = 1; i < c.length; i++) km += Math.hypot((c[i][0] - c[i - 1][0]) * Math.cos((c[i][1] * Math.PI) / 180), c[i][1] - c[i - 1][1]) * KM_PER_DEG;
  return km;
}

// The tiler drops any line shorter than its tolerance (about a pixel), so at low zooms the short runs
// where the remoteness level changes every few km would vanish and leave the trail dashed. For each
// zoom, runs shorter than MIN_RUN_PX are merged into their neighbours along the chain: the merged run
// takes the order of its longest part and the length-weighted mean remoteness level.
const MIN_RUN_PX = 6;
function featuresForZoom(z, subsetChains) {
  const kmPerPx = 40075 / (512 * 2 ** z); // at the equator; the basin sits near it
  const minKm = MIN_RUN_PX * kmPerPx;
  const out = [];
  for (const ch of subsetChains) {
    const groups = [];
    let g = null;
    for (const r of ch.runs) {
      if (g && (g.km < minKm || r.km < minKm || (g.ord === r.ord && g.rem === r.rem))) {
        // merge: the runs share their boundary vertex
        g.c = g.c.concat(r.c.slice(1));
        g.remKm += r.rem * r.km; g.km += r.km;
        if (r.km > g.longest) { g.longest = r.km; g.ord = r.ord; }
        g.rem = Math.round(g.remKm / g.km);
      } else {
        if (g) groups.push(g);
        g = { ord: r.ord, rem: r.rem, c: r.c, km: r.km, remKm: r.rem * r.km, longest: r.km };
      }
    }
    if (g) groups.push(g);
    for (const q of groups) out.push({ type: 'Feature', properties: { up: ch.up, ord: q.ord, rem: q.rem }, geometry: { type: 'LineString', coordinates: q.c } });
  }
  return out;
}

// Chaikin corner cutting: the source follows a 460 m grid in 45° steps; two passes round that into
// curves without moving any point more than about half a cell.
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
for (let z = MIN_Z; z <= MAX_Z; z++) {
  const thr = THRESHOLD[z];
  const subset = featuresForZoom(z, chains.filter((ch) => ch.up >= thr));
  // (a chain's up is its downstream-most reach, so big rivers are drawn whole and small ones dropped)
  // tolerance 8 = 1 screen px (4096 units per 512 px tile): a line that wiggles within its own width
  // draws over itself and looks brighter than its opacity, worst at low zoom where source vertices
  // are far denser than pixels
  // maxZoom one deeper than the zoom we cut: geojson-vt skips simplification at its own maxZoom
  const index = geojsonvt({ type: 'FeatureCollection', features: subset }, { maxZoom: z + 1, indexMaxZoom: z, indexMaxPoints: 0, tolerance: 8, buffer: 32, extent: 4096 });
  let n = 0;
  for (const id of Object.keys(index.tiles)) {
    const raw = index.tiles[id];
    if (raw.z !== z || !raw.numFeatures) continue;
    const t = index.getTile(raw.z, raw.x, raw.y);
    if (!t || !t.features.length) continue;
    const buf = vtpbf.fromGeojsonVt({ rivers: t }, { version: 2, extent: 4096 });
    const dir = path.join(OUT, String(z), String(t.x));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${t.y}.pbf`), buf);
    keys.push(`${z}/${t.x}/${t.y}`);
    written++; bytes += buf.length; n++;
  }
  log(`z${z}: ${subset.length} reaches, ${n} tiles (threshold ${thr} km²)`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ minzoom: MIN_Z, maxzoom: MAX_Z, tiles: written, keys }));
log(`wrote ${written} tiles, ${(bytes / 1048576).toFixed(1)} MB`);
