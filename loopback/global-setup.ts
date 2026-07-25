// loopback/global-setup.ts — restore the TEST vault to a pristine seed before each
// Playwright run. The DnD tests persist real changes into the markdown (reorder, bucket->
// plan, carry-forward all rewrite files), so without this reset the suite is not
// deterministically re-runnable. Runs once per `npx playwright test` invocation.
//
// IMPORTANT: the backend auto-transitions (archives) any Plan Week.md whose week label is
// older than the current calendar week. The seed therefore CANNOT use a fixed week — it
// would rot the moment the calendar advances past it. Instead we stamp the seed with the
// CURRENT ISO week at reset time, and the carry-forward source archive with LAST week.
import fs from 'fs';
import path from 'path';

const PARA = ['0-Inbox', '1-Projects', '2-Areas', '3-Resources', '4-Archive'];

function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { year: date.getUTCFullYear(), week };
}

const wkTag = (w: { year: number; week: number }) => `${w.year}-wk${String(w.week).padStart(2, '0')}`;
const stampWeek = (text: string, w: { year: number; week: number }) =>
  text.replace(/Week \d{4}-wk\d+/g, `Week ${wkTag(w)}`);

export default function globalSetup() {
  const root = process.cwd();
  const fixtures = path.join(root, 'loopback', 'fixtures');
  const seed = path.join(fixtures, 'seed');
  const vault = path.join(fixtures, 'vault');

  const now = new Date();
  const thisWeek = isoWeek(now);
  const lastWeek = isoWeek(new Date(now.getTime() - 7 * 24 * 3600 * 1000));

  // Ensure PARA structure exists (settings readiness gate needs >=3 folders).
  for (const folder of PARA) {
    fs.mkdirSync(path.join(vault, folder), { recursive: true });
    const keep = path.join(vault, folder, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }

  // Current-week plan + bucket, stamped with the current ISO week.
  fs.writeFileSync(
    path.join(vault, 'Plan Week.md'),
    stampWeek(fs.readFileSync(path.join(seed, 'Plan Week.md'), 'utf8'), thisWeek),
  );
  fs.copyFileSync(path.join(seed, 'Plan Week Bucket.md'), path.join(vault, 'Plan Week Bucket.md'));

  // Carry-forward source = LAST week, in the archive. Wipe any archive debris the
  // backend's auto-transition may have created, then write the single prev-week file.
  const archive = path.join(vault, '4-Archive', 'a0-Inbox');
  fs.rmSync(archive, { recursive: true, force: true });
  fs.mkdirSync(archive, { recursive: true });
  const seedArchive = fs.readdirSync(path.join(seed, '4-Archive', 'a0-Inbox'))[0];
  fs.writeFileSync(
    path.join(archive, `Plan Week - ${wkTag(lastWeek)}.md`),
    stampWeek(fs.readFileSync(path.join(seed, '4-Archive', 'a0-Inbox', seedArchive), 'utf8'), lastWeek),
  );

  // eslint-disable-next-line no-console
  console.log(`[loopback] vault reset: current=${wkTag(thisWeek)} carrySource=${wkTag(lastWeek)}`);
}
