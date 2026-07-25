#!/usr/bin/env bash
# loopback/loop.sh — OUTER guard loop. Re-invokes Claude Code headless until
# check.sh goes green or MAX attempts is hit. This is the deterministic stop
# that doesn't depend on the model deciding it's done.
#
# Usage:  ./loopback/loop.sh
# Requires: claude CLI logged in, dev server + backend running (see SETUP.md).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

MAX=8
GOAL='Make ./loopback/check.sh exit 0. Read CLAUDE.md and loopback/DESIGN-RUBRIC.md first.
Detect the DnD implementation, fix reorder behavior so loopback/dnd.spec.ts passes, then do the
visual pass against the rubric using loopback/shots/*.png. Run ./loopback/check.sh after each
change and fix what fails. Commit after each green check.'

for i in $(seq 1 "$MAX"); do
  echo "===================== ATTEMPT $i / $MAX ====================="

  if ./loopback/check.sh; then
    echo "Green before attempt $i — nothing to do."; exit 0
  fi

  # Hand the latest failure to Claude Code, let it iterate this round.
  claude -p "$GOAL" \
    --allowedTools "Bash,Edit,Write,Read,Glob,Grep" \
    --max-turns 60

  if ./loopback/check.sh; then
    echo "✅ GREEN after attempt $i"; exit 0
  fi
done

echo "❌ Hit $MAX attempts without green. See loopback/STATUS.md."
exit 1
