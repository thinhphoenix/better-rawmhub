/* ─────────────────────────────────────────────────────────────────────
   RAWM HID transport
   Reconstructed from the vendor bundle (library.min.js, build 2026-06-01)
   and the public device catalogue. Covers the mouse "CMD" protocol used
   by RAWM receivers and wired mice, plus the HS query handshake used by
   RAWM magnetic keyboards. Everything is logged so a real device can be
   diagnosed from the in-app console.
   ───────────────────────────────────────────────────────────────────── */

const RAWM = (() => {
  const VENDOR_ID = 0x1915;

  const CMD = {
    QUERY: 0x1,
    QUERY_RESULT: 0x2,
    CONFIG: 0x3,
    ACTION: 0x6,
    NOTIFY: 0xb,
    PING: 0xe,
  };

  const CFG = {
    MOUSE_PARAM: 0x15,
    MOUSE_KEY: 0x16,
    MOUSE_FUNCTION: 0x18,
    LIGHT: 0x12,
    SLEEP_TIME: 0x21,
    BRIGHTNESS: 0x31,
    CRC: 0x24,
  };

  const ACTION = {
    SAVE_CONFIG_TO_FDS: 0x34,
    RESTORE: 0x35,
    REBOOT: 0x33,
    READ_RSSI: 0x42,
  };

  const NOTIFY = {
    CPI: 0x00,
    POLLING: 0x01,
    BATTERY: 0x17,
    RSSI: 0x1c,
    GLASS_MODE: 0x21,
    ONBOARD_INDEX: 0x22,
  };

  const LED = { BLINK: 0x80, ROTATE: 0x40, AUTO_OFF: 0x20, CPI: 0x10, FLAG: 0x08, R: 0x04, G: 0x02, B: 0x01 };

  /* CRC-16/CCITT-FALSE as implemented by crc16_compute() in the bundle. */
  function crc16(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (((crc >> 8) | (crc << 8)) & 0xffff) ^ bytes[i];
      crc ^= (crc & 0xff) >> 4;
      crc = (crc ^ ((crc << 8) << 4)) & 0xffff;
      crc = (crc ^ (((crc & 0xff) << 4) << 1)) & 0xffff;
    }
    return crc & 0xffff;
  }

  function frame(command, payload) {
    const len = payload.length + 2;
    if (len > 0xfff) throw new Error('packet too large');
    const out = new Uint8Array(len);
    out[0] = ((len >> 4) & 0xf0) | (command & 0x0f);
    out[1] = len & 0xff;
    out.set(payload, 2);
    return out;
  }

  function hex(bytes, max = 96) {
    return Array.from(bytes.subarray(0, max))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }

  class Transport extends EventTarget {
    constructor(log) {
      super();
      this.log = log || (() => {});
      this.device = null;
      this.profile = null;
      this.channel = null;
      this.crc = false;
      this.buffer = new Uint8Array(0);
      this.queue = [];
      this.pumpTimer = null;
      this.queryTimer = null;
      this.queryRetry = null;
      this.isReceiver = false;
      this.reportId = 0;
      this.outputs = [];
      this.info = null;
      this._onReport = this._onReport.bind(this);
    }

    static get supported() {
      return typeof navigator !== 'undefined' && !!navigator.hid;
    }

    static async authorised() {
      if (!Transport.supported) return [];
      try { return await navigator.hid.getDevices(); } catch { return []; }
    }

    static async request() {
      if (!Transport.supported) throw new Error('WebHID is not available in this browser.');
      const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: VENDOR_ID }],
      });
      return devices || [];
    }

    async connect(hidDevice, profile) {
      this.disconnect();
      if (!hidDevice) throw new Error('No device selected.');
      if (!hidDevice.opened) await hidDevice.open();
      this.device = hidDevice;
      this.profile = profile || null;
      this.crc = false;
      this.buffer = new Uint8Array(0);
      this.queue = [];
      this.isReceiver = !!(profile && profile.receiver);
      // A receiver must first answer on the direct channel; only after its
      // paired-device info arrives do we route packets to channel 0.
      this.channel = null;
      this.receiverInfo = null;
      this.reportLength = Number(profile && profile.report_len) || 64;
      this.reportId = 0;
      this.outputs = [];
      this.hs = !!(profile && profile.soc === 'HS');
      this.info = null;
      this.queryText = '';
      this.queryAttempts = 0;

      // Pick the actual output report from the descriptor. Receivers and
      // keyboards are not always 64-byte reports; writing the wrong length
      // makes Chrome reject the report.
      if (!this.hs) {
        const outputs = [];
        for (const collection of hidDevice.collections || []) {
          for (const report of collection.outputReports || []) {
            const bits = (report.items || []).reduce((n, item) => n + (item.reportSize || 0) * (item.reportCount || 0), 0);
            outputs.push({ id: report.reportId, bytes: Math.ceil(bits / 8) });
          }
        }
        this.outputs = outputs;
        const usable = outputs.filter((o) => o.bytes > 0).sort((a, b) => b.bytes - a.bytes)[0];
        if (usable) {
          this.reportId = usable.id;
          this.reportLength = usable.bytes;
        }
        this.log('info', `output reports: ${outputs.map((o) => `${o.id}:${o.bytes}B`).join(', ') || 'none'} → ${this.reportId}/${this.reportLength}B`);
      }
      hidDevice.addEventListener('inputreport', this._onReport);
      this.emit('open', { device: hidDevice, profile });
      this.log('rx', `opened ${hidDevice.productName || 'RAWM device'} — ${this.isReceiver ? 'receiver (direct, then channel 0)' : 'direct'}${this.hs ? ' (HS keyboard)' : ''}`);

      if (this.hs) {
        // HS keyboards answer a firmware query first; full key/axis config is
        // a separate command set. Ask for the software version so the
        // handshake is visible in the console.
        this.sendHs(0xf5);
        return;
      }

      this.query();
      this.startQueryRetry();
    }

    startQueryRetry() {
      clearInterval(this.queryRetry);
      this.queryRetry = setInterval(() => {
        if (!this.device || this.info || this.queryAttempts >= 3) {
          clearInterval(this.queryRetry);
          this.queryRetry = null;
          return;
        }
        this.query();
      }, 1400);
    }

    disconnect() {
      clearTimeout(this.queryTimer);
      clearInterval(this.queryRetry);
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
      this.queryRetry = null;
      const d = this.device;
      if (d) {
        try { d.removeEventListener('inputreport', this._onReport); } catch { /* noop */ }
        if (d.opened) d.close().catch(() => {});
      }
      this.device = null;
      this.profile = null;
      this.channel = null;
      this.queue = [];
      this.buffer = new Uint8Array(0);
      this.crc = false;
      this.info = null;
    }

    emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    /* ── send ─────────────────────────────────────────────────────────── */

    query() {
      this.queryAttempts = (this.queryAttempts || 0) + 1;
      this.queryText = '';
      clearTimeout(this.queryTimer);
      this.queryTimer = setTimeout(() => {
        if (this.device && !this.info) {
          this.emit('timeout', null);
          this.log('err', 'no query response — check 2.4 GHz mode / USB cable, close other HID software, then retry');
        }
      }, 5000);
      const secs = Math.floor(Date.now() / 1000);
      const payload = new Uint8Array(12);
      payload[0] = 0;           // reserved
      payload[1] = 3;           // OS_PC
      payload[2] = 0;
      payload[3] = 0;
      // 7-byte little-endian timestamp, matching send_event_query()
      let v = secs;
      for (let i = 4; i < 11; i++) {
        payload[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      this.enqueue(CMD.QUERY, payload);
      this.log('tx', 'query device info');
    }

    enqueue(command, payload) {
      this.queue.push({ command, payload });
      if (!this.pumpTimer) {
        this.pumpTimer = setInterval(() => this.pump(), 22);
      }
      this.pump();
    }

    pump() {
      if (!this.device) return;
      const job = this.queue.shift();
      if (!job) {
        clearInterval(this.pumpTimer);
        this.pumpTimer = null;
        return;
      }
      try {
        if (this.hs) {
          this.writeHsFrame(job.command, job.payload);
        } else {
          const packet = frame(job.command, job.payload);
          const body = this.crc ? this.wrapCrc(packet) : packet;
          this.writeBody(body);
        }
      } catch (err) {
        this.log('err', 'send failed: ' + err.message);
        this.emit('error', err);
      }
    }

    wrapCrc(packet) {
      const total = packet.length + 5;
      const out = new Uint8Array(total);
      out[0] = ((total >> 4) & 0xf0) | CMD.CONFIG;
      out[1] = total & 0xff;
      out[2] = CFG.CRC;
      const sum = crc16(packet);
      out[3] = sum & 0xff;
      out[4] = (sum >> 8) & 0xff;
      out.set(packet, 5);
      return out;
    }

    writeBody(body) {
      const report = new Uint8Array(this.reportLength);
      let off = 0;
      if (this.channel !== null) {
        report[0] = 0xc0 | (this.channel & 0x3f);
        off = 1;
      }
      const chunk = body.subarray(0, this.reportLength - off - 1);
      report[off] = 0x80 | chunk.length;
      report.set(chunk, off + 1);
      this.sendReport(report);
    }

    writeHsFrame(command, payload) {
      const report = new Uint8Array(this.reportLength || 32);
      report[0] = command;
      report.set(payload.subarray(0, report.length - 1), 1);
      this.sendReport(report);
    }

    sendReport(report) {
      const tried = new Set();
      const fail = (err) => {
        this.log('err', `sendReport rejected: ${err.message} (id ${this.reportId}, ${report.length}B)`);
        this.emit('error', err);
      };
      const attempt = (id, length) => {
        tried.add(`${id}:${length}`);
        const data = new Uint8Array(length);
        data.set(report.subarray(0, length));
        this.reportId = id;
        this.reportLength = length;
        this.log('tx', `${id}/${length}B ${hex(data, 72)}`);
        const result = this.device.sendReport(id, data);
        if (!result || typeof result.catch !== 'function') return;
        result.catch((err) => {
          const next = [[0, 64], [0, 32]].find(([i, l]) => !tried.has(`${i}:${l}`));
          if (next) {
            this.log('info', `retrying output report ${next[0]}/${next[1]}B after: ${err.message}`);
            attempt(next[0], next[1]);
          } else {
            fail(err);
          }
        });
      };
      attempt(this.reportId, report.length);
    }

    sendHs(command, bytes = []) {
      this.enqueue(command, new Uint8Array(bytes));
    }

    sendConfig(type, payload) {
      const body = new Uint8Array([0, type, ...payload]);
      this.enqueue(CMD.CONFIG, body);
    }

    sendAction(action, value = 0) {
      const p = new Uint8Array(5);
      p[0] = action;
      p[1] = value & 0xff;
      p[2] = (value >> 8) & 0xff;
      p[3] = (value >> 16) & 0xff;
      p[4] = (value >> 24) & 0xff;
      this.enqueue(CMD.ACTION, p);
    }

    /* ── receive ──────────────────────────────────────────────────────── */

    _onReport(event) {
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      if (event.reportId) {
        const withId = new Uint8Array(data.length + 1);
        withId[0] = event.reportId;
        withId.set(data, 1);
        this.log('rx', hex(withId, 72));
        this.ingest(withId);
      } else {
        this.log('rx', hex(data, 72));
        this.ingest(data);
      }
    }

    /* Inbound reports are packetised:
         [0xC0|channel]? [0x80|length] [4-byte device header] [frame…]
       The vendor strips the first envelope and appends the rest, so a frame
       can span several reports. We do the same and then scan for a frame. */
    ingest(data) {
      let off = 0;
      if (data.length > 1 && (data[0] & 0xc0) === 0xc0) {
        off = 1;
        this.inboundChannel = data[0] & 0x3f;
      }
      if (off >= data.length) return;
      const head = data[off];
      if ((head & 0xc0) === 0x80) {
        const n = head & 0x3f;
        this.feed(data.subarray(off + 1, off + 1 + n));
      } else if ((head & 0xc0) === 0x40 && (head & 0x3f) === 0x00) {
        // Buffer-size advertisement, not an event frame.
      } else {
        // Unknown envelope: let the frame scanner try the whole report.
        this.feed(data.subarray(off));
      }
    }

    feed(chunk) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
      if (this.buffer.length > 8192) this.buffer = this.buffer.subarray(this.buffer.length - 4096);
      this.drain();
    }

    drain() {
      let i = 0;
      let parsedAny = false;
      while (i + 2 <= this.buffer.length) {
        const cmd = this.buffer[i] & 0x0f;
        const len = ((this.buffer[i] & 0xf0) << 4) | this.buffer[i + 1];
        const fits = len >= 3 && len <= 900 && i + len <= this.buffer.length;
        if (fits && this.plausible(cmd, i, len)) {
          const payload = this.buffer.slice(i + 2, i + len);
          this.buffer = this.buffer.slice(i + len);
          this.handle(cmd, payload);
          parsedAny = true;
          i = 0;
          continue;
        }
        i++;
      }
      // Drop leading noise but keep a possible partial frame near the end.
      while (this.buffer.length && this.buffer[0] === 0x00) this.buffer = this.buffer.subarray(1);
      if (this.buffer.length > 4096) this.buffer = this.buffer.subarray(this.buffer.length - 2048);
      if (!parsedAny && !this.info) this.salvageJson();
    }

    /* Last-resort handshake parser: some firmware revisions send the query
       result as JSON without the 4-byte device header / frame envelope. */
    salvageJson() {
      if (this.buffer.length < 16) return;
      const text = new TextDecoder().decode(this.buffer);
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return;
      try {
        const info = JSON.parse(text.slice(start, end + 1));
        if (!info || (info.r === undefined && info.cpi === undefined && info.battery === undefined && info.pi === undefined)) return;
        this.info = info;
        this.buffer = new Uint8Array(0);
        clearTimeout(this.queryTimer);
        clearInterval(this.queryRetry);
        this.queryRetry = null;
        this.log('rx', 'device info (salvaged) ' + JSON.stringify(info).slice(0, 400));
        this.emit('info', info);
      } catch { /* incomplete JSON, wait for more */ }
    }

    plausible(cmd, offset, len) {
      const payload = this.buffer.subarray(offset + 2, offset + len);
      if (cmd === CMD.QUERY_RESULT) {
        let j = payload.length - 1;
        while (j >= 0 && payload[j] === 0) j--;
        const first = payload[0];
        return (first === 0x7b || first === 0x5b) && j > 2;
      }
      if (cmd === CMD.NOTIFY) return payload.length >= 2 && payload[0] <= 0x30;
      if (cmd === CMD.CONFIG || cmd === CMD.ACTION || cmd === CMD.PING) return len <= 96;
      return false;
    }

    handle(cmd, payload) {
      if (cmd === CMD.QUERY_RESULT) {
        const text = new TextDecoder().decode(payload);
        this.queryText = (this.queryText || '') + text;
        this.queryText = this.queryText.replace(/\0+$/, '');
        let info = null;
        try { info = JSON.parse(this.queryText); } catch { /* chunked, wait for more */ }
        if (info) {
          clearTimeout(this.queryTimer);
          clearInterval(this.queryRetry);
          this.queryRetry = null;
          this.queryText = '';
          if (this.isReceiver && this.channel === null) {
            // A dongle answers first. Show its info, then ask the paired
            // device on channel 0; the mouse/keyboard replies with its own
            // product id and name.
            this.receiverInfo = info;
            this.info = info;
            if (info.crc === 1) this.crc = true;
            this.log('rx', 'receiver info — querying paired device on channel 0');
            this.emit('info', info);
            this.emit('peer', info);
            this.channel = 0;
            this.queryAttempts = 0;
            this.query();
            this.startQueryRetry();
            return;
          }
          this.info = info;
          if (info.crc === 1) this.crc = true;
          this.log('rx', 'device info ' + JSON.stringify(info).slice(0, 400));
          this.emit('info', info);
        }
        return;
      }
      if (cmd === CMD.NOTIFY) {
        const type = payload[0];
        const value = payload.subarray(1);
        const notify = { type, value };
        if (type === NOTIFY.CPI && value.length >= 2) notify.cpi = value[0] | (value[1] << 8);
        if (type === NOTIFY.CPI && value.length >= 4) notify.cpi = (value[0] | (value[1] << 8) | (value[2] << 16) | (value[3] << 24)) >>> 0;
        if (type === NOTIFY.POLLING && value.length >= 2) notify.polling = value[0] | (value[1] << 8);
        if (type === NOTIFY.BATTERY) notify.battery = value[0];
        if (type === NOTIFY.RSSI) notify.rssi = value[0];
        if (type === NOTIFY.ONBOARD_INDEX) notify.onboard = value[0];
        this.log('rx', `notify 0x${type.toString(16)} ${hex(value, 16)}`);
        this.emit('notify', notify);
        return;
      }
      this.emit('frame', { cmd, payload });
    }

    /* ── mouse config packets ─────────────────────────────────────────── */

    writeMouseConfig(cfg) {
      if (!this.device) throw new Error('No device connected');
      const info = this.info || {};
      const xy = !!(cfg.xy && (cfg.cpiX !== cfg.cpiY));
      const cpi = (cfg.cpiX & 0xffff) | ((xy ? cfg.cpiY : 0) & 0xffff) << 16;
      const levels = (cfg.dpiLevels || []).filter((n) => n > 0);
      const wide = levels.some((n) => (n & 0xffff0000) !== 0);

      const p = [];
      const push16 = (n) => { p.push(n & 0xff, (n >> 8) & 0xff); };

      if (xy) { p.push(0, 0); } else { push16(cfg.cpiX); }
      push16(cfg.polling);
      p.push(cfg.lightByte & 0xff);

      if (wide) p.push(0);
      else {
        p.push(levels.length);
        levels.forEach((n) => push16(n));
      }
      p.push(cfg.onboard & 0xff);
      p.push(cfg.powerMode & 0xff);

      if (xy) { p.push(cpi & 0xff, (cpi >> 8) & 0xff, (cpi >> 16) & 0xff, (cpi >> 24) & 0xff); }
      else p.push(0, 0, 0, 0);

      if (wide) p.push(0);
      else {
        p.push(levels.length);
        levels.forEach((n) => p.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff));
      }

      p.push(cfg.lod & 0xff);
      const delays = cfg.keyDelay || [];
      p.push(delays.length);
      delays.forEach((n) => p.push(n & 0xff));
      p.push(cfg.motionSync ? 1 : 0);
      p.push((cfg.angleTuning | 0) & 0xff);
      p.push(cfg.angleSnapping ? 1 : 0);
      p.push(cfg.rippleControl ? 1 : 0);

      const colors = cfg.levelColors || [];
      p.push(colors.length);
      colors.forEach((c) => p.push(c & 0x07));
      p.push(info.txOutputPower == null ? 0xff : info.txOutputPower);

      const batteryLevels = info.battery_levels || info.batteryLevels || [];
      p.push(batteryLevels.length);
      batteryLevels.forEach((n) => push16(n));
      p.push(info.autoTxPower || 0);

      const status = cfg.onboardStatus || [];
      p.push(status.length);
      status.forEach((c) => p.push(c & 0xff));
      p.push(cfg.glassMode ? 1 : 0);

      this.sendConfig(CFG.MOUSE_PARAM, p);
      this.log('tx', `mouse params · ${cfg.cpiX}${xy ? '×' + cfg.cpiY : ''} dpi · ${cfg.polling} Hz · level ${cfg.onboard}`);
    }

    writeLight(lightByte) {
      this.sendConfig(CFG.LIGHT, [lightByte & 0xff]);
    }

    writeBrightness(value) {
      this.sendConfig(CFG.BRIGHTNESS, [value & 0xff]);
    }

    writeSleep(seconds) {
      this.sendConfig(CFG.SLEEP_TIME, [seconds & 0xff, (seconds >> 8) & 0xff]);
    }

    writeGamingOnly(enabled) {
      this.sendConfig(0x27, [enabled ? 1 : 0]);
      this.log('tx', `firmware channel · ${enabled ? 'RAWM Gaming' : 'Standard'}`);
    }

    save() {
      this.sendAction(ACTION.SAVE_CONFIG_TO_FDS, 0);
      this.log('tx', 'action · save config to onboard memory');
    }

    restore() {
      this.sendAction(ACTION.RESTORE, 0);
      this.log('tx', 'action · factory restore');
    }
  }

  return { VENDOR_ID, CMD, CFG, ACTION, NOTIFY, LED, Transport, crc16, frame, hex };
})();
