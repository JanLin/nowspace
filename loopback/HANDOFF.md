# HANDOFF — what changed and why (loopback goal vs. real NowSpace)

I read the real NowSpace repo (`../coaching-agent`) and retargeted the loopback **goal** so it
reflects how drag-and-drop actually works. Summary of the gap I found and what I changed.

## What was wrong with the original goal
The original harness assumed a generic single flat todo list with `[data-testid="todo-item"]`
on port 5173. The real app is different on every count:

- **Native HTML5 DnD**, no dnd-kit/react-dnd (the stepped-mouse approach was right — kept it).
- **Six gestures**, not one: within-day reorder, group reorder, move across days,
  Bucket→Plan, carry-forward, subtask reorder — keyed by typed `dataTransfer` payloads
  (`text/plain`, `bucket-task`, `carry-task`, `carry-group`, `subtask`, `vault-note-name`).
- **No `data-testid`s anywhere** — original selectors matched nothing.
- **No `typecheck` script** — `check.sh` step 1 would fail immediately.
- **Wrong port** — Vite is pinned to **1420** (`strictPort`), not 5173.
- **Monorepo** — the app is in `frontend/`, not repo root.
- **Backend-backed persistence** — drops write through FastAPI (:8000) into `Plan Week.md`;
  "persist across reload" means the markdown round-trip really happened.

## What I changed (in this folder)
- `dnd.spec.ts` — rewritten to verify the **4 gestures you flagged** (within-day reorder,
  move across days, Bucket→Plan **with link preservation**, carry-forward) + persistence +
  no-ghost guard. Selectors use a small `data-testid` set.
- `CLAUDE.md` — corrected app description, a real DnD gesture table, the 1420/frontend/backend
  facts, and a "Required FIRST actions" list (add typecheck script, install Playwright, add the
  minimal testids, run backend against a fixture vault).
- `playwright.config.ts` — port 1420, `npm --prefix frontend run dev`, backend note.
- `check.sh` — typecheck/lint via `npm --prefix frontend`.
- `shots.spec.ts` — week-view + bucket-open + mobile screenshots on :1420.
- `DESIGN-RUBRIC.md` — added cross-day / Bucket→Plan / carry-forward affordance items.

## The only app changes the loop needs (small + safe)
Claude Code does these as step 1 on the `loopback/dnd-redesign` branch:
1. `frontend/package.json` → add `"typecheck": "tsc --noEmit"`.
2. `npm i -D @playwright/test && npx playwright install chromium`.
3. Add these `data-testid`s in `WeekPlan.tsx` (and Bucket panel):
   `week-day-<dayname>` (day drop container), `task-row` (draggable task),
   `bucket-toggle` + `bucket-item`, `carry-open` + `carry-item`,
   `task-link-icon` (the existing 🔗 element — needed for the link-preservation assertion).
4. Provide a **test vault fixture** seeded with: ≥3 Monday tasks, ≥1 Tuesday task,
   ≥1 bucket task that has a `[[wiki link]]`, and ≥1 carry-forward task.

## Reported symptoms now encoded as explicit targets
The spec + CLAUDE.md now name the four things you hit:
1. **Drop lands at wrong order** — grid view re-sorts by priority (`sortTasksByPriority`), so a
   manual reorder doesn't stick. (Likely the core bug.)
2. **Drop splits a group** — in groupView a drop interleaves into the group instead of
   before/after it. New test asserts the group stays contiguous.
3. **Drop indicator looks bad** — rubric now calls for a clear gap/line, correct above/below side.
4. **Drag-to-link fails** — new test drags a vault note onto a task and expects the 🔗 icon.

Plus a **fixture vault** under `fixtures/vault/` so the backend has test data (never your real vault).

## To run
The branch `loopback/dnd-redesign` already exists. From the repo root:
```bash
bash ../coaching-agent-PM/nowspace-loopback/setup-in-repo.sh
```
It switches to the branch, copies the harness in, moves CLAUDE.md + playwright.config.ts to
root, adds the `typecheck` script, and installs Playwright. Then start the backend against
`loopback/fixtures/vault` on :8000 and run `claude` (SETUP.md §A) or `./loopback/loop.sh`.
Nothing is committed until you review and commit.
