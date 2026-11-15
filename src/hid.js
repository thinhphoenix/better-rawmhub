/* ─────────────────────────────────────────────────────────────────────
   RAWM HID transport
   Reconstructed from the vendor bundle (library.min.js, build 2026-06-01)
   and the public device catalogue. Covers the mouse "CMD" protocol used
   by RAWM receivers and wired mice, plus the HS query handshake used by
   RAWM magnetic keyboards. Everything is logged so a real device can be
   diagnosed from the in-app console.

   Inbound reports, as measured on hardware:
   · dongle:   [0x80|len][frame bytes]              frame = [cmd|len hi][len lo][payload]
   · wired:    report id 0x52 carries an 18-byte device header (counter,
               current CPI, flags) in front of the same byte stream, so the
               payload starts at byte 19; short reports (0x89/0x91/0xa2) carry
               the stream directly with the id equal to 0x80|len.
   · the query answer arrives either as a QUERY_RESULT frame (dongle) or as
     notify 0x0c JSON chunks (wired) — both are accepted here.
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
    INFO: 0x0c,
    BATTERY: 0x17,
    RSSI: 0x1c,
    GLASS_MODE: 0x21,
    ONBOARD_INDEX: 0x22,
  };

  const LED = { BLINK: 0x80, ROTATE: 0x40, AUTO_OFF: 0x20, CPI: 0x10, FLAG: 0x08, R: 0x04, G: 0x02, B: 0x01 };

  /* Every wired input report ends with this 29-byte device trailer (status
     counters). It is not part of the byte stream. */
  const STREAM_TRAILER = 29;

  /* Fields carried by the query-result JSON. The app reads a subset, but the
     whole set is kept so wiring a device through the field-wise recovery path
     builds the same config as a clean JSON parse. */
  const INFO_KEYS = [
    'r', 'rc', 'dn', 'pi', 'vi', 'battery', 'chg', 'cpi', 'cpi_l', 'cpi_l_c',
    'polling', 'light', 'lod', 'lod_c', 'ms', 'at', 'at2', 'cn', 'pm', 'kd',
    'ocn', 'oci', 'ocs', 'ec', 'dgom', 'sst', 'lbn', 'hc', 'rr', 'rrc', 'ht',
    'esb_selected', 'esb_addr', 'lz', 'st', 'rf_ch', 'top', 'atp', 'co',
    'noack', 'lua', 'gm', 'ob', 'msg', 'crc',
  ];

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
      this.viaFeature = false;
      this.noOutput = false;
      this.txQueue = [];
      this.txTimer = null;
      this.txOffset = 0;
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
      this.viaFeature = false;
      this.noOutput = false;
      this.txQueue = [];
      this.txTimer = null;
      this.txOffset = 0;
      this.hs = !!(profile && profile.soc === 'HS');
      this.info = null;
      this.queryText = '';
      this.infoText = '';
      this.stream = '';
      this.queryAttempts = 0;

      // Pick the actual output report from the descriptor. Receivers and
      // keyboards are not always 64-byte reports; writing the wrong length
      // makes Chrome reject the report.
      if (!this.hs) {
        const outputs = [];
        const features = [];
        for (const collection of hidDevice.collections || []) {
          for (const report of collection.outputReports || []) {
            const bits = (report.items || []).reduce((n, item) => n + (item.reportSize || 0) * (item.reportCount || 0), 0);
            outputs.push({ id: report.reportId, bytes: Math.ceil(bits / 8) });
          }
          for (const report of collection.featureReports || []) {
            const bits = (report.items || []).reduce((n, item) => n + (item.reportSize || 0) * (item.reportCount || 0), 0);
            features.push({ id: report.reportId, bytes: Math.ceil(bits / 8) });
          }
        }
        this.outputs = outputs;
        this.log('info', `output reports: ${outputs.map((o) => `${o.id}:${o.bytes}B`).join(', ') || 'none'}`);
        this.log('info', `feature reports: ${features.map((o) => `${o.id}:${o.bytes}B`).join(', ') || 'none'}`);
        const usable = outputs.filter((o) => o.bytes > 0).sort((a, b) => b.bytes - a.bytes)[0];
        if (usable) {
          this.reportId = usable.id;
          this.reportLength = usable.bytes;
          this.log('info', `using output report ${this.reportId}/${this.reportLength}B`);
        } else if (features.length) {
          const pick = features.filter((o) => o.bytes > 0).sort((a, b) => b.bytes - a.bytes)[0];
          this.viaFeature = true;
          this.reportId = pick.id;
          this.reportLength = pick.bytes;
          this.log('info', `no output report - trying feature report ${this.reportId}/${this.reportLength}B`);
        } else {
          this.noOutput = true;
          this.log('err', 'this HID interface has no output or feature reports; Chrome cannot write to it');
          this.emit('nooutput', null);
          return;
        }
      }
      this._onGone = null;
      hidDevice.addEventListener('inputreport', this._onReport);
      this._onGone = () => {
        this.log('err', 'device disconnected / rebooting');
        this.emit('gone', null);
      };
      hidDevice.addEventListener('disconnect', this._onGone);
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
      }, 700);
    }

    disconnect() {
      clearTimeout(this.queryTimer);
      clearInterval(this.queryRetry);
      clearInterval(this.pumpTimer);
      clearTimeout(this.txTimer);
      this.pumpTimer = null;
      this.queryRetry = null;
      this.txTimer = null;
      this.txQueue = [];
      this.txOffset = 0;
      const d = this.device;
      if (d) {
        try { d.removeEventListener('inputreport', this._onReport); } catch { /* noop */ }
        try { if (this._onGone) d.removeEventListener('disconnect', this._onGone); } catch { /* noop */ }
        if (d.opened) d.close().catch(() => {});
      }
      this._onGone = null;
      this.device = null;
      this.profile = null;
      this.channel = null;
      this.queue = [];
      this.buffer = new Uint8Array(0);
      this.crc = false;
      this.info = null;
    }

    async waitForIdle(timeout = 1500) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const busy = (this.queue && this.queue.length) || this.txQueue.length || this.txTimer || this.pumpTimer;
        if (!busy) return true;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return false;
    }

    emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    /* ── send ─────────────────────────────────────────────────────────── */

    query() {
      this.queryAttempts = (this.queryAttempts || 0) + 1;
      this.queryText = '';
      this.queryAt = Date.now();
      clearTimeout(this.queryTimer);
      this.queryTimer = setTimeout(() => {
        if (this.device && !this.info) {
          this.emit('timeout', null);
          this.log('err', `no query response after ${Date.now() - this.queryAt} ms — check 2.4 GHz mode / USB cable, close other HID software, then retry`);
          this.log('rx', `buffer ${this.buffer.length}B · json ${(this.infoText || '').length}B · tail ${hex(this.buffer.subarray(-96))}`);
        }
      }, 5000);
      const secs = Math.floor(Date.now() / 1000);
      const payload = new Uint8Array(10);
      payload[0] = 3;           // OS_PC
      payload[1] = 0;
      payload[2] = 0;
      // 7-byte little-endian timestamp, matching send_event_query()
      let v = secs;
      for (let i = 3; i < 10; i++) {
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
      this.txQueue.push(body);
      this.drainTx();
    }

    drainTx() {
      if (!this.device || this.txTimer || !this.txQueue.length) return;
      const body = this.txQueue[0];
      const prefix = this.channel !== null ? 1 : 0;
      const max = this.reportLength - prefix - 1;
      if (max <= 0) {
        this.txQueue.shift();
        this.txOffset = 0;
        return;
      }
      const chunk = body.subarray(this.txOffset, this.txOffset + max);
      const report = new Uint8Array(this.reportLength);
      let off = 0;
      if (prefix) {
        report[0] = 0xc0 | (this.channel & 0x3f);
        off = 1;
      }
      report[off] = 0x80 | chunk.length;
      report.set(chunk, off + 1);
      this.sendReport(report);
      this.txOffset += chunk.length;
      if (this.txOffset < body.length) {
        this.txTimer = setTimeout(() => { this.txTimer = null; this.drainTx(); }, 25);
      } else {
        this.txQueue.shift();
        this.txOffset = 0;
        this.txTimer = setTimeout(() => { this.txTimer = null; this.drainTx(); }, 10);
      }
    }

    writeHsFrame(command, payload) {
      const report = new Uint8Array(this.reportLength || 32);
      report[0] = command;
      report.set(payload.subarray(0, report.length - 1), 1);
      this.sendReport(report);
    }

    sendReport(report) {
      if (this.noOutput) {
        this.log('err', 'ignored write: this HID interface has no output/feature report');
        return;
      }
      if (this.viaFeature) {
        const data = new Uint8Array(this.reportLength);
        data.set(report.subarray(0, this.reportLength));
        this.log('tx', `feature ${this.reportId}/${this.reportLength}B ${hex(data, 72)}`);
        try {
          const result = this.device.sendFeatureReport(this.reportId, data);
          if (result && typeof result.catch === 'function') {
            result.catch((err) => {
              this.log('err', 'sendFeatureReport rejected: ' + err.message);
              this.emit('error', err);
            });
          }
          this.pollFeature();
        } catch (err) {
          this.log('err', 'sendFeatureReport failed: ' + err.message);
          this.emit('error', err);
        }
        return;
      }
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

    pollFeature() {
      let n = 0;
      const tick = async () => {
        if (n++ > 4 || !this.device) return;
        try {
          const view = await this.device.receiveFeatureReport(this.reportId);
          if (view && view.byteLength) {
            const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
            this.log('rx', 'feature ' + hex(data, 72));
            this.ingest(data);
          }
        } catch { /* no feature response */ }
        setTimeout(tick, 60);
      };
      tick();
    }

    sendHs(command, bytes = []) {
      this.enqueue(command, new Uint8Array(bytes));
    }

    sendConfig(type, payload) {
      const body = new Uint8Array([type, ...payload]);
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
      if (head === 0x52) {
        /* Wired status report: [0x52][18-byte device header][16 stream bytes]
           [29-byte device trailer]. The header and the trailer both have to be
           dropped or they land in the middle of the byte stream and break every
           frame and JSON chunk that spans reports. */
        const end = data.length > off + 19 + STREAM_TRAILER ? data.length - STREAM_TRAILER : data.length;
        if (end <= off + 19) return;
        this.feed(data.subarray(off + 19, end));
        return;
      }
      if (head === 0x40) return; // buffer-size advertisement, no payload
      if ((head & 0xc0) === 0x80) {
        const n = head & 0x3f;
        this.feed(data.subarray(off + 1, off + 1 + n));
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
      /* Keep the raw byte stream too: wired firmware interleaves the JSON with
         a per-report device trailer and re-sends it every retry, so only a
         field-wise scan over the stream survives. */
      if (!this.info) {
        this.stream = (this.stream || '') + new TextDecoder('latin1').decode(chunk);
        if (this.stream.length > 8192) this.stream = this.stream.slice(-4096);
      }
      this.drain();
    }

    /* True when the head of the buffer is an unfinished frame or JSON object.
       Its payload bytes (JSON text in particular) look like frames, so the
       scanner must wait instead of consuming them. */
    headIncomplete() {
      if (this.info || !this.buffer.length) return false;
      const head = this.buffer[0];
      if (head === 0x7b) {
        for (let k = 0; k < this.buffer.length; k++) if (this.buffer[k] === 0x7d) return false;
        return true;
      }
      if (this.buffer.length < 2) return false;
      const cmd = head & 0x0f;
      const len = ((head & 0xf0) << 4) | this.buffer[1];
      const known = cmd === CMD.QUERY_RESULT || cmd === CMD.NOTIFY ||
        cmd === CMD.CONFIG || cmd === CMD.ACTION || cmd === CMD.PING;
      return known && len >= 3 && len <= 900 && this.buffer.length < len;
    }

    drain() {
      let i = 0;
      let parsedAny = false;
      while (i + 2 <= this.buffer.length) {
        if (i === 0 && this.headIncomplete()) return;
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
      if (!this.info) {
        // The JSON accumulator may already hold the whole object even though
        // notify frames were parsed from the same stream.
        const streamed = this.infoJson();
        if (streamed) { this.acceptInfo(streamed, 'json stream'); return; }
        // A complete object found in the raw buffer beats field-wise recovery:
        // it carries every value, including the DPI stage list.
        this.salvageJson();
        if (this.info) return;
        const fields = this.extractInfo();
        if (fields) this.acceptInfo(fields, 'stream fields');
      }
    }

    /* Field-wise recovery. Wired firmware packs the JSON into reports that also
       carry a device trailer, and re-sends the whole message on every retry, so
       the object never appears as one contiguous string. Every "key":value whose
       value ends at a delimiter is still intact, so collect those.

       Only used once the answer is complete: accepting the first few keys would
       pin an info object without cpi / polling / cpi_l and the app would fall
       back to catalogue defaults (the "wrong DPI" symptom). */
    extractInfo() {
      const stream = this.stream || '';
      if (stream.length < 128) return null;
      if (stream.lastIndexOf('}') < 0) return null;
      const grab = (key) => {
        const re = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]|-?\\d+(?:\\.\\d+)?|true|false)(?=\\s*[,}])', 'g');
        let m;
        let last;
        while ((m = re.exec(stream)) !== null) last = m[1];
        if (last === undefined) return undefined;
        try { return JSON.parse(last); } catch { return last; }
      };
      const info = {};
      for (const key of INFO_KEYS) {
        const value = grab(key);
        if (value !== undefined) info[key] = value;
      }
      if (info.r == null || (info.pi == null && info.dn == null)) return null;
      // DPI and polling must be present, otherwise the config falls back to
      // catalogue defaults and shows values the mouse does not have.
      if (info.cpi == null && info.polling == null) return null;
      return info;
    }

    /* Last-resort handshake parser: some firmware revisions send the query
       result as JSON without the frame envelope. */
    salvageJson() {
      if (this.buffer.length < 16) return;
      const text = new TextDecoder().decode(this.buffer);
      const end = text.lastIndexOf('}');
      if (end < 0) return;
      const starts = [text.indexOf('{')];
      const lastStart = text.lastIndexOf('{');
      if (lastStart > starts[0]) starts.push(lastStart);
      const isInfo = (o) => !!o && (o.r !== undefined || o.cpi !== undefined || o.battery !== undefined || o.pi !== undefined);
      for (const start of starts) {
        if (start < 0 || end <= start) continue;
        try {
          const info = JSON.parse(text.slice(start, end + 1));
          if (!isInfo(info)) continue;
          this.acceptInfo(info, 'salvaged');
          return;
        } catch { /* incomplete JSON, wait for more */ }
      }
    }

    /* ── device info ───────────────────────────────────────────────────── */

    /* Wired firmware answers the query with the info JSON inside notify 0x0c
       chunks instead of a QUERY_RESULT frame, so keep a text accumulator and
       parse it once the object closes. */
    pushInfoText(text) {
      if (!text) return;
      this.infoText = (this.infoText || '') + text;
      if (this.infoText.length > 65536) this.infoText = this.infoText.slice(-32768);
    }

    infoJson() {
      const text = this.infoText || '';
      if (text.length < 24) return null;
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      const isInfo = (o) => !!o && (o.r !== undefined || o.cpi !== undefined || o.battery !== undefined || o.pi !== undefined);
      // Whole span first, then the most recent object: a failed earlier attempt
      // can leave a truncated copy in front of a complete one.
      const starts = [start];
      const lastStart = text.lastIndexOf('{');
      if (lastStart > start) starts.push(lastStart);
      for (const from of starts) {
        try {
          const info = JSON.parse(text.slice(from, end + 1));
          if (isInfo(info)) return info;
        } catch { /* try the next start */ }
      }
      return null;
    }

    acceptInfo(info, how) {
      clearTimeout(this.queryTimer);
      clearInterval(this.queryRetry);
      this.queryRetry = null;
      this.queryText = '';
      this.infoText = '';
      this.stream = '';
      // The stream still holds the query answer as text; drop it so the scanner
      // cannot mistake JSON bytes for frames later.
      if (!this.info) this.buffer = new Uint8Array(0);
      if (this.isReceiver && this.channel === null) {
        // A dongle answers first. Show its info, then ask the paired device on
        // channel 0; the mouse/keyboard replies with its own product id and name.
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
      this.crc = info.crc === 1;
      const took = this.queryAt ? ` · +${Date.now() - this.queryAt} ms` : '';
      this.log('rx', `device info${how ? ' (' + how + ')' : ''}${took} ` + JSON.stringify(info).slice(0, 400));
      this.emit('info', info);
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
        this.pushInfoText(text);
        let info = null;
        try { info = JSON.parse(this.queryText); } catch { /* chunked, wait for more */ }
        if (!info) info = this.infoJson();
        if (info) { this.acceptInfo(info, 'query result'); return; }
        return;
      }
      if (cmd === CMD.NOTIFY) {
        const type = payload[0];
        const value = payload.subarray(1);
        if (type === NOTIFY.INFO) {
          this.pushInfoText(new TextDecoder().decode(value));
          const info = this.infoJson();
          if (info) { this.acceptInfo(info, 'notify json'); return; }
          this.log('rx', `info json ${(this.infoText || '').length}B · ${hex(value, 24)}`);
          return;
        }
        const notify = { type, value };
        if (type === NOTIFY.CPI && value.length >= 2) notify.cpi = value[0] | (value[1] << 8);
        if (type === NOTIFY.CPI && value.length >= 4) notify.cpi = (value[0] | (value[1] << 8) | (value[2] << 16) | (value[3] << 24)) >>> 0;
        if (type === NOTIFY.POLLING && value.length >= 2) notify.polling = value[0] | (value[1] << 8);
        if (type === NOTIFY.BATTERY) notify.battery = value[0];
        if (type === NOTIFY.BATTERY && value.length >= 2) notify.chg = value[1];
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
      // The firmware expects a fixed eight-entry table (unused slots are 0),
      // not a shortened list of active stages.
      const levels = Array.from({ length: 8 }, (_, i) => Number(cfg.dpiLevels[i]) || 0);
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

      const batteryLevels = info.battery_levels || info.batteryLevels ||
        (this.profile && this.profile.battery_levels) || [];
      p.push(batteryLevels.length);
      batteryLevels.forEach((n) => push16(n));
      p.push(info.autoTxPower || 0);

      const status = cfg.onboardStatus || [];
      p.push(status.length);
      status.forEach((c) => p.push(c & 0xff));
      p.push(cfg.glassMode ? 1 : 0);

      this.sendConfig(CFG.MOUSE_PARAM, p);
      this.log('tx', `mouse params · ${cfg.cpiX}${xy ? '×' + cfg.cpiY : ''} dpi · ${cfg.polling} Hz · level ${cfg.onboard} · ${p.length}B`);
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

    reboot() {
      this.sendAction(ACTION.REBOOT, 0);
      this.log('tx', 'action · reboot device');
    }

    async reconnect() {
      if (!this.profile || !navigator.hid) return false;
      const profile = this.profile;
      const devices = await navigator.hid.getDevices();
      const device = devices.find((d) => d.vendorId === VENDOR_ID && Number(d.productId) === Number(profile.product_id));
      if (!device) return false;
      await this.connect(device, profile);
      return true;
    }

    restore() {
      this.sendAction(ACTION.RESTORE, 0);
      this.log('tx', 'action · factory restore');
    }
  }

  return { VENDOR_ID, CMD, CFG, ACTION, NOTIFY, LED, Transport, crc16, frame, hex };
})();
