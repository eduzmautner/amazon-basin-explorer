// Builds public/riverinfo.json: one record per named river (the ids the label tiles carry), with
// length, distance to the sea, elevations, discharge and population from HydroRIVERS + RiverATLAS.
//
// Inputs: data/work/amazon.ndjson (reach graph), data/work/label-rivers.json (river id -> matched
// reaches, from build-labels.mjs), data/raw/riveratlas/RiverATLAS_v10_sa_{north,south}.dbf.
import fs from 'node:fs';
import readline from 'node:readline';
import * as shp from 'shapefile';
import { WATER_TYPES } from './water-types.mjs';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---- reach graph ----
const reach = new Map(); // id -> { down, up, len }
{
  const rl = readline.createInterface({ input: fs.createReadStream('data/work/amazon.ndjson') });
  for await (const line of rl) { if (!line) continue; const r = JSON.parse(line); reach.set(r.id, { down: r.down, up: r.up, len: r.len }); }
}
const mainPred = new Map(); // downstream id -> largest upstream reach (the one that "continues" the river)
for (const [id, r] of reach) {
  if (!reach.has(r.down)) continue;
  const cur = mainPred.get(r.down);
  if (cur === undefined || reach.get(cur).up < r.up) mainPred.set(r.down, id);
}
log('reaches:', reach.size);

// ---- rivers and their sections along the chain ----
const rivers = JSON.parse(fs.readFileSync('data/work/label-rivers.json', 'utf8'));
// A river's size: the length-weighted median of its OSM lines' sizes, so the long main line of a
// big river outweighs its many short bank-side pieces. Matches onto reaches more than 3x
// that size are strays (a small creek's line snapped to the big river it runs beside) and are ignored.
const size = new Map();
for (const r of rivers) {
  const total = r.lineUps.reduce((s, [, km]) => s + km, 0);
  // largest size among lines of at least 20 km, provided lines of that size class (within 3x) make
  // up at least 15% of the river's mapped length; otherwise the length-weighted median
  const longs = r.lineUps.filter(([, km]) => km >= 20).sort((a, b) => b[0] - a[0]);
  let chosen = null;
  for (const [up] of longs) {
    const support = r.lineUps.filter(([u]) => u >= up / 3).reduce((s, [, km]) => s + km, 0);
    if (support >= 0.15 * total) { chosen = up; break; }
  }
  if (chosen === null) {
    const u = [...r.lineUps].sort((a, b) => a[0] - b[0]);
    let acc = 0; chosen = u[u.length - 1][0];
    for (const [up, km] of u) { acc += km; if (acc >= total / 2) { chosen = up; break; } }
  }
  size.set(r.rid, chosen);
}
const ownReaches = (r) => { const cap = 3 * size.get(r.rid); const ok = r.reaches.filter((id) => reach.get(id).up <= cap); return ok.length ? ok : r.reaches; };
// reach id -> river name. When several rivers claim a reach (the Amazon's OSM relation runs the
// whole river, Solimões stretch included), the one whose size is closest to the reach wins.
let owner = new Map();
const ownerFit = new Map();
for (const r of rivers) for (const id of ownReaches(r)) {
  const fit = Math.abs(Math.log(reach.get(id).up) - Math.log(size.get(r.rid)));
  if (!owner.has(id) || fit < ownerFit.get(id)) { owner.set(id, r.name); ownerFit.set(id, fit); }
}
let ownedUps = new Map(); // river name -> sorted ups of the reaches it owns
const rebuildOwnedUps = () => { ownedUps = new Map(); for (const [id, name] of owner) (ownedUps.get(name) ?? ownedUps.set(name, []).get(name)).push(reach.get(id).up); for (const u of ownedUps.values()) u.sort((a, b) => a - b); };
rebuildOwnedUps();
// Does the river named `name` really take over at a reach of this size? A stray match (a creek that
// snapped onto the big river beside it) owns one or two reaches of that scale; a real successor
// river (Solimões above the Amazonas) owns dozens.
const takesOver = (name, up) => { const u = ownedUps.get(name); if (!u) return false; let n = 0; for (let i = u.length - 1; i >= 0 && u[i] >= up / 3; i--) n++; return n >= 3; };
const upstreamOf = new Map(); // id -> upstream reach ids
for (const [id, r] of reach) if (reach.has(r.down)) (upstreamOf.get(r.down) ?? upstreamOf.set(r.down, []).get(r.down)).push(id);
const CONFLUENCE_JUMP = 1.6; // upstream area growing by this factor in one step = joined a comparable or bigger river

