/* Download product renders from the vendor's product API.
   By default only the first model per device is saved; pass --all to fetch
   every colour in the catalogue's `models` array. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'src/catalogue.json');
const catalogue = JSON.parse(readFileSync(file, 'utf8'));
const dir = resolve(root, 'assets/products');
const all = process.argv.includes('--all');
mkdirSync(dir, { recursive: true });

let saved = 0;
for (const d of catalogue) {
  if (!d.mouse || d.keyboard) continue;
  const models = Array.isArray(d.models) && d.models.length ? d.models : ['black'];
  let first = null;
  for (const model of models) {
    const url = `https://hub.miracletek.net/hub/product/${d.product_id}/${model}/connected.png`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const name = `${d.product_id}-${model}.png`;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(resolve(dir, name), buf);
    if (!first) first = `assets/products/${name}`;
    saved++;
    console.log(`${name} ${(buf.length / 1024).toFixed(1)} kB`);
    if (!all) break;
  }
  if (first) d.product_image = first;
}

writeFileSync(file, JSON.stringify(catalogue));
console.log(`saved ${saved} product renders`);
