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
    const model = Array.isArray(d.models) && d.models.length ? d.models[0] : null;
    const product = d.product_image || (kind === 'mouse' && model
      ? `https://hub.miracletek.net/hub/product/${d.product_id}/${model}/connected.png`
      : '');
    devices.push({
      ...d,
      key: d.product_id + ':' + rawTitle,
      title,
      image: product,
      kind,
    });
  }
  const byProduct = (id) => devices.find((d) => String(d.product_id).toLowerCase() === String(id).toLowerCase());

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
  };

  const transport = new RAWM.Transport((dir, msg) => addLog(dir, msg));

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
    levelColors: [4, 2, 3, 1],
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
  const MOUSE_FN = { M1: 'Left click', M2: 'Right click', M3: 'Middle click', M4: 'Back', M5: 'Forward', M6: 'DPI cycle', M7: 'Onboard profile' };

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
    if (Number.isFinite(Number(info.pr)) && Number(info.pr) > 0) cfg.polling = Number(info.pr);
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
  const PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 24 24" fill="none" stroke="#3c444e" stroke-width="1"><rect x="6.5" y="2.5" width="11" height="19" rx="5.5"/><path d="M12 2.6v6.2"/></svg>');
  const img = (src, cls = '', alt = '', kind = 'mouse') => src
    ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'"/>`
    : `<div class="${cls} device-placeholder">${icon(kind === 'keyboard' ? 'keys' : kind === 'receiver' ? 'chip' : 'mouse')}</div>`;

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
      M1: [36, 19], M2: [64, 19], M3: [50, 17], M4: [19, 57],
      M5: [19, 67], M6: [50, 55], M7: [50, 80], M8: [50, 90],
    };
    return `<div class="mouse-map">
      <div class="mouse-wrap">
        ${img(p.image, 'mouse-photo', p.title, p.kind)}
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

  function connectView() {
    const support = RAWM.Transport.supported;
    const hero = byProduct('234a') || devices.find((d) => d.kind === 'mouse') || null;
    const counts = {
      mice: devices.filter((d) => d.kind === 'mouse').length,
      keyboards: devices.filter((d) => d.kind === 'keyboard').length,
    };
    return `
    ${pageHead('WebHID configurator', 'Your gear, <span style="color:var(--accent)">dialed in</span>.',
      'Tune sensitivity, polling, lighting and key maps from the browser. Settings are written straight to the device — no driver, no installer, no account.',
      `<span class="pill">${counts.mice} mice · ${counts.keyboards} keyboards</span>`)}

    <div class="connect-solo">
      <section class="card connect-card">
        <div class="connect-stage">
          <div class="stage-tags"><span class="tag accent"><span class="dot on"></span>READY</span><span class="tag">WEBHID</span></div>
          ${img(hero ? hero.image : '', '', hero ? hero.title : 'RAWM mouse', hero ? hero.kind : 'mouse')}
        </div>
        <div class="connect-copy">
          <h2>Connect your device</h2>
          <p>Turn the mouse on and switch to <strong style="color:var(--text);font-weight:500">2.4 GHz</strong>, or plug it in with a USB cable. Then pick it from the browser prompt — Chromium browsers only.</p>
          <div class="row wrap">
            <button class="btn btn-primary btn-lg" data-action="connect" ${support ? '' : 'disabled'}>
              ${icon('link')}<span>Connect device</span>
            </button>
          </div>
          ${!support ? `<div class="browser-note">${icon('alert')}<span>This browser has no WebHID support. Use Chrome or Edge on desktop over <span class="mono">https://</span> or <span class="mono">localhost</span>.</span></div>` : ''}
          <div class="checklist">
            <div class="check-row"><span class="cr-n">1</span><span>Switch the device to <strong>2.4 GHz</strong>, or connect it with a USB cable.</span></div>
            <div class="check-row"><span class="cr-n">2</span><span>Choose the RAWM device in the browser's device picker.</span></div>
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
    const charging = !!Number(info.charging);
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
          ${battery != null ? `<span class="tag">${icon('battery')} ${battery}%${charging ? ' · charging' : ''}</span>` : ''}
        </div>
        ${img(p.image, 'hero-img', p.title, p.kind)}
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
        </div>
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label"><span>Sensitivity</span>${icon('sliders')}</div>
            <div class="stat-value"><span data-live="cpiX">${fmt(c.cpiX)}</span><small>${c.xy ? '× ' + fmt(c.cpiY) + ' dpi' : 'dpi'}</small></div>
            <div class="stat-bar"><i style="width:${clamp((c.cpiX / ((p.cpi_range && p.cpi_range[1]) || 30000)) * 100, 4, 100)}%"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Polling</span>${icon('wave')}</div>
            <div class="stat-value">${fmt(c.polling)}<small>hz</small></div>
            <div class="stat-bar"><i style="width:${clamp((c.polling / 8000) * 100, 4, 100)}%"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Battery</span>${icon('battery')}</div>
            <div class="stat-value">${battery != null ? battery : '—'}<small>${battery != null ? '%' + (charging ? ' · chg' : '') : 'wired'}</small></div>
            <div class="stat-bar"><i style="width:${battery != null ? battery : 0}%;${battery != null && battery < 25 ? 'background:var(--danger)' : ''}"></i></div>
          </div>
          <div class="stat">
            <div class="stat-label"><span>Profile</span>${icon('chip')}</div>
            <div class="stat-value">${(c.onboard | 0) + 1}<small>/ ${onboardMax}</small></div>
            <div class="stat-bar"><i style="width:${(((c.onboard | 0) + 1) / onboardMax) * 100}%"></i></div>
          </div>
        </div>
      </div>
    </section>

    <div class="grid g-3" style="margin-top:14px">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('sliders')}<div><h2>Sensitivity</h2><p>${c.dpiLevels.length} onboard stages</p></div></div></div>
        <div class="card-body">
          <div class="dpi-readout"><span class="num">${fmt(c.cpiX)}</span><span class="unit">DPI</span></div>
          <div class="dpi-stages">
            ${levels.slice(0, 8).map((v, i) => `
              <button class="dpi-stage ${i === c.activeLevel ? 'is-active' : ''}" data-action="dpi-stage" data-index="${i}">
                <div class="ds-i"><span class="ds-dot" style="--c:${STAGE_COLOR(i)}"></span>${String(i + 1).padStart(2, '0')}</div>
                <div class="ds-v">${fmt(v)}</div>
              </button>`).join('')}
          </div>
          <button class="link-btn" style="margin-top:12px" data-page="performance">Fine-tune stages ${icon('arrow')}</button>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('wave')}<div><h2>Polling rate</h2><p>Updates per second</p></div></div></div>
        <div class="card-body">
          <div class="dpi-readout"><span class="num">${fmt(c.polling)}</span><span class="unit">HZ</span></div>
          <div class="seg-wrap" style="margin-top:14px;display:grid;grid-template-columns:repeat(4,1fr)">
            ${(p.polling_rates || [125, 250, 500, 1000]).map((r) => `<button class="chip ${r === c.polling ? 'is-active' : ''}" data-action="polling" data-value="${r}" style="justify-content:center">${fmt(r)}</button>`).join('')}
          </div>
          <p class="help" style="margin-top:12px">Restart the device after changing polling rate.</p>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('bulb')}<div><h2>Lighting</h2><p>${esc(LIGHT_PRESETS.find((l) => l.mode === c.lightMode)?.name || 'Breathe')} · ${c.brightness}%</p></div></div></div>
        <div class="card-body">
          ${p.light ? `
          <div class="light-stage" style="min-height:118px;border-radius:9px;--glow:${esc(c.color)}">
            <div style="position:absolute;inset:10px;border-radius:7px;background:radial-gradient(50% 80% at 50% 50%, ${esc(c.color)}33, transparent 70%)"></div>
            <div style="position:relative;z-index:1;font-family:var(--mono);font-size:10px;letter-spacing:.14em;color:${esc(c.color)}">${esc((LIGHT_PRESETS.find((l) => l.mode === c.lightMode)?.name || 'breathe').toUpperCase())}</div>
          </div>
          <button class="link-btn" style="margin-top:12px" data-page="lighting">Open lighting studio ${icon('arrow')}</button>
          ` : `<div class="empty" style="padding:22px 10px">${icon('bulb')}<p>No RGB lighting on this device.</p></div>`}
        </div>
      </section>
    </div>

    <div class="split" style="margin-top:14px">
      <section class="card">
        <div class="card-head">
          <div class="ch-title">${icon('chip')}<div><h2>Onboard profiles</h2><p>Select the slot written by the device</p></div></div>
          <div class="row" style="gap:6px">
            <button class="btn btn-ghost btn-sm" data-action="factory-reset">${icon('refresh')}<span>Restore</span></button>
            <button class="btn btn-ghost btn-sm" data-action="apply">${icon('check')}<span>Write</span></button>
          </div>
        </div>
        <div class="card-body">
          <div class="profiles">
            ${Array.from({ length: onboardMax }).map((_, i) => `
              <button class="profile-tile ${i === (c.onboard | 0) ? 'is-active' : ''}" data-action="onboard" data-index="${i}">
                <div class="pt-i">SLOT ${String(i + 1).padStart(2, '0')}</div>
                <div class="pt-name">Profile ${i + 1}</div>
                <div class="pt-dot" style="--pc:${['#4be38a', '#7aa7ff', '#ff6b6b', '#b388ff', '#f2b25c'][i % 5]}"></div>
              </button>`).join('')}
          </div>
          <div class="setting-row" style="margin-top:16px">
            <div class="sr-main"><div class="sr-title">Switchable</div><p class="sr-desc">Use the profile button on the device to cycle slots.</p></div>
            <div class="sr-side">
              <div class="color-dots">
                ${['#4be38a', '#7aa7ff', '#ff6b6b', '#b388ff', '#f2b25c'].map((col) => `<span class="cdot" style="--c:${col}"></span>`).join('')}
              </div>
              <label class="switch"><input type="checkbox" data-bind="allowSwitch" data-kind="bool" ${c.allowSwitch ? 'checked' : ''} aria-label="Switchable"/><i></i></label>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('info')}<div><h2>Device details</h2><p>Reported by the firmware</p></div></div></div>
        <div class="card-body">
          <div class="kv"><span class="k">Firmware</span><span class="v">${esc((state.info && (state.info.r || state.info.revision)) || '—')}</span></div>
          <div class="kv"><span class="k">Product ID</span><span class="v">${esc(String(p.product_id).toUpperCase())}</span></div>
          <div class="kv"><span class="k">Sensor</span><span class="v">${esc(p.sensor || '—')}</span></div>
          <div class="kv"><span class="k">SoC</span><span class="v">${esc(p.soc || '—')}</span></div>
          <div class="kv"><span class="k">Connection</span><span class="v ${state.connected ? 'good' : ''}">${esc(connection)}</span></div>
          <div class="kv"><span class="k">Lighting</span><span class="v">${p.light ? 'RGB' : 'None'}</span></div>
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
      'Pick a button on the device, then choose what it should send. Changes are staged until you write them.',
      `<span class="pill ${state.dirty ? 'accent' : ''}">${state.dirty ? 'Unsaved changes' : 'In sync'}</span>`)}

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
            <button class="btn btn-primary btn-sm" data-action="apply">${icon('check')}<span>Apply &amp; onboard</span></button>
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
      `<span class="pill ${state.dirty ? 'accent' : ''}">${state.dirty ? 'Unsaved changes' : 'In sync'}</span>`)}
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
      'Everything the sensor reports, tuned in one place. Values are written with the button in the header.',
      `<span class="pill ${state.dirty ? 'accent' : ''}">${state.dirty ? 'Unsaved' : 'In sync'}</span>`)}

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
                  <div class="ds-i"><span class="ds-dot" style="--c:${STAGE_COLOR(i)}"></span>STAGE ${String(i + 1).padStart(2, '0')}</div>
                  <div class="ds-v">${fmt(v)}</div>
                </button>`).join('')}
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
        <div class="card-head"><div class="ch-title">${icon('battery')}<div><h2>Power</h2><p>Sleep and wireless mode</p></div></div></div>
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
          <div class="between"><span class="field-label">Estimated battery</span><span class="mono" style="font-size:11px">${state.info && state.info.battery != null ? state.info.battery + '%' : '—'}</span></div>
          <div class="stat-bar" style="height:6px;margin-top:9px"><i style="width:${state.info && state.info.battery ? state.info.battery : 0}%"></i></div>
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
      `<span class="pill">${preset.name} · <span data-live="brightness">${c.brightness}</span>%</span>`)}

    <div class="split">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('bulb')}<div><h2>Preview</h2><p>${esc(preset.name)} · ${esc(c.color)}</p></div></div><span class="pill accent">LIVE</span></div>
        <div class="card-body">
          <div class="light-stage" style="--glow:${esc(c.color)}">
            ${img(p.image, '', p.title, p.kind)}
            <span class="ls-caption">${esc(preset.name)} · <span data-live="brightness">${c.brightness}</span>% · <span data-live="speed">${c.speed}</span>% speed</span>
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
              <span class="mono" style="font-size:10px;color:var(--faint);margin-left:4px">${esc(c.color.toUpperCase())}</span>
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
          <div class="notice" style="margin-top:12px">${icon('info')}<span>Firmware is flashed by the desktop app. This page reports the revision and hands off the download.</span></div>
          <div class="row" style="margin-top:12px">
            <a class="btn btn-primary btn-sm" href="https://static.miracletek.net/pc/RAWMHUB.zip" target="_blank" rel="noopener">${icon('download')}<span>Get the updater</span></a>
            <a class="btn btn-ghost btn-sm" href="https://www.rawmtech.com/hub.html" target="_blank" rel="noopener">${icon('link')}<span>Vendor hub</span></a>
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

  /* ── Downloads ─────────────────────────────────────────────────────── */
  function downloadsView() {
    return `
    ${pageHead('Get the app', 'Downloads',
      'This page is the web configurator. The native apps add firmware flashing and offline device profiles.')}
    <div class="grid g-2">
      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('download')}<div><h2>RAWM HUB</h2><p>Official builds from the vendor</p></div></div></div>
        <div class="card-body">
          ${[
            ['monitor', 'Windows / macOS', 'Desktop app · firmware flashing', 'https://static.miracletek.net/pc/RAWMHUB.zip'],
            ['chip', 'Android', 'APK · on-the-go configuration', 'https://static.miracletek.net/android/RAWMHUB.apk'],
            ['mouse', 'iOS / iPadOS', 'App Store · RAWMHUB', 'https://apps.apple.com/cn/app/rawmhub/id1638249393'],
            ['globe', 'Web', 'You are here · WebHID', '#/device'],
          ].map(([ic, name, sub, href]) => `
            <div class="dl-row">
              <span class="dl-icon">${icon(ic)}</span>
              <div class="dl-main"><div class="t">${esc(name)}</div><div class="s">${esc(sub)}</div></div>
              ${href.startsWith('#') ? `<button class="btn btn-ghost btn-sm" data-page="device">Open</button>` : `<a class="btn btn-ghost btn-sm" href="${esc(href)}" target="_blank" rel="noopener">Download</a>`}
            </div>`).join('')}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><div class="ch-title">${icon('terminal')}<div><h2>Run this build</h2><p>WebHID needs a secure context</p></div></div></div>
        <div class="card-body">
          <p class="help">Open the built page for the UI; hardware access needs <span class="mono">localhost</span> or HTTPS.</p>
          <pre class="log" style="margin-top:12px;max-height:none">npx serve .
