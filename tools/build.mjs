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
const pkg = JSON.parse(read('package.json'));

// Phosphor icons, emitted as a <symbol> sprite so the existing icon() helper
// keeps working without any layout changes.
const iconMap = {
  mouse: 'mouse',
  grid: 'grid-four',
  sliders: 'sliders-horizontal',
  bulb: 'lightbulb',
  keys: 'keyboard',
  bolt: 'lightning',
  chip: 'cpu',
  download: 'download-simple',
  battery: 'battery-medium',
  link: 'link-simple',
  plus: 'plus',
  minus: 'minus',
  check: 'check',
  x: 'x',
  chevron: 'caret-right',
  arrow: 'arrow-right',
  refresh: 'arrows-clockwise',
  trash: 'trash',
  copy: 'copy',
  wave: 'wave-sine',
  monitor: 'monitor',
  info: 'info',
  alert: 'warning',
  terminal: 'terminal-window',
  globe: 'globe',
  play: 'play',
  record: 'record',
};
let iconSprite = '';
for (const [id, name] of Object.entries(iconMap)) {
  const svg = read(`node_modules/@phosphor-icons/core/assets/regular/${name}.svg`);
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');
  iconSprite += `<symbol id="i-${id}" viewBox="0 0 256 256">${inner}</symbol>`;
}

const mime = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
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
const favicon = dataUri('assets/favicon.ico');
const template = templateSrc
  .split('assets/rawm-hub.png').join(logo)
  .split('assets/favicon.ico').join(favicon)
  .split('__VERSION__').join(pkg.version);

const json = JSON.stringify(catalogue).replace(/<\//g, '<\\/');
const out = template
  .replace('__CSS__', () => css.trim())
  .replace('__CATALOGUE__', () => json)
  .replace('__ICON_SPRITE__', () => iconSprite)
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
