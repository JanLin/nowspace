# Recurrence — §0 discovery report

Findings required by the recurrence brief §0, with the §9 answers, recorded
before implementation. Where the brief and the codebase disagree, the codebase
wins (per the brief) and the divergence is listed at the bottom.

A prior, independent implementation of this brief exists on the unmerged
branch `claude/habit-notes-recurring-templates-d3ba7f` (commits `a4a6e85`,
`cb9db90`). This attempt is deliberately fresh: its code was not read, only
its commit messages (encountered while mapping branches). Convergent choices
are marked where known.

## How habits are modelled (§0 q1)

- `Plan Week Habits.md` — **not frontmatter**. One bullet per habit under
  `## Body/Mind/Soul/Sleep` headers:
  `- name (variant | variant): 3x/week[, morning][, 30min]`.
  Parser: `_parse_habits_file` (backend/routers/habits.py:44) splits at the
  **last** colon, lowercases the target segment, splits it on commas, and
  **silently ignores unknown tokens** — that tolerance is the old-backend
  round-trip mechanism for a new field. The serializer rebuilds lines from the
  model, so an old backend that re-saves from its Habits editor drops unknown
  tokens (accepted: same skew behaviour as every Habits field).
- **Day-of-week steering does not exist** (§9 q1). The only time dimension is
  the cosmetic `morning` flag. This is by design: Jan's habit tone rules are
  weekly flexible targets, never fixed days. Demote-to-habit therefore carries
  the note link and a weekly target, not a weekday — building day steering
  would contradict the habits feature's own principles, so it is *not* treated
  as a prerequisite (divergence 1).
- Trigger statistics exist (week counts, 8-week history, `established`), no
  streaks. Surfaces: HabitStrip.tsx (strip above week views), Habits.tsx
  (tab), WeekPlan.tsx rollup. The "trigger surface" of the brief = HabitStrip.
- New-field precedent: `duration` (commit `09345c6`) — one comma token, one
  `elif` in the token loop, conditional emit in the serializer.

## Weekly review machinery (§0 q2)

- The review is one client-side wizard: `WeeklyReview` in
  frontend/src/components/Funnel.tsx:461. Steps are a discriminated-union
  array built per render (Funnel.tsx:480–488) with conditional spreads — an
  empty step contributes zero entries, which is exactly the brief's
  "zero seconds when empty" requirement, already idiomatic.
- Adding a step = union variant (Funnel.tsx:452), spread in the array, one
  render block. Item selectors sit at Funnel.tsx:474–478 (`wokenIdxs` etc.).
- There is no `/review` backend route; review edits ride the normal bucket
  autosave through the same gates, and completion PATCHes
  `POST /api/settings/funnel` (`last_review`, `week_focus`).
- New review data (lapsed templates, threshold templates) will come from the
  recurrence GET endpoint and be passed into `WeeklyReview` as props, computed
  client-side like `wokenIdxs`.

## Week close and slipCount (§0 q3)

- Week close is **lazy, on read**: `_auto_transition_if_needed`
  (backend/routers/plan.py:375), fired from `GET /plan/week` offset 0. No
  scheduler, no background task, none should be added.
- All slip increments go through one function: `_increment_bucket_slips`
  (plan.py:351) — bucket-only scan, `stage=="ready" and horizon=="n"`.
  **That loop body is the exclusion seam**: skip items carrying a recurrence
  id and route the miss to the template's `missedStreak` instead.
- The 3-slip threshold is a hardcoded `>= 3` inside the review's slips step
  (Funnel.tsx:563); the slips selector (Funnel.tsx:475) must also exclude
  recurring instances so they never enter that step.
- The slip-by-group stats rollup (plan.py:1879–1889) needs the same exclusion
  or recurring items distort the denominators.

## Due dates in Timing (§0 q4, §9 q3)

- **No due-date concept exists, deliberately** — "Horizons, not deadlines"
  (Philosophy.tsx:37). Scheduling granularity is a day section in a week
  file; there are no time blocks. The brief's `dueDate` is therefore a new
  field, and it must stay a *quiet* fact: rendered as plain text on the
  instance, identical styling before and after the date, no overdue state,
  no color shift. Its only active role is being moved forward by the
  no-stacking rule.
- Tokens: new bucket-line tokens must be colon-free and must ride week lines
  too (an instance that is scheduled moves into the week file; completion
  there must credit the template, and the id must survive the round trip —
  today `POST /plan/bucket/move` preserves only `~e`). Chosen vocabulary:
  - `~r<6 hex>` — recurrence template id on an instance (`recurrence_id`).
  - `~du<YYYY-MM-DD>` — due date (`due_date`), calendar instances only.
