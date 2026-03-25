import { useEffect, useState } from "react";
import { api, type MemoryResponse } from "../api";

export default function Dashboard() {
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getMemory()
      .then(setMemory)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="py-12 text-center text-gray-400">Loading...</div>;
  }

  if (!memory) {
    return (
      <div className="py-12 text-center text-gray-400">
        Could not load memory data.
      </div>
    );
  }

  const maxScore = 5;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">
        Pillar Balance
      </h2>

      {/* Bar chart */}
      <div className="space-y-3">
        {memory.pillar_balance.map((pillar) => (
          <div key={pillar.name}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-700">{pillar.name}</span>
              <span className="text-gray-500 font-mono">
                {pillar.score}/{maxScore}
              </span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${(pillar.score / maxScore) * 100}%`,
                  backgroundColor:
                    pillar.score <= 2
                      ? "#ef4444"
                      : pillar.score <= 3
                        ? "#f59e0b"
                        : "#22c55e",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Patterns */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Patterns & Traps
        </h3>
        <ul className="space-y-1">
          {memory.patterns.map((p, i) => (
            <li key={i} className="text-sm text-gray-600 flex items-start gap-2">
              <span className="text-amber-500 mt-0.5">!</span>
              {p}
            </li>
          ))}
        </ul>
      </div>

      {/* Goals */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">
          Long Term Goals
        </h3>
        <ul className="space-y-1">
          {memory.goals.map((g, i) => (
            <li key={i} className="text-sm text-gray-600 flex items-start gap-2">
              <span className="text-blue-500 mt-0.5">*</span>
              {g}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
