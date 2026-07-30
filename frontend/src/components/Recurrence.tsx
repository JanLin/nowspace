import { useEffect, useState } from "react";
import { api, type RecurrenceTemplate } from "../api";
import { ModalShell } from "./Funnel";

/* Recurring task templates — managed from the Bucket tab.

   Tone rules, from the brief and the philosophy: templates carry no streaks
   and no visible miss counts (misses surface once, in the weekly review, as
   a question about the cadence). The creation gate refuses — size always,
   a coordination step for interval templates — and never warns. */

export const REPEAT_HINT = 'e.g. "monthly on 25", "weekly on mon", "2-weekly on thu", "every 6w"';

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

/** The per-task repeat popover: weekly with clickable days (none = "comes
    up as n that week") or monthly with a clickable day grid. When editing
    an existing template it also offers pause/resume and stop. Absolutely
    positioned — render inside a `relative` anchor. */
export function RepeatPopover({ template, onSave, onPause, onStop, onClose }: {
  template?: RecurrenceTemplate | null; // null/undefined = creating
  onSave: (choice: RepeatChoice) => void;
  onPause?: () => void; // toggles pause/resume when editing
  onStop?: () => void;  // retire; the task stays as an ordinary task
  onClose: () => void;
}) {
  const existing = template ? parseRepeatChoice(template.repeat) : null;
  const interval = template ? isIntervalRepeat(template.repeat) : false;
  const [kind, setKind] = useState<"weekly" | "monthly">(existing?.kind === "monthly" ? "monthly" : "weekly");
  const [weekdays, setWeekdays] = useState<number[]>(existing?.kind === "weekly" ? existing.weekdays : []);
  const [monthDay, setMonthDay] = useState<number>(existing?.kind === "monthly" ? existing.day : 0);
  const [every, setEvery] = useState<number>(existing?.every || 1);
  const everyMax = kind === "weekly" ? 52 : 12;
  const clampedEvery = Math.max(1, Math.min(everyMax, every || 1));

  const choice: RepeatChoice | null =
    kind === "weekly"
      ? { kind: "weekly", weekdays, every: clampedEvery }
      : monthDay ? { kind: "monthly", day: monthDay, every: clampedEvery } : null;
  const changed = !existing || !template || (choice && repeatString(choice) !== template.repeat.trim().toLowerCase());

  const chip = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${active ? "bg-blue-600 text-white" : ""}`;
  const chipStyle = (active: boolean) =>
    active ? undefined : ({ background: "var(--bg-tertiary)", color: "var(--text-secondary)" } as const);

  return (
    <div className="absolute top-6 right-0 z-40 rounded-lg shadow-xl border p-2.5 w-60 space-y-2"
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
      onClick={(e) => e.stopPropagation()}>
      {interval ? (
        <p className="text-[10px]" style={{ color: "var(--text-secondary)" }}>
          {repeatTooltip(template!.repeat)}. Edit interval schedules from ↻ Recurring in the toolbar.
        </p>
      ) : (
        <>
          <div className="flex gap-1">
            <button onClick={() => setKind("weekly")} className={chip(kind === "weekly")} style={chipStyle(kind === "weekly")}>weekly</button>
            <button onClick={() => setKind("monthly")} className={chip(kind === "monthly")} style={chipStyle(kind === "monthly")}>monthly</button>
          </div>
          {/* Cadence: every N weeks/months. − and + because number-input
              spinners are fiddly at this size; the value is also typeable. */}
          <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
            <span>every</span>
            <button onClick={() => setEvery(Math.max(1, clampedEvery - 1))}
              className="px-1.5 rounded" style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>−</button>
            <input type="number" min={1} max={everyMax} value={clampedEvery}
              onChange={(e) => setEvery(parseInt(e.target.value || "1", 10))}
              className="w-10 px-1 py-0.5 rounded text-center"
              style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
            <button onClick={() => setEvery(Math.min(everyMax, clampedEvery + 1))}
              className="px-1.5 rounded" style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>＋</button>
            <span>{kind === "weekly" ? (clampedEvery === 1 ? "week" : "weeks") : (clampedEvery === 1 ? "month" : "months")}</span>
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
          <button onClick={() => choice && onSave(choice)} disabled={!choice || !changed}
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
      <button onClick={onClose} className="w-full py-0.5 rounded text-[9px]"
        style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }}>
        close
      </button>
    </div>
  );
}

/** "monthly on 25" → next occurrence as a quiet display string. Not used for
    scheduling — the backend owns spawning; this only helps while editing. */
export function describeRepeat(repeat: string): string {
  const r = repeat.trim().toLowerCase();
  if (isIntervalRepeat(r)) return "wakes in the weekly review when the interval has passed";
  if (parseRepeatChoice(r)) return "spawns one copy at a time, on schedule";
  return "";
}

export function emptyTemplate(prefill?: Partial<RecurrenceTemplate>): RecurrenceTemplate {
  return {
    id: "", title: "", repeat: "", size: "", group: "", next_action: "",
    note: "", state: "active", created: "", spawned: "", last_done: "",
    missed: 0, deferred: "", extra: [],
    ...(prefill || {}),
  };
}

export default function RecurrenceModal({ onClose, prefill, groups }: {
  onClose: () => void;
  /** Prefill for "make this item recurring" — opens with a new template row. */
  prefill?: Partial<RecurrenceTemplate> | null;
  groups: string[];
}) {
  const [rows, setRows] = useState<RecurrenceTemplate[]>([]);
  const [mtime, setMtime] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  const load = () => {
    api.getRecurrence().then((r) => {
      const rows = r.templates;
      if (prefill) rows.push(emptyTemplate(prefill));
      setRows(rows);
      setMtime(r.mtime);
      setLoaded(true);
      setDirty(!!prefill);
      setError("");
    }).catch((e) => setError(e instanceof Error ? e.message : "Failed to load templates"));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const update = (i: number, patch: Partial<RecurrenceTemplate>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.saveRecurrence(rows.filter((r) => r.title.trim() || r.id), mtime);
      setMtime(res.mtime);
      setDirty(false);
      setError("");
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      if (msg.includes("changed on disk")) {
        setError("Templates changed on another device — reloaded, redo your edit.");
        load();
      } else {
        setError(msg);
      }
    }
    setSaving(false);
  };

  const active = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state !== "retired");
  const retired = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state === "retired");

  const input = "px-2 py-1 rounded text-xs";
  const inputStyle = { background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" } as const;

  return (
    <ModalShell onClose={onClose} wide>
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>↻ Recurring tasks</h3>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
            If missing it creates debt someone can collect, it's a recurring task.
            If missing it only breaks a pattern, it's a habit — put it in 🌱 Habits instead.
          </p>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!loaded && !error && <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Loading…</p>}

        {loaded && active.length === 0 && (
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Nothing repeats yet. A template places one copy at a time into Ready —
            there is never a pile.
          </p>
        )}

        {active.map(({ r, i }) => {
          const interval = isIntervalRepeat(r.repeat);
          return (
            <div key={r.id || `new-${i}`} className="rounded-lg p-2.5 space-y-1.5"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              <div className="flex flex-wrap items-center gap-1.5">
                <input type="text" value={r.title} placeholder="what repeats"
                  onChange={(e) => update(i, { title: e.target.value })}
                  className={`${input} flex-1 min-w-[10rem] font-medium`} style={inputStyle} />
                <select value={r.size} onChange={(e) => update(i, { size: e.target.value })}
                  className={input} style={inputStyle}
                  title="Optional — sized copies spawn Ready; unsized ones arrive Captured and take the one-tap size later">
                  <option value="">no size</option>
                  <option value="s">s</option><option value="m">m</option><option value="l">l</option>
                </select>
                <select value={groups.includes(r.group) ? r.group : ""}
                  onChange={(e) => update(i, { group: e.target.value })}
                  className={input} style={inputStyle} title="Bucket group its copies appear under">
                  <option value="">no group</option>
                  {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <input type="text" value={r.repeat} placeholder={REPEAT_HINT}
                  onChange={(e) => update(i, { repeat: e.target.value })}
                  className={`${input} w-52`} style={inputStyle} />
                <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                  {describeRepeat(r.repeat)}
                </span>
              </div>
              <input type="text" value={r.next_action}
                placeholder={interval ? "first action — e.g. propose a date to X (required)" : "first action (optional — the task is its own next action)"}
                onChange={(e) => update(i, { next_action: e.target.value })}
                className={`${input} w-full`} style={inputStyle} />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>📄</span>
                <input type="text" value={r.note} placeholder="note that explains how (optional)"
                  onChange={(e) => update(i, { note: e.target.value })}
                  className={`${input} flex-1 min-w-[8rem]`} style={inputStyle} />
                {interval && r.last_done && (
                  <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}
                    title="Intervals count from the last time it actually happened">
                    last done {r.last_done}
                  </span>
                )}
                <button onClick={() => update(i, { state: r.state === "paused" ? "active" : "paused" })}
                  className="text-[9px] px-1.5 py-0.5 rounded"
                  style={{ background: "var(--bg-tertiary)", color: r.state === "paused" ? "#b45309" : "var(--text-secondary)" }}
                  title={r.state === "paused" ? "Paused — spawns nothing, surfaces nowhere. Click to resume." : "Pause — spawns nothing until resumed"}>
                  {r.state === "paused" ? "paused ⏸ — resume" : "pause"}
                </button>
                <button onClick={() => update(i, { state: "retired" })}
                  className="text-[9px] px-1.5 py-0.5 rounded"
                  style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                  title="The obligation is over. Completed copies stay done, in place.">
                  retire
                </button>
              </div>
            </div>
          );
        })}

        <div className="flex items-center gap-2">
          <button onClick={() => { setRows((p) => [...p, emptyTemplate()]); setDirty(true); }}
            className="text-[10px] px-2 py-1 rounded"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
            + New template
          </button>
          {retired.length > 0 && (
            <button onClick={() => setShowRetired(!showRetired)}
              className="text-[10px] px-2 py-1 rounded"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }}>
              {showRetired ? "hide" : "show"} retired ({retired.length})
            </button>
          )}
        </div>

        {showRetired && retired.map(({ r, i }) => (
          <div key={r.id || i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-tertiary)" }}>
            <span className="flex-1">{r.title} · {r.repeat}</span>
            <button onClick={() => update(i, { state: "active" })}
              className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
              reactivate
            </button>
          </div>
        ))}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
            {dirty ? "Cancel" : "Close"}
          </button>
          {dirty && (
            <button onClick={save} disabled={saving}
              className="text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "var(--accent)" }}>
              {saving ? "Saving…" : "Save templates"}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
