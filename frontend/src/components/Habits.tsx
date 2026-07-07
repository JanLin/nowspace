import { useEffect, useState } from "react";
import { api } from "../api";
import type { Habit } from "../api";
import { habitDomainStyle } from "./HabitStrip";

/* The registration of habits you've built — a calm, read-mostly view.
   Logging happens via the habit strip in the week view; this tab shows
   this week's progress, an 8-week history, and "established" badges.
   Tone rules: celebrate weeks met, never count weeks missed. */

const DOMAIN_ORDER = ["body", "mind", "soul", "sleep"];
const DOMAIN_TITLES: Record<string, string> = {
  body: "Body", mind: "Mind", soul: "Soul", sleep: "Sleep",
};

export default function Habits() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [found, setFound] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    api.getHabits().then((r) => { setFound(r.found); setHabits(r.habits); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load habits"));
  };

  useEffect(() => {
    load();
    window.addEventListener("week-changed", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("week-changed", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  const createStarter = async () => {
    setCreating(true);
    try { await api.initHabits(); load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to create Habits.md"); }
    setCreating(false);
  };

  if (found === null) return <p className="text-center py-8 text-sm" style={{ color: "var(--text-tertiary)" }}>Loading…</p>;

  if (!found) {
    return (
      <div className="max-w-lg mx-auto text-center space-y-4 py-10">
        <div className="text-4xl">🌱</div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--text)" }}>Habits</h2>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Gentle weekly practices for body, mind, soul and sleep. Habits appear as
          small chips above your day — tap one when you've done it, and the strip
          shrinks as your week goes well. Nothing nags, nothing turns red.
        </p>
        <button
          onClick={createStarter}
          disabled={creating}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {creating ? "Creating…" : "Create my starter set"}
        </button>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Creates <span className="font-mono">Habits.md</span> in your vault — edit it freely in Obsidian.
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  const byDomain = new Map<string, Habit[]>();
  habits.forEach((h) => byDomain.set(h.domain, [...(byDomain.get(h.domain) || []), h]));
  const domains = [
    ...DOMAIN_ORDER.filter((d) => byDomain.has(d)),
    ...[...byDomain.keys()].filter((d) => !DOMAIN_ORDER.includes(d)).sort(),
  ];

  const weekDots = (h: Habit) => {
    const total = h.period === "day" ? 7 : h.target;
    const done = h.period === "day" ? h.days_done : Math.min(h.week_count, total);
    return "●".repeat(done) + "○".repeat(Math.max(0, total - done));
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Log habits from the chips above your day. Edit definitions in{" "}
          <span className="font-mono">Habits.md</span> — this page just remembers what you've built.
        </p>
        <button onClick={load} className="text-[10px] px-2 py-1 rounded"
          style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
          Refresh
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}

      {domains.map((d) => {
        const { icon, color } = habitDomainStyle(d);
        return (
          <section key={d} className="space-y-2">
            <h2 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--text)" }}>
              <span>{icon}</span> {DOMAIN_TITLES[d] || d.charAt(0).toUpperCase() + d.slice(1)}
            </h2>
            <div className="space-y-1.5">
              {(byDomain.get(d) || []).map((h) => (
                <div key={h.name} className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
                  style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)", boxShadow: `inset 2px 0 0 ${color}` }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: "var(--text)" }}>{h.name}</span>
                      {h.established && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                          established ✓
                        </span>
                      )}
                      {h.morning && <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>morning</span>}
                    </div>
                    {h.variants.length > 0 && (
                      <div className="text-[10px] truncate" style={{ color: "var(--text-tertiary)" }}>
                        {h.variants.join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-mono tracking-wider" style={{ color }}>
                      {weekDots(h)}
                      <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>
                        {h.period === "day" ? `${h.days_done}/7 days` : `${h.week_count}/${h.target} this week`}
                      </span>
                    </div>
                    {h.history.length > 0 && (
                      <div className="text-[10px] font-mono mt-0.5" title={`${h.history.filter(Boolean).length} of the last ${h.history.length} weeks`}
                        style={{ color: "var(--text-tertiary)" }}>
                        {h.history.map((m, i) => <span key={i} style={m ? { color } : undefined}>{m ? "▓" : "░"}</span>)}
                        <span className="ml-1.5">{h.history.filter(Boolean).length} of last {h.history.length} wks</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
