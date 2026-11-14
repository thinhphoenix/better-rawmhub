/* Recolour the cyan RAWM bolt to the UI accent blue (#3b82f6). */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const file = 'assets/rawm-hub.png';
const png = PNG.sync.read(readFileSync(file));
let changed = 0;
for (let i = 0; i < png.data.length; i += 4) {
  const r = png.data[i];
  const g = png.data[i + 1];
  const b = png.data[i + 2];
  const a = png.data[i + 3];
  // Cyan-ish pixels only; white/gray text and transparent pixels are untouched.
  if (a > 0 && r < 120 && g > 150 && b > 150) {
    png.data[i] = 0x3b;
    png.data[i + 1] = 0x82;
    png.data[i + 2] = 0xf6;
    changed++;
  }
}
writeFileSync(file, PNG.sync.write(png));
console.log(`recoloured ${changed} pixels → #3b82f6`);
