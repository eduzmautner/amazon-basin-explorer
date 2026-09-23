# Amazon Basin Explorer

A satellite map that shows only the Amazon river system: the main stem, every tributary down to the
smallest stream in the HydroRIVERS model, and a strip of imagery around each one. Everything else
is masked. Zoomed out, the whole basin reads as a pixel-edged silhouette against the void; zoom in
and the corridors resolve around each river, with names from OpenStreetMap and, inside Brazil,
from the national water agency ANA.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. Scroll to zoom, drag to pan. Top right: dark/light toggle and the
"visible land" slider (how wide the strip of land around each river is), the "River Trails" toggle
(the HydroRIVERS network as white lines) and a snapshot button (2500 px PNG of the map, no UI). Click a
river name to open an info panel with its length, discharge and more. Bottom right: an overview
minimap that appears from the 50-mile scale in, and the scale bar.

## How it works

- **Imagery**: Esri World Imagery tiles, requested through a custom `masked://` tile protocol
  (`src/tiles.ts`). Each tile is checked against the reveal grid; tiles fully outside the corridors
  are never fetched, partially covered tiles are clipped cell by cell on a canvas.
- **Reveal grid** (`src/mask.ts`): one ~300 m grid over the basin, shipped as `public/mask/finest.bin.gz`
  (about 20 MB). Each cell stores how deep inside a river corridor it sits, so the corridor width can
  be scaled live by the slider. Corridor width scales with river size, from 5 miles on the main stem
  to 0.5 mile on creeks. Coarser zooms are derived in the browser by counting fine cells; a
  zoomed-out cell shows when enough of its area is inside a corridor (`coarseFraction` in the index).
- **Names**: `pipeline/build-labels.mjs` chains OpenStreetMap waterway ways by name, matches each to
  the nearest HydroRIVERS reach to learn its size, generalises and smooths the path per zoom, and
  writes vector tiles. Names of bigger rivers appear first as you zoom.
- **Motion**: MapLibre's drag inertia, tuned heavier, plus a velocity-based scroll zoom in
  `src/inertia.ts` so zooming glides to a stop too.
- **Minimap** (`src/minimap.ts`): a canvas drawing of the basin silhouette, coastline and viewport,
  built from the same reveal grid.

Tuning knobs live in `pipeline/config.mjs`.

## Data pipeline (run once; outputs are committed under `public/`)

1. Download `HydroRIVERS_v10_sa_shp.zip` from https://www.hydrosheds.org/products/hydrorivers
   (the file host sits behind a browser check, so download it in a browser) and unzip it into
   `data/raw/HydroRIVERS_v10_sa_shp/`.
2. `npm run data:rivers` extracts the Amazon basin (745k reaches) to `data/work/amazon.ndjson`.
3. `npm run data:tiles` builds `public/mask/`.
4. `npm run data:names` fetches named waterways from Overpass in chunks to
   `data/work/osm-names.ndjson`. It is resumable and slow (the public servers rate-limit).
4b. `node pipeline/fetch-ana-names.mjs` fetches ANA's named river reaches for the Amazon basin (BHO 2017,
   public feature service, about a minute) to `data/work/ana-names.ndjson`. Optional: OSM stays the
   primary source, and ANA only labels stretches OSM leaves unnamed, matched to HydroRIVERS by
   upstream area. Rebuild the river info (5c) after the labels so the new rivers get panels.
5. `npm run data:labels` builds `public/labels/`.
5a. `node pipeline/build-countries.mjs` builds `public/countries.json` (country borders as the edges shared by two
   Natural Earth countries, plus a label point each) for the "Countries" toggle.
5a2. `node pipeline/build-settlements.mjs` builds `public/settlements.json` (towns of 2,000+ people near the basin's
   rivers) from GeoNames `cities500.txt` (download https://download.geonames.org/export/dump/cities500.zip into
   `data/raw/geonames/`). Run it before 5b: the trail tiles carry a remoteness level per stretch, the strongest
   town glow reaching it (strength from population on a log scale, reach growing with the cube root of population).
5b. `node pipeline/build-rivers.mjs` builds `public/rivers/`, the centreline tiles behind the "River Trails" toggle.
5c. River info: download RiverATLAS (https://www.hydrosheds.org/hydroatlas, shapefile version) and extract
   `RiverATLAS_v10_sa_north.dbf` and `RiverATLAS_v10_sa_south.dbf` into `data/raw/riveratlas/`, then
   `node pipeline/build-riverinfo.mjs` writes `public/riverinfo.json` (one record per named river: length to
   its confluence, distance to the sea, elevations, modelled discharge, flooding, population; water type from
   `pipeline/water-types.mjs`). The first run scans the 2 GB tables once and caches the basin's records.
6. `node pipeline/build-outline.mjs` builds the coastline from Natural Earth 1:10m countries
   (`data/raw/ne_10m_admin_0_countries.geojson`, from github.com/nvkelso/natural-earth-vector).

### Fonts

Labels are set in Liberation Sans (SIL Open Font License), the metric-compatible twin of Arial.
MapLibre needs fonts pre-rasterised into glyph files; `pipeline/build-glyphs.mjs` makes them from
any TrueType file:

```bash
node pipeline/build-glyphs.mjs path/to/Font.ttf "Font Name Regular"
```

then set `text-font` in `src/main.ts` to the stack name. Arial itself is not redistributable, so
Arial glyphs are git-ignored; generate them locally if you want the real thing.

## Deploying

Pushes to `main` build the site and publish it to GitHub Pages via `.github/workflows/pages.yml`
(the repo's Pages source must be set to "GitHub Actions"). The site lives at https://amazonbasinexplorer.com:
`public/CNAME` carries the domain into every build, and the domain is set under the repo's Pages settings
(DNS: four A records to GitHub Pages' addresses and a www CNAME to eduzmautner.github.io).

## Visitor statistics

The page loads [GoatCounter](https://www.goatcounter.com)'s counting script (see the end of `index.html`): page views, countries,
referrers and screen sizes, with no cookies and nothing personal stored, so no consent banner is needed.
It does not count visits on localhost. The dashboard is at https://eduzmautner.goatcounter.com.
Fork this project? Remove that script tag or point it at your own GoatCounter code.

## Credits

Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community. River network:
HydroRIVERS v1.0 (Lehner & Grill 2013, CC BY 4.0). River attributes: HydroATLAS / RiverATLAS v1.0 (Linke
et al. 2019, CC BY 4.0). Names © OpenStreetMap contributors (ODbL) and Agência Nacional de Águas e Saneamento Básico (ANA),
Base Hidrográfica Ottocodificada 2017. Towns from GeoNames (CC BY 4.0).
Coastline: Natural Earth (public domain). Open Sans glyphs via fonts.openmaptiles.org.
