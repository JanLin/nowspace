type View = "week" | "bucket" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

export default function Nav({
  current,
  onChange,
  hideCoach = false,
}: {
  current: View;
  onChange: (v: View) => void;
  hideCoach?: boolean;
}) {
  const tabs: { id: View; icon: string; name: string }[] = [
    { id: "week", icon: "📅", name: "Plan" },
    { id: "bucket", icon: "🪣", name: "Bucket" },
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
        <button
          key={tab.id}
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
      ))}
    </nav>
  );
}
