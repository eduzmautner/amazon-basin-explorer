// Favicon from the basin silhouette: white shape on a black square, as SVG plus PNG fallbacks.
import fs from 'node:fs';
import { createCanvas, Path2D } from '@napi-rs/canvas';

const src = fs.readFileSync('public/basin.svg', 'utf8');
const d = /d="([^"]*)"/.exec(src)[1];
const [, vw, vh] = /viewBox="0 0 (\d+) (\d+)"/.exec(src).map(Number);
const SIZE = 64, PAD = 5; // design units: a 64-unit square with 5 units of breathing room
const s = Math.min((SIZE - 2 * PAD) / vw, (SIZE - 2 * PAD) / vh);
const tx = (SIZE - vw * s) / 2, ty = (SIZE - vh * s) / 2;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="#000"/>
  <path fill="#fff" transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(4)})" d="${d}"/>
</svg>
`;
fs.writeFileSync('public/favicon.svg', svg);
for (const [px, file] of [[32, 'favicon-32.png'], [180, 'apple-touch-icon.png'], [512, 'icon-512.png']]) {
  const c = createCanvas(px, px);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, px, px);
  ctx.scale(px / SIZE, px / SIZE); ctx.translate(tx, ty); ctx.scale(s, s);
  ctx.fillStyle = '#fff'; ctx.fill(new Path2D(d), 'evenodd');
  fs.writeFileSync('public/' + file, c.toBuffer('image/png'));
}
console.log('wrote public/favicon.svg, favicon-32.png, apple-touch-icon.png, icon-512.png');
