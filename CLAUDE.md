# CLAUDE.md — NowSpace

Guidance for Claude Code when working in this repo. **Read this fully before editing.**

## What NowSpace is

A **Franklin-Planner-style weekly task + notes app** backed by Obsidian markdown (no database).

- **Frontend:** React 19 + TypeScript + Tailwind v4 + Vite, in `frontend/`. Key files:
  `frontend/src/components/WeekPlan.tsx` (the week grid — the main DnD surface, ~3.7k lines),
  `DailyPlan.tsx` (single-day view), `Bucket.tsx` (the deferred-task bucket).
- **Backend:** Python FastAPI (`backend/main.py`, `backend/routers/`) that reads/writes
  `Plan Week.md` and `Plan Week Bucket.md` in the user's Obsidian vault. DnD persistence
  goes **through the backend into markdown** — there is no DB.
- **Dev ports:** frontend Vite is pinned to **1420** (`strictPort`, Tauri convention — NOT
  5173). Backend runs on **8000**. The app is also packaged as a Tauri desktop app.

The current drag-and-drop is **unreliable and janky** — fixing it is the primary goal of the
`loopback/dnd-redesign` branch.

## How NowSpace drag-and-drop actually works (the real spec)

DnD is **native HTML5** (`draggable` + `onDragStart`/`onDragOver`/`onDrop`/`onDragEnd` with
`e.dataTransfer`). There is **no dnd-kit / react-dnd**. Gestures are distinguished by typed
`dataTransfer` payloads. Playwright's `dragTo()` will NOT fire these — use stepped
`mouse.move` (the helper in `dnd.spec.ts` already does).

The week view (`WeekPlan.tsx`) supports **six** gestures. This loop targets the **four** the
user flagged as broken (the other two — group reorder and subtask reorder — are out of scope
unless a fix requires touching them; flag in `STATUS.md` if so):

| # | Gesture | dataTransfer type | What "correct" means |
|---|---------|-------------------|----------------------|
| 1 | **Reorder task within a day** | `text/plain` `{dayIdx,taskIdx}` | drop indicator respects above/below midpoint (`handleDragOver` uses clientY vs midY); order changes; priority code `[A1]` and `[[links]]` preserved |
| 2 | **Move task across days** | `text/plain` | task leaves source day, lands in target day at the drop position; nothing duplicated |
| 3 | **Bucket → Plan** | `bucket-task` `{bucketIdx}` | `pullFromBucket` removes from bucket, inserts into the day; **wiki `[[links]]` must survive the move** (R-BUCK-4) |
| 4 | **Carry-forward** | `carry-task` / `carry-group` | `pullFromCarry` / `pullCarryGroup` pulls an unfinished prior task/group into the chosen day without leaving stale state behind |

Persistence is real: after a drop the change is written to `Plan Week.md` (the right day, the
right group heading `* iGrant:`, the priority code, and any `[[wiki links]]` intact). "Persists
across reload" means the markdown file was rewritten correctly, not a generic backend write.

### Known symptoms to fix (reported by the user — make the tests for these pass)
1. **Drop lands at the wrong order.** The grid view re-sorts tasks by priority on render
   (`sortTasksByPriority`, ~line 2556). A manual drag-reorder doesn't stick because the view
   re-sorts. Decide intended behavior — manual order authoritative within a priority tier, OR
   the drag updates the task's priority/sequence — so the order the user drops into is the
   order shown and saved. Note the decision in `STATUS.md`.
2. **Drop splits a group.** In `groupView`, dropping a task adjacent to a group interleaves it
   into the middle and splits the group. A drop near a group must place the task before/after
   the whole group block (see `reorderGroups` / `reorderPlanGroups`), keeping the group
   contiguous.
3. **Drop indicator looks bad.** The current indicator is a blue top border (`border-blue-400`)
   that's easy to miss/mis-read. Improve it per `DESIGN-RUBRIC.md` (clear gap/line, correct
   above-vs-below side) and make sure it clears on every row after drop.
4. **Drag-to-link fails.** Dropping a vault note onto a task (the `vault-note-name` path →
   `addLinkToTask`) should add a `[[link]]` and show the 🔗 icon. Verify the vault note drag
   source sets `dataTransfer.setData("vault-note-name", ...)` and the task drop target reads it.

