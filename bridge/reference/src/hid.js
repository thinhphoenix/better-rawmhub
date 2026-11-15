/* HID access for the bridge. hidapi (through node-hid) exposes one entry per
   top-level collection, so a mouse usually shows up once for its vendor
   interface and again for keyboard/mouse collections. Only the RAWM vendor id
   is ever listed, and the page picks the vendor-defined interface first. */
import HID from 'node-hid';

export const VENDOR_ID = 0x1915;

export function listDevices() {
  let devices = [];
  try {
    devices = HID.devices();
  } catch {
    devices = [];
  }
  return devices
    .filter((device) => device.vendorId === VENDOR_ID)
    .map((device, index) => ({
      id: device.path ? String(device.path) : `${device.vendorId}:${device.productId}:${index}`,
      path: device.path ? String(device.path) : null,
      vendorId: device.vendorId,
      productId: device.productId,
      productName: device.product || '',
      serialNumber: device.serialNumber || '',
      usagePage: Number.isFinite(device.usagePage) ? device.usagePage : null,
      usage: Number.isFinite(device.usage) ? device.usage : null,
      interface: Number.isFinite(device.interface) ? device.interface : null,
    }))
    .sort((a, b) => (b.usagePage || 0) - (a.usagePage || 0));
}

export class DeviceHandle {
  constructor(info, hooks, options = {}) {
    this.info = info;
    this.hooks = hooks;
    this.reportIds = options.reportIds !== false;
    this.device = null;
    this.closed = false;
  }

  open() {
    if (!this.info.path) throw new Error('this HID interface exposes no path to open');
    this.device = new HID.HID(this.info.path);
    this.device.on('data', (buf) => {
      if (this.closed || !buf) return;
      try { this.hooks.input(this, buf); } catch { /* page went away */ }
    });
    this.device.on('error', (err) => this.fail(err));
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    try { this.hooks.gone(this, err); } catch { /* noop */ }
  }

  /* hidapi wants the report id as the first byte on the way out; the page
     hand us the payload the same way Chrome's WebHID does, without it. */
  write(reportId, data) {
    if (!this.device) throw new Error('device is not open');
    const payload = Buffer.from(data);
    const buffer = this.reportIds ? Buffer.concat([Buffer.from([reportId & 0xff]), payload]) : payload;
    this.device.write(buffer);
  }

  sendFeature(reportId, data) {
    if (!this.device) throw new Error('device is not open');
    const payload = Buffer.from(data);
    const buffer = this.reportIds ? Buffer.concat([Buffer.from([reportId & 0xff]), payload]) : payload;
    this.device.sendFeatureReport(buffer);
  }

  readFeature(reportId) {
    if (!this.device) throw new Error('device is not open');
    const read = this.device.receiveFeatureReport || this.device.getFeatureReport;
    if (typeof read !== 'function') throw new Error('this node-hid build cannot read feature reports');
    const buffer = read.call(this.device, reportId & 0xff);
    if (!buffer || !buffer.length) return null;
    // hidapi always prefixes the report id on feature reads.
    return buffer.length > 1 ? buffer.subarray(1) : buffer;
  }

  close() {
    if (this.closed && !this.device) return;
    this.closed = true;
    const device = this.device;
    this.device = null;
    try { if (device) device.close(); } catch { /* unplugged */ }
  }
}
