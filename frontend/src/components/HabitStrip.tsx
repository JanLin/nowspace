import { useState } from "react";
import { api, type Habit } from "../api";
import { normTime, shiftTime, nowHHMM } from "../timefmt";

export interface HabitTime { start: string; minutes: number }

/* Gentle habit chips shown above the day/grid views.
   Rules: no unchecked tasks, no red, no overdue state. A chip only exists
   while there is something left to do this week — the strip shrinks as the
   week goes well. Established habits stay as a tiny ✓ chip so logging never
   needs a tab switch. */

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
  onLog,
  onOpenNote,
  compact = false,
}: {
  habits: Habit[];
  onLog: (habit: Habit, variant?: string, time?: HabitTime) => void;
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

  const remaining = (h: Habit) =>
    h.period === "day" ? h.today_count === 0 : h.week_count < h.target;

  // Established habits always keep a tiny chip; others only while below target.
  const visible = habits
    .filter((h) => h.established || remaining(h))
    .sort((a, b) => (b.morning ? 1 : 0) - (a.morning ? 1 : 0));

  if (visible.length === 0) return null;

  const handleTap = (h: Habit) => {
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
        const doneToday = h.today_count > 0;
        const atTarget = !remaining(h);
        const tiny = h.established && atTarget;
        return (
          <div key={h.name} className="relative flex items-center">
            <button
              onClick={() => handleTap(h)}
              title={
                h.period === "day"
                  ? `${h.name} — daily${doneToday ? " · done today ✓" : ""}`
                  : `${h.name} — ${h.week_count}/${h.target} this week${h.morning ? " · morning" : ""}`
              }
              className={`flex items-center gap-1 rounded-full border transition-colors ${
                compact || tiny ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]"
              } ${doneToday || atTarget ? "opacity-50" : "hover:opacity-80"}`}
              style={{
                borderColor: color,
                color,
                backgroundColor: "var(--bg)",
              }}
            >
              <span>{tiny ? "✓" : icon}</span>
              {!tiny && <span className="font-medium">{h.name}</span>}
              {tiny && <span className="font-medium">{h.name}</span>}
              {!tiny && h.period === "week" && (
                <span className="opacity-70">{h.week_count}/{h.target}</span>
              )}
              {h.note && onOpenNote && !tiny && (
                <HabitNoteLink note={h.note} onOpenNote={onOpenNote} />
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
