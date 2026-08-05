#!/bin/bash
set -e

echo ""
echo "=========================================="
echo "  Nowspace - Setup"
echo "=========================================="
echo ""

# --- 1. Check Docker ---
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed."
    echo ""
    echo "  Mac:     https://docs.docker.com/desktop/install/mac-install/"
    echo "  Windows: https://docs.docker.com/desktop/install/windows-install/"
    echo "  Linux:   https://docs.docker.com/engine/install/"
    echo ""
    echo "Install Docker, then run this script again."
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "Docker is installed but not running. Please start Docker Desktop and try again."
    exit 1
fi

echo "Docker is ready."
echo ""

# --- 2. Claude API Key ---
echo "Step 1: Claude API Key"
echo "  The coaching features use the Claude API."
echo "  Get a key at: https://console.anthropic.com/"
echo ""
read -p "  Enter your Claude API key (or press Enter to skip): " API_KEY
echo ""

if [ -z "$API_KEY" ]; then
    echo "  Skipped. Planning features will work, but AI coaching and"
    echo "  prioritisation will be unavailable until you add a key to .env"
    echo ""
fi

# --- 3. Vault Location ---
echo "Step 2: Obsidian Vault Location"
echo "  This is the root folder of your Obsidian vault."
echo "  The coach reads and writes Plan Week.md here."
echo ""

while true; do
    read -p "  Enter the full path to your vault: " VAULT_PATH
    # Expand ~ if present
    VAULT_PATH="${VAULT_PATH/#\~/$HOME}"

    if [ -z "$VAULT_PATH" ]; then
        echo "  A vault path is required."
        continue
    fi

    if [ ! -d "$VAULT_PATH" ]; then
        read -p "  Directory does not exist. Create it? (y/n): " CREATE
        if [ "$CREATE" = "y" ] || [ "$CREATE" = "Y" ]; then
            mkdir -p "$VAULT_PATH"
            echo "  Created: $VAULT_PATH"
        else
            continue
        fi
    fi
    break
done
echo ""

# --- 4. Create Obsidian folder structure ---
echo "Setting up vault structure..."
FOLDERS=("0-Inbox" "1-Projects" "2-Areas" "3-Resources" "4-Archive")
for folder in "${FOLDERS[@]}"; do
    if [ ! -d "$VAULT_PATH/$folder" ]; then
        mkdir -p "$VAULT_PATH/$folder"
        echo "  Created: $folder/"
    else
        echo "  Exists:  $folder/"
    fi
done
echo ""

# --- 5. Create example Plan Week.md ---
PLAN_FILE="$VAULT_PATH/0-Inbox/Plan Week.md"
if [ ! -f "$PLAN_FILE" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    cp "$SCRIPT_DIR/templates/Plan Week.md" "$PLAN_FILE"
    echo "  Created example: 0-Inbox/Plan Week.md"
    echo "  (Open it in Obsidian to see goals, tasks, and a white elephant example)"
else
    echo "  Plan Week.md already exists - skipping (your tasks are safe!)"
fi
echo ""

# --- 6. Write .env ---
cat > .env << EOF
ANTHROPIC_API_KEY=$API_KEY
VAULT_PATH=$VAULT_PATH
EOF
echo "  Configuration saved to .env"
echo ""

# --- 7. Build and start ---
echo "Building and starting the coach (this may take a minute on first run)..."
echo ""
docker compose up --build -d

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "  The coach is running at: http://localhost:8000"
echo ""
echo "  Next steps:"
echo "  1. Open http://localhost:8000 in your browser"
echo "  2. Click 'Load Week' to see your Plan Week.md"
echo "  3. Open Obsidian and navigate to 0-Inbox/Plan Week.md"
echo "     to verify the example tasks are there"
echo ""
echo "  Useful commands:"
echo "    Stop:    docker compose down"
echo "    Start:   docker compose up -d"
echo "    Logs:    docker compose logs -f"
echo "    Update:  git pull && docker compose up --build -d"
echo ""
echo "  Happy task planning! $(printf '\xF0\x9F\x90\x98')"
echo ""
