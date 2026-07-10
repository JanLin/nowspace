type View = "week" | "bucket" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

export default function Nav({
  current,
  onChange,
}: {
  current: View;
  onChange: (v: View) => void;
}) {
  const tabs: { id: View; label: string; shortLabel: string }[] = [
    { id: "week", label: "📅 Plan", shortLabel: "📅" },
    { id: "bucket", label: "🪣 Bucket", shortLabel: "🪣" },
    { id: "habits", label: "🌱 Habits", shortLabel: "🌱" },
    { id: "time", label: "⏱ Time", shortLabel: "⏱" },
    { id: "coaching", label: "🧭 Coach", shortLabel: "🧭" },
    { id: "dashboard", label: "📊 Dashboard", shortLabel: "📊" },
    { id: "settings", label: "⚙️ Settings", shortLabel: "⚙️" },
  ];

  return (
    <nav className="flex flex-1 gap-1 p-1 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className="flex-1 py-1.5 sm:py-2 px-2 sm:px-4 rounded-md text-xs sm:text-sm font-medium transition-colors"
          style={
            current === tab.id
              ? { backgroundColor: "var(--bg)", color: "var(--text)", boxShadow: "0 1px 2px var(--shadow)" }
              : { color: "var(--text-secondary)" }
          }
        >
          <span className="hidden sm:inline">{tab.label}</span>
          <span className="sm:hidden">{tab.shortLabel}</span>
        </button>
      ))}
    </nav>
  );
}
