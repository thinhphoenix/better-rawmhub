import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const templateSrc = read('src/template.html');
const css = read('src/styles.css');
const hid = read('src/hid.js');
const app = read('src/app.js');
const antLib = read('assets/ant.js');
const antControls = read('src/ant-controls.js');
const catalogue = JSON.parse(read('src/catalogue.json'));

const mime = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const dataUri = (path) => {
  const buf = readFileSync(resolve(root, path));
  return `data:${mime[extname(path)] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
};

// Inline downloaded product renders; devices without a render use the SVG
// placeholder in the UI.
for (const d of catalogue) {
  if (d.product_image) {
    try { d.product_image = dataUri(d.product_image); } catch { delete d.product_image; }
  }
}

const logo = dataUri('assets/rawm-hub.png');
const template = templateSrc.split('assets/rawm-hub.png').join(logo);

const json = JSON.stringify(catalogue).replace(/<\//g, '<\\/');
const out = template
  .replace('__CSS__', () => css.trim())
  .replace('__CATALOGUE__', () => json)
  .replace('__ANT_LIB__', () => antLib)
  .replace('__HID__', () => hid.trim())
  .replace('__APP__', () => app.trim())
  .replace('__ANT_CONTROLS__', () => antControls.trim());

writeFileSync(resolve(root, 'index.html'), out);

// Cloudflare Pages output: one self-contained file + security headers.
const publicDir = resolve(root, 'public');
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
writeFileSync(resolve(publicDir, 'index.html'), out);

console.log(`built index.html · ${(out.length / 1024).toFixed(1)} kB · ${catalogue.length} devices`);
console.log('built public/index.html (Cloudflare Pages)');
