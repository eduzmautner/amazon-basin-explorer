// Builds MapLibre glyph files (signed-distance-field PBFs, 256 code points per file) from a local
// TrueType font, so the map can label rivers in a typeface no public glyph server carries.
// Usage: node pipeline/build-glyphs.mjs "C:/Windows/Fonts/arial.ttf" "Arial Regular"
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import TinySDF from '@mapbox/tiny-sdf';
import Pbf from 'pbf';

const [fontPath, stackName] = process.argv.slice(2);
if (!fontPath || !stackName) { console.error('usage: build-glyphs.mjs <font.ttf> "<Font stack name>"'); process.exit(1); }
const RANGES = [[0, 255], [256, 511], [512, 767], [768, 1023], [7680, 7935], [8192, 8447]];
const OUT = path.join('public/fonts', stackName);

// TinySDF expects a DOM canvas; hand it the Node one
const family = GlobalFonts.registerFromPath(fontPath, 'GlyphSource') ? 'GlyphSource' : path.parse(fontPath).name;
globalThis.document = { createElement: () => createCanvas(1, 1) };

// Same rasterisation the reference tool (fontnik) uses: 24 px, 3 px buffer, 8 px SDF radius
const sdf = new TinySDF({ fontSize: 24, buffer: 3, radius: 8, cutoff: 0.25, fontFamily: family, fontWeight: 'normal' });

function writeGlyph(g, pbf) {
  pbf.writeVarintField(1, g.id);
  if (g.bitmap) pbf.writeBytesField(2, g.bitmap);
  pbf.writeVarintField(3, g.width);
  pbf.writeVarintField(4, g.height);
  pbf.writeSVarintField(5, g.left);
  pbf.writeSVarintField(6, g.top);
  pbf.writeVarintField(7, g.advance);
}
function writeStack(s, pbf) {
  pbf.writeStringField(1, s.name);
  pbf.writeStringField(2, s.range);
  for (const g of s.glyphs) pbf.writeMessage(3, writeGlyph, g);
}

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [a, b] of RANGES) {
  const glyphs = [];
  for (let id = a; id <= b; id++) {
    if (id < 32 || (id >= 127 && id < 160)) continue; // control characters
    const ch = String.fromCodePoint(id);
    const r = sdf.draw(ch);
    const w = r.glyphWidth, h = r.glyphHeight;
    // metrics follow MapLibre's own TinySDF-to-glyph mapping: top is relative to a 27 px line
    glyphs.push({
      id, width: w, height: h, left: r.glyphLeft, top: Math.round(r.glyphTop) - 27, advance: Math.round(r.glyphAdvance),
      bitmap: w > 0 && h > 0 ? Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength) : undefined,
    });
  }
  const pbf = new Pbf();
  pbf.writeMessage(1, writeStack, { name: stackName, range: `${a}-${b}`, glyphs });
  fs.writeFileSync(path.join(OUT, `${a}-${b}.pbf`), pbf.finish());
  total += glyphs.length;
}
console.log(`wrote ${total} glyphs for "${stackName}" to ${OUT}/`);
