/**
 * Reveal grid. The finest level stores, per ~300 m cell, how deep inside a river corridor it sits:
 * 0 = on the river, distLevels-1 = at the corridor's edge, distLevels = outside every corridor.
 * The "visible land" slider is a corridor scale: a cell is inside when depth < scale * distLevels.
 * Coarser zooms count how many fine cells each coarse cell contains and show it when the share
 * reaches min(cap, base + perScale * scale), so thin corridors still light up the cells they cross.
 * The counts are rebuilt whenever the scale changes.
 */
export interface MaskIndex {
  subdivision: number; maxMaskZoom: number; minLevel: number; maxLevel: number;
  distLevels: number; coarseFraction: { base: number; perScale: number; cap: number }; defaultWidth: number;
  finest: { maskZoom: number; x0: number; y0: number; w: number; h: number; file: string };
}
type Counts = Uint8Array | Uint16Array | Uint32Array;
interface Level { M: number; x0: number; y0: number; w: number; h: number; count: Counts; finePerCell: number }

/**
 * n: cells per tile side. grid: (n+2)^2 visibility with one cell of padding. bridges: same layout,
 * bit flags per empty cell for 45° corner fills (1 = NW, 2 = NE, 4 = SW, 8 = SE), set when the two
 * neighbours on those sides are visible, so staircase edges chamfer along the river.
 */
export interface Coverage { n: number; grid: Uint8Array; bridges: Uint8Array; any: boolean; all: boolean }
export const BRIDGE_NW = 1, BRIDGE_NE = 2, BRIDGE_SW = 4, BRIDGE_SE = 8;

export class Mask {
  private levels = new Map<number, Level>();
  private scale: number;

  private constructor(readonly index: MaskIndex, private depth: Uint8Array) {
    this.scale = index.defaultWidth;
    this.rebuild();
  }

