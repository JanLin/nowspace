#!/bin/sh
# Show an instance's state and the URLs to send to the subscriber.
#   ./subscriber-status.sh alice
set -e

NAME="$1"
if [ -z "$NAME" ]; then
  echo "usage: $0 <name>" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^nowspace-$NAME-ts$"; then
  echo "instance '$NAME' is not running" >&2
  exit 1
fi

STATE="$(docker exec "nowspace-$NAME-ts" tailscale status --json 2>/dev/null || true)"
DNSNAME="$(printf '%s' "$STATE" | grep -o '"DNSName": *"[^"]*"' | head -1 | sed 's/.*"DNSName": *"//; s/\.\{0,1\}"$//; s/\.$//')"

if [ -z "$DNSNAME" ]; then
  AUTH_URL="$(printf '%s' "$STATE" | grep -o '"AuthURL": *"[^"]*"' | head -1 | sed 's/.*": *"//; s/"$//')"
  if [ -n "$AUTH_URL" ]; then
    echo "Not signed in yet. Current one-time login link (fresh):"
    echo ""
    echo "    $AUTH_URL"
  else
    echo "Not signed in and no login link available — restart to mint one:"
    echo "    docker restart nowspace-$NAME-ts   # then rerun this script"
  fi
  exit 0
fi

echo "Instance:  nowspace-$NAME  (joined the subscriber's tailnet)"
echo ""
echo "Nowspace:  https://$DNSNAME"
if docker ps --format '{{.Names}}' | grep -q "^nowspace-$NAME-obsidian$"; then
  echo "Obsidian:  https://$DNSNAME:8443"
fi
echo ""
echo "Phone: install the Tailscale app, sign in with the same account,"
echo "open the Nowspace URL in the browser and 'Add to Home Screen'."
