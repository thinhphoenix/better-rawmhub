#!/usr/bin/env node
/* Live check against a running bridge: connects, pairs if needed, lists
   devices, opens the vendor interface and sends the same QUERY packet the
   configurator sends. Prints the first few input reports.

   Usage:
     node bridge/tools/live-test.mjs                 (port 47311, no pairing)
     node bridge/tools/live-test.mjs --port=47311 --code=123456
     node bridge/tools/live-test.mjs --send=no       (only list devices)

   Requires a RAWM device on USB and the bridge already running.
*/
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'reference', 'package.json'));
const WebSocket = require('ws');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const port = Number(option('port', '47311'));
const code = option('code', '');
const sendQuery = option('send', 'yes') !== 'no';
const origin = option('origin', 'http://localhost:8080');

const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { origin, headers: { Host: `127.0.0.1:${port}` } });
ws.binaryType = 'arraybuffer';

let handle = null;
let reports = 0;
let writes = 0;

const frame = (command, payload) => {
  const length = payload.length + 2;
  const out = new Uint8Array(length);
  out[0] = ((length >> 4) & 0xf0) | (command & 0x0f);
  out[1] = length & 0xff;
  out.set(payload, 2);
  return out;
};

const queryReport = () => {
  const payload = new Uint8Array(10);
  payload[0] = 3;
  let seconds = Math.floor(Date.now() / 1000);
  for (let i = 3; i < 10; i++) { payload[i] = seconds & 0xff; seconds = Math.floor(seconds / 256); }
  const packet = frame(0x1, payload);
  const report = new Uint8Array(64);
  report[0] = 0x80 | packet.length;
  report.set(packet, 1);
  return report;
};

const send = (message) => ws.send(JSON.stringify(message));

ws.on('open', () => send({ t: 'hello', api: 1 }));
ws.on('error', (err) => { console.error('socket error:', err.message); process.exit(1); });

ws.on('message', (raw, isBinary) => {
  if (isBinary) {
    const buf = Buffer.from(raw);
    reports++;
    if (reports <= 4) {
      console.log(`input  handle=${buf.readUInt16LE(1)}  ${buf.length - 3}B  ${buf.subarray(3, 15).toString('hex')}`);
    }
    if (reports === 4) finish();
    return;
  }
  const msg = JSON.parse(raw.toString());
  switch (msg.t) {
    case 'welcome':
      console.log(`welcome · bridge ${msg.version} · ${msg.platform} · paired=${msg.paired}`);
      if (!msg.paired) {
        if (!code) { console.error('the bridge needs a pairing code — pass --code=123456'); process.exit(2); }
        send({ t: 'pair', code });
        break;
      }
      send({ t: 'list' });
      break;
    case 'paired':
      console.log('paired');
      send({ t: 'list' });
      break;
    case 'devices':
      if (!msg.devices.length) { console.error('no RAWM device on vendor 0x1915'); process.exit(3); }
      for (const device of msg.devices) {
        console.log(`device · pid 0x${device.productId.toString(16)} · usagePage 0x${(device.usagePage || 0).toString(16)} · if ${device.interface} · ${device.productName}`);
      }
      {
        const vendor = msg.devices.find((d) => (d.usagePage || 0) >= 0xff00) || msg.devices[0];
        send({ t: 'open', seq: 1, deviceId: vendor.id });
      }
      break;
    case 'opened':
      handle = msg.handle;
      console.log(`opened handle ${handle}`);
      if (sendQuery) {
        send({ t: 'send', seq: 2, handle, rid: 0, data: Buffer.from(queryReport()).toString('base64') });
      } else {
        setTimeout(finish, 300);
      }
      break;
    case 'sent':
      writes++;
      break;
    case 'error':
      console.error(`error · ${msg.code}: ${msg.message}`);
      process.exit(4);
      break;
    default:
      break;
  }
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log(`ok · ${writes} write(s) accepted · ${reports} input report(s)`);
  ws.close();
  process.exit(0);
}

setTimeout(() => {
  console.error(`timeout · ${writes} write(s) accepted · ${reports} input report(s)`);
  process.exit(5);
}, 6000);
