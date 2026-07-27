/* ── Funnel: bucket stages UI ───────────────────────────────────
   Captured → Shaping (WIP-limited) → Ready → scheduled, with Dormant
   and Discarded as deliberate exits. The server enforces every gate;
   these dialogs exist so the user never hits a 422 blind.
   See docs/funnel-discovery.md and the implementation brief. */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BucketTask, BucketStage, DiscardReason } from "../api";
import { stripBucketMeta, stripCtxTokens } from "../contexts";

export const STAGE_META: Record<BucketStage, { label: string; chip: string; hint: string }> = {
  captured: { label: "Captured", chip: "bg-gray-100 text-gray-600", hint: "Inbox — unjudged, not schedulable" },
  binding: { label: "Shaping", chip: "bg-purple-100 text-purple-700", hint: "Being shaped into something bounded" },
  ready: { label: "Ready", chip: "bg-emerald-100 text-emerald-700", hint: "Bounded — has a next action and a size" },
  dormant: { label: "Dormant", chip: "bg-sky-100 text-sky-700", hint: "Parked on purpose, silent until its wake date" },
  discarded: { label: "Discarded", chip: "bg-gray-100 text-gray-400", hint: "Dropped, with the reason recorded" },
};

export const DISCARD_LABELS: Record<DiscardReason, string> = {
  no_agency: "No agency — I can't act on the outcome",
  already_decided: "Already decided — more thinking changes nothing",
  not_mine: "Not mine to carry",
};

export const ESTIMATES: ["s" | "m" | "l", string][] = [
  ["s", "small — under an hour"],
  ["m", "medium — an afternoon"],
  ["l", "large — several sessions"],
];

export const stageOf = (t: BucketTask): BucketStage => (t.stage as BucketStage) || "captured";
export const labelOf = (t: BucketTask) => stripBucketMeta(stripCtxTokens(t.text));
// Bounded = sized; a GTD-style task is its own next action, steps optional
export const isBound = (t: BucketTask) => ["s", "m", "l"].includes(t.estimate || "");

/** A resolution the dialogs hand back to the caller, who applies it. */
export type StageResolution =
  | { kind: "ready"; estimate: "s" | "m" | "l"; steps: string[] }
  | { kind: "binding"; question: string; mode: "solve" | "rehearse" }
  | { kind: "dormant"; wake_date: string }
  | { kind: "discarded"; reason: DiscardReason };

/** Apply a resolution to a task, returning the updated copy. */
export function applyResolution(t: BucketTask, r: StageResolution): BucketTask {
  const today = new Date().toISOString().slice(0, 10);
  if (r.kind === "ready") {
    const existing = t.subtasks || [];
    const added = r.steps.filter(Boolean).map((text) => ({ text, done: false }));
    return {
      ...t, stage: "ready", estimate: r.estimate,
      subtasks: [...existing, ...added],
      question: "", wake_date: "", discard_reason: "",
      ready_since: t.ready_since || today,
    };
  }
  if (r.kind === "binding") {
    return { ...t, stage: "binding", question: r.question, mode: r.mode, wake_date: "", discard_reason: "", ready_since: "" };
  }
  if (r.kind === "dormant") {
    return { ...t, stage: "dormant", wake_date: r.wake_date, question: "", discard_reason: "", ready_since: "", horizon: "" };
  }
  return { ...t, stage: "discarded", discard_reason: r.reason, question: "", wake_date: "", ready_since: "", horizon: "" };
}

/* ── Shared modal shell ─────────────────────────────────────── */

