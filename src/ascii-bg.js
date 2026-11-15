/* Drift — a slow ASCII character field painted behind the shell.
   Look ported from the "drift" preset in asciify-engine (MIT): broad noise
   lobes of glyphs that fade in and out, with a short trail so the field reads
   as moving sideways rather than blinking.

   Cost control: every glyph is pre-rendered once into a small sprite atlas
   (7 characters × 6 alpha steps) and blitted with drawImage, so the frame loop
   never shapes text. The backing canvas stays at 1 device pixel per CSS pixel,
   the field draws at 15 fps and pauses with the tab. */
(() => {
  if (document.getElementById('ascii-bg')) return;

  const CELL = 16;            // CSS px per glyph cell
  const SPEED = 0.05;         // noise units per second (very slow lobes)
  const FPS = 12;             // base rate; a slow field reads fine at 12
  const BUDGET = 8;           // draw may use at most 1/8 of the frame budget
  const CHARS = ' .:-=+*#';
  const INK = '150, 157, 168'; // graphite, same family as the UI muted text
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const BASE_ALPHA = 0.16;
  const ALPHA_RANGE = 0.38;
  const STEPS = 6;

  const canvas = document.createElement('canvas');
  canvas.id = 'ascii-bg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);

  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let cols = 0;
  let rows = 0;
  let width = 0;
  let height = 0;
  let cell = CELL;
  let field = new Float32Array(1);
  let gridCols = 0;
  let gridRows = 0;
  let frame = 0;
  let lastDraw = 0;
  let cost = 0;               // rolling cost of one draw, in ms

  /* ── Glyph sprites ─────────────────────────────────────────────────── */
  const sprites = [];
  function buildSprites() {
    for (let level = 1; level < CHARS.length; level++) {
      sprites[level] = [];
      for (let step = 0; step < STEPS; step++) {
        const sprite = document.createElement('canvas');
        sprite.width = cell;
        sprite.height = cell;
        const g = sprite.getContext('2d');
        g.textBaseline = 'top';
        g.font = `500 ${cell - 3}px ${MONO}`;
        g.fillStyle = `rgba(${INK}, ${(BASE_ALPHA + (ALPHA_RANGE * (step + 0.5)) / STEPS).toFixed(3)})`;
        g.fillText(CHARS[level], 0, 0);
        sprites[level][step] = sprite;
      }
    }
  }
  buildSprites();

  /* ── Value noise (2 octaves) ───────────────────────────────────────── */
  function hash2(ix, iy) {
    let n = ix * 127 + iy * 311;
    n = (n >> 13) ^ n;
    return (((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  }

  function vnoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  }

  function fbm(x, y) {
    return vnoise(x, y) * 0.62 + vnoise(x * 2.1, y * 2.1) * 0.38; // -1..1
  }

  /* ── Layout ────────────────────────────────────────────────────────── */
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Cap the backing store: on a 4K panel the field renders at ~0.5x and the
    // browser scales it up. It is a soft background, so the blur never shows.
    const scale = Math.min(1, Math.sqrt(2_300_000 / (w * h)));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // Keep the number of glyphs roughly constant across screens: bigger
    // viewports get bigger glyphs instead of more of them.
    const next = Math.min(26, Math.max(CELL, Math.round(CELL * Math.sqrt((w * h) / (1440 * 950)))));
    if (next !== cell) {
      cell = next;
      buildSprites();
    }

    cols = Math.ceil(w / cell) + 1;
    rows = Math.ceil(h / cell) + 1;
    width = w;
    height = h;
    // Sample the noise on a coarser grid and interpolate: 4x fewer noise calls.
    gridCols = Math.ceil(cols / 2) + 1;
    gridRows = Math.ceil(rows / 2) + 1;
    field = new Float32Array(gridCols * gridRows);
    ctx.clearRect(0, 0, w, h);
    draw(0, true);
  }

  function sample(gx, gy) {
    const x = Math.min(gx, gridCols - 1.001);
    const y = Math.min(gy, gridRows - 1.001);
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * gridCols + x0;
    const a = field[i];
    const b = field[i + 1];
    const c = field[i + gridCols];
    const d = field[i + gridCols + 1];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  /* ── Paint ─────────────────────────────────────────────────────────── */
  function draw(time, hard) {
    const t = time * SPEED;

    for (let gy = 0; gy < gridRows; gy++) {
      for (let gx = 0; gx < gridCols; gx++) {
        const nx = gx * 0.5 * 0.2 + t;
        const ny = gy * 0.5 * 0.2 + Math.sin(t * 0.35) * 0.16;
        field[gy * gridCols + gx] = fbm(nx, ny) * 0.5 + 0.5; // 0..1
      }
    }

    if (!hard) {
      // Trail: erase a little of the previous frame so glyphs fade instead of
      // jumping. destination-out keeps the transparent page background intact.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const v = sample(col / 2, row / 2);
        // Band the tone: below the threshold the cell stays empty, which is
        // what keeps the field airy instead of turning the page grey.
        const tone = (v - 0.45) / 0.26;
        if (tone <= 0.08) continue;
        const level = Math.min(CHARS.length - 1, 1 + Math.floor(tone * (CHARS.length - 1)));
        const step = Math.min(STEPS - 1, Math.floor(Math.min(tone, 1) * STEPS));
        ctx.drawImage(sprites[level][step], col * cell, row * cell);
      }
    }
  }

  /* ── Loop ──────────────────────────────────────────────────────────── */
  function tick(now) {
    frame = requestAnimationFrame(tick);
    // Spend at most 1/BUDGET of the time drawing, so a slow machine gets a
    // slower field rather than a laggy app.
    const interval = Math.max(1000 / FPS, cost * BUDGET);
    if (now - lastDraw < interval) return;
    lastDraw = now;
    const started = performance.now();
    draw(now / 1000, false);
    const spent = performance.now() - started;
    cost = cost ? cost * 0.7 + spent * 0.3 : spent;
  }

  function start() {
    if (frame || reduced.matches) return;
    frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  if (typeof reduced.addEventListener === 'function') {
    reduced.addEventListener('change', () => (reduced.matches ? stop() : start()));
  }

  resize();
  start();
})();
