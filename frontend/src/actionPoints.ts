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
}

// "AP" then :/- or space, then the text. Uppercase only — "app"/"apply" never match.
const AP_LINE_RE = /^(\s*[-*]?\s*)AP([:\-]|\s)\s*(.+)$/;
const HARVESTED_RE = /^(\s*[-*]?\s*)AP→/;
const DONE_RE = /^(\s*[-*]?\s*)AP ✓/;

/** Open (not yet harvested, not done) action points in a note */
export function findOpenAPs(content: string): FoundAP[] {
  const out: FoundAP[] = [];
  content.split("\n").forEach((line, i) => {
    if (HARVESTED_RE.test(line) || DONE_RE.test(line)) return;
    const m = line.match(AP_LINE_RE);
    if (m && m[3].trim()) out.push({ line: i, text: m[3].trim() });
  });
  return out;
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
