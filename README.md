# Nowspace — Personal Coaching Agent

A task planning and coaching tool that reads your [Obsidian](https://obsidian.md/) vault, prioritises tasks using AI, and helps you stay focused through coaching questions.

## Table of Contents

- [What It Does](#what-it-does)
- [Download Desktop App](#download-desktop-app)
- [Run with Docker](#run-with-docker)
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

When configured, a **Work | Volunteer | Personal | All** switch appears in the week view and bucket. The active mode filters every list, panel, and counter — nothing from other contexts leaks through.

**Markup convention** — trailing `@` tokens on a task line are metadata, hidden from the displayed label:

- `@w` / `@v` / `@p` — force a context for one task (overrides the group mapping)
- `@pin` — surface a personal/volunteer task during Work mode (the 📌 icon toggles it)

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