  static async load(base = '/mask/', onProgress?: (msg: string) => void): Promise<Mask> {
    const res = await fetch(base + 'index.json');
    if (!res.ok) throw new Error('mask index missing');
    const index = (await res.json()) as MaskIndex;
    onProgress?.('loading river grid');
    const r = await fetch(base + index.finest.file);
    if (!r.ok) throw new Error(`mask grid: ${r.status}`);
    let bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const ds = new DecompressionStream('gzip');
      bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
    }
    onProgress?.('building zoom levels');
    await new Promise((ok) => setTimeout(ok, 0)); // let the message paint
    const f = index.finest;
    // unpack two 4-bit cells per byte into one byte per cell
    const n = f.w * f.h;
    const depth = new Uint8Array(n);
    for (let i = 0; i < n; i += 2) {
      const b = bytes[i >> 1];
      depth[i] = b >> 4;
      if (i + 1 < n) depth[i + 1] = b & 15;
    }
    return new Mask(index, depth);
  }

  /** Corridor scale in 0..1 (the slider): 1 = full corridor widths. */
  setVisible(scale: number) {
    const s = Math.min(1, Math.max(0.02, scale));
    if (s === this.scale) return;
    this.scale = s;
    this.rebuild();
  }
  getVisible() { return this.scale; }

  /** Threshold the depth field at the current scale, then halve up into the coarse count levels. */
  private rebuild() {
    const f = this.index.finest;
    // inside when depth < scale * levels, i.e. depth <= maxDepth
    const maxDepth = Math.min(this.index.distLevels - 1, Math.ceil(this.scale * this.index.distLevels) - 1);
    const count = new Uint8Array(f.w * f.h);
    const d = this.depth;
    for (let i = 0; i < count.length; i++) count[i] = d[i] <= maxDepth ? 1 : 0;
    this.levels.clear();
    let level: Level = { M: f.maskZoom, x0: f.x0, y0: f.y0, w: f.w, h: f.h, count, finePerCell: 1 };
    this.levels.set(level.M, level);
    const coarsest = this.index.minLevel + this.index.subdivision;
    for (let M = f.maskZoom - 1; M >= coarsest; M--) {
      level = Mask.halve(level);
      this.levels.set(M, level);
    }
  }

  /** One level coarser: each cell sums its 2x2 children, so counts stay relative to the finest grid. */
  private static halve(l: Level): Level {
    const x0 = Math.floor(l.x0 / 2), y0 = Math.floor(l.y0 / 2);
    const x1 = Math.floor((l.x0 + l.w - 1) / 2), y1 = Math.floor((l.y0 + l.h - 1) / 2);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const finePerCell = l.finePerCell * 4;
    const count: Counts = finePerCell <= 255 ? new Uint8Array(w * h) : finePerCell <= 65535 ? new Uint16Array(w * h) : new Uint32Array(w * h);
    const ox = x0 * 2 - l.x0, oy = y0 * 2 - l.y0; // fine coords of coarse (0,0)
    for (let cy = 0; cy < h; cy++) {
      const fy0 = oy + cy * 2, fy1 = fy0 + 1;
      const r0 = fy0 >= 0 && fy0 < l.h ? fy0 * l.w : -1, r1 = fy1 >= 0 && fy1 < l.h ? fy1 * l.w : -1;
      for (let cx = 0; cx < w; cx++) {
        const fx0 = ox + cx * 2, fx1 = fx0 + 1;
        let s = 0;
        if (r0 >= 0) { if (fx0 >= 0 && fx0 < l.w) s += l.count[r0 + fx0]; if (fx1 < l.w) s += l.count[r0 + fx1]; }
        if (r1 >= 0) { if (fx0 >= 0 && fx0 < l.w) s += l.count[r1 + fx0]; if (fx1 < l.w) s += l.count[r1 + fx1]; }
        count[cy * w + cx] = s;
      }
    }
    return { M: l.M - 1, x0, y0, w, h, count, finePerCell };
  }

  private maskZoomFor(z: number) { return Math.min(z + this.index.subdivision, this.index.maxMaskZoom); }

  /**
   * Visible cells of one coarse level as a bitmap, for drawing an overview. Cells are in web
   * mercator tile units at mask zoom M (world = 2^M cells across).
   */
  silhouette(M: number): { M: number; x0: number; y0: number; w: number; h: number; on: Uint8Array } {
    const l = this.levels.get(M) ?? this.levels.get(this.index.minLevel + this.index.subdivision)!;
    const cf = this.index.coarseFraction;
    const minFraction = Math.min(cf.cap, cf.base + cf.perScale * this.scale);
    const need = l.finePerCell === 1 ? 1 : Math.max(1, Math.ceil(l.finePerCell * minFraction));
    const on = new Uint8Array(l.w * l.h);
    for (let i = 0; i < on.length; i++) on[i] = l.count[i] >= need ? 1 : 0;
    return { M: l.M, x0: l.x0, y0: l.y0, w: l.w, h: l.h, on };
  }

  /**
   * For imagery tile (z,x,y): an (n+2)x(n+2) visibility grid (one cell of padding on each side),
   * where n = cells per tile side, plus summary flags.
   */
  coverage(z: number, x: number, y: number): Coverage {
    const M = this.maskZoomFor(z);
    const l = this.levels.get(M) ?? this.levels.get(this.index.minLevel + this.index.subdivision)!;
    const cf = this.index.coarseFraction;
    const minFraction = Math.min(cf.cap, cf.base + cf.perScale * this.scale);
    const need = l.finePerCell === 1 ? 1 : Math.max(1, Math.ceil(l.finePerCell * minFraction));
    let n: number, cx0: number, cy0: number;
    if (l.M >= z) { n = 1 << (l.M - z); cx0 = x * n; cy0 = y * n; }
    else { n = 1; cx0 = x >> (z - l.M); cy0 = y >> (z - l.M); }
    const side = n + 2;
    const grid = new Uint8Array(side * side);
    let on = 0;
    for (let j = 0; j < side; j++) {
      const my = cy0 + j - 1 - l.y0;
      if (my < 0 || my >= l.h) continue;
      for (let i = 0; i < side; i++) {
        const mx = cx0 + i - 1 - l.x0;
        if (mx < 0 || mx >= l.w) continue;
        if (l.count[my * l.w + mx] >= need) {
          grid[j * side + i] = 1;
          if (i > 0 && j > 0 && i <= n && j <= n) on++;
        }
      }
    }
    // corner bridges: an empty cell between two visible orthogonal neighbours gets the triangle
    // that faces them, turning the stair step into a 45° edge
    const bridges = new Uint8Array(side * side);
    let bridged = 0;
    if (on < n * n) { // even a tile with no cells of its own may bridge a corner from its neighbours
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = j * side + i;
        if (grid[k]) continue;
        const N = grid[k - side], S = grid[k + side], W = grid[k - 1], E = grid[k + 1];
        const f = (N && W ? BRIDGE_NW : 0) | (N && E ? BRIDGE_NE : 0) | (S && W ? BRIDGE_SW : 0) | (S && E ? BRIDGE_SE : 0);
        if (f) { bridges[k] = f; bridged++; }
      }
    }
    return { n, grid, bridges, any: on > 0 || bridged > 0, all: on === n * n };
  }
}
