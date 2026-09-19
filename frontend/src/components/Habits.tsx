import { useEffect, useState } from "react";
import { api } from "../api";
import type { Habit, HabitPause } from "../api";
import { HabitNoteLink, habitDomainStyle } from "./HabitStrip";
import NoteFilePicker from "./NoteFilePicker";

/* The registration of habits you've built — a calm, read-mostly view.
   Logging happens via the habit strip in the week view; this tab shows
   this week's progress, an 8-week history, and "established" badges,
   plus a simple editor for the definitions (stored in Plan Week Habits.md).
   Tone rules: celebrate weeks met, never count weeks missed. A week past its
   target shows every completion. A paused habit keeps its row and history,
   quietly, until you resume it — pausing is a choice of focus, not a lapse. */

const DOMAIN_ORDER = ["body", "mind", "soul", "sleep"];
const DOMAIN_TITLES: Record<string, string> = {
  body: "Body", mind: "Mind", soul: "Soul", sleep: "Sleep",
};

type HabitRow = {
  name: string;
  domain: string;
  variants: string; // CSV while editing
  target: number;
  period: string;
  morning: boolean;
  duration: number; // minutes per occurrence; 0 = untimed
  note: string; // wikilink target of the how-to note; "" = none
  paused: boolean;
  // Carried through untouched so a save never loses them; the backend
  // dates a pause (or a start-again) ticked here the same as the button
  paused_since: string;
  pauses: HabitPause[];
};

/** The row's progress graph: one bar per week, oldest → newest, ending with
    this week so far (outlined — it isn't over). The dashed line is where a
    week counts as met, and bars pass it freely: 6 of a 5x/week stands
    taller. A met week is full colour, any other a quiet tint — never red.
    A paused week is a dot, because it was a choice; an empty week is simply
    a gap. */
