import type maplibregl from 'maplibre-gl';

/**
 * "About" button, bottom left, in the same framed box as the zoom buttons. Opens the about panel:
 * what the map is, and the data it is built from, in place of MapLibre's compact attribution.
 */
export class AboutControl implements maplibregl.IControl {
  private container!: HTMLDivElement;

  constructor(private onToggle: () => void) {}

  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl about-control';
    const b = document.createElement('button');
    b.type = 'button'; b.title = 'About this map'; b.setAttribute('aria-label', 'About this map');
    // an "i": a dot over a stem, drawn so it matches the weight of the other glyphs
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">'
      + '<path d="M12 10.5V17.5"/><circle cx="12" cy="6.75" r="0.9" fill="currentColor" stroke="none"/></svg>';
    b.addEventListener('click', this.onToggle);
    this.container.appendChild(b);
    return this.container;
  }

  onRemove() { this.container.remove(); }
}
