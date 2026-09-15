// Big rivers in OpenStreetMap are often relations (type=waterway) whose member ways carry no name of
// their own, so fetch-osm-names.mjs never sees them. This fetches named river relations and their
// member way geometries, tagging each way with the relation's name.
// Output: data/work/osm-relations.ndjson (one GeoJSON Feature per member way)
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'data/work/osm-relations.ndjson';
const DONE = 'data/work/osm-relations.done.json';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const LAT0 = -21, LAT1 = 6, LON0 = -80, LON1 = -48;
const STEP = 4;
const UA = 'amazon-explorer/0.1 (contact: eduzmautner@gmail.com)';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set(fs.existsSync(DONE) ? JSON.parse(fs.readFileSync(DONE, 'utf8')) : []);
const out = fs.createWriteStream(OUT, { flags: 'a' });
const chunks = [];
for (let lat = LAT0; lat < LAT1; lat += STEP)
  for (let lon = LON0; lon < LON1; lon += STEP)
    chunks.push([lat, lon, Math.min(lat + STEP, LAT1), Math.min(lon + STEP, LON1)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ep = 0;

for (const [s, w, n, e] of chunks) {
  const key = `${s},${w},${n},${e}`;
  if (done.has(key)) continue;
  // relations touching the box, then every member way of those relations (with geometry)
  const q = `[out:json][timeout:180][bbox:${s},${w},${n},${e}];relation["waterway"~"^(river|stream|canal)$"]["name"]->.r;.r out body;way(r.r)["waterway"];out tags geom;`;
  let ok = false;
  for (let attempt = 0; attempt < 12 && !ok; attempt++) {
    const url = ENDPOINTS[ep % ENDPOINTS.length];
    try {
      const t0 = Date.now();
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA } });
      if ([429, 502, 504].includes(res.status)) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const json = await res.json();
      const wayName = new Map(); // way id -> relation name (first relation wins)
      for (const el of json.elements ?? []) if (el.type === 'relation') for (const m of el.members ?? []) if (m.type === 'way' && !wayName.has(m.ref)) wayName.set(m.ref, el.tags.name);
      let cnt = 0;
      for (const el of json.elements ?? []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const name = el.tags?.name ?? wayName.get(el.id);
        if (!name) continue;
        const f = { type: 'Feature', properties: { id: el.id, name, kind: el.tags?.waterway ?? 'river', fromRelation: !el.tags?.name }, geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) } };
        out.write(JSON.stringify(f) + '\n');
        cnt++;
      }
      done.add(key);
      fs.writeFileSync(DONE, JSON.stringify([...done]));
      console.log(`chunk ${key}: ${cnt} member ways in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      ok = true;
      await sleep(2000);
    } catch (err) {
      console.warn(`chunk ${key} attempt ${attempt + 1} failed on ${url}: ${err.message}`);
      ep++;
      await sleep(Math.min(120000, 8000 * (attempt + 1)));
    }
  }
  if (!ok) console.error(`GIVING UP on chunk ${key}`);
}
out.end();
console.log('done; chunks completed:', done.size, '/', chunks.length);