const DEBUG = new Set((process.env.DEBUG_RID ?? '').split(';').filter(Boolean));
let sections = new Map(); // rid -> { mouth, top, lengthKm, chain }
const computeSections = () => { sections = new Map(); for (const r of rivers) {
  const dbg = DEBUG.has(r.rid) ? (...a) => console.log('  [' + r.rid + ']', ...a) : () => {};
  const mine = ownReaches(r);
  const own = new Set(mine);
  const S = size.get(r.rid);
  // anchor: the own reach of the river's typical size (largest up that does not exceed 1.5x size)
  const anchorPool = mine.filter((id) => reach.get(id).up <= 1.5 * S);
  const anchor = (anchorPool.length ? anchorPool : mine).reduce((a, b) => (reach.get(b).up > reach.get(a).up ? b : a));
  dbg('size', S, 'own reaches', mine.length, 'anchor', anchor, 'up', reach.get(anchor).up);
  // downstream: to the river's end. Stop where another name takes over, or where the upstream area
  // jumps (the river has flowed into one of comparable or greater size), or at the sink.
  let mouth = anchor;
  for (;;) {
    const next = reach.get(mouth).down;
    if (!reach.has(next)) break;
    const o = owner.get(next);
    if (o !== undefined && o !== r.name && takesOver(o, reach.get(next).up)) { dbg('down stop: owner', o, 'at up', reach.get(next).up); break; }
    if (!own.has(next) && reach.get(next).up > CONFLUENCE_JUMP * reach.get(mouth).up) { dbg('down stop: jump', reach.get(mouth).up, '->', reach.get(next).up); break; }
    mouth = next;
  }
  // upstream: to the source. At each confluence prefer the branch carrying this river's name (the
  // Beni keeps its name above the larger Madre de Dios), else the largest branch. Stop where another
  // name takes over (Amazonas -> Solimões).
  const chain = [mouth];
  for (let cur = mouth; ;) {
    const ups = upstreamOf.get(cur);
    if (!ups) { dbg('up stop: source at', cur, 'after', chain.length, 'reaches'); break; }
    const main = mainPred.get(cur);
    const named = ups.filter((id) => own.has(id) || owner.get(id) === r.name);
    const best = named.length ? named.reduce((a, b) => (reach.get(b).up > reach.get(a).up ? b : a)) : undefined;
    // follow the branch carrying this river's name only when it is comparable to the main branch;
    // a folded side channel also carries the name but is far smaller, and must not divert the walk
    const next = best !== undefined && main !== undefined && reach.get(best).up >= reach.get(main).up / 3 ? best : main;
    if (next === undefined) { dbg('up stop: no upstream'); break; }
    const o = owner.get(next);
    if (o !== undefined && o !== r.name && takesOver(o, reach.get(next).up)) { dbg('up stop: owner', o, 'at up', reach.get(next).up, 'after', chain.length, 'reaches'); break; }
    chain.push(next); cur = next;
  }
  const top = chain[chain.length - 1];
  let lengthKm = 0;
  for (const id of chain) lengthKm += reach.get(id).len;
  sections.set(r.rid, { mouth, top, lengthKm, chain });
} };
computeSections();
// pass 2: ownership from the pass-1 sections (contiguous stretches), which drops stray single-reach
// claims such as a tributary's line snapping onto the main river beside its mouth
owner = new Map(); ownerFit.clear();
for (const r of rivers) {
  const sec = sections.get(r.rid);
  for (const id of sec.chain) {
    const fit = Math.abs(Math.log(reach.get(id).up) - Math.log(size.get(r.rid)));
    if (!owner.has(id) || fit < ownerFit.get(id)) { owner.set(id, r.name); ownerFit.set(id, fit); }
  }
}
rebuildOwnedUps();
computeSections();
log('rivers:', rivers.size ?? rivers.length);

