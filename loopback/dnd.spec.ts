// loopback/dnd.spec.ts — the VERIFIER for NowSpace drag-and-drop behavior.
//
// This file is the contract. Claude Code edits the APP (WeekPlan.tsx + adds the small
// data-testid set listed in CLAUDE.md) to make these pass — not the other way around.
//
// NowSpace uses NATIVE HTML5 DnD (draggable + dataTransfer), no dnd-kit/react-dnd, so
// page.dragTo() will NOT fire the events. We use stepped manual mouse moves.
//
// Assumes: frontend dev server on :1420 (Vite strictPort) AND the FastAPI backend on :8000
// pointed at a TEST vault fixture (see SETUP.md). The persist-across-reload test needs the
// markdown round-trip to be real.

import { test, expect, Page, Locator } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:1420';

// Stepped drag from the center of `source` to the center of `target`. Intermediate moves +
// small waits are REQUIRED for native HTML5 dnd to register dragenter/dragover/drop.
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const s = await source.boundingBox();
  const d = await target.boundingBox();
  if (!s || !d) throw new Error('source or target not found / not visible');
  const sx = s.x + s.width / 2, sy = s.y + s.height / 2;
  const dx = d.x + d.width / 2, dy = d.y + d.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (dx - sx) * 0.25, sy + (dy - sy) * 0.25);
  await page.waitForTimeout(40);
  await page.mouse.move(sx + (dx - sx) * 0.6, sy + (dy - sy) * 0.6);
  await page.waitForTimeout(40);
  await page.mouse.move(dx, dy);          // settle on target so drop indicator resolves
  await page.waitForTimeout(40);
  await page.mouse.move(dx, dy);
  await page.mouse.up();
}

const dayCol = (page: Page, day: string) =>
  page.locator(`[data-testid="week-day-${day}"]`);
const tasksIn = (page: Page, day: string) =>
  dayCol(page, day).locator('[data-testid="task-row"]');

async function texts(loc: Locator): Promise<string[]> {
  return (await loc.allInnerTexts()).map((t) => t.trim());
}

test.beforeEach(async ({ page }) => {
  await page.goto(BASE);
  // The default view is single-day; cross-day + grid gestures need a multi-day grid.
  // Switch to the 7-day grid so all day columns are visible.
  await page.locator('[data-testid="view-7day"]').click();
  await expect(tasksIn(page, 'monday').first()).toBeVisible();
});

// NOTE FOR THE LOOP — root-cause hints from the user's reported symptoms:
//  * "drag ends at wrong order": the grid view re-sorts tasks by priority on render
//    (sortTasksByPriority in WeekPlan.tsx). A manual drag-reorder won't stick while the
//    view re-sorts. Decide the intended behavior (manual order authoritative within a
//    priority tier, OR drag updates the priority/sequence) and make the order the user
//    drops into the order that shows. These tests assert the DROPPED order is what shows.
//  * "splits a group instead of before/after it": in groupView, dropping a task adjacent to
//    a group must place it before/after the whole group, not interleave into it.

// ---- Gesture 1: reorder a task within a day --------------------------------------------
test('reorder within a day: first task moves below the third', async ({ page }) => {
  const before = await texts(tasksIn(page, 'monday'));
  test.skip(before.length < 3, 'need >= 3 seeded Monday tasks');
  const first = before[0];

  await dragOnto(page,
    tasksIn(page, 'monday').nth(0),
    tasksIn(page, 'monday').nth(2));

  const after = await texts(tasksIn(page, 'monday'));
  expect(after).not.toEqual(before);                 // order changed
  expect(after.indexOf(first)).toBeGreaterThan(0);   // first item moved down
  expect(after.length).toBe(before.length);          // nothing lost/duplicated
});

// ---- Gesture 2: move a task across days ------------------------------------------------
test('move across days: a Monday task lands in Tuesday', async ({ page }) => {
  const monBefore = await texts(tasksIn(page, 'monday'));
  const tueBefore = await texts(tasksIn(page, 'tuesday'));
  test.skip(monBefore.length < 1, 'need a Monday task to move');
  const moved = monBefore[0];

  await dragOnto(page,
    tasksIn(page, 'monday').nth(0),
    dayCol(page, 'tuesday'));                         // drop on the day container

  const monAfter = await texts(tasksIn(page, 'monday'));
  const tueAfter = await texts(tasksIn(page, 'tuesday'));
  expect(monAfter).not.toContain(moved);             // left Monday
  expect(tueAfter).toContain(moved);                 // arrived in Tuesday
  expect(tueAfter.length).toBe(tueBefore.length + 1);
  expect(monAfter.length).toBe(monBefore.length - 1);
});

