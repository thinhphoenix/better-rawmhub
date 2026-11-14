import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const SITE_URL = 'https://better-rawmhub.chila.io.vn';
const googleVerification = (process.env.GOOGLE_SITE_VERIFICATION || '').trim();
const verificationTag = googleVerification
  ? `<meta name="google-site-verification" content="${googleVerification}" />`
  : '';
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
  star: 'star',
  github: 'github-logo',
  bug: 'bug',
  external: 'arrow-square-out',
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
  .split('__SITE_URL__').join(SITE_URL)
  .split('__GOOGLE_VERIFICATION__').join(verificationTag)
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

// Search-engine files: robots.txt, sitemap.xml and a social preview image.
const today = new Date().toISOString().slice(0, 10);
writeFileSync(resolve(publicDir, 'robots.txt'), [
  'User-agent: *',
  'Allow: /',
  '',
  `Sitemap: ${SITE_URL}/sitemap.xml`,
  '',
].join('\n'));

writeFileSync(resolve(publicDir, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '  <url>',
  `    <loc>${SITE_URL}/</loc>`,
  `    <lastmod>${today}</lastmod>`,
  '    <changefreq>weekly</changefreq>',
  '    <priority>1.0</priority>',
  '  </url>',
  '</urlset>',
  '',
].join('\n'));

try {
  copyFileSync(resolve(root, 'shots/device.png'), resolve(publicDir, 'og-image.png'));
} catch {
  // Screenshot is optional; the meta tag still points at the expected path.
}

console.log(`built index.html · ${(out.length / 1024).toFixed(1)} kB · ${catalogue.length} devices`);
console.log('built public/index.html (Cloudflare Pages)');
console.log('built public/robots.txt, public/sitemap.xml, public/og-image.png');
