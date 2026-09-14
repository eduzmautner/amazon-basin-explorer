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
// corridor radius, in this many steps (4 bits: 15 steps inside + "outside").
export const DIST_LEVELS = 15;
// "Visible land" slider = corridor scale (1 = full corridor widths, 0.05 = a sliver either side of
// each river). Default position:
export const DEFAULT_CORRIDOR_SCALE = 0.75;
// A coarse (zoomed-out) cell is shown when the fraction of its ground area inside a (scaled)
// corridor is at least min(cap, base + perScale * slider). Measured on the basin core: at 100%
// this lights ~85% of cells (near solid, a few holes), at 50% about half, at 15% about a quarter,
// so the ribbons of the big rivers stay visible even with the thinnest corridors.
export const COARSE_FRACTION = { base: 0.17, perScale: 0.66, cap: 0.5 };

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
