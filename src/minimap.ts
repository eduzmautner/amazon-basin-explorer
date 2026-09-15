import maplibregl from 'maplibre-gl';
import type { Mask } from './mask';
import { BASE } from './base';

const EARTH_CIRC = 40075016.686;
const MILE_M = 1609.344;
/** Basin overview extent (lon/lat). 3:2 in mercator at this latitude band. */
const EXTENT = { w: -81, e: -46, s: -21.5, n: 6.5 };
const WIDTH = 210, HEIGHT = 140;
/** Show the overview once the scale bar reads 50 mi or less, i.e. 100 mi no longer fits its 140 px. */
const SHOW_BELOW_MILES = 100, SCALE_BAR_PX = 140;
const SILHOUETTE_MASK_ZOOM = 11; // ~19 km cells: ~330 x 300 over the extent, plenty for 210 px

const mercY = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const mercX = (lon: number) => (lon + 180) / 360;

/** A small canvas overview: basin silhouette, coastline and the current viewport. */
export class MiniMapControl implements maplibregl.IControl {
  private container!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private base = document.createElement('canvas'); // silhouette + coast, redrawn only when they change
  private map?: maplibregl.Map;
  private coast: number[][][] = [];
  private px0 = mercX(EXTENT.w); private px1 = mercX(EXTENT.e);
  private py0 = mercY(EXTENT.n); private py1 = mercY(EXTENT.s);

  constructor(private mask: Mask) {}

  onAdd(map: maplibregl.Map) {
    this.map = map;
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl minimap';
    this.canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.base]) { c.width = WIDTH * dpr; c.height = HEIGHT * dpr; }
    this.canvas.style.width = WIDTH + 'px';
    this.canvas.style.height = HEIGHT + 'px';
    this.container.appendChild(this.canvas);
    fetch(BASE + 'outline.json').then((r) => r.json()).then((f) => { this.coast = f.geometry.coordinates; this.redrawBase(); this.draw(); });
    this.redrawBase();
    map.on('move', this.draw);
    map.on('resize', this.draw);
    this.draw();
    return this.container;
  }

  onRemove() { this.map?.off('move', this.draw); this.map?.off('resize', this.draw); this.container.remove(); this.map = undefined; }

  /** Call after the theme or the corridor scale changes. */
  refresh() { this.redrawBase(); this.draw(); }

  private toPx(lon: number, lat: number): [number, number] {
    const dpr = window.devicePixelRatio || 1;
    return [((mercX(lon) - this.px0) / (this.px1 - this.px0)) * WIDTH * dpr, ((mercY(lat) - this.py0) / (this.py1 - this.py0)) * HEIGHT * dpr];
  }

  private css(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  private redrawBase() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.base.getContext('2d')!;
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    // silhouette
    const s = this.mask.silhouette(SILHOUETTE_MASK_ZOOM);
    const scale = 2 ** s.M;
    const sx = (WIDTH * dpr) / ((this.px1 - this.px0) * scale), sy = (HEIGHT * dpr) / ((this.py1 - this.py0) * scale);
    const ox = this.px0 * scale, oy = this.py0 * scale;
    ctx.fillStyle = this.css('--muted');
    for (let cy = 0; cy < s.h; cy++) for (let cx = 0; cx < s.w; cx++) {
      if (!s.on[cy * s.w + cx]) continue;
      // snap to whole device pixels so neighbouring cells share edges with no hairline seams
      const x = Math.floor((s.x0 + cx - ox) * sx), y = Math.floor((s.y0 + cy - oy) * sy);
      const x2 = Math.floor((s.x0 + cx + 1 - ox) * sx), y2 = Math.floor((s.y0 + cy + 1 - oy) * sy);
      ctx.fillRect(x, y, x2 - x, y2 - y);
    }
    // coastline
    ctx.strokeStyle = this.css('--border');
    ctx.lineWidth = 1.5 * dpr; // see the coast layer in main.ts
    ctx.beginPath();
    for (const ring of this.coast) {
      ring.forEach(([lon, lat], i) => { const [x, y] = this.toPx(lon, lat); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    }
    ctx.stroke();
  }

  private draw = () => {
    const map = this.map;
    if (!map) return;
    // visibility: only when the map is zoomed in past the 50 mi scale mark
    const lat = map.getCenter().lat;
    const mPerPx = (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    const shown = (mPerPx * SCALE_BAR_PX) / MILE_M < SHOW_BELOW_MILES;
    this.container.classList.toggle('minimap-hidden', !shown);
    if (!shown) return;

    const dpr = window.devicePixelRatio || 1;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    // viewport
    const b = map.getBounds();
    const [x0, y0] = this.toPx(b.getWest(), b.getNorth());
    const [x1, y1] = this.toPx(b.getEast(), b.getSouth());
    const minPx = 6 * dpr;
    const w = Math.max(minPx, x1 - x0), h = Math.max(minPx, y1 - y0);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    ctx.strokeStyle = this.css('--fg');
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(Math.round(cx - w / 2) + 0.5, Math.round(cy - h / 2) + 0.5, Math.round(w), Math.round(h));
  };
}
