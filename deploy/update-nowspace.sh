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
git reset --hard origin/main

# nvm-installed node isn't on launchd's PATH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

(cd frontend && npm ci --no-audit --no-fund && npx vite build)
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

launchctl kickstart -k "gui/$(id -u)/com.nowspace.server" || true
echo "$(date '+%F %T') now at ${REMOTE:0:7} — server restarted"
