#!/bin/sh
# Installs better-rawmhub-bridge for the current user on macOS.
# Right-click -> Open in Finder, or run: sh install.command
set -e

here=$(cd "$(dirname "$0")" && pwd)
source_bin="$here/better-rawmhub-bridge"
target_dir="$HOME/Library/Application Support/BetterRawmHubBridge"

if [ ! -f "$source_bin" ]; then
  echo "better-rawmhub-bridge was not found next to this script." >&2
  exit 1
fi

mkdir -p "$target_dir"
cp "$source_bin" "$target_dir/better-rawmhub-bridge"
chmod +x "$target_dir/better-rawmhub-bridge"

# Unsigned downloads carry a quarantine flag that makes Gatekeeper refuse them.
xattr -d com.apple.quarantine "$target_dir/better-rawmhub-bridge" 2>/dev/null || true

echo ""
echo "Installed to $target_dir"
echo ""
echo "Start it with:"
echo "  \"$target_dir/better-rawmhub-bridge\""
echo ""
echo "If macOS blocks it, open System Settings -> Privacy & Security and choose"
echo "Open Anyway. If it asks for Input Monitoring, allow it — without that the"
echo "HID handle cannot be opened."
echo ""
