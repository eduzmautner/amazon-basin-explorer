import maplibregl from 'maplibre-gl';
import { Mask } from './mask';

export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const TILE_PX = 256;
/** Width in screen pixels of the soft transition at every mask edge. 0 = pixel-sharp squares. */
export const FEATHER_PX = 0;

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
 * Registers the labels:// protocol for the river-name vector tiles. Only tiles listed in the
 * index exist on disk, so anything else is answered locally with an empty tile.
 */
export async function registerLabelsProtocol(base = '/labels/'): Promise<{ minzoom: number; maxzoom: number }> {
  const res = await fetch(base + 'index.json');
  if (!res.ok) return { minzoom: 0, maxzoom: 0 };
  const index = (await res.json()) as { minzoom: number; maxzoom: number; keys: string[] };
  const keys = new Set(index.keys);
  maplibregl.addProtocol('labels', async (params, abort) => {
    const key = params.url.replace('labels://', '');
    if (!keys.has(key)) return { data: new ArrayBuffer(0) };
    const r = await fetch(base + key + '.pbf', { signal: abort.signal });
    if (!r.ok) throw new Error(`labels ${r.status}`);
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
    const { n, grid } = cov;
    const side = n + 2;
    const cellPx = TILE_PX / n;

    // 1) tiny alpha image of the padded cell grid
    const tiny = new OffscreenCanvas(side, side);
    const tctx = tiny.getContext('2d')!;
    const id = tctx.createImageData(side, side);
    for (let i = 0; i < side * side; i++) id.data[i * 4 + 3] = grid[i] ? 255 : 0;
    tctx.putImageData(id, 0, 0);

    // 2) scale the cell grid up to tile size. With no feather this is a plain nearest-neighbour
    //    blit, so every cell edge lands exactly on a pixel boundary. With a feather, the grid is first
    //    blown up so each cell is (cellPx / feather) texels wide and then smoothed, which gives a
    //    bilinear ramp ~FEATHER_PX wide on screen whatever the cell size.
    let maskImg: OffscreenCanvas = tiny;
    const feather = Math.min(FEATHER_PX, cellPx);
    if (feather > 0) {
      const midSide = Math.round(side * (cellPx / feather));
      maskImg = new OffscreenCanvas(midSide, midSide);
      const mctx = maskImg.getContext('2d')!;
      mctx.imageSmoothingEnabled = false;
      mctx.drawImage(tiny, 0, 0, midSide, midSide);
    }

    const out = new OffscreenCanvas(TILE_PX, TILE_PX);
    const octx = out.getContext('2d')!;
    octx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    octx.globalCompositeOperation = 'destination-in';
    octx.imageSmoothingEnabled = feather > 0;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(maskImg, -cellPx, -cellPx, side * cellPx, side * cellPx);
    img.close();
    return { data: out.transferToImageBitmap() };
  }
}
