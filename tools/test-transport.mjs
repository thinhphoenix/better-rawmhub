/* Fast protocol smoke test — no browser or hardware required. */
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../src/hid.js', import.meta.url), 'utf8') + '\nreturn RAWM;';
const RAWM = new Function(code)();

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeTransport() {
  const t = new RAWM.Transport(() => {});
  const seen = { info: null };
  t.addEventListener('info', (e) => { seen.info = e.detail; });
  return { t, seen };
}

function report(body, { channel = null } = {}) {
  const out = new Uint8Array(64);
  let off = 0;
  if (channel !== null) { out[0] = 0xc0 | channel; off = 1; }
  out[off] = 0x80 | body.length;
  out.set(body, off + 1);
  return out.subarray(0, off + 1 + body.length);
}

function send(t, body, opts = {}) {
  for (let i = 0; i < body.length; i += 50) t.ingest(report(body.subarray(i, i + 50), opts));
}

const info = { r: '1.0.1', cpi: 1600, pr: 1000, battery: 78, pi: '232a', crc: 1 };
const json = enc.encode(JSON.stringify(info));
const frame = RAWM.frame(RAWM.CMD.QUERY_RESULT, json);
const clean = new Uint8Array(frame.length + 4);
clean.set(frame, 4);                       // four firmware bytes before the frame

let pass = 0;

// 1. Direct device, one report, 4-byte prefix.
{
  const { t, seen } = makeTransport();
  send(t, clean);
  if (seen.info && seen.info.cpi === 1600) pass++;
  else console.error('FAIL direct');
}

// 2. Receiver routed, one report.
{
  const { t, seen } = makeTransport();
  send(t, clean, { channel: 0 });
  if (seen.info && seen.info.battery === 78) pass++;
  else console.error('FAIL receiver');
}

// 3. Frame split over two reports with the prefix only on the first.
{
  const { t, seen } = makeTransport();
  t.ingest(report(clean.subarray(0, 20)));
  if (seen.info) console.error('FAIL parsed too early');
  t.ingest(report(clean.subarray(20, 40)));
  t.ingest(report(clean.subarray(40)));
  if (seen.info && seen.info.pr === 1000) pass++;
  else console.error('FAIL split');
}

// 4. No envelope at all: JSON salvage path.
{
  const { t, seen } = makeTransport();
  t.ingest(json);
  if (seen.info && seen.info.r === '1.0.1') pass++;
  else console.error('FAIL salvage');
}

// 5. CRC matches the vendor algorithm's low 16 bits.
{
  const bytes = [1, 2, 3, 4, 5];
  const expected = 37636;
  if (RAWM.crc16(bytes) === expected) pass++;
  else console.error('FAIL crc', RAWM.crc16(bytes));
}

// 6. Receiver: direct query discovers the paired mouse, then routes on 0.
{
  const { t, seen } = makeTransport();
  t.isReceiver = true;
  t.channel = null;
  t.reportLength = 64;
  const sent = [];
  t.device = { opened: true, sendReport: (id, data) => sent.push(data), addEventListener() {}, removeEventListener() {} };
  const peer = { r: '1.0.1', dn: 'LEVIATHAN V4', esb_addr: ['aabbcc'] };
  const frame = RAWM.frame(RAWM.CMD.QUERY_RESULT, enc.encode(JSON.stringify(peer)));
  const body = new Uint8Array(frame.length + 4);
  body.set(frame, 4);
  send(t, body);
  const routed = sent[sent.length - 1];
  if (t.channel === 0 && t.receiverInfo && routed && (routed[0] & 0xc0) === 0xc0) pass++;
  else console.error('FAIL receiver switch', { channel: t.channel, ri: t.receiverInfo, sent: sent.length, buf: t.buffer.length, first: routed && routed[0] });
  send(t, clean, { channel: 0 });
  if (seen.info && seen.info.pi === '232a') pass++;
  else console.error('FAIL receiver mouse info');
}

// 7. Wired firmware: the info JSON arrives as notify 0x0c chunks inside 0x52
//    status reports that carry an 18-byte device header before the stream.
{
  const { t, seen } = makeTransport();
  const header = [0x15, 0x24, 0, 0, 0x80, 0x0c, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0x28, 0, 0];
  const status = (chunk) => new Uint8Array([0x52, ...header, ...chunk]);
  const body = enc.encode(JSON.stringify({ ...info, dn: 'LEVIATHAN V4', esb_addr: ['8f56'], kd: [8, 8, 8, 8] }));
  for (let i = 0; i < body.length; i += 90) {
    const part = body.subarray(i, i + 90);
    const payload = new Uint8Array(1 + part.length);
    payload[0] = RAWM.NOTIFY.INFO;
    payload.set(part, 1);
    const f = RAWM.frame(RAWM.CMD.NOTIFY, payload);
    for (let k = 0; k < f.length; k += 45) t.ingest(status(f.subarray(k, k + 45)));
  }
  if (seen.info && seen.info.dn === 'LEVIATHAN V4' && seen.info.battery === 78) pass++;
  else console.error('FAIL wired status report', { buf: t.buffer.length, json: (t.infoText || '').length });
}

console.log(`${pass}/8 transport checks passed`);
process.exit(pass === 8 ? 0 : 1);
