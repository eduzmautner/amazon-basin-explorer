// Builds one bit grid per imagery zoom: which fine cells (imagery zoom + MASK_SUBDIVISION) lie inside
// the corridor of a reach that qualifies at that zoom. Output: public/mask/index.json + z{z}.bin.gz
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { MASK_BANDS, MIN_MASK_LEVEL, MAX_MASK_LEVEL, MASK_SUBDIVISION, MAX_MASK_ZOOM, DIST_LEVELS, COARSE_FRACTION, DEFAULT_CORRIDOR_SCALE, corridorMiles, MILE_M } from './config.mjs';

const IN = 'data/work/amazon.ndjson';
const OUT_DIR = 'public/mask';
const EARTH_CIRC = 40075016.686;

// ---- load reaches into flat typed arrays ----
const t0 = Date.now();
const upl = [], offs = [0], xs = [], ys = [];
{
  const rl = readline.createInterface({ input: fs.createReadStream(IN) });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    upl.push(r.up);
    for (const [lon, lat] of r.c) {
      // web mercator unit coords in [0,1]
      xs.push((lon + 180) / 360);
      const s = Math.sin((lat * Math.PI) / 180);
      ys.push(0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI));
    }
    offs.push(xs.length);
  }
}
const N = upl.length;
const X = Float64Array.from(xs), Y = Float64Array.from(ys), OFF = Uint32Array.from(offs), UP = Float64Array.from(upl);
xs.length = ys.length = 0;
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (let i = 0; i < X.length; i++) { if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i]; if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i]; }
console.log(`loaded ${N} reaches, ${X.length} vertices in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// precompute corridor radius (m) per reach and its representative latitude cos for cell sizing
const RAD_M = new Float64Array(N), COSLAT = new Float64Array(N);
for (let i = 0; i < N; i++) {
  RAD_M[i] = corridorMiles(UP[i]) * MILE_M;
  const ym = Y[OFF[i]];
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ym)));
  COSLAT[i] = Math.cos(lat);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * Rasterise corridors of every reach with upland >= threshold at mask zoom M. Each cell keeps the
 * smallest normalised distance to a river (distance / that river's corridor radius) quantised to
 * DIST_LEVELS steps; DIST_LEVELS itself means outside every corridor. The browser turns this into a
 * yes/no grid for any corridor scale, which is what the "visible land" slider drives.
 */
function rasterise(M, threshold) {
  const scale = 2 ** M;
  const padCells = Math.ceil((5 * MILE_M) / (EARTH_CIRC / scale)) + 2;
  const x0 = Math.max(0, Math.floor(minX * scale) - padCells), y0 = Math.max(0, Math.floor(minY * scale) - padCells);
  const x1 = Math.min(scale - 1, Math.ceil(maxX * scale) + padCells), y1 = Math.min(scale - 1, Math.ceil(maxY * scale) + padCells);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const grid = new Uint8Array(w * h).fill(DIST_LEVELS);
  let used = 0;
  for (let i = 0; i < N; i++) {
    if (UP[i] < threshold) continue;
    used++;
    const cellM = (EARTH_CIRC * COSLAT[i]) / scale;
    const r = Math.max(RAD_M[i] / cellM, 0.75);
    const r2 = r * r;
    for (let k = OFF[i]; k < OFF[i + 1] - 1; k++) {
      const ax = X[k] * scale - x0, ay = Y[k] * scale - y0;
      const bx = X[k + 1] * scale - x0, by = Y[k + 1] * scale - y0;
      const cx0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), cx1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
      const cy0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), cy1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax, dy = by - ay, ll = dx * dx + dy * dy;
      for (let cy = cy0; cy <= cy1; cy++) {
        const py = cy + 0.5;
        for (let cx = cx0; cx <= cx1; cx++) {
          const px = cx + 0.5;
          let t = ll > 0 ? ((px - ax) * dx + (py - ay) * dy) / ll : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + t * dx - px, ey = ay + t * dy - py;
          const d2 = ex * ex + ey * ey;
          if (d2 <= r2) {
            const q = Math.min(DIST_LEVELS - 1, Math.floor((Math.sqrt(d2) / r) * DIST_LEVELS));
            const i2 = cy * w + cx;
            if (q < grid[i2]) grid[i2] = q;
          }
        }
      }
    }
  }
  return { grid, x0, y0, w, h, used };
}

// Only the finest grid is shipped. The browser derives every coarser zoom from it by counting how
// many fine cells fall inside each coarse cell, so the "visible land" threshold can be changed live.
const band = MASK_BANDS[MASK_BANDS.length - 1];
const M = MAX_MASK_ZOOM;
const level = rasterise(M, band.threshold);
const { grid, x0, y0, w, h } = level;
const packed = new Uint8Array(Math.ceil((w * h) / 2)); // two 4-bit cells per byte, row-major
let on = 0;
for (let i = 0; i < w * h; i++) {
  const q = grid[i];
  if (q < DIST_LEVELS) on++;
  packed[i >> 1] |= (i & 1) ? q : q << 4;
}
const gz = zlib.gzipSync(packed, { level: 9 });
fs.writeFileSync(`${OUT_DIR}/finest.bin.gz`, gz);
const index = {
  subdivision: MASK_SUBDIVISION, maxMaskZoom: M, minLevel: MIN_MASK_LEVEL, maxLevel: MAX_MASK_LEVEL,
  distLevels: DIST_LEVELS, coarseFraction: COARSE_FRACTION, defaultWidth: DEFAULT_CORRIDOR_SCALE,
  finest: { maskZoom: M, x0, y0, w, h, file: 'finest.bin.gz' },
};
fs.writeFileSync(`${OUT_DIR}/index.json`, JSON.stringify(index));
console.log(`finest grid (mask zoom ${M}, threshold ${band.threshold} km², ${level.used} reaches): ${w}x${h}, ${(100 * on / (w * h)).toFixed(1)}% revealed, ${(gz.length / 1024).toFixed(0)} KB`);
