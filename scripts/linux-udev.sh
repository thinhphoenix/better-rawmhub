#!/bin/sh
# Installs the udev rule that lets Chrome, Edge and the local bridge open a
# RAWM device on Linux, then reloads udev and shows whether it worked.
#
#   curl -fsSL https://raw.githubusercontent.com/thinhphoenix/better-rawmhub/main/scripts/linux-udev.sh | sudo sh
#   curl -fsSL ... | sudo sh -s -- --product 2346     # scope to one product
#   sudo sh linux-udev.sh --dry-run                   # show what it would do
#
# The rule is scoped to vendor 1915 (and optionally one product id), tagged
# uaccess and named 70-* so it is read before 73-seat-late.rules applies the
# ACL. It does not touch any other device.
set -eu

VENDOR="1915"
PRODUCT=""
FILE="70-better-rawmhub.rules"
DIR="/etc/udev/rules.d"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --product=*) PRODUCT="${1#*=}" ;;
    --product)
      [ $# -ge 2 ] || { echo "--product needs a value (e.g. 2346)" >&2; exit 2; }
      PRODUCT="$2"; shift ;;
    --vendor=*) VENDOR="${1#*=}" ;;
    --vendor)
      [ $# -ge 2 ] || { echo "--vendor needs a value" >&2; exit 2; }
      VENDOR="$2"; shift ;;
    --file=*) FILE="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# Normalise 0x-prefixed values so both "0x2346" and "2346" work.
VENDOR=$(printf '%s' "$VENDOR" | sed 's/^0[xX]//' | tr 'A-F' 'a-f')
PRODUCT=$(printf '%s' "$PRODUCT" | sed 's/^0[xX]//' | tr 'A-F' 'a-f')

RULE="SUBSYSTEM==\"hidraw\", ATTRS{idVendor}==\"$VENDOR\""
if [ -n "$PRODUCT" ]; then
  RULE="$RULE, ATTRS{idProduct}==\"$PRODUCT\""
fi
RULE="$RULE, TAG+=\"uaccess\""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "rule file: $DIR/$FILE"
  echo "rule:      $RULE"
  echo "commands:  udevadm control --reload-rules; udevadm trigger --subsystem-match=hidraw"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root because it writes to $DIR." >&2
  echo "Run it as: curl -fsSL https://raw.githubusercontent.com/thinhphoenix/better-rawmhub/main/scripts/linux-udev.sh | sudo sh" >&2
  exit 1
fi

if [ ! -d "$DIR" ]; then
  echo "$DIR does not exist — is udev installed?" >&2
  exit 1
fi

# Immutable systems (SteamOS, NixOS images) refuse the write; say so instead of
# pretending it worked.
if ! (: > "$DIR/.better-rawmhub-write-test") 2>/dev/null; then
  echo "$DIR is read-only on this system." >&2
  echo "Add this line to your declarative udev config instead:" >&2
  echo "  $RULE" >&2
  if [ -e /etc/NIXOS ]; then
    echo "NixOS: services.udev.extraRules = '$RULE';" >&2
  fi
  exit 2
fi
rm -f "$DIR/.better-rawmhub-write-test"

printf '%s\n' "$RULE" > "$DIR/$FILE"
chmod 644 "$DIR/$FILE"
echo "Wrote $DIR/$FILE"

udevadm control --reload-rules
udevadm trigger --subsystem-match=hidraw

echo ""
echo "Nodes for vendor $VENDOR:"
found=0
for node in /dev/hidraw*; do
  [ -e "$node" ] || continue
  line=$(ls -l "$node")
  case "$line" in
    *"+"*) echo "  ok   $line" ; found=$((found + 1)) ;;
    *) echo "  ..   $line" ;;
  esac
done
if [ "$found" -eq 0 ]; then
  echo "  no hidraw node shows an ACL yet — unplug and replug the device, then run:"
  echo "  ls -l /dev/hidraw*"
fi

echo ""
echo "Done. Replug the receiver if the browser still refuses, then press Connect."
echo "The rule stays scoped to vendor $VENDOR${PRODUCT:+ and product $PRODUCT}."
