// Country borders and name points for South America from Natural Earth 1:10m (public/countries.json).
// Borders are the polygon edges shared by two countries, so the coastline (drawn by the outline
// layer) is not repeated. Labels sit at Natural Earth's label points; French Guiana, a part of
// France's polygon, gets its own.
import fs from 'node:fs';

const src = JSON.parse(fs.readFileSync('data/raw/ne_10m_admin_0_countries.geojson', 'utf8'));
const SKIP = new Set(['Brazilian I.', 'Southern Patagonian Ice Field', 'Falkland Is.']); // not countries
const sa = src.features.filter((f) => f.properties.CONTINENT === 'South America' && !SKIP.has(f.properties.NAME));
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();
const countries = sa.map((f) => ({ name: f.properties.NAME_EN, label: [f.properties.LABEL_X, f.properties.LABEL_Y], rings: rings(f.geometry) }));
// French Guiana: the parts of France that sit in South America
const france = src.features.find((f) => f.properties.NAME === 'France');
const guiana = (france.geometry.type === 'Polygon' ? [france.geometry.coordinates] : france.geometry.coordinates).filter((poly) => poly[0].every(([x, y]) => x > -60 && x < -50 && y > 1 && y < 7)).flat();
countries.push({ name: 'French Guiana', label: [-53.2, 3.7], rings: guiana });
console.log('countries:', countries.map((c) => c.name).join(', '));

// shared edges: a segment key -> set of countries using it
const key = (a, b) => { const p = a[0] + ',' + a[1], q = b[0] + ',' + b[1]; return p < q ? p + '|' + q : q + '|' + p; };
const users = new Map();
for (const c of countries) for (const ring of c.rings) for (let i = 0; i < ring.length - 1; i++) {
  const k = key(ring[i], ring[i + 1]);
  (users.get(k) ?? users.set(k, new Set()).get(k)).add(c.name);
}
const shared = [...users].filter(([, s]) => s.size >= 2).map(([k]) => k.split('|').map((p) => p.split(',').map(Number)));
// chain the segments into lines
const adj = new Map();
const pk = (p) => p[0] + ',' + p[1];
for (const [a, b] of shared) { (adj.get(pk(a)) ?? adj.set(pk(a), []).get(pk(a))).push(b); (adj.get(pk(b)) ?? adj.set(pk(b), []).get(pk(b))).push(a); }
const usedSeg = new Set();
const lines = [];
for (const [a, b] of shared) {
  if (usedSeg.has(key(a, b))) continue;
  usedSeg.add(key(a, b));
  const line = [a, b];
  for (const dir of [1, -1]) {
    for (;;) {
      const end = dir === 1 ? line[line.length - 1] : line[0];
      const next = (adj.get(pk(end)) ?? []).find((n) => !usedSeg.has(key(end, n)));
      if (!next) break;
      usedSeg.add(key(end, next));
      if (dir === 1) line.push(next); else line.unshift(next);
    }
  }
  lines.push(line);
}
let km = 0;
for (const l of lines) for (let i = 1; i < l.length; i++) km += Math.hypot((l[i][0] - l[i - 1][0]) * Math.cos((l[i][1] * Math.PI) / 180), l[i][1] - l[i - 1][1]) * 111.32;
console.log('shared segments:', shared.length, 'border lines:', lines.length, 'total', Math.round(km), 'km');

const round = (p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];
const features = [
  { type: 'Feature', properties: { kind: 'border' }, geometry: { type: 'MultiLineString', coordinates: lines.map((l) => l.map(round)) } },
  ...countries.map((c) => ({ type: 'Feature', properties: { kind: 'label', name: c.name }, geometry: { type: 'Point', coordinates: c.label } })),
];
fs.writeFileSync('public/countries.json', JSON.stringify({ type: 'FeatureCollection', features }));
console.log('bytes:', fs.statSync('public/countries.json').size);
