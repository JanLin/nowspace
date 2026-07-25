// loopback/shots.spec.ts — capture screenshots for the VISUAL pass.
// These don't assert; they produce PNGs in loopback/shots/ that Claude Code reads and
// critiques against DESIGN-RUBRIC.md. NowSpace dev server is on :1420.
import { test } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:1420';

test('capture board states', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'loopback/shots/week-desktop.png', fullPage: true });

  // mid-drag visual (hold, screenshot, release) — a Monday task being lifted
  const first = page.locator('[data-testid="week-day-monday"] [data-testid="task-row"]').first();
  const box = await first.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 140, { steps: 6 });
    await page.waitForTimeout(80);
    await page.screenshot({ path: 'loopback/shots/week-mid-drag.png' });
    await page.mouse.up();
  }

  // bucket open (so the bucket panel + its drag affordances are visible)
  const bucket = page.locator('[data-testid="bucket-toggle"]');
  if (await bucket.count()) {
    await bucket.click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'loopback/shots/bucket-open.png', fullPage: true });
  }

  // mobile width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'loopback/shots/week-mobile.png', fullPage: true });
});