- `BucketTask` has `extra="forbid"`; adding fields ⇒
  **`BUCKET_SCHEMA_VERSION` 2 → 3 ⇒ minor release (0.5.0)**, per CLAUDE.md.
  (Convergent with the prior branch, which also bumped to 3.)

## Sync and idempotent spawning (§0 q5, §9 q2)

- Only the vault syncs (Syncthing); each device runs its own backend.
  Precedent for "run once per period": `_auto_transition_if_needed` —
  idempotence derived from on-disk state, never a "last ran" timestamp.
  Spawning copies this: a lazy pass on bucket/week read.
- Idempotence design:
  - Each template records the last **handled** occurrence date (`spawned`
    key). The pass computes the newest occurrence ≤ today; if it is newer
    than `spawned`, handle it (spawn, or apply the no-stacking rule), then
    set `spawned` to it. Re-runs no-op.
  - Instance identity `~i` is **derived** — first 6 hex of
    sha1(`templateId|occurrenceDate`) — instead of random. Two devices that
    both reach a spawn date offline write byte-identical lines; whichever
    file survives Syncthing's conflict pick, the state is the same, and a
    reconcile pass drops any duplicate live instance with the same
    `recurrence_id` (keep the earlier line), repairing files that arrive
    over sync already violating one-live-instance.
  - The save gate additionally refuses a client save containing two live
    instances of one template.
- Sync-conflict/partial-write tolerance follows handoff.py:294–305 (skip
  `.sync-conflict-`, skip sub-2s-old files) — relevant only if templates get
  per-file storage; the chosen single-file store rides the existing bucket
  patterns instead.

## Template storage

`Plan Week Recurring.md`, one `## <title>` block per template with
`- key: value` lines (split at the *first* colon on a known-key whitelist, so
values may contain colons and commas — the reason the Habits one-liner grammar
is not reused: a next action must be free text). Rationale for one file over
per-template frontmatter files: templates are user-editable standing
definitions like Habits.md, hand-editing in Obsidian is a first-class path,
and the `Plan Week *` family is where the app's own data lives. Unknown keys
are preserved on rewrite (unlike Habits) so future fields round-trip through
old backends. (Storage location convergent with the prior branch; block
grammar decided independently.)

Reads/writes go through a small module (`backend/recurrence.py`) used by both
the router and the week-close/spawn seams; whole-file rewrites, tolerant
parse, `expected_mtime` guard on the client-facing save route.

## Wikilinks (§0 q6)

- Resolution: `vault_index.resolve_name` (backend/vault_index.py:128), HTTP
  `GET /api/vault/resolve`; client helper `resolveLink` (frontend/src/links.ts)
  and renderer `renderWikiText` (Bucket.tsx:64). All reused as-is.
- The resolver cannot distinguish a note from an app-managed file, so the
  "notes, never work items" rule (§2.1) is enforced by the habit/template
  save paths: a note value resolving into the `Plan Week *` family /
  `Time Log *` / `_dispatch` is refused with 422.

## §9 answers

1. **Day steering:** doesn't exist and is deliberately absent; demote-to-habit
   carries note + weekly target (see above).
2. **Where spawning runs:** lazily on read, alongside the week-close pattern;
   occurrence ledger + derived instance ids make it sync-safe. No scheduler.
3. **Due dates:** none exist; new quiet `~du` token, calendar instances only.
4. **Dormancy wake for interval lapse:** not reusable — wake is a one-shot
   client-side date check with no re-arm, and lapse is measured from
   `lastCompletedAt`, not a fixed date. The review-step machinery is the right
   seam; lapsed templates are computed like `wokenIdxs`, from template data.

## Divergences from the brief (codebase wins)

1. **Habit `note` is a line token, not frontmatter** — habits have no
   frontmatter. Format: a bare wikilink token, `- tai chi: 2x/week, [[Tai Chi
   form]]` (renders as a real link when the file is opened in Obsidian).
2. **`nextAction` is required for interval templates only** (Jan's call,
   2026-07-30). The brief predates the GTD adjustment (PR #121): Ready =
   sized only, a task is its own next action. A calendar template like "pay
   credit bill" needs no separate first action, so the field is optional
   there; an interval template's coordination step ("propose a date to X")
   is the real content, so it stays mandatory. **Estimate is required on
   every template** — that *is* the ready gate.
3. **`area` is the bucket group.** The codebase derives area from
   group → folder mapping; a second area field would be a parallel truth.
   Instances spawn into the template's group.
4. **The miss threshold is a hardcoded 3**, matching the existing slip
   threshold (also hardcoded). No new config surface until a real need.

## Sequencing note

Stages 1–4 land together as 0.5.0 (the schema bump forces the minor, and
stage 1 alone doesn't justify one); stage 5 diagnostics ride along only where
free. Staging vault note: it contains the *prior* branch's `note=[[...]]`
habit tokens — reseed or hand-edit when testing this branch.
