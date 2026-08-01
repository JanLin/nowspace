/** Notes you've opened lately, shared by every surface that offers a note.
 *
 *  One list, one key: the browser and the task-link picker are two ways of
 *  reaching the same vault, and a note opened in one should be near to hand
 *  in the other. Per-device by design — this is about where you've just
 *  been, which is a property of the screen in front of you, not of the
 *  vault (the same reasoning as the theme and the text size). */

export interface RecentNote {
  path: string;
  name: string;
  timestamp: number;
}

const RECENTS_KEY = "vault-browser-recents";
const MAX_RECENTS = 8;

export function loadRecents(): RecentNote[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.path && r.name) : [];
  } catch {
    return [];
  }
}

export function addToRecents(path: string, name: string): void {
  const recents = loadRecents().filter((r) => r.path !== path);
  recents.unshift({ path, name, timestamp: Date.now() });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
}
