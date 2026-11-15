/* better-rawmhub-bridge - loopback WebSocket server.
   The page never sees a HID path: it asks this process to list devices, open
   one, and write reports. Everything is scoped to vendor 0x1915, bound to
   loopback, origin-checked and, after the first visit, token-paired. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { DeviceHandle, listDevices } from './hid.js';
import { configPath, loadConfig, saveConfig } from './config.js';
import { DEFAULT_ORIGINS, hostAllowed, originAllowed, safeEqualHex, sha256 } from './security.js';

export const API = 1;
export const VERSION = '0.1.0';
export const DEFAULT_PORT = 47311;

const PAIR_TTL = 10 * 60 * 1000;
const MAX_PAYLOAD = 256 * 1024;

const stamp = () => new Date().toTimeString().slice(0, 8);

export function startBridge(options = {}) {
  const port = Number(options.port) || DEFAULT_PORT;
  const host = options.host || '127.0.0.1';
  const idleSeconds = options.idle == null ? 600 : Math.max(0, Number(options.idle) || 0);
  const extraOrigins = Array.isArray(options.origins) ? options.origins : [];
  const pairing = options.pairing !== false;
  const reportIds = options.reportIds !== false;
  const log = typeof options.log === 'function' ? options.log : (line) => console.log(line);

  const config = loadConfig();
  const sessions = new Set();
  const handles = new Map();
  const pending = new Map();
  let nextHandle = 1;
  let lastActivity = Date.now();
  let closed = false;

  const touch = () => { lastActivity = Date.now(); };

  /* ── pairing ─────────────────────────────────────────────────────────── */

  function issueCode(origin) {
    const current = pending.get(origin);
    if (current && current.expires > Date.now()) return current.code;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pending.set(origin, { code, expires: Date.now() + PAIR_TTL });
    log('');
    log(`  ${stamp()}  pairing code for ${origin}:  ${code}`);
    log('            type it into the page once - this origin is remembered');
    log('');
    return code;
  }

  function tokenOk(origin, token) {
    if (!pairing) return true;
    const stored = config.tokens[origin];
    if (!stored || typeof token !== 'string' || !token) return false;
    return safeEqualHex(stored, sha256(token));
  }

  function approve(origin) {
    const token = randomBytes(24).toString('base64url');
    config.tokens[origin] = sha256(token);
    saveConfig(config);
    pending.delete(origin);
    return token;
  }

  /* ── framing ─────────────────────────────────────────────────────────── */

  function send(ws, message) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(message)); } catch { /* closing */ }
  }

  function fail(session, seq, code, message) {
    send(session.ws, { t: 'error', seq: seq == null ? undefined : seq, code, message });
  }

  function sendInput(id, buffer) {
    const entry = handles.get(id);
    if (!entry) return;
    const ws = entry.session.ws;
    if (!ws || ws.readyState !== 1) return;
    const head = Buffer.allocUnsafe(3);
    head[0] = 1;
    head.writeUInt16LE(id, 1);
    try { ws.send(Buffer.concat([head, buffer]), { binary: true }); } catch { /* closing */ }
    touch();
  }

  function onGone(id, err) {
    const entry = handles.get(id);
    handles.delete(id);
    touch();
    if (!entry) return;
    entry.session.handles.delete(id);
    log(`  ${stamp()}  ${entry.info.productName || 'device'} disconnected${err ? ` (${err.message})` : ''}`);
    send(entry.session.ws, { t: 'gone', handle: id, reason: err ? err.message : 'device removed' });
    try { entry.device.close(); } catch { /* already gone */ }
  }

  /* ── protocol ────────────────────────────────────────────────────────── */

  function handleMessage(session, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'hello': {
        session.authorised = tokenOk(session.origin, msg.token);
        send(session.ws, {
          t: 'welcome',
          api: API,
          version: VERSION,
          platform: `${process.platform}-${process.arch}`,
          paired: session.authorised,
          pairing,
        });
        if (!session.authorised && pairing) issueCode(session.origin);
        break;
      }

      case 'pair': {
        if (!pairing) {
          session.authorised = true;
          send(session.ws, { t: 'paired', token: 'open' });
          break;
        }
        const entry = pending.get(session.origin);
        const code = String(msg.code || '').trim();
        if (!entry || entry.expires < Date.now() || code !== entry.code) {
          fail(session, msg.seq, 'bad-code', 'That pairing code is wrong or expired');
          break;
        }
        const token = approve(session.origin);
        session.authorised = true;
        log(`  ${stamp()}  paired ${session.origin}`);
        send(session.ws, { t: 'paired', token });
        break;
      }

      case 'list': {
        if (!session.authorised) { fail(session, msg.seq, 'pair-required', 'Pair this page with the bridge first'); break; }
        send(session.ws, { t: 'devices', devices: listDevices() });
        touch();
        break;
      }

      case 'open': {
        if (!session.authorised) { fail(session, msg.seq, 'pair-required', 'Pair this page with the bridge first'); break; }
        const info = listDevices().find((device) => device.id === msg.deviceId);
        if (!info) { fail(session, msg.seq, 'not-found', 'That device is not plugged in any more'); break; }
        const busy = [...handles.values()].some((entry) => entry.info.id === info.id);
        if (busy) { fail(session, msg.seq, 'device-busy', 'Another tab already has this device open'); break; }
        const id = nextHandle++;
        let device;
        try {
          device = new DeviceHandle(
            info,
            { input: (_, buf) => sendInput(id, buf), gone: (_, err) => onGone(id, err) },
            { reportIds },
          );
          device.open();
        } catch (err) {
          fail(session, msg.seq, 'open-failed', err.message || String(err));
          break;
        }
        handles.set(id, { id, info, device, session });
        session.handles.add(id);
        touch();
        log(`  ${stamp()}  opened ${info.productName || 'RAWM device'} for ${session.origin}`);
        send(session.ws, { t: 'opened', seq: msg.seq, handle: id, productName: info.productName, usagePage: info.usagePage });
        break;
      }

      case 'send': {
        const entry = handles.get(msg.handle);
        if (!entry || entry.session !== session) { fail(session, msg.seq, 'no-handle', 'That device is not open'); break; }
        try {
          entry.device.write(msg.rid | 0, Buffer.from(String(msg.data || ''), 'base64'));
          send(session.ws, { t: 'sent', seq: msg.seq });
          touch();
        } catch (err) {
          fail(session, msg.seq, 'write-failed', err.message || String(err));
        }
        break;
      }

      case 'feature': {
        const entry = handles.get(msg.handle);
        if (!entry || entry.session !== session) { fail(session, msg.seq, 'no-handle', 'That device is not open'); break; }
        try {
          if (msg.dir !== 'read') {
            entry.device.sendFeature(msg.rid | 0, Buffer.from(String(msg.data || ''), 'base64'));
          }
          let buffer = null;
          try { buffer = entry.device.readFeature(msg.rid | 0); } catch { buffer = null; }
          send(session.ws, { t: 'feature-data', seq: msg.seq, data: buffer ? buffer.toString('base64') : '' });
          touch();
        } catch (err) {
          fail(session, msg.seq, 'feature-failed', err.message || String(err));
        }
        break;
      }

      case 'close': {
        const entry = handles.get(msg.handle);
        if (entry && entry.session === session) {
          handles.delete(msg.handle);
          session.handles.delete(msg.handle);
          try { entry.device.close(); } catch { /* already gone */ }
          send(session.ws, { t: 'closed', handle: msg.handle });
          touch();
        }
        break;
      }

      case 'ping':
        send(session.ws, { t: 'pong' });
        touch();
        break;

      default:
        break;
    }
  }

  /* ── transport ───────────────────────────────────────────────────────── */

  const httpServer = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end(`better-rawmhub-bridge ${VERSION} speaks WebSocket only: ws://${host}:${port}/v1/ws\n`);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  function refuse(socket, code, reason) {
    const body = `${code} ${reason}\n`;
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    } catch { /* noop */ }
    socket.destroy();
  }

  httpServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    const hostHeader = req.headers.host || '';
    if (!/^\/v1\/ws(?:[?#].*)?$/.test(req.url || '')) return refuse(socket, 404, 'Not Found');
    if (!hostAllowed(hostHeader)) return refuse(socket, 403, 'Forbidden');
    if (!originAllowed(origin, extraOrigins)) {
      log(`  ${stamp()}  refused ${origin || '(no origin)'} - not in the allowlist`);
      return refuse(socket, 403, 'Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || '';
    const session = { ws, origin, authorised: false, handles: new Set() };
    sessions.add(session);
    touch();
    log(`  ${stamp()}  page connected - ${origin}`);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // pages never send binary
      try { handleMessage(session, raw); } catch (err) {
        log(`  ${stamp()}  protocol error: ${err && err.message}`);
        fail(session, null, 'bridge-error', err && err.message ? err.message : 'internal error');
      }
    });

    ws.on('close', () => {
      sessions.delete(session);
      for (const id of session.handles) {
        const entry = handles.get(id);
        handles.delete(id);
        try { if (entry) entry.device.close(); } catch { /* noop */ }
      }
      session.handles.clear();
      touch();
      log(`  ${stamp()}  page closed - ${origin}`);
    });

    ws.on('error', () => { /* reported through close */ });
  });

  httpServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      log(`port ${port} is already in use - is another bridge running?`);
      log(`try: better-rawmhub-bridge --port=${port + 1}  and set the same port in the page`);
    } else {
      log(`server error: ${err && err.message}`);
    }
  });

  let idleTimer = null;
  if (idleSeconds > 0) {
    idleTimer = setInterval(() => {
      if (closed) return;
      if (handles.size || sessions.size) return;
      if (Date.now() - lastActivity < idleSeconds * 1000) return;
      log(`  ${stamp()}  idle for ${idleSeconds}s - exiting (start it again from the page, or use --idle=0)`);
      shutdown();
    }, 15000);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function shutdown() {
    if (closed) return;
    closed = true;
    if (idleTimer) clearInterval(idleTimer);
    for (const [id, entry] of handles) {
      handles.delete(id);
      try { entry.device.close(); } catch { /* noop */ }
    }
    for (const session of sessions) {
      try { session.ws.close(); } catch { /* noop */ }
    }
    sessions.clear();
    try { wss.close(); } catch { /* noop */ }
    try { httpServer.close(); } catch { /* noop */ }
  }

  httpServer.listen(port, host, () => {
    log('');
    log(`  better-rawmhub-bridge ${VERSION}`);
    log(`  ws://${host}:${port}/v1/ws`);
    log(`  origins: ${DEFAULT_ORIGINS.join(', ')}${extraOrigins.length ? ` + ${extraOrigins.join(', ')}` : ''}`);
    log(`  origins on localhost are allowed too - devices: vendor 0x1915 only`);
    log(`  pairing: ${pairing ? 'on' : 'off'} - idle exit: ${idleSeconds ? `${idleSeconds}s after the last page closes` : 'never'}`);
    log(`  config: ${configPath()}`);
    log('  close this window to stop the bridge');
    log('');
  });

  return { port, host, url: `ws://${host}:${port}/v1/ws`, close: shutdown };
}
