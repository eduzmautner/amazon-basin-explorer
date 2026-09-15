// Exports the basin silhouette as an SVG path, using the same rules the map applies: depth field
// thresholded at a corridor scale, counted up to a coarse level, coarse cells shown by the
// coarseFraction rule, and 45° corner bridges between diagonal neighbours.
// Usage: node pipeline/export-silhouette.mjs [maskZoom=10] [scale=1] [out=public/basin.svg]
import fs from 'node:fs';
import zlib from 'node:zlib';

const M_OUT = Number(process.argv[2] ?? 10);   // 10 = the grid the map uses at the on-load zoom
const SCALE = Number(process.argv[3] ?? 1);     // "visible land" 0.15..1
const OUT = process.argv[4] ?? 'public/basin.svg';

const index = JSON.parse(fs.readFileSync('public/mask/index.json', 'utf8'));
const f = index.finest;
const packed = zlib.gunzipSync(fs.readFileSync('public/mask/' + f.file));
const n = f.w * f.h;
const maxDepth = Math.min(index.distLevels - 1, Math.ceil(SCALE * index.distLevels) - 1);
let level = { M: f.maskZoom, x0: f.x0, y0: f.y0, w: f.w, h: f.h, count: new Uint8Array(n), per: 1 };
for (let i = 0; i < n; i++) { const q = (i & 1 ? packed[i >> 1] & 15 : packed[i >> 1] >> 4); level.count[i] = q <= maxDepth || (SCALE >= 0.999 && index.interiorLevel !== undefined && q === index.interiorLevel) ? 1 : 0; }
while (level.M > M_OUT) {
  const x0 = Math.floor(level.x0 / 2), y0 = Math.floor(level.y0 / 2);
  const x1 = Math.floor((level.x0 + level.w - 1) / 2), y1 = Math.floor((level.y0 + level.h - 1) / 2);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, per = level.per * 4;
  const count = new Uint32Array(w * h);
  const ox = x0 * 2 - level.x0, oy = y0 * 2 - level.y0;
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
    let s = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const fx = ox + cx * 2 + i, fy = oy + cy * 2 + j;
      if (fx >= 0 && fy >= 0 && fx < level.w && fy < level.h) s += level.count[fy * level.w + fx];
    }
    count[cy * w + cx] = s;
  }
  level = { M: level.M - 1, x0, y0, w, h, count, per };
}
const cf = index.coarseFraction;
const minFraction = cf.cap - (cf.cap - cf.t0) * Math.exp(-cf.k * (SCALE - cf.s0));
const need = level.per === 1 ? 1 : Math.max(1, Math.ceil(level.per * minFraction));
const { w, h } = level;
const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && level.count[y * w + x] >= need;

// polygons: squares for visible cells, triangles for corner bridges (same rule as src/mask.ts)
const polys = [];
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  if (on(x, y)) { polys.push([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]); continue; }
  const N = on(x, y - 1), S = on(x, y + 1), W = on(x - 1, y), E = on(x + 1, y);
  const nw = N && W, ne = N && E, sw = S && W, se = S && E;
  const k = (nw ? 1 : 0) + (ne ? 1 : 0) + (sw ? 1 : 0) + (se ? 1 : 0);
  if (k === 0) continue;
  // the union of the bridge triangles as ONE polygon (edge cancellation needs non-overlapping pieces):
  // a single triangle, a pentagon for two adjacent corners, the whole cell for anything else
  const P = (...pts) => polys.push(pts.map(([px, py]) => [x + px, y + py]));
  if (k === 1) {
    if (nw) P([0, 0], [1, 0], [0, 1]); else if (ne) P([1, 0], [1, 1], [0, 0]);
    else if (sw) P([0, 1], [0, 0], [1, 1]); else P([1, 1], [0, 1], [1, 0]);
  } else if (k === 2 && nw && ne) P([0, 0], [1, 0], [1, 1], [0.5, 0.5], [0, 1]);
  else if (k === 2 && ne && se) P([1, 0], [1, 1], [0, 1], [0.5, 0.5], [0, 0]);
  else if (k === 2 && se && sw) P([1, 1], [0, 1], [0, 0], [0.5, 0.5], [1, 0]);
  else if (k === 2 && sw && nw) P([0, 1], [0, 0], [1, 0], [0.5, 0.5], [1, 1]);
  else P([0, 0], [1, 0], [1, 1], [0, 1]);
}
// boundary = directed edges whose reverse is not present (interior edges cancel)
const key = (a, b) => `${a[0]},${a[1]}>${b[0]},${b[1]}`;
const edges = new Map();
for (const p of polys) for (let i = 0; i < p.length; i++) {
  const a = p[i], b = p[(i + 1) % p.length];
  const rev = key(b, a);
  if (edges.has(rev)) edges.delete(rev); else edges.set(key(a, b), [a, b]);
}
// chain edges into rings. All polygons share one orientation, so at a pinch vertex (cells touching
// only at a corner) there are two ways out; always take the sharpest turn toward the interior side,
// which keeps every ring simple instead of crossing itself.
const next = new Map();
for (const [a, b] of edges.values()) { const k = `${a[0]},${a[1]}`; (next.get(k) ?? next.set(k, []).get(k)).push(b); }
const rings = [];
const pick = (prev, cur, outs) => {
  if (outs.length === 1) return outs[0];
  const dx = cur[0] - prev[0], dy = cur[1] - prev[1];
  let best = null, bestScore = -Infinity;
  for (const o of outs) {
    const ex = o[0] - cur[0], ey = o[1] - cur[1];
    // score: right turns (positive cross in y-down space for our orientation) rank highest
    const cross = dx * ey - dy * ex, dot = dx * ex + dy * ey;
    const score = Math.atan2(cross, dot);
    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best;
};
for (const [a, b0] of edges.values()) {
  const k0 = `${a[0]},${a[1]}`;
  const outs0 = next.get(k0);
  if (!outs0?.length || !outs0.includes(b0)) continue;
  outs0.splice(outs0.indexOf(b0), 1);
  const ring = [a, b0]; let prev = a, cur = b0;
  for (;;) {
    const outs = next.get(`${cur[0]},${cur[1]}`);
    if (!outs?.length) break;
    const nxt = pick(prev, cur, outs);
    outs.splice(outs.indexOf(nxt), 1);
    if (nxt[0] === a[0] && nxt[1] === a[1]) break;
    ring.push(nxt); prev = cur; cur = nxt;
  }
  if (ring.length >= 3) rings.push(ring);
}
// drop collinear points, then emit
const simplify = (r) => r.filter((p, i) => { const q = r[(i + r.length - 1) % r.length], s = r[(i + 1) % r.length]; return (p[0] - q[0]) * (s[1] - p[1]) !== (p[1] - q[1]) * (s[0] - p[0]); });
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const r of rings) for (const [x, y] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
const d = rings.map(simplify).map((r) => 'M' + r.map(([x, y]) => `${x - minX} ${y - minY}`).join('L') + 'Z').join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxX - minX} ${maxY - minY}" fill-rule="evenodd">\n  <path fill="currentColor" d="${d}"/>\n</svg>\n`;
fs.writeFileSync(OUT, svg);
console.log(`${OUT}: mask zoom ${M_OUT}, scale ${SCALE}, grid ${w}x${h}, ${polys.length} polygons, ${rings.length} rings, ${(svg.length / 1024).toFixed(0)} KB`);
