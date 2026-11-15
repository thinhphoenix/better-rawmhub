import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
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
const i18n = read('src/i18n.js');
const localeDir = resolve(root, 'src/locales');
const locales = {};
for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json'))) {
  locales[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(resolve(localeDir, file), 'utf8'));
}
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
// Icons that read better without the 20%-opacity fill: pulled from the regular
// (outline) set instead of duotone.
const OUTLINE_ICONS = new Set(['chevron', 'arrow', 'x']);
for (const [id, name] of Object.entries(iconMap)) {
  const svg = OUTLINE_ICONS.has(id)
    ? read(`node_modules/@phosphor-icons/core/assets/regular/${name}.svg`)
    : read(`node_modules/@phosphor-icons/core/assets/duotone/${name}-duotone.svg`);
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');
  iconSprite += `<symbol id="i-${id}" viewBox="0 0 256 256">${inner}</symbol>`;
}

const mime = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const dataUri = (path) => {
  const buf = readFileSync(resolve(root, path));
  return `data:${mime[extname(path)] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
};

// The only render kept on disk: shown instantly while the vendor hub's
// per-device renders download, and when one fails to load. It is reserved, so
// the variant scan below does not inline it a second time.
const placeholderFile = '234a-black.png';
const placeholderImg = dataUri(`assets/products/${placeholderFile}`);

// Discover colour variants from the files on disk instead of hardcoding them.
// tools/fetch-products.mjs --all downloads every model into assets/products as
// <product_id>-<model>.png.
const productDir = resolve(root, 'assets/products');
const productFiles = readdirSync(productDir).filter((f) => f.toLowerCase().endsWith('.png') && f !== placeholderFile);
for (const d of catalogue) {
  const pid = String(d.product_id || '').toLowerCase();
  const variants = {};
  for (const f of productFiles) {
    const m = f.match(new RegExp(`^${pid}-(.+)\\.png$`, 'i'));
    if (m) variants[m[1].toLowerCase()] = `assets/products/${f}`;
  }
  const entries = Object.entries(variants);
  if (!entries.length) continue;
  const current = String(d.product_image || '').match(/-([^.]+)\.png$/i);
  const preferred = current && variants[current[1].toLowerCase()];
  d.product_image = preferred || variants.black || entries[0][1];
  if (entries.length > 1) d.product_images = variants;
}

// Inline downloaded product renders; everything else loads from the vendor
// hub at runtime, with the inlined placeholder shown while it downloads.
for (const d of catalogue) {
  if (d.product_image) {
    if (d.product_image === `assets/products/${placeholderFile}`) delete d.product_image;
    else {
      try { d.product_image = dataUri(d.product_image); } catch { delete d.product_image; }
    }
  }
  if (d.product_images && typeof d.product_images === 'object') {
    for (const colour of Object.keys(d.product_images)) {
      try { d.product_images[colour] = dataUri(d.product_images[colour]); } catch { delete d.product_images[colour]; }
    }
    if (!Object.keys(d.product_images).length) delete d.product_images;
  }
}

const logo = dataUri('assets/rawm-hub.png');
const favicon = dataUri('assets/favicon.ico');
const flags = {};
for (const lang of ['en', 'vi', 'zh', 'ja', 'th', 'ko', 'es', 'fr', 'de', 'ru']) {
  try { flags[lang] = dataUri(`assets/flags/${lang}.png`); } catch { /* optional */ }
}
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
  .replace('__I18N__', () => i18n.trim().replace('__LOCALES__', () => JSON.stringify(locales)))
  .replace('__APP__', () => app.trim().split('__PLACEHOLDER_IMG__').join(placeholderImg))
  .replace('__ANT_CONTROLS__', () => antControls.trim().replace('__FLAGS__', () => JSON.stringify(flags)));

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

// Search Console HTML-file verification: keep any google*.html at repo root
// in the deployed output.
const verificationFiles = readdirSync(root).filter((f) => /^google[0-9a-f]+\.html$/i.test(f));
for (const f of verificationFiles) copyFileSync(resolve(root, f), resolve(publicDir, f));

console.log(`built index.html · ${(out.length / 1024).toFixed(1)} kB · ${catalogue.length} devices`);
console.log('built public/index.html (Cloudflare Pages)');
console.log('built public/robots.txt, public/sitemap.xml, public/og-image.png');
if (verificationFiles.length) console.log(`copied ${verificationFiles.join(', ')}`);
