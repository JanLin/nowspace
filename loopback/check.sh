#!/usr/bin/env bash
# loopback/check.sh — the single success signal for the NowSpace DnD loop.
# Exit 0 == done. Any non-zero step stops here and prints what failed.
# NowSpace is a monorepo: the React app is in frontend/, so typecheck/lint run there.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

step() { echo; echo "=== $1 ==="; }

step "1/4 typecheck (frontend)"
npm --prefix frontend run typecheck || { echo "FAIL: typecheck (add \"typecheck\": \"tsc --noEmit\" to frontend/package.json)"; exit 1; }

step "2/4 lint (frontend)"
npm --prefix frontend run lint || { echo "FAIL: lint"; exit 1; }

step "3/4 drag-and-drop e2e"
npx playwright test loopback/dnd.spec.ts || { echo "FAIL: dnd e2e"; exit 1; }

step "4/4 screenshots"
mkdir -p loopback/shots
npx playwright test loopback/shots.spec.ts || { echo "FAIL: screenshots"; exit 1; }

echo; echo "ALL GREEN ✅"
