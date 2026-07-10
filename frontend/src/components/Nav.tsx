type View = "week" | "bucket" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

export default function Nav({
  current,
  onChange,
}: {
  current: View;
  onChange: (v: View) => void;
}) {
  const tabs: { id: View; icon: string; name: string }[] = [
    { id: "week", icon: "📅", name: "Plan" },
    { id: "bucket", icon: "🪣", name: "Bucket" },
    { id: "habits", icon: "🌱", name: "Habits" },
    { id: "time", icon: "⏱", name: "Time" },
    { id: "coaching", icon: "🧭", name: "Coach" },
    { id: "dashboard", icon: "📊", name: "Dashboard" },
    { id: "settings", icon: "⚙️", name: "Settings" },
  ];

  return (
    <nav className="flex flex-1 gap-1 p-1 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          title={tab.name}
          aria-label={tab.name}
          aria-current={current === tab.id ? "page" : undefined}
          className={`flex-1 py-1.5 sm:py-2 px-2 rounded-md text-base leading-none transition-all ${
            current === tab.id ? "" : "opacity-55 hover:opacity-100 grayscale hover:grayscale-0"
          }`}
          style={
            current === tab.id
              ? { backgroundColor: "var(--accent-bg)", boxShadow: "inset 0 0 0 2px var(--accent)" }
              : undefined
          }
        >
          {tab.icon}
        </button>
      ))}
    </nav>
  );
}
