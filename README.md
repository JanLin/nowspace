# Personal Coaching Agent

A task planning and coaching tool that reads your [Obsidian](https://obsidian.md/) vault, prioritises tasks using AI, and helps you stay focused through coaching questions.

## What It Does

- **Reads your Obsidian vault** — Parses `Plan Week.md` with daily task lists, groups, and subtasks
- **Prioritises tasks** — Uses Claude AI to assign A/B/C priorities based on your goals and patterns
- **Week planning** — Day view, Mon-Fri, full week, and weekend views with drag-and-drop reordering
- **White elephant breakdown** — Break down hard-to-start tasks into small steps (click the elephant icon)
- **Coaching** — AI-powered coaching questions to help you reflect and stay on track
- **Saves back to Obsidian** — All changes sync back to your markdown files

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- An Obsidian vault (or the setup will create one for you)
- A [Claude API key](https://console.anthropic.com/) (optional — planning works without it)

### Setup

1. Clone this repository:

   ```bash
   git clone git@github.com:JanLin/coaching-agent.git
   cd coaching-agent
   ```

2. Run the setup script:

   **Mac / Linux:**
   ```bash
   ./setup.sh
   ```

   **Windows:**
   ```cmd
   setup.bat
   ```

3. The script will ask you for:
   - Your Claude API key (press Enter to skip)
   - The path to your Obsidian vault

4. It creates the vault folder structure and an example `Plan Week.md`, then builds and starts the app.

5. Open **http://localhost:8000** in your browser and click **Load Week**.

### Verify in Obsidian

After setup, open Obsidian and check that your vault has:

```
YourVault/
  0-Inbox/
    Plan Week.md    <-- Your weekly plan lives here
  1-Projects/
  2-Areas/
  3-Resources/
  4-Archive/
```

Open `Plan Week.md` to see the example tasks. Edit them to match your actual week.

## Daily Usage

```bash
# Start the coach
docker compose up -d

# Open in browser
open http://localhost:8000

# Stop when done
docker compose down
```

## Updating

When a new version is available:

```bash
git pull
docker compose up --build -d
```

Your tasks and coaching memory are stored outside the container (in your vault and the `memory/` folder), so updates never lose your data.

## Configuration

All settings are in `.env` (created by the setup script):

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `VAULT_PATH` | Absolute path to your Obsidian vault |

To change settings, edit `.env` and restart:

```bash
docker compose down && docker compose up -d
```

## Feedback and Issues

Found a bug or have a suggestion? Please open an issue:

1. Go to [github.com/JanLin/coaching-agent/issues](https://github.com/JanLin/coaching-agent/issues)
2. Click **New issue**
3. Describe what happened or what you'd like to see
4. Include screenshots if helpful

You can also comment on existing issues to add context or vote for features.

## Tech Stack

- **Backend:** Python, FastAPI, Claude API (Anthropic SDK)
- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Storage:** Obsidian markdown files (no database)
- **Deployment:** Docker
