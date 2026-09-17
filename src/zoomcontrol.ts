import type maplibregl from 'maplibre-gl';

/**
 * Plus / minus zoom buttons, stacked like Google Maps' but in this site's box style. Added to the
 * bottom-right corner after the scale bar and the minimap, so it sits above the minimap, and drops
 * onto the scale bar whenever the minimap is hidden.
 */
export class ZoomControl implements maplibregl.IControl {
  private container!: HTMLDivElement;
  private map?: maplibregl.Map;
  private plus!: HTMLButtonElement;
  private minus!: HTMLButtonElement;

  onAdd(map: maplibregl.Map) {
    this.map = map;
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl zoom-control';
    this.plus = this.button('+', 'Zoom in', () => map.zoomIn({ duration: 400 }));
    this.minus = this.button('−', 'Zoom out', () => map.zoomOut({ duration: 400 }));
    this.container.append(this.plus, this.minus);
    map.on('zoom', this.sync);
    map.on('resize', this.sync);
    this.sync();
    return this.container;
  }

  onRemove() { this.map?.off('zoom', this.sync); this.map?.off('resize', this.sync); this.container.remove(); this.map = undefined; }

  private button(glyph: string, label: string, act: () => void) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = glyph; b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', act);
    return b;
  }

  /**
   * The furthest the map can really zoom out: its minZoom, or the zoom at which the panning bounds
   * just fill the window, whichever is closer in. MapLibre clamps to that silently.
   */
  private floorZoom(map: maplibregl.Map) {
    let floor = map.getMinZoom();
    const b = map.getMaxBounds();
    if (b) {
      const my = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
      const c = map.getContainer();
      const fx = (b.getEast() - b.getWest()) / 360, fy = my(b.getSouth()) - my(b.getNorth());
      floor = Math.max(floor, Math.log2(c.clientWidth / (512 * fx)), Math.log2(c.clientHeight / (512 * fy)));
    }
    return floor;
  }

  /** Grey out a button at the end of the zoom range. */
  private sync = () => {
    const map = this.map;
    if (!map) return;
    const z = map.getZoom();
    this.plus.disabled = z >= map.getMaxZoom() - 1e-6;
    this.minus.disabled = z <= this.floorZoom(map) + 1e-3;
  };
}
