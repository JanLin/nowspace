#!/bin/sh
# Rebuild the image from the repo clone and restart every subscriber
# instance on it. Runs automatically from the mini's hourly update job
# (deploy/update-nowspace.sh) whenever main moves; safe to run manually
# any time. Subscribers therefore track main — use the staging setup to
# check anything risky before merging (README "Staging").
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
