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

1. Download `better-rawmhub-bridge.exe` from the releases page (or the zip, which
   adds the same installer).
2. Run it. Windows warns that the publisher is unknown because the build is not
   signed: **More info** → **Run anyway**.
3. That is all. The page starts the daemon itself from now on.

For a Start-menu entry, the `betterrawm://` handler and an optional login entry,
run `install.ps1` from the zip (right-click → *Run with PowerShell*). It does
not need administrator rights:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

- copies the binary to `%LOCALAPPDATA%\BetterRawmHubBridge\`
- adds **Better RAWM Hub Bridge** and **Stop Better RAWM Hub Bridge** shortcuts
- registers `betterrawm://start`, which is how the page launches it
- starts it now; add `-AutoStart` to also start it at login

Logs go to `%LOCALAPPDATA%\BetterRawmHubBridge\bridge.log`. If Defender
quarantines the binary, add that folder to the exclusions.

### macOS

1. Download the archive for your Mac (`mac-arm64` or `mac-x64`).
2. Unzip, then right-click `install.command` → **Open** (a double-click on an
   unsigned script is refused).
3. It copies the binary to `~/Library/Application Support/BetterRawmHubBridge/`,
   removes the quarantine flag, installs a LaunchAgent so it is available at
   login, and starts it.

macOS has no way to register a URL scheme for a bare binary, so the LaunchAgent
is how the daemon is there when the page asks. Unnotarised binaries need
**System Settings → Privacy & Security → Open Anyway** the first time. If macOS
asks for **Input Monitoring**, grant it — otherwise the HID handle cannot be
opened.

### Linux

```sh
sudo cp 70-better-rawmhub.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
./better-rawmhub-bridge
```

## Using it

1. Open <https://better-rawmhub.chila.io.vn> in Firefox or Safari.
2. Press **Connect device**. If the daemon is not running, the page offers
   **Start the bridge**; one click launches it and the page connects by itself.
3. **There is no code to type.** The daemon trusts its origin allowlist and
   starts serving. `--pair` adds the six-digit code back for origins outside the
   hosted pages.

Firefox 154+ shows a **local network** permission prompt the first time the page
reaches `127.0.0.1`. Choose **Allow**. If it was denied, open the site settings
for the page and allow local network access, then press **Try again**.

The daemon exits ten minutes after the last tab closes, so nothing keeps running
in the background unless you install it with `-AutoStart` (Windows) or the
LaunchAgent (macOS).

## Options

```
--port=<n>          loopback port (default 47311)
--idle=<seconds>    exit after this long with no page open (default 600, 0 = never)
--origin=<url>      extra allowed origin, repeatable (or --origin=* for any)
--pair              require the six-digit code for non-hosted origins (off by default)
--no-report-ids     do not prefix writes with the report id (rare interfaces)
--host=<address>    bind address (default 127.0.0.1 — do not change this)
--stop              stop a bridge that is already running, then exit
```

## Security

The daemon is a door into your USB devices, so it is deliberately narrow:

- binds `127.0.0.1` only, so nothing on the LAN can reach it;
- rejects requests whose `Host` header is not a loopback name (blocks DNS
  rebinding);
- checks `Origin` against an allowlist: the two hosted pages plus anything on
  `http://localhost` / `http://127.0.0.1`. `null` (a `file://` page or a
  sandboxed frame) is refused. A remote site cannot forge these headers, which
  is why no pairing code is needed day to day;
- optional pairing (`--pair`): a six-digit code once per non-hosted origin, then
  a 24-byte token. Only the SHA-256 of the token is stored, in
  `%LOCALAPPDATA%\BetterRawmHubBridge\config.json`
  (`~/Library/Application Support/BetterRawmHubBridge/config.json` on macOS);
- only ever lists devices on vendor `0x1915`, and opens one device per connection.

Nothing leaves the machine. There is no telemetry.

## Uninstall

Nothing else on the machine is involved, so removing it is small and reversible.

**Windows** — run `uninstall.ps1` from the zip (right-click → *Run with
PowerShell*), or do it by hand:

```powershell
& "$env:LOCALAPPDATA\BetterRawmHubBridge\better-rawmhub-bridge.exe" --stop
Remove-Item "$env:LOCALAPPDATA\BetterRawmHubBridge" -Recurse -Force
Remove-Item 'HKCU:\Software\Classes\betterrawm' -Recurse -Force
Remove-Item "$([Environment]::GetFolderPath('Programs'))\Better RAWM Hub Bridge.lnk"
Remove-Item "$([Environment]::GetFolderPath('Programs'))\Stop Better RAWM Hub Bridge.lnk"
```

That removes the daemon, its config and log, the `betterrawm://` handler and the
Start-menu entries. If you installed with `-AutoStart`, also delete
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Better RAWM Hub Bridge.lnk`.

**macOS** — run `uninstall.command`, or:

```sh
launchctl unload ~/Library/LaunchAgents/io.better-rawmhub.bridge.plist
rm -f ~/Library/LaunchAgents/io.better-rawmhub.bridge.plist
rm -rf "$HOME/Library/Application Support/BetterRawmHubBridge"
```

**Linux** — `./better-rawmhub-bridge --stop`, delete the binary and, if you added
it, `/etc/udev/rules.d/70-better-rawmhub.rules`.

Nothing is written anywhere else: no services, no scheduled tasks, no drivers.
Chrome and Edge keep working over WebHID with nothing installed.

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
| *Pair this page with the bridge* | only with `--pair`, and only for non-hosted origins |
| The page says it cannot reach localhost | Firefox denied the local-network prompt, or the page is on `file://` |
| Device is listed but does not answer | another tool (vendor hub, another tab) holds the interface; close it |
| macOS: device opens then fails | grant **Input Monitoring** to the binary |
| Linux: open fails with permission denied | install `70-better-rawmhub.rules` |
