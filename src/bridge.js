/* ─────────────────────────────────────────────────────────────────────
   Local bridge transport
   Firefox and Safari have no WebHID. better-rawmhub-bridge is a small
   native daemon that owns the HID handle and hands it to the page over a
   loopback WebSocket. This module wraps that socket in an object shaped
   like a WebHID HIDDevice, so src/hid.js speaks both transports without
   any protocol change: same sendReport / sendFeatureReport /
   receiveFeatureReport / inputreport contract.

   Wire protocol v1
     control frames are JSON text
       → { t:'hello', api, token? }    ← { t:'welcome', api, version, platform, paired }
       → { t:'pair', code }            ← { t:'paired', token } | { t:'error', code:'bad-code' }
       → { t:'list' }                  ← { t:'devices', devices:[…] }
       → { t:'open', seq, deviceId }   ← { t:'opened', seq, handle }
       → { t:'send', seq, handle, rid, data }  ← { t:'sent', seq } | { t:'send-error', seq, message }
       → { t:'feature', seq, handle, rid, dir, data } ← { t:'feature-data', seq, data }
       → { t:'close', handle }         ← { t:'closed', handle }
       ← { t:'gone', handle, reason }
     input reports are binary frames
       [0x01][handle:u16le][raw report bytes…]

   The raw report still carries the report-id byte the platform HID layer
   returned (or not, when the device has no numbered reports). The first
   report on a handle decides which shape it is; see decideReport().
   ───────────────────────────────────────────────────────────────────── */

