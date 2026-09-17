// Fetch named river reaches for the Amazon basin from ANA's Base Hidrográfica Ottocodificada
// (BHO 2017 multi-scale, "trecho de drenagem"), Brazil's national water agency. It fills the many
// gaps in OpenStreetMap's river names inside Brazil. Public ArcGIS feature service, paged.
// Output: data/work/ana-names.ndjson (same shape as osm-names.ndjson, ids prefixed "ana")
import fs from 'node:fs';

const SERVICE = 'https://www.snirh.gov.br/arcgis/rest/services/SPR/BHO2017_5K_TRECHODRENAGEM/FeatureServer/0/query';
// Otto-Pfafstetter level 1 basin 4 is the Amazon; a blank name is stored as a single space
const WHERE = "COBACIA LIKE '4%' AND NORIOCOMP IS NOT NULL AND NORIOCOMP <> ' '";
const PAGE = 1000; // the service's maxRecordCount
const OUT = 'data/work/ana-names.ndjson';

const get = async (params, tries = 5) => {
  const url = SERVICE + '?' + new URLSearchParams(params);
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'amazon-explorer/0.1' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j;
    } catch (err) {
      if (a + 1 >= tries) throw err;
      console.warn(`retry ${a + 1}: ${err.message}`);
      await new Promise((ok) => setTimeout(ok, 3000 * (a + 1)));
    }
  }
};

const { count } = await get({ where: WHERE, returnCountOnly: 'true', f: 'json' });
console.log('named reaches to fetch:', count);
const out = fs.createWriteStream(OUT);
const seen = new Set();
let written = 0;
for (let offset = 0; offset < count; offset += PAGE) {
  const j = await get({
    where: WHERE, outFields: 'COTRECHO,NORIOCOMP,NUSTRAHLER,NUAREAMONT', outSR: '4326', geometryPrecision: '5',
    orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'geojson',
  });
  for (const f of j.features ?? []) {
    const p = f.properties, g = f.geometry;
    if (!g || seen.has(p.COTRECHO)) continue;
    seen.add(p.COTRECHO);
    const name = String(p.NORIOCOMP).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const parts = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
    parts.forEach((c, i) => {
      if (c.length < 2) return;
      out.write(JSON.stringify({ type: 'Feature', properties: { id: `ana${p.COTRECHO}${i ? '_' + i : ''}`, name, kind: 'river', src: 'ana', stra: p.NUSTRAHLER, up: p.NUAREAMONT }, geometry: { type: 'LineString', coordinates: c } }) + '\n');
      written++;
    });
  }
  console.log(`${Math.min(offset + PAGE, count)} / ${count}`);
}
await new Promise((ok) => out.end(ok));
console.log('wrote', written, 'lines ->', OUT);
