# Nowspace (coaching-agent)

FastAPI backend + React/Vite frontend (Tauri desktop wrapper) that is a
presentation layer over an Obsidian vault. **All data is markdown files in
the vault — there is no database.** Multiple installations (Mac desktop
app, Mac Mini server + PWA, dev instances) share one vault via Syncthing.

Key docs: `docs/philosophy.md` (product principles, mirrored in
`frontend/src/components/Philosophy.tsx` — keep the two in step),
`docs/funnel-discovery.md` (funnel/handoff design decisions and format),
`docs/releases/` (per-version notes, used by the release workflow).

## Binding product principles

These come from the funnel and handoff implementation briefs, whose
**non-goals sections are binding**. If a requested change conflicts with
any of the following, say so explicitly, name the principle, and get
confirmation before implementing — do not quietly comply:

- **No notifications, badges, red counts, streaks or nudges about overdue
  or slipped work.** Anywhere, ever. The weekly review is the notification.
  (One allowed quiet signal each: the Review pill's weekly "due" state, the
  logo's after-cutoff half-moon.)
- **Capture is never gated.** No required fields, no classification, no
  prompts at capture, on any surface.
- **Limits are hard.** The Binding WIP limit, the in-flight dispatch limit
  and the ready gate must refuse — never a warning, a confirmation dialog
  or an "I understand" checkbox. A check that can be clicked past will be.
- **Only `ready`/`active` items are schedulable.** This is the entire
  contract between Bucket and Timing; enforce it on every route including
  direct API calls.
- **The conformance check cannot be overridden**, fails closed on anything
  unresolvable, and reports every failure, not the first.
- **Nowspace hands agents paths, never content**, and agent output enters
  the funnel only as `captured` — never ready, never binding, never
  editing an existing item. No agent suggestions of what to think about.
- **Measure the system, never the user.** No scores for thinking; slips
  and age-in-ready stay separate figures.
- **The Slate stays read-only** (plus its one capture box); rehearse
  questions never link out to answers.

## Data-format and compatibility rules

- Funnel state lives in tilde tokens on bucket lines (`~s:` `~e:`/`~es`
  `~sl:` `~rs:` `~se:` `~wake:` `~dr:` `~rh`); the binding question is a
  `- ? …` subtask line. New metadata must round-trip as opaque text
  through OLD backends (Syncthing version skew) — verify before changing
  the format.
- `BUCKET_SCHEMA_VERSION` (backend/models.py) governs forced upgrades:
  **bump it only together with a minor release (0.x), never in a patch
  (0.x.y)**. Patch releases must keep the format unchanged so mixed patch
  levels interoperate. Any format change without a schema bump silently
  corrupts other instances — this is the highest-severity mistake in this
  codebase.
- Keep the three skew guards intact: client version on bucket writes,
  `extra="forbid"` on BucketTask/BucketMoveRequest, and the `bucket_schema`
  marker in the vault settings file (how isolated desktop apps detect skew).
- Whole-file vault writes need the `expected_mtime` guard pattern; new
  writers to synced files must tolerate `.sync-conflict-` files and
  partial writes.

## Process

- Run `python3 -m pytest backend/tests -q` (44+ tests) and
  `cd frontend && npx tsc --noEmit` before committing. The **canary
  harness** in `backend/tests/test_handoff.py` failing means an area
  boundary leaked — never weaken that test to make a change pass.
- Never develop against the real vault: use the staging setup (separate
  vault + ports 8100/5273, `staging-*` entries in `.claude/launch.json`;
  see README "Staging"). The worktree keeps its own gitignored
  `config.yaml` pointing at the staging vault.
- User-facing copy changes go to HelpGuide.tsx, Philosophy.tsx AND
  `docs/philosophy.md` together.
- Releases: tag `v0.x.y` on main; notes come from `docs/releases/0.x.y.md`;
  the workflow uploads stable-named installers that the README's
  `releases/latest` links depend on — don't rename them.
