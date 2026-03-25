import { useState, useEffect } from "react";
import { api } from "../api";

export default function Goals() {
  const [goals, setGoals] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchGoals = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getGoals();
      setGoals(data.goals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch goals");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGoals();
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Weekly Goals</h2>
        <button
          onClick={fetchGoals}
          disabled={loading}
          className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <p className="text-xs text-gray-400">
        Work goals that guide weekday prioritisation
      </p>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {goals.length > 0 ? (
        <div className="space-y-1">
          {goals.map((goal, i) => (
            <div
              key={i}
              className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-50 text-sm"
            >
              <span className="text-blue-500 mt-0.5 shrink-0">&#9679;</span>
              <span className="text-gray-900">{goal}</span>
            </div>
          ))}
        </div>
      ) : (
        !loading && (
          <div className="py-8 text-center text-gray-400 text-sm">
            No goals set for this week
          </div>
        )
      )}
    </div>
  );
}
