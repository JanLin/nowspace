type View = "week" | "goals" | "coaching" | "dashboard";

export default function Nav({
  current,
  onChange,
}: {
  current: View;
  onChange: (v: View) => void;
}) {
  const tabs: { id: View; label: string }[] = [
    { id: "week", label: "Plan" },
    { id: "goals", label: "Goals" },
    { id: "coaching", label: "Coaching" },
    { id: "dashboard", label: "Dashboard" },
  ];

  return (
    <nav className="flex gap-1 bg-gray-50 p-1 rounded-lg">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            current === tab.id
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