# or
python -m http.server 8080</pre>
          <div class="kv" style="margin-top:10px"><span class="k">Browser</span><span class="v">Chrome / Edge 89+</span></div>
          <div class="kv"><span class="k">API</span><span class="v">${RAWM.Transport.supported ? 'WebHID available' : 'WebHID unavailable'}</span></div>
          <div class="kv"><span class="k">Vendor ID</span><span class="v">0x1915</span></div>
          <div class="notice" style="margin-top:12px">${icon('info')}<span>Product renders and the device catalogue belong to RAWM / Miraclatek and are loaded from their CDN.</span></div>
        </div>
      </section>
    </div>`;
  }

  /* ── Router / shell ────────────────────────────────────────────────── */
  const PAGE_TITLES = {
    device: 'Device', buttons: 'Buttons', performance: 'Performance', lighting: 'Lighting',
    advanced: 'Advanced keys', macros: 'Macros', firmware: 'Firmware', downloads: 'Downloads',
  };
  const PAGE_GATE = ['device', 'buttons', 'performance', 'lighting', 'advanced', 'macros', 'firmware'];

  function render() {
    if (window.__antCleanup) window.__antCleanup();
    const page = state.page;
    const gated = PAGE_GATE.includes(page) && !state.connected;
    const html = gated ? connectView() : ({
      device: deviceView,
      buttons: buttonsView,
      performance: performanceView,
      lighting: lightingView,
      advanced: advancedView,
      macros: macrosView,
      firmware: firmwareView,
      downloads: downloadsView,
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
    document.title = state.connected && state.profile ? `${PAGE_TITLES[page]} · ${state.profile.title} — RAWM HUB` : 'RAWM HUB — Device configurator';

    const apply = $('#apply-btn');
    apply.hidden = !(state.dirty && state.connected);
    apply.querySelector('span').textContent = 'Write to device';

    const fw = $('#fw-channel');
    if (fw) fw.value = String((state.cfg && state.cfg.fwChannel) || 0);

    const pill = $('#conn-pill');
    const battery = state.info && Number.isFinite(Number(state.info.battery)) ? Number(state.info.battery) : null;
    const stateLabel = state.handshake === 'ready' ? 'CONNECTED' : state.handshake === 'timeout' ? 'NO REPLY' : 'CONNECTING';
    if (state.connected) {
      pill.innerHTML = `<span class="dot on"></span><span>${stateLabel}${battery != null ? ' · ' + battery + '%' : ''}</span>`;
    } else {
      pill.innerHTML = `<span class="dot"></span><span>NO DEVICE</span>`;
    }

    renderRailDevice();

    if (state.logOpen) renderLog();
    updateRangeFills();
    if (window.__antMount) window.__antMount();
  }

  function renderRailDevice() {
    const el = $('#rail-device');
    if (!el) return;
    if (!state.connected || !state.profile) { el.innerHTML = ''; return; }
    const p = state.profile;
    const battery = state.info && state.info.battery != null ? state.info.battery : null;
    el.innerHTML = `<button class="mini-device" data-page="device" style="width:100%;text-align:left" title="${esc(p.title)}">
      ${img(p.image, '', p.title, p.kind)}
      <span style="min-width:0">
        <span class="md-name" style="display:block">${esc(p.title)}</span>
        <span class="md-sub"><span class="dot on"></span>${state.handshake === 'ready' ? 'CONNECTED' : state.handshake === 'timeout' ? 'NO REPLY' : 'CONNECTING'}</span>
      </span>
      <span class="md-batt">${battery != null ? battery + '%' : ''}</span>
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
      const pid = Number(picked[0].productId).toString(16).padStart(4, '0');
      const authorised = await RAWM.Transport.authorised();
      const pool = [...picked, ...authorised.filter((d) => Number(d.productId) === Number(picked[0].productId))];
      const writable = pool.find((d) => (d.collections || []).some((c) => (c.outputReports || []).length > 0 || (c.featureReports || []).length > 0));
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
      } else if (err && err.name === 'SecurityError') {
        toast('Permission was blocked by the browser', 'err');
        addLog('err', err.message);
      } else if (location.protocol === 'file:') {
        toast('WebHID needs localhost or https:// — serve the folder first', 'err');
        addLog('err', 'file:// origin cannot use WebHID; run python -m http.server 8080');
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

  function disconnectDevice() {
    state.connected = false;
    state.handshake = 'idle';
    transport.disconnect();
    clearTimeout(reconnectTimer);
    state.profile = null;
    state.info = null;
    state.cfg = null;
    state.dirty = false;
    state.capturing = false;
    toast('Device disconnected', 'info');
    go('device');
  }

  async function applyAll() {
    if (!state.cfg) return;
    try {
      state.cfg.lightByte = lightByte();
      transport.writeMouseConfig(state.cfg);
      if (state.profile.light) transport.writeLight(state.cfg.lightByte);
      transport.writeBrightness(Math.round((state.cfg.brightness / 100) * 255));
      transport.writeSleep(Math.max(1, state.cfg.sleep) * 60);
      transport.save();
      state.dirty = false;
      render();
      toast('Writing to device…', 'ok');
    } catch (err) {
      toast(err.message || 'Write failed', 'err');
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
      <div class="modal" role="dialog" aria-modal="true" aria-label="WebHID console">
        <div class="modal-head">
          <div class="row" style="gap:9px">${icon('terminal')}<h3>WebHID console</h3><span class="pill ${state.connected ? 'accent' : ''}"><span class="dot ${state.connected ? 'on' : ''}"></span>${state.connected ? 'LIVE' : 'IDLE'}</span></div>
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
    if (window.__antMount) window.__antMount(root);
  }

  function closeLog() {
    state.logOpen = false;
    $('#modal-root').innerHTML = '';
  }

  /* ── Toasts ────────────────────────────────────────────────────────── */
  let toastId = 0;
  function toast(message, kind = 'ok') {
    const root = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' err' : '');
    el.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check')}<span>${esc(message)}</span>`;
    root.appendChild(el);
    el.dataset.id = String(++toastId);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, 3600);
  }

  /* ── Interactions ──────────────────────────────────────────────────── */
  function markDirty() {
    state.dirty = true;
    const apply = $('#apply-btn');
    apply.hidden = !state.connected;
    const pill = $('.page-head .pill');
    if (pill) { pill.textContent = 'Unsaved changes'; pill.classList.add('accent'); }
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
      case 'apply': applyAll(); break;
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
        markDirty(); render();
        break;
      }
      case 'dpi-add': {
        if (c.dpiLevels.length >= 8) break;
        const last = c.dpiLevels[c.dpiLevels.length - 1] || 800;
        c.dpiLevels.push(Math.min((p.cpi_range && p.cpi_range[1]) || 30000, last + 800));
        c.activeLevel = c.dpiLevels.length - 1;
        markDirty(); render();
        break;
      }
      case 'dpi-remove': {
        if (c.dpiLevels.length <= 1) break;
        c.dpiLevels.pop();
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
        markDirty(); render();
        break;
      }
      case 'dpi-reset': {
        c.dpiLevels = ((p && p.cpi_levels) || DEFAULTS.dpiLevels).filter((n) => n > 0);
        c.activeLevel = Math.min(2, c.dpiLevels.length - 1);
        c.cpiX = c.cpiY = c.dpiLevels[c.activeLevel];
        markDirty(); render();
        break;
      }
      case 'polling': c.polling = Number(el.dataset.value); markDirty(); render(); break;
      case 'lod': c.lod = Number(el.dataset.value); markDirty(); render(); break;
      case 'power': c.powerMode = Number(el.dataset.value); markDirty(); render(); break;
      case 'turbo-mode': c.wireless.mode = Number(el.dataset.value); markDirty(); render(); break;

      case 'light-mode': c.lightMode = el.dataset.mode; markDirty(); render(); break;
      case 'color': c.color = el.dataset.color; markDirty(); render(); break;
      case 'paint': {
        c.painted = c.painted || {};
        c.painted[el.dataset.index] = c.color;
        markDirty(); render();
        break;
      }
      case 'onboard': c.onboard = Number(el.dataset.index); markDirty(); render(); break;

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
      state.dirty = true;
      return;
    }
    if (bind.startsWith('adv.')) {
      setPath(state.cfg, bind, kind === 'int' ? Number(input.value) : kind === 'float' ? Number(input.value) : input.value);
      state.dirty = true;
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
    if (bind.startsWith('zones.')) render();
  });

  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'fw-channel' && state.cfg) {
      state.cfg.fwChannel = Number(e.target.value);
      if (state.connected) {
        transport.writeGamingOnly(state.cfg.fwChannel === 1);
        transport.save();
        transport.reboot();
        state.handshake = 'waiting';
        render();
        toast('FW channel changed — device is rebooting…', 'info');
        scheduleReconnect();
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
    if (n.cpi != null && state.cfg) state.cfg.cpiX = n.cpi & 0xffff;
    if (n.polling != null && state.cfg) state.cfg.polling = n.polling;
    render();
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
    const hash = (location.hash || '').replace('#/', '');
    if (PAGE_TITLES[hash]) state.page = hash;

    render();
    addLog('info', 'RAWM HUB 2.0 · WebHID ' + (RAWM.Transport.supported ? 'available' : 'unavailable'));
    if (!RAWM.Transport.supported) addLog('err', 'navigator.hid missing — use Chrome or Edge');
  }

  window.addEventListener('hashchange', () => {
    const hash = (location.hash || '').replace('#/', '');
    if (PAGE_TITLES[hash] && hash !== state.page) { state.page = hash; render(); }
  });

  boot();
})();