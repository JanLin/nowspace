#!/usr/bin/env bash
# Keep an always-on Mac's Nowspace at origin/main. Safe to run any time —
# does nothing unless main moved. Installed as a launchd interval job
# (com.nowspace.update.plist); run manually for an immediate update.
set -euo pipefail

REPO="${NOWSPACE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"

git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "$(date '+%F %T') updating ${LOCAL:0:7} → ${REMOTE:0:7}"

# The website (site/) ships via GitHub Pages, not from here. Take the commits
# so the clone stays at main, but skip the rebuild+restart when nothing
# outside site/ moved — a typo fix on nowspace.org must not bounce the server
# and rebuild every subscriber's Docker image.
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
git reset --hard origin/main
if [ -n "$CHANGED" ] && ! echo "$CHANGED" | grep -qv '^site/'; then
  echo "$(date '+%F %T') now at ${REMOTE:0:7} — website-only, nothing to rebuild"
  exit 0
fi

# nvm-installed node isn't on launchd's PATH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# NOWSPACE_ADDONS_UI installs extension packages for the frontend build.
# Reinstalled every run on purpose: npm ci wipes node_modules, and this clone
# is git reset --hard above — nothing an extension needs can be left lying
# around in the tree. --no-save keeps package.json/lock untouched, so the
# next update still fast-forwards cleanly. The backend half is a pip install
# in .venv (which survives, since the venv is not recreated) plus
# NOWSPACE_ADDONS in the launchd plist. See docs/EXTENSIONS.md.
(
  cd frontend
  npm ci --no-audit --no-fund
  if [ -n "${NOWSPACE_ADDONS_UI:-}" ]; then
    echo "$(date '+%F %T') installing extension packages: $NOWSPACE_ADDONS_UI"
    npm install --no-save --no-audit --no-fund $(echo "$NOWSPACE_ADDONS_UI" | tr ',' ' ')
  fi
  npm run build
)
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

launchctl kickstart -k "gui/$(id -u)/com.nowspace.server" || true
echo "$(date '+%F %T') now at ${REMOTE:0:7} — server restarted"

# Subscriber instances ride the same update: rebuild the image from this
# clone and restart every instance. Guarded — a Docker hiccup must never
# block the mini's own update (the server is already restarted above).
if [ -d "$REPO/deploy/subscribers/instances" ] && command -v docker >/dev/null 2>&1; then
  if "$REPO/deploy/subscribers/update-subscribers.sh"; then
    echo "$(date '+%F %T') subscriber instances updated"
  else
    echo "$(date '+%F %T') subscriber update FAILED — run deploy/subscribers/update-subscribers.sh manually"
  fi
fi
