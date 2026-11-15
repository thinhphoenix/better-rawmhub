/* Drift — a slow ASCII character field painted behind the shell.
   Look ported from the "drift" preset in asciify-engine (MIT): broad noise
   lobes of glyphs that fade in and out, with a short trail so the field reads
   as moving sideways rather than blinking. Canvas 2D, no dependencies.
   The field is decorative: aria-hidden, pointer-events none, and it stops
   animating when the tab is hidden or motion is reduced. */
(() => {
  if (document.getElementById('ascii-bg')) return;

  const CELL = 13;            // CSS px per glyph cell
  const SPEED = 0.05;         // noise units per second (very slow lobes)
  const FPS = 24;
  const CHARS = ' .:-=+*#';
  const INK = '150, 157, 168'; // graphite, same family as the UI muted text
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

  const canvas = document.createElement('canvas');
  canvas.id = 'ascii-bg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);

  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let dpr = 1;
  let cols = 0;
  let rows = 0;
  let field = new Float32Array(1);
  let gridCols = 0;
  let gridRows = 0;
  let frame = 0;
  let lastDraw = 0;

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
    return (vnoise(x, y) * 0.62 + vnoise(x * 2.1, y * 2.1) * 0.38); // -1..1
  }

  /* ── Layout ────────────────────────────────────────────────────────── */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'top';
    ctx.font = `500 ${CELL - 1}px ${MONO}`;

    cols = Math.ceil(w / CELL) + 1;
    rows = Math.ceil(h / CELL) + 1;
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
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fillRect(0, 0, cols * CELL, rows * CELL);
      ctx.globalCompositeOperation = 'source-over';
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const v = sample(col / 2, row / 2);
        // Band the tone: below the threshold the cell stays empty, which is
        // what keeps the field airy instead of turning the page grey.
        const tone = (v - 0.45) / 0.26;
        if (tone <= 0.03) continue;
        const level = Math.min(CHARS.length - 1, 1 + Math.floor(tone * (CHARS.length - 1)));
        const ch = CHARS[level];
        if (ch === ' ') continue;
        const alpha = 0.16 + Math.min(tone, 1) * 0.38;
        ctx.fillStyle = `rgba(${INK}, ${alpha.toFixed(3)})`;
        ctx.fillText(ch, col * CELL, row * CELL);
      }
    }
  }

  /* ── Loop ──────────────────────────────────────────────────────────── */
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (now - lastDraw < 1000 / FPS) return;
    lastDraw = now;
    draw(now / 1000, false);
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
