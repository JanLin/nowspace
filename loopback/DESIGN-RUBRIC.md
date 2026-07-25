# DESIGN-RUBRIC.md — the spec for the visual / redesign pass

This is the "done" definition for the parts a test can't assert. After behavior tests are
green, Claude Code captures `loopback/shots/*.png`, **reads them**, and edits until each item
below is satisfied. Score each item pass/fail in `loopback/STATUS.md` after every visual cycle.

## Drag-and-drop affordances
- [ ] Draggable tasks show a clear grab affordance (cursor `grab`/`grabbing`, or a visible handle).
- [ ] During drag, the dragged item is visually distinct (lift/shadow/opacity) and a clear
      **drop indicator** shows where it will land — NowSpace currently uses a blue top border
      (`border-blue-400`); a gap or line is fine, but it must be unambiguous, not just a hover color.
- [ ] The drop indicator respects above-vs-below the midpoint (matches `handleDragOver`'s
      clientY-vs-midY logic) so the task lands where the line shows.
- [ ] On drop, the item settles with a short transition (no instant jump, no sub-200ms flash).
- [ ] No ghost/clone left behind; the blue drop-indicator border clears on every task after drop.

## Cross-surface DnD (NowSpace-specific)
- [ ] **Across days:** dropping a task on another day column shows a clear target-day highlight;
      the task leaves the source day and is not duplicated.
- [ ] **Bucket → Plan:** the bucket panel and bucket items show a drag affordance; the drop
      target day highlights; the moved task keeps its `[[link]]` icon (links survive the move).
- [ ] **Carry-forward:** carried items read clearly as "from a previous day"; once pulled into
      a day they disappear from the carry list (no stale duplicate offered).

## Layout & hierarchy
- [ ] Consistent spacing scale (e.g. 4/8/12/16px), aligned edges, no cramped or random gaps.
- [ ] Clear visual hierarchy: title > metadata > actions. One primary action per todo.
- [ ] Empty state is designed, not a blank panel.

## States
- [ ] Hover, focus (keyboard), active, and disabled states are all visible and distinct.
- [ ] Keyboard reordering works (arrow keys or documented shortcut) — DnD is not the only path.
- [ ] Mobile width (390px) is usable: targets ≥44px, no horizontal scroll, drag still works.

## Polish
- [ ] Color contrast meets WCAG AA for text.
- [ ] Transitions are consistent (same easing/duration tokens), nothing janky on reorder.
- [ ] Nothing visually broken at the screenshots' widths (1280 and 390).

## Out of scope (do NOT do without flagging in STATUS.md)
- Backend/API changes beyond what reorder persistence needs.
- New features (tags, due dates, etc.) — this branch is DnD + visual quality only.
