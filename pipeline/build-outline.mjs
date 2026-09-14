// Dissolves Natural Earth 1:10m South American countries into one landmass outline (public/outline.json)
import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';

const src = JSON.parse(fs.readFileSync('data/raw/ne_10m_admin_0_countries.geojson', 'utf8'));
const sa = src.features.filter((f) => f.properties.CONTINENT === 'South America');
console.log('countries:', sa.map((f) => f.properties.NAME).join(', '));
const polys = sa.map((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
// French Guiana is a part of France's multipolygon (continent "Europe"); pick the parts that sit in South America
const france = src.features.find((f) => f.properties.NAME === 'France');
const inSA = (poly) => poly[0].every(([x, y]) => x > -60 && x < -50 && y > 1 && y < 7);
const guiana = (france.geometry.type === 'Polygon' ? [france.geometry.coordinates] : france.geometry.coordinates).filter(inSA);
console.log('French Guiana parts:', guiana.length);
polys.push(guiana);
const union = polygonClipping.union(...polys);
const lines = [];
for (const poly of union) for (const ring of poly) lines.push(ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]));
const out = { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
fs.writeFileSync('public/outline.json', JSON.stringify(out));
console.log('rings:', lines.length, 'vertices:', lines.reduce((a, l) => a + l.length, 0), 'bytes:', fs.statSync('public/outline.json').size);
