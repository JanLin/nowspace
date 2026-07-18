#!/bin/sh
# Tear down a subscriber instance. The vault is archived, never deleted.
#   ./remove-subscriber.sh alice
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$1"
if [ -z "$NAME" ]; then
  echo "usage: $0 <name>" >&2
  exit 1
fi

DIR="$HERE/instances/$NAME"
if [ ! -d "$DIR" ]; then
  echo "no instance '$NAME' at $DIR" >&2
  exit 1
fi

( cd "$DIR" && docker compose --profile obsidian down )

mkdir -p "$HERE/archives"
STAMP="$(date +%Y%m%d-%H%M%S)"
tar -czf "$HERE/archives/$NAME-$STAMP.tar.gz" -C "$DIR" vault
rm -rf "$DIR"

echo "Instance '$NAME' removed. Vault archived at:"
echo "    archives/$NAME-$STAMP.tar.gz"
