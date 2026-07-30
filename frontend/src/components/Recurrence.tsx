import { useEffect, useState } from "react";
import { api, type RecurrenceTemplate } from "../api";
import { ModalShell } from "./Funnel";

/* Recurring task templates — managed from the Bucket tab.

   Tone rules, from the brief and the philosophy: templates carry no streaks
   and no visible miss counts (misses surface once, in the weekly review, as
   a question about the cadence). The creation gate refuses — size always,
   a coordination step for interval templates — and never warns. */

export const REPEAT_HINT = 'e.g. "monthly on 25", "weekly on mon", "every 6w"';

export function isIntervalRepeat(repeat: string): boolean {
  return /^every\s+\d+\s*[wd]$/i.test(repeat.trim());
}

/** "monthly on 25" → next occurrence as a quiet display string. Not used for
    scheduling — the backend owns spawning; this only helps while editing. */
export function describeRepeat(repeat: string): string {
  const r = repeat.trim().toLowerCase();
  if (isIntervalRepeat(r)) return "wakes in the weekly review when the interval has passed";
  if (/^monthly\s+on\s+\d{1,2}$/.test(r) || /^weekly\s+on\s+((mon|tue|wed|thu|fri|sat|sun)\s*)+$/.test(r))
    return "spawns one Ready copy on the date";
  return "";
}

export function emptyTemplate(prefill?: Partial<RecurrenceTemplate>): RecurrenceTemplate {
  return {
    id: "", title: "", repeat: "", size: "", group: "", next_action: "",
    note: "", state: "active", created: "", spawned: "", last_done: "",
    missed: 0, deferred: "", extra: [],
    ...(prefill || {}),
  };
}

export default function RecurrenceModal({ onClose, prefill, groups }: {
  onClose: () => void;
  /** Prefill for "make this item recurring" — opens with a new template row. */
  prefill?: Partial<RecurrenceTemplate> | null;
  groups: string[];
}) {
  const [rows, setRows] = useState<RecurrenceTemplate[]>([]);
  const [mtime, setMtime] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRetired, setShowRetired] = useState(false);

  const load = () => {
    api.getRecurrence().then((r) => {
      const rows = r.templates;
      if (prefill) rows.push(emptyTemplate(prefill));
      setRows(rows);
      setMtime(r.mtime);
      setLoaded(true);
      setDirty(!!prefill);
      setError("");
    }).catch((e) => setError(e instanceof Error ? e.message : "Failed to load templates"));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const update = (i: number, patch: Partial<RecurrenceTemplate>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.saveRecurrence(rows.filter((r) => r.title.trim() || r.id), mtime);
      setMtime(res.mtime);
      setDirty(false);
      setError("");
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      if (msg.includes("changed on disk")) {
        setError("Templates changed on another device — reloaded, redo your edit.");
        load();
      } else {
        setError(msg);
      }
    }
    setSaving(false);
  };

  const active = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state !== "retired");
  const retired = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.state === "retired");

  const input = "px-2 py-1 rounded text-xs";
  const inputStyle = { background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" } as const;

  return (
    <ModalShell onClose={onClose} wide>
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>↻ Recurring tasks</h3>
          <p className="text-[10px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
            If missing it creates debt someone can collect, it's a recurring task.
            If missing it only breaks a pattern, it's a habit — put it in 🌱 Habits instead.
          </p>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {!loaded && !error && <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Loading…</p>}

        {loaded && active.length === 0 && (
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            Nothing repeats yet. A template places one copy at a time into Ready —
            there is never a pile.
          </p>
        )}

        {active.map(({ r, i }) => {
          const interval = isIntervalRepeat(r.repeat);
          return (
            <div key={r.id || `new-${i}`} className="rounded-lg p-2.5 space-y-1.5"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              <div className="flex flex-wrap items-center gap-1.5">
                <input type="text" value={r.title} placeholder="what repeats"
                  onChange={(e) => update(i, { title: e.target.value })}
                  className={`${input} flex-1 min-w-[10rem] font-medium`} style={inputStyle} />
                <select value={r.size} onChange={(e) => update(i, { size: e.target.value })}
                  className={input} style={inputStyle} title="Size — the same gate as Ready">
                  <option value="">size…</option>
                  <option value="s">s</option><option value="m">m</option><option value="l">l</option>
                </select>
                <select value={groups.includes(r.group) ? r.group : ""}
                  onChange={(e) => update(i, { group: e.target.value })}
                  className={input} style={inputStyle} title="Bucket group its copies appear under">
                  <option value="">no group</option>
                  {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <input type="text" value={r.repeat} placeholder={REPEAT_HINT}
                  onChange={(e) => update(i, { repeat: e.target.value })}
                  className={`${input} w-52`} style={inputStyle} />
                <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                  {describeRepeat(r.repeat)}
                </span>
              </div>
              <input type="text" value={r.next_action}
                placeholder={interval ? "first action — e.g. propose a date to X (required)" : "first action (optional — the task is its own next action)"}
                onChange={(e) => update(i, { next_action: e.target.value })}
                className={`${input} w-full`} style={inputStyle} />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>📄</span>
                <input type="text" value={r.note} placeholder="note that explains how (optional)"
                  onChange={(e) => update(i, { note: e.target.value })}
                  className={`${input} flex-1 min-w-[8rem]`} style={inputStyle} />
                {interval && r.last_done && (
                  <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}
                    title="Intervals count from the last time it actually happened">
                    last done {r.last_done}
                  </span>
                )}
                <button onClick={() => update(i, { state: r.state === "paused" ? "active" : "paused" })}
                  className="text-[9px] px-1.5 py-0.5 rounded"
                  style={{ background: "var(--bg-tertiary)", color: r.state === "paused" ? "#b45309" : "var(--text-secondary)" }}
                  title={r.state === "paused" ? "Paused — spawns nothing, surfaces nowhere. Click to resume." : "Pause — spawns nothing until resumed"}>
                  {r.state === "paused" ? "paused ⏸ — resume" : "pause"}
                </button>
                <button onClick={() => update(i, { state: "retired" })}
                  className="text-[9px] px-1.5 py-0.5 rounded"
                  style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                  title="The obligation is over. Completed copies stay done, in place.">
                  retire
                </button>
              </div>
            </div>
          );
        })}

        <div className="flex items-center gap-2">
          <button onClick={() => { setRows((p) => [...p, emptyTemplate()]); setDirty(true); }}
            className="text-[10px] px-2 py-1 rounded"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
            + New template
          </button>
          {retired.length > 0 && (
            <button onClick={() => setShowRetired(!showRetired)}
              className="text-[10px] px-2 py-1 rounded"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }}>
              {showRetired ? "hide" : "show"} retired ({retired.length})
            </button>
          )}
        </div>

        {showRetired && retired.map(({ r, i }) => (
          <div key={r.id || i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-tertiary)" }}>
            <span className="flex-1">{r.title} · {r.repeat}</span>
            <button onClick={() => update(i, { state: "active" })}
              className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
              reactivate
            </button>
          </div>
        ))}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg"
            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
            {dirty ? "Cancel" : "Close"}
          </button>
          {dirty && (
            <button onClick={save} disabled={saving}
              className="text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "var(--accent)" }}>
              {saving ? "Saving…" : "Save templates"}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