function HabitGraph({ h, color }: { h: Habit; color: string }) {
  const BAR = 5, GAP = 2, H = 18;
  const goal = Math.max(1, h.week_goal || h.target);
  const thisWeek = h.period === "day" ? h.days_done : h.week_count;
  const weeks = [
    ...h.history_counts.map((count, i) => ({
      count, met: !!h.history[i], paused: !!h.history_paused?.[i],
      label: h.history_labels?.[i] ? `wk ${Number(h.history_labels[i].split("wk")[1])}` : "", current: false,
    })),
    { count: thisWeek, met: thisWeek >= goal, paused: h.paused, label: "this week so far", current: true },
  ];
  const top = Math.max(goal, ...weeks.map((w) => w.count));
  const y = (v: number) => H - (v / top) * (H - 1);
  const width = weeks.length * (BAR + GAP) - GAP;
  const unit = h.period === "day" ? "days" : "times";
  return (
    <svg width={width} height={H} className="inline-block align-middle shrink-0" role="img"
      aria-label={`${weeks.length} weeks, one bar each; the dashed line is the goal of ${goal}`}>
      <line x1={0} x2={width} y1={y(goal)} y2={y(goal)} strokeWidth={1} strokeDasharray="2 2"
        style={{ stroke: "var(--text-tertiary)" }} />
      {weeks.map((w, i) => {
        const x = i * (BAR + GAP);
        const tip = w.paused ? `${w.label}: paused` : `${w.label}: ${w.count} ${unit} (goal ${goal})`;
        if (w.paused) {
          return (
            <circle key={i} cx={x + BAR / 2} cy={H - 1.5} r={1.2} style={{ fill: "var(--text-tertiary)" }}>
              <title>{tip}</title>
            </circle>
          );
        }
        if (w.count === 0) return null; // an empty week is a gap
        const barTop = y(w.count);
        return (
          <rect key={i} x={x} y={barTop} width={BAR} height={H - barTop} rx={1}
            fill={color} fillOpacity={w.met ? (w.current ? 0.7 : 1) : 0.3}
            stroke={w.current ? color : undefined} strokeWidth={w.current ? 0.75 : undefined}>
            <title>{tip}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** "2026-09-19" → "19 Sep", read as a local date (not UTC midnight). */
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export default function Habits({ onOpenNote }: { onOpenNote?: (path: string, name: string) => void }) {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [found, setFound] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Editor state
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<HabitRow[]>([]);
  const [savingRows, setSavingRows] = useState(false);
  const [pausing, setPausing] = useState<string | null>(null);
  // Vault note picker for the how-to note (same panel tasks use)
  const [notePicker, setNotePicker] = useState<{ idx: number; pos: { top: number; left: number } } | null>(null);

  const load = () => {
    api.getHabits().then((r) => { setFound(r.found); setHabits(r.habits); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load habits"));
  };

  useEffect(() => {
    load();
    window.addEventListener("week-changed", load);
    window.addEventListener("week-saved", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("week-changed", load);
      window.removeEventListener("week-saved", load);
      window.removeEventListener("focus", load);
    };
  }, []);

  const createStarter = async () => {
    setCreating(true);
    try { await api.initHabits(); load(); window.dispatchEvent(new CustomEvent("habits-changed")); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to create Plan Week Habits.md"); }
    setCreating(false);
  };

  const startEditing = () => {
    setRows(habits.map((h) => ({
      name: h.name, domain: h.domain, variants: h.variants.join(", "),
      target: h.period === "day" ? 1 : h.target, period: h.period, morning: h.morning,
      duration: h.duration || 0, note: h.note || "", paused: !!h.paused,
      paused_since: h.paused_since || "", pauses: h.pauses || [],
    })));
    setEditing(true);
  };

  const saveRows = async () => {
    const clean = rows.filter((r) => r.name.trim());
    setSavingRows(true);
    try {
      await api.saveHabits(clean.map((r) => ({
        name: r.name.trim(),
        domain: r.domain.trim() || "body",
        variants: r.variants.split(",").map((v) => v.trim()).filter(Boolean),
        target: Math.max(1, r.target),
        period: r.period === "day" ? "day" : "week",
        morning: r.morning,
        duration: Math.max(0, r.duration || 0),
        note: r.note.replace(/^\[\[|\]\]$/g, "").trim(),
        paused: r.paused,
        paused_since: r.paused_since,
        pauses: r.pauses,
      })));
      setEditing(false);
      load();
      window.dispatchEvent(new CustomEvent("habits-changed")); // refresh the strip
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save habits");
    }
    setSavingRows(false);
  };

  const togglePause = async (h: Habit) => {
    setPausing(h.name);
    try {
      await api.pauseHabit(h.name, !h.paused);
      load();
      window.dispatchEvent(new CustomEvent("habits-changed")); // refresh the strip
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to pause habit");
    }
    setPausing(null);
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
          Creates <span className="font-mono">Plan Week Habits.md</span> in your vault — edit it here or in Obsidian.
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  /* ── Edit mode ─────────────────────────────────────────── */
  if (editing) {
    const editDomains = [
      ...DOMAIN_ORDER,
      ...[...new Set(rows.map((r) => r.domain))].filter((d) => !DOMAIN_ORDER.includes(d)).sort(),
    ];
    const setRowNote = (idx: number, note: string) =>
      setRows((prev) => prev.map((r, j) => (j === idx ? { ...r, note } : r)));
    return (
      <div className="space-y-5 pb-12">
        <div className="flex items-center justify-between">
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Editing <span className="font-mono">Plan Week Habits.md</span> — targets are weekly and flexible; any variant counts.
          </p>
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="text-xs px-3 py-1.5 rounded-lg"
              style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
              Cancel
            </button>
            <button onClick={saveRows} disabled={savingRows}
              className="text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "var(--accent)" }}>
              {savingRows ? "Saving…" : "Save habits"}
            </button>
          </div>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}

        {editDomains.map((d) => {
          const { icon } = habitDomainStyle(d);
          const domainRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.domain === d);
          return (
            <section key={d} className="space-y-1.5">
              <h2 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--text)" }}>
                <span>{icon}</span> {DOMAIN_TITLES[d] || d.charAt(0).toUpperCase() + d.slice(1)}
              </h2>
              {domainRows.map(({ r, i }) => {
                const update = (patch: Partial<HabitRow>) =>
                  setRows((prev) => prev.map((row, j) => (j === i ? { ...row, ...patch } : row)));
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg"
                    style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
                    <input type="text" value={r.name} placeholder="habit name"
                      onChange={(e) => update({ name: e.target.value })}
                      className="w-36 px-2 py-1 rounded text-xs"
                      style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
                    <input type="text" value={r.variants} placeholder="variants, comma-separated"
                      onChange={(e) => update({ variants: e.target.value })}
                      className="flex-1 min-w-[10rem] px-2 py-1 rounded text-xs"
                      style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
                    <select value={r.period} onChange={(e) => update({ period: e.target.value })}
                      className="px-1.5 py-1 rounded text-xs"
                      style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}>
                      <option value="week">per week</option>
                      <option value="day">daily</option>
                    </select>
                    {/* Seven chips rather than a number field. Typing was the
                        problem: the field is controlled and fell back to 1 the
                        moment you cleared it, so it snapped back as you
                        deleted. A tap can't be half-done. */}
                    {r.period === "week" && (
                      <span className="flex gap-0.5" title="Times per week">
                        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                          <button key={n} type="button" onClick={() => update({ target: n })}
                            className={`w-6 py-1 rounded text-xs font-medium transition-colors ${r.target === n ? "bg-blue-600 text-white" : ""}`}
                            style={r.target === n ? undefined : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                            title={`${n}× a week`}>
                            {n}
                          </button>
                        ))}
                      </span>
                    )}
                    <label className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      <input type="checkbox" checked={r.morning} onChange={(e) => update({ morning: e.target.checked })} />
                      morning
                    </label>
                    <label className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}
                      title="Off the Plan tab and out of the week's count; history kept">
                      <input type="checkbox" checked={r.paused} onChange={(e) => update({ paused: e.target.checked })} />
                      paused
                    </label>
                    {/* A duration is a number you know, so it's typed. What
                        it must not do is the thing the old field did: being
                        controlled with a fallback, it rewrote the digit the
                        moment you cleared it, so the value came back as you
                        deleted. Uncontrolled — the DOM owns the text and we
                        read it, the same reasoning as the task inputs and
                        their Samsung keyboards. Empty means untimed. */}
                    <label className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      <input
                        key={`dur-${i}`}
                        type="number" min={0} step={5} inputMode="numeric"
                        defaultValue={r.duration || ""}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          update({ duration: v === "" ? 0 : Math.max(0, parseInt(v, 10) || 0) });
                        }}
                        placeholder="untimed"
                        className="w-20 px-1.5 py-1 rounded text-xs"
                        style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
                        title="Minutes per occurrence — leave it empty for untimed" />
                      min
                    </label>
                    <button
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setNotePicker({ idx: i, pos: { top: rect.bottom + 4, left: Math.max(8, rect.right - 300) } });
                      }}
                      className="flex items-center gap-1 px-1.5 py-1 rounded text-[10px]"
                      style={{ backgroundColor: "var(--bg)", color: r.note ? "var(--text)" : "var(--text-tertiary)", border: "1px solid var(--border)" }}
                      title={r.note ? `Linked: ${r.note} — click to change or remove (in the panel)` : "Link the vault note that explains how — reference only, never a task"}>
                      📄 {r.note || "how-to note"}
                    </button>
                    <button onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                      className="text-xs px-1" style={{ color: "var(--text-tertiary)" }} title="Remove habit">
                      ✕
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() => setRows((prev) => [...prev, { name: "", domain: d, variants: "", target: 1, period: "week", morning: false, duration: 0, note: "", paused: false, paused_since: "", pauses: [] }])}
                className="text-[10px] px-2 py-1 rounded"
                style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                + Add {DOMAIN_TITLES[d] || d} habit
              </button>
            </section>
          );
        })}
        {notePicker && (
          <NoteFilePicker
            existingLinks={rows[notePicker.idx]?.note ? [{ name: rows[notePicker.idx].note }] : []}
            position={notePicker.pos}
            startFolder=""
            onSelect={(path, name) => { setNotePicker(null); onOpenNote?.(path, name); }}
            onAddLink={(name) => { setRowNote(notePicker.idx, name); setNotePicker(null); }}
            onRemoveLink={() => { setRowNote(notePicker.idx, ""); setNotePicker(null); }}
            onReplaceLink={(_old, newName) => { setRowNote(notePicker.idx, newName); setNotePicker(null); }}
            onClose={() => setNotePicker(null)}
          />
        )}
      </div>
    );
  }

  /* ── Read view ─────────────────────────────────────────── */
  const byDomain = new Map<string, Habit[]>();
  habits.forEach((h) => byDomain.set(h.domain, [...(byDomain.get(h.domain) || []), h]));
  byDomain.forEach((list) => list.sort((a, b) => Number(a.paused) - Number(b.paused)));
  const domains = [
    ...DOMAIN_ORDER.filter((d) => byDomain.has(d)),
    ...[...byDomain.keys()].filter((d) => !DOMAIN_ORDER.includes(d)).sort(),
  ];

  const weekDots = (h: Habit) => {
    const total = h.period === "day" ? 7 : h.target;
    const done = h.period === "day" ? h.days_done : h.week_count;
    return "●".repeat(done) + "○".repeat(Math.max(0, total - done));
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Log habits from the chips above your day — this page just remembers what you've built.
        </p>
        <div className="flex gap-2">
          <button onClick={load} className="text-[10px] px-2 py-1 rounded"
            style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
            Refresh
          </button>
          <button onClick={startEditing} className="text-[10px] px-2 py-1 rounded"
            style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
            Edit
          </button>
        </div>
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
                <div key={h.name} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-lg ${h.paused ? "opacity-60" : ""}`}
                  style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)", boxShadow: `inset 2px 0 0 ${h.paused ? "var(--border)" : color}` }}>
                  {/* min width: on a phone the progress column wraps below
                      rather than squeezing the name to a word per line */}
                  <div className="flex-1 min-w-[8rem]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium" style={{ color: "var(--text)" }}>{h.name}</span>
                      {h.established && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                          established ✓
                        </span>
                      )}
                      {h.paused && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                          title={h.paused_since ? `Paused since ${shortDate(h.paused_since)}` : undefined}>
                          paused
                        </span>
                      )}
                      {h.morning && <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>morning</span>}
                      {h.duration > 0 && <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>~{h.duration >= 60 ? `${Math.floor(h.duration / 60)}h${h.duration % 60 || ""}` : `${h.duration}min`}</span>}
                      {h.note && onOpenNote && <HabitNoteLink note={h.note} onOpenNote={onOpenNote} />}
                    </div>
                    {h.variants.length > 0 && (
                      <div className="text-[10px] truncate" style={{ color: "var(--text-tertiary)" }}>
                        {h.variants.join(" · ")}
                      </div>
                    )}
                  </div>
                  {/* Progress and the pause button travel together: on a phone
                      they wrap below the name as one right-aligned group */}
                  <div className="flex items-center gap-3 ml-auto shrink-0">
                    <div className="text-right">
                      {!h.paused && (
                        <div className="text-xs font-mono tracking-wider" style={{ color }}>
                          {weekDots(h)}
                          <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>
                            {h.period === "day" ? `${h.days_done}/7 days` : `${h.week_count}/${h.target} this week`}
                          </span>
                        </div>
                      )}
                      {h.history.length > 0 && (() => {
                        const pausedWk = (i: number) => !!h.history_paused?.[i];
                        const met = h.history.filter(Boolean).length;
                        const active = h.history.filter((_, i) => !pausedWk(i)).length;
                        const paused = h.history.length - active;
                        return (
                          <div className="flex items-center justify-end gap-1.5 text-[10px] font-mono mt-0.5"
                            style={{ color: "var(--text-tertiary)" }}>
                            <HabitGraph h={h} color={color} />
                            <span title={`${met} of the ${active} weeks you were doing it${paused ? ` · ${paused} paused` : ""}`}>
                              {met} of {active} wks{paused ? `, ${paused} paused` : ""}
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                    <button onClick={() => togglePause(h)} disabled={pausing === h.name}
                      className="shrink-0 text-[10px] px-2 py-1 rounded disabled:opacity-50"
                      style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                      title={h.paused ? "Back on the Plan tab and into the week's count" : "Take it off the Plan tab for now — history is kept"}>
                      {h.paused ? "▶ resume" : "⏸ pause"}
                    </button>
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
