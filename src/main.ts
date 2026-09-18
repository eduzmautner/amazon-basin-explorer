import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { Mask } from './mask';
import { registerStaticTilesProtocol, registerMaskedProtocol, TILE_PX } from './tiles';
import { installInertialZoom } from './inertia';
import { MiniMapControl } from './minimap';
import { ZoomControl } from './zoomcontrol';
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
const borderColor = () => cssVar('--border'); // boxes and the continent outline share it
const borderSoftColor = () => cssVar('--border-soft'); // country borders, 25% lighter
function applyTheme(t: Theme) {
  root.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  // isStyleLoaded() is false whenever tiles are still loading, so check for the layer instead
  if (map?.getLayer('bg')) map.setPaintProperty('bg', 'background-color', bgColor());
  if (map?.getLayer('coast')) map.setPaintProperty('coast', 'line-color', borderColor());
  if (map?.getLayer('country-borders')) map.setPaintProperty('country-borders', 'line-color', borderSoftColor());
}

async function boot() {
  applyTheme(currentTheme());
  const loading = document.getElementById('loading')!;
  const mask = await Mask.load(BASE + 'mask/', (msg) => { loading.textContent = msg; });
  loading.hidden = true;
  registerMaskedProtocol(mask);
  const labels = await registerStaticTilesProtocol('labels', BASE + 'labels/');
  const rivers = await registerStaticTilesProtocol('rivers', BASE + 'rivers/');

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
            'Imagery © Esri, Maxar, Earthstar Geographics · Rivers: HydroRIVERS · Names © OpenStreetMap contributors, ANA (BHO 2017)',
        },
        outline: { type: 'geojson', data: BASE + 'outline.json' },
        countries: { type: 'geojson', data: BASE + 'countries.json' },
        labels: {
          type: 'vector',
          tiles: ['labels://{z}/{x}/{y}'],
          minzoom: labels.minzoom,
          maxzoom: labels.maxzoom,
        },
        rivers: {
          type: 'vector',
          tiles: ['rivers://{z}/{x}/{y}'],
          minzoom: rivers.minzoom,
          maxzoom: rivers.maxzoom,
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
          // 1.5px: an anti-aliased 1px line straddles two pixels at half strength and reads lighter
          // than the 1px DOM borders it is meant to match
          paint: { 'line-color': borderColor(), 'line-width': 1.5 },
        },
        // country borders (Natural Earth), a step lighter than the coastline
        {
          id: 'country-borders',
          type: 'line',
          source: 'countries',
          filter: ['==', ['get', 'kind'], 'border'],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': borderSoftColor(), 'line-width': 1.5 },
        },
        // "River Trails": HydroRIVERS centrelines, toggled from the panel
        {
          id: 'river-trails',
          type: 'line',
          source: 'rivers',
          'source-layer': 'rivers',
          // butt caps: rivers are pre-chained into continuous lines, so ends only meet at confluences,
          // and flat ends there stack less than round ones
          layout: { 'line-join': 'round', 'line-cap': 'butt', visibility: 'none' },
          // opacity by Strahler order: 5% per step from 15% at order 3 (and below) to 50% at the order 10 Amazon
          paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': ['*', 0.05, ['max', 3, ['coalesce', ['get', 'ord'], 3]]] },
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
        // country names: same face and halo as the river names, upper case, two sizes larger
        {
          id: 'country-names',
          type: 'symbol',
          source: 'countries',
          filter: ['==', ['get', 'kind'], 'label'],
          layout: {
            'text-field': ['upcase', ['get', 'name']],
            'text-font': ['Liberation Sans Regular'],
            'text-size': 16,
            'text-letter-spacing': 0.05,
            'text-padding': 6,
            'text-pitch-alignment': 'viewport',
          },
          paint: {
            'text-color': '#ffffff',
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
    fadeDuration: 0, // labels appear and disappear instantly, matching the River Labels toggle both ways
    canvasContextAttributes: { preserveDrawingBuffer: true }, // lets the snapshot button read the canvas at any time
  });
  if (import.meta.env.DEV) (window as any).__map = map; // handy for poking at the map from devtools
  map.touchZoomRotate.disableRotation();
  map.keyboard.disable();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  const UNITS_KEY = 'amazon-explorer-units';
  type Units = 'imperial' | 'metric';
  let units: Units = 'imperial';
  try { if (localStorage.getItem(UNITS_KEY) === 'metric') units = 'metric'; } catch {}
  const scaleBar = new maplibregl.ScaleControl({ maxWidth: 140, unit: units });
  map.addControl(scaleBar, 'bottom-right');
  const minimap = new MiniMapControl(mask);
  map.addControl(minimap, 'bottom-right'); // added after the scale bar, so it stacks above it
  map.addControl(new ZoomControl(), 'bottom-right'); // above the minimap, or right above the scale bar while that is hidden
  // start collapsed to the (i) button; MapLibre opens it once the style loads
  map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  installInertialZoom(map);

  const hint = document.getElementById('hint')!;
  map.once('movestart', () => hint.classList.add('fade'));

  // "visible land" slider: re-threshold the reveal grid and reload the imagery tiles
  const slider = document.getElementById('visible') as HTMLInputElement;
  const readout = document.getElementById('visible-value')!;
  // always opens at the default (the whole basin); the slider is not remembered between visits
  try { localStorage.removeItem('amazon-explorer-corridor-scale'); } catch {}
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
      (map!.getSource('imagery') as maplibregl.RasterTileSource).setTiles([`masked://{z}/{x}/{y}?v=${v}`]);
    }, 120);
  });

  // River info panel: click a name label, look the river up in riverinfo.json (loaded once)
  type RiverInfo = {
    name: string; lengthKm: number | null; toSeaKm: number | null; eleSource: number | null; eleMouth: number | null;
    gradient: number | null; order: number; disAvg: number | null; disMax: number | null; disMin: number | null;
    inundPct: number | null; lakePct: number | null; lakeVolMcm: number | null; regulationPct: number | null;
    population: number | null; popDensity: number | null; water: 'white' | 'black' | 'clear' | null; note?: string;
  };
  let riverInfo: Promise<Record<string, RiverInfo>> | undefined;
  const panel = document.getElementById('river-panel')!;
  const rpName = document.getElementById('rp-name')!, rpWater = document.getElementById('rp-water')!, rpRows = document.getElementById('rp-rows')!, rpNote = document.getElementById('rp-note')!;
  const fmt = new Intl.NumberFormat('en-US');
  const km = (v: number | null) => (v === null ? 'N/A' : fmt.format(Math.round(v)) + ' km');
  const m3 = (v: number | null) => (v === null ? 'N/A' : (v >= 100 ? fmt.format(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2)) + ' m³/s');
  const WATER: Record<string, string> = {
    white: 'Whitewater river: sediment-laden, from the Andes',
    black: 'Blackwater river: tannin-stained, sediment-poor',
    clear: 'Clearwater river: draining the ancient shields',
  };
  const showRiver = (info: RiverInfo) => {
    rpName.textContent = info.name;
    rpWater.textContent = info.water ? WATER[info.water] : '';
    rpWater.hidden = !info.water;
    rpNote.textContent = info.note ?? '';
    rpNote.hidden = !info.note;
    const rows: [string, string][] = [
      ['Length', km(info.lengthKm)],
      ['Distance to the sea', km(info.toSeaKm)],
      ['Source elevation', info.eleSource === null ? 'N/A' : fmt.format(info.eleSource) + ' m'],
      ['Mouth elevation', info.eleMouth === null ? 'N/A' : fmt.format(info.eleMouth) + ' m'],
      ['Gradient', info.gradient === null ? 'N/A' : info.gradient.toFixed(2) + ' m/km'],
      ['Stream order', String(info.order)],
      ['Discharge, mean', m3(info.disAvg)],
      ['Discharge, peak month', m3(info.disMax)],
      ['Discharge, low month', m3(info.disMin)],
      ['Land flooded yearly', info.inundPct === null ? 'N/A' : info.inundPct.toFixed(1) + ' %'],
      ['Lakes in catchment', info.lakePct === null ? 'N/A' : info.lakePct.toFixed(2) + ' % of area'],
      ['Population in catchment', info.population === null ? 'N/A' : fmt.format(info.population)],
      ['Population density', info.popDensity === null ? 'N/A' : info.popDensity.toFixed(1) + ' / km²'],
    ];
    if (info.regulationPct !== null && info.regulationPct > 0) rows.push(['Flow regulated by dams', info.regulationPct.toFixed(1) + ' %']);
    rpRows.replaceChildren(...rows.map(([k, v]) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = k; const b = document.createElement('td'); b.textContent = v; tr.append(a, b); return tr; }));
    panel.hidden = false;
  };
  const openRiver = async (rid: string) => {
    riverInfo ??= fetch(BASE + 'riverinfo.json').then((r) => r.json());
    const info = (await riverInfo)[rid];
    if (info) showRiver(info);
  };
  if (import.meta.env.DEV) (window as any).__openRiver = openRiver;
  // a finger is not a pixel: look for a label within a box around the tap, nearest first
  const TAP_PX = 14;
  map.on('click', async (e) => {
    const { x, y } = e.point;
    const hits = map!.queryRenderedFeatures([[x - TAP_PX, y - TAP_PX], [x + TAP_PX, y + TAP_PX]], { layers: ['river-names'] });
    const rid = hits[0]?.properties?.rid as string | undefined;
    if (rid) await openRiver(rid);
  });
  const cc = map.getCanvasContainer();
  map.on('mouseenter', 'river-names', () => cc.classList.add('on-label'));
  map.on('mouseleave', 'river-names', () => cc.classList.remove('on-label'));
  document.getElementById('rp-close')!.addEventListener('click', () => { panel.hidden = true; });

  // River Trails toggle
  const trails = document.getElementById('trails') as HTMLInputElement;
  const TRAILS_KEY = 'amazon-explorer-trails';
  const applyTrails = () => map!.setLayoutProperty('river-trails', 'visibility', trails.checked ? 'visible' : 'none');
  try { trails.checked = localStorage.getItem(TRAILS_KEY) !== '0'; } catch {} // on by default
  map.once('load', applyTrails);
  trails.addEventListener('change', () => { applyTrails(); try { localStorage.setItem(TRAILS_KEY, trails.checked ? '1' : '0'); } catch {} });

  // Countries toggle: borders and names together
  const countriesToggle = document.getElementById('countries') as HTMLInputElement;
  const COUNTRIES_KEY = 'amazon-explorer-countries';
  const applyCountries = () => {
    const v = countriesToggle.checked ? 'visible' : 'none';
    for (const id of ['country-borders', 'country-names']) map!.setLayoutProperty(id, 'visibility', v);
    minimap.setCountries(countriesToggle.checked);
  };
  try { countriesToggle.checked = localStorage.getItem(COUNTRIES_KEY) !== '0'; } catch {}
  map.once('load', applyCountries);
  countriesToggle.addEventListener('change', () => { applyCountries(); try { localStorage.setItem(COUNTRIES_KEY, countriesToggle.checked ? '1' : '0'); } catch {} });

  // River Labels toggle: names off = free exploring, nothing to tap; the info panel closes with them
  const labelsToggle = document.getElementById('labels') as HTMLInputElement;
  const LABELS_KEY = 'amazon-explorer-labels';
  const applyLabels = () => {
    map!.setLayoutProperty('river-names', 'visibility', labelsToggle.checked ? 'visible' : 'none');
    if (!labelsToggle.checked) { panel.hidden = true; cc.classList.remove('on-label'); }
  };
  try { labelsToggle.checked = localStorage.getItem(LABELS_KEY) !== '0'; } catch {}
  map.once('load', applyLabels);
  labelsToggle.addEventListener('change', () => { applyLabels(); try { localStorage.setItem(LABELS_KEY, labelsToggle.checked ? '1' : '0'); } catch {} });

  // Units toggle: miles / kilometres on the scale bar (the river data is already metric)
  const unitButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#units-control button[data-unit]'));
  const applyUnits = () => {
    scaleBar.setUnit(units);
    for (const b of unitButtons) b.setAttribute('aria-checked', b.dataset.unit === units ? 'true' : 'false');
  };
  applyUnits();
  for (const b of unitButtons) b.addEventListener('click', () => {
    units = b.dataset.unit as Units;
    applyUnits();
    try { localStorage.setItem(UNITS_KEY, units); } catch {}
  });

  // snapshot: the map canvas alone (imagery, outline, names); the DOM overlays are not part of it
  const snapBtn = document.getElementById('snapshot') as HTMLButtonElement;
  const SNAPSHOT_LONG_SIDE = 2500;
  /**
   * Renders the current view into an off-screen map at whatever pixel ratio makes the long side
   * SNAPSHOT_LONG_SIDE px, so the export is the same size on every screen. Same style, centre and
   * zoom, so cells and labels look exactly as on screen, just at high resolution.
   */
  const takeSnapshot = async (): Promise<Blob> => {
    const src = map!;
    const w = src.getCanvas().clientWidth, h = src.getCanvas().clientHeight;
    const holder = document.createElement('div');
    holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${h}px;pointer-events:none;`;
    document.body.appendChild(holder);
    const off = new maplibregl.Map({
      container: holder,
      style: src.getStyle(),
      center: src.getCenter(),
      zoom: src.getZoom(),
      bearing: 0,
      pitch: 0,
      pixelRatio: SNAPSHOT_LONG_SIDE / Math.max(w, h),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    try {
      // wait until every tile and label is in (or give up after a while and take what is there)
      await Promise.race([new Promise<void>((r) => off.once('idle', () => r())), new Promise<void>((r) => setTimeout(r, 30_000))]);
      off.redraw();
      return await new Promise<Blob>((resolve, reject) =>
        off.getCanvas().toBlob((blob) => (blob ? resolve(blob) : reject(new Error('snapshot failed'))), 'image/png'));
    } finally {
      off.remove();
      holder.remove();
    }
  };
  if (import.meta.env.DEV) (window as any).__takeSnapshot = takeSnapshot;
  snapBtn.addEventListener('click', async () => {
    snapBtn.disabled = true;
    const label = snapBtn.textContent;
    snapBtn.textContent = 'Rendering…';
    try {
      const blob = await takeSnapshot();
      const c = map!.getCenter();
      const name = `amazon-basin_${c.lat.toFixed(3)}_${c.lng.toFixed(3)}_z${map!.getZoom().toFixed(1)}.png`;
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally { snapBtn.disabled = false; snapBtn.textContent = label; }
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
