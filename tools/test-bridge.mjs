/* Checks for the local bridge: the page-side adapter (report-id shape, port,
   HID facade selection) and the shipped daemon's security rules once built. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

function equal(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

// src/bridge.js is a plain script; run it and grab the exported object.
const Bridge = new Function(`${read('src/bridge.js')}\nreturn RAWM_BRIDGE;`)();
const bytes = (...values) => new Uint8Array(values);

check('bridge port matches the daemon default', () => {
  equal(Bridge.PORT, 47311, 'PORT');
  equal(Bridge.API, 1, 'API');
});

check('numbered report with id 0x52 is split into id + payload', () => {
  const shape = Bridge.decideReport(bytes(0x52, 0xaa, 0xbb));
  equal(shape.numbered, true, 'numbered');
  equal(shape.reportId, 0x52, 'reportId');
  equal(Array.from(shape.body), [0xaa, 0xbb], 'body');
});

check('receiver report with id 0 keeps its envelope in the payload', () => {
  const shape = Bridge.decideReport(bytes(0x00, 0x81, 0x0c));
  equal(shape.numbered, true, 'numbered');
  equal(shape.reportId, 0x00, 'reportId');
  equal(Array.from(shape.body), [0x81, 0x0c], 'body');
});

check('interface without numbered reports is passed through untouched', () => {
  const raw = bytes(0xbf, 0x01, 0x02);
  const shape = Bridge.decideReport(raw);
  equal(shape.numbered, false, 'numbered');
  equal(shape.reportId, 0, 'reportId');
  equal(shape.body, raw, 'body');
});

check('empty reports do not throw', () => {
  const shape = Bridge.decideReport(new Uint8Array(0));
  equal(shape.numbered, false, 'numbered');
  equal(shape.reportId, 0, 'reportId');
});

check('HID facade picks the bridge when the browser has no WebHID', () => {
  const RAWM = new Function('RAWM_BRIDGE', `${read('src/hid.js')}\nreturn RAWM;`)(Bridge);
  if (typeof navigator !== 'undefined' && navigator.hid) {
    equal(RAWM.Transport.backend, 'webhid', 'backend in a WebHID browser');
  } else {
    equal(RAWM.Transport.backend, 'bridge', 'backend without WebHID');
    equal(RAWM.Transport.supported, true, 'supported');
    equal(RAWM.Transport.native, false, 'native');
  }
});

check('bridge script is built before hid.js', () => {
  const out = resolve(root, 'index.html');
  if (!existsSync(out)) return; // not built yet
  const html = read('index.html');
  const bridgeAt = html.indexOf('const RAWM_BRIDGE =');
  const hidAt = html.indexOf('const RAWM = (() =>');
  if (bridgeAt < 0 || hidAt < 0) throw new Error('bundle is missing one of the scripts');
  if (bridgeAt > hidAt) throw new Error('RAWM_BRIDGE is inlined after hid.js');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
