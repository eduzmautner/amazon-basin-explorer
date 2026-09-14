// Pass 1: find the Amazon's MAIN_RIV (main river id of the reach with the largest upstream area).
// Pass 2: write every reach with that MAIN_RIV to data/work/amazon.ndjson with compact properties.
import fs from 'node:fs';
import * as shp from 'shapefile';

const SHP = 'data/raw/HydroRIVERS_v10_sa_shp/HydroRIVERS_v10_sa.shp';
const OUT = 'data/work/amazon.ndjson';

async function pass1() {
  const src = await shp.open(SHP);
  let best = null, n = 0;
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    n++;
    const p = r.value.properties;
    if (!best || p.UPLAND_SKM > best.UPLAND_SKM) best = p;
  }
  console.log('total reaches in SA:', n);
  console.log('largest reach:', best);
  return best.MAIN_RIV;
}

async function pass2(mainRiv) {
  const src = await shp.open(SHP);
  const out = fs.createWriteStream(OUT);
  let n = 0, km = 0, maxOrd = 0;
  const ordCount = {};
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const p = r.value.properties;
    if (p.MAIN_RIV !== mainRiv) continue;
    const g = r.value.geometry;
    const coords = g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates;
    const rec = {
      id: p.HYRIV_ID, down: p.NEXT_DOWN, len: p.LENGTH_KM, up: p.UPLAND_SKM, dis: p.DIS_AV_CMS,
      stra: p.ORD_STRA, cls: p.ORD_CLAS, flow: p.ORD_FLOW,
      c: coords.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]),
    };
    out.write(JSON.stringify(rec) + '\n');
    n++; km += p.LENGTH_KM; maxOrd = Math.max(maxOrd, p.ORD_STRA);
    ordCount[p.ORD_STRA] = (ordCount[p.ORD_STRA] ?? 0) + 1;
  }
  out.end();
  console.log(`Amazon basin reaches: ${n}, total length ${Math.round(km)} km, max Strahler order ${maxOrd}`);
  console.log('reaches per Strahler order:', ordCount);
}

const mainRiv = await pass1();
await pass2(mainRiv);