export function ModalShell({ children, onClose, z = 50, wide = false }: {
  children: React.ReactNode; onClose?: () => void; z?: number; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center p-3"
      style={{ zIndex: z, background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}>
      <div className={`w-full ${wide ? "max-w-lg" : "max-w-sm"} max-h-[85vh] overflow-y-auto rounded-xl shadow-2xl p-4 space-y-3`}
        style={{ background: "var(--card)", border: "1px solid var(--card-border, var(--border))", color: "var(--text)" }}
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

const btnPrimary = "px-3 py-1.5 rounded-lg text-xs font-medium text-white";
const btnGhost = "px-3 py-1.5 rounded-lg text-xs font-medium";
const ghostStyle = { background: "var(--bg-tertiary)", color: "var(--text-secondary)" } as const;

/* ── Ready dialog: the definition-of-ready gate ─────────────── */

export function ReadyDialog({ task, onResolve, onCancel }: {
  task: BucketTask; onResolve: (r: StageResolution) => void; onCancel: () => void;
}) {
  const [estimate, setEstimate] = useState<"" | "s" | "m" | "l">((task.estimate as "s" | "m" | "l") || "");
  const [steps, setSteps] = useState<string[]>([]);
  const stepRef = useRef<HTMLInputElement>(null);
  const existingOpen = (task.subtasks || []).filter((s) => !s.done);

  const addStep = () => {
    const v = (stepRef.current?.value || "").trim();
    if (v) { setSteps((p) => [...p, v]); if (stepRef.current) stepRef.current.value = ""; }
  };

  return (
    <ModalShell onClose={onCancel}>
      <div>
        <h3 className="text-sm font-semibold">Ready means bounded</h3>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>{labelOf(task)}</p>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">
          Steps <span className="font-normal" style={{ color: "var(--text-tertiary)" }}>
            (optional — skip when the task itself is the action)</span>
        </p>
        {existingOpen.map((s, i) => (
          <p key={`e${i}`} className="text-xs pl-2" style={{ color: "var(--text-secondary)" }}>· {s.text}</p>
        ))}
        {steps.map((s, i) => (
          <p key={`n${i}`} className="text-xs pl-2 flex items-center gap-1" style={{ color: "var(--text-secondary)" }}>
            · {s}
            <button onClick={() => setSteps((p) => p.filter((_, j) => j !== i))} className="text-red-400 text-[10px]">×</button>
          </p>
        ))}
        <div className="flex gap-1">
          <input ref={stepRef} type="text" autoComplete="off" placeholder="e.g. email Anna for the venue list"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) addStep(); }}
            className="flex-1 text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-emerald-400"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
          <button onClick={addStep} className={btnGhost} style={ghostStyle}>＋</button>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">How big is it?</p>
        <div className="flex gap-1">
          {ESTIMATES.map(([e, name]) => (
            <button key={e} onClick={() => setEstimate(e)} title={name}
              className={`px-2.5 py-1 rounded text-xs font-mono font-bold ${estimate === e ? "bg-emerald-100 text-emerald-700" : ""}`}
              style={estimate !== e ? ghostStyle : undefined}>
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className={btnGhost} style={ghostStyle}>Cancel</button>
        <button
          disabled={!estimate}
          onClick={() => estimate && onResolve({ kind: "ready", estimate, steps })}
          className={`${btnPrimary} disabled:opacity-40`} style={{ background: "#059669" }}>
          Mark Ready
        </button>
      </div>
    </ModalShell>
  );
}

/* ── Dormant dialog ─────────────────────────────────────────── */

export function DormantDialog({ task, onResolve, onCancel }: {
  task: BucketTask; onResolve: (r: StageResolution) => void; onCancel: () => void;
}) {
  const plus = (days: number) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const [wake, setWake] = useState(plus(30));
  return (
    <ModalShell onClose={onCancel}>
      <div>
        <h3 className="text-sm font-semibold">Park it — on purpose</h3>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>{labelOf(task)}</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
          Silent until the wake date, then it surfaces in the weekly review. A decision, not a failure.
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {[["+2w", 14], ["+1m", 30], ["+3m", 90]].map(([label, d]) => (
          <button key={label as string} onClick={() => setWake(plus(d as number))}
            className={`px-2 py-1 rounded text-xs ${wake === plus(d as number) ? "bg-sky-100 text-sky-700 font-medium" : ""}`}
            style={wake !== plus(d as number) ? ghostStyle : undefined}>
            {label as string}
          </button>
        ))}
        <input type="date" value={wake} min={plus(1)} onChange={(e) => setWake(e.target.value)}
          className="text-xs px-2 py-1 rounded outline-none"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={btnGhost} style={ghostStyle}>Cancel</button>
        <button disabled={!wake} onClick={() => onResolve({ kind: "dormant", wake_date: wake })}
          className={`${btnPrimary} disabled:opacity-40`} style={{ background: "#0284c7" }}>
          Sleep until {wake}
        </button>
      </div>
    </ModalShell>
  );
}

/* ── Discard dialog ─────────────────────────────────────────── */

export function DiscardDialog({ task, onResolve, onCancel }: {
  task: BucketTask; onResolve: (r: StageResolution) => void; onCancel: () => void;
}) {
  return (
    <ModalShell onClose={onCancel}>
      <div>
        <h3 className="text-sm font-semibold">Drop it — and record why</h3>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>{labelOf(task)}</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-tertiary)" }}>
          The reason is what stops the same topic reappearing next month.
        </p>
      </div>
      <div className="space-y-1.5">
        {(Object.keys(DISCARD_LABELS) as DiscardReason[]).map((r) => (
          <button key={r} onClick={() => onResolve({ kind: "discarded", reason: r })}
            className="w-full text-left px-3 py-2 rounded-lg text-xs hover:opacity-80"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text)" }}>
            {DISCARD_LABELS[r]}
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <button onClick={onCancel} className={btnGhost} style={ghostStyle}>Cancel</button>
      </div>
    </ModalShell>
  );
}

/* ── Shape dialog: the two promotion tests, then the question ── */

export function BindDialog({ task, onResolve, onCancel }: {
  task: BucketTask; onResolve: (r: StageResolution) => void; onCancel: () => void;
}) {
  // step 0: agency test · step 1: underdetermined test · step 2: the question
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"solve" | "rehearse">("solve");
  const qRef = useRef<HTMLInputElement>(null);
  const [qErr, setQErr] = useState("");

  const submitQuestion = () => {
    let q = (qRef.current?.value || "").trim();
    if (q && !q.endsWith("?")) q += "?";
    if (q.length < 2) { setQErr("The question is what you'll actually carry — it can't be empty."); return; }
    onResolve({ kind: "binding", question: q, mode });
  };

  return (
    <ModalShell onClose={onCancel}>
      <div>
        <h3 className="text-sm font-semibold">Promote to Shaping</h3>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>{labelOf(task)}</p>
      </div>

      {step === 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">Can you act on the outcome?</p>
          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className={btnPrimary} style={{ background: "var(--accent)" }}>Yes</button>
            <button onClick={() => onResolve({ kind: "discarded", reason: "no_agency" })}
              className={btnGhost} style={ghostStyle}>No — discard it</button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">Does more thinking change the answer?</p>
          <div className="flex flex-col gap-1.5">
            <button onClick={() => setStep(2)} className={`${btnPrimary} self-start`} style={{ background: "var(--accent)" }}>
              Yes — it's genuinely open
            </button>
            <button onClick={() => onResolve({ kind: "ready", estimate: "s", steps: [] })}
              className="text-left px-3 py-1.5 rounded-lg text-xs" style={ghostStyle}
              title="You'll be asked for the next action and size">
              No — it's already decided, write the next action
            </button>
            <button onClick={() => onResolve({ kind: "discarded", reason: "already_decided" })}
              className="text-left px-3 py-1.5 rounded-lg text-xs" style={ghostStyle}>
              No — it's just circling, discard it
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">What question are you carrying?</p>
          <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            Your mind works on questions and ignores nouns — the title isn't enough.
          </p>
          <input ref={qRef} type="text" autoComplete="off"
            placeholder="e.g. What would make this worth doing at all?"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submitQuestion(); }}
            className="w-full text-xs px-2 py-1.5 rounded outline-none focus:ring-1 focus:ring-purple-400"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
          {qErr && <p className="text-[10px] text-red-500">{qErr}</p>}
          <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
            <button onClick={() => setMode("solve")}
              className={`px-2 py-0.5 rounded ${mode === "solve" ? "bg-purple-100 text-purple-700 font-medium" : ""}`}
              style={mode !== "solve" ? ghostStyle : undefined}>solve</button>
            <button onClick={() => setMode("rehearse")}
              className={`px-2 py-0.5 rounded ${mode === "rehearse" ? "bg-purple-100 text-purple-700 font-medium" : ""}`}
              style={mode !== "rehearse" ? ghostStyle : undefined}>rehearse</button>
            <span>— rehearse = retrieval practice on things you already know</span>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className={btnGhost} style={ghostStyle}>Cancel</button>
            <button onClick={submitQuestion} className={btnPrimary} style={{ background: "#7c3aed" }}>Shape it</button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/* ── Eviction dialog: the fifth item forces a trade-off ─────── */

export function EvictionDialog({ bindingItems, limit, incoming, onEvict, onCancel }: {
  bindingItems: { task: BucketTask; originalIdx: number }[];
  limit: number;
  incoming: BucketTask | null; // the item waiting for a slot (null = just resolving)
  onEvict: (originalIdx: number, r: StageResolution) => void;
  onCancel: () => void;
}) {
  const [resolving, setResolving] = useState<{ idx: number; kind: "ready" | "dormant" | "discarded" } | null>(null);
  const target = resolving ? bindingItems.find((b) => b.originalIdx === resolving.idx) : null;

  return (
    <>
      <ModalShell onClose={onCancel} wide>
        <div>
          <h3 className="text-sm font-semibold">Shaping is full — the limit is the feature</h3>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
            {incoming
              ? <>To carry <span className="font-medium">“{labelOf(incoming)}”</span>, one of these {limit} has to leave. This is the only moment genuine prioritisation happens.</>
              : <>Pick which one leaves, and how.</>}
          </p>
        </div>
        <div className="space-y-2">
          {bindingItems.map(({ task, originalIdx }) => (
            <div key={originalIdx} className="px-3 py-2 rounded-lg space-y-1"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
              <p className="text-xs font-medium">{labelOf(task)}</p>
              {task.question && <p className="text-[11px] italic" style={{ color: "var(--text-secondary)" }}>{task.question}</p>}
              <div className="flex gap-1.5">
                <button onClick={() => setResolving({ idx: originalIdx, kind: "ready" })}
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700">→ Ready</button>
                <button onClick={() => setResolving({ idx: originalIdx, kind: "dormant" })}
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700">→ Dormant</button>
                <button onClick={() => setResolving({ idx: originalIdx, kind: "discarded" })}
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">→ Discard</button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button onClick={onCancel} className={btnGhost} style={ghostStyle}>
            {incoming ? "Never mind — it stays captured" : "Close"}
          </button>
        </div>
      </ModalShell>

      {target && resolving?.kind === "ready" && (
        <ReadyDialog task={target.task}
          onResolve={(r) => { onEvict(target.originalIdx, r); setResolving(null); }}
          onCancel={() => setResolving(null)} />
      )}
      {target && resolving?.kind === "dormant" && (
        <DormantDialog task={target.task}
          onResolve={(r) => { onEvict(target.originalIdx, r); setResolving(null); }}
          onCancel={() => setResolving(null)} />
      )}
      {target && resolving?.kind === "discarded" && (
        <DiscardDialog task={target.task}
          onResolve={(r) => { onEvict(target.originalIdx, r); setResolving(null); }}
          onCancel={() => setResolving(null)} />
      )}
    </>
  );
}

/* ── Diagnostics (stage 6): system metrics, never a user score ─ */

type FunnelStats = Awaited<ReturnType<typeof api.getFunnelStats>>;

export function FunnelStatsModal({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<FunnelStats | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.getFunnelStats().then(setStats).catch((e) => setErr(e instanceof Error ? e.message : "Failed"));
  }, []);

  return (
    <ModalShell onClose={onClose} wide>
      <div>
        <h3 className="text-sm font-semibold">Funnel diagnostics</h3>
        <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          These measure the system, not you. Slips and age-in-ready are separate figures on purpose.
        </p>
      </div>
      {err && <p className="text-xs text-red-500">{err}</p>}
      {stats && (
        <div className="space-y-3 text-xs" style={{ color: "var(--text-secondary)" }}>
          <div>
            <p className="font-medium mb-1" style={{ color: "var(--text)" }}>Time in stage</p>
            {(Object.entries(STAGE_META) as [BucketStage, typeof STAGE_META[BucketStage]][]).map(([st, meta]) => {
              const row = stats.stages[st];
              if (!row || !row.count) return null;
              return (
                <p key={st}>
                  <span className={`px-1 rounded text-[10px] ${meta.chip}`}>{meta.label}</span>{" "}
                  {row.count} item{row.count !== 1 ? "s" : ""}
                  {row.avg_days_in_stage !== null && ` · avg ${row.avg_days_in_stage}d in stage`}
                </p>
              );
            })}
            {stats.ready_age_days.avg !== null && (
              <p className="mt-0.5">Age in Ready: avg {stats.ready_age_days.avg}d, max {stats.ready_age_days.max}d</p>
            )}
          </div>
          <div>
            <p className="font-medium mb-1" style={{ color: "var(--text)" }}>How items leave Shaping</p>
            <p>
              → Ready {stats.binding_exits.ready} · → Dormant {stats.binding_exits.dormant} · → Discarded {stats.binding_exits.discarded}
            </p>
          </div>
          {Object.keys(stats.slip_by_group).length > 0 && (
            <div>
              <p className="font-medium mb-1" style={{ color: "var(--text)" }}>Slips by group (ready items)</p>
              {Object.entries(stats.slip_by_group).map(([g, row]) => (
                <p key={g}>{g}: {row.slipped_items}/{row.ready_items} slipped ({row.total_slips} slips total)</p>
              ))}
            </div>
          )}
          <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            Last review: {stats.last_review || "never"}
            {stats.last_review_secs > 0 && ` · took ${Math.floor(stats.last_review_secs / 60)}:${String(stats.last_review_secs % 60).padStart(2, "0")} (target 5:00)`}
          </p>
        </div>
      )}
      <div className="flex justify-end">
        <button onClick={onClose} className={btnGhost} style={ghostStyle}>Close</button>
      </div>
    </ModalShell>
  );
}

/* ── Weekly review: a timed flow, not a tab ─────────────────── */

type ReviewStep =
  | { kind: "intro" }
  | { kind: "slips" }
  | { kind: "binding-check"; idx: number }
  | { kind: "refill" }
  | { kind: "woken"; idx: number }
  | { kind: "focus" }
  | { kind: "done" };

export function WeeklyReview({ tasks, limit, weekFocus, onApply, onFinish, onClose }: {
  tasks: BucketTask[];
  limit: number;
  weekFocus: string;
  /** Replace one task (by index in `tasks`) with an updated copy. */
  onApply: (idx: number, updated: BucketTask) => void;
  onFinish: (focus: string, secs: number) => void;
  onClose: () => void;
}) {
  const startedAt = useRef(Date.now());
  const today = new Date().toISOString().slice(0, 10);

  // Snapshot the step list up front; indexes reference the live tasks array.
  const bindingIdxs = tasks.map((t, i) => ({ t, i })).filter(({ t }) => stageOf(t) === "binding").map(({ i }) => i);
  const slippedIdxs = tasks.map((t, i) => ({ t, i }))
    .filter(({ t }) => stageOf(t) === "ready" && (t.slip_count || 0) > 0).map(({ i }) => i);
  const wokenIdxs = tasks.map((t, i) => ({ t, i }))
    .filter(({ t }) => stageOf(t) === "dormant" && (t.wake_date || "9999") <= today).map(({ i }) => i);

  const steps: ReviewStep[] = [
    { kind: "intro" },
    ...(slippedIdxs.length ? [{ kind: "slips" } as ReviewStep] : []),
    ...bindingIdxs.map((idx) => ({ kind: "binding-check", idx } as ReviewStep)),
    { kind: "refill" },
    ...wokenIdxs.map((idx) => ({ kind: "woken", idx } as ReviewStep)),
    { kind: "focus" },
    { kind: "done" },
  ];

  const [stepIdx, setStepIdx] = useState(0);
  const [dialog, setDialog] = useState<{ idx: number; kind: "bind" | "ready" | "dormant" | "discard" } | null>(null);
  const [focus, setFocus] = useState(weekFocus);
  const [pickingFor, setPickingFor] = useState(false); // refill: choosing a captured item
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const next = () => { setPickingFor(false); setStepIdx((i) => Math.min(i + 1, steps.length - 1)); };
  const back = () => setStepIdx((i) => Math.max(i - 1, 0));

  const bindingCount = tasks.filter((t) => stageOf(t) === "binding").length;
  const capturedItems = tasks.map((t, i) => ({ t, i })).filter(({ t }) => stageOf(t) === "captured");

  const resolveWith = (idx: number, r: StageResolution) => {
    onApply(idx, applyResolution(tasks[idx], r));
    setDialog(null);
  };

  const elapsed = () => Math.round((Date.now() - startedAt.current) / 1000);
  const fmtMin = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const dlgTask = dialog ? tasks[dialog.idx] : null;

  const stageActions = (idx: number, t: BucketTask, opts?: { allowBind?: boolean }) => (
    <div className="flex gap-1.5 flex-wrap">
      {opts?.allowBind && (
        <button onClick={() => setDialog({ idx, kind: "bind" })}
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700">→ Shaping</button>
      )}
      <button onClick={() => setDialog({ idx, kind: "ready" })}
        className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700">→ Ready</button>
      <button onClick={() => setDialog({ idx, kind: "dormant" })}
        className="px-2 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700">→ Dormant</button>
      <button onClick={() => setDialog({ idx, kind: "discard" })}
        className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">→ Discard</button>
      {t.question && <span className="text-[10px] italic self-center" style={{ color: "var(--text-tertiary)" }}>{t.question}</span>}
    </div>
  );

  return (
    <>
      <ModalShell onClose={onClose} wide z={60}>
        {/* header: progress + timer */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <span key={i} className="w-1.5 h-1.5 rounded-full"
                style={{ background: i <= stepIdx ? "var(--accent)" : "var(--border)" }} />
            ))}
          </div>
          <span className="text-[10px] font-mono" style={{ color: "var(--text-tertiary)" }}>
            {fmtMin(elapsed())} · aim for 5:00
          </span>
        </div>

        {step.kind === "intro" && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Weekly review</h3>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              Five minutes: reconcile what slipped, check what you're carrying, refill the empty
              slots, wake what's due, set one line for the week. It ends — that's the point.
            </p>
            {weekFocus && <p className="text-xs italic" style={{ color: "var(--text-tertiary)" }}>Last week's line: “{weekFocus}”</p>}
            <button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Start</button>
          </div>
        )}

        {step.kind === "slips" && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">What slipped</h3>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              Committed to a week that ended without them. No score — just an honest look.
            </p>
            {slippedIdxs.map((idx) => {
              const t = tasks[idx];
              const forced = (t.slip_count || 0) >= 3 && stageOf(t) === "ready";
              return (
                <div key={idx} className="px-3 py-2 rounded-lg space-y-1.5"
                  style={{ background: "var(--bg-secondary)", border: forced ? "1px solid #f59e0b" : "1px solid var(--border)" }}>
                  <p className="text-xs font-medium">
                    {labelOf(t)} <span className="font-normal" style={{ color: "var(--text-tertiary)" }}>· slipped ×{t.slip_count}</span>
                  </p>
                  {forced ? (
                    <div className="space-y-1">
                      <p className="text-[11px] font-medium" style={{ color: "#b45309" }}>
                        Three weeks running. Too big, or not actually important?
                      </p>
                      <div className="flex gap-1.5">
                        <button onClick={() => setDialog({ idx, kind: "bind" })}
                          className="px-2 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700">
                          Too big — re-scope it in Shaping
                        </button>
                        <button onClick={() => setDialog({ idx, kind: "dormant" })}
                          className="px-2 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700">
                          Not important — park it
                        </button>
                        <button onClick={() => setDialog({ idx, kind: "discard" })}
                          className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                          Not important — drop it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>Still Ready — it stays in the pool.</p>
                  )}
                </div>
              );
            })}
            <div className="flex justify-end"><button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Next</button></div>
          </div>
        )}

        {step.kind === "binding-check" && (() => {
          const idx = (step as { kind: "binding-check"; idx: number }).idx;
          const t = tasks[idx];
          if (!t || stageOf(t) !== "binding") { return (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Resolved.</p>
              <div className="flex justify-end"><button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Next</button></div>
            </div>
          ); }
          return (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Carrying: {labelOf(t)}</h3>
              {t.question && <p className="text-xs italic" style={{ color: "var(--text-secondary)" }}>“{t.question}”</p>}
              <p className="text-xs font-medium">Anything new since last week?</p>
              <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                Repetition without new information is rumination — two quiet weeks in a row and this slot should go to something else.
              </p>
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Yes — keep carrying it</button>
              </div>
              {stageActions(idx, { ...t, question: "" })}
            </div>
          );
        })()}

        {step.kind === "refill" && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">
              Shaping slots: {bindingCount}/{limit}
            </h3>
            {bindingCount >= limit ? (
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Full — nothing to refill.</p>
            ) : capturedItems.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Nothing captured to promote. That's fine.</p>
            ) : !pickingFor ? (
              <div className="flex gap-2">
                <button onClick={() => setPickingFor(true)} className={btnPrimary} style={{ background: "#7c3aed" }}>
                  Promote something
                </button>
                <button onClick={next} className={btnGhost} style={ghostStyle}>Leave slots empty</button>
              </div>
            ) : (
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {capturedItems.map(({ t, i }) => (
                  <button key={i} onClick={() => setDialog({ idx: i, kind: "bind" })}
                    className="w-full text-left px-3 py-1.5 rounded-lg text-xs hover:opacity-80"
                    style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text)" }}>
                    {labelOf(t)}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end"><button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Next</button></div>
          </div>
        )}

        {step.kind === "woken" && (() => {
          const idx = (step as { kind: "woken"; idx: number }).idx;
          const t = tasks[idx];
          if (!t || stageOf(t) !== "dormant") { return (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Resolved.</p>
              <div className="flex justify-end"><button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Next</button></div>
            </div>
          ); }
          return (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Woke up: {labelOf(t)}</h3>
              <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>Parked until {t.wake_date}. Does it still matter?</p>
              <div className="flex gap-1.5 flex-wrap">
                <button
                  onClick={() => { onApply(idx, { ...t, stage: "captured", wake_date: "" }); next(); }}
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">→ Back to Captured</button>
              </div>
              {stageActions(idx, t, { allowBind: true })}
            </div>
          );
        })()}

        {step.kind === "focus" && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">One line for the week</h3>
            <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)}
              autoComplete="off" placeholder="e.g. Ship the funnel, everything else waits"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) next(); }}
              className="w-full text-xs px-2 py-1.5 rounded outline-none focus:ring-1 focus:ring-blue-400"
              style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
            <div className="flex justify-end gap-2">
              <button onClick={back} className={btnGhost} style={ghostStyle}>Back</button>
              <button onClick={next} className={btnPrimary} style={{ background: "var(--accent)" }}>Done</button>
            </div>
          </div>
        )}

        {step.kind === "done" && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">That's the review</h3>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {fmtMin(elapsed())} — everything that needed a decision got one. See you next week.
            </p>
            <div className="flex justify-end">
              <button onClick={() => onFinish(focus.trim(), elapsed())}
                className={btnPrimary} style={{ background: "var(--accent)" }}>Close</button>
            </div>
          </div>
        )}
      </ModalShell>

      {dlgTask && dialog?.kind === "bind" && (
        <BindDialog task={dlgTask}
          onResolve={(r) => {
            // "already decided → ready" from inside the bind flow still has to
            // pass the ready gate — reroute to the ready dialog
            if (r.kind === "ready") { setDialog({ idx: dialog.idx, kind: "ready" }); return; }
            resolveWith(dialog.idx, r);
          }}
          onCancel={() => setDialog(null)} />
      )}
      {dlgTask && dialog?.kind === "ready" && (
        <ReadyDialog task={dlgTask} onResolve={(r) => resolveWith(dialog.idx, r)} onCancel={() => setDialog(null)} />
      )}
      {dlgTask && dialog?.kind === "dormant" && (
        <DormantDialog task={dlgTask} onResolve={(r) => resolveWith(dialog.idx, r)} onCancel={() => setDialog(null)} />
      )}
      {dlgTask && dialog?.kind === "discard" && (
        <DiscardDialog task={dlgTask} onResolve={(r) => resolveWith(dialog.idx, r)} onCancel={() => setDialog(null)} />
      )}
    </>
  );
}
