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

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
// 1. load reaches
const reaches = new Map(); // id -> { down, up, ord, c }
{
  const rl = readline.createInterface({ input: fs.createReadStream(IN) });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    reaches.set(r.id, { down: r.down, up: r.up, ord: r.stra, c: r.c });
  }
}
log('reaches:', reaches.size);

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
const features = [];
for (const [id] of reaches) {
  if (hasUpstream.has(id)) continue; // not a headwater: some chain passes through it
  const coords = [];
  const runs = []; // { ord, start }: index in coords of the run's first vertex
  let cur = id, maxUp = 0;
  for (;;) {
    const r = reaches.get(cur);
    maxUp = Math.max(maxUp, r.up);
    const start = coords.length ? coords.length - 1 : 0;
    if (!runs.length || runs[runs.length - 1].ord !== r.ord) runs.push({ ord: r.ord, start });
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
  for (let k = 0; k < runs.length; k++) {
    const a = runs[k].start * f, b = k + 1 < runs.length ? runs[k + 1].start * f : sm.length - 1;
    const seg = sm.slice(a, b + 1);
    if (seg.length < 2) continue;
    features.push({ type: 'Feature', properties: { up, ord: runs[k].ord }, geometry: { type: 'LineString', coordinates: seg } });
  }
}
void isMainPredOfSomething;
log('river runs after chaining and cutting by order:', features.length);

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
  const subset = features.filter((f) => f.properties.up >= thr);
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