// ---- RiverATLAS attributes for the reaches we need ----
const CACHE = 'data/work/atlas-amazon.json';
const atlas = new Map();
if (fs.existsSync(CACHE)) {
  for (const [id, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE, 'utf8')))) atlas.set(Number(id), v);
  log('atlas records from cache:', atlas.size);
} else for (const part of ['north', 'south']) {
  const src = await shp.openDbf(`data/raw/riveratlas/RiverATLAS_v10_sa_${part}.dbf`);
  let n = 0;
  for (;;) {
    const rec = await src.read();
    if (rec.done) break;
    n++;
    const p = rec.value;
    if (!reach.has(p.HYRIV_ID)) continue; // keep every Amazon reach, so later runs need no rescan
    atlas.set(p.HYRIV_ID, {
      toSea: p.DIST_DN_KM, order: p.ORD_STRA, ele: p.ele_mt_cav,
      disAvg: p.dis_m3_pyr, disMax: p.dis_m3_pmx, disMin: p.dis_m3_pmn,
      inund: p.inu_pc_ult, lakePct: p.lka_pc_use, lakeVol: p.lkv_mc_usu, regulation: p.dor_pc_pva,
      pop: p.pop_ct_usu, popDensity: p.ppd_pk_uav,
    });
  }
  log(`RiverATLAS ${part}: ${n} records scanned, ${atlas.size} kept so far`);
}
if (!fs.existsSync(CACHE)) { fs.writeFileSync(CACHE, JSON.stringify(Object.fromEntries(atlas))); log('atlas cache written'); }

// ---- water type (literature; applied to the dominant river of each name only) ----
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(rio|río|river)\s+/, '').trim();
const dominant = new Map(); // normalised name -> rid with the most reaches
for (const r of rivers) { const k = norm(r.name); const cur = dominant.get(k); if (!cur || size.get(cur.rid) < size.get(r.rid)) dominant.set(k, r); }

// ---- assemble ----
const out = {};
let missing = 0;
const round = (v, d = 0) => (v === undefined || v === null ? null : Number(Number(v).toFixed(d)));
for (const r of rivers) {
  const s = sections.get(r.rid);
  const m = atlas.get(s.mouth), t = atlas.get(s.top);
  if (!m) { missing++; continue; }
  const eleSrc = t ? t.ele : null;
  // water type: the biggest river of that name, and any section of it (Peruvian Amazonas, Solimões
  // sections) within a tenth of its size; small namesakes elsewhere get none
  const dom = dominant.get(norm(r.name));
  const water = dom && size.get(r.rid) >= size.get(dom.rid) / 10 ? (WATER_TYPES[norm(r.name)] ?? null) : null;
  out[r.rid] = {
    name: r.name,
    lengthKm: round(s.lengthKm),
    toSeaKm: round(m.toSea),
    eleSource: eleSrc, eleMouth: m.ele,
    gradient: eleSrc !== null && s.lengthKm > 0 ? round((eleSrc - m.ele) / s.lengthKm, 2) : null, // m per km
    order: m.order,
    disAvg: round(m.disAvg, m.disAvg < 10 ? 2 : 0), disMax: round(m.disMax, m.disMax < 10 ? 2 : 0), disMin: round(m.disMin, m.disMin < 10 ? 2 : 0),
    inundPct: round(m.inund, 1), lakePct: round(m.lakePct, 2), lakeVolMcm: round(m.lakeVol, 1), regulationPct: round(m.regulation, 1),
    population: round(m.pop * 1000), popDensity: round(m.popDensity, 1),
    water,
  };
}
fs.writeFileSync('public/riverinfo.json', JSON.stringify(out));
log(`wrote public/riverinfo.json: ${Object.keys(out).length} rivers, ${missing} without atlas record, ${(fs.statSync('public/riverinfo.json').size / 1024).toFixed(0)} KB`);
console.log('Rio Amazonas (main stem):', out['60443230|Rio Amazonas']);
