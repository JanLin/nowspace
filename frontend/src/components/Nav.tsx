import React from "react";

type View = "week" | "bucket" | "slate" | "notes" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

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
  const tabs: { id: View; icon: string; name: string }[] = [
    { id: "week", icon: "📅", name: "Plan" },
    { id: "bucket", icon: "🪣", name: "Bucket" },
    // The Slate has no tab — it opens from the Nowspace logo (App.tsx),
    // keeping the ambient surface out of the working navigation.
    { id: "notes", icon: "📝", name: "Notes" },
    { id: "habits", icon: "🌱", name: "Habits" },
    { id: "time", icon: "⏱", name: "Time" },
    // Coach + Dashboard are parked (hidden even with an API key configured);
    // re-enable by restoring their entries here and the panels in App.tsx:
    // { id: "coaching", icon: "🧭", name: "Coach" },
    // { id: "dashboard", icon: "📊", name: "Dashboard" },
    { id: "settings", icon: "⚙️", name: "Settings" },
  ];

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
              <span className="text-[9px] leading-none sm:hidden" style={{ color: "var(--text-secondary)" }}>Search</span>
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
            <span className="text-[9px] leading-none sm:hidden" style={{ color: "var(--text-secondary)" }}>{tab.name}</span>
          </span>
        </button>
        </React.Fragment>
      ))}
    </nav>
  );
}
