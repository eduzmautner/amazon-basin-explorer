import maplibregl from 'maplibre-gl';
import { Mask, BRIDGE_NW, BRIDGE_NE, BRIDGE_SW, BRIDGE_SE } from './mask';

export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const TILE_PX = 256;

function blankTile(): ImageBitmap {
  const c = new OffscreenCanvas(1, 1);
  c.getContext('2d'); // a context must exist before a bitmap can be transferred out
  return c.transferToImageBitmap();
}

// Decoded imagery, kept so that moving the "visible land" slider re-composites tiles without
// re-downloading them. Small LRU: ~15 KB per tile.
const imageryCache = new Map<string, ArrayBuffer>();
const IMAGERY_CACHE_MAX = 800;
async function fetchImagery(z: number, x: number, y: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const key = `${z}/${x}/${y}`;
  const hit = imageryCache.get(key);
  if (hit) { imageryCache.delete(key); imageryCache.set(key, hit); return hit; }
  const res = await fetch(IMAGERY_URL(z, x, y), { signal });
  if (!res.ok) throw new Error(`imagery ${res.status}`);
  const buf = await res.arrayBuffer();
  imageryCache.set(key, buf);
  if (imageryCache.size > IMAGERY_CACHE_MAX) imageryCache.delete(imageryCache.keys().next().value!);
  return buf;
}

/**
 * Registers a <scheme>:// protocol for a pre-cut set of vector tiles (river names, river trails).
 * Only tiles listed in the index exist on disk, so anything else is answered locally with an
 * empty tile instead of a 404.
 */
export async function registerStaticTilesProtocol(scheme: string, base: string): Promise<{ minzoom: number; maxzoom: number }> {
  const res = await fetch(base + 'index.json');
  if (!res.ok) return { minzoom: 0, maxzoom: 0 };
  const index = (await res.json()) as { minzoom: number; maxzoom: number; keys: string[] };
  const keys = new Set(index.keys);
  maplibregl.addProtocol(scheme, async (params, abort) => {
    const key = params.url.replace(scheme + '://', '');
    if (!keys.has(key)) return { data: new ArrayBuffer(0) };
    const r = await fetch(base + key + '.pbf', { signal: abort.signal });
    if (!r.ok) throw new Error(`${scheme} ${r.status}`);
    return { data: await r.arrayBuffer() };
  });
  return { minzoom: index.minzoom, maxzoom: index.maxzoom };
}

/** Registers the masked:// protocol. Tiles outside the reveal grid are never requested from Esri. */
export function registerMaskedProtocol(mask: Mask) {
  maplibregl.addProtocol('masked', async (params, abort) => {
    try {
      return await maskedTile(mask, params.url, abort);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.warn('masked tile failed', params.url, e);
      throw e;
    }
  });
}

async function maskedTile(mask: Mask, url: string, abort: AbortController): Promise<{ data: ImageBitmap | ArrayBuffer }> {
  {
    // a query string (the slider value) is only there to defeat MapLibre's tile cache
    const m = /^masked:\/\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/.exec(url);
    if (!m) throw new Error("bad tile url " + url);
    const z = +m[1], x = +m[2], y = +m[3];
    const cov = mask.coverage(z, x, y);
    if (!cov.any) return { data: blankTile() };
    const bytes = await fetchImagery(z, x, y, abort.signal);
    if (cov.all) return { data: bytes };

    const img = await createImageBitmap(new Blob([bytes]));
    const { n, grid, bridges } = cov;
    const side = n + 2;
    const cellPx = TILE_PX / n;

    // alpha mask at tile resolution: whole cells as squares, bridge cells as 45° triangles facing
    // the two visible neighbours. Cell edges land on whole pixels, so squares stay pixel-sharp.
    const maskC = new OffscreenCanvas(TILE_PX, TILE_PX);
    const mctx = maskC.getContext('2d')!;
    mctx.fillStyle = '#000';
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const k = j * side + i;
      const x0 = (i - 1) * cellPx, y0 = (j - 1) * cellPx, x1 = x0 + cellPx, y1 = y0 + cellPx;
      if (grid[k]) { mctx.fillRect(x0, y0, cellPx, cellPx); continue; }
      const f = bridges[k];
      if (!f) continue;
      // one fill per triangle: in a single path, overlapping triangles with opposite winding cancel
      const tri = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
        mctx.beginPath(); mctx.moveTo(ax, ay); mctx.lineTo(bx, by); mctx.lineTo(cx, cy); mctx.closePath(); mctx.fill();
      };
      if (f & BRIDGE_NW) tri(x0, y0, x1, y0, x0, y1);
      if (f & BRIDGE_NE) tri(x1, y0, x0, y0, x1, y1);
      if (f & BRIDGE_SW) tri(x0, y1, x0, y0, x1, y1);
      if (f & BRIDGE_SE) tri(x1, y1, x1, y0, x0, y1);
    }

    const out = new OffscreenCanvas(TILE_PX, TILE_PX);
    const octx = out.getContext('2d')!;
    octx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(maskC, 0, 0);
    img.close();
    return { data: out.transferToImageBitmap() };
  }
}