## The loopback contract (how you must work on this branch)

You are an **autonomous iterate-to-green loop**. Do not declare done by inspection. "Done" is
defined only by the checks below passing. After every change, run the checks, read the output,
fix what failed, repeat until green or the attempt cap.

**Success command:**

```bash
./loopback/check.sh
```

It must exit 0. In order it runs (all targeting the `frontend/` workspace):

1. `npm --prefix frontend run typecheck` — no type errors.
2. `npm --prefix frontend run lint` — no lint errors.
3. `npx playwright test loopback/dnd.spec.ts` — the drag-and-drop behavior tests.
4. Screenshot capture (`loopback/shots/`) — for the visual pass.

If any step fails, the loop is not done. Treat failing output as your next instruction.

### Required FIRST actions (the harness is not yet wired to this repo)

Before behavior work, make the harness runnable — these are missing today:

1. **Add a `typecheck` script** to `frontend/package.json`: `"typecheck": "tsc --noEmit"`
   (only `lint` exists today).
2. **Install Playwright** in the repo: `npm i -D @playwright/test && npx playwright install chromium`.
3. **Add the test hooks the spec needs.** There are currently **no `data-testid`s anywhere**.
   Add this minimal, safe set (and nothing more) so the spec can target real elements:
   - `data-testid="week-day-<dayname>"` on each day-column drop container in `WeekPlan.tsx`
     (lowercase day name, e.g. `week-day-monday`).
   - `data-testid="task-row"` on each draggable task row, with the visible task text inside it.
   - `data-testid="bucket-toggle"` on the bucket open control; `data-testid="bucket-item"` on
     each draggable bucket row (text inside).
   - `data-testid="carry-open"` on the carry-forward open control; `data-testid="carry-item"`
     on each draggable carry row.
   - `data-testid="view-7day"` on the 7-day view toggle; `data-testid="group-toggle"` on the
     group/flat toggle (the spec switches view + grouping).
   - `data-testid="task-link-icon"` on the existing 🔗 icon; `data-testid="vault-note"` on
     draggable vault notes (for the drag-to-link test).
4. Confirm the backend is up on :8000 with a **test vault fixture** (see SETUP.md) — the
   persist-across-reload test needs real markdown round-tripping. Never hit the prod vault.

### Stopping conditions
- **Stop on green:** all four steps pass.
- **Hard cap:** if `./loopback/check.sh` has not gone green after **8** edit→check cycles,
  STOP and write `loopback/STATUS.md` explaining where you're stuck and what you'd try next.
- **Never** edit `loopback/dnd.spec.ts` to force a pass unless the test itself is wrong — and
  if you believe it is, say so in `STATUS.md` and explain why before changing it.

## Visual polish / redesign pass (after behavior is green)

Capture `loopback/shots/*.png` → **Read the PNGs yourself** → critique against
`loopback/DESIGN-RUBRIC.md` → edit → re-capture. The rubric is the spec; don't invent scope.

## Guardrails

- Work only on the `loopback/dnd-redesign` branch. Commit after each green check
  (`loopback: <what changed> (check green)`).
- **Frontend-first.** Don't change the FastAPI API contract (routes, request/response shapes)
  unless a DnD fix genuinely needs a persistence change. If it does, flag in `STATUS.md`
  first, keep it additive/backward-compatible. The markdown round-trip (right day, group
  heading, priority, links) is the part most likely to need care.
- Do not touch `.env*`, `config.yaml` secrets, or Tauri signing/deploy config.
- Keep todos data realistic — use a fixture vault, never a real/prod vault.

## Commands

```bash
# frontend (in frontend/)
npm --prefix frontend install
npm --prefix frontend run dev        # serves on http://localhost:1420 (strictPort)
npm --prefix frontend run build
npm --prefix frontend run typecheck  # ADD THIS — tsc --noEmit
npm --prefix frontend run lint       # eslint .

# backend (from repo root) — needs a vault path in config.yaml
uvicorn backend.main:app --reload --port 8000

# e2e
npm i -D @playwright/test
npx playwright install chromium
npx playwright test loopback/dnd.spec.ts
```
