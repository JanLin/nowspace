#!/usr/bin/env bash
# Build the FastAPI backend into a standalone binary using PyInstaller
# The output binary is placed where Tauri expects sidecar binaries.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
BACKEND_DIR="$PROJECT_ROOT/backend"
TAURI_DIR="$PROJECT_ROOT/frontend/src-tauri"
BINARIES_DIR="$TAURI_DIR/binaries"

# Detect architecture for Tauri sidecar naming
TARGET_TRIPLE=$(rustc -vV | grep 'host:' | awk '{print $2}')
echo "Building for target: $TARGET_TRIPLE"

# Clean previous builds
rm -rf "$PROJECT_ROOT/build" "$PROJECT_ROOT/dist"

# Run PyInstaller from project root so 'backend' package is importable.
# --paths . rather than an absolute path: the generated .spec bakes whatever
# it is given, and an absolute path is a build that breaks the day the folder
# is renamed or built on another machine.
cd "$PROJECT_ROOT"

# A frozen bundle discovers nothing at run time, so every extension in
# backend/addons.py has to be named to PyInstaller here. One list, read from
# the module itself so the two cannot drift.
ADDON_IMPORTS=$(python3 -c "
from backend.addons import addon_modules
print(' '.join('--hidden-import ' + m for m in addon_modules()))
" 2>/dev/null || echo "")
if [ -n "$ADDON_IMPORTS" ]; then
  echo "Bundling extensions: $ADDON_IMPORTS"
fi
python3 -m PyInstaller \
  --noconfirm \
  --onefile \
  --name "nowspace-server" \
  --paths . \
  --hidden-import backend \
  --hidden-import backend.main \
  --hidden-import backend.config \
  --hidden-import backend.routers \
  --hidden-import backend.routers.plan \
  --hidden-import backend.routers.coach \
  --hidden-import backend.routers.memory \
  --hidden-import backend.routers.vault \
  --hidden-import backend.routers.notes \
  --hidden-import backend.routers.settings \
  --hidden-import backend.routers.habits \
  --hidden-import backend.routers.timelog \
  --hidden-import backend.agents \
  --hidden-import backend.session \
  --hidden-import backend.vault_index \
  --hidden-import backend.models \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols \
  --hidden-import uvicorn.protocols.http \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import backend.vault_io \
  --hidden-import backend.host \
  --hidden-import backend.addons \
  --collect-submodules backend \
  $ADDON_IMPORTS \
  backend/run_server.py

# Copy to Tauri binaries dir with correct naming
mkdir -p "$BINARIES_DIR"
cp "$PROJECT_ROOT/dist/nowspace-server" "$BINARIES_DIR/nowspace-server-${TARGET_TRIPLE}"

echo ""
echo "Backend binary built: $BINARIES_DIR/nowspace-server-${TARGET_TRIPLE}"
echo "Size: $(du -h "$BINARIES_DIR/nowspace-server-${TARGET_TRIPLE}" | cut -f1)"
