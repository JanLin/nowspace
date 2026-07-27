/* ── Task search ────────────────────────────────────────────────
   Find a task across the current Plan week and the Bucket (or Bucket
   only). Results are badged with their source — 📅 day or 🪣 stage —
   and group; picking one jumps to the owning tab, reveals the task
   and flashes it (via the "nowspace-reveal" event the views listen
   for). Opens from the 🔍 in the header or ⌘K / Ctrl-K. */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { BucketTask, DayTasks } from "../api";
import { bucketAnchorKey, stripBucketMeta, stripCtxTokens } from "../contexts";

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STAGE_CHIP: Record<string, string> = {
  captured: "bg-gray-100 text-gray-500",
  binding: "bg-purple-100 text-purple-700",
  ready: "bg-emerald-100 text-emerald-700",
  dormant: "bg-sky-100 text-sky-700",
  discarded: "bg-gray-100 text-gray-400",
};

type Scope = "all" | "week" | "bucket";

export type SearchHit = {
  source: "week" | "bucket";
  label: string;        // cleaned display text (no group prefix)
  group: string;
  key: string;          // reveal anchor key
  dayIdx?: number;      // week only
  done?: boolean;       // week only
  stage?: string;       // bucket only
  question?: string;    // bucket binding items
};

function splitGroup(text: string): { group: string; label: string } {
  const idx = text.indexOf(":");
  if (idx > 1 && idx < 30) {
    const group = text.slice(0, idx).trim();
    const label = text.slice(idx + 1).trim();
    if (group && label && !/^[A-Da-d]\d*$/.test(group) && !group.includes("[")) return { group, label };
  }
  return { group: "", label: text };
}

export default function TaskSearch({ onPick, onClose }: {
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [weekDays, setWeekDays] = useState<DayTasks[]>([]);
  const [bucketTasks, setBucketTasks] = useState<BucketTask[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    Promise.allSettled([api.getWeekPlan(0), api.getBucket()]).then(([w, b]) => {
      if (w.status === "fulfilled") setWeekDays(w.value.days || []);
      if (b.status === "fulfilled") setBucketTasks(b.value.tasks || []);
      setLoading(false);
    });
  }, []);

  const hits = useMemo<SearchHit[]>(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const matches = (hay: string) => {
      const h = hay.toLowerCase();
      return terms.every((t) => h.includes(t));
    };
    const out: SearchHit[] = [];
    if (scope !== "bucket") {
      weekDays.forEach((day, dayIdx) => {
        (day.tasks || []).forEach((t) => {
          const clean = stripBucketMeta(stripCtxTokens(t.text));
          if (!matches(clean)) return;
          const { group, label } = splitGroup(clean);
          out.push({ source: "week", label, group, dayIdx, done: t.done, key: clean });
        });
      });
    }
    if (scope !== "week") {
      bucketTasks.forEach((t) => {
        const clean = stripBucketMeta(stripCtxTokens(t.text));
        const question = t.question || "";
        if (!matches(clean) && !matches(question)) return;
        const { group, label } = splitGroup(clean);
        out.push({
          source: "bucket", label, group,
          stage: t.stage || "captured",
          question: question || undefined,
          key: bucketAnchorKey(t.text),
        });
      });
    }
    return out.slice(0, 60);
  }, [query, scope, weekDays, bucketTasks]);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-3 pt-[10vh]"
      style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl shadow-2xl p-3 space-y-2"
        style={{ background: "var(--card)", border: "1px solid var(--card-border, var(--border))", color: "var(--text)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          <input ref={inputRef} type="text" value={query} autoComplete="off" spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && hits.length > 0) onPick(hits[0]);
            }}
            placeholder="Search tasks…  (Enter opens the first hit)"
            className="flex-1 text-sm px-2.5 py-1.5 rounded-lg outline-none focus:ring-1 focus:ring-blue-400"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
          {([["all", "All"], ["week", "Planning"], ["bucket", "Bucket"]] as [Scope, string][]).map(([s, name]) => (
            <button key={s} onClick={() => setScope(s)}
              className={`px-1.5 py-1 rounded text-[10px] font-medium shrink-0 ${scope === s ? "bg-blue-100 text-blue-700" : ""}`}
              style={scope !== s ? { background: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}>
              {name}
            </button>
          ))}
        </div>

        <div className="max-h-[55vh] overflow-y-auto space-y-0.5">
          {loading && <p className="text-xs text-center py-4" style={{ color: "var(--text-tertiary)" }}>Loading…</p>}
          {!loading && query && hits.length === 0 && (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-tertiary)" }}>
              Nothing matches in {scope === "all" ? "this week's plan or the bucket" : scope === "week" ? "this week's plan" : "the bucket"}.
            </p>
          )}
          {!loading && !query && (
            <p className="text-[11px] text-center py-4" style={{ color: "var(--text-tertiary)" }}>
              Searches the current Plan week and the Bucket. Every word must match;
              group names count (try a group to list everything in it).
            </p>
          )}
          {hits.map((h, i) => (
            <button key={i} onClick={() => onPick(h)}
              className="w-full text-left px-2 py-1.5 rounded-lg text-xs flex items-center gap-1.5 hover:opacity-80"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              {h.source === "week" ? (
                <span className="shrink-0 text-[10px] font-mono px-1 rounded bg-blue-100 text-blue-700"
                  title="In this week's plan">📅 {DAY_SHORT[h.dayIdx ?? 0]}</span>
              ) : (
                <span className={`shrink-0 text-[10px] px-1 rounded font-medium ${STAGE_CHIP[h.stage || "captured"]}`}
                  title={`In the bucket — ${h.stage}`}>🪣 {h.stage === "binding" ? "shaping" : h.stage}</span>
              )}
              {h.group && (
                <span className="shrink-0 text-[10px] px-1 rounded"
                  style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>{h.group}</span>
              )}
              <span className={`flex-1 truncate ${h.done ? "line-through" : ""}`}
                style={{ color: h.done ? "var(--text-tertiary)" : "var(--text)" }}>
                {h.label}
                {h.question && <span className="italic" style={{ color: "var(--text-tertiary)" }}> — “{h.question}”</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
