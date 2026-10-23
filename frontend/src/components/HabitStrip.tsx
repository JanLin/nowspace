import { useState } from "react";
import { api, type Habit } from "../api";
import { normTime, shiftTime, nowHHMM } from "../timefmt";

export interface HabitTime { start: string; minutes: number }

/* Gentle habit chips shown above the day/grid views.
   Rules: no unchecked tasks, no red, no overdue state. The strip shrinks as
   the week goes well: a weekly habit that has met its target folds to a tiny
   ✓ chip instead of vanishing, so a sixth run on a 5x/week habit is still one
   tap — and the count shows 6/5, never clamped. A daily habit done today
   leaves the strip; established ones keep the tiny chip. Paused habits are
   not here at all. */

/** The one green on the strip: a week's target reached. It only ever
 *  fills a chip — the border and the text stay the habit's own domain
 *  colour, which is what tells one group of habits from another. */
const MET_GREEN = "#10b981";

export const HABIT_DOMAIN: Record<string, { icon: string; color: string }> = {
  body: { icon: "💪", color: "#f97316" },
  mind: { icon: "🧠", color: "#0ea5e9" },
  soul: { icon: "🌿", color: "#10b981" },
  sleep: { icon: "😴", color: "#6366f1" },
};

export function habitDomainStyle(domain: string) {
  return HABIT_DOMAIN[domain] || { icon: "🌱", color: "#9ca3af" };
}

/** The note that explains how — reference material, nothing more. Shown
    wherever the habit is; resolves on tap so a note synced in moments ago
    still opens. A span, not a button, so it can live INSIDE the habit
    chip's button without invalid nesting. */
export function HabitNoteLink({ note, onOpenNote }: {
  note: string;
  onOpenNote: (path: string, name: string) => void;
}) {
  const name = note.split("|")[0].split("#")[0].trim();
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        api.vaultResolve(name).then((res) => {
          if (res.path) onOpenNote(res.path, res.name || name);
        }).catch(() => {});
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).click(); }}
      className="px-0.5 text-[10px] opacity-60 hover:opacity-100 cursor-pointer"
      title={`Open ${name}`}
    >
      📄
    </span>
  );
}

