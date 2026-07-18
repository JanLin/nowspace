#!/bin/sh
# Provision a subscriber demo instance on this machine.
#
#   ./new-subscriber.sh alice              app only
#   ./new-subscriber.sh alice --obsidian   app + Obsidian-in-the-browser
#
# Prints a one-time Tailscale login link to forward to the subscriber.
# They click it, sign in with their own account, and the instance joins
# THEIR tailnet — no credentials or keys ever pass through you.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$1"

if [ -z "$NAME" ]; then
  echo "usage: $0 <name> [--obsidian]" >&2
  exit 1
fi
case "$NAME" in
  *[!a-z0-9-]*)
    echo "name must be lowercase letters, digits or dashes (used as hostname)" >&2
    exit 1;;
esac

PROFILE=""
[ "$2" = "--obsidian" ] && PROFILE="--profile obsidian"

DIR="$HERE/instances/$NAME"
if [ -d "$DIR" ]; then
  echo "instance '$NAME' already exists at $DIR" >&2
  exit 1
fi

docker image inspect nowspace:latest >/dev/null 2>&1 || "$HERE/build-image.sh"

mkdir -p "$DIR/vault" "$DIR/ts-state" "$DIR/memory"
sed "s/__NAME__/$NAME/g" "$HERE/compose-template.yml" > "$DIR/docker-compose.yml"
cp "$HERE/serve-template.json" "$DIR/serve.json"

( cd "$DIR" && docker compose $PROFILE up -d )

echo ""
echo "Waiting for the Tailscale login link (can take ~15s)..."
# Ask tailscaled for the CURRENT auth URL — log-scraping can pick up an
# expired link (they are one-time and each restart mints a new one)
URL=""
i=0
while [ $i -lt 30 ]; do
  URL="$(docker exec "nowspace-$NAME-ts" tailscale status --json 2>/dev/null \
        | grep -o '"AuthURL": *"[^"]*"' | head -1 | sed 's/.*": *"//; s/"$//')"
  [ -n "$URL" ] && break
  sleep 2
  i=$((i + 1))
done

echo ""
if [ -n "$URL" ]; then
  echo "==============================================================="
  echo "Send this one-time login link to $NAME:"
  echo ""
  echo "    $URL"
  echo ""
  echo "They sign in with their own Tailscale account (Google/Apple/MS"
  echo "login works). The link is one-time and expires — if it does,"
  echo "./subscriber-status.sh $NAME prints a fresh one. Once they are"
  echo "signed in, the same command prints their app URL to send along."
  echo "==============================================================="
else
  echo "No login link yet — the instance may already be authenticated, or"
  echo "Tailscale is still starting. Run:  ./subscriber-status.sh $NAME"
fi
