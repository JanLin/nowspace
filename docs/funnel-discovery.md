# Funnel + Handoff — §0 discovery report

Findings required by `nowspace-funnel-implementation-brief.md` §0 and
`nowspace-handoff-implementation-brief.md` §0/§7, recorded before implementation.
Where the briefs and the codebase disagree, the codebase wins (per the briefs)
and the divergence is listed at the bottom.

## How tasks are modelled and persisted

- Everything is markdown in the Obsidian vault; there is no database.
- Bucket items are task lines in `Plan Week Bucket.md` (`- nA: label` under
  `- Group:` headers), parsed/serialized by `_parse_bucket_file` /
  `_format_bucket_tasks` (`backend/routers/plan.py`). Metadata is encoded in
  the line: priority `A:`–`D:`, horizon prefix `n`/`nw`/`m`, `**bold**` =
  focused, `WAIT:` = waiting, hidden tilde tokens `~wYYWW` (entry week) and
  `~m` (legacy month horizon).
- Week plans are `Plan Week.md` (+ dated future/archive files) with seven
  `##### Day` sections; checked boxes are completion state.
- Migrations: there is no migration framework. The convention is tolerant
  parsing (legacy `[A]` priorities still parse) plus opportunistic in-place
  fixes on save. Version skew is guarded by `extra="forbid"` on the Pydantic
  models (422 instead of silent field loss).

## Epic → task decomposition (to reuse as the exit from Binding)

The existing mechanism is **subtasks + promote**: any task can be broken into
indented subtask steps (the 🐘 affordance); `promoteSubtask` (Bucket) turns a
step into its own task, and `@epic` graduation (WeekPlan) records a ticked
step as its own completed day task. Per the brief this is reused: the funnel's
"≥1 concrete next action" is **≥1 subtask**, and decomposition out of Binding
is the existing subtask flow — no parallel mechanism is built.

## How Bucket and Timing query items

"Timing" = the week-plan surfaces. Items reach them through exactly one server
chokepoint: `POST /plan/bucket/move` (`from_bucket` branch). The client-side
entry points are the weekday row in Bucket's badge menu and WeekPlan's bucket
side panel / drag targets. The stage filter (only `ready` is schedulable)
belongs in that endpoint plus those UI entry points.

## Habits

`Plan Week Habits.md`, domains body/mind/soul/sleep; completions are ordinary
checked week tasks (`habit: <name>`), statistics (8-week history, established
flag) already exist in `GET /plan/habits`. The "trigger habit" for the slate
(stage 5) can be an ordinary habit entry — no new tracking is needed.

## Existing fields

- Priority A–D: exists (bucket + week).
- GTD horizon n/nw/m: exists (bucket only).
- **s/m/l estimate: does NOT exist anywhere.** The brief assumed it might; it
  must be added. It will follow the tilde-token pattern (`~e:s|m|l`) with a
  proper field on `BucketTask`.

## Handoff-brief specifics (§0/§7 answers)

- **Bucket item ↔ file**: a Bucket item is a *line*, not a file, and
  frontmatter is NOT where funnel fields go — they go into the line's token
  vocabulary. Dispatch records (handoff §2) will be per-file with frontmatter
  as the brief expects, since those are new artifacts.
- **Areas**: no first-class Area entity. The closest mapping is the group →
  vault-folder mapping (`reference_links` in `Plan Week Configuration.md`,
  resolved by `vault_index.resolve_group_to_folder`). Handoff area config will
  be a new explicit `areas:` section in the vault settings file, with `root`
  required — groups alone do not define a security boundary. (§7 Q1: areas do
  not currently correspond to a single folder root; the mapping is established
  first, as the brief requires.)
- **Link/embed resolution**: wikilinks `[[...]]` are resolved by
  `vault_index.resolve_name` → `TaskLink.resolved_path`. **Embeds `![[...]]`
  are not handled anywhere** — the conformance check must add embed parsing,
  reusing the existing `WIKI_LINK_RE`/index resolution rather than a new
  resolver. Frontmatter references and Dataview queries are NOT resolved by
  the existing code (§7 Q4) → per the brief, attached notes containing
  Dataview-style queries fail the conformance check outright.
- **Note-body readers** (§0 caution "Nowspace must not become a content
  proxy"): `GET /api/notes/read` is the single general body reader (editor,
  notes panel, diary, link preview). The conformance checker reads bodies
  *server-side* only to resolve links/embeds — it never returns body content
  to the agent or the dispatch record.
- **Vault is synced** (Syncthing, §7 Q3): `proposalsPath` watching must
  tolerate partial writes and `.sync-conflict-` files; all new writes go
  through the same `expected_mtime` guard pattern where a read-modify-write
  exists.
- Dispatch records live under the area root (e.g. `<root>/_dispatch/`), so
  they inherit the boundary; the conformance check exempts the dispatch
  record itself from its own link scan (records link to the source item,
  which lives in `0-Inbox`, outside the area — see divergences).

## Divergences from the briefs (codebase wins / judgment calls)

1. **No per-item files, no frontmatter for funnel fields** — stage and friends
   are line tokens + first-class API fields, matching the existing format.
2. **`sourceItem` is not a path** (handoff §2): bucket items have no path. The
   dispatch record stores the item's text + stable id instead, and `area` is
   derived from the item's group → area mapping, then frozen on the record.
3. **Estimates don't pre-exist** — added as `~e:` token, s/m/l.
4. **Migration default**: items already carrying a priority or a horizon are
   grandfathered to `ready` (the user was de facto scheduling them); everything
   else defaults to `captured`. Grandfathered items may lack next-action/
   estimate; the ready *gate* applies to transitions from now on. This is the
   "sensible default" trade-off — blocking the user's whole existing bucket on
   day one would be worse.
5. **Obsidian edits bypass API gates** by design (files are the source of
   truth). Invariants are enforced on every app route; hand-edited violations
   are surfaced in the UI (e.g. an over-limit Binding count renders as
   over-limit and blocks additions) rather than "fixed" silently.
6. **Slate/review surfaces**: "reachable in under five seconds with no
   navigation" is implemented as a nav tab (one tap) — the app has no global
   overlay pattern and inventing one would fight the shell.
7. **stageEnteredAt / readySince** are stored at day precision (ISO date
   tokens), matching the app's week/age display conventions; cycle-time
   diagnostics are reported in days/weeks.

## Pre-existing bugs found during discovery (out of scope, reported)

- `/api/vault/pinned-notes` (GET/POST) calls `config.pinned_notes` /
  `config.save_pinned_notes`, which don't exist → 500 on use.
- `POST /plan/bucket/move` silently drops subtasks in both directions.
  (This one matters to the funnel: the next action must survive the move —
  fixed as part of stage 1.)
