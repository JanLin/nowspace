/* ── Handoff surface (agent dispatch) ───────────────────────────
   Three lanes: Drafting, In flight, Returned. Deliberately a modal,
   not a tab — it opens, it has work in it, it empties, it closes.
   Isolation is enforced OUTSIDE Nowspace (one agent per area, one
   read-only mount); what this surface owns is the conformance check
   and the record of what is in flight. Paths, never content. */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BucketTask, Dispatch, HandoffReturn } from "../api";
import { ModalShell, labelOf } from "./Funnel";

const ARTIFACTS = ["diagnosis", "patch", "options", "critique", "draft"] as const;

const LANE_STYLE: Record<string, string> = {
  drafting: "rgb(148 163 184 / 0.35)",
  in_flight: "rgb(59 130 246 / 0.45)",
  returned: "rgb(16 185 129 / 0.45)",
};

const btn = "px-2 py-0.5 rounded text-[10px] font-medium";
const ghostStyle = { background: "var(--bg-tertiary)", color: "var(--text-secondary)" } as const;

/** Compose a new dispatch for one bucket item (opened from the badge menu). */
export function DispatchComposer({ task, area, onDone, onCancel }: {
  task: BucketTask; area: string; onDone: () => void; onCancel: () => void;
}) {
  const [artifact, setArtifact] = useState<string>("");
  const [notes, setNotes] = useState<string[]>([]);
  const [failures, setFailures] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);

  const addNote = () => {
    const v = (noteRef.current?.value || "").trim();
    if (v) { setNotes((p) => [...p, v]); setFailures(null); if (noteRef.current) noteRef.current.value = ""; }
  };

  const create = async () => {
    if (!artifact) return;
    setBusy(true); setErr(""); setFailures(null);
    try {
      const check = await api.handoffCheck({
        source_text: task.text, area, attached_notes: notes, expected_artifact: artifact,
      });
      if (check.conformance === "fail") { setFailures(check.failures); return; }
      await api.createDispatch({
        source_text: task.text, area, attached_notes: notes, expected_artifact: artifact,
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell onClose={onCancel} z={70}>
      <div>
        <h3 className="text-sm font-semibold">Hand off to the {area} agent</h3>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>{labelOf(task)}</p>
        {task.question && <p className="text-xs italic" style={{ color: "var(--text-tertiary)" }}>“{task.question}”</p>}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">What do you expect back?</p>
        <div className="flex gap-1 flex-wrap">
          {ARTIFACTS.map((a) => (
            <button key={a} onClick={() => setArtifact(a)}
              className={`${btn} ${artifact === a ? "bg-blue-100 text-blue-700" : ""}`}
              style={artifact !== a ? ghostStyle : undefined}>{a}</button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">Notes the agent should read <span className="font-normal" style={{ color: "var(--text-tertiary)" }}>(vault paths — the agent reads from its own mount)</span></p>
        {notes.map((n, i) => (
          <p key={i} className="text-[11px] font-mono pl-1 flex items-center gap-1" style={{ color: "var(--text-secondary)" }}>
            {n}
            <button onClick={() => { setNotes((p) => p.filter((_, j) => j !== i)); setFailures(null); }}
              className="text-red-400">×</button>
          </p>
        ))}
        <div className="flex gap-1">
          <input ref={noteRef} type="text" autoComplete="off" spellCheck={false}
            placeholder="2-Areas/…/note.md"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) addNote(); }}
            className="flex-1 text-[11px] font-mono px-2 py-1 rounded outline-none focus:ring-1 focus:ring-blue-400"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
          <button onClick={addNote} className={btn} style={ghostStyle}>＋</button>
        </div>
        <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
          Links typed on the item itself are checked too. Everything named must stay inside the area — a failing check can't be overridden.
        </p>
      </div>

      {failures && (
        <div className="px-2.5 py-2 rounded-lg space-y-0.5 text-[11px]"
          style={{ background: "rgb(239 68 68 / 0.08)", border: "1px solid rgb(239 68 68 / 0.35)", color: "var(--text)" }}>
          <p className="font-medium">Handoff unavailable — the material named here leaves the area:</p>
          {failures.map((f, i) => <p key={i}>· {f}</p>)}
          <p style={{ color: "var(--text-tertiary)" }}>Split the note, or drop the attachment. There is no override.</p>
        </div>
      )}
      {err && <p className="text-xs text-red-500">{err}</p>}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={ghostStyle}>Cancel</button>
        <button disabled={!artifact || busy} onClick={create}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-40"
          style={{ background: "var(--accent)" }}>
          {busy ? "Checking…" : "Create draft"}
        </button>
      </div>
    </ModalShell>
  );
}

/** The three-lane surface. */
export default function HandoffSurface({ onClose, onOpenNote }: {
  onClose: () => void; onOpenNote: (path: string, name: string) => void;
}) {
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [returns, setReturns] = useState<HandoffReturn[]>([]);
  const [limit, setLimit] = useState(3);
  const [inFlight, setInFlight] = useState(0);
  const [areaFilter, setAreaFilter] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [capturing, setCapturing] = useState<HandoffReturn | null>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    setErr("");
    try {
      const [d, r, a] = await Promise.all([
        api.getDispatches(areaFilter),
        api.getHandoffReturns(areaFilter),
        api.getHandoffAreas(),
      ]);
      setDispatches(d.dispatches); setInFlight(d.in_flight); setLimit(d.limit);
      setReturns(r.returns);
      setAreas(a.areas.filter((x) => x.agent_binding).map((x) => x.name));
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
  };
  useEffect(() => { load(); }, [areaFilter]);

  const patch = async (d: Dispatch, body: { state?: string; exchange_count?: number }) => {
    setErr("");
    try { await api.updateDispatch(d.area, d.id, body); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  };

  const resolveReturn = async (r: HandoffReturn, action: "discard" | "capture", texts?: string[]) => {
    setErr("");
    try {
      await api.resolveHandoffReturn({ area: r.area, path: r.path, action, capture_texts: texts });
      setCapturing(null);
      window.dispatchEvent(new CustomEvent("bucket-changed"));
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  };

  const lane = (title: string, hint: string, key: string, items: Dispatch[]) => (
    <div className="rounded-lg p-2 space-y-1.5 min-h-[90px]"
      style={{ background: "var(--bg-secondary)", border: `1px solid ${LANE_STYLE[key]}` }}>
      <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--text)" }}>
        {title}
        <span className="font-normal" style={{ color: "var(--text-tertiary)" }}>
          {key === "in_flight" ? `${inFlight}/${limit}` : `(${items.length})`}
        </span>
      </p>
      {items.length === 0 && <p className="text-[10px] py-2 text-center" style={{ color: "var(--text-tertiary)" }}>{hint}</p>}
      {items.map((d) => (
        <div key={d.id} className="rounded p-2 space-y-1 text-[11px]"
          style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
          <p className="font-medium" style={{ color: "var(--text)" }}>{d.source_label}</p>
          <p style={{ color: "var(--text-tertiary)" }}>
            {d.area} · expecting <span className="font-mono">{d.expected_artifact}</span>
            {d.attached_notes.length > 0 && ` · ${d.attached_notes.length} note${d.attached_notes.length > 1 ? "s" : ""}`}
            {d.exchange_count > 0 && ` · ${d.exchange_count} exchanges`}
          </p>
          <div className="flex gap-1 flex-wrap">
            {d.state === "drafting" && (
              <button onClick={() => patch(d, { state: "in_flight" })}
                className={`${btn} bg-blue-100 text-blue-700`}
                title="Re-checks conformance first — files change">Send → in flight</button>
            )}
            {d.state === "in_flight" && (
              <>
                <button onClick={() => patch(d, { exchange_count: d.exchange_count + 1 })}
                  className={btn} style={ghostStyle} title="Count an exchange with the agent (diagnostics only)">+1 exchange</button>
                <button onClick={() => patch(d, { state: "returned" })}
                  className={`${btn} bg-emerald-100 text-emerald-700`}>Mark returned</button>
              </>
            )}
            {d.state === "returned" && (
              <button onClick={() => patch(d, { state: "closed" })}
                className={`${btn} bg-emerald-100 text-emerald-700`}>Close</button>
            )}
            {d.state === "drafting" && (
              <button onClick={() => patch(d, { state: "closed" })} className={btn} style={ghostStyle}>Discard draft</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <ModalShell onClose={onClose} wide z={55}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">🤝 Handoff</h3>
          <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            It opens, it empties, it closes. Scope decisions stay in the weekly review.
          </p>
        </div>
        {areas.length > 1 && (
          <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}
            className="text-[11px] px-1.5 py-1 rounded outline-none"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}>
            <option value="">All areas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>

      {err && <p className="text-xs text-red-500">{err}</p>}
      {areas.length === 0 && (
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          No areas with an agent binding yet. Configure them in Settings → Agent areas —
          most areas will never have one, and that's the comfortable default.
        </p>
      )}

      {lane("Drafting", "Nothing being assembled", "drafting", dispatches.filter((d) => d.state === "drafting"))}
      {lane("In flight", "Nothing with an agent right now", "in_flight", dispatches.filter((d) => d.state === "in_flight"))}
      {lane("Returned", "Nothing waiting on you", "returned", dispatches.filter((d) => d.state === "returned"))}

      {/* Proposal files from the watched folder */}
      <div className="rounded-lg p-2 space-y-1.5"
        style={{ background: "var(--bg-secondary)", border: `1px solid ${LANE_STYLE.returned}` }}>
        <p className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>
          Agent output <span className="font-normal" style={{ color: "var(--text-tertiary)" }}>({returns.length})</span>
        </p>
        {returns.length === 0 && (
          <p className="text-[10px] py-1 text-center" style={{ color: "var(--text-tertiary)" }}>Empty — as it should end up</p>
        )}
        {returns.map((r) => (
          <div key={r.path} className="rounded p-2 space-y-1 text-[11px]"
            style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
            <p className="font-medium" style={{ color: "var(--text)" }}>{r.name}</p>
            <p style={{ color: "var(--text-tertiary)" }}>{r.area} · {r.modified}{r.dispatch_id && ` · ${r.dispatch_id}`}</p>
            <div className="flex gap-1 flex-wrap">
              <button onClick={() => onOpenNote(r.path, r.name)} className={btn} style={ghostStyle}>Read</button>
              <button onClick={() => setCapturing(r)} className={`${btn} bg-emerald-100 text-emerald-700`}
                title="Creates Captured items — never Ready, never Binding, never edits anything">Capture…</button>
              <button onClick={() => resolveReturn(r, "discard")} className={btn} style={ghostStyle}>Discard</button>
            </div>
          </div>
        ))}
      </div>

      {capturing && (
        <ModalShell onClose={() => setCapturing(null)} z={75}>
          <div>
            <h3 className="text-sm font-semibold">Capture from {capturing.name}</h3>
            <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              One item per line. They land in Captured — unjudged, unpromoted — and wait
              for the weekly review like everything else. Deciding what you carry stays yours.
            </p>
          </div>
          <textarea ref={captureRef} rows={4} autoComplete="off"
            placeholder={"Group: follow up on…"}
            className="w-full text-xs px-2 py-1.5 rounded outline-none focus:ring-1 focus:ring-emerald-400"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setCapturing(null)} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={ghostStyle}>Cancel</button>
            <button onClick={() => {
              const texts = (captureRef.current?.value || "").split("\n").map((s) => s.trim()).filter(Boolean);
              if (texts.length) resolveReturn(capturing, "capture", texts);
            }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: "#059669" }}>
              Capture & clear
            </button>
          </div>
        </ModalShell>
      )}
    </ModalShell>
  );
}