const RAWM_BRIDGE = (() => {
  const API = 1;
  const PORT = 47311;
  const CONNECT_TIMEOUT = 1200;
  const REPLY_TIMEOUT = 2500;
  const SEND_TIMEOUT = 1500;
  const TOKEN_KEY = 'rawmhub.bridge.tokens';

  let logFn = () => {};
  const note = (dir, msg) => { try { logFn(dir, `bridge · ${msg}`); } catch { /* noop */ } };

  class BridgeError extends Error {
    constructor(code, message, detail) {
      super(message || code);
      this.name = 'BridgeError';
      this.code = code;
      this.detail = detail || null;
    }
  }

  /* Report-id shape, decided once per handle from the first inbound report.
     A numbered interface answers with the report id first: 0x52 on a wired
     mouse, 0x00 on a receiver report that has no id. An interface without
     numbered reports answers straight with an envelope byte (0x80|len,
     0x40 or 0xC0|channel). Treating the first byte as an id only in the
     first case reproduces exactly what Chrome's WebHID would hand over. */
  function decideReport(raw) {
    if (!raw || !raw.length) return { numbered: false, reportId: 0, body: raw || new Uint8Array(0) };
    const numbered = raw[0] === 0x00 || raw[0] === 0x52;
    return numbered
      ? { numbered: true, reportId: raw[0], body: raw.subarray(1) }
      : { numbered: false, reportId: 0, body: raw };
  }

  function toB64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return btoa(out);
  }

  function fromB64(text) {
    const raw = atob(text || '');
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* Tokens are per origin, in localStorage, so a reload does not ask for the
     pairing code again. The daemon only stores a SHA-256 of the token. */
  const tokens = {
    all() {
      try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}') || {}; } catch { return {}; }
    },
    get(origin) {
      const value = this.all()[origin];
      return typeof value === 'string' ? value : null;
    },
    set(origin, token) {
      const all = this.all();
      all[origin] = token;
      try { localStorage.setItem(TOKEN_KEY, JSON.stringify(all)); } catch { /* private mode */ }
    },
    clear(origin) {
      const all = this.all();
      delete all[origin];
      try { localStorage.setItem(TOKEN_KEY, JSON.stringify(all)); } catch { /* private mode */ }
    },
  };

  function fire(device, type, detail) {
    const list = device._listeners[type];
    if (!list) return;
    for (const fn of list.slice()) {
      try { fn(detail); } catch (err) { note('err', `listener threw: ${err && err.message}`); }
    }
  }

  /* ── HIDDevice-shaped wrapper ───────────────────────────────────────── */

  class BridgeDevice {
    constructor(client, info) {
      this.client = client;
      this.bridge = true;
      this.deviceId = info.id;
      this.path = info.path || info.id;
      this.vendorId = info.vendorId;
      this.productId = info.productId;
      this.productName = info.productName || 'RAWM device';
      this.serialNumber = info.serialNumber || '';
      this.usagePage = info.usagePage || 0;
      this.usage = info.usage || 0;
      this.interface = info.interface;
      // The daemon cannot read the report descriptor, so the transport falls
      // back to profile.report_len (64 bytes by default) plus its 64→32 retry.
      this.collections = [];
      this.opened = false;
      this.handle = null;
      this.reportLength = 0;
      this._listeners = { inputreport: [], disconnect: [] };
      this._lastFeature = null;
      this._numbered = null;
    }

    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      if (!this._listeners[type].includes(fn)) this._listeners[type].push(fn);
    }

    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }

    dispatchEvent(event) {
      const type = event && event.type;
      if (type) fire(this, type, event);
      return true;
    }

    async open() {
      if (this.opened) return;
      const msg = await this.client.open(this);
      this.handle = msg.handle;
      this.reportLength = Number(msg.reportLength) || 0;
      this.opened = true;
      note('info', `opened ${this.productName} via the bridge (usagePage ${hex16(this.usagePage)})`);
    }

    async close() {
      const handle = this.handle;
      this.opened = false;
      this.handle = null;
      if (handle == null) return;
      try { await this.client.close(handle); } catch { /* already gone */ }
    }

    sendReport(reportId, data) {
      return this.client.sendReport(this, reportId, data);
    }

    async sendFeatureReport(reportId, data) {
      const view = await this.client.feature(this, reportId, 'write', data);
      this._lastFeature = view;
    }

    async receiveFeatureReport(reportId) {
      if (this._lastFeature) {
        const view = this._lastFeature;
        this._lastFeature = null;
        return view;
      }
      return this.client.feature(this, reportId, 'read', null);
    }

    /* Called from the client when a binary frame arrives for this handle. */
    _report(raw) {
      const shape = decideReport(raw);
      if (this._numbered == null) {
        this._numbered = shape.numbered;
        note('info', `${this.productName} input reports ${this._numbered ? 'carry a report id' : 'have no report id'}`);
      }
      const reportId = this._numbered ? shape.reportId : 0;
      const body = this._numbered ? shape.body : raw;
      const data = new DataView(body.buffer, body.byteOffset, body.byteLength);
      fire(this, 'inputreport', { type: 'inputreport', reportId, data });
    }
  }

  function hex16(value) {
    return '0x' + (Number(value) || 0).toString(16).padStart(4, '0');
  }

  /* ── WebSocket client ───────────────────────────────────────────────── */

  function openSocket() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/ws`); }
      catch (err) { reject(new BridgeError('no-daemon', 'This browser refused a loopback WebSocket', err)); return; }
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const fail = (detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        reject(new BridgeError('no-daemon', `Nothing answered on 127.0.0.1:${PORT}`, detail));
      };
      const timer = setTimeout(() => fail('connect timeout'), CONNECT_TIMEOUT);
      ws.onopen = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(ws); };
      ws.onerror = () => fail('socket error');
      ws.onclose = () => fail('socket closed during the handshake');
    });
  }

  class Client {
    constructor() {
      this.ws = null;
      this.ready = null;
      this.welcome = null;
      this.seq = 0;
      this.waiters = [];
      this.devices = new Map();
      this.handles = new Map();
      this.lastError = null;
      this.silent = false;
    }

    connect() {
      if (this.ready) return this.ready;
      this.silent = false;
      this.ready = (async () => {
        const ws = await openSocket();
        this.ws = ws;
        ws.onmessage = (event) => {
          if (typeof event.data === 'string') this._control(event.data);
          else this._binary(event.data);
        };
        ws.onclose = () => this._closed('the bridge stopped');
        ws.onerror = () => { /* reported through onclose */ };
        const welcome = await this._hello();
        this.welcome = welcome;
        note('info', `bridge ${welcome.version || '?'} on 127.0.0.1:${PORT} · ${welcome.platform || 'unknown'}${welcome.paired ? '' : ' · pairing required'}`);
        return welcome;
      })();
      this.ready.catch(() => { this.ready = null; });
      return this.ready;
    }

    _hello() {
      const wait = this._expect((m) => m.t === 'welcome', CONNECT_TIMEOUT + 800, 'no-daemon');
      this._send({ t: 'hello', api: API, token: tokens.get(location.origin) });
      return wait;
    }

    _expect(match, timeout, code) {
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new BridgeError(code || 'timeout', 'The bridge did not answer in time'));
        }, timeout || REPLY_TIMEOUT);
        this.waiters.push(waiter);
      });
    }

    _settle(msg) {
      const index = this.waiters.findIndex((w) => {
        try { return w.match(msg); } catch { return false; }
      });
      if (index < 0) return false;
      const waiter = this.waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      if (msg.t === 'error' || msg.t === 'send-error') {
        waiter.reject(new BridgeError(msg.code || 'bridge-error', msg.message || msg.code || 'The bridge refused the request'));
      } else {
        waiter.resolve(msg);
      }
      return true;
    }

    _send(msg) {
      if (!this.ws || this.ws.readyState !== 1) throw new BridgeError('no-daemon', 'The bridge is not connected');
      try { this.ws.send(JSON.stringify(msg)); }
      catch (err) { throw new BridgeError('no-daemon', 'Could not write to the bridge', err); }
    }

    _control(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (this._settle(msg)) return;
      if (msg.t === 'gone') {
        const device = this.handles.get(msg.handle);
        if (!device) return;
        this.handles.delete(msg.handle);
        device.opened = false;
        device.handle = null;
        note('err', `${device.productName} disconnected (${msg.reason || 'unplugged'})`);
        fire(device, 'disconnect', { type: 'disconnect', reason: msg.reason || 'device removed' });
        return;
      }
      if (msg.t === 'error' && !this.silent) note('err', `${msg.code || 'error'}: ${msg.message || ''}`);
    }

    _binary(buffer) {
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint8(0) !== 1) return;
      const device = this.handles.get(view.getUint16(1, true));
      if (!device) return;
      device._report(new Uint8Array(buffer, 3));
    }

    _closed(reason) {
      const hadSocket = !!this.ws;
      this.ws = null;
      this.ready = null;
      this.welcome = null;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new BridgeError('no-daemon', reason));
      }
      for (const device of this.handles.values()) {
        device.opened = false;
        device.handle = null;
        fire(device, 'disconnect', { type: 'disconnect', reason });
      }
      this.handles.clear();
      if (hadSocket && !this.silent) note('err', 'bridge connection closed');
    }

    async list() {
      this._send({ t: 'list' });
      const msg = await this._expect((m) => m.t === 'devices' || m.t === 'error');
      return Array.isArray(msg.devices) ? msg.devices : [];
    }

    async open(device) {
      const seq = ++this.seq;
      this._send({ t: 'open', seq, deviceId: device.deviceId });
      const msg = await this._expect(
        (m) => m.seq === seq && (m.t === 'opened' || m.t === 'error'),
        REPLY_TIMEOUT + 1500,
        'open-failed',
      );
      this.handles.set(msg.handle, device);
      return msg;
    }

    async close(handle) {
      try { this._send({ t: 'close', handle }); } catch { /* bridge is down */ }
      this.handles.delete(handle);
    }

    sendReport(device, reportId, data) {
      const seq = ++this.seq;
      this._send({ t: 'send', seq, handle: device.handle, rid: reportId & 0xff, data: toB64(data) });
      return this._expect(
        (m) => m.seq === seq && (m.t === 'sent' || m.t === 'send-error' || m.t === 'error'),
        SEND_TIMEOUT,
        'send-timeout',
      ).then(() => undefined);
    }

    feature(device, reportId, dir, data) {
      const seq = ++this.seq;
      this._send({ t: 'feature', seq, handle: device.handle, rid: reportId & 0xff, dir, data: data ? toB64(data) : null });
      return this._expect(
        (m) => m.seq === seq && (m.t === 'feature-data' || m.t === 'send-error' || m.t === 'error'),
        REPLY_TIMEOUT,
        'feature-timeout',
      ).then((msg) => {
        const bytes = fromB64(msg.data || '');
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      });
    }

    async pair(code) {
      await this.connect();
      this._send({ t: 'pair', code: String(code || '').trim() });
      const msg = await this._expect((m) => m.t === 'paired' || m.t === 'error', REPLY_TIMEOUT + 1500, 'pair-timeout');
      if (!msg.token) throw new BridgeError('pair-failed', 'The bridge did not return a token');
      tokens.set(location.origin, msg.token);
      if (this.welcome) this.welcome.paired = true;
      note('info', `paired with the bridge for ${location.origin}`);
      return msg.token;
    }

    shutdown() {
      this.silent = true;
      const ws = this.ws;
      this._closed('closed by the page');
      try { if (ws) ws.close(); } catch { /* noop */ }
    }
  }

  let client = null;
  const get = () => (client || (client = new Client()));

  /* One BridgeDevice per daemon device id, reused across calls so a reconnect
     after a device reboot keeps the same object and its listeners. */
  function mapDevices(c, list) {
    return list
      .map((info) => {
        let device = c.devices.get(info.id);
        if (!device) {
          device = new BridgeDevice(c, info);
          c.devices.set(info.id, device);
        }
        return device;
      })
      .sort((a, b) => (b.usagePage || 0) - (a.usagePage || 0));
  }

  /* ── Public API ─────────────────────────────────────────────────────── */

  async function request() {
    const c = get();
    const welcome = await c.connect();
    if (!welcome.paired) throw new BridgeError('pair-required', 'This page is not paired with the bridge yet');
    const list = await c.list();
    if (!list.length) throw new BridgeError('no-device', 'The bridge found no RAWM device on vendor 0x1915');
    return mapDevices(c, list);
  }

  async function pair(code) {
    const c = get();
    await c.pair(code);
    return request();
  }

  /* Used by the transport for reconnects after a reboot or a channel change:
     ask the daemon again instead of trusting a cached handle. */
  async function getDevices() {
    if (!client || !client.ws) return [];
    try {
      const welcome = await client.connect();
      if (!welcome.paired) return [];
      return mapDevices(client, await client.list());
    } catch {
      return [];
    }
  }

  function forget() {
    tokens.clear(location.origin);
    if (client) client.shutdown();
    client = null;
  }

  function reset() {
    if (client) client.shutdown();
    client = null;
  }

  function setLog(fn) {
    logFn = typeof fn === 'function' ? fn : () => {};
  }

  return {
    API,
    PORT,
    available: true,
    request,
    pair,
    getDevices,
    forget,
    reset,
    setLog,
    decideReport,
    tokens,
    get lastError() { return client ? client.lastError : null; },
    get welcome() { return client ? client.welcome : null; },
  };
})();

if (typeof window !== 'undefined') window.RAWM_BRIDGE = RAWM_BRIDGE;
if (typeof module !== 'undefined' && module.exports) module.exports = RAWM_BRIDGE;
