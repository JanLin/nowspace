#!/bin/sh
# Build the Nowspace image from this repo clone (local tag, no registry).
set -e

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
echo "Building nowspace:latest from $REPO"
docker build -t nowspace:latest "$REPO"
