# NowSpace loopback — setup & run

A self-iterating Claude Code loop that fixes NowSpace's drag-and-drop, then does a visual
polish/redesign pass. The whole idea: nothing is "done" until `loopback/check.sh` exits 0.
That command is the loop's goal.

> **NowSpace specifics (already baked into these files):**
> - The React app lives in **`frontend/`** (monorepo), so typecheck/lint/dev run with
>   `npm --prefix frontend ...`.
> - The Vite dev server is **port 1420** (`strictPort`, Tauri), NOT 5173.
> - DnD is **native HTML5** (no dnd-kit/react-dnd) — the stepped-mouse drag helper is required.
> - There are **no `data-testid`s yet** and **no `typecheck` script yet** — adding both is the
>   loop's first task (see CLAUDE.md → "Required FIRST actions").
> - Persistence writes through the **FastAPI backend on :8000** into `Plan Week.md`. Run it
>   against a **test vault fixture**, never your real Obsidian vault.

## Files (drop the whole `loopback/` folder into the repo root)

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Goes in the **repo root**. Primes Claude Code on the loop, success criteria, guardrails. |
| `loopback/check.sh` | The single success signal: typecheck → lint → DnD e2e → screenshots. |
| `loopback/dnd.spec.ts` | The **verifier** — real drag gestures, asserts DOM order. Edit selectors to match NowSpace. |
| `loopback/shots.spec.ts` | Captures screenshots for the visual pass. |
| `loopback/DESIGN-RUBRIC.md` | The "done" spec for visual quality Claude can't unit-test. |
| `loopback/playwright.config.ts` | Move to repo root (or pass with `-c`). Set dev command + port. |
| `loopback/loop.sh` | Outer guard: re-runs Claude Code until green or 8 attempts. |

## One-time prep

```bash
# from repo root, on a clean working tree
git checkout -b loopback/dnd-redesign
cp -r /path/to/nowspace-loopback ./loopback
mv ./loopback/CLAUDE.md ./CLAUDE.md         # CLAUDE.md belongs at root
mv ./loopback/playwright.config.ts ./playwright.config.ts
chmod +x loopback/*.sh

npm install -D @playwright/test
npx playwright install chromium

# make sure these scripts exist in package.json:
#   "typecheck": "tsc --noEmit"
#   "lint": "eslint ."
```

Then **tailor two things** before the first run:
1. In `dnd.spec.ts` / `shots.spec.ts`, replace `[data-testid="todo-item"]` and list selectors
   with NowSpace's real markup (add the `data-testid`s if they don't exist — small, safe edit).
2. In `playwright.config.ts`, set `BASE_URL` / `WEB_CMD` to the real dev port and command.
   If the UI needs the Python backend running, start it first in another terminal.

## Run it

Two ways, pick one.

### A. Let Claude Code drive interactively (recommended first time)
```bash
# backend running in another terminal if needed
claude
```
Then paste:
> Read CLAUDE.md and loopback/DESIGN-RUBRIC.md. Detect how drag-and-drop is implemented and
> tell me. Then make ./loopback/check.sh exit 0 — fix reorder behavior until loopback/dnd.spec.ts
> passes, then do the visual pass against the rubric using the screenshots in loopback/shots/.
> Run ./loopback/check.sh after each change, fix what fails, commit on each green. Stop after 8
> cycles and write loopback/STATUS.md if you're stuck.

This lets you watch the loop and catch a wrong turn early — the best way to "get a sense of the
capability," which is your stated goal.

### B. Fully headless outer loop
```bash
./loopback/loop.sh
```
Re-invokes Claude Code until green or 8 attempts. Use this once you trust the harness.

## What "loopback" actually is here (the 4 parts)
- **Goal/spec:** `check.sh` + `DESIGN-RUBRIC.md`.
- **Generator:** Claude Code editing the React app.
- **Executor:** Playwright running real drag gestures + the dev server.
- **Verifier/controller:** `check.sh` exit code (behavior) and Claude reading its own
  screenshots (visual), with `loop.sh` / `--max-turns` as the stop guard.

Remove any one of these and it stops being a loop and becomes one-shot guessing. The verifier
is the part people skip — for DnD it's non-negotiable, because "feels good" isn't assertable.

## Gotchas already handled
- The drag helper uses **stepped mouse moves** so it works for native HTML5 DnD *and*
  dnd-kit/react-dnd (a single `dragTo()` jump fails for both in different ways).
- `reuseExistingServer: true` so it won't fight a dev server you already have running.
- Hard 8-cycle cap + `STATUS.md` so the loop can't spin forever or fake a pass.
