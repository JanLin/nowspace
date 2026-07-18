#!/bin/sh
# First run: seed an empty vault with the starter content so the app is
# usable with zero setup (subscriber demos, brand-new users). A vault that
# already has files is never touched.
set -e

VAULT="${VAULT_PATH:-/vault}"

if [ -d /app/starter-vault ] && [ -d "$VAULT" ] && [ -z "$(ls -A "$VAULT" 2>/dev/null)" ]; then
  echo "Vault at $VAULT is empty — seeding starter content"
  cp -R /app/starter-vault/. "$VAULT"/
fi

exec python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
