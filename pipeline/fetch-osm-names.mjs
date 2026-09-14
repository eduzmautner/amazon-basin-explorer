// Fetch named waterways (rivers + streams) in the Amazon basin bbox from Overpass, in chunks.
// Output: data/work/osm-names.ndjson (one GeoJSON Feature per line)
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'data/work/osm-names.ndjson';
const DONE = 'data/work/osm-names.done.json';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
// Amazon basin bbox (lat/lon), generous.
const LAT0 = -21, LAT1 = 6, LON0 = -80, LON1 = -48;
const STEP = 2; // degrees (smaller chunks finish before the servers time out)

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
  // also skip chunks fully inside a box completed by an earlier run with a different chunk size
  if ([...done].some((k) => { const [ds, dw, dn, de] = k.split(',').map(Number); return s >= ds && w >= dw && n <= dn && e <= de; })) { done.add(key); continue; }
  const q = `[out:json][timeout:180][bbox:${s},${w},${n},${e}];(way["waterway"~"^(river|stream|canal)$"]["name"];);out tags geom;`;
  let ok = false;
  for (let attempt = 0; attempt < 12 && !ok; attempt++) {
    const url = ENDPOINTS[ep % ENDPOINTS.length];
    try {
      const t0 = Date.now();
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'amazon-explorer/0.1 (contact: eduzmautner@gmail.com)' } });
      if (res.status === 429 || res.status === 504 || res.status === 502) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const json = await res.json();
      let n = 0;
      for (const el of json.elements ?? []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const f = { type: 'Feature', properties: { id: el.id, name: el.tags.name, kind: el.tags.waterway, name_pt: el.tags['name:pt'], name_es: el.tags['name:es'] }, geometry: { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) } };
        out.write(JSON.stringify(f) + '\n');
        n++;
      }
      done.add(key);
      fs.writeFileSync(DONE, JSON.stringify([...done]));
      console.log(`chunk ${key}: ${n} ways in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      ok = true;
      await sleep(1500);
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
