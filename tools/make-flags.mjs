import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const W = 40;
const H = 27;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function draw(file, colours, direction) {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const band = direction === 'v' ? Math.min(2, Math.floor((x * 3) / W)) : Math.min(2, Math.floor((y * 3) / H));
      const [r, g, b] = hex(colours[band]);
      const i = (W * y + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  writeFileSync(file, PNG.sync.write(png));
  console.log('wrote', file);
}

draw('assets/flags/de.png', ['#000000', '#dd0000', '#ffce00'], 'h');
draw('assets/flags/fr.png', ['#0055a4', '#ffffff', '#ef4135'], 'v');
draw('assets/flags/ru.png', ['#ffffff', '#0039a6', '#d52b1e'], 'h');
