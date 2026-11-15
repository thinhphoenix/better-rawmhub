#!/bin/sh
# Installs better-rawmhub-bridge for the current user on Linux.
#
#   ./install.sh                 binary + udev rule, then prints how to start
#   ./install.sh --with-service  also installs a systemd --user service
#   ./install.sh --no-rule       skip the udev rule (already installed)
#
# The udev rule is what lets any browser, and the bridge, open /dev/hidraw*.
# It is scoped to vendor 1915 and keeps the 70- prefix so it is read before
# 73-seat-late.rules applies the ACL.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
src="$here/better-rawmhub-bridge"
prefix="${XDG_DATA_HOME:-$HOME/.local/share}/better-rawmhub-bridge"
bin="$prefix/better-rawmhub-bridge"
rule_src="$here/70-better-rawmhub.rules"
rule_dst="/etc/udev/rules.d/70-better-rawmhub.rules"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

with_service=0
with_rule=1
for arg in "$@"; do
  case "$arg" in
    --with-service) with_service=1 ;;
    --no-rule) with_rule=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f "$src" ]; then
  echo "better-rawmhub-bridge was not found next to this script." >&2
  exit 1
fi

mkdir -p "$prefix"
install -m 755 "$src" "$bin"
echo "Installed $bin"

as_root() {
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  elif command -v pkexec >/dev/null 2>&1; then
    pkexec "$@"
  else
    return 127
  fi
}

print_rule_manually() {
  echo ""
  echo "Add the rule manually (the browser needs it too, not just the bridge):"
  echo "  sudo cp '$rule_src' '$rule_dst'"
  echo "  sudo udevadm control --reload-rules"
  echo "  sudo udevadm trigger --subsystem-match=hidraw"
  if [ -e /etc/NIXOS ]; then
    echo ""
    echo "NixOS: declare it instead, e.g. in configuration.nix:"
    echo '  services.udev.extraRules = '"'"'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1915", TAG+="uaccess"'"'"';'
  fi
  if command -v steamos-readonly >/dev/null 2>&1; then
    echo ""
    echo "SteamOS: run 'sudo steamos-readonly disable' first, then re-run this script,"
    echo "then 'sudo steamos-readonly enable'. A system update may reset the rule."
  fi
}

if [ "$with_rule" -eq 1 ] && [ -f "$rule_src" ]; then
  if as_root true 2>/dev/null; then
    if as_root install -m 644 "$rule_src" "$rule_dst" 2>/dev/null; then
      as_root udevadm control --reload-rules || true
      as_root udevadm trigger --subsystem-match=hidraw || true
      echo "Installed $rule_dst and reloaded udev."
    else
      echo "Could not write $rule_dst (read-only /etc?)."
      print_rule_manually
    fi
  else
    echo "Neither sudo nor pkexec is usable here."
    print_rule_manually
  fi
fi

if [ "$with_service" -eq 1 ]; then
  mkdir -p "$unit_dir"
  cat > "$unit_dir/better-rawmhub-bridge.service" <<UNIT
[Unit]
Description=Better RAWM Hub bridge (HID access for Firefox and Safari)

[Service]
ExecStart=$bin --idle=0
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now better-rawmhub-bridge.service
  echo "Enabled better-rawmhub-bridge.service (systemd --user)."
  echo "Status: systemctl --user status better-rawmhub-bridge"
else
  echo ""
  echo "Start it when you need it:"
  echo "  $bin --idle=0"
  echo "or re-run with --with-service to keep it running at login."
fi

echo ""
echo "Log: $prefix/bridge.log"
echo "Stop: $bin --stop"
echo "Remove: $bin --stop; rm -rf '$prefix';"
echo "        sudo rm -f '$rule_dst' && sudo udevadm control --reload-rules"
echo "        systemctl --user disable --now better-rawmhub-bridge 2>/dev/null || true"
echo ""
