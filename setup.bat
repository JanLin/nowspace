@echo off
setlocal enabledelayedexpansion

echo.
echo ==========================================
echo   Personal Coaching Agent - Setup
echo ==========================================
echo.

REM --- 1. Check Docker ---
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo Docker is not installed.
    echo.
    echo   Download: https://docs.docker.com/desktop/install/windows-install/
    echo.
    echo Install Docker Desktop, then run this script again.
    pause
    exit /b 1
)

docker info >nul 2>nul
if %errorlevel% neq 0 (
    echo Docker is installed but not running. Please start Docker Desktop and try again.
    pause
    exit /b 1
)

echo Docker is ready.
echo.

REM --- 2. Claude API Key ---
echo Step 1: Claude API Key
echo   The coaching features use the Claude API.
echo   Get a key at: https://console.anthropic.com/
echo.
set /p API_KEY="  Enter your Claude API key (or press Enter to skip): "
echo.

if "!API_KEY!"=="" (
    echo   Skipped. Planning features will work, but AI coaching and
    echo   prioritisation will be unavailable until you add a key to .env
    echo.
)

REM --- 3. Vault Location ---
echo Step 2: Obsidian Vault Location
echo   This is the root folder of your Obsidian vault.
echo   The coach reads and writes Plan Week.md here.
echo.

:vault_prompt
set /p VAULT_PATH="  Enter the full path to your vault: "
if "!VAULT_PATH!"=="" (
    echo   A vault path is required.
    goto vault_prompt
)

if not exist "!VAULT_PATH!" (
    set /p CREATE="  Directory does not exist. Create it? (y/n): "
    if /i "!CREATE!"=="y" (
        mkdir "!VAULT_PATH!"
        echo   Created: !VAULT_PATH!
    ) else (
        goto vault_prompt
    )
)
echo.

REM --- 4. Create Obsidian folder structure ---
echo Setting up vault structure...
for %%F in (0-Inbox 1-Projects 2-Areas 3-Resources 4-Archive) do (
    if not exist "!VAULT_PATH!\%%F" (
        mkdir "!VAULT_PATH!\%%F"
        echo   Created: %%F\
    ) else (
        echo   Exists:  %%F\
    )
)
echo.

REM --- 5. Create example Plan Week.md ---
if not exist "!VAULT_PATH!\0-Inbox\Plan Week.md" (
    copy "%~dp0templates\Plan Week.md" "!VAULT_PATH!\0-Inbox\Plan Week.md" >nul
    echo   Created example: 0-Inbox\Plan Week.md
    echo   (Open it in Obsidian to see goals, tasks, and a white elephant example)
) else (
    echo   Plan Week.md already exists - skipping (your tasks are safe!)
)
echo.

REM --- 6. Write .env ---
(
    echo ANTHROPIC_API_KEY=!API_KEY!
    echo VAULT_PATH=!VAULT_PATH!
) > .env
echo   Configuration saved to .env
echo.

REM --- 7. Build and start ---
echo Building and starting the coach (this may take a minute on first run)...
echo.
docker compose up --build -d

echo.
echo ==========================================
echo   Setup Complete!
echo ==========================================
echo.
echo   The coach is running at: http://localhost:8000
echo.
echo   Next steps:
echo   1. Open http://localhost:8000 in your browser
echo   2. Click 'Load Week' to see your Plan Week.md
echo   3. Open Obsidian and navigate to 0-Inbox\Plan Week.md
echo      to verify the example tasks are there
echo.
echo   Useful commands:
echo     Stop:    docker compose down
echo     Start:   docker compose up -d
echo     Logs:    docker compose logs -f
echo     Update:  git pull ^&^& docker compose up --build -d
echo.
echo   Happy task planning!
echo.
pause
