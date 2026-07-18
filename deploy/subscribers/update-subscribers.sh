#!/bin/sh
# Pull the latest published image and restart every subscriber instance.
# Safe to run from cron/launchd — instances with no update are untouched.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$HERE/instances" ] || { echo "no instances"; exit 0; }

for DIR in "$HERE/instances"/*/; do
  [ -d "$DIR" ] || continue
  NAME="$(basename "$DIR")"
  echo "— updating $NAME"
  ( cd "$DIR" && docker compose --profile obsidian pull -q && docker compose --profile obsidian up -d )
done
