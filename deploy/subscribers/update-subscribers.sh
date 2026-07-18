#!/bin/sh
# Rebuild the image from the repo clone and restart every subscriber
# instance on it. Mirrors the mini's own update flow: the hourly job
# pulls the repo; run this after (or hook it into the same job).
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"

"$HERE/build-image.sh"

[ -d "$HERE/instances" ] || { echo "no instances"; exit 0; }

for DIR in "$HERE/instances"/*/; do
  [ -d "$DIR" ] || continue
  NAME="$(basename "$DIR")"
  echo "— updating $NAME"
  ( cd "$DIR" && docker compose --profile obsidian up -d )
done
