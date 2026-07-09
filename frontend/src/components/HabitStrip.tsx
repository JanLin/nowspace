import { useState } from "react";
import type { Habit } from "../api";

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

export default function HabitStrip({
  habits,
  onLog,
  compact = false,
}: {
  habits: Habit[];
  onLog: (habit: Habit, variant?: string) => void;
  compact?: boolean;
}) {
  const [pickerFor, setPickerFor] = useState<string | null>(null);

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
      onLog(h);
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
          <div key={h.name} className="relative">
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
            </button>
            {pickerFor === h.name && (
              <div
                className="absolute left-0 top-full mt-1 z-30 flex gap-1 rounded-lg shadow-lg border p-1"
                style={{ backgroundColor: "var(--card)", borderColor: "var(--card-border)" }}
              >
                {h.variants.map((v) => (
                  <button
                    key={v}
                    onClick={() => { setPickerFor(null); onLog(h, v); }}
                    className="px-2 py-0.5 rounded text-[10px] font-medium hover:opacity-80"
                    style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text)" }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
