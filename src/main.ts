import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Mask } from './mask';
import { registerLabelsProtocol, registerMaskedProtocol, TILE_PX } from './tiles';
import { installInertialZoom } from './inertia';
import { MiniMapControl } from './minimap';
import { BASE } from './base';

const THEME_KEY = 'amazon-explorer-theme';
const root = document.documentElement;
let map: maplibregl.Map | undefined;

type Theme = 'light' | 'dark';
function currentTheme(): Theme {
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch {}
  return 'dark'; // default; the toggle's choice is remembered per browser
}
const cssVar = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
const bgColor = () => cssVar('--bg');
const fgColor = () => cssVar('--fg');
function applyTheme(t: Theme) {
  root.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  // isStyleLoaded() is false whenever tiles are still loading, so check for the layer instead
  if (map?.getLayer('bg')) map.setPaintProperty('bg', 'background-color', bgColor());
  if (map?.getLayer('coast')) map.setPaintProperty('coast', 'line-color', fgColor());
}

async function boot() {
  applyTheme(currentTheme());
  const loading = document.getElementById('loading')!;
  const mask = await Mask.load(BASE + 'mask/', (msg) => { loading.textContent = msg; });
  loading.hidden = true;
  registerMaskedProtocol(mask);
  const labels = await registerLabelsProtocol(BASE + 'labels/');

  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        imagery: {
          type: 'raster',
          tiles: [`masked://{z}/{x}/{y}?v=${mask.getVisible()}`],
          tileSize: TILE_PX,
          minzoom: 3,
          maxzoom: 17,
          attribution:
            'Imagery © Esri, Maxar, Earthstar Geographics · Rivers: HydroRIVERS · Names © OpenStreetMap contributors',
        },
        outline: { type: 'geojson', data: BASE + 'outline.json' },
        labels: {
          type: 'vector',
          tiles: ['labels://{z}/{x}/{y}'],
          minzoom: labels.minzoom,
          maxzoom: labels.maxzoom,
        },
      },
      glyphs: BASE + 'fonts/{fontstack}/{range}.pbf',
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': bgColor() } },
        { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 400 } },
        // South American coastline, for a sense of scale
        {
          id: 'coast',
          type: 'line',
          source: 'outline',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': fgColor(), 'line-width': 1 },
        },
        {
          id: 'river-names',
          type: 'symbol',
          source: 'labels',
          'source-layer': 'rivers',
          layout: {
            'symbol-placement': 'line',
            'symbol-spacing': 450,
            'text-field': ['get', 'name'],
            // Liberation Sans is the freely redistributable metric twin of Arial (see README, Fonts)
            'text-font': ['Liberation Sans Regular'],
            'text-size': 14,
            'text-letter-spacing': 0.05,
            'text-max-angle': 60,
            'text-padding': 6,
            'text-pitch-alignment': 'viewport',
          },
          paint: {
            'text-color': '#ffffff',
            // MapLibre has no offset drop shadow for text; a soft, low-opacity halo reads as one
            'text-halo-color': 'rgba(0, 0, 0, 0.45)',
            'text-halo-width': 1,
            'text-halo-blur': 1,
          },
        },
      ],
    },
    bounds: [[-79.5, -19], [-48.5, 5.5]],
    fitBoundsOptions: { padding: 40 },
    minZoom: 3.2,
    maxZoom: 17,
    maxBounds: [[-100, -35], [-28, 20]],
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
    // heavier, longer glide when panning
    dragPan: { linearity: 0.25, maxSpeed: 2200, deceleration: 1500 },
    fadeDuration: 400,
  });
  if (import.meta.env.DEV) (window as any).__map = map; // handy for poking at the map from devtools
  map.touchZoomRotate.disableRotation();
  map.keyboard.disable();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'imperial' }), 'bottom-right');
  const minimap = new MiniMapControl(mask);
  map.addControl(minimap, 'bottom-right'); // added after the scale bar, so it stacks above it
  // start collapsed to the (i) button; MapLibre opens it once the style loads
  map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  installInertialZoom(map);

  const hint = document.getElementById('hint')!;
  map.once('movestart', () => hint.classList.add('fade'));

  // "visible land" slider: re-threshold the reveal grid and reload the imagery tiles
  const slider = document.getElementById('visible') as HTMLInputElement;
  const readout = document.getElementById('visible-value')!;
  const VIS_KEY = 'amazon-explorer-corridor-scale';
  try { const v = Number(localStorage.getItem(VIS_KEY)); if (v >= 15 && v <= 100) mask.setVisible(v / 100); } catch {}
  slider.value = String(Math.round(mask.getVisible() * 100));
  const showValue = () => { readout.textContent = slider.value + '%'; };
  showValue();
  let pending = 0;
  slider.addEventListener('input', () => {
    showValue();
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      const v = Number(slider.value) / 100;
      readout.textContent = '…'; // re-thresholding the grid takes well under a second
      mask.setVisible(v);
      showValue();
      minimap.refresh();
      try { localStorage.setItem(VIS_KEY, slider.value); } catch {}
      (map!.getSource('imagery') as maplibregl.RasterTileSource).setTiles([`masked://{z}/{x}/{y}?v=${v}`]);
    }, 120);
  });

  document.getElementById('theme')!.addEventListener('click', () => {
    applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
    minimap.refresh();
  });
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:2em">${String(e)}</pre>`;
});
