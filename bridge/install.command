#!/bin/sh
# Installs better-rawmhub-bridge for the current user on macOS.
# Right-click -> Open in Finder, or run: sh install.command
#
# A LaunchAgent keeps it available at login, because macOS cannot register a
# betterrawm:// handler for a bare binary the way Windows can.
set -e

here=$(cd "$(dirname "$0")" && pwd)
source_bin="$here/better-rawmhub-bridge"
target_dir="$HOME/Library/Application Support/BetterRawmHubBridge"
target_bin="$target_dir/better-rawmhub-bridge"
agent="$HOME/Library/LaunchAgents/io.better-rawmhub.bridge.plist"

if [ ! -f "$source_bin" ]; then
  echo "better-rawmhub-bridge was not found next to this script." >&2
  exit 1
fi

mkdir -p "$target_dir" "$HOME/Library/LaunchAgents"
cp "$source_bin" "$target_bin"
chmod +x "$target_bin"

# Unsigned downloads carry a quarantine flag that makes Gatekeeper refuse them.
xattr -d com.apple.quarantine "$target_bin" 2>/dev/null || true

cat > "$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.better-rawmhub.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$target_bin</string>
    <string>--idle=0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
PLIST

launchctl unload "$agent" 2>/dev/null || true
launchctl load "$agent"

echo ""
echo "Installed to $target_dir"
echo "Started now, and at every login (LaunchAgent: $agent)"
echo "Log: $target_dir/bridge.log"
echo "Stop it with: \"$target_bin\" --stop"
echo ""
echo "If macOS blocks it, open System Settings -> Privacy & Security and choose"
echo "Open Anyway. If it asks for Input Monitoring, allow it - without that the"
echo "HID handle cannot be opened."
echo ""
