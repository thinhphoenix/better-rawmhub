/* HID error classification and the Linux udev helpers. Pure functions, so they
   run without a browser: the same code the page uses decides what the user is
   told after a failed open. */
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../src/hid.js', import.meta.url), 'utf8') + '\nreturn RAWM;';
const RAWM = new Function(code)();

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
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const fail = (name, message = 'Failed to open the device.') => new DOMException(message, name);
const classify = (err, context = {}) => RAWM.classifyHidError(err, context);

const WEBHID_LINUX = { stage: 'open', protocol: 'webhid', platform: 'linux', fileProtocol: false };

check('cancelled device picker is not a permission problem', () => {
  const info = classify(fail('NotFoundError', 'No device selected.'), { stage: 'request', protocol: 'webhid', platform: 'linux' });
  equal(info.kind, 'no-device-selected', 'kind');
  equal(info.stage, 'request', 'stage');
});

check('NotAllowedError on open + Linux + WebHID is the hidraw case', () => {
  const info = classify(fail('NotAllowedError'), WEBHID_LINUX);
  equal(info.kind, 'linux-permission', 'kind');
  equal(info.name, 'NotAllowedError', 'name');
  equal(info.message, 'Failed to open the device.', 'message');
  equal(info.platform, 'linux', 'platform');
});

check('NotAllowedError on open + macOS has its own hint', () => {
  equal(classify(fail('NotAllowedError'), { ...WEBHID_LINUX, platform: 'macos' }).kind, 'macos-permission', 'kind');
});

check('NotAllowedError on open elsewhere is a plain open failure', () => {
  equal(classify(fail('NotAllowedError'), { ...WEBHID_LINUX, platform: 'windows' }).kind, 'open-failed', 'windows');
  equal(classify(fail('NotAllowedError'), { ...WEBHID_LINUX, platform: 'other' }).kind, 'open-failed', 'other');
});

check('NotAllowedError during requestDevice is a browser permission', () => {
  const info = classify(fail('NotAllowedError'), { ...WEBHID_LINUX, stage: 'request' });
  equal(info.kind, 'browser-permission', 'kind');
});

check('SecurityError is a browser permission at any stage', () => {
  for (const stage of ['request', 'open']) {
    equal(classify(fail('SecurityError'), { ...WEBHID_LINUX, stage }).kind, 'browser-permission', stage);
  }
});

check('a bridge transport never reports an OS permission problem', () => {
  const info = classify(fail('NotAllowedError'), { stage: 'open', protocol: 'bridge', platform: 'linux' });
  equal(info.kind, 'open-failed', 'kind');
  equal(info.protocol, 'bridge', 'protocol');
});

check('bridge error codes keep their own kinds', () => {
  const codeErr = (value) => Object.assign(new Error(value), { code: value });
  equal(classify(codeErr('pair-required')).kind, 'bridge-pair', 'pair-required');
  equal(classify(codeErr('no-daemon')).kind, 'bridge-down', 'no-daemon');
  equal(classify(codeErr('no-device')).kind, 'bridge-no-device', 'no-device');
  equal(classify(codeErr('device-busy')).kind, 'device-busy', 'device-busy');
});

check('InvalidStateError on open means the device is already open', () => {
  equal(classify(fail('InvalidStateError', 'The device is already open.'), WEBHID_LINUX).kind, 'device-busy', 'kind');
});

check('file:// wins over permission kinds but not over a cancelled picker', () => {
  const file = { ...WEBHID_LINUX, fileProtocol: true };
  equal(classify(fail('NotAllowedError'), file).kind, 'file-protocol', 'NotAllowedError on file://');
  equal(classify(fail('NotFoundError'), { ...file, stage: 'request' }).kind, 'no-device-selected', 'cancelled on file://');
});

check('unknown errors stay unknown and keep the message', () => {
  const info = classify(new Error('boom'), {});
  equal(info.kind, 'unknown', 'kind');
  equal(info.message, 'boom', 'message');
  equal(info.platform, 'other', 'platform defaults to other');
  equal(info.protocol, 'webhid', 'protocol defaults to webhid');
  equal(info.stage, 'open', 'stage defaults to open');
});

check('the udev rule is scoped to vendor and product, lowercase hex', () => {
  equal(
    RAWM.udevRule({ productId: 0x2346 }),
    'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1915", ATTRS{idProduct}=="2346", TAG+="uaccess"',
    'rule',
  );
  equal(
    RAWM.udevRule({ vendorId: 0x1915, productId: 0x0a1b }),
    'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1915", ATTRS{idProduct}=="0a1b", TAG+="uaccess"',
    'lowercase',
  );
});

check('the udev rule degrades to the vendor when the product is unknown', () => {
  equal(RAWM.udevRule(), 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1915", TAG+="uaccess"', 'default');
  equal(RAWM.udevRule({ productId: null }), 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1915", TAG+="uaccess"', 'null product');
});

check('the install script reloads, triggers and verifies', () => {
  const script = RAWM.udevInstallScript({ productId: 0x2346 });
  for (const needle of [
    '/etc/udev/rules.d/70-better-rawmhub.rules',
    'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1915", ATTRS{idProduct}=="2346", TAG+="uaccess"',
    'sudo udevadm control --reload-rules',
    'sudo udevadm trigger --subsystem-match=hidraw',
    'ls -l /dev/hidraw*',
  ]) {
    if (!script.includes(needle)) throw new Error(`script is missing ${needle}`);
  }
});

check('the one command is the published script with the product scope', () => {
  equal(
    RAWM.udevOneLiner({ productId: 0x2346 }),
    'curl -fsSL https://raw.githubusercontent.com/thinhphoenix/better-rawmhub/main/scripts/linux-udev.sh | sudo sh -s -- --product 2346',
    'line',
  );
  const vendorOnly = RAWM.udevOneLiner({});
  if (vendorOnly.includes('--product')) throw new Error('the vendor-wide command must not narrow the product');
  if (!vendorOnly.includes('sudo sh')) throw new Error('the command must run through sudo');
});

check('scripts/linux-udev.sh stays in sync with the generated commands', () => {
  const script = readFileSync(new URL('../scripts/linux-udev.sh', import.meta.url), 'utf8');
  for (const needle of [
    '70-better-rawmhub.rules',
    '/etc/udev/rules.d',
    'ATTRS{idVendor}',
    'TAG+=',
    'uaccess',
    'udevadm control --reload-rules',
    'udevadm trigger --subsystem-match=hidraw',
  ]) {
    if (!script.includes(needle)) throw new Error(`scripts/linux-udev.sh is missing ${needle}`);
  }
  for (const banned of ['chmod 666', '--no-sandbox']) {
    if (script.includes(banned)) throw new Error(`scripts/linux-udev.sh mentions ${banned}`);
  }
});

check('the guidance never suggests an unsafe workaround', () => {
  const text = `${RAWM.udevRule({ productId: 0x2346 })}\n${RAWM.udevInstallScript({ productId: 0x2346 })}`;
  for (const banned of ['chmod 666', '--no-sandbox', 'chmod -R 777']) {
    if (text.includes(banned)) throw new Error(`script mentions ${banned}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
