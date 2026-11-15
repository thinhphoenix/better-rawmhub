# better-rawmhub-bridge

A small local daemon that gives **Firefox and Safari** access to a RAWM mouse or
keyboard, because neither browser ships WebHID (and Mozilla's standards position
on WebHID is negative).

The page never needs a browser extension. It opens a WebSocket to
`ws://127.0.0.1:47311/v1/ws`, the daemon owns the HID handle, and reports are
relayed in both directions. Chrome and Edge are unaffected: when
`navigator.hid` exists, the page uses WebHID and this daemon is never needed.

```
Firefox / Safari ──ws://127.0.0.1:47311──▶ better-rawmhub-bridge ──HID──▶ RAWM device
```

## Which implementation ships

| Path | What it is |
| --- | --- |
| `rust/` | **The shipped daemon.** One static binary, ~5 MB RAM, no runtime dependency. |
| `reference/src` | Earlier Node port of the same protocol. Kept to cross-check behaviour; not distributed. |
| `tools/live-test.mjs` | Connects to a running bridge, lists devices, opens the vendor interface and sends the configurator's QUERY packet. |

## Install

### Windows

1. Download `better-rawmhub-bridge-win-x64.zip` from the releases page.
2. Unzip anywhere and run `install.ps1` (right-click → *Run with PowerShell*).
3. The binary lands in `%LOCALAPPDATA%\BetterRawmHubBridge\`, with a Start-menu
   shortcut. Pass `-AutoStart` if you want it to start with Windows.

The build is not code-signed, so the first run shows *Windows protected your PC*
→ **More info** → **Run anyway**. If Defender quarantines it, add the folder to
exclusions.

### macOS

1. Download the archive for your Mac (`mac-arm64` or `mac-x64`).
2. Unzip, then right-click `install.command` → **Open** (a double-click on an
   unsigned script is refused).
3. It copies the binary to `~/Library/Application Support/BetterRawmHubBridge/`,
   removes the quarantine flag and prints how to start it.

Unnotarised binaries need **System Settings → Privacy & Security → Open Anyway**
the first time. If macOS asks for **Input Monitoring**, grant it — otherwise the
HID handle cannot be opened.

### Linux

```sh
sudo cp 70-better-rawmhub.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
./better-rawmhub-bridge
```

## Using it

1. Start the daemon (double-click, or `better-rawmhub-bridge`).
2. Open <https://better-rawmhub.chila.io.vn> in Firefox or Safari.
3. Press **Connect device**. The first time, the daemon prints a six-digit code
   in its window; type it into the page. That origin is remembered.

Firefox 154+ shows a **local network** permission prompt the first time the page
reaches `127.0.0.1`. Choose **Allow**. If it was denied, open the site settings
for the page and allow local network access, then press **Try again**.

## Options

```
--port=<n>          loopback port (default 47311)
--idle=<seconds>    exit after this long with no page open (default 600, 0 = never)
--origin=<url>      extra allowed origin, repeatable (or --origin=* for any)
--no-pair           skip the pairing code (local development only)
--no-report-ids     do not prefix writes with the report id (rare interfaces)
--host=<address>    bind address (default 127.0.0.1 — do not change this)
```

The daemon exits on its own ten minutes after the last page closes, so it does
not sit in the background forever. Run it with `--idle=0` to keep it up.

## Security

The daemon is a door into your USB devices, so it is deliberately narrow:

- binds `127.0.0.1` only, so nothing on the LAN can reach it;
- rejects requests whose `Host` header is not a loopback name (blocks DNS
  rebinding);
- checks `Origin` against an allowlist: the two hosted pages plus anything on
  `http://localhost` / `http://127.0.0.1`. `null` (a `file://` page or a
  sandboxed frame) is refused;
- requires a six-digit pairing code once per origin, then a 24-byte token. Only
  the SHA-256 of the token is stored, in
  `%LOCALAPPDATA%\BetterRawmHubBridge\config.json`
  (`~/Library/Application Support/BetterRawmHubBridge/config.json` on macOS);
- only ever lists devices on vendor `0x1915`, and opens one device per connection.

Nothing leaves the machine. There is no telemetry.

## Protocol (v1)

JSON control frames, binary frames for input reports.

```
→ { t:'hello', api:1, token? }     ← { t:'welcome', api, version, platform, paired }
→ { t:'pair', code }               ← { t:'paired', token } | { t:'error', code:'bad-code' }
→ { t:'list' }                     ← { t:'devices', devices:[…] }
→ { t:'open', seq, deviceId }      ← { t:'opened', seq, handle }
→ { t:'send', seq, handle, rid, data }   ← { t:'sent', seq } | { t:'error', seq, code }
→ { t:'feature', seq, handle, rid, dir, data } ← { t:'feature-data', seq, data }
→ { t:'close', handle }            ← { t:'closed', handle }
                                   ← { t:'gone', handle, reason }
← [0x01][handle:u16le][raw report…]     (input report, binary)
```

`data` is base64 of the report payload without its report-id byte, exactly as
`HIDDevice.sendReport()` expects it.

The raw input frames still contain whatever the platform HID layer returned.
`src/bridge.js` decides once per handle whether the first byte is a report id
(`0x52` on a wired mouse, `0x00` on a receiver report) or the first payload byte
(an `0x80 | len` envelope), and splits accordingly.

## Development

```bash
# run the shipped daemon
cargo run --release --manifest-path bridge/rust/Cargo.toml

# unit tests (origin, host and token rules)
cargo test --release --manifest-path bridge/rust/Cargo.toml

# talk to a running daemon with a real device plugged in
node bridge/tools/live-test.mjs --code=123456

# the reference implementation, same protocol
npm install --prefix bridge/reference
node bridge/reference/src/index.js
```

`live-test.mjs` prints the device list, opens the vendor interface, sends the
same QUERY packet the page sends and reports how many input reports came back.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| *Bridge not running* in the page | the daemon is not started, or something else holds port 47311 (`netstat -ano \| findstr 47311`) |
| *Pair this page with the bridge* | first visit from this origin, or **Forget pairing** was pressed |
| The page says it cannot reach localhost | Firefox denied the local-network prompt, or the page is on `file://` |
| Device is listed but does not answer | another tool (vendor hub, another tab) holds the interface; close it |
| macOS: device opens then fails | grant **Input Monitoring** to the binary |
| Linux: open fails with permission denied | install `70-better-rawmhub.rules` |
