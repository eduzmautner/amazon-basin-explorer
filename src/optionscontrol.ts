import type maplibregl from 'maplibre-gl';

/**
 * "Map options" button for phones: a folded-map icon in the bottom-right stack, above the zoom
 * buttons, that opens the controls as a bottom sheet. Hidden by CSS on wider screens, where the
 * controls stay in the top-right corner.
 */
export class OptionsControl implements maplibregl.IControl {
  private container!: HTMLDivElement;

  constructor(private onToggle: () => void) {}

  onAdd() {
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl options-control';
    const b = document.createElement('button');
    b.type = 'button'; b.title = 'Map options'; b.setAttribute('aria-label', 'Map options');
    // folded map, three panels: outline plus the two fold lines
    b.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'
      + '<path d="M6.3 7.65 10.1 5.95 13.8 7.65 17.7 5.95 17.7 16.15 13.8 18.05 10.1 16.15 6.3 18.05Z"/>'
      + '<path d="M10.1 5.95V16.15M13.8 7.65V18.05"/></svg>';
    b.addEventListener('click', this.onToggle);
    this.container.appendChild(b);
    return this.container;
  }

  onRemove() { this.container.remove(); }
}
