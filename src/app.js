/* ─────────────────────────────────────────────────────────────────────
   RAWM HUB — application UI
   ───────────────────────────────────────────────────────────────────── */
(() => {
  'use strict';

  const CATALOGUE = JSON.parse(document.getElementById('catalogue').textContent);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

  /* Battery gauge: five cells filled to the real level, tinted by state.
     Rendered inline (not from the sprite) so the cells can carry the level. */
  const BATT_CELLS = 5;
  const batteryTone = (pct) =>
    pct == null ? 'var(--faint)' : pct <= 20 ? 'var(--danger)' : pct <= 50 ? 'var(--warn)' : 'var(--ok)';

  function batteryIcon(pct, size = 16) {
    const known = pct != null && Number.isFinite(Number(pct));
    const value = known ? clamp(Number(pct), 0, 100) : 0;
    const filled = known ? Math.ceil((value / 100) * BATT_CELLS) : 0;
    const tone = batteryTone(known ? value : null);
    let cells = '';
    for (let i = 0; i < BATT_CELLS; i++) {
      cells += `<rect x="${(3.42 + i * 2.44).toFixed(2)}" y="3.6" width="2.2" height="4.8" rx="0.8" fill="${i < filled ? tone : 'rgba(255,255,255,.08)'}"/>`;
    }
    const h = (size * 12) / 22;
    return `<svg class="batt" viewBox="0 0 22 12" width="${size}" height="${h.toFixed(2)}" aria-hidden="true">
      <rect x="1" y="1.6" width="16.6" height="8.8" rx="2.2" fill="none" stroke="currentColor" stroke-opacity=".38" stroke-width="1.2"/>
      <rect x="18.6" y="4.3" width="2.2" height="3.4" rx="1" fill="currentColor" fill-opacity=".38"/>
      ${cells}
    </svg>`;
  }

  /* Slot so updateLive() can repaint the gauge when the level changes. */
  const batterySlot = (pct, size = 14) =>
    `<span class="batt-slot" data-batt-icon data-batt-size="${size}">${batteryIcon(pct, size)}</span>`;

  /* Devices ------------------------------------------------------------ */
  const devices = [];
  const seen = new Set();
  for (const d of CATALOGUE) {
    const key = `${d.product_id}-${d.display_name || d.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawTitle = d.display_name || d.name || 'RAWM device';
    const title = /[^\x00-\x7F]/.test(rawTitle) ? (d.name || d.alias || rawTitle) : rawTitle;
    const kind = d.receiver ? 'receiver' : d.keyboard ? 'keyboard' : 'mouse';
    const models = Array.isArray(d.models) ? d.models.filter(Boolean) : [];
    const model = models[0] || null;
    const renderUrl = (colour) => `https://hub.miracletek.net/hub/product/${d.product_id}/${colour}/connected.png`;
    const product = d.product_image || (kind === 'mouse' && model ? renderUrl(model) : '');
    const images = {};
    // Colour variants load from the vendor hub; an inlined local render (when
    // one ships in assets/products) wins over the remote URL.
    if (kind === 'mouse') for (const colour of models) images[colour] = renderUrl(colour);
    if (d.product_images && typeof d.product_images === 'object') {
      for (const [colour, src] of Object.entries(d.product_images)) if (src) images[colour] = src;
    }
    if (product) images[model || 'default'] = product;
    const defaultColor = Object.keys(images).find((c) => images[c] === product) || model || Object.keys(images)[0] || null;
    devices.push({
      ...d,
      key: d.product_id + ':' + rawTitle,
      title,
      image: product,
      images,
      defaultColor,
      kind,
    });
  }
  const byProduct = (id) => devices.find((d) => String(d.product_id).toLowerCase() === String(id).toLowerCase());

  // Colour variant chosen per product id; remembered locally only.
  const COLOR_KEY = 'rawmhub.deviceColour';
  let colourPrefs = {};
  try { colourPrefs = JSON.parse(localStorage.getItem(COLOR_KEY) || '{}') || {}; } catch { colourPrefs = {}; }

  function colorOptions(p) {
    return p && p.images ? Object.keys(p.images).filter((c) => c !== 'default') : [];
  }
  function activeColor(p) {
    const pref = p && colourPrefs[p.product_id];
    if (pref && p.images && p.images[pref]) return pref;
    return (p && p.defaultColor) || '';
  }
  function productImage(p) {
    if (!p) return '';
    const pref = colourPrefs[p.product_id];
    if (pref && p.images && p.images[pref]) return p.images[pref];
    return p.image;
  }
  function setProductColor(p, colour) {
    if (!p || !p.images || !p.images[colour]) return;
    colourPrefs[p.product_id] = colour;
    try { localStorage.setItem(COLOR_KEY, JSON.stringify(colourPrefs)); } catch { /* ignore */ }
    const src = productImage(p);
    $$('img.device-render').forEach((el) => {
      el.classList.remove('is-loaded');
      el.onerror = () => { el.onerror = null; el.src = PLACEHOLDER_IMG; };
      el.src = src;
    });
    $$('[data-action="device-color"]').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.color === colour);
    });
  }

  /* State ------------------------------------------------------------- */
  const state = {
    page: 'device',
    connected: false,
    handshake: 'idle',
    profile: null,
    info: null,
    cfg: null,
    dirty: false,
    selectedKey: null,
    advTab: 'socd',
    macro: 0,
    capturing: false,
    log: [],
    logOpen: false,
    busy: false,
    fwSwitching: false,
    bridgeProblem: null,
  };

  const transport = new RAWM.Transport((dir, msg) => addLog(dir, msg));
  if (window.RAWM_BRIDGE) window.RAWM_BRIDGE.setLog((dir, msg) => addLog(dir, msg));

  const DEFAULTS = {
    cpiX: 1600, cpiY: 1600, xy: false,
    polling: 1000,
    xPolling: false,
    dpiLevels: [400, 800, 1600, 3200],
    activeLevel: 2,
    lightMode: 'loop',
    color: '#4be38a',
    brightness: 70,
    speed: 50,
    glassMode: false,
    lod: 0,
    angleTuning: 0,
    angleSnapping: false,
    rippleControl: false,
    motionSync: true,
    sleep: 10,
    powerMode: 2,
    wireless: { auto: true, mode: 3, powerSaving: true },
    keyDelayKey: 'M1',
    keyDelayMs: 3,
    onboard: 0,
    onboardMax: 5,
    allowSwitch: true,
    rplus: 'None',
    fwChannel: null,
    keyDelay: [8, 8, 8, 8, 8, 8, 8],
    levelColors: [1, 2, 6, 4, 0, 0, 0, 0],
    onboardStatus: [0x81, 0x82, 0x83, 0x84],
    keys: {},
    zones: [true, false, false],
    adv: {
      socd: { a: 'A', b: 'D' },
      mt: { key: 'Shift', tap: 'Space', hold: 'Ctrl', ms: 180 },
      rs: { a: 'A', b: 'D' },
      dks: { p1: 1, p2: 3.4, p3: 3.4, p4: 1 },
    },
    macros: [
      { name: 'Rapid fire', trigger: 'Hold', actions: [{ type: 'Key down', value: 'Mouse 1', delay: 0 }, { type: 'Delay', value: '', delay: 40 }, { type: 'Key up', value: 'Mouse 1', delay: 0 }] },
      { name: 'Jump + crouch', trigger: 'Toggle', actions: [{ type: 'Key down', value: 'Space', delay: 0 }, { type: 'Delay', value: '', delay: 80 }, { type: 'Key up', value: 'Space', delay: 0 }] },
      { name: 'Copy / paste', trigger: 'On press', actions: [{ type: 'Key down', value: 'Ctrl + C', delay: 0 }, { type: 'Key up', value: 'Ctrl + C', delay: 20 }] },
    ],
  };

  const LIGHT_PRESETS = [
    { name: 'Loop', mode: 'loop', cls: 'pv-breathe', byte: 0x48 },
    { name: 'Customize', mode: 'custom', cls: 'pv-static', byte: 0x08 },
    { name: 'DPI levels', mode: 'dpi', cls: 'pv-dpi', byte: 0x18 },
  ];
  const STAGE_COLORS = ['#4cc9f0', '#4be38a', '#ffd166', '#ff6b6b', '#b388ff', '#f2b25c', '#7aa7ff', '#ff9ff3'];
  const STAGE_COLOR = (i) => STAGE_COLORS[i % STAGE_COLORS.length];
  // The firmware only stores three colour bits (R/G/B).
  const LED_COLORS = [
    { hex: '#f5f7fa', bits: 7 },
    { hex: '#ff6b6b', bits: 4 },
    { hex: '#4be38a', bits: 2 },
    { hex: '#4cc9f0', bits: 1 },
    { hex: '#ffd166', bits: 6 },
    { hex: '#37e0d8', bits: 3 },
    { hex: '#b388ff', bits: 5 },
    { hex: '#1a1f24', bits: 0 },
  ];
  const COLORS = LED_COLORS.map((c) => c.hex);
  const colorForBits = (bits) => (LED_COLORS.find((c) => c.bits === (Number(bits) & 0x07)) || LED_COLORS[7]).hex;
  const stageBits = (i) => {
    const arr = state.cfg && state.cfg.levelColors;
    return Array.isArray(arr) && arr[i] != null ? Number(arr[i]) & 0x07 : null;
  };
  // DPI stages store their own LED colour on the device; show that instead of
  // an arbitrary palette so the UI matches the mouse.
  const stageColor = (i) => {
    const bits = stageBits(i);
    return bits == null ? STAGE_COLOR(i) : colorForBits(bits);
  };
  const MOUSE_FN = { M1: 'Left click', M2: 'Right click', M3: 'Middle click', M4: 'Back', M5: 'Forward', M6: 'DPI cycle', M7: 'Onboard profile' };
  const REPO_URL = 'https://github.com/thinhphoenix/better-rawmhub';
  /* Vendor pages: installers, firmware and the original web tool live here. */
  const VENDOR_HUB = 'https://www.rawmtech.com/hub3.html';
  const VENDOR_WEB = 'https://www.rawmtech.com/hub.html';
  const VENDOR_DOWNLOADS = 'https://www.rawmshop.com/pages/download-center';

  function issueLink(kind) {
    const version = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    const device = state.profile ? `${state.profile.title} (PID ${String(state.profile.product_id).toUpperCase()})` : 'No device connected';
    const browser = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (kind === 'feature') {
      const body = [
        '**What would you like to add or change?**', '', '', '',
        '**Why is it useful?**', '', '', '',
        '---',
        `App v${version}`,
        `Device: ${device}`,
      ].join('\n');
      return `${REPO_URL}/issues/new?title=${encodeURIComponent('[Feature] ')}&body=${encodeURIComponent(body)}`;
    }
    const body = [
      '**What happened?**', '', '', '',
      '**Steps to reproduce**', '1. ', '2. ', '3. ', '',
      '**Expected behaviour**', '', '', '',
      '**Device and app**',
      `- App: v${version}`,
      `- Device: ${device}`,
      `- Browser: ${browser}`,
      '',
      '**HID console log**',
      '<!-- Open the terminal button in the header, reproduce the problem, then paste the log here. -->', '',
    ].join('\n');
    return `${REPO_URL}/issues/new?title=${encodeURIComponent('[Bug] ')}&body=${encodeURIComponent(body)}`;
  }

  function colorBits(hex) {
    const exact = LED_COLORS.find((c) => c.hex.toLowerCase() === String(hex).toLowerCase());
    if (exact) return exact.bits;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
    if (!m) return 2;
    const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
    let best = 2;
    let bestDist = Infinity;
    for (const c of LED_COLORS) {
      if (!c.bits) continue;
      const cm = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.hex);
      const [cr, cg, cb] = cm.slice(1).map((x) => parseInt(x, 16));
      const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
      if (d < bestDist) { bestDist = d; best = c.bits; }
    }
    return best;
  }

  function decodeLight(byte) {
    const b = Number(byte) & 0xff;
    const mode = (b & 0x10) ? 'dpi' : (b & 0x40) ? 'loop' : 'custom';
    const bits = b & 0x07;
    const color = (LED_COLORS.find((c) => c.bits === bits) || LED_COLORS[7]).hex;
    return { mode, color, autoOff: !!(b & 0x20), raw: b };
  }

  /* Config ------------------------------------------------------------ */
  function makeConfig(p, info) {
    const levels = (p && p.cpi_levels ? p.cpi_levels.filter((n) => n > 0) : DEFAULTS.dpiLevels.slice());
    const polling = p && p.polling_rates && p.polling_rates.length
      ? (p.polling_rates.includes(1000) ? 1000 : p.polling_rates[p.polling_rates.length - 1])
      : DEFAULTS.polling;
    const cfg = {
      ...structuredClone(DEFAULTS),
      dpiLevels: levels.length ? levels : DEFAULTS.dpiLevels.slice(),
      polling,
      onboardMax: (info && info.onboardConfigNum) || 5,
      lightMode: 'loop',
    };
    cfg.cpiX = cfg.cpiY = cfg.dpiLevels[Math.min(2, cfg.dpiLevels.length - 1)];
    cfg.activeLevel = Math.min(2, cfg.dpiLevels.length - 1);
    if (Number.isFinite(p && p.lods ? p.lods.length : 0)) cfg.lod = 0;
    return cfg;
  }

  function mergeInfo(info) {
    if (!info || !state.cfg) return;
    const cfg = state.cfg;
    const rev = String(info.revision || info.r || '');
    if (cfg.fwChannel == null) cfg.fwChannel = rev.startsWith('G-') ? 1 : 0;
    const cpi = Number(info.cpi);
    if (Number.isFinite(cpi) && cpi > 0) {
      cfg.cpiX = cpi & 0xffff;
      cfg.cpiY = (cpi >>> 16) & 0xffff || cfg.cpiX;
      cfg.xy = cfg.cpiY !== cfg.cpiX;
      const stage = cfg.dpiLevels.findIndex((v) => Number(v) === cfg.cpiX);
      if (stage >= 0) cfg.activeLevel = stage;
    }
    // DPI stages and their LED colours: cpi_l / cpi_l_c in the query result.
    if (Array.isArray(info.cpi_l) && info.cpi_l.length) {
      const levels = info.cpi_l
        .map((n) => {
          const v = Number(n) || 0;
          return (v & 0xffff) || ((v >>> 16) & 0xffff);
        })
        .filter((n) => n > 0);
      if (levels.length) {
        cfg.dpiLevels = levels;
        const stage = levels.findIndex((v) => v === cfg.cpiX);
        cfg.activeLevel = stage >= 0 ? stage : Math.min(cfg.activeLevel, levels.length - 1);
      }
    }
    if (Array.isArray(info.cpi_l_c)) {
      const colors = info.cpi_l_c.map((n) => Number(n) & 0x07).slice(0, 8);
      while (colors.length < 8) colors.push(0);
      cfg.levelColors = colors;
    }
    // The query result calls it `polling`; older builds used `pr`.
    const polling = info.pr != null ? info.pr : info.polling;
    if (Number.isFinite(Number(polling)) && Number(polling) > 0) cfg.polling = Number(polling);
    if (info.lod != null) cfg.lod = Number(info.lod);
    if (info.st != null) cfg.sleep = Math.max(1, Math.round(Number(info.st) / 60) || 10);
    const lightVal = info.light != null ? info.light : info.l;
    if (lightVal != null) {
      const l = decodeLight(Number(lightVal));
      cfg.lightMode = l.mode;
      cfg.color = l.color;
      cfg.autoOff = l.autoOff;
      cfg.lightByteRaw = l.raw;
    }
    const bri = info.brightness != null ? info.brightness : info.bri;
    if (bri != null) cfg.brightness = Math.round((Number(bri) / 255) * 100);
    if (info.ms != null) cfg.motionSync = !!Number(info.ms);
    if (info.at != null) cfg.angleTuning = Number(info.at);
    if (info.as != null) cfg.angleSnapping = !!Number(info.as);
    if (info.rctrl != null) cfg.rippleControl = !!Number(info.rctrl);
    if (info.ob != null) cfg.onboard = Number(info.ob);
    if (info.cn != null) cfg.onboardMax = Number(info.cn) || cfg.onboardMax;
    cfg.glassMode = !!(info.gm && Number(info.gm));
  }

  function lightByte() {
    const preset = LIGHT_PRESETS.find((p) => p.mode === state.cfg.lightMode) || LIGHT_PRESETS[0];
    let b = preset.byte & ~0x07;
    b |= colorBits(state.cfg.color);
    if (state.cfg.autoOff) b |= 0x20;
    return b & 0xff;
  }

  /* Markup helpers ----------------------------------------------------- */
  // Inlined by the build: the one local render, used as the loading placeholder.
  const PLACEHOLDER_IMG = '__PLACEHOLDER_IMG__';
  document.documentElement.style.setProperty('--device-ph', `url("${PLACEHOLDER_IMG}")`);
  const img = (src, cls = '', alt = '') =>
    `<img class="${cls}" src="${esc(src || PLACEHOLDER_IMG)}" alt="${esc(alt)}" loading="lazy" onload="this.classList.add('is-loaded')" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'"/>`;

  function pctStyle(value, min, max) {
    const pct = ((Number(value) - min) / (max - min)) * 100;
    return `--pct:${clamp(pct, 0, 100)}%`;
  }

  function pageHead(eyebrow, title, sub, actions = '') {
    return `<div class="page-head">
      <div>
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h1>${title}</h1>
        ${sub ? `<p class="sub">${sub}</p>` : ''}
      </div>
      ${actions ? `<div class="head-actions">${actions}</div>` : ''}
    </div>`;
  }

  function toggleRow(title, desc, bind, checked) {
    return `<div class="setting-row">
      <div class="sr-main">
        <div class="sr-title">${esc(title)}</div>
        ${desc ? `<p class="sr-desc">${desc}</p>` : ''}
      </div>
      <div class="sr-side">
        <label class="switch">
          <input type="checkbox" data-bind="${bind}" data-kind="bool" ${checked ? 'checked' : ''} aria-label="${esc(title)}"/>
          <i></i>
        </label>
      </div>
    </div>`;
  }

  function rangeRow(label, bind, value, min, max, step, unit, outSuffix = unit) {
    const shown = Math.abs(Number(value)) >= 1000 ? fmt(value) : value;
    return `<div class="field">
      <div class="between">
        <span class="field-label">${esc(label)}</span>
        <output class="mono" data-out="${bind}" style="font-size:11px;color:var(--text)">${shown}${outSuffix}</output>
      </div>
      <input class="range" type="range" data-bind="${bind}" data-kind="int" min="${min}" max="${max}" step="${step}" value="${value}" style="${pctStyle(value, min, max)}"/>
      <div class="range-scale"><span>${min}${unit}</span><span>${max}${unit}</span></div>
    </div>`;
  }

  /* ── Connect / landing ─────────────────────────────────────────────── */
  function mouseMap(p, active) {
    const keys = (p.keys || []).slice().sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
    const pos = {
      M1: [33, 20], M2: [67, 20], M3: [50, 16], M4: [14, 41],
      M5: [14, 50], M6: [50, 47], M7: [50, 80], M8: [50, 90],
    };
    return `<div class="mouse-map">
      <div class="mouse-wrap">
        ${img(productImage(p), 'mouse-photo device-render', p.title)}
        ${keys.map((k) => {
          const pt = pos[k.name] || [50, 50];
          const side = ['M1', 'M4', 'M5'].includes(k.name) ? 'hs-left' : k.name === 'M2' ? 'hs-right' : k.name === 'M3' ? 'hs-top' : '';
          return `<button class="hotspot ${k.name === active ? 'is-active' : ''}"
                    style="left:${pt[0]}%;top:${pt[1]}%"
                    data-action="select-key" data-key="${esc(k.name)}"
                    aria-label="${esc(k.name)}">
                    <span class="hs-label ${side}">${esc(k.label || k.name)} ${esc(k.name)}</span>
                  </button>`;
        }).join('')}
      </div>
    </div>`;
  }

  /* ── Bridge panel (Firefox, Safari) ─────────────────────────────────── */

  const BRIDGE_RELEASES = 'https://github.com/thinhphoenix/better-rawmhub/releases/latest';

  function bridgePlatform() {
    const ua = navigator.userAgent || '';
    if (/Mac/i.test(ua)) return 'macOS';
    if (/Win/i.test(ua)) return 'Windows';
    return 'Linux';
  }

  function bridgePanel() {
    if (RAWM.Transport.backend !== 'bridge') return '';
    const problem = state.bridgeProblem;
    const port = (window.RAWM_BRIDGE && window.RAWM_BRIDGE.PORT) || 47311;
    const headline = problem === 'down'
      ? 'The bridge is not running.'
      : problem === 'pair'
        ? 'Pair this page with the bridge.'
        : 'This browser has no WebHID — install the bridge once.';
    return `
      <div class="notice${problem ? ' warn' : ''}" style="margin-top:14px">
        ${icon(problem ? 'alert' : 'info')}
        <div>
          <strong>${headline}</strong>
          <p class="help" style="margin-top:6px">Firefox and Safari reach the device through <span class="mono">better-rawmhub-bridge</span>, a small local daemon on <span class="mono">127.0.0.1:${port}</span>. Start it, then press Connect again. Nothing is installed inside the browser and no account is needed.</p>
          <div class="row wrap" style="margin-top:10px">
            <a class="btn btn-ghost btn-sm" href="${BRIDGE_RELEASES}" target="_blank" rel="noopener">${icon('download')}<span>Download for ${bridgePlatform()}</span></a>
            <button class="btn btn-ghost btn-sm" data-action="bridge-retry">${icon('refresh')}<span>Try again</span></button>
            ${problem === 'pair' ? `<button class="btn btn-primary btn-sm" data-action="bridge-pair-open">${icon('link')}<span>Enter code</span></button>` : ''}
            <button class="btn btn-ghost btn-sm" data-action="bridge-forget">${icon('x')}<span>Forget pairing</span></button>
          </div>
        </div>
      </div>`;
  }

  function connectView() {
    const support = RAWM.Transport.supported;
    const blocked = location.protocol === 'file:';
    const native = RAWM.Transport.native;
    const hero = byProduct('234a') || devices.find((d) => d.kind === 'mouse') || null;
    const counts = {
      mice: devices.filter((d) => d.kind === 'mouse').length,
      keyboards: devices.filter((d) => d.kind === 'keyboard').length,
    };
    return `
    ${pageHead('Browser configurator', 'Your gear, <span style="color:var(--accent)">dialed in</span>.',
      'Tune sensitivity, polling, lighting and key maps from the browser. Settings are written straight to the device — no account, no vendor software.',
      `<span class="pill">${counts.mice} mice · ${counts.keyboards} keyboards</span>`)}

    <div class="connect-solo">
      <section class="card connect-card">
        <div class="connect-stage">
          <div class="stage-tags"><span class="tag accent"><span class="dot on"></span>READY</span><span class="tag">${native ? 'WEBHID' : 'BRIDGE'}</span></div>
          ${img(hero ? productImage(hero) : '', 'device-render', hero ? hero.title : 'RAWM mouse')}
        </div>
        <div class="connect-copy">
          <h2>Connect your device</h2>
          <p>Turn the mouse on and switch to <strong style="color:var(--text);font-weight:500">2.4 GHz</strong>, or plug it in with a USB cable. Then press Connect — Chrome and Edge ask you to pick the device, the bridge picks the RAWM interface for you.</p>
          <div class="row wrap">
            <button class="btn btn-primary btn-lg" data-action="connect" ${support && !blocked ? '' : 'disabled'}>
              ${icon('link')}<span>Connect device</span>
            </button>
          </div>
          ${blocked ? `<div class="browser-note">${icon('alert')}<span>This page was opened from disk. Serve it over <span class="mono">http://localhost</span> or <span class="mono">https://</span> first.</span></div>` : ''}
          ${bridgePanel()}
          <div class="checklist">
            <div class="check-row"><span class="cr-n">1</span><span>Switch the device to <strong>2.4 GHz</strong>, or connect it with a USB cable.</span></div>
            <div class="check-row"><span class="cr-n">2</span><span>Choose the RAWM device${native ? " in the browser's device picker" : ' — the bridge lists them'}</span></div>
            <div class="check-row"><span class="cr-n">3</span><span>Wait for the handshake — the console logs every packet.</span></div>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* ── Device ────────────────────────────────────────────────────────── */
  function deviceView() {
    const p = state.profile;
    const c = state.cfg;
    const info = state.info || {};
    const battery = Number.isFinite(Number(info.battery)) ? Number(info.battery) : null;
    const charging = Number(info.chg ?? info.charging ?? 0) === 1;
    const onboardMax = c.onboardMax || 5;
    const connection = transport.isReceiver ? '2.4 GHz receiver' : 'USB cable';
    const levels = c.dpiLevels.length ? c.dpiLevels : [c.cpiX];
    const stateLabel = state.handshake === 'ready' ? 'CONNECTED' : state.handshake === 'timeout' ? 'NO REPLY' : 'CONNECTING';
    return `
    ${pageHead('Device overview', esc(p.title),
      `${esc(p.sensor || 'RAWM sensor')}${p.soc ? ' · ' + esc(p.soc) : ''} · ${esc(connection)}`,
      `<button class="btn btn-danger btn-sm" data-action="disconnect">Disconnect</button>`)}

    ${state.handshake !== 'ready' ? `<div class="notice warn" style="margin-bottom:14px">
      ${icon('alert')}
      <span><strong>${state.handshake === 'error' ? 'This HID interface cannot be written over WebHID.' : state.handshake === 'timeout' ? 'No reply from the device.' : 'Waiting for the device to answer.'}</strong>
      ${state.handshake === 'error' ? ' Pick another RAWM interface in the browser prompt, connect the mouse directly with a USB cable, or use the desktop app.' : state.handshake === 'timeout' ? ' Close RAWM HUB desktop if it is running, switch the device to 2.4 GHz or plug in the cable, then try again.' : ' The query was sent and usually answers in under a second.'}
      ${state.handshake === 'error' ? '' : '<button class="link-btn" data-action="handshake">Send query again</button>'}</span>
    </div>` : ''}

    <section class="card hero">
      <div class="hero-stage">
        <div class="rings"><i></i><i></i><i></i></div>
        <div class="stage-tags">
          <span class="tag accent"><span class="dot on"></span>${stateLabel}</span>
          ${battery != null ? `<span class="tag">${batterySlot(battery, 14)} <span data-live="battery-tag">${battery}%${charging ? ' · charging' : ''}</span></span>` : ''}
        </div>
        ${img(productImage(p), 'hero-img device-render', p.title)}
        <span class="stage-model">${esc(p.title)} ${p.sensor ? '· ' + esc(p.sensor) : ''}</span>
      </div>
      <div class="hero-panel">
        <div class="hero-id">
          <p class="eyebrow">${p.receiver ? 'Receiver' : p.keyboard ? 'Keyboard' : 'Mouse'}</p>
          <h2>${esc(p.title)}</h2>
          <div class="meta">
            <span class="tag mono">PID ${esc(String(p.product_id).toUpperCase())}</span>
            ${p.polling_rates ? `<span class="tag">${fmt(Math.max(...p.polling_rates))} HZ MAX</span>` : ''}
            ${p.lods ? `<span class="tag">${p.lods.length} LOD</span>` : ''}
          </div>
          ${colorOptions(p).length > 1 ? `
          <div class="variant-row">
            <span class="field-label">Colour</span>
            <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">
              ${colorOptions(p).map((colour) => `<button class="chip variant-chip ${colour === activeColor(p) ? 'is-active' : ''}" data-action="device-color" data-color="${esc(colour)}">${esc(colour.charAt(0).toUpperCase() + colour.slice(1))}</button>`).join('')}
            </div>
          </div>` : ''}
        </div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label"><span>Sensitivity</span>${icon('sliders')}</div>
            <div class="stat-value"><span data-live="cpiX">${fmt(c.cpiX)}</span><small>${c.xy ? '× ' + fmt(c.cpiY) + ' dpi' : 'dpi'}</small></div>
            <div class="stat-bar"><i data-bar="cpi" style="width:${clamp((c.cpiX / ((p.cpi_range && p.cpi_range[1]) || 30000)) * 100, 4, 100)}%"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Polling</span>${icon('wave')}</div>
            <div class="stat-value"><span data-live="polling">${fmt(c.polling)}</span><small>hz</small></div>
            <div class="stat-bar"><i data-bar="polling" style="width:${clamp((c.polling / 8000) * 100, 4, 100)}%"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Battery</span>${batterySlot(battery, 13)}</div>
            <div class="stat-value"><span data-live="battery">${battery != null ? battery : '—'}</span><small>${battery != null ? '%' + (charging ? ' · chg' : '') : 'wired'}</small></div>
            <div class="stat-bar"><i data-bar="battery" style="width:${battery != null ? battery : 0}%;${battery != null ? 'background:' + batteryTone(battery) : ''}"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Profile</span>${icon('chip')}</div>
            <div class="stat-value"><span data-live="profile">${(c.onboard | 0) + 1}</span><small>/ ${onboardMax}</small></div>
            <div class="stat-bar"><i data-bar="profile" style="width:${(((c.onboard | 0) + 1) / onboardMax) * 100}%"></i></div>
          </div>
        </div>
      </div>
    </section>

    <div class="grid g-3" style="margin-top:14px">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('sliders')}<div><h2>Sensitivity</h2><p>${c.dpiLevels.length} onboard stages</p></div></div></div>
        <div class="card-body">
          <div class="dpi-readout"><span class="num" data-live="cpiX">${fmt(c.cpiX)}</span><span class="unit">DPI</span></div>
          <div class="dpi-stages">
            ${levels.slice(0, 8).map((v, i) => `
              <button class="dpi-stage ${i === c.activeLevel ? 'is-active' : ''}" data-action="dpi-stage" data-index="${i}">
                <div class="ds-i"><span class="ds-dot" style="--c:${stageColor(i)}"></span>${String(i + 1).padStart(2, '0')}</div>
                <div class="ds-v">${fmt(v)}</div>
              </button>`).join('')}
          </div>
          <button class="link-btn" style="margin-top:12px" data-page="performance">Fine-tune stages ${icon('arrow')}</button>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('wave')}<div><h2>Polling rate</h2><p>Updates per second</p></div></div></div>
        <div class="card-body">
          <div class="dpi-readout"><span class="num" data-live="polling">${fmt(c.polling)}</span><span class="unit">HZ</span></div>
          <div class="seg-wrap" style="margin-top:14px;display:grid;grid-template-columns:repeat(4,1fr)">
            ${(p.polling_rates || [125, 250, 500, 1000]).map((r) => `<button class="chip ${r === c.polling ? 'is-active' : ''}" data-action="polling" data-value="${r}" style="justify-content:center">${fmt(r)}</button>`).join('')}
          </div>
          <p class="help" style="margin-top:12px">Restart the device after changing polling rate.</p>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('bulb')}<div><h2>Lighting</h2><p><span data-live="light-mode-name">${esc(LIGHT_PRESETS.find((l) => l.mode === c.lightMode)?.name || 'Breathe')}</span> · <span data-live="brightness">${c.brightness}</span>%</p></div></div></div>
        <div class="card-body">
          ${p.light ? `
          <div class="light-stage" style="min-height:118px;border-radius:9px;--glow:${esc(c.color)}">
            <div class="light-glow" style="position:absolute;inset:10px;border-radius:7px;background:radial-gradient(50% 80% at 50% 50%, ${esc(c.color)}33, transparent 70%)"></div>
            <div style="position:relative;z-index:1;font-family:var(--mono);font-size:10px;letter-spacing:.14em;color:${esc(c.color)}"><span data-live="light-mode-upper">${esc((LIGHT_PRESETS.find((l) => l.mode === c.lightMode)?.name || 'breathe').toUpperCase())}</span></div>
          </div>
          <button class="link-btn" style="margin-top:12px" data-page="lighting">Open lighting studio ${icon('arrow')}</button>
          ` : `<div class="empty" style="padding:22px 10px">${icon('bulb')}<p>No RGB lighting on this device.</p></div>`}
        </div>
      </section>
    </div>

    <div class="split split-even" style="margin-top:14px">
      <section class="card">
        <div class="card-head">
          <div class="ch-title">${icon('chip')}<div><h2>Onboard profiles</h2><p>Select the slot written by the device</p></div></div>
          <div class="row" style="gap:6px">
            <button class="btn btn-ghost btn-sm" data-action="factory-reset">${icon('refresh')}<span>Restore</span></button>
          </div>
        </div>
        <div class="card-body">
          <div class="profiles">
            ${Array.from({ length: onboardMax }).map((_, i) => `
              <button class="profile-tile ${i === (c.onboard | 0) ? 'is-active' : ''}" data-action="onboard" data-index="${i}">
                <div class="pt-i">SLOT ${String(i + 1).padStart(2, '0')}</div>
                <div class="pt-name">Profile ${i + 1}</div>
                <div class="pt-dot" style="--pc:${['#3b82f6', '#7aa7ff', '#ff6b6b', '#b388ff', '#f2b25c'][i % 5]}"></div>
              </button>`).join('')}
          </div>
          <div class="setting-row" style="margin-top:16px">
            <div class="sr-main"><div class="sr-title">Switchable</div><p class="sr-desc">Use the profile button on the device to cycle slots.</p></div>
            <div class="sr-side">
              <div class="color-dots">
                ${['#3b82f6', '#7aa7ff', '#ff6b6b', '#b388ff', '#f2b25c'].map((col) => `<span class="cdot" style="--c:${col}"></span>`).join('')}
              </div>
              <label class="switch"><input type="checkbox" data-bind="allowSwitch" data-kind="bool" ${c.allowSwitch ? 'checked' : ''} aria-label="Switchable"/><i></i></label>
            </div>
          </div>
        </div>
      </section>

      <section class="card stretch">
        <div class="card-head"><div class="ch-title">${icon('info')}<div><h2>Device details</h2><p>Reported by the firmware</p></div></div></div>
        <div class="card-body">
          <div class="kv"><span class="k">Firmware</span><span class="v">${esc((state.info && (state.info.r || state.info.revision)) || '—')}</span></div>
          <div class="kv"><span class="k">Product ID</span><span class="v">${esc(String(p.product_id).toUpperCase())}</span></div>
          <div class="kv"><span class="k">Sensor</span><span class="v">${esc(p.sensor || '—')}</span></div>
          <div class="kv"><span class="k">SoC</span><span class="v">${esc(p.soc || '—')}</span></div>
          <div class="kv"><span class="k">Connection</span><span class="v ${state.connected ? 'good' : ''}">${esc(connection)}</span></div>
          <div class="kv"><span class="k">Profiles</span><span class="v">${onboardMax} slots</span></div>
        </div>
      </section>
    </div>`;
  }

  /* ── Buttons ───────────────────────────────────────────────────────── */
  function keyFunction(p, key) {
    const assigned = state.cfg.keys[key.name];
    if (assigned && assigned.label) return assigned.label;
    return MOUSE_FN[key.name] || key.label || 'Unassigned';
  }

  function selectedKey() {
    const p = state.profile;
    if (!p) return null;
    if (p.keyboard) {
      return state.selectedKey || 'Key A';
    }
    const keys = p.keys || [];
    const found = keys.find((k) => k.name === state.selectedKey);
    return found ? found.name : (keys[0] && keys[0].name) || null;
  }

  function buttonsView() {
    const p = state.profile;
    const c = state.cfg;
    if (p.keyboard) return keyboardView();
    const keys = (p.keys || []).slice().sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
    const active = selectedKey();
    const key = keys.find((k) => k.name === active);
    const assignment = (active && c.keys[active]) || { type: 'key', label: key ? keyFunction(p, key) : 'Left click', mods: [], turbo: false, freq: 20, rand: 0, down: 0, up: 0 };
    return `
    ${pageHead('Button mapping', 'Buttons',
      'Pick a button on the device, then choose what it should send. Changes apply as soon as you pick them.',
      `<span class="pill ${state.dirty ? 'accent' : ''}" data-dirty-pill>${state.dirty ? 'Unsaved changes' : 'In sync'}</span>`)}

    <div class="split">
      <div class="stack">
        <section class="card map-card">
          <div class="card-head"><div class="ch-title">${icon('mouse')}<div><h2>Device map</h2><p>${keys.length} programmable buttons</p></div></div><span class="pill">TOP VIEW</span></div>
          ${mouseMap(p, active)}
          <div class="key-list">
            ${keys.map((k) => `
              <button class="key-row ${k.name === active ? 'is-active' : ''}" data-action="select-key" data-key="${esc(k.name)}">
                <span class="kr-name">${esc(k.label || k.name)}</span>
                <span class="kr-label">${esc(k.name)}</span>
                <span class="kr-fn">${esc(keyFunction(p, k))}</span>
              </button>`).join('')}
          </div>
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><div class="ch-title">${icon('keys')}<div><h2>Assign ${esc(key ? key.label + ' · ' + key.name : 'button')}</h2><p>What this button sends</p></div></div></div>
          <div class="card-body stack">
            <div class="grid g-2">
              <div class="field">
                <span class="field-label">Onboard config</span>
                <select class="input" data-bind="onboard" data-kind="int">
                  ${Array.from({ length: c.onboardMax || 5 }).map((_, i) => `<option value="${i}" ${i === (c.onboard | 0) ? 'selected' : ''}>Profile ${i + 1}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <span class="field-label">R-Plus key</span>
                <select class="input" data-bind="rplus" data-kind="str">
                  <option ${c.rplus === 'None' ? 'selected' : ''}>None</option>
                  ${keys.map((k) => `<option ${c.rplus === k.name ? 'selected' : ''}>${k.name}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="divider" style="margin:0"></div>
            <div class="seg full" role="tablist">
              ${[['key', 'Key'], ['macro', 'Macro'], ['function', 'Function'], ['none', 'None']].map(([v, l]) => `<button class="${assignment.type === v ? 'is-active' : ''}" data-action="map-type" data-type="${v}">${l}</button>`).join('')}
            </div>

            ${assignment.type === 'key' ? `
              <div class="field">
                <span class="field-label">Key or button</span>
                <div class="row">
                  <input class="input" value="${esc(assignment.label || '')}" data-bind="assignment.label" data-kind="str" aria-label="Assigned key"/>
                  <button class="btn ${state.capturing ? 'btn-primary' : 'btn-ghost'} btn-sm" data-action="capture" style="flex:none">
                    ${state.capturing ? '<span class="record-dot"></span><span>Listening…</span>' : icon('record') + '<span>Record</span>'}
                  </button>
                </div>
                <p class="help">Click record, then press any key or mouse button. Esc cancels.</p>
              </div>
              <div class="field">
                <span class="field-label">Modifiers</span>
                <div class="seg-wrap">
                  ${['Ctrl', 'Shift', 'Alt', 'Win'].map((m) => `<button class="chip ${(assignment.mods || []).includes(m) ? 'is-active' : ''}" data-action="mod" data-mod="${m}">${m}</button>`).join('')}
                </div>
              </div>
              ${toggleRow('Turbo', 'Repeat clicks while the button is held.', 'assignment.turbo', assignment.turbo)}
              ${assignment.turbo ? `<div class="grid g-2">
                <div class="field"><span class="field-label">Clicks / second</span><input class="input" type="number" min="1" max="200" value="${assignment.freq || 20}" data-bind="assignment.freq" data-kind="int"/></div>
                <div class="field"><span class="field-label">Randomise ±</span><input class="input" type="number" min="0" max="50" value="${assignment.rand || 0}" data-bind="assignment.rand" data-kind="int"/></div>
                <div class="field"><span class="field-label">Hold down ms</span><input class="input" type="number" min="0" max="500" value="${assignment.down || 0}" data-bind="assignment.down" data-kind="int"/></div>
                <div class="field"><span class="field-label">Hold up ms</span><input class="input" type="number" min="0" max="500" value="${assignment.up || 0}" data-bind="assignment.up" data-kind="int"/></div>
              </div>` : ''}
            ` : assignment.type === 'macro' ? `
              <div class="field">
                <span class="field-label">Macro</span>
                <select class="input" data-bind="assignment.macro" data-kind="str">
                  ${c.macros.map((m) => `<option ${assignment.macro === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
                </select>
              </div>
              <div class="tab-note">${icon('info')}<span>Macro playback is stored with the button. Edit macro actions on the Macros page.</span></div>
            ` : assignment.type === 'function' ? `
              <div class="field">
                <span class="field-label">Device function</span>
                <select class="input" data-bind="assignment.fn" data-kind="str">
                  ${['DPI cycle', 'Next DPI stage', 'Previous DPI stage', 'Show battery', 'Switch onboard profile', 'Toggle lighting', 'Macro toggle'].map((f) => `<option ${assignment.fn === f ? 'selected' : ''}>${f}</option>`).join('')}
                </select>
              </div>
              <div class="tab-note">${icon('info')}<span>Functions are executed on the device and keep working with the tab closed.</span></div>
            ` : `
              <div class="empty">${icon('minus')}<p>This button sends nothing. It can still be restored later from the device profile.</p></div>
            `}
          </div>
          <div class="card-foot">
            <button class="btn btn-ghost btn-sm" data-action="factory-reset">${icon('refresh')}<span>Restore</span></button>
            <span class="help">Changes apply and save automatically.</span>
          </div>
        </section>

        <div class="notice">${icon('info')}<span><strong>Draft mode.</strong> This build writes sensitivity, polling and lighting to the device. Button and macro writes are staged locally while the key table is being verified — the console shows every packet.</span></div>
      </div>
    </div>`;
  }

  function keyboardView() {
    const p = state.profile;
    const active = selectedKey();
    const rows = [
      [['Esc', 1], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1], ['-', 1], ['=', 1], ['Backspace', 2]],
      [['Tab', 1.5], ['Q', 1], ['W', 1], ['E', 1], ['R', 1], ['T', 1], ['Y', 1], ['U', 1], ['I', 1], ['O', 1], ['P', 1], ['[', 1], [']', 1], ['\\', 1.5]],
      [['Caps', 1.75], ['A', 1], ['S', 1], ['D', 1], ['F', 1], ['G', 1], ['H', 1], ['J', 1], ['K', 1], ['L', 1], [';', 1], ["'", 1], ['Enter', 2.25]],
      [['Shift', 2.25], ['Z', 1], ['X', 1], ['C', 1], ['V', 1], ['B', 1], ['N', 1], ['M', 1], [',', 1], ['.', 1], ['/', 1], ['Shift', 1.75]],
      [['Ctrl', 1.25], ['Win', 1.25], ['Alt', 1.25], ['Space', 6.25], ['Alt', 1.25], ['Fn', 1.25], ['Ctrl', 1.25]],
    ];
    return `
    ${pageHead('Key mapping', 'Buttons',
      'Select a key to remap. The board below is a 65% ANSI reference layout for this build.',
      `<span class="pill ${state.dirty ? 'accent' : ''}" data-dirty-pill>${state.dirty ? 'Unsaved changes' : 'In sync'}</span>`)}
    <div class="split">
      <div class="stack">
        <section class="card">
          <div class="card-head"><div class="ch-title">${icon('keys')}<div><h2>${esc(p.title)}</h2><p>${esc(p.soc === 'HS' ? 'Magnetic · HS protocol' : 'Mechanical')}</p></div></div><span class="pill">ANSI 65%</span></div>
          <div class="card-body">
            <div class="kbd-board">
              ${rows.map((row) => `<div class="kbd-row">${row.map(([label, flex]) => `<button class="keycap ${label === active ? 'is-active' : ''}" style="flex:${flex}" data-action="select-key" data-key="${esc(label)}">${esc(label)}</button>`).join('')}</div>`).join('')}
            </div>
            <p class="help" style="margin-top:12px">Magnetic keyboards expose SOCD, MT, RS and DKS rules on the Advanced keys page.</p>
          </div>
        </section>
        <div class="notice warn">${icon('alert')}<span><strong>Keyboard writes are disabled in this build.</strong> The HS command set is decoded and the firmware handshake runs, but key tables differ per model — this page stays local until a device key map is imported.</span></div>
      </div>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('sliders')}<div><h2>Assign ${esc(active)}</h2><p>What this key sends</p></div></div></div>
        <div class="card-body stack">
          <div class="seg full">
            ${[['key', 'Key'], ['macro', 'Macro'], ['function', 'Function'], ['none', 'None']].map(([v, l]) => `<button class="${(state.cfg.keys[active]?.type || 'key') === v ? 'is-active' : ''}" data-action="map-type" data-type="${v}">${l}</button>`).join('')}
          </div>
          <div class="field">
            <span class="field-label">Key</span>
            <div class="row"><input class="input" value="${esc((state.cfg.keys[active] && state.cfg.keys[active].label) || active)}" data-bind="assignment.label" data-kind="str"/><button class="btn btn-ghost btn-sm" data-action="capture">${icon('record')}<span>Record</span></button></div>
          </div>
          <div class="field">
            <span class="field-label">Modifiers</span>
            <div class="seg-wrap">${['Ctrl', 'Shift', 'Alt', 'Win'].map((m) => `<button class="chip ${((state.cfg.keys[active]?.mods) || []).includes(m) ? 'is-active' : ''}" data-action="mod" data-mod="${m}">${m}</button>`).join('')}</div>
          </div>
          <div class="tab-note">${icon('info')}<span>Mappings are kept in this browser for keyboards. Nothing is written to HS hardware yet.</span></div>
        </div>
        <div class="card-foot"><button class="btn btn-ghost btn-sm" data-action="reset-key">Reset</button><button class="btn btn-primary btn-sm" data-action="stage-mapping">Stage change</button></div>
      </section>
    </div>`;
  }

  /* ── Performance ───────────────────────────────────────────────────── */
  function performanceView() {
    const p = state.profile;
    const c = state.cfg;
    const max = (p.cpi_range && p.cpi_range[1]) || 30000;
    const min = (p.cpi_range && p.cpi_range[0]) || 50;
    const step = p.cpi_step || 50;
    const lods = p.lods || ['Low', 'Medium', 'High'];
    return `
    ${pageHead('Sensor & speed', 'Performance',
      'Everything the sensor reports, tuned in one place. Changes are written to the device automatically.',
      `<span class="pill ${state.dirty ? 'accent' : ''}" data-dirty-pill>${state.dirty ? 'Unsaved' : 'In sync'}</span>`)}

    <div class="grid g-2">
      <section class="card" style="grid-column:1/-1">
        <div class="card-head">
          <div class="ch-title">${icon('sliders')}<div><h2>Sensitivity</h2><p>DPI / CPI · ${fmt(min)}–${fmt(max)} in ${fmt(step)} steps</p></div></div>
          <label class="row" style="gap:8px;font-size:11.5px;color:var(--muted)">Separate X / Y
            <span class="switch"><input type="checkbox" data-bind="xy" data-kind="bool" ${c.xy ? 'checked' : ''}/><i></i></span>
          </label>
        </div>
        <div class="card-body">
          <div class="dpi-top">
            <div>
              <div class="dpi-readout"><span class="num" data-live="cpiX">${fmt(c.cpiX)}</span><span class="unit">${c.xy ? 'X DPI' : 'DPI'}</span></div>
              ${c.xy ? `<div class="dpi-readout" style="margin-top:10px"><span class="num" style="font-size:28px;color:var(--muted)" data-live="cpiY">${fmt(c.cpiY)}</span><span class="unit">Y DPI</span></div>` : ''}
              <div class="seg-wrap" style="margin-top:14px">
                <button class="chip" data-action="dpi-step" data-delta="-100">−100</button>
                <button class="chip" data-action="dpi-step" data-delta="100">+100</button>
                <button class="chip" data-action="dpi-reset">Reset</button>
              </div>
            </div>
            <div class="stack" style="gap:16px">
              ${rangeRow(c.xy ? 'X sensitivity' : 'Sensitivity', 'cpiX', c.cpiX, min, max, step, ' dpi')}
              ${c.xy ? rangeRow('Y sensitivity', 'cpiY', c.cpiY, min, max, step, ' dpi') : ''}
            </div>
          </div>
          <div class="dpi-stages-block">
            <div class="between">
              <div>
                <span class="field-label">Onboard stages</span>
                <p class="help">Click a stage to make it active. Every stage is written to memory.</p>
              </div>
              <div class="row">
                ${c.dpiLevels.length > 1 ? `<button class="link-btn" data-action="dpi-remove">Remove last</button>` : ''}
                ${c.dpiLevels.length < 8 ? `<button class="btn btn-ghost btn-sm" data-action="dpi-add">${icon('plus')}<span>Add stage</span></button>` : ''}
              </div>
            </div>
            <div class="dpi-stages dpi-grid">
              ${c.dpiLevels.map((v, i) => `
                <button class="dpi-stage ${i === c.activeLevel ? 'is-active' : ''}" data-action="dpi-stage" data-index="${i}">
                  <div class="ds-i"><span class="ds-dot" style="--c:${stageColor(i)}"></span>STAGE ${String(i + 1).padStart(2, '0')}</div>
                  <div class="ds-v">${fmt(v)}</div>
                </button>`).join('')}
            </div>
            <div class="stage-color">
              <span class="field-label">Stage <span data-live="active-stage">${String(c.activeLevel + 1).padStart(2, '0')}</span> colour</span>
              <div class="swatches">
                ${LED_COLORS.map((col) => `<button class="swatch swatch-sm ${stageBits(c.activeLevel) === col.bits ? 'is-active' : ''}" style="--sw:${col.hex}" data-action="stage-color" data-bits="${col.bits}" title="${col.bits === 0 ? 'Off' : col.hex.toUpperCase()}" aria-label="Stage colour ${col.hex}"></button>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('wave')}<div><h2>Polling rate</h2><p>Sensor updates per second</p></div></div></div>
        <div class="card-body">
          <div class="seg full" style="flex-wrap:wrap">
            ${(p.polling_rates || [125, 250, 500, 1000]).map((r) => `<button class="${r === c.polling ? 'is-active' : ''}" data-action="polling" data-value="${r}">${fmt(r)}</button>`).join('')}
          </div>
          <div class="notice" style="margin-top:14px">${icon('info')}<span>Restart the device after changing polling rate. Higher rates need the bundled 2.4 GHz receiver.</span></div>
          ${p.boost_polling_rates ? `<div class="kv" style="margin-top:8px"><span class="k">Boost rates</span><span class="v">${p.boost_polling_rates.map(fmt).join(' / ')} Hz</span></div>` : ''}
          ${toggleRow('X-Polling', 'Interpolate extra reports between sensor samples.', 'xPolling', c.xPolling)}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('chip')}<div><h2>Sensor corrections</h2><p>Lift-off, angle and smoothing</p></div></div></div>
        <div class="card-body">
          <div class="field">
            <span class="field-label">Lift-off distance</span>
            <div class="seg full">
              ${lods.map((l, i) => `<button class="${i === Number(c.lod) ? 'is-active' : ''}" data-action="lod" data-value="${i}">${esc(String(l))}</button>`).join('')}
            </div>
          </div>
          <div style="height:14px"></div>
          ${rangeRow('Angle tuning', 'angleTuning', c.angleTuning, -30, 30, 1, '°')}
          <div style="height:6px"></div>
          ${toggleRow('Angle snapping', 'Straighten horizontal and vertical movement.', 'angleSnapping', c.angleSnapping)}
          ${toggleRow('Ripple control', 'Smooth out wave-shaped jitter at speed.', 'rippleControl', c.rippleControl)}
          ${toggleRow('Motion sync', 'Align sensor samples with USB reports.', 'motionSync', c.motionSync)}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${batterySlot(state.info && state.info.battery != null ? Number(state.info.battery) : null, 16)}<div><h2>Power</h2><p>Sleep and wireless mode</p></div></div></div>
        <div class="card-body">
          ${rangeRow('Sleep after', 'sleep', c.sleep, 1, 30, 1, ' min')}
          <div class="field" style="margin-top:14px">
            <span class="field-label">Power mode</span>
            <div class="seg full">
              ${(p.power_modes || ['Office', 'LP', 'HP']).slice(0, 4).map((m, i) => `<button class="${i === Number(c.powerMode) ? 'is-active' : ''}" data-action="power" data-value="${i}">${esc(String(m))}</button>`).join('')}
            </div>
            <p class="help">${esc((p.power_mode_tips && p.power_mode_tips[c.powerMode]) || 'Higher performance uses more battery.')}</p>
          </div>
          <div class="divider"></div>
          <div class="between"><span class="field-label">Estimated battery</span><span class="mono batt-readout">${batterySlot(state.info && state.info.battery != null ? Number(state.info.battery) : null, 13)}<span data-live="battery-pct">${state.info && state.info.battery != null ? state.info.battery + '%' : '—'}</span></span></div>
          <div class="stat-bar" style="height:6px;margin-top:9px"><i data-bar="battery-power" style="width:${state.info && state.info.battery ? state.info.battery : 0}%;${state.info && state.info.battery != null ? 'background:' + batteryTone(Number(state.info.battery)) : ''}"></i></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('wave')}<div><h2>Wireless turbo</h2><p>Link quality and power</p></div></div><span class="pill accent">100%</span></div>
        <div class="card-body">
          ${toggleRow('Auto switch', 'Pick the best mode for the current signal.', 'wireless.auto', c.wireless.auto)}
          <div class="field" style="margin-top:12px">
            <span class="field-label">Mode</span>
            <div class="seg full">
              ${[1, 2, 3, 4].map((m) => `<button class="${Number(c.wireless.mode) === m ? 'is-active' : ''}" data-action="turbo-mode" data-value="${m}">${m}</button>`).join('')}
            </div>
          </div>
          ${toggleRow('Power saving', 'Trade peak signal strength for battery life.', 'wireless.powerSaving', c.wireless.powerSaving)}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('sliders')}<div><h2>Key delay</h2><p>Per-button debounce</p></div></div></div>
        <div class="card-body">
          <div class="field">
            <span class="field-label">Select key</span>
            <select class="input" data-bind="keyDelayKey" data-kind="str">
              ${(p.keys || []).map((k) => `<option ${c.keyDelayKey === k.name ? 'selected' : ''}>${k.name}</option>`).join('')}
            </select>
          </div>
          <div style="height:12px"></div>
          ${rangeRow('Delay', 'keyDelayMs', c.keyDelayMs, 1, 10, 1, ' ms')}
          <p class="help">Increasing the delay can improve key stability.</p>
        </div>
      </section>
    </div>`;
  }

  /* ── Lighting ──────────────────────────────────────────────────────── */
  function lightingView() {
    const p = state.profile;
    const c = state.cfg;
    if (!p.light) {
      return `
      ${pageHead('Lighting studio', 'Lighting',
        'This device profile does not expose RGB lighting.')}
      <section class="card"><div class="empty">
        ${icon('bulb')}
        <p>No RGB lighting on this device. The firmware reports no light channel for ${esc(p.title)}.</p>
      </div></section>`;
    }
    const preset = LIGHT_PRESETS.find((l) => l.mode === c.lightMode) || LIGHT_PRESETS[0];
    const zones = p.keyboard ? ['Per key', 'Underglow', 'Side rails'] : ['Scroll wheel', 'Logo', 'Base'];
    const zoneOn = (i) => !!(c.zones && c.zones[i]);
    return `
    ${pageHead('Lighting studio', 'Lighting',
      'Mode, colour and brightness for every zone. Preview reflects the values written on apply.',
      `<span class="pill"><span data-live="light-mode-name">${preset.name}</span> · <span data-live="brightness">${c.brightness}</span>%</span>`)}

    <div class="split">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('bulb')}<div><h2>Preview</h2><p><span data-live="light-mode-name">${esc(preset.name)}</span> · <span data-live="color-hex">${esc(c.color)}</span></p></div></div><span class="pill accent">LIVE</span></div>
        <div class="card-body">
          <div class="light-stage" style="--glow:${esc(c.color)}">
            ${img(productImage(p), 'device-render', p.title)}
            <span class="ls-caption"><span data-live="light-mode-name">${esc(preset.name)}</span> · <span data-live="brightness">${c.brightness}</span>% · <span data-live="speed">${c.speed}</span>% speed</span>
          </div>
          <div class="zone-list" style="margin-top:14px;border-top:1px solid var(--line)">
            ${zones.map((z, i) => `
              <div class="zone-row">
                <span class="zr-dot" style="--zc:${esc(c.color)};opacity:${zoneOn(i) ? 1 : 0.3}"></span>
                <span class="zr-name">${esc(z)}</span>
                <span class="zr-state">${zoneOn(i) ? 'ON' : 'OFF'}</span>
                <label class="switch"><input type="checkbox" data-bind="zones.${i}" data-kind="bool" ${zoneOn(i) ? 'checked' : ''} aria-label="${esc(z)}"/><i></i></label>
              </div>`).join('')}
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('sliders')}<div><h2>Effect</h2><p>Pick a mode and colour</p></div></div></div>
        <div class="card-body">
          <div class="mode-grid">
            ${LIGHT_PRESETS.map((l) => `
              <button class="mode-tile ${l.mode === c.lightMode ? 'is-active' : ''}" data-action="light-mode" data-mode="${l.mode}">
                <div class="mt-preview ${l.cls}" style="${l.mode === 'steady' ? 'background:' + c.color : ''}"></div>
                <div class="mt-name">${esc(l.name)}</div>
                <div class="mt-sub">${l.mode === 'off' ? 'NO OUTPUT' : l.mode.toUpperCase()}</div>
              </button>`).join('')}
          </div>
          <div class="divider"></div>
          <div class="field">
            <span class="field-label">Colour</span>
            <div class="swatches">
              ${COLORS.map((col) => `<button class="swatch ${col.toLowerCase() === c.color.toLowerCase() ? 'is-active' : ''}" style="--sw:${col}" data-action="color" data-color="${col}" aria-label="${col}"></button>`).join('')}
              <span class="mono" data-live="color-hex" style="font-size:10px;color:var(--faint);margin-left:4px">${esc(c.color.toUpperCase())}</span>
            </div>
          </div>
          <div style="height:14px"></div>
          ${rangeRow('Brightness', 'brightness', c.brightness, 0, 100, 1, '%')}
          <div style="height:12px"></div>
          ${rangeRow('Speed', 'speed', c.speed, 0, 100, 1, '%')}
          <div style="height:4px"></div>
          ${toggleRow('Glass mode', 'Raise the tracking ceiling for glass and reflective desks.', 'glassMode', c.glassMode)}
        </div>
      </section>
    </div>

    ${p.keyboard ? `
    <section class="card" style="margin-top:14px">
      <div class="card-head"><div class="ch-title">${icon('keys')}<div><h2>Per-key colour</h2><p>Click a key to paint it with the active colour</p></div></div><span class="pill">${p.keys ? p.keys.length : 68} KEYS</span></div>
      <div class="card-body">
        <div class="perkey">
          ${Array.from({ length: 84 }).map((_, i) => `<button class="pk ${c.painted && c.painted[i] ? 'is-active' : ''}" style="--c:${(c.painted && c.painted[i]) || '#171b21'}" data-action="paint" data-index="${i}" aria-label="Key ${i + 1}"></button>`).join('')}
        </div>
        <p class="help" style="margin-top:10px">Painted keys use the current colour. The layout is illustrative until the keyboard key map is imported.</p>
      </div>
    </section>` : ''}`;
  }

  /* ── Advanced keys ─────────────────────────────────────────────────── */
  function advancedView() {
    const p = state.profile;
    const c = state.cfg;
    const supported = !!(p.keyboard || p.enhancement);
    const tab = state.advTab;
    const keys = p.keyboard ? ['A', 'S', 'D', 'F', 'W', 'Space', 'Shift', 'Ctrl'] : ['M1', 'M2', 'M3', 'M4', 'M5'];
    const adv = c.adv || DEFAULTS.adv;
    const dv = (v) => (keys.includes(v) ? v : keys[0]);
    const select = (name, value) => `<select class="input" data-bind="${name}" data-kind="str" ${supported ? '' : 'disabled'}>${keys.map((k) => `<option ${k === dv(value) ? 'selected' : ''}>${k}</option>`).join('')}</select>`;
    const titleMap = { socd: 'SOCD', mt: 'MT', rs: 'RS', dks: 'DKS' };
    return `
    ${pageHead('Magnetic switches', 'Advanced keys',
      'Priority, tap-hold and multi-stage travel. These features live on the keyboard firmware, not the host.',
      `<span class="pill ${supported ? 'accent' : ''}">${supported ? 'Supported' : 'Mouse profile'}</span>`)}

    <div class="adv-tabs" style="margin-bottom:14px">
      ${[['socd', 'SOCD'], ['mt', 'MT'], ['rs', 'RS'], ['dks', 'DKS']].map(([v, l]) => `<button class="${tab === v ? 'is-active' : ''}" data-action="adv-tab" data-tab="${v}">${l}</button>`).join('')}
    </div>

    ${!supported ? `<div class="notice warn" style="margin-bottom:14px">${icon('alert')}<span><strong>This profile is a mouse.</strong> Switch to a magnetic keyboard (for example Z68A) to edit SOCD, MT, RS and DKS behaviour.</span></div>` : ''}

    <div class="grid g-2">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('keys')}<div><h2>${esc(titleMap[tab])}</h2><p>${esc({
          socd: 'Simultaneous opposite cardinal directions',
          mt: 'Dual-action tap and hold',
          rs: 'Rapid trigger priority',
          dks: 'Dynamic keystroke, four stages',
        }[tab])}</p></div></div><span class="pill">FW</span></div>
        <div class="card-body stack">
          <fieldset class="adv-fieldset" ${supported ? '' : 'disabled'}>
          ${tab === 'socd' ? `
            <p class="help">When two opposing directions are held, the most recent input wins. Releasing it restores the other direction. Choose the two keys and the resolution rule.</p>
            <div class="grid g-2">
              <div class="field"><span class="field-label">Key 1</span>${select('adv.socd.a', adv.socd.a)}</div>
              <div class="field"><span class="field-label">Key 2</span>${select('adv.socd.b', adv.socd.b)}</div>
            </div>
            <div class="field"><span class="field-label">Resolution</span>
              <div class="seg full">
                <button class="is-active">Last input wins</button><button>Neutral</button><button>First wins</button>
              </div>
            </div>
            <div class="diagram" style="height:118px">
              <div class="axis" style="top:34px"></div><span class="label" style="top:34px">A pressed</span>
              <div class="axis" style="top:72px"></div><span class="label" style="top:72px">D pressed</span>
              <div class="marker" style="top:33px;width:42%;color:var(--accent)"></div>
              <div class="marker" style="top:71px;width:72%;color:#7aa7ff"></div>
              <div class="marker" style="top:100px;width:62%;color:var(--accent)"></div>
            </div>
            <div class="tab-note">${icon('info')}<span>Equivalent to Snap Tap. Some tournament rules restrict this behaviour — check your league.</span></div>
          ` : tab === 'mt' ? `
            <p class="help">One key, two jobs. A tap sends one action, holding past the threshold sends another.</p>
            <div class="grid g-2">
              <div class="field"><span class="field-label">Key</span>${select('adv.mt.key', adv.mt.key)}</div>
              <div class="field"><span class="field-label">Hold threshold</span><div class="input-group"><input class="input" type="number" value="${esc(adv.mt.ms)}" data-bind="adv.mt.ms" data-kind="int"/><span class="unit">ms</span></div></div>
              <div class="field"><span class="field-label">Tap sends</span><input class="input" value="${esc(adv.mt.tap)}" data-bind="adv.mt.tap" data-kind="str"/></div>
              <div class="field"><span class="field-label">Hold sends</span><input class="input" value="${esc(adv.mt.hold)}" data-bind="adv.mt.hold" data-kind="str"/></div>
            </div>
            <div class="tab-note">${icon('info')}<span>Useful for walk/crouch or scope/hold bindings without a second key.</span></div>
          ` : tab === 'rs' ? `
            <p class="help">Two keys share a priority: whichever is pressed deeper activates, and the shallower key resumes when it is released.</p>
            <div class="grid g-2">
              <div class="field"><span class="field-label">Key 1</span>${select('adv.rs.a', adv.rs.a)}</div>
              <div class="field"><span class="field-label">Key 2</span>${select('adv.rs.b', adv.rs.b)}</div>
            </div>
            <div class="diagram" style="height:130px">
              <div class="axis" style="top:30px"></div><span class="label" style="top:30px">1.0 mm</span>
              <div class="axis" style="top:66px"></div><span class="label" style="top:66px">2.2 mm</span>
              <div class="axis" style="top:102px"></div><span class="label" style="top:102px">3.4 mm</span>
              <div class="marker" style="top:65px;width:34%;color:var(--accent)"></div>
              <div class="marker" style="top:101px;width:62%;color:#7aa7ff"></div>
            </div>
            <div class="tab-note">${icon('info')}<span>Also called rapid trigger priority. Both keys keep analog resolution.</span></div>
          ` : `
            <p class="help">Four functions across four travel points. Bind different actions to a light press, a deep press, and the release path.</p>
            <div class="grid g-2">
              <div class="field"><span class="field-label">Press start</span><div class="input-group"><input class="input" type="number" step="0.05" value="${esc(adv.dks.p1)}" data-bind="adv.dks.p1" data-kind="float"/><span class="unit">mm</span></div></div>
              <div class="field"><span class="field-label">Bottom out</span><div class="input-group"><input class="input" type="number" step="0.05" value="${esc(adv.dks.p2)}" data-bind="adv.dks.p2" data-kind="float"/><span class="unit">mm</span></div></div>
              <div class="field"><span class="field-label">Release bottom</span><div class="input-group"><input class="input" type="number" step="0.05" value="${esc(adv.dks.p3)}" data-bind="adv.dks.p3" data-kind="float"/><span class="unit">mm</span></div></div>
              <div class="field"><span class="field-label">Fully released</span><div class="input-group"><input class="input" type="number" step="0.05" value="${esc(adv.dks.p4)}" data-bind="adv.dks.p4" data-kind="float"/><span class="unit">mm</span></div></div>
            </div>
            <div class="field"><span class="field-label">Stages</span>
              <div class="stack" style="gap:6px">
                ${[['1', 'Light press', 'Walk'], ['2', 'Deep press', 'Sprint'], ['3', 'Release', 'Stop'], ['4', 'Full release', 'Idle']].map(([n, k, a]) => `<div class="pair-row" style="grid-template-columns:26px 1fr 1fr"><span class="mono" style="font-size:9px;color:var(--faint)">${n}</span><input class="input" value="${k}" readonly/><input class="input" value="${a}" readonly/></div>`).join('')}
              </div>
            </div>
            <div class="tab-note">${icon('info')}<span>DKS is only available on magnetic switch models with per-key ADC.</span></div>
          `}
          </fieldset>
        </div>
        <div class="card-foot">
          <span class="help">${supported ? 'Stored on the keyboard with the next write.' : 'Unavailable for this device.'}</span>
          <button class="btn btn-primary btn-sm" data-action="stage-advanced" ${supported ? '' : 'disabled'}>${icon('check')}<span>Stage change</span></button>
        </div>
      </section>

      <div class="stack">
        <section class="card">
          <div class="card-head"><div class="ch-title">${icon('chip')}<div><h2>Configured pairs</h2><p>Stored on the device</p></div></div></div>
          <div class="card-body">
            ${(tab === 'socd' ? [['A', 'D', 'Last input'], ['W', 'S', 'Last input']] : tab === 'mt' ? [['Shift', 'Tap: Space', 'Hold: Ctrl']] : tab === 'rs' ? [['A', 'D', 'Depth priority']] : [['W', '4 stages', '1.0–3.4 mm']]).map(([a, b, c2]) => `<div class="kv"><span class="k mono">${esc(a)}</span><span class="v">${esc(b)}</span><span class="pill">${esc(c2)}</span></div>`).join('')}
            <p class="help" style="margin-top:10px">A maximum of 20 advanced key rules is stored per profile.</p>
          </div>
        </section>
      </div>
    </div>`;
  }

  /* ── Macros ────────────────────────────────────────────────────────── */
  function macrosView() {
    const c = state.cfg;
    const macro = c.macros[state.macro] || c.macros[0];
    return `
    ${pageHead('Automation', 'Macros',
      'Record a sequence once, then bind it to any button. Delays are stored in milliseconds.',
      `<button class="btn btn-primary btn-sm" data-action="macro-add">${icon('plus')}<span>New macro</span></button>`)}

    <div class="split">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('bolt')}<div><h2>Library</h2><p>${c.macros.length} macros in this profile</p></div></div><span class="pill">${c.macros.length}</span></div>
        <div class="macro-list">
          ${c.macros.map((m, i) => `
            <button class="macro-item ${i === state.macro ? 'is-active' : ''}" data-action="macro-select" data-index="${i}">
              <span class="mi-main">
                <span class="mi-name">${esc(m.name)}</span>
                <span class="mi-meta">${esc(m.trigger)} · ${m.actions.length} actions</span>
              </span>
              <span class="mi-count">${String(i + 1).padStart(2, '0')}</span>
            </button>`).join('')}
        </div>
        <div class="card-foot">
          <span class="help">Macros execute on the device.</span>
          <button class="btn btn-ghost btn-sm" data-action="macro-delete" ${c.macros.length <= 1 ? 'disabled' : ''}>${icon('trash')}<span>Delete</span></button>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="ch-title">${icon('keys')}<div><h2>${esc(macro.name)}</h2><p>${esc(macro.trigger)} trigger</p></div></div>
          <button class="btn ${state.capturing ? 'btn-primary' : 'btn-ghost'} btn-sm" data-action="capture-macro">
            ${state.capturing ? '<span class="record-dot"></span><span>Recording…</span>' : icon('record') + '<span>Record</span>'}
          </button>
        </div>
        <div class="card-body">
          <div class="grid g-2" style="margin-bottom:14px">
            <div class="field"><span class="field-label">Name</span><input class="input" value="${esc(macro.name)}" data-bind="macro.name" data-kind="str"/></div>
            <div class="field"><span class="field-label">Trigger</span>
              <select class="input" data-bind="macro.trigger" data-kind="str">${['Hold', 'Toggle', 'On press', 'On release'].map((t) => `<option ${macro.trigger === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
            </div>
          </div>
          <div class="between" style="margin-bottom:6px"><span class="field-label">Actions</span><span class="mono" style="font-size:10px;color:var(--faint)">${macro.actions.length} steps</span></div>
          <div>
            ${macro.actions.map((a, i) => `
              <div class="action-row">
                <span class="idx">${String(i + 1).padStart(2, '0')} · ${esc(a.type)}</span>
                <input class="input" value="${esc(a.value || '')}" placeholder="${a.type === 'Delay' ? '—' : 'Key / button'}" data-bind="macro.action.value" data-index="${i}" data-kind="str" ${a.type === 'Delay' ? 'disabled' : ''}/>
                <div class="input-group" style="height:30px">
                  <input class="input" type="number" min="0" value="${a.delay || 0}" data-bind="macro.action.delay" data-index="${i}" data-kind="int" style="height:30px"/>
                  <span class="unit" style="height:30px">ms</span>
                </div>
                <button class="icon-btn" data-action="macro-action-remove" data-index="${i}" aria-label="Remove step">${icon('x')}</button>
              </div>`).join('')}
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-ghost btn-sm" data-action="macro-action-add">${icon('plus')}<span>Add step</span></button>
            <button class="btn btn-ghost btn-sm" data-action="macro-action-delay">${icon('wave')}<span>Add delay</span></button>
          </div>
        </div>
        <div class="card-foot">
          <span class="help">${macro.actions.reduce((n, a) => n + (Number(a.delay) || 0), 0)} ms total</span>
          <button class="btn btn-primary btn-sm" data-action="stage-macro">${icon('check')}<span>Save macro</span></button>
        </div>
      </section>
    </div>`;
  }

  /* ── Firmware ──────────────────────────────────────────────────────── */
  function firmwareView() {
    const p = state.profile;
    const connection = transport.isReceiver ? '2.4 GHz' : 'USB';
    return `
    ${pageHead('Device firmware', 'Firmware',
      'The revision and channel reported by the device, plus the factory reset.')}

    <div class="split">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('chip')}<div><h2>Installed firmware</h2><p>${esc(p.title)}</p></div></div><span class="pill accent">STABLE</span></div>
        <div class="card-body">
          <div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr;border:1px solid var(--line);border-radius:10px;overflow:hidden">
            <div class="stat" style="border-right:1px solid var(--line);border-bottom:0;padding:15px 16px"><div class="stat-label">Installed</div><div class="stat-value" style="font-size:18px">${esc((state.info && (state.info.r || state.info.revision)) || '—')}</div></div>
            <div class="stat" style="border-right:1px solid var(--line);border-bottom:0;padding:15px 16px"><div class="stat-label">Channel</div><div class="stat-value" style="font-size:18px">Stable</div></div>
            <div class="stat" style="border-bottom:0;padding:15px 16px"><div class="stat-label">Connection</div><div class="stat-value" style="font-size:18px">${esc(connection)}</div></div>
          </div>
          <div class="setting-row" style="margin-top:14px">
            <div class="sr-main">
              <div class="sr-title">Firmware channel</div>
              <p class="sr-desc">The device reports the Stable channel. Competitive builds ship sensor timing changes early and are flashed from the desktop app.</p>
            </div>
            <div class="sr-side"><span class="pill">READ ONLY</span></div>
          </div>
          <div class="notice" style="margin-top:12px">${icon('info')}<span>Firmware is flashed by the official desktop app, not from this page. Install it from the vendor hub, flash the device, then come back here to configure it.</span></div>
          <div class="row" style="margin-top:12px">
            <a class="btn btn-primary btn-sm" href="${VENDOR_HUB}" target="_blank" rel="noopener">${icon('link')}<span>Get the official app</span></a>
            <button class="btn btn-ghost btn-sm" data-page="about">${icon('info')}<span>About</span></button>
          </div>
        </div>
      </section>

      <section class="card" style="border-color:rgba(255,111,111,.18)">
        <div class="card-head"><div class="ch-title">${icon('alert')}<div><h2>Factory reset</h2><p>Irreversible</p></div></div><span class="pill" style="color:#e5a4a4;border-color:rgba(255,111,111,.3)">DANGER</span></div>
        <div class="card-body">
          <p class="help">Erases every onboard profile, DPI stage, lighting scene and macro. The device returns to its shipping configuration.</p>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-danger btn-sm" data-action="factory-reset">${icon('refresh')}<span>Restore factory defaults</span></button>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* ── About ─────────────────────────────────────────────────────────── */
  /* Star count for the repo, fetched once and cached. The button renders
     without it and the number appears when it arrives, so no layout shift. */
  const STAR_CACHE = 'rawmhub.stars';
  const STAR_TTL = 6 * 3600 * 1000;
  let starCount = null;

  function formatStars(n) {
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  }

  function paintStarCount() {
    $$('[data-star-count]').forEach((el) => {
      const known = starCount != null;
      el.hidden = !known;
      const value = el.querySelector('[data-star-value]');
      if (value) value.textContent = known ? formatStars(starCount) : '';
      else el.textContent = known ? formatStars(starCount) : '';
    });
  }

  async function loadStarCount() {
    try {
      const cached = JSON.parse(localStorage.getItem(STAR_CACHE) || 'null');
      if (cached && typeof cached.n === 'number' && Date.now() - cached.t < STAR_TTL) {
        starCount = cached.n;
        paintStarCount();
        return;
      }
    } catch { /* ignore a corrupt cache */ }
    try {
      const res = await fetch(`${REPO_URL}`.replace('github.com', 'api.github.com/repos'), {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data.stargazers_count !== 'number') return;
      starCount = data.stargazers_count;
      paintStarCount();
      try { localStorage.setItem(STAR_CACHE, JSON.stringify({ n: starCount, t: Date.now() })); } catch { /* quota */ }
    } catch { /* offline or rate limited: the button stays as it is */ }
  }

  function aboutView() {
    const version = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    return `
    ${pageHead('About', 'About this project',
      'An independent, browser-based configurator for RAWM mice and keyboards. No installer, no account, no background service.')}

    <div class="split">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('info')}<div><h2>What Better RAWM Hub is</h2><p>Community rebuild of the vendor web configurator</p></div></div><span class="pill accent">OPEN SOURCE</span></div>
        <div class="card-body">
          <p class="help">Better RAWM Hub is a free, open-source alternative to the RAWM HUB desktop software. It talks to the device straight from the browser — WebHID in Chrome and Edge, or the small <span class="mono">better-rawmhub-bridge</span> daemon in Firefox and Safari — so DPI stages, polling rate, lift-off distance, angle tuning, motion sync, lighting, button mapping, advanced keys and macros can be changed without installing vendor software. Every change is written to the mouse and stored in its onboard memory.</p>
          <p class="help" style="margin-top:10px">RAWM HUB Web is also known as free RAWM mouse software that runs directly in the browser: adjust DPI, polling rate, lighting, key mapping and macros without installing anything.</p>
          <div class="kv" style="margin-top:14px"><span class="k">Installer</span><span class="v">None — runs in the browser</span></div>
          <div class="kv"><span class="k">Account</span><span class="v">Not required</span></div>
          <div class="kv"><span class="k">Telemetry</span><span class="v">None</span></div>
          <div class="kv"><span class="k">Price</span><span class="v good">Free · open source</span></div>
          <div class="kv"><span class="k">Browser</span><span class="v">${RAWM.Transport.native ? 'Chrome / Edge 89+' : 'Firefox / Safari · bridge'}</span></div>
          <div class="kv"><span class="k">Device access</span><span class="v">${RAWM.Transport.native ? 'WebHID · Vendor ID 0x1915' : 'Bridge · Vendor ID 0x1915'}</span></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('link')}<div><h2>Official RAWM HUB</h2><p>Installers and firmware come from the vendor</p></div></div></div>
        <div class="card-body">
          <p class="help">This site does not host the vendor's installers. For firmware flashing, the mobile apps or the original tool, use RAWM's own pages:</p>
          <div class="dl-row">
            <span class="dl-icon">${icon('monitor')}</span>
            <div class="dl-main"><div class="t">Desktop app · Windows / macOS</div><div class="s">Official RAWM HUB v3 · firmware flashing</div></div>
            <a class="btn btn-ghost btn-sm" href="${VENDOR_HUB}" target="_blank" rel="noopener">rawmtech.com</a>
          </div>
          <div class="dl-row">
            <span class="dl-icon">${icon('globe')}</span>
            <div class="dl-main"><div class="t">Vendor web configurator</div><div class="s">The original browser tool this project rebuilds</div></div>
            <a class="btn btn-ghost btn-sm" href="${VENDOR_WEB}" target="_blank" rel="noopener">rawmtech.com</a>
          </div>
          <div class="dl-row">
            <span class="dl-icon">${icon('download')}</span>
            <div class="dl-main"><div class="t">Download center</div><div class="s">Android APK, iOS app and manuals</div></div>
            <a class="btn btn-ghost btn-sm" href="${VENDOR_DOWNLOADS}" target="_blank" rel="noopener">rawmshop.com</a>
          </div>
          <div class="notice" style="margin-top:12px">${icon('alert')}<span>Firmware updates are not supported here. Flash firmware with the official desktop app first, then configure the device in this page.</span></div>
        </div>
      </section>
    </div>

    <div class="grid g-2" style="margin-top:14px">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('github')}<div><h2>GitHub repository</h2><p>Source code, releases and issues</p></div></div><span class="pill">OPEN SOURCE</span></div>
        <div class="card-body">
          <p class="help">If this tool helped you, star the repo — it makes the project easier for other RAWM owners to find.</p>
          <div class="kv" style="margin-top:10px"><span class="k">Repository</span><a class="v" href="${REPO_URL}" target="_blank" rel="noopener">thinhphoenix/better-rawmhub</a></div>
          <div class="kv"><span class="k">Issues</span><a class="v" href="${REPO_URL}/issues" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}/issues</a></div>
          <div class="row" style="margin-top:14px;flex-wrap:wrap">
            <a class="btn btn-primary btn-sm" href="${REPO_URL}" target="_blank" rel="noopener">${icon('github')}<span>Star on GitHub</span><span class="star-count" data-star-count hidden><span data-star-value></span><svg class="ic star-glyph" aria-hidden="true"><use href="#i-star"/></svg></span></a>
            <a class="btn btn-ghost btn-sm" href="${REPO_URL}" target="_blank" rel="noopener">${icon('github')}<span>View source</span></a>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('bug')}<div><h2>Report the app</h2><p>Bugs and feature requests go to GitHub Issues</p></div></div></div>
        <div class="card-body">
          <p class="help">The issue opens pre-filled with your app version, browser and connected device. For device bugs, paste the HID console log too.</p>
          <div class="row" style="margin-top:14px;flex-wrap:wrap">
            <a class="btn btn-primary btn-sm" href="${issueLink('bug')}" target="_blank" rel="noopener">${icon('bug')}<span>Report a bug</span></a>
            <a class="btn btn-ghost btn-sm" href="${issueLink('feature')}" target="_blank" rel="noopener">${icon('plus')}<span>Request a feature</span></a>
          </div>
          <div class="kv" style="margin-top:12px"><span class="k">All issues</span><a class="v" href="${REPO_URL}/issues" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}/issues</a></div>
        </div>
      </section>
    </div>

    <section class="card" style="margin-top:14px">
      <div class="card-head"><div class="ch-title">${icon('globe')}<div><h2>Credits &amp; disclaimer</h2><p>Unofficial project, not affiliated with RAWM</p></div></div><span class="pill">v${esc(version)}</span></div>
      <div class="card-body">
        <p class="help">Supported controls include DPI stages with per-stage colours, polling rate, lift-off distance, angle tuning, ripple control, motion sync, glass mode, lighting modes and brightness, button remapping, advanced keys and macros for every device in the vendor catalogue.</p>
        <p class="help" style="margin-top:10px">This is an unofficial community rebuild, not affiliated with or endorsed by RAWM. RAWM, RAWM HUB and the device renders belong to RAWM / Shenzhen Renmo Electronic Technology; product images and the device catalogue are loaded from the vendor's CDN.</p>
        <div class="kv" style="margin-top:12px"><span class="k">Vendor</span><a class="v" href="https://www.rawmtech.com/" target="_blank" rel="noopener">rawmtech.com</a></div>
        <div class="kv"><span class="k">Source</span><a class="v" href="${REPO_URL}" target="_blank" rel="noopener">thinhphoenix/better-rawmhub</a></div>
        <div class="kv"><span class="k">App version</span><span class="v">v${esc(version)}</span></div>
      </div>
    </section>`;
  }

  /* ── Loading skeleton ──────────────────────────────────────────────── */
  function loadingView() {
    const p = state.profile || {};
    const noReply = state.handshake === 'timeout';
    const broken = state.handshake === 'error';
    const label = noReply ? 'NO REPLY' : broken ? 'READ ERROR' : 'READING DEVICE';
    const note = noReply
      ? `<div class="notice warn">${icon('alert')}<span><strong>The device did not answer the query.</strong> Close RAWM HUB desktop if it is running, switch the mouse to 2.4 GHz or plug the cable in, then try again. <button class="link-btn" data-action="handshake">Send query again</button></span></div>`
      : broken
        ? `<div class="notice danger">${icon('alert')}<span><strong>This HID interface is read-only over WebHID.</strong> Pick another RAWM interface in the browser prompt, or connect the mouse with a cable.</span></div>`
        : `<div class="notice">${icon('info')}<span>Reading the configuration from the device. Nothing is shown until the device answers, so no value here is a guess. <button class="link-btn" data-action="handshake">Send query again</button></span></div>`;

    /* The skeleton reuses the real layout classes, so nothing jumps when the
       answer arrives: same hero grid, same stat cells, same cards. */
    const ln = (w, h = 10, extra = '') => `<span class="skel-line" style="width:${w}%;height:${h}px;${extra}"></span>`;
    const statCell = () => `<div class="stat">
        <div class="stat-label">${ln(48, 8)}<span class="skel-dot" style="width:13px;height:13px"></span></div>
        ${ln(62, 25, 'margin-top:9px;border-radius:5px')}
        <div class="stat-bar"><i style="width:0"></i></div>
      </div>`;
    const head = (glyph, title) => `<div class="card-head"><div class="ch-title">${icon(glyph)}<div><h2>${title}</h2>${ln(44, 8, 'margin-top:5px')}</div></div></div>`;
    const stages = Array.from({ length: 4 }).map(() => `<div class="dpi-stage"><span class="skel-box" style="display:block;height:46px;border-radius:4px"></span></div>`).join('');
    const chips = Array.from({ length: 4 }).map(() => `<span class="skel-box" style="height:30px;border-radius:4px"></span>`).join('');
    const slots = Array.from({ length: 5 }).map(() => `<div class="profile-tile"><span class="skel-line" style="width:40%;height:8px"></span><span class="skel-line" style="width:70%;height:10px;margin-top:7px"></span><span class="skel-line" style="width:100%;height:4px;margin-top:10px"></span></div>`).join('');
    const kv = () => `<div class="kv"><span class="skel-line" style="width:32%;height:8px"></span><span class="skel-line" style="width:26%;height:8px"></span></div>`;

    return `
    ${pageHead('Device overview', esc(p.title || 'RAWM device'),
      'Reading the configuration from the device.',
      `<span class="pill accent">${label}</span><button class="btn btn-danger btn-sm" data-action="disconnect">Disconnect</button>`)}
    ${note}

    <section class="card hero">
      <div class="hero-stage">
        <div class="stage-tags">
          <span class="tag accent"><span class="dot on"></span>${label}</span>
          <span class="tag">${ln(38, 8, 'width:38px')}</span>
        </div>
        <span class="skel-box" style="width:min(64%, 300px);height:280px;border-radius:10px"></span>
        <span class="skel-line" style="position:absolute;left:20px;bottom:18px;width:150px;height:9px"></span>
      </div>
      <div class="hero-panel">
        <div class="hero-id">
          ${ln(18, 8)}
          ${ln(58, 24, 'margin-top:12px;border-radius:5px')}
          <div class="meta">
            <span class="skel-box" style="width:84px;height:25px;border-radius:4px"></span>
            <span class="skel-box" style="width:104px;height:25px;border-radius:4px"></span>
            <span class="skel-box" style="width:64px;height:25px;border-radius:4px"></span>
          </div>
        </div>
        <div class="stat-grid">${statCell()}${statCell()}${statCell()}${statCell()}</div>
      </div>
    </section>

    <div class="grid g-3" style="margin-top:14px">
      <section class="card">
        ${head('sliders', 'Sensitivity')}
        <div class="card-body">
          ${ln(46, 42, 'border-radius:6px')}
          <div class="dpi-stages">${stages}</div>
          ${ln(34, 10, 'margin-top:14px')}
        </div>
      </section>
      <section class="card">
        ${head('wave', 'Polling rate')}
        <div class="card-body">
          ${ln(34, 42, 'border-radius:6px')}
          <div class="seg-wrap" style="margin-top:14px;display:grid;grid-template-columns:repeat(4,1fr)">${chips}</div>
          ${ln(62, 8, 'margin-top:14px')}
        </div>
      </section>
      <section class="card">
        ${head('bulb', 'Lighting')}
        <div class="card-body">
          <span class="skel-box" style="display:block;height:118px;border-radius:9px"></span>
          ${ln(38, 10, 'margin-top:14px')}
        </div>
      </section>
    </div>

    <div class="split split-even" style="margin-top:14px">
      <section class="card">
        ${head('chip', 'Onboard profiles')}
        <div class="card-body">
          <div class="profiles">${slots}</div>
          <div class="setting-row" style="margin-top:16px">
            <div class="sr-main">${ln(34, 10)}<span class="skel-line" style="display:block;width:64%;height:8px;margin-top:7px"></span></div>
            <span class="skel-box" style="width:40px;height:20px;border-radius:100px"></span>
          </div>
        </div>
      </section>
      <section class="card stretch">
        ${head('info', 'Device details')}
        <div class="card-body">${kv()}${kv()}${kv()}${kv()}${kv()}</div>
      </section>
    </div>`;
  }

  /* ── Router / shell ────────────────────────────────────────────────── */
  const PAGE_TITLES = {
    device: 'Device', buttons: 'Buttons', performance: 'Performance', lighting: 'Lighting',
    advanced: 'Advanced keys', macros: 'Macros', firmware: 'Firmware', about: 'About',
  };
  /* The Downloads page became About; keep old hash links working. */
  const LEGACY_PAGES = { downloads: 'about' };
  const PAGE_GATE = ['device', 'buttons', 'performance', 'lighting', 'advanced', 'macros', 'firmware'];

  function render() {
    if (window.__antCleanup) window.__antCleanup();
    const page = state.page;
    const gated = PAGE_GATE.includes(page) && !state.connected;
    // Connected but the device has not answered the query yet: show a skeleton
    // instead of a view built from catalogue defaults, which would look like
    // real (wrong) DPI / polling values.
    const pending = state.connected && state.handshake !== 'ready' && PAGE_GATE.includes(page);
    const html = gated ? connectView() : pending ? loadingView() : ({
      device: deviceView,
      buttons: buttonsView,
      performance: performanceView,
      lighting: lightingView,
      advanced: advancedView,
      macros: macrosView,
      firmware: firmwareView,
      about: aboutView,
    }[page] || deviceView)();

    $('#view').innerHTML = html;

    $$('#nav-main .nav-item, #nav-system .nav-item').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.page === page);
    });
    const lightNav = $('.nav-item[data-page="lighting"]');
    if (lightNav) {
      const noLight = !!(state.connected && state.profile && !state.profile.light);
      lightNav.disabled = noLight;
      lightNav.classList.toggle('is-disabled', noLight);
    }
    $('#crumb-section').textContent = PAGE_TITLES[page] || 'Device';
    const tr = window.RAWM_I18N ? window.RAWM_I18N.t : (s) => s;
    const pageLabel = page === 'device' ? tr('RAWM mouse & keyboard configurator') : tr(PAGE_TITLES[page] || 'Device');
    document.title = state.connected && state.profile
      ? `Better RAWM Hub — ${tr(PAGE_TITLES[page])} · ${state.profile.title}`
      : `Better RAWM Hub — ${pageLabel}`;

    const fw = $('#fw-channel');
    if (fw) fw.value = String((state.cfg && state.cfg.fwChannel) || 0);

    const pill = $('#conn-pill');
    if (pill) {
      const battery = state.info && Number.isFinite(Number(state.info.battery)) ? Number(state.info.battery) : null;
      const stateLabel = state.handshake === 'ready' ? 'CONNECTED' : state.handshake === 'timeout' ? 'NO REPLY' : 'CONNECTING';
      pill.innerHTML = state.connected
        ? `<span class="dot on"></span><span>${stateLabel}</span>${battery != null ? `<span class="pill-batt">${batterySlot(battery, 12)}<span>${battery}%</span></span>` : ''}`
        : `<span class="dot"></span><span>NO DEVICE</span>`;
    }

    if (state.dirty && state.connected && state.cfg) scheduleLiveApply();

    renderRailDevice();

    if (state.logOpen) renderLog();
    updateRangeFills();
    paintStarCount();
    if (window.RAWM_I18N) window.RAWM_I18N.apply(document.body);
    if (window.__antMount) window.__antMount();
  }

  let railBattery = null;

  function renderRailDevice() {
    const el = $('#rail-device');
    if (!el) return;
    if (!state.connected || !state.profile) { el.innerHTML = ''; railBattery = null; return; }
    const p = state.profile;
    const battery = state.info && state.info.battery != null ? state.info.battery : null;
    railBattery = battery;
    el.innerHTML = `<button class="mini-device" data-page="device" style="width:100%;text-align:left" title="${esc(p.title)}">
      ${img(productImage(p), 'device-render', p.title)}
      <span style="min-width:0">
        <span class="md-name" style="display:block">${esc(p.title)}</span>
        <span class="md-sub"><span class="dot on"></span>${state.handshake === 'ready' ? 'CONNECTED' : state.handshake === 'timeout' ? 'NO REPLY' : 'CONNECTING'}</span>
      </span>
      <span class="md-batt">${battery != null ? `${batterySlot(Number(battery), 14)}<span>${battery}%</span>` : ''}</span>
    </button>`;
  }

  function updateRangeFills() {
    $$('input.range').forEach((r) => {
      const min = Number(r.min) || 0;
      const max = Number(r.max) || 100;
      const val = Number(r.value) || 0;
      r.style.setProperty('--pct', clamp(((val - min) / (max - min)) * 100, 0, 100) + '%');
    });
  }

  function go(page) {
    page = LEGACY_PAGES[page] || page;
    if (!PAGE_TITLES[page]) page = 'device';
    state.page = page;
    state.capturing = false;
    if (location.hash !== '#/' + page) history.replaceState(null, '', '#/' + page);
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  /* ── Device open / close ───────────────────────────────────────────── */
  async function connectDevice() {
    if (state.busy) return;
    state.busy = true;
    try {
      const picked = await RAWM.Transport.request();
      if (!picked.length) { state.busy = false; return; }
      state.bridgeProblem = null;
      const pid = Number(picked[0].productId).toString(16).padStart(4, '0');
      const authorised = await RAWM.Transport.authorised();
      const pool = [...picked, ...authorised.filter((d) => Number(d.productId) === Number(picked[0].productId))];
      // WebHID can expose several collections per product; pick the one that
      // can be written to. The bridge already sorts vendor interfaces first.
      const writable = picked[0].bridge
        ? picked[0]
        : pool.find((d) => (d.collections || []).some((c) => (c.outputReports || []).length > 0 || (c.featureReports || []).length > 0));
      const hid = writable || picked[0];
      addLog('info', `HID candidates: ${pool.map((d) => `${d.productName || 'device'} (${(d.collections || []).length} collections)`).join(' · ')}`);
      const known = byProduct(pid);
      const profile = known ? { ...known } : {
        title: hid.productName || 'RAWM device',
        product_id: pid,
        vendor_id: '1915',
        kind: 'mouse',
        polling_rates: [125, 250, 500, 1000, 2000, 4000, 8000],
        cpi_levels: [400, 800, 1600, 3200],
        cpi_range: [50, 30000],
        cpi_step: 50,
        power_modes: ['LP', 'HP'],
        lods: ['Low', 'High'],
      };
      if (!known && /receiver|dongle/i.test(hid.productName || '')) profile.receiver = true;
      state.profile = profile;
      state.connected = true;
      state.handshake = 'waiting';
      state.dirty = false;
      state.cfg = makeConfig(profile, null);
      state.selectedKey = profile.keyboard ? 'A' : (profile.keys && profile.keys[0] ? profile.keys[0].name : null);
      await transport.connect(hid, profile);
      addLog('info', `product ${pid} — ${profile.title}${known ? '' : ' (unknown, generic profile)'}${profile.receiver ? ' · receiver' : ''}`);
      go('device');
      toast(`Connected · ${profile.title}`, 'ok');
    } catch (err) {
      state.connected = false;
      state.handshake = 'idle';
      state.profile = null;
      state.cfg = null;
      if (err && err.name === 'NotFoundError') {
        toast('No device selected', 'err');
      } else if (err && err.code === 'pair-required') {
        state.bridgeProblem = 'pair';
        addLog('err', 'bridge: this page is not paired yet');
        openBridgePair();
      } else if (err && err.code === 'no-daemon') {
        state.bridgeProblem = 'down';
        if (location.protocol === 'file:') {
          toast('Serve this page over http(s) — a file:// page cannot reach the bridge', 'err');
        } else {
          toast('Bridge not running — start better-rawmhub-bridge, then try again', 'err');
        }
        addLog('err', `bridge unavailable: ${err.message}`);
      } else if (err && err.code === 'no-device') {
        toast('No RAWM device found — check 2.4 GHz mode or the cable', 'err');
        addLog('err', err.message);
      } else if (err && err.code === 'device-busy') {
        toast('Another tab already has this device open', 'err');
      } else if (err && err.name === 'SecurityError') {
        toast('Permission was blocked by the browser', 'err');
        addLog('err', err.message);
      } else if (location.protocol === 'file:') {
        toast('The device needs localhost or https:// — serve the folder first', 'err');
        addLog('err', 'file:// origin cannot reach the device; run python -m http.server 8080');
      } else {
        toast(err.message || 'Could not open device', 'err');
        addLog('err', String((err && err.message) || err));
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  let reconnectTimer = null;

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    let tries = 0;
    const tick = async () => {
      if (!state.connected) return;
      tries++;
      try {
        const ok = await transport.reconnect();
        if (ok) {
          state.handshake = 'waiting';
          render();
          toast('Device reconnected', 'ok');
          return;
        }
      } catch (err) {
        addLog('err', 'reconnect: ' + err.message);
      }
      if (tries < 8) reconnectTimer = setTimeout(tick, 1200);
      else toast('Device did not come back — click Connect', 'err');
    };
    reconnectTimer = setTimeout(tick, 1600);
  }

  function disconnectDevice(message = 'Device disconnected') {
    state.connected = false;
    state.handshake = 'idle';
    state.fwSwitching = false;
    clearTimeout(liveTimer);
    clearTimeout(saveTimer);
    transport.disconnect();
    clearTimeout(reconnectTimer);
    state.profile = null;
    state.info = null;
    state.cfg = null;
    state.dirty = false;
    state.capturing = false;
    toast(message, 'info');
    go('device');
  }

  /* ── Live apply ────────────────────────────────────────────────────── */
  // Every settings change is written to the device automatically: a short
  // debounce coalesces slider drags, then the onboard save follows once the
  // user stops interacting. There is no manual "Write to device" step.
  let liveTimer = 0;
  let saveTimer = 0;

  function writeLiveConfig() {
    state.cfg.lightByte = lightByte();
    transport.writeMouseConfig(state.cfg);
    if (state.profile && state.profile.light) transport.writeLight(state.cfg.lightByte);
    transport.writeBrightness(Math.round((state.cfg.brightness / 100) * 255));
    transport.writeSleep(Math.max(1, state.cfg.sleep) * 60);
  }

  function scheduleLiveApply(delay = 260) {
    if (!state.connected || !state.cfg) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (!state.connected || !state.cfg) return;
      try {
        writeLiveConfig();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 1200);
      } catch (err) {
        addLog('err', 'auto-apply: ' + (err.message || err));
      }
    }, delay);
  }

  function flushSave() {
    if (!state.connected || !state.cfg) return;
    try {
      transport.save();
      state.dirty = false;
      updateDirtyPill();
    } catch (err) {
      addLog('err', 'auto-save: ' + (err.message || err));
    }
  }

  /* ── Logging ───────────────────────────────────────────────────────── */
  function addLog(dir, msg) {
    state.log.unshift({ dir, msg, t: new Date() });
    if (state.log.length > 260) state.log.length = 260;
    if (state.logOpen) renderLog();
  }

  function renderLog() {
    const root = $('#log-body');
    if (!root) return;
    root.innerHTML = state.log.map((l) => {
      const time = l.t.toLocaleTimeString('en-GB', { hour12: false });
      const cls = l.dir === 'tx' ? 'tx' : l.dir === 'err' ? 'err' : l.dir === 'rx' ? 'rx' : '';
      return `<span class="time">${time}</span> <span class="${cls}">${l.dir.toUpperCase().padEnd(4, ' ')}</span> ${esc(l.msg)}`;
    }).join('\n') || 'Waiting for traffic…';
  }

  function openLog() {
    state.logOpen = true;
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-scrim" data-close="1">
      <div class="modal" role="dialog" aria-modal="true" aria-label="HID console">
        <div class="modal-head">
          <div class="row" style="gap:9px">${icon('terminal')}<h3>HID console</h3><span class="pill ${state.connected ? 'accent' : ''}"><span class="dot ${state.connected ? 'on' : ''}"></span>${state.connected ? 'LIVE' : 'IDLE'}</span></div>
          <button class="icon-btn" data-action="close-log" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="log" id="log-body"></div>
          <p class="help" style="margin-top:10px">TX is what this page sent to the device; RX is the raw report. The first four RX bytes are the receiver header. Report anything unexpected with the full log.</p>
        </div>
        <div class="modal-foot">
          <span class="help">${state.log.length} entries · VID 0x1915 · CRC ${transport.crc ? 'on' : 'off'}</span>
          <div class="row">
            <button class="btn btn-ghost btn-sm" data-action="clear-log">Clear</button>
            <button class="btn btn-ghost btn-sm" data-action="copy-log">${icon('copy')}<span>Copy</span></button>
            <button class="btn btn-primary btn-sm" data-action="close-log">Done</button>
          </div>
        </div>
      </div>
    </div>`;
    renderLog();
    if (window.RAWM_I18N) window.RAWM_I18N.apply(root);
    if (window.__antMount) window.__antMount(root);
  }

  function closeLog() {
    state.logOpen = false;
    $('#modal-root').innerHTML = '';
  }

  function closeModal() {
    state.logOpen = false;
    $('#modal-root').innerHTML = '';
  }

  /* ── Bridge pairing ────────────────────────────────────────────────── */

  function openBridgePair() {
    const root = $('#modal-root');
    const port = (window.RAWM_BRIDGE && window.RAWM_BRIDGE.PORT) || 47311;
    root.innerHTML = `<div class="modal-scrim" data-close="1">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Pair with the bridge">
        <div class="modal-head">
          <div class="row" style="gap:9px">${icon('link')}<h3>Pair with the bridge</h3></div>
          <button class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <p class="help">The bridge printed a six-digit code in its window. Type it here once — this browser is remembered after that.</p>
          <input class="input" id="bridge-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"
            style="margin-top:12px;letter-spacing:.35em;font-family:'JetBrains Mono',monospace;font-size:20px;text-align:center" />
          <p class="help" id="bridge-pair-error" style="color:var(--danger);margin-top:8px"></p>
        </div>
        <div class="modal-foot">
          <span class="help">127.0.0.1:${port}</span>
          <div class="row">
            <button class="btn btn-ghost btn-sm" data-action="close-modal">Cancel</button>
            <button class="btn btn-primary btn-sm" data-action="bridge-pair">Pair</button>
          </div>
        </div>
      </div>
    </div>`;
    const input = $('#bridge-code');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairBridge(); });
    }
  }

  async function pairBridge() {
    const input = $('#bridge-code');
    const error = $('#bridge-pair-error');
    const code = ((input && input.value) || '').replace(/\D/g, '');
    if (code.length !== 6) {
      if (error) error.textContent = 'Enter the six-digit code shown by the bridge.';
      return;
    }
    if (!window.RAWM_BRIDGE) return;
    try {
      await window.RAWM_BRIDGE.pair(code);
      closeModal();
      state.bridgeProblem = null;
      toast('Paired with the bridge', 'ok');
      connectDevice();
    } catch (err) {
      if (error) error.textContent = (err && err.message) || 'Pairing failed.';
      addLog('err', `bridge pairing: ${(err && err.message) || 'failed'}`);
    }
  }

  /* ── Toasts ────────────────────────────────────────────────────────── */
  let toastId = 0;
  function toast(message, kind = 'ok') {
    const root = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' err' : '');
    el.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check')}<span>${esc(message)}</span>`;
    root.appendChild(el);
    if (window.RAWM_I18N) window.RAWM_I18N.apply(el);
    el.dataset.id = String(++toastId);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, 3600);
  }

  /* ── Interactions ──────────────────────────────────────────────────── */
  function markDirty() {
    state.dirty = true;
    const pill = $('.page-head .pill[data-dirty-pill]');
    if (pill) {
      pill.textContent = 'Unsaved changes';
      pill.classList.add('accent');
      if (window.RAWM_I18N) window.RAWM_I18N.apply(pill);
    }
    scheduleLiveApply();
  }

  function updateDirtyPill() {
    $$('.page-head .pill[data-dirty-pill]').forEach((pill) => {
      pill.textContent = state.dirty ? 'Unsaved changes' : 'In sync';
      pill.classList.toggle('accent', !!state.dirty);
      if (window.RAWM_I18N) window.RAWM_I18N.apply(pill);
    });
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    const target = parts.reduce((o, k) => (o[k] == null ? (o[k] = {}) : o[k]), obj);
    target[last] = value;
  }

  /* Assignment helpers */
  function assignment() {
    const p = state.profile;
    const key = selectedKey();
    if (!p || !key) return null;
    if (!state.cfg.keys[key]) {
      const meta = (p.keys || []).find((k) => k.name === key);
      state.cfg.keys[key] = { type: 'key', label: meta ? keyFunction(p, meta) : key, mods: [], turbo: false, freq: 20, rand: 0, down: 0, up: 0 };
    }
    return state.cfg.keys[key];
  }

  function updateLive(bind, value) {
    $$(`[data-live="${bind}"]`).forEach((el) => {
      el.textContent = Math.abs(Number(value)) >= 1000 ? fmt(value) : value;
    });
    if (bind === 'cpiX') {
      const active = $('.dpi-stage.is-active .ds-v');
      if (active) active.textContent = fmt(value);
    }
  }

  function updateOut(input) {    const bind = input.dataset.bind;
    const kind = input.dataset.kind;
    const out = $(`[data-out="${bind}"]`);
    if (!out) return;
    let val = input.value;
    if (kind === 'int' || kind === 'float') {
      val = Number(val);
      if (Math.abs(val) >= 1000) val = fmt(val);
    }
    const suffix = out.textContent.replace(/^-?[\d,.]+/, '');
    out.textContent = String(val) + suffix;
    if (input.type === 'range') {
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 100;
      input.style.setProperty('--pct', clamp(((Number(input.value) - min) / (max - min)) * 100, 0, 100) + '%');
    }
  }

  // Applies the current state to the already-rendered DOM. Settings changes use
  // this instead of a full render so images, Ant Design controls and scroll
  // position stay untouched (no blink between edits).
  function refreshSettingsUi() {
    const c = state.cfg;
    if (!c) return;
    updateDirtyPill();

    const text = (key, value) => $$(`[data-live="${key}"]`).forEach((el) => { el.textContent = value; });
    const out = (bind, value) => $$(`[data-out="${bind}"]`).forEach((el) => {
      const suffix = el.textContent.replace(/^-?[\d,.]+/, '');
      el.textContent = (Math.abs(Number(value)) >= 1000 ? fmt(value) : value) + suffix;
    });

    text('cpiX', fmt(c.cpiX));
    if (c.xy) text('cpiY', fmt(c.cpiY));
    text('polling', fmt(c.polling));
    text('brightness', String(c.brightness));
    text('speed', String(c.speed));
    out('cpiX', c.cpiX);
    if (c.xy) out('cpiY', c.cpiY);
    out('brightness', c.brightness);
    out('speed', c.speed);

    const info = state.info || {};
    const battery = Number.isFinite(Number(info.battery)) ? Number(info.battery) : null;
    const charging = Number(info.chg ?? info.charging ?? 0) === 1;
    const profileEl = $('[data-live="profile"]');
    if (profileEl) profileEl.textContent = String((c.onboard | 0) + 1);
    $$('[data-live="battery"]').forEach((el) => { el.textContent = battery != null ? String(battery) : '—'; });
    $$('[data-live="battery-tag"]').forEach((el) => {
      el.textContent = battery != null ? `${battery}%${charging ? ' · charging' : ''}` : 'wired';
    });
    $$('[data-live="battery-pct"]').forEach((el) => { el.textContent = battery != null ? `${battery}%` : '—'; });
    /* Repaint every gauge with the new level, keeping each slot's own size. */
    $$('[data-batt-icon]').forEach((el) => {
      el.innerHTML = batteryIcon(battery, Number(el.dataset.battSize) || 14);
    });
    if (battery !== railBattery) renderRailDevice();
    const batteryUnit = $('[data-live="battery"]') && $('[data-live="battery"]').nextElementSibling;
    if (batteryUnit) batteryUnit.textContent = battery != null ? '%' + (charging ? ' · chg' : '') : 'wired';

    const p = state.profile || {};
    const setBar = (name, pct, colour) => $$(`[data-bar="${name}"]`).forEach((i) => {
      i.style.width = clamp(pct, 0, 100) + '%';
      i.style.background = colour || '';
    });
    setBar('cpi', (c.cpiX / ((p.cpi_range && p.cpi_range[1]) || 30000)) * 100);
    setBar('polling', (c.polling / 8000) * 100);
    if ($('[data-bar="battery"]')) setBar('battery', battery || 0, battery != null ? batteryTone(battery) : '');
    if ($('[data-bar="battery-power"]')) setBar('battery-power', battery || 0, battery != null ? batteryTone(battery) : '');
    if ($('[data-bar="profile"]')) setBar('profile', (((c.onboard | 0) + 1) / (c.onboardMax || 5)) * 100);

    $$('.dpi-stage[data-index]').forEach((el) => {
      const i = Number(el.dataset.index);
      el.classList.toggle('is-active', i === c.activeLevel);
      const v = el.querySelector('.ds-v');
      if (v && c.dpiLevels[i] != null) v.textContent = fmt(c.dpiLevels[i]);
      const dot = el.querySelector('.ds-dot');
      if (dot) dot.style.setProperty('--c', stageColor(i));
    });
    const stageLabel = $('[data-live="active-stage"]');
    if (stageLabel) stageLabel.textContent = String(c.activeLevel + 1).padStart(2, '0');
    $$('[data-action="stage-color"]').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.bits) === stageBits(c.activeLevel));
    });

    const syncRange = (bind, value) => {
      $$(`input.range[data-bind="${bind}"]`).forEach((input) => {
        if (Number(input.value) === Number(value)) return;
        input.value = value;
        const lo = Number(input.min) || 0;
        const hi = Number(input.max) || 100;
        input.style.setProperty('--pct', clamp(((Number(value) - lo) / (hi - lo)) * 100, 0, 100) + '%');
        if (window.__antSyncValue) window.__antSyncValue(bind, value);
      });
    };
    syncRange('cpiX', c.cpiX);
    if (c.xy) syncRange('cpiY', c.cpiY);
    syncRange('brightness', c.brightness);
    syncRange('speed', c.speed);

    const setActive = (selector, attr, value) => $$(selector).forEach((el) => {
      el.classList.toggle('is-active', String(el.dataset[attr]) === String(value));
    });
    setActive('[data-action="polling"]', 'value', c.polling);
    setActive('[data-action="lod"]', 'value', c.lod);
    setActive('[data-action="power"]', 'value', c.powerMode);
    setActive('[data-action="turbo-mode"]', 'value', c.wireless && c.wireless.mode);
    setActive('[data-action="onboard"]', 'index', c.onboard);
    setActive('[data-action="light-mode"]', 'mode', c.lightMode);
    $$('[data-action="color"]').forEach((el) => {
      el.classList.toggle('is-active', String(el.dataset.color).toLowerCase() === String(c.color).toLowerCase());
    });

    const preset = LIGHT_PRESETS.find((l) => l.mode === c.lightMode) || LIGHT_PRESETS[0];
    $$('.light-stage').forEach((el) => el.style.setProperty('--glow', c.color));
    $$('.light-glow').forEach((el) => {
      el.style.background = `radial-gradient(50% 80% at 50% 50%, ${c.color}33, transparent 70%)`;
    });
    text('light-mode-name', preset.name);
    text('light-mode-upper', preset.name.toUpperCase());
    text('color-hex', c.color.toUpperCase());
    $$('[data-live="light-mode-upper"]').forEach((el) => { el.parentElement.style.color = c.color; });
    $$('[data-action="light-mode"] .mt-preview').forEach((el) => {
      if (el.closest('[data-mode="steady"]')) el.style.background = c.color;
    });
    $$('.zone-row .zr-dot').forEach((el) => el.style.setProperty('--zc', c.color));

    $$('.pk[data-index]').forEach((el) => {
      const i = Number(el.dataset.index);
      const col = c.painted && c.painted[i];
      el.classList.toggle('is-active', !!col);
      el.style.setProperty('--c', col || '#171b21');
    });
    if (window.RAWM_I18N) window.RAWM_I18N.apply($('#view'));
  }

  document.addEventListener('click', (e) => {
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) { go(pageBtn.dataset.page); return; }

    const el = e.target.closest('[data-action]');
    if (!el) {
      if (e.target.closest('[data-close]') && !e.target.closest('.modal')) closeLog();
      return;
    }
    const action = el.dataset.action;
    const p = state.profile;
    const c = state.cfg;

    switch (action) {
      case 'connect': connectDevice(); break;
      case 'disconnect': disconnectDevice(); break;
      case 'device-color': setProductColor(p, el.dataset.color); break;
      case 'handshake':
        if (!state.connected) break;
        state.handshake = 'waiting';
        transport.query();
        render();
        toast('Query sent to the device', 'info');
        break;

      case 'select-key': state.selectedKey = el.dataset.key; state.capturing = false; render(); break;
      case 'map-type': {
        const a = assignment(); if (!a) break;
        a.type = el.dataset.type; state.dirty = true; render();
        break;
      }
      case 'capture': state.capturing = !state.capturing; render(); break;
      case 'mod': {
        const a = assignment(); if (!a) break;
        a.mods = a.mods || [];
        const i = a.mods.indexOf(el.dataset.mod);
        if (i >= 0) a.mods.splice(i, 1); else a.mods.push(el.dataset.mod);
        state.dirty = true; render();
        break;
      }
      case 'stage-mapping': {
        const a = assignment(); if (!a) break;
        if (!a.mods || !a.mods.length) { /* keep */ }
        a.label = [ ...(a.mods || []), a.label ].filter(Boolean).join(' + ');
        a.mods = [];
        state.dirty = true; render(); toast('Mapping staged', 'ok');
        break;
      }
      case 'reset-key': {
        const key = selectedKey();
        if (key && c.keys) delete c.keys[key];
        state.dirty = true; render(); toast('Button reset', 'info');
        break;
      }

      case 'dpi-stage': {
        const i = Number(el.dataset.index);
        c.activeLevel = i;
        c.cpiX = c.dpiLevels[i] || c.cpiX;
        if (!c.xy) c.cpiY = c.cpiX;
        markDirty(); refreshSettingsUi();
        break;
      }
      case 'dpi-add': {
        if (c.dpiLevels.length >= 8) break;
        const last = c.dpiLevels[c.dpiLevels.length - 1] || 800;
        c.dpiLevels.push(Math.min((p.cpi_range && p.cpi_range[1]) || 30000, last + 800));
        c.levelColors = Array.isArray(c.levelColors) ? c.levelColors.slice(0, 8) : DEFAULTS.levelColors.slice();
        while (c.levelColors.length < 8) c.levelColors.push(0);
        const nextBits = [1, 2, 6, 4, 5, 3, 7, 7][c.dpiLevels.length - 1] || 1;
        if (!c.levelColors[c.dpiLevels.length - 1]) c.levelColors[c.dpiLevels.length - 1] = nextBits;
        c.activeLevel = c.dpiLevels.length - 1;
        markDirty(); render();
        break;
      }
      case 'dpi-remove': {
        if (c.dpiLevels.length <= 1) break;
        const removed = c.dpiLevels.length - 1;
        c.dpiLevels.pop();
        if (Array.isArray(c.levelColors)) c.levelColors[removed] = 0;
        c.activeLevel = Math.min(c.activeLevel, c.dpiLevels.length - 1);
        c.cpiX = c.dpiLevels[c.activeLevel];
        markDirty(); render();
        break;
      }
      case 'dpi-step': {
        const d = Number(el.dataset.delta);
        const max = (p.cpi_range && p.cpi_range[1]) || 30000;
        const min = (p.cpi_range && p.cpi_range[0]) || 50;
        const step = p.cpi_step || 50;
        c.cpiX = clamp(Math.round((c.cpiX + d) / step) * step, min, max);
        if (!c.xy) c.cpiY = c.cpiX;
        c.dpiLevels[c.activeLevel] = c.cpiX;
        markDirty(); refreshSettingsUi();
        break;
      }
      case 'dpi-reset': {
        c.dpiLevels = ((p && p.cpi_levels) || DEFAULTS.dpiLevels).filter((n) => n > 0);
        c.levelColors = DEFAULTS.levelColors.slice();
        c.activeLevel = Math.min(2, c.dpiLevels.length - 1);
        c.cpiX = c.cpiY = c.dpiLevels[c.activeLevel];
        markDirty(); render();
        break;
      }
      case 'stage-color': {
        const bits = Number(el.dataset.bits) & 0x07;
        c.levelColors = Array.isArray(c.levelColors) ? c.levelColors.slice(0, 8) : DEFAULTS.levelColors.slice();
        while (c.levelColors.length < 8) c.levelColors.push(0);
        c.levelColors[c.activeLevel] = bits;
        markDirty(); refreshSettingsUi();
        break;
      }
      case 'polling': c.polling = Number(el.dataset.value); markDirty(); refreshSettingsUi(); break;
      case 'lod': c.lod = Number(el.dataset.value); markDirty(); refreshSettingsUi(); break;
      case 'power': c.powerMode = Number(el.dataset.value); markDirty(); refreshSettingsUi(); break;
      case 'turbo-mode': c.wireless.mode = Number(el.dataset.value); markDirty(); refreshSettingsUi(); break;

      case 'light-mode': c.lightMode = el.dataset.mode; markDirty(); refreshSettingsUi(); break;
      case 'color': c.color = el.dataset.color; markDirty(); refreshSettingsUi(); break;
      case 'paint': {
        c.painted = c.painted || {};
        c.painted[el.dataset.index] = c.color;
        markDirty(); refreshSettingsUi();
        break;
      }
      case 'onboard': c.onboard = Number(el.dataset.index); markDirty(); refreshSettingsUi(); break;

      case 'adv-tab': state.advTab = el.dataset.tab; render(); break;
      case 'stage-advanced': toast('Advanced key rule staged', 'ok'); break;

      case 'macro-select': state.macro = Number(el.dataset.index); render(); break;
      case 'macro-add': {
        c.macros.push({ name: 'New macro', trigger: 'Hold', actions: [{ type: 'Delay', value: '', delay: 100 }] });
        state.macro = c.macros.length - 1; state.dirty = true; render();
        break;
      }
      case 'macro-delete': {
        if (c.macros.length <= 1) break;
        c.macros.splice(state.macro, 1);
        state.macro = Math.max(0, state.macro - 1);
        state.dirty = true; render();
        break;
      }
      case 'macro-action-add': {
        const m = c.macros[state.macro];
        m.actions.push({ type: 'Key down', value: '', delay: 0 });
        state.dirty = true; render();
        break;
      }
      case 'macro-action-delay': {
        const m = c.macros[state.macro];
        m.actions.push({ type: 'Delay', value: '', delay: 50 });
        state.dirty = true; render();
        break;
      }
      case 'macro-action-remove': {
        const m = c.macros[state.macro];
        m.actions.splice(Number(el.dataset.index), 1);
        state.dirty = true; render();
        break;
      }
      case 'capture-macro': state.capturing = !state.capturing; render(); break;
      case 'stage-macro': toast('Macro saved to profile', 'ok'); state.dirty = false; render(); break;

      case 'factory-reset': {
        $('#modal-root').innerHTML = `<div class="modal-scrim" data-close="1">
          <div class="modal" style="max-width:440px">
            <div class="modal-head"><div class="row" style="gap:9px">${icon('alert')}<h3>Restore factory defaults?</h3></div><button class="icon-btn" data-close="1">${icon('x')}</button></div>
            <div class="modal-body"><p class="help">This erases every profile, DPI stage, lighting scene and macro stored on the device. It cannot be undone.</p></div>
            <div class="modal-foot"><button class="btn btn-ghost btn-sm" data-close="1">Cancel</button><button class="btn btn-danger btn-sm" data-action="confirm-reset">Erase device</button></div>
          </div>
        </div>`;
        if (window.__antMount) window.__antMount($('#modal-root'));
        break;
      }
      case 'confirm-reset': {
        $('#modal-root').innerHTML = '';
        transport.restore();
        toast('Restore command sent', 'info');
        break;
      }

      case 'open-log': openLog(); break;
      case 'close-log': closeLog(); break;
      case 'close-modal': closeModal(); break;
      case 'bridge-pair': pairBridge(); break;
      case 'bridge-pair-open': openBridgePair(); break;
      case 'bridge-retry': connectDevice(); break;
      case 'bridge-forget':
        if (window.RAWM_BRIDGE) window.RAWM_BRIDGE.forget();
        state.bridgeProblem = null;
        render();
        toast('Pairing forgotten — the next connect asks for a code', 'info');
        break;
      case 'clear-log': state.log = []; renderLog(); break;
      case 'copy-log': {
        const text = state.log.map((l) => `${l.t.toISOString()} ${l.dir.toUpperCase()} ${l.msg}`).join('\n');
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Log copied', 'ok')).catch(() => toast('Copy failed', 'err'));
        break;
      }
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return;
    const bind = input.dataset.bind;
    if (!bind) return;
    if (!state.cfg) return;

    const kind = input.dataset.kind;

    if (bind === 'assignment.label' || bind === 'assignment.freq' || bind === 'assignment.rand' || bind === 'assignment.down' || bind === 'assignment.up' ||
        bind === 'assignment.macro' || bind === 'assignment.fn' || bind === 'assignment.turbo') {
      const a = assignment(); if (!a) return;
      const field = bind.split('.')[1];
      a[field] = kind === 'bool' ? input.checked : kind === 'int' ? Number(input.value) : input.value;
      if (['assignment.freq', 'assignment.rand', 'assignment.down', 'assignment.up'].includes(bind)) return;
      markDirty();
      return;
    }
    if (bind.startsWith('macro.')) {
      const m = state.cfg.macros[state.macro];
      if (!m) return;
      if (bind === 'macro.name') m.name = input.value;
      if (bind === 'macro.trigger') m.trigger = input.value;
      if (bind === 'macro.action.value') m.actions[Number(input.dataset.index)].value = input.value;
      if (bind === 'macro.action.delay') m.actions[Number(input.dataset.index)].delay = Number(input.value);
      markDirty();
      return;
    }
    if (bind.startsWith('adv.')) {
      setPath(state.cfg, bind, kind === 'int' ? Number(input.value) : kind === 'float' ? Number(input.value) : input.value);
      markDirty();
      return;
    }
    if (!state.cfg) return;

    let value;
    if (kind === 'bool') value = input.checked;
    else if (kind === 'int') value = Math.round(Number(input.value));
    else if (kind === 'float') value = Number(input.value);
    else value = input.value;

    if (bind === 'cpiX') {
      state.cfg.cpiX = value;
      if (!state.cfg.xy) state.cfg.cpiY = value;
      if (state.cfg.dpiLevels[state.cfg.activeLevel] != null) state.cfg.dpiLevels[state.cfg.activeLevel] = value;
    } else if (bind === 'cpiY') {
      state.cfg.cpiY = value;
    } else if (bind === 'xy') {
      state.cfg.xy = value;
      if (!value) state.cfg.cpiY = state.cfg.cpiX;
      render();
      return;
    } else {
      setPath(state.cfg, bind, value);
    }
    if (bind === 'keyDelayMs') {
      const idx = (state.profile.keys || []).findIndex((k) => k.name === state.cfg.keyDelayKey);
      if (idx >= 0) state.cfg.keyDelay[idx] = value;
    }
    markDirty();
    updateLive(bind, value);
    updateOut(input);
    if (bind.startsWith('zones.')) { refreshSettingsUi(); return; }
  });

  document.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'lang-select') {
      const next = e.target.value;
      // Defer so React can finish the Select event before the tree is rebuilt.
      setTimeout(() => {
        if (window.RAWM_I18N) window.RAWM_I18N.setLang(next);
        render();
      }, 0);
      return;
    }
    if (e.target && e.target.id === 'fw-channel' && state.cfg) {
      const next = Number(e.target.value);
      state.cfg.fwChannel = next;
      if (state.connected) {
        state.fwSwitching = true;
        state.handshake = 'waiting';
        try {
          transport.writeGamingOnly(next === 1);
          transport.save();
          await transport.waitForIdle(1500);
          transport.reboot();
          await transport.waitForIdle(700);
        } catch (err) {
          addLog('err', 'fw channel: ' + (err.message || err));
        }
        disconnectDevice('Firmware channel changed — connect again to continue.');
      }
      return;
    }
    const input = e.target;
    if (input instanceof HTMLInputElement && input.type === 'checkbox' && input.dataset.bind && !input.dataset.kind) {
      // unbound switches
      return;
    }
  });

  /* Key capture */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !state.capturing && $('#modal-root').innerHTML) {
      $('#modal-root').innerHTML = '';
      state.logOpen = false;
      return;
    }
    if (!state.capturing) return;
    e.preventDefault();
    if (e.key === 'Escape') {
      state.capturing = false;
      render();
      return;
    }
    if (state.page === 'macros') {
      const m = state.cfg.macros[state.macro];
      const label = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.metaKey && 'Win', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join(' + ');
      m.actions.push({ type: 'Key down', value: label, delay: 0 }, { type: 'Key up', value: label, delay: 0 });
      state.capturing = false;
      state.dirty = true;
      render();
      toast(`Captured ${label}`, 'ok');
      return;
    }
    const a = assignment();
    if (!a) { state.capturing = false; return; }
    a.label = [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.metaKey && 'Win', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join(' + ');
    a.mods = [];
    a.type = 'key';
    state.capturing = false;
    state.dirty = true;
    render();
    toast(`Bound to ${a.label}`, 'ok');
  });

  /* Transport events */
  transport.addEventListener('info', (ev) => {
    const info = ev.detail;
    state.handshake = 'ready';

    // A receiver first reports itself; when the paired device answers on
    // channel 0, switch the UI to that product so its render/keys are used.
    if (info.pi != null) {
      const raw = typeof info.pi === 'number' ? info.pi.toString(16) : String(info.pi).replace(/^0x/i, '');
      const target = byProduct(raw.padStart(4, '0')) ||
        (info.dn ? devices.find((d) => d.title.toLowerCase() === String(info.dn).toLowerCase()) : null);
      if (target && (!state.profile || target.product_id !== state.profile.product_id)) {
        state.profile = { ...target };
        state.cfg = makeConfig(state.profile, info);
        state.selectedKey = state.profile.keyboard ? 'A' : (state.profile.keys && state.profile.keys[0] ? state.profile.keys[0].name : null);
        addLog('info', `paired device · ${target.title}`);
      }
    }

    state.info = info;
    mergeInfo(info);
    if (info.dn && state.profile && state.profile.title !== info.dn) {
      // receiver reports the paired mouse name; keep it for display
      state.info.deviceName = info.dn;
    }
    render();
    toast('Device info received', 'ok');
    addLog('info', `battery ${info.battery != null ? info.battery + '%' : '—'} · fw ${info.r || '—'} · crc ${info.crc === 1 ? 'on' : 'off'}`);
  });
  transport.addEventListener('notify', (ev) => {
    const n = ev.detail;
    if (!state.info) state.info = {};
    if (n.battery != null) state.info.battery = n.battery;
    if (n.chg != null) state.info.chg = n.chg;
    if (n.cpi != null && state.cfg) state.cfg.cpiX = n.cpi & 0xffff;
    if (n.polling != null && state.cfg) state.cfg.polling = n.polling;
    refreshSettingsUi();
  });
  transport.addEventListener('peer', () => {
    addLog('info', 'receiver paired — querying the mouse on channel 0');
  });
  transport.addEventListener('nooutput', () => {
    state.handshake = 'error';
    addLog('err', 'this HID interface has no output/feature report — Chrome cannot write to it');
    render();
    toast('This HID interface is read-only over WebHID', 'err');
  });
  transport.addEventListener('gone', () => {
    if (state.fwSwitching) return;
    if (!state.connected) return;
    state.handshake = 'waiting';
    render();
    toast('Device disconnected — waiting for it to come back', 'info');
    scheduleReconnect();
  });
  transport.addEventListener('timeout', () => {
    if (!state.connected) return;
    state.handshake = 'timeout';
    addLog('err', 'handshake timed out — no query answer');
    render();
    toast('No reply from the device — open the console', 'err');
  });
  transport.addEventListener('error', (ev) => {
    if (!state.connected) return;
    state.handshake = 'error';
    const err = ev.detail;
    addLog('err', 'HID error: ' + ((err && err.message) || String(err || 'write rejected')));
    render();
    toast('HID write failed — open the console', 'err');
  });
  transport.addEventListener('open', () => {});

  /* Boot -------------------------------------------------------------- */
  function boot() {
    const params = new URLSearchParams(location.search);
    const rawHash = (location.hash || '').replace('#/', '');
    const hash = LEGACY_PAGES[rawHash] || rawHash;
    if (PAGE_TITLES[hash]) state.page = hash;

    const langSel = $('#lang-select');
    if (langSel && window.RAWM_I18N) langSel.value = window.RAWM_I18N.lang;

    render();
    loadStarCount();
    addLog('info', `RAWM HUB 2.0 · ${RAWM.Transport.native ? 'WebHID' : 'bridge'} ${RAWM.Transport.supported ? 'available' : 'unavailable'}`);
    if (!RAWM.Transport.supported) addLog('err', 'no HID transport — use Chrome/Edge, or install better-rawmhub-bridge');
  }

  window.addEventListener('hashchange', () => {
    const rawHash = (location.hash || '').replace('#/', '');
    const hash = LEGACY_PAGES[rawHash] || rawHash;
    if (PAGE_TITLES[hash] && hash !== state.page) { state.page = hash; render(); }
  });

  boot();
})();