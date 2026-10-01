// Paths to the sea for the river highlight. Clicking a river lights its course from its source to the
// Amazon mouth: not just to where it loses its name, but on through every bigger river it joins.
// The network is chained as in build-rivers.mjs (at each confluence the largest upstream reach
// continues the chain), so a path is a short list of chain segments: [chain id, km from the start
// point down to that chain's mouth], each continuing to the chain's mouth, the last one at the sea.
// The segment where the river's own stretch ends (where it loses its name) carries a third value,
// the km from that point to the chain's mouth, so the client can draw the river itself and its
// continuation to the sea differently.
// Inputs:  data/work/amazon.ndjson, data/work/river-sections.json (from build-riverinfo.mjs), public/riverinfo.json
// Outputs: public/riverinfo.json gains "path" per river; public/chains/{id}.json holds each referenced
//          chain's course head to mouth, simplified and delta-encoded as integers at 1e-5 degrees.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const OUT = 'public/chains';
const SIMPLIFY_DEG = 0.0005; // ~55 m: HydroRIVERS vertices sit on a 460 m grid, this trims the straight runs
const KM_PER_DEG = 111.32;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const reaches = new Map(); // id -> { down, up, len, c }
for await (const line of readline.createInterface({ input: fs.createReadStream('data/work/amazon.ndjson') })) {
  if (!line) continue;
  const r = JSON.parse(line);
  reaches.set(r.id, { down: r.down, up: r.up, len: r.len, c: r.c });
}
const mainPred = new Map(); // downstream id -> largest upstream reach (the one that continues the chain)
for (const [id, r] of reaches) {
  if (!reaches.has(r.down)) continue;
  const cur = mainPred.get(r.down);
  if (cur === undefined || reaches.get(cur).up < r.up) mainPred.set(r.down, id);
}
log('reaches:', reaches.size);

// chain mouth of a reach, and km from the reach's upstream end down to that mouth
const mouthOf = new Map(), kmToMouth = new Map();
const resolve = (id) => {
  const stack = [];
  let cur = id;
  while (!mouthOf.has(cur)) {
    stack.push(cur);
    const next = reaches.get(cur).down;
    if (!reaches.has(next) || mainPred.get(next) !== cur) { mouthOf.set(cur, cur); kmToMouth.set(cur, reaches.get(cur).len); stack.pop(); break; }
    cur = next;
  }
  while (stack.length) { const r = stack.pop(); const next = reaches.get(r).down; mouthOf.set(r, mouthOf.get(next)); kmToMouth.set(r, reaches.get(r).len + kmToMouth.get(next)); }
  return mouthOf.get(id);
};

const sections = JSON.parse(fs.readFileSync('data/work/river-sections.json', 'utf8'));
const info = JSON.parse(fs.readFileSync('public/riverinfo.json', 'utf8'));
const chainsUsed = new Set();
let hops = 0, longest = 0;
for (const s of sections) {
  const top = s.reaches[s.reaches.length - 1], mouth = s.reaches[0]; // the section runs mouth -> top
  const mouthChain = resolve(mouth), ownEnd = Math.round((kmToMouth.get(mouth) - reaches.get(mouth).len) * 10) / 10;
  const p = [];
  let cur = top;
  for (;;) {
    const ch = resolve(cur);
    p.push(ch === mouthChain ? [ch, Math.round(kmToMouth.get(cur) * 10) / 10, ownEnd] : [ch, Math.round(kmToMouth.get(cur) * 10) / 10]);
    chainsUsed.add(ch);
    const next = reaches.get(ch).down;
    if (!reaches.has(next)) break;
    cur = next;
  }
  if (info[s.rid]) info[s.rid].path = p;
  hops += p.length; longest = Math.max(longest, p.length);
}
fs.writeFileSync('public/riverinfo.json', JSON.stringify(info));
log('paths:', sections.length, 'chain segments per path: mean', (hops / sections.length).toFixed(1), 'max', longest, '| distinct chains:', chainsUsed.size);

// chain courses, head to mouth
function simplify(c, tol) {
  if (c.length <= 2) return c;
  const keep = new Uint8Array(c.length); keep[0] = keep[c.length - 1] = 1;
  const stack = [[0, c.length - 1]];
  const cosl = Math.cos((c[0][1] * Math.PI) / 180);
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = c[a][0] * cosl, ay = c[a][1], bx = c[b][0] * cosl, by = c[b][1];
    const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy;
    let best = -1, bestD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = c[i][0] * cosl, py = c[i][1];
      let t = ll > 0 ? ((px - ax) * dx + (py - ay) * dy) / ll : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return c.filter((_, i) => keep[i]);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let bytes = 0, vertices = 0;
for (const mouth of chainsUsed) {
  // head: follow the main predecessors up from the mouth
  let head = mouth;
  while (mainPred.has(head)) head = mainPred.get(head);
  const coords = [];
  for (let cur = head; ; cur = reaches.get(cur).down) {
    const r = reaches.get(cur);
    for (let i = coords.length ? 1 : 0; i < r.c.length; i++) coords.push(r.c[i]);
    if (cur === mouth) break;
  }
  const sm = simplify(coords, SIMPLIFY_DEG);
  const ints = []; let px = 0, py = 0;
  for (const [x, y] of sm) { const ix = Math.round(x * 1e5), iy = Math.round(y * 1e5); ints.push(ix - px, iy - py); px = ix; py = iy; }
  const buf = JSON.stringify(ints);
  fs.writeFileSync(path.join(OUT, `${mouth}.json`), buf);
  bytes += buf.length; vertices += sm.length;
}
void KM_PER_DEG;
log(`wrote ${chainsUsed.size} chains, ${vertices} vertices, ${(bytes / 1048576).toFixed(1)} MB -> ${OUT}/`);
