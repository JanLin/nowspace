import { useEffect, useRef, useState } from "react";
import { type RecurrenceTemplate } from "../api";

/* Recurring schedules — set and edited on the task itself via the ↻
   popover; there is no separate management layout. Tone rules, from the
   brief and the philosophy: templates carry no streaks and no visible miss
   counts (misses surface once, in the weekly review, as a question about
   the cadence). */

export function isIntervalRepeat(repeat: string): boolean {
  return /^every\s+\d+\s*[wd]$/i.test(repeat.trim());
}

/* ── The clickable schedule (per-task ↻ popover) ───────────── */

const WDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type RepeatChoice =
  | { kind: "weekly"; weekdays: number[]; every: number } // weekdays [] = any day that week
  | { kind: "monthly"; day: number; every: number };

export function repeatString(c: RepeatChoice): string {
  const prefix = c.every > 1 ? `${c.every}-` : "";
  if (c.kind === "monthly") return `${prefix}monthly on ${c.day}`;
  return c.weekdays.length
    ? `${prefix}weekly on ${c.weekdays.map((i) => WDAY_KEYS[i]).join(" ")}`
    : `${prefix}weekly`;
}

/** Parse a calendar repeat back into a choice (null for interval/invalid). */
export function parseRepeatChoice(repeat: string): RepeatChoice | null {
  const r = repeat.trim().toLowerCase();
  const mm = r.match(/^(?:(\d{1,2})-)?monthly\s+on\s+(\d{1,2})$/);
  if (mm) return { kind: "monthly", day: parseInt(mm[2], 10), every: mm[1] ? parseInt(mm[1], 10) : 1 };
  const wm = r.match(/^(?:(\d{1,2})-)?weekly(?:\s+on\s+((?:\w{3}\s*)+))?$/);
  if (wm) {
    const every = wm[1] ? parseInt(wm[1], 10) : 1;
    if (!wm[2]) return { kind: "weekly", weekdays: [], every };
    const days = wm[2].split(/\s+/).map((w) => WDAY_KEYS.indexOf(w.slice(0, 3))).filter((i) => i >= 0);
    return days.length ? { kind: "weekly", weekdays: [...new Set(days)].sort(), every } : null;
  }
  return null;
}

/** Terse cadence for the ↻ badge: "w", "2w", "m", "3m"; interval "6w". */
export function repeatShort(repeat: string): string {
  const r = repeat.trim().toLowerCase();
  const im = r.match(/^every\s+(\d+)\s*([wd])$/);
  if (im) return `${im[1]}${im[2]}`;
  const c = parseRepeatChoice(r);
  if (!c) return "";
  return `${c.every > 1 ? c.every : ""}${c.kind === "monthly" ? "m" : "w"}`;
}

/** Hover text for the ↻ badge: the schedule in plain words. */
export function repeatTooltip(repeat: string): string {
  const r = repeat.trim();
  if (isIntervalRepeat(r)) return `Repeats ${r.toLowerCase()} — surfaces in the weekly review`;
  const c = parseRepeatChoice(r);
  if (!c) return "Repeats";
  const cadence = c.every > 1
    ? (c.kind === "monthly" ? `every ${c.every} months` : `every ${c.every} weeks`)
    : (c.kind === "monthly" ? "monthly" : "weekly");
  if (c.kind === "monthly") return `Repeats ${cadence} on the ${c.day}${ordinal(c.day)}`;
  if (!c.weekdays.length) return `Repeats ${cadence} — comes up as n, no set day`;
  return `Repeats ${cadence} on ${c.weekdays.map((i) => WDAY_LABELS[i]).join(", ")}`;
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** Next occurrence on/after `from` — mirrors the backend's occurrence walk
    (weekly-no-day anchors on Monday of the current week). ISO date. */
export function nextOccurrenceISO(c: RepeatChoice, from: Date): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const iso = (x: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  };
  if (c.kind === "monthly") {
    const clamp = (y: number, m: number) => {
      const last = new Date(y, m + 1, 0).getDate();
      return new Date(y, m, Math.min(c.day, last));
    };
    const thisMonth = clamp(d.getFullYear(), d.getMonth());
    return iso(thisMonth >= d ? thisMonth : clamp(d.getFullYear(), d.getMonth() + 1));
  }
  const monWeekday = (x: Date) => (x.getDay() + 6) % 7; // Mon=0
  if (!c.weekdays.length) {
    const monday = new Date(d);
    monday.setDate(d.getDate() - monWeekday(d));
    return iso(monday);
  }
  for (let i = 0; i < 7; i++) {
    const cand = new Date(d);
    cand.setDate(d.getDate() + i);
    if (c.weekdays.includes(monWeekday(cand))) return iso(cand);
  }
  return iso(d);
}

