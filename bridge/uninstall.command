#!/bin/sh
# Removes everything install.command added for the current user:
# the LaunchAgent, the daemon and its config/log folder.
#
#   sh uninstall.command      (or right-click -> Open in Finder)
set -e

target_dir="$HOME/Library/Application Support/BetterRawmHubBridge"
target_bin="$target_dir/better-rawmhub-bridge"
agent="$HOME/Library/LaunchAgents/io.better-rawmhub.bridge.plist"

echo "Stopping the bridge..."
if [ -x "$target_bin" ]; then
  "$target_bin" --stop 2>/dev/null || true
  sleep 1
fi
pkill -f 'BetterRawmHubBridge/better-rawmhub-bridge' 2>/dev/null || true

echo "Removing the LaunchAgent..."
launchctl unload "$agent" 2>/dev/null || true
rm -f "$agent"

echo "Removing $target_dir..."
rm -rf "$target_dir"

echo ""
echo "Done. Better RAWM Hub Bridge is gone."
echo "The web configurator still works in Safari with the bridge installed, and in Chrome and Edge over WebHID."
echo ""
