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
const features = [];
{
  const rl = readline.createInterface({ input: fs.createReadStream(IN) });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    features.push({ type: 'Feature', properties: { up: Math.round(r.up) }, geometry: { type: 'LineString', coordinates: r.c } });
  }
}
log('reaches:', features.length);
fs.rmSync(OUT, { recursive: true, force: true });
let written = 0, bytes = 0;
const keys = [];
for (let z = MIN_Z; z <= MAX_Z; z++) {
  const thr = THRESHOLD[z];
  const subset = features.filter((f) => f.properties.up >= thr);
  const index = geojsonvt({ type: 'FeatureCollection', features: subset }, { maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0, tolerance: 2, buffer: 32, extent: 4096 });
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