/** Interval length in days for "every 6w" / "every 45d" (null otherwise). */
export function intervalDays(repeat: string): number | null {
  const im = repeat.trim().match(/^every\s+(\d+)\s*([wd])$/i);
  return im ? parseInt(im[1], 10) * (im[2].toLowerCase() === "w" ? 7 : 1) : null;
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Next occurrence strictly AFTER the anchor (the last handled occurrence),
    honouring every-N parity the same way the backend anchors it on
    `spawned`. Used for "next 25 Aug" display, never for spawning. */
export function nextAfterISO(c: RepeatChoice, anchorISO: string): string {
  const anchor = new Date(`${anchorISO}T00:00:00`);
  if (isNaN(anchor.getTime())) return nextOccurrenceISO(c, new Date());
  const p = (n: number) => String(n).padStart(2, "0");
  const iso = (x: Date) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  if (c.kind === "monthly") {
    const m = anchor.getMonth() + c.every;
    const last = new Date(anchor.getFullYear(), m + 1, 0).getDate();
    return iso(new Date(anchor.getFullYear(), m, Math.min(c.day, last)));
  }
  const monWeekday = (x: Date) => (x.getDay() + 6) % 7;
  const mondayOf = (x: Date) => { const d = new Date(x); d.setDate(d.getDate() - monWeekday(d)); return d; };
  if (!c.weekdays.length) {
    const d = mondayOf(anchor);
    d.setDate(d.getDate() + 7 * c.every);
    return iso(d);
  }
  const aMon = mondayOf(anchor).getTime();
  for (let i = 1; i <= 7 * (c.every + 1); i++) {
    const cand = new Date(anchor);
    cand.setDate(anchor.getDate() + i);
    if (!c.weekdays.includes(monWeekday(cand))) continue;
    const wk = Math.round((mondayOf(cand).getTime() - aMon) / (7 * 86400000));
    if (wk % c.every === 0) return iso(cand);
  }
  return nextOccurrenceISO(c, new Date());
}

/** The per-task repeat popover: weekly with clickable days (none = "comes
    up as n that week") or monthly with a clickable day grid. When editing
    an existing template it also offers pause/resume and stop. Absolutely
    positioned — render inside a `relative` anchor. */
/** What the popover hands back on save. `calendar` is null for interval
    schedules (review-driven, measured from the last completion), which
    also carry their required coordination step. */
export type RepeatResult = {
  repeat: string;
  calendar: RepeatChoice | null;
  nextAction?: string;
};

export function RepeatPopover({ template, onSave, onPause, onStop, onClose, align = "right" }: {
  template?: RecurrenceTemplate | null; // null/undefined = creating
  onSave: (result: RepeatResult) => void;
  onPause?: () => void; // toggles pause/resume when editing
  onStop?: () => void;  // retire; the task stays as an ordinary task
  onClose: () => void;
  /** Which edge of the anchor to align with. The ↻ badge sits at the LEFT
      of the task, so its popover must open rightward (align="left") or it
      falls off the window; the hover icon on the row's right edge keeps
      the default. */
  align?: "left" | "right";
}) {
  const existing = template ? parseRepeatChoice(template.repeat) : null;
  const existingDays = template ? intervalDays(template.repeat) : null;
  const [kind, setKind] = useState<"weekly" | "monthly" | "interval">(
    existingDays !== null ? "interval" : existing?.kind === "monthly" ? "monthly" : "weekly");
  const [weekdays, setWeekdays] = useState<number[]>(existing?.kind === "weekly" ? existing.weekdays : []);
  const [monthDay, setMonthDay] = useState<number>(existing?.kind === "monthly" ? existing.day : 0);
  // Intervals count in weeks unless the file says days ("every 45d")
  const intUnit: "w" | "d" = existingDays !== null && existingDays % 7 !== 0 ? "d" : "w";
  const [every, setEvery] = useState<number>(
    existingDays !== null ? (intUnit === "w" ? existingDays / 7 : existingDays) : existing?.every || 1);
  const [nextAction, setNextAction] = useState(template?.next_action || "");
  const everyMax = kind === "monthly" ? 12 : kind === "weekly" ? 52 : intUnit === "w" ? 52 : 365;
  const clampedEvery = Math.max(1, Math.min(everyMax, every || 1));

  // Clicking anywhere outside closes the popover (same as the note picker)
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const choice: RepeatChoice | null =
    kind === "weekly"
      ? { kind: "weekly", weekdays, every: clampedEvery }
      : kind === "monthly" && monthDay ? { kind: "monthly", day: monthDay, every: clampedEvery } : null;
  const result: RepeatResult | null =
    kind === "interval"
      ? (nextAction.trim()
          ? { repeat: `every ${clampedEvery}${intUnit}`, calendar: null, nextAction: nextAction.trim() }
          : null)
      : choice ? { repeat: repeatString(choice), calendar: choice } : null;
  const changed = !template || !result
    || result.repeat !== template.repeat.trim().toLowerCase()
    || (result.nextAction !== undefined && result.nextAction !== template.next_action);

  const chip = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${active ? "bg-blue-600 text-white" : ""}`;
  const chipStyle = (active: boolean) =>
    active ? undefined : ({ background: "var(--bg-tertiary)", color: "var(--text-secondary)" } as const);

  return (
    <div ref={popRef}
      className={`absolute top-6 ${align === "left" ? "left-0" : "right-0"} z-40 rounded-lg shadow-xl border p-2.5 w-64 space-y-2`}
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
      onClick={(e) => e.stopPropagation()}>
      {(
        <>
          {/* One compact row: cadence toggle + every-N stepper (no unit word
              — the toggle IS the unit; the hint line spells it out below) */}
          <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
            <button onClick={() => setKind("weekly")} className={chip(kind === "weekly")} style={chipStyle(kind === "weekly")}>weekly</button>
            <button onClick={() => setKind("monthly")} className={chip(kind === "monthly")} style={chipStyle(kind === "monthly")}>monthly</button>
            <button onClick={() => setKind("interval")} className={chip(kind === "interval")} style={chipStyle(kind === "interval")}
              title="Measured from the last time it was done — wakes in the weekly review instead of spawning on a date">interval</button>
            <span className="ml-auto">every</span>
            <button onClick={() => setEvery(Math.max(1, clampedEvery - 1))}
              className="px-1.5 rounded" style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>−</button>
            <input type="number" min={1} max={everyMax} value={clampedEvery}
              onChange={(e) => setEvery(parseInt(e.target.value || "1", 10))}
              className="w-8 px-0.5 py-0.5 rounded text-center"
              style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
            <button onClick={() => setEvery(Math.min(everyMax, clampedEvery + 1))}
              className="px-1.5 rounded" style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>＋</button>
            {kind === "interval" && <span>{intUnit === "w" ? "wk" : "d"}</span>}
          </div>
          {kind === "weekly" && (
            <>
              <div className="flex gap-0.5">
                {WDAY_LABELS.map((label, i) => (
                  <button key={label}
                    onClick={() => setWeekdays((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort())}
                    className={`flex-1 py-0.5 rounded text-[9px] font-medium ${weekdays.includes(i) ? "bg-blue-600 text-white" : ""}`}
                    style={weekdays.includes(i) ? undefined : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                    {label.slice(0, 2)}
                  </button>
                ))}
              </div>
              <p className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                {choice ? repeatTooltip(repeatString(choice)).replace(/^Repeats /, "") : ""}
              </p>
            </>
          )}
          {kind === "monthly" && (
            <>
              <div className="grid grid-cols-7 gap-0.5">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <button key={day} onClick={() => setMonthDay(day)}
                    className={`py-0.5 rounded text-[9px] ${monthDay === day ? "bg-blue-600 text-white font-bold" : ""}`}
                    style={monthDay === day ? undefined : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                    {day}
                  </button>
                ))}
              </div>
              <p className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                {monthDay && choice
                  ? `${repeatTooltip(repeatString(choice)).replace(/^Repeats /, "")} (short months clamp)`
                  : "Pick a day of the month"}
              </p>
            </>
          )}
          {kind === "interval" && (
            <>
              <input type="text" value={nextAction} onChange={(e) => setNextAction(e.target.value)}
                placeholder="first action — e.g. propose a date to X (required)"
                className="w-full text-[10px] px-2 py-1 rounded outline-none focus:ring-1 focus:ring-blue-400"
                style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
              <p className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                Counts from the last time it was done. Wakes in the weekly
                review — no date, nothing pings; each copy starts with the
                first action above.
              </p>
            </>
          )}
          <button onClick={() => result && onSave(result)} disabled={!result || !changed}
            className="w-full py-1 rounded text-[10px] font-medium text-white disabled:opacity-40"
            style={{ background: "var(--accent)" }}>
            {template ? "Change schedule" : "Repeat"}
          </button>
        </>
      )}
      {template && (
        <div className="flex gap-1 pt-0.5 border-t" style={{ borderColor: "var(--border)" }}>
          {onPause && (
            <button onClick={onPause} className="flex-1 py-0.5 rounded text-[9px]"
              style={{ background: "var(--bg-tertiary)", color: template.state === "paused" ? "#b45309" : "var(--text-secondary)" }}
              title={template.state === "paused" ? "Paused — spawns nothing. Resume it." : "Pause — spawns nothing until resumed"}>
              {template.state === "paused" ? "resume" : "pause"}
            </button>
          )}
          {onStop && (
            <button onClick={onStop} className="flex-1 py-0.5 rounded text-[9px]"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
              title="Stop repeating — this copy stays an ordinary task; history is kept">
              stop repeating
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function emptyTemplate(prefill?: Partial<RecurrenceTemplate>): RecurrenceTemplate {
  return {
    id: "", title: "", repeat: "", size: "", group: "", next_action: "",
    note: "", state: "active", created: "", spawned: "", last_done: "",
    missed: 0, deferred: "", extra: [],
    ...(prefill || {}),
  };
}
