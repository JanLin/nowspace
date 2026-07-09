/** Flexible time input → "HH:MM" (colon optional: 1945, 945, 9:45); null if invalid */
export function normTime(raw: string): string | null {
  const s = raw.trim().replace(".", ":");
  const m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mnt = parseInt(m[2], 10);
  if (h > 23 || mnt > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mnt).padStart(2, "0")}`;
}

/** "HH:MM" shifted by minutes, clamped to the same day */
export function shiftTime(hhmm: string, deltaMin: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, Math.max(0, h * 60 + m + deltaMin));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
