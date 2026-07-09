/* Action points in call notes.
   Convention: a line starting with "AP" (uppercase) is an action point:
     AP: send revised proposal
     - AP follow up with Maria
   Lifecycle markers, written back into the call file:
     AP→  harvested into the bucket (won't be offered again)
     AP ✓ the task was completed in Nowspace — the log shows it's done */

export interface FoundAP {
  line: number; // 0-based line index
  text: string; // the action text after the AP marker
  section: string; // nearest preceding ## heading (call/date header), "" if none
}

// "AP" then :/- or space, then the text. Uppercase only — "app"/"apply" never match.
const AP_LINE_RE = /^(\s*[-*]?\s*)AP([:\-]|\s)\s*(.+)$/;
const HARVESTED_RE = /^(\s*[-*]?\s*)AP→/;
const DONE_RE = /^(\s*[-*]?\s*)AP ✓/;

/** Open (not yet harvested, not done) action points in a note,
    tagged with the nearest preceding ## section heading (call date). */
export function findOpenAPs(content: string): FoundAP[] {
  const out: FoundAP[] = [];
  let section = "";
  content.split("\n").forEach((line, i) => {
    const h = line.match(/^##+\s+(.+)$/);
    if (h) { section = h[1].trim(); return; }
    if (HARVESTED_RE.test(line) || DONE_RE.test(line)) return;
    const m = line.match(AP_LINE_RE);
    if (m && m[3].trim()) out.push({ line: i, text: m[3].trim(), section });
  });
  return out;
}

/** The default sections to pre-select: the newest call only.
    Prefers the section whose heading contains the latest YYYY-MM-DD date;
    falls back to the last section in the file. Long histories stay opt-in. */
export function defaultSections(aps: FoundAP[]): Set<string> {
  const sections = [...new Set(aps.map((a) => a.section))];
  if (sections.length <= 1) return new Set(sections);
  let best: string | null = null;
  let bestDate = "";
  for (const s of sections) {
    const d = s.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (d && d > bestDate) { bestDate = d; best = s; }
  }
  return new Set([best ?? sections[sections.length - 1]]);
}

/** Mark the given lines as harvested: "AP" → "AP→" */
export function markHarvested(content: string, lines: number[]): string {
  const set = new Set(lines);
  return content.split("\n").map((line, i) => {
    if (!set.has(i)) return line;
    return line.replace(/^(\s*[-*]?\s*)AP\b/, "$1AP→");
  }).join("\n");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Flip the harvested AP line matching taskText to done: "AP→" → "AP ✓".
    Returns the updated content, or null if no line matched. */
export function markDone(content: string, taskText: string): string | null {
  const wanted = norm(taskText);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*[-*]?\s*)AP→([:\-]|\s)?\s*(.+)$/);
    if (m && norm(m[3]) === wanted) {
      lines[i] = lines[i].replace(/^(\s*[-*]?\s*)AP→/, "$1AP ✓");
      return lines.join("\n");
    }
  }
  return null;
}