export default function HabitStrip({
  habits,
  dayIdx,
  onLog,
  onUnlog,
  onOpenNote,
  compact = false,
}: {
  habits: Habit[];
  //: Which day the strip is about — the one open in the day view. Every
  //: tick, every colour and every undo here belongs to this day.
  dayIdx: number;
  onLog: (habit: Habit, variant?: string, time?: HabitTime) => void;
  //: Takes back today's last log. Tapping the chip must stay "I did it
  //: again", so undo is its own small control rather than a second meaning
  //: for the same press.
  onUnlog?: (habit: Habit) => void;
  onOpenNote?: (path: string, name: string) => void;
  compact?: boolean;
}) {
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  // Timed habits confirm duration + start on completion (feeds the time log)
  const [timeFor, setTimeFor] = useState<{ habit: Habit; variant?: string } | null>(null);
  const [timeMinutes, setTimeMinutes] = useState("30");
  const [timeStart, setTimeStart] = useState("");
  const [timeErr, setTimeErr] = useState("");

  const beginLog = (habit: Habit, variant?: string) => {
    if (habit.duration > 0) {
      setTimeMinutes(String(habit.duration));
      setTimeStart(shiftTime(nowHHMM(), -habit.duration));
      setTimeErr("");
      setTimeFor({ habit, variant });
    } else {
      onLog(habit, variant);
    }
  };

  const confirmTimed = (withTime: boolean) => {
    if (!timeFor) return;
    if (!withTime) { onLog(timeFor.habit, timeFor.variant); setTimeFor(null); return; }
    const start = normTime(timeStart);
    const minutes = parseInt(timeMinutes, 10);
    if (!start || !minutes || minutes <= 0) {
      setTimeErr("start like 1945 or 19:45, minutes > 0");
      return;
    }
    onLog(timeFor.habit, timeFor.variant, { start, minutes });
    setTimeFor(null);
  };

  /** How many times this habit was done on the day being looked at. */
  const onDay = (h: Habit) => h.week_days?.[dayIdx] ?? 0;
  /** The week's target is reached — the thing worth celebrating, and the
   *  only green on the strip. */
  const weekMet = (h: Habit) =>
    h.period === "day" ? h.days_done >= (h.week_goal || 5) : h.week_count >= h.target;
  // Every habit that isn't paused keeps its chip. It used to vanish once
  // done, which only made sense while the strip was about today and there
  // was nothing left to do with it; now that a chip means "this day", one
  // that disappears would hide the day's answer rather than give it.
  const visible = habits
    .filter((h) => !h.paused)
    .sort((a, b) => (b.morning ? 1 : 0) - (a.morning ? 1 : 0));

  if (visible.length === 0) return null;

  const handleTap = (h: Habit) => {
    // A daily habit already done on this day takes no more taps — one a day
    // is its whole meaning, and tapping twice was how it got double-counted.
    // The undo beside it is the way back. A weekly habit keeps counting:
    // a second session on one day really is two towards 3x/week.
    if (h.period === "day" && onDay(h) > 0) return;
    if (h.variants.length > 0) {
      setPickerFor(pickerFor === h.name ? null : h.name);
    } else {
      beginLog(h);
    }
  };

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${compact ? "" : "px-1"}`}>
      {visible.map((h) => {
        const { icon, color } = habitDomainStyle(h.domain);
        const dayCount = onDay(h);
        const doneThisDay = dayCount > 0;
        const met = weekMet(h);
        return (
          <div key={h.name} className="relative flex items-center">
            <button
              onClick={() => handleTap(h)}
              title={
                (h.period === "day"
                  ? `${h.name} — daily`
                  : `${h.name} — ${h.week_count}/${h.target} this week${h.morning ? " · morning" : ""}`)
                + (doneThisDay ? ` · done this day ✓${dayCount > 1 ? ` (${dayCount}×)` : ""}` : " · not done this day")
                + (met ? " · week's target reached" : "")
              }
              className={`flex items-center gap-1 rounded-full border transition-colors ${
                compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]"
              } ${doneThisDay || h.period === "week" ? "" : "hover:opacity-80"}`}
              style={{
                // The domain's colour is how the strip is read — body from
                // mind from soul at a glance — so the border and the text
                // keep it whatever else is true of the chip.
                borderColor: color,
                // Full strength whether or not the day is done: a faded chip
                // was unreadable at a glance, and "not done today" is exactly
                // the thing the strip exists to show.
                color,
                // The week's target reached is the one celebration here, and
                // it fills the chip rather than recolouring it — never red,
                // never a warning for the days without it.
                backgroundColor: met ? `color-mix(in srgb, ${MET_GREEN} 20%, var(--bg))` : "var(--bg)",
              }}
            >
              <span>{doneThisDay ? "✓" : icon}</span>
              <span className="font-medium">{h.name}</span>
              {h.period === "week" && (
                <span className="opacity-70">{h.week_count}/{h.target}</span>
              )}
              {h.note && onOpenNote && (
                <HabitNoteLink note={h.note} onOpenNote={onOpenNote} />
              )}
              {/* Only this day's tick can be taken back, and only from the
                  day it was made on. The same ↩ the toolbar undoes with, at
                  full strength — a faint one was the hardest thing on the
                  strip to see, and it is the control you reach for in a
                  hurry. */}
              {onUnlog && doneThisDay && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onUnlog(h); }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).click(); }}
                  className="ml-0.5 px-1 rounded text-[11px] font-bold cursor-pointer hover:opacity-80"
                  style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                  title={`Not actually done — take this day's ${h.name} back`}
                >
                  ↩
                </span>
              )}
            </button>
            {pickerFor === h.name && (
              <div
                className="absolute left-0 top-full mt-1 z-30 flex gap-1 rounded-lg shadow-lg border p-1"
                style={{ backgroundColor: "var(--card)", borderColor: "var(--card-border)" }}
              >
                {h.variants.map((v) => (
                  <button
                    key={v}
                    onClick={() => { setPickerFor(null); beginLog(h, v); }}
                    className="px-2 py-0.5 rounded text-[10px] font-medium hover:opacity-80"
                    style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text)" }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
            {timeFor?.habit.name === h.name && (
              <div
                className="absolute left-0 top-full mt-1 z-30 rounded-lg shadow-lg border p-2 space-y-1.5 min-w-[15rem]"
                style={{ backgroundColor: "var(--card)", borderColor: "var(--card-border)" }}
              >
                <div className="text-[10px] font-medium" style={{ color: "var(--text)" }}>
                  Log time for {timeFor.variant || h.name}?
                </div>
                <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>
                  <span>started</span>
                  <input value={timeStart} onChange={(e) => setTimeStart(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") confirmTimed(true); if (e.key === "Escape") setTimeFor(null); }}
                    className="w-14 px-1 py-0.5 rounded font-mono border" style={{ backgroundColor: "var(--bg)", color: "var(--text)", borderColor: "var(--border)" }} />
                  <span>for</span>
                  <input value={timeMinutes} onChange={(e) => setTimeMinutes(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") confirmTimed(true); if (e.key === "Escape") setTimeFor(null); }}
                    className="w-10 px-1 py-0.5 rounded font-mono border" style={{ backgroundColor: "var(--bg)", color: "var(--text)", borderColor: "var(--border)" }} />
                  <span>min</span>
                </div>
                {timeErr && <div className="text-[9px] text-red-500">{timeErr}</div>}
                <div className="flex gap-1">
                  <button onClick={() => confirmTimed(true)}
                    className="flex-1 px-2 py-1 rounded bg-blue-600 text-white text-[10px] font-medium hover:bg-blue-700">
                    ✓ Done + log time
                  </button>
                  <button onClick={() => confirmTimed(false)}
                    className="px-2 py-1 rounded text-[10px]" style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                    title="Mark the habit done without a time entry">
                    just done
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