// ---- Gesture 3: Bucket -> Plan, preserving links ---------------------------------------
test('bucket -> plan: dragging a bucket task into a day moves it and KEEPS its link', async ({ page }) => {
  await page.locator('[data-testid="bucket-toggle"]').click();
  const bucketItem = page.locator('[data-testid="bucket-item"]').first();
  await expect(bucketItem).toBeVisible();
  const label = (await bucketItem.innerText()).trim();
  const tueBefore = await texts(tasksIn(page, 'tuesday'));

  await dragOnto(page, bucketItem, dayCol(page, 'tuesday'));

  const tueAfter = await texts(tasksIn(page, 'tuesday'));
  expect(tueAfter.length).toBe(tueBefore.length + 1);
  // The moved task should be present in Tuesday (matched loosely on its text)
  expect(tueAfter.some((t) => t.includes(label.split('\n')[0]))).toBeTruthy();

  // R-BUCK-4: links survive the move. Seed a bucket task WITH a [[link]] and assert the
  // link icon shows on the new plan task. (Fixture must seed one linked bucket task.)
  const movedRow = tasksIn(page, 'tuesday').filter({ hasText: label.split('\n')[0] }).first();
  await expect(movedRow.locator('[data-testid="task-link-icon"]')).toBeVisible();
});

// ---- Gesture 4: carry-forward ----------------------------------------------------------
test('carry-forward: pulling a carried task into a day adds it and leaves no stale state', async ({ page }) => {
  await page.locator('[data-testid="carry-open"]').click();
  const carryItem = page.locator('[data-testid="carry-item"]').first();
  await expect(carryItem).toBeVisible();
  const label = (await carryItem.innerText()).trim();
  const monBefore = await texts(tasksIn(page, 'monday'));

  await dragOnto(page, carryItem, dayCol(page, 'monday'));

  const monAfter = await texts(tasksIn(page, 'monday'));
  expect(monAfter.length).toBe(monBefore.length + 1);
  expect(monAfter.some((t) => t.includes(label.split('\n')[0]))).toBeTruthy();
  // stale-state guard: the same carried item should not still be offered after it was pulled
  await expect(
    page.locator('[data-testid="carry-item"]').filter({ hasText: label.split('\n')[0] })
  ).toHaveCount(0);
});

// ---- Persistence: the markdown round-trip really happened ------------------------------
test('reorder persists across reload (backend wrote Plan Week.md)', async ({ page }) => {
  const before = await texts(tasksIn(page, 'monday'));
  test.skip(before.length < 2, 'need >= 2 Monday tasks');

  await dragOnto(page, tasksIn(page, 'monday').nth(0), tasksIn(page, 'monday').nth(1));
  const after = await texts(tasksIn(page, 'monday'));
  await page.waitForTimeout(800);                     // let autosave flush to backend
  await page.reload();
  await expect(tasksIn(page, 'monday').first()).toBeVisible();
  expect(await texts(tasksIn(page, 'monday'))).toEqual(after);  // survived reload
});

// ---- Group integrity: a drop must not split a group -----------------------------------
// Reproduces the user's symptom: dropping a task near a group interleaved into the middle
// and split it. Requires groupView ON and a fixture with a contiguous group (e.g. "iGrant"
// has >=2 Monday tasks) plus at least one ungrouped task to drag.
test('dropping a task near a group keeps the group contiguous', async ({ page }) => {
  await page.locator('[data-testid="view-7day"]').click();
  const groupToggle = page.locator('[data-testid="group-toggle"]');
  if (await groupToggle.count()) await groupToggle.click();

  const rows = tasksIn(page, 'monday');
  const order = await texts(rows);
  // indices of the group's tasks (fixture seeds them sharing an "iGrant" prefix/section)
  const groupRows = rows.filter({ hasText: 'iGrant' });
  test.skip((await groupRows.count()) < 2, 'fixture needs >=2 iGrant Monday tasks');

  // Drag an ungrouped task onto the group header / first group task.
  const ungrouped = rows.filter({ hasNotText: 'iGrant' }).first();
  await dragOnto(page, ungrouped, groupRows.first());

  // The group's tasks must remain a contiguous block (not split by the dropped task).
  const after = await texts(tasksIn(page, 'monday'));
  const groupIdxs = after.map((t, i) => (t.includes('iGrant') ? i : -1)).filter((i) => i >= 0);
  const contiguous = groupIdxs.every((v, i) => i === 0 || v === groupIdxs[i - 1] + 1);
  expect(contiguous).toBeTruthy();
});

// ---- Drag-to-link: dropping a vault note onto a task adds a [[link]] -------------------
// Reproduces "drag-to-link fails". Uses the vault-note-name dataTransfer path
// (addLinkToTask). Requires the vault browser / note source to expose draggable notes.
test('dragging a vault note onto a task adds a link icon', async ({ page }) => {
  const noteSource = page.locator('[data-testid="vault-note"]').first();
  test.skip((await noteSource.count()) === 0, 'vault note drag source not present in this view');

  const target = tasksIn(page, 'monday').first();
  await dragOnto(page, noteSource, target);
  await expect(target.locator('[data-testid="task-link-icon"]')).toBeVisible();
});

// ---- Jank guard: no ghost / stuck drag state after drop --------------------------------
test('no ghost / stuck drag state after drop', async ({ page }) => {
  await dragOnto(page, tasksIn(page, 'monday').nth(0), tasksIn(page, 'monday').nth(1));
  await expect(page.locator('.dragging, [data-dragging="true"]')).toHaveCount(0);
  // NowSpace shows the drop indicator with a blue top border; it must clear after drop.
  await expect(page.locator('.border-blue-400')).toHaveCount(0);
});
