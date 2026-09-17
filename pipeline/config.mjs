// Shared tuning knobs for the data pipeline and (mirrored) the client.

// Reveal bands, keyed on imagery tile zoom (= map zoom + 1). Each band is one dataset: every reach
// with upstream area >= threshold km² is rasterised at the band's finest zoom and the coarser zooms
// in the band are downsampled from it, so within a band zooming never swaps rivers in or out.
// Fewer bands = fewer visible "refreshes" while zooming; one band = the same rivers at every zoom.
export const MASK_BANDS = [
  { maxZoom: 12, threshold: 0 }, // one band: every reach in the model at every zoom
];
export const MIN_MASK_LEVEL = 3;
export const MAX_MASK_LEVEL = 12; // imagery zooms above this reuse level 12's grid

// Imagery zoom -> minimum upstream area (km²) for a river's *name* to appear. Independent of the
// mask so that at the world view only the big rivers compete for label space.
export const REVEAL_THRESHOLD_BY_ZOOM = {
  3: 300000, 4: 100000, 5: 40000, 6: 15000, 7: 5000, 8: 1500, 9: 500, 10: 150, 11: 40, 12: 0,
};

// The finest grid stores each cell's distance to the nearest river as a fraction of that river's
// corridor radius, in this many steps (4 bits: 14 corridor steps, then INTERIOR_LEVEL = inside the
// basin but beyond every corridor, shown only at 100% visible land, and 15 = outside the basin).
export const DIST_LEVELS = 14;
export const INTERIOR_LEVEL = 14;
export const OUTSIDE_LEVEL = 15;
// Basin interior = cells not reachable from the grid border without crossing a corridor, tested on
// a 2x coarser grid with the corridors thickened by this many coarse cells so that small gaps
// between headwater corridors on the divide do not let the "outside" leak in.
export const INTERIOR_CLOSE_CELLS = 2;
// "Visible land" slider = corridor scale (1 = full corridor widths, 0.05 = a sliver either side of
// each river). Default position: the whole basin.
export const DEFAULT_CORRIDOR_SCALE = 1;
// A coarse (zoomed-out) cell is shown when the fraction of its ground area inside a (scaled)
// corridor is at least T(s) = cap - (cap - t0) * exp(-k * (s - s0)), s = slider (0.15..1).
// The curve was fitted so the share of the basin shown grows steadily at every 5% step: ~10% at
// 15%, ~37% at 50%, ~55% at 100% (measured on the on-load zoom). A steeper curve makes some steps
// lose cells; a flatter one shows nearly everything by 40%.
export const COARSE_FRACTION = { t0: 0.2, s0: 0.15, k: 2.8, cap: 0.62 };

// Mask grid is this many zoom levels finer than the imagery tile (5 => 32x32 cells per 256px tile,
// i.e. 8px squares on screen). Capped at MAX_MASK_ZOOM so the finest file stays a sane size.
export const MASK_SUBDIVISION = 5;
export const MAX_MASK_ZOOM = 17; // ~300 m cells at the equator

// Corridor half-width in miles as a function of upstream area (km²): log-linear from 0.5 mi to 5 mi.
export function corridorMiles(uplandKm2) {
  const lo = 1, hi = Math.log10(3e6);
  const t = Math.min(1, Math.max(0, (Math.log10(Math.max(uplandKm2, 10)) - lo) / (hi - lo)));
  return 0.5 + 4.5 * t;
}
export const MILE_M = 1609.344;

// Main-stem naming, Brazilian geographic usage (IBGE, ANA): Río Amazonas in Peru and along the
// Colombian border; Rio Solimões from where the river enters Brazil at Tabatinga down to the
// Encontro das Águas at Manaus, where the Rio Negro joins; Rio Amazonas from there to the sea.
// The main stem flows steadily east, so longitude separates the stretches. The confluence longitude
// is HydroRIVERS' own (59.902 W, 3.140 S). The main stem proper starts where the Marañón and the
// Ucayali meet, where the upstream area steps up past MAIN_STEM_MIN_UP.
export const BORDER_LON = -69.95;
export const NEGRO_CONFLUENCE_LON = -59.902;
export const MAIN_STEM_MIN_UP = 700000; // km²
export const mainStemName = (lon) => (lon < BORDER_LON ? 'Río Amazonas' : lon < NEGRO_CONFLUENCE_LON ? 'Rio Solimões' : 'Rio Amazonas');
