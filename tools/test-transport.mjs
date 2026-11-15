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

// 8. Wired firmware: a 0x52 status report is [0x52][18-byte header]
//    [stream bytes][29-byte trailer]; the frame inside must survive both.
{
  const { t, seen } = makeTransport();
  const notes = [];
  t.addEventListener('notify', (e) => notes.push(e.detail));
  const header = [0x15, 0x24, 0, 0, 0x80, 0x0c, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0x28, 0, 0];
  const trailer = [0, 0, 0, 0x70, 0x20, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x9b, 0x65, 0, 8, 0, 0, 0, 0, 0xbf, 0x42, 0, 8, 0x18];
  const batteryFrame = RAWM.frame(RAWM.CMD.NOTIFY, new Uint8Array([RAWM.NOTIFY.BATTERY, 78, 1]));
  t.ingest(new Uint8Array([0x52, ...header, ...batteryFrame, ...trailer]));
  if (t.buffer.length === 0 && notes.some((n) => n.battery === 78)) pass++;
  else console.error('FAIL wired status report', { buf: t.buffer.length, notes: notes.length });
}

// 9. Wired retransmits: the same JSON text arrives 34 bytes at a time in 0xa2
//    reports, each followed by the device trailer, twice over.
{
  const { t, seen } = makeTransport();
  const trailer = [0, 0, 0, 0x70, 0x20, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x9b, 0x65, 0, 8, 0, 0, 0, 0, 0xbf, 0x42, 0, 8, 0x18];
  const body = enc.encode(JSON.stringify({
    r: 'G-1.0.0', rc: 6, dn: 'LEVIATHAN V4', pi: 9034, vi: 6421, battery: 100, chg: 1,
    cpi: 3200, polling: 1000, light: 66, cpi_l: [400, 800, 1600, 3200, 0, 0, 0, 0], crc: 1,
  }));
  for (let copy = 0; copy < 2; copy++) {
    for (let i = 0; i < body.length; i += 34) {
      const part = body.subarray(i, i + 34);
      t.ingest(new Uint8Array([0x80 | part.length, ...part, ...trailer]));
    }
  }
  const got = seen.info;
  if (got && got.dn === 'LEVIATHAN V4' && got.battery === 100 && got.cpi === 3200) pass++;
  else console.error('FAIL stream fields', got);
}

// 10. A half-received answer must not be pinned: DPI and polling only arrive
//     later in the payload, and accepting early freezes catalogue defaults.
{
  const { t, seen } = makeTransport();
  const send = (bytes) => {
    for (let i = 0; i < bytes.length; i += 34) {
      const part = bytes.subarray(i, i + 34);
      t.ingest(new Uint8Array([0x80 | part.length, ...part]));
    }
  };
  send(enc.encode('{"r":"G-1.0.0","dn":"LEVIATHAN V4","pi":9034'));
  const early = seen.info;
  send(enc.encode(',"battery":100,"chg":1,"cpi":1600,"polling":8000,"cpi_l":[400,1600,3200,0,0,0,0,0],"crc":1}'));
  const got = seen.info;
  if (!early && got && got.cpi === 1600 && got.polling === 8000 && Array.isArray(got.cpi_l)) pass++;
  else console.error('FAIL partial answer pinned', { early, got });
}

console.log(`${pass}/10 transport checks passed`);
process.exit(pass === 10 ? 0 : 1);
