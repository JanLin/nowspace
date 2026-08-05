import React from "react";
import { surfaces, surfaceEnabled } from "../surfaces";
import { useAddonSettings } from "../appMode";

/** A registered surface's id widens this, so it is a string rather than the
 *  union it used to be. The built-in ids are still the only ones the baseline
 *  itself switches on. */
type View = string;

/** Where the built-ins sit, so a registered surface can ask for a place
 *  between two of them (25 → after Bucket, before Notes). Settings stays at
 *  the end; an extension asking for 100 still lands before it, because the
 *  sort is stable and Settings is appended last. */
const BUILT_IN_ORDER = { week: 10, bucket: 20, notes: 30, habits: 40, time: 50, settings: 90 } as const;

export default function Nav({
  current,
  onChange,
  hideCoach = false,
  onSearch,
}: {
  current: View;
  onChange: (v: View) => void;
  hideCoach?: boolean;
  /** Search sits inside the bar, just before Settings — the header's right
      edge had run out of room on a 360px phone. */
  onSearch?: () => void;
}) {
  const addonSettings = useAddonSettings();

  const builtIn: { id: View; icon: string; name: string; order: number }[] = [
    { id: "week", icon: "📅", name: "Plan", order: BUILT_IN_ORDER.week },
    { id: "bucket", icon: "🪣", name: "Bucket", order: BUILT_IN_ORDER.bucket },
    // The Slate has no tab — it opens from the Nowspace logo (App.tsx),
    // keeping the ambient surface out of the working navigation.
    { id: "notes", icon: "📝", name: "Notes", order: BUILT_IN_ORDER.notes },
    { id: "habits", icon: "🌱", name: "Habits", order: BUILT_IN_ORDER.habits },
    { id: "time", icon: "⏱", name: "Time", order: BUILT_IN_ORDER.time },
    // Coach + Dashboard are parked (hidden even with an API key configured);
    // re-enable by restoring their entries here and the panels in App.tsx:
    // { id: "coaching", icon: "🧭", name: "Coach", order: 60 },
    // { id: "dashboard", icon: "📊", name: "Dashboard", order: 70 },
    { id: "settings", icon: "⚙️", name: "Settings", order: BUILT_IN_ORDER.settings },
  ];

  // Registered surfaces whose switch is on. Empty in the baseline, which is
  // why every one of these lines is a no-op until an extension is installed.
  const extra = surfaces()
    .filter((s) => surfaceEnabled(s, addonSettings))
    .map((s) => ({ id: s.id as View, icon: s.icon, name: s.name, order: s.order ?? 80 }));

  const tabs = [...builtIn, ...extra].sort((a, b) => a.order - b.order);

  return (
    <nav className="flex flex-1 gap-1 p-1 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
      {tabs.filter((tab) => !(hideCoach && (tab.id === "coaching" || tab.id === "dashboard"))).map((tab) => (
        <React.Fragment key={`slot-${tab.id}`}>
        {tab.id === "settings" && onSearch && (
          <button
            onClick={onSearch}
            title="Search tasks — Plan week + Bucket (⌘K)"
            aria-label="Search tasks"
            className="flex-1 py-1 sm:py-2 px-1 sm:px-2 rounded-md leading-none transition-all opacity-60 hover:opacity-100"
          >
            <span className="flex flex-col items-center gap-0.5">
              <span className="text-base leading-none">🔍</span>
              <span className="nav-label text-[9px] leading-none sm:hidden" style={{ color: "var(--text-secondary)" }}>Search</span>
            </span>
          </button>
        )}
        <button
          data-tour={tab.id}
          onClick={() => onChange(tab.id)}
          title={tab.name}
          aria-label={tab.name}
          aria-current={current === tab.id ? "page" : undefined}
          className={`flex-1 py-1 sm:py-2 px-1 sm:px-2 rounded-md leading-none transition-all ${
            current === tab.id ? "" : "opacity-60 hover:opacity-100"
          }`}
          style={
            current === tab.id
              ? { backgroundColor: "var(--accent-bg)", boxShadow: "inset 0 0 0 2px var(--accent)" }
              : undefined
          }
        >
          <span className="flex flex-col items-center gap-0.5">
            <span className="text-base leading-none">{tab.icon}</span>
            <span className="nav-label text-[9px] leading-none sm:hidden" style={{ color: "var(--text-secondary)" }}>{tab.name}</span>
          </span>
        </button>
        </React.Fragment>
      ))}
    </nav>
  );
}
