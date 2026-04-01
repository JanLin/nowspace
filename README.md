# Nowspace — Personal Coaching Agent

A task planning and coaching tool that reads your [Obsidian](https://obsidian.md/) vault, prioritises tasks using AI, and helps you stay focused through coaching questions.

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

## Quick Start (Development)

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
   # Edit .env with your ANTHROPIC_API_KEY and vault path
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
    Plan Week Configuration.md  <-- Reference links config
  1-Projects/
  2-Areas/
  3-Resources/
  4-Archive/
```

## Task Icons

Each task has icon actions that appear on hover:

### 🎺 Focus (Trumpet + Pomodoro)

Click the trumpet 🎺 to mark a task as your current focus. A **Pomodoro timer** prompt appears with 15 or 30 minute options. The timer floats on-screen with grace period and break controls.

### 🐘 White Elephant (Breakdown)

Click the elephant 🐘 to break a hard-to-start task into small, actionable subtasks. Each subtask gets its own checkbox.

### ⏳ Waiting (Hourglass)

Click the hourglass ⏳ when a task is blocked. Waiting tasks show a `WAIT:` prefix in Obsidian and are deprioritised in coaching.

## Configuration

Settings are managed from the **Settings** tab in the app:

- **Vault path** — path to your Obsidian vault (auto-detects PARA structure)
- **Claude API key** — stored in `~/.nowspace/.env`, never bundled with the app
- **Reference groups** — map group names to vault folders for the reference file browser

## Tech Stack

- **Desktop:** [Tauri v2](https://v2.tauri.app/) (Rust + WebView)
- **Backend:** Python, FastAPI, Claude API (Anthropic SDK), bundled via PyInstaller
- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Storage:** Obsidian markdown files (no database)

## Feedback and Issues

Found a bug or have a suggestion? [Open an issue](https://github.com/JanLin/coaching-agent/issues).
