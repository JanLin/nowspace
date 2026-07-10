# Nowspace — Personal Coaching Agent

![Version](https://img.shields.io/github/package-json/v/JanLin/coaching-agent?filename=frontend%2Fpackage.json&label=version&color=4c78dd)

A task planning and coaching tool that reads your [Obsidian](https://obsidian.md/) vault, prioritises tasks using AI, and helps you stay focused through coaching questions.

## Table of Contents

- [What It Does](#what-it-does)
- [Download Desktop App](#download-desktop-app)
- [Run with Docker](#run-with-docker)
- [Always-on Mac + Phone Access](#always-on-mac--phone-access)
- [Development Setup](#development-setup)
- [Vault Structure](#vault-structure)
- [Task Icons](#task-icons)
- [Configuration](#configuration)
- [Tech Stack](#tech-stack)
- [Feedback and Issues](#feedback-and-issues)

## What It Does

- **Reads your Obsidian vault** — Parses `Plan Week.md` with daily task lists, groups, and subtasks
- **Prioritises tasks** — Uses Claude AI to assign A/B/C priorities based on your goals and patterns
- **Week planning** — Day view, Mon-Fri, full week, and weekend views with drag-and-drop reordering
- **Bucket list** — Park tasks you want to do later and pull them into any day
- **White elephant breakdown** — Break down hard-to-start tasks into small steps (click the elephant icon)
- **Coaching** — AI-powered coaching questions to help you reflect and stay on track
- **Notes & references** — Scratchpad with wiki-link support and reference file browser
- **Settings** — Configure vault path, API key, and reference groups from the app
- **Saves back to Obsidian** — All changes sync back to your markdown files

## Download Desktop App

Download the latest version for your platform:

| Platform | Download |
|---|---|
| **macOS (Apple Silicon)** | [Nowspace_0.2.0_aarch64.dmg](https://github.com/JanLin/coaching-agent/releases/latest/download/Nowspace_0.2.0_aarch64.dmg) |
| **Windows** | [Nowspace_0.2.0_x64-setup.exe](https://github.com/JanLin/coaching-agent/releases/latest/download/Nowspace_0.2.0_x64-setup.exe) |
| **Linux (AppImage)** | [Nowspace_0.2.0_amd64.AppImage](https://github.com/JanLin/coaching-agent/releases/latest/download/Nowspace_0.2.0_amd64.AppImage) |
| **Linux (deb)** | [nowspace_0.2.0_amd64.deb](https://github.com/JanLin/coaching-agent/releases/latest/download/nowspace_0.2.0_amd64.deb) |

Or browse all releases: [github.com/JanLin/coaching-agent/releases](https://github.com/JanLin/coaching-agent/releases)

### First Launch

1. Open the app — on first launch it will open the **Settings** tab
2. **Set your Obsidian vault path** — browse to your vault folder (the app auto-detects the PARA structure)
3. **Enter your Claude API key** — get one at [console.anthropic.com](https://console.anthropic.com/) (keys start with `sk-ant-`)
4. Once configured, the app switches to the **Plan** tab and loads your week

Your API key is stored locally in `~/.nowspace/.env` and is never sent anywhere except the Anthropic API.

## Run with Docker

Run Nowspace as a web app using Docker, without installing Python or Node.js.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- An Obsidian vault with PARA folder structure
- A [Claude API key](https://console.anthropic.com/) (optional — planning works without it)

### Quick Start

1. Clone and configure:

   ```bash
   git clone git@github.com:JanLin/coaching-agent.git
   cd coaching-agent
   cp .env.example .env
   # Edit .env — set ANTHROPIC_API_KEY and VAULT_PATH
   ```

2. Start the container:

   ```bash
   docker compose up -d
   ```

3. Open **http://localhost:8000** in your browser.

The `VAULT_PATH` environment variable in `.env` is mounted into the container so the app can read and write your Obsidian files. Changes sync back to your vault on disk.

To stop: `docker compose down`

## Always-on Mac + Phone Access

Run Nowspace on an always-on Mac (e.g. a Mac mini that already holds a
Syncthing copy of the vault) and reach it from your phone anywhere via
[Tailscale](https://tailscale.com). The backend serves the built frontend
itself, and production builds use same-origin API calls — no CORS, no
extra server. The `deploy/` folder automates keeping it current.

**One-time setup on the Mac:**

```sh
git clone https://github.com/JanLin/coaching-agent.git && cd coaching-agent
# config.yaml: point vault_path at the synced vault; keep server.host 127.0.0.1
pip3 install -r requirements.txt
(cd frontend && npm ci && npx vite build)

# Install the launchd services (server + hourly auto-update)
REPO=$(pwd)
for f in deploy/com.nowspace.server.plist deploy/com.nowspace.update.plist; do
  sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" "$f" > ~/Library/LaunchAgents/$(basename "$f")
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$(basename "$f")
done

# Expose it to your tailnet only (never use `tailscale funnel`)
tailscale serve --bg 8000
```

Then on the phone: install Tailscale, sign in to the same tailnet, open
`https://<mac-name>.<tailnet>.ts.net`, and use "Add to Home Screen" — the
PWA manifest makes it launch full-screen like an app.

**Updates are automatic**: `deploy/update-nowspace.sh` runs hourly via
launchd, and whenever `origin/main` has new commits it pulls, rebuilds the
frontend, refreshes Python deps, and restarts the server. Merging a PR is
the deploy. Check the running version any time in Settings → About, or run
the script by hand for an immediate update. Logs land in
`~/Library/Logs/nowspace-{server,update}.log`.

## Development Setup

### Prerequisites

- Python 3.9+, Node.js 18+
- An Obsidian vault with PARA folder structure
- A [Claude API key](https://console.anthropic.com/) (optional — planning works without it)

### Setup

1. Clone and install:

   ```bash
   git clone git@github.com:JanLin/coaching-agent.git
   cd coaching-agent
   pip install -r requirements.txt
   cd frontend && npm install && cd ..
   ```

2. Configure:

   ```bash
   cp .env.example .env
   cp config.yaml.example config.yaml
   # Edit .env with your ANTHROPIC_API_KEY
   # Edit config.yaml with your vault path
   ```

3. Run:

   ```bash
   # Backend
   uvicorn backend.main:app --reload --port 8000

   # Frontend (separate terminal)
   cd frontend && npm run dev
   ```

4. Open **http://localhost:5173** in your browser.

### Building the Desktop App

```bash
# Build the Python sidecar binary
./build-backend.sh

# Build the Tauri desktop app
cd frontend && npm run tauri build
```

The built app will be in `frontend/src-tauri/target/release/bundle/`.

## Vault Structure

The app expects an Obsidian vault with PARA folders:

```
YourVault/
  0-Inbox/
    Plan Week.md          <-- Your weekly plan
    Plan Week Bucket.md   <-- Parked tasks (bucket list)
  1-Projects/
  2-Areas/
  3-Resources/
  4-Archive/
```

## Task Icons

Each task has icon actions that appear on hover:

### Focus (Trumpet + Pomodoro)

Click the trumpet to mark a task as your current focus. A **Pomodoro timer** prompt appears with 15 or 30 minute options. The timer floats on-screen with grace period and break controls.

### White Elephant (Breakdown)

Click the elephant to break a hard-to-start task into small, actionable subtasks. Each subtask gets its own checkbox.

### Waiting (Hourglass)

Click the hourglass when a task is blocked. Waiting tasks show a `WAIT:` prefix in Obsidian and are deprioritised in coaching.

## Contexts (Work / Volunteer / Personal)

Optionally separate tasks into three contexts so you can mentally switch off work at the end of the day (and keep private errands out of sight during work hours). Enable by mapping group prefixes in `config.yaml`:

```yaml
contexts:
  work: [acme, client-x]
  volunteer: [rotary]
  # everything else counts as personal
```

When configured, **Work / Volunteer / Personal** filter chips appear in the week view and bucket. Chips toggle independently and combine — e.g. select Personal + Volunteer for the full private-time view, or just Work during the day. **All** clears the filter. The active selection filters every list, panel, and counter — nothing from unselected contexts leaks through. When more than one context is visible, tasks carry a colored left edge (blue work / purple volunteer / green personal).

**Markup convention** — trailing `@` tokens on a task line are metadata, hidden from the displayed label:

- `@w` / `@v` / `@p` — force a context for one task (overrides the group mapping)
- `@pin` — surface a personal/volunteer task during Work mode (the 📌 icon toggles it)

**Teach a group inline** — no need to edit config for new groups: type the tag right after the group name once, e.g. `wallet@w: fix access control`. Nowspace assigns the whole `wallet` group to Work, persists it to config, and cleans the tag from the line on save. Works when typed in the app or directly in Obsidian. Re-teaching (`wallet@p: …`) reassigns the group — latest wins.

Pins are deliberately short-lived: completing the task removes `@pin`, and carrying a task to another day or week drops it too — surfacing an errand during work hours is a decision you re-make each day. Tasks added while a mode is active automatically get that mode's token so they don't vanish from the current filter.

## Configuration

Settings are managed from the **Settings** tab in the app:

- **Vault path** — path to your Obsidian vault (auto-detects PARA structure)
- **Claude API key** — stored in `~/.nowspace/.env`, never bundled with the app
- **Reference groups** — map group names to vault folders for the reference file browser

For development, settings live in `config.yaml` (copy from `config.yaml.example`).

## Tech Stack

- **Desktop:** [Tauri v2](https://v2.tauri.app/) (Rust + WebView)
- **Backend:** Python, FastAPI, Claude API (Anthropic SDK), bundled via PyInstaller
- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Storage:** Obsidian markdown files (no database)

## Feedback and Issues

Found a bug or have a suggestion? [Open an issue](https://github.com/JanLin/coaching-agent/issues).
