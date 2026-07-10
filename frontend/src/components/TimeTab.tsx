import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { TimeEntry } from "../api";
import {
  type CtxName, type CtxMap, type CtxTags, type CtxSelection, DEFAULT_CTX_TAGS,
  ctxChipClass, ctxEdgeColor, allContextNames, resolveContext, ctxFeatureEnabled,
  taskVisibleInCtxSelection, loadCtxSelection, saveCtxSelection,
} from "../contexts";

/* Where the time goes: month log, per-area/company/sub-project sums, and a
   per-day invoice summary per company. Filtering mirrors the Plan tab
   (shared context selection + a company filter). Sums are computed here
   from the raw log — the backend only stores entries. */

/** "Arratech/CRA: task" → { company, sub, label } */
function parseEntry(text: string): { company: string; sub: string; label: string } {
  const m = text.match(/^([^:/]{2,29})(?:\/([^:]{1,29}))?\s*:\s*(.+)$/);
  if (m) return { company: m[1].trim(), sub: (m[2] || "").trim(), label: m[3].trim() };
  return { company: "", sub: "", label: text };
}

function fmtH(mins: number, quarter: boolean): string {
  const m = quarter ? Math.round(mins / 15) * 15 : mins;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function nowMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Flexible time input → "HH:MM" (colon optional: 1945, 945, 9:45); null if invalid */
function normTime(raw: string): string | null {
  const s = raw.trim().replace(".", ":");
  const m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mnt = parseInt(m[2], 10);
  if (h > 23 || mnt > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mnt).padStart(2, "0")}`;
}

export default function TimeTab() {
  const [month, setMonth] = useState(nowMonth());
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [running, setRunning] = useState<TimeEntry | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0); // re-render for the elapsed clock

  // Shared filters (same selection as the Plan tab)
  const [ctxMap, setCtxMap] = useState<CtxMap>({});
  const [ctxTags, setCtxTags] = useState<CtxTags>(DEFAULT_CTX_TAGS);
  const [ctxSel, setCtxSelState] = useState<CtxSelection>(loadCtxSelection);
  const ctxEnabled = ctxFeatureEnabled(ctxMap);
  const toggleCtx = (name: CtxName) => {
    setCtxSelState((prev) => {
      const next = prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name];
      saveCtxSelection(next);
      return next;
    });
  };
  const [companyFilter, setCompanyFilter] = useState<string>("");

  // Ad-hoc start (calls / meetings not in the task list)
  const [adhocText, setAdhocText] = useState("");
  const [adhocCompany, setAdhocCompany] = useState("");

  // Invoice view
  const [invoiceCompany, setInvoiceCompany] = useState("");
  const [quarterRound, setQuarterRound] = useState(false);
  const [copied, setCopied] = useState(false);

  // Inline entry editing
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editText, setEditText] = useState("");

  const load = (m: string = month) => {
    api.getTimeLog(m).then((r) => { setEntries(r.entries); setRunning(r.running); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load time log"));
  };

  useEffect(() => { load(month); }, [month]);
  useEffect(() => {
    const sync = () => setCtxSelState(loadCtxSelection());
    const reload = () => load();
    api.getSettings().then((s) => {
      setCtxMap(s.contexts || {});
      setCtxTags({ ...DEFAULT_CTX_TAGS, ...(s.context_tags || {}) });
    }).catch(() => {});
    window.addEventListener("ctx-mode-changed", sync);
    window.addEventListener("time-changed", reload);
    window.addEventListener("focus", reload);
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => {
      window.removeEventListener("ctx-mode-changed", sync);
      window.removeEventListener("time-changed", reload);
      window.removeEventListener("focus", reload);
      clearInterval(t);
    };
  }, []);

  const announce = () => window.dispatchEvent(new CustomEvent("time-changed"));

  const startEntry = async (text: string) => {
    try { await api.startTime(text); load(nowMonth()); setMonth(nowMonth()); announce(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to start"); }
  };

  const stopEntry = async () => {
    try { await api.stopTime(); load(); announce(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to stop"); }
  };

  const visible = useMemo(() => entries.filter((e) => {
    const { company } = parseEntry(e.text);
    if (companyFilter && company.toLowerCase() !== companyFilter.toLowerCase()) return false;
    // Context filtering matches the Plan rules (company acts as the group)
    return taskVisibleInCtxSelection(`${company}: x`, ctxSel, ctxMap, ctxTags);
  }), [entries, companyFilter, ctxSel, ctxMap, ctxTags]);

  const companies = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => { const { company } = parseEntry(e.text); if (company) set.add(company); });
    Object.values(ctxMap).flat().forEach((g) => set.add(g));
    return [...set].sort();
  }, [entries, ctxMap]);

  // ── Sums (minutes) ─────────────────────────────────────────
  const sums = useMemo(() => {
    const byArea = new Map<string, number>();
    const byCompany = new Map<string, number>();
    const bySub = new Map<string, Map<string, number>>();
    visible.forEach((e) => {
      const { company, sub } = parseEntry(e.text);
      const area = resolveContext(`${company}: x`, ctxMap, ctxTags);
      byArea.set(area, (byArea.get(area) || 0) + e.minutes);
      const c = company || "(no company)";
      byCompany.set(c, (byCompany.get(c) || 0) + e.minutes);
      if (!bySub.has(c)) bySub.set(c, new Map());
      const s = sub || "(general)";
      bySub.get(c)!.set(s, (bySub.get(c)!.get(s) || 0) + e.minutes);
    });
    return { byArea, byCompany, bySub, total: visible.reduce((n, e) => n + e.minutes, 0) };
  }, [visible, ctxMap, ctxTags]);

  // ── Invoice: per-day summaries for one company ─────────────
  const invoice = useMemo(() => {
    if (!invoiceCompany) return null;
    const days = new Map<string, { minutes: number; labels: Set<string> }>();
    entries.forEach((e) => {
      const { company, sub, label } = parseEntry(e.text);
      if (company.toLowerCase() !== invoiceCompany.toLowerCase()) return;
      const d = days.get(e.date) || { minutes: 0, labels: new Set() };
      d.minutes += e.minutes;
      d.labels.add(sub ? `${sub}: ${label}` : label);
      days.set(e.date, d);
    });
    const rows = [...days.entries()].sort().map(([d, v]) => ({ date: d, minutes: v.minutes, labels: [...v.labels] }));
    return { rows, total: rows.reduce((n, r) => n + r.minutes, 0) };
  }, [entries, invoiceCompany]);

  const copyInvoice = () => {
    if (!invoice) return;
    const lines = [
      `# ${invoiceCompany} — ${month}`,
      "",
      ...invoice.rows.map((r) => `- ${r.date} — ${fmtH(r.minutes, quarterRound)}h: ${r.labels.join("; ")}`),
      "",
      `Total: ${fmtH(invoice.total, quarterRound)}h`,
    ];
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // ── Entry editing ──────────────────────────────────────────
  const dayIndexOf = (e: TimeEntry) =>
    entries.filter((x) => x.date === e.date).sort((a, b) => a.start.localeCompare(b.start)).indexOf(e);

  const saveEdit = async (e: TimeEntry) => {
    const start = normTime(editStart);
    const end = editEnd.trim() ? normTime(editEnd) : null;
    if (!start || (editEnd.trim() && !end)) {
      setError(`"${!start ? editStart : editEnd}" is not a time — use HH:MM or HHMM (e.g. 1945)`);
      return;
    }
    try {
      await api.updateTimeEntry({ date: e.date, index: dayIndexOf(e), start, end, text: editText });
      setEditKey(null); load(); announce();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to update"); }
  };

  const deleteEntry = async (e: TimeEntry) => {
    try {
      await api.updateTimeEntry({ date: e.date, index: dayIndexOf(e), start: e.start, end: e.end, text: e.text, delete: true });
      load(); announce();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to delete"); }
  };

  const byDay = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    visible.forEach((e) => m.set(e.date, [...(m.get(e.date) || []), e]));
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
      .map(([d, es]) => [d, es.sort((a, b) => a.start.localeCompare(b.start))] as const);
  }, [visible]);

  const monthNav = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  void tick;

  return (
    <div className="space-y-5 pb-12">
      {error && <div className="p-2 bg-red-50 text-red-700 rounded text-xs">{error}</div>}

      {/* Running entry + ad-hoc start */}
      <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
        {running ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <input
              key={`txt-${running.text}`}
              defaultValue={running.text}
              onKeyDown={async (ev) => {
                if (ev.key !== "Enter") return;
                const v = (ev.target as HTMLInputElement).value.trim();
                if (!v || v === running.text) return;
                try { await api.adjustTime({ text: v }); load(); announce(); }
                catch (err) { setError(err instanceof Error ? err.message : "Failed to rename"); }
              }}
              title="Edit the description of the running entry — Enter saves"
              className="flex-1 min-w-[10rem] text-sm font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
            />
            <span className="text-xs" style={{ color: "var(--text-secondary)" }}>started</span>
            <input
              key={running.start}
              defaultValue={running.start}
              onKeyDown={async (ev) => {
                if (ev.key !== "Enter") return;
                const t = normTime((ev.target as HTMLInputElement).value);
                if (!t) { setError("Start must be HH:MM or HHMM (e.g. 1945)"); return; }
                try { await api.adjustTime({ start: t }); load(); announce(); }
                catch (err) { setError(err instanceof Error ? err.message : "Failed to adjust"); }
              }}
              title="Started earlier? Type the real start time (1945 works) and press Enter"
              className="w-16 px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
            />
            {[-15, -30, -60].map((d) => (
              <button key={d}
                onClick={async () => {
                  const [h, m] = running.start.split(":").map(Number);
                  const t = Math.max(0, h * 60 + m + d);
                  try { await api.adjustTime({ start: `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` }); load(); announce(); }
                  catch (err) { setError(err instanceof Error ? err.message : "Failed to adjust"); }
                }}
                title={`Started ${-d} minutes earlier than recorded`}
                className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
                {d}m
              </button>
            ))}
            <span className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
              → now · {fmtH(running.minutes, false)}h
            </span>
            <button onClick={stopEntry} className="px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs font-medium hover:bg-red-200">■ Stop</button>
          </div>
        ) : (
          <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Nothing running — press ▶ on a task in the Plan tab, replay an entry below, or start an ad-hoc activity:</p>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          <select value={adhocCompany} onChange={(e) => setAdhocCompany(e.target.value)}
            className="px-1.5 py-1 rounded text-xs" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}>
            <option value="">no company</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="text" value={adhocText} placeholder="call / meeting / activity… (Company/Sub: also works inline)"
            onChange={(e) => setAdhocText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && adhocText.trim()) { startEntry(adhocCompany ? `${adhocCompany}: ${adhocText.trim()}` : adhocText.trim()); setAdhocText(""); } }}
            className="flex-1 min-w-[12rem] px-2 py-1 rounded text-xs" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          <button onClick={() => { if (adhocText.trim()) { startEntry(adhocCompany ? `${adhocCompany}: ${adhocText.trim()}` : adhocText.trim()); setAdhocText(""); } }}
            className="px-2.5 py-1 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">▶ Start</button>
        </div>
      </div>

      {/* Month nav + filters (same chips as the Plan tab) */}
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => monthNav(-1)} className="px-1.5 rounded hover:bg-gray-100 text-gray-500">«</button>
        <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{month}</span>
        <button onClick={() => monthNav(1)} className="px-1.5 rounded hover:bg-gray-100 text-gray-500">»</button>
        <span className="w-px h-4 bg-gray-200" />
        {ctxEnabled && allContextNames(ctxMap, ctxTags).filter((n) =>
          ["work", "volunteer", "personal"].includes(n) || ctxSel.includes(n) ||
          entries.some((e) => resolveContext(`${parseEntry(e.text).company}: x`, ctxMap, ctxTags) === n)
        ).map((name) => {
          const active = ctxSel.includes(name);
          return (
            <button key={name} onClick={() => toggleCtx(name)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${active ? ctxChipClass(name) : "hover:opacity-80"}`}
              style={!active ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </button>
          );
        })}
        {ctxEnabled && (
          <button onClick={() => { setCtxSelState([]); saveCtxSelection([]); }}
            className={`px-2 py-0.5 rounded text-xs font-medium ${ctxSel.length === 0 ? "bg-gray-200 text-gray-700" : ""}`}
            style={ctxSel.length !== 0 ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}>
            All
          </button>
        )}
        <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}
          className="px-1.5 py-0.5 rounded text-xs" style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "none" }}>
          <option value="">All companies</option>
          {companies.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Sums */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-lg p-3" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
          <h3 className="text-xs font-semibold mb-2" style={{ color: "var(--text)" }}>By area — total {fmtH(sums.total, false)}h</h3>
          {[...sums.byArea.entries()].sort((a, b) => b[1] - a[1]).map(([area, mins]) => (
            <div key={area} className="flex items-center gap-2 py-0.5 text-xs">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: ctxEdgeColor(area) }} />
              <span className="flex-1 capitalize" style={{ color: "var(--text)" }}>{area}</span>
              <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{fmtH(mins, false)}h</span>
            </div>
          ))}
        </div>
        <div className="rounded-lg p-3" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
          <h3 className="text-xs font-semibold mb-2" style={{ color: "var(--text)" }}>By company / sub-project</h3>
          {[...sums.byCompany.entries()].sort((a, b) => b[1] - a[1]).map(([c, mins]) => (
            <div key={c} className="py-0.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="flex-1 font-medium" style={{ color: "var(--text)" }}>{c}</span>
                <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{fmtH(mins, false)}h</span>
              </div>
              {(sums.bySub.get(c)?.size || 0) > 1 && (
                <div className="ml-3 border-l pl-2" style={{ borderColor: "var(--border)" }}>
                  {[...sums.bySub.get(c)!.entries()].sort((a, b) => b[1] - a[1]).map(([s, m]) => (
                    <div key={s} className="flex items-center gap-2 text-[10px]" style={{ color: "var(--text-secondary)" }}>
                      <span className="flex-1">{s}</span>
                      <span className="font-mono">{fmtH(m, false)}h</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Invoice summary */}
      <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-xs font-semibold" style={{ color: "var(--text)" }}>Invoice summary</h3>
          <select value={invoiceCompany} onChange={(e) => setInvoiceCompany(e.target.value)}
            className="px-1.5 py-0.5 rounded text-xs" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}>
            <option value="">choose company…</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={quarterRound} onChange={(e) => setQuarterRound(e.target.checked)} />
            round to 15 min
          </label>
          {invoice && invoice.rows.length > 0 && (
            <button onClick={copyInvoice} className="px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] font-medium hover:bg-blue-700">
              {copied ? "Copied ✓" : "Copy as markdown"}
            </button>
          )}
        </div>
        {invoice && invoice.rows.map((r) => (
          <div key={r.date} className="flex items-start gap-2 text-xs">
            <span className="font-mono shrink-0" style={{ color: "var(--text-secondary)" }}>{r.date}</span>
            <span className="font-mono shrink-0" style={{ color: "var(--text)" }}>{fmtH(r.minutes, quarterRound)}h</span>
            <span className="flex-1" style={{ color: "var(--text-secondary)" }}>{r.labels.join("; ")}</span>
          </div>
        ))}
        {invoice && (
          <div className="text-xs font-semibold pt-1 border-t" style={{ color: "var(--text)", borderColor: "var(--border)" }}>
            Total: {fmtH(invoice.total, quarterRound)}h
          </div>
        )}
      </div>

      {/* Entries by day — replay ▶, edit, delete */}
      <div className="space-y-3">
        {byDay.map(([d, es]) => (
          <div key={d}>
            <div className="flex items-center gap-2 text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>
              {d}
              <span className="font-mono font-normal">{fmtH(es.reduce((n, e) => n + e.minutes, 0), false)}h</span>
            </div>
            <div className="space-y-0.5">
              {es.map((e) => {
                const key = `${e.date}|${e.start}|${e.text}`;
                const { company } = parseEntry(e.text);
                const area = resolveContext(`${company}: x`, ctxMap, ctxTags);
                if (editKey === key) {
                  return (
                    <div key={key} className="flex items-center gap-1.5 px-2 py-1 rounded text-xs" style={{ backgroundColor: "var(--bg-secondary)" }}>
                      <input value={editStart} onChange={(ev) => setEditStart(ev.target.value)} className="w-14 px-1 py-0.5 rounded font-mono" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
                      <span style={{ color: "var(--text-tertiary)" }}>–</span>
                      <input value={editEnd} onChange={(ev) => setEditEnd(ev.target.value)} placeholder="running" className="w-14 px-1 py-0.5 rounded font-mono" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
                      <input value={editText} onChange={(ev) => setEditText(ev.target.value)} className="flex-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
                      <button onClick={() => saveEdit(e)} className="px-1.5 rounded bg-blue-600 text-white text-[10px]">Save</button>
                      <button onClick={() => setEditKey(null)} className="px-1 text-[10px]" style={{ color: "var(--text-tertiary)" }}>✕</button>
                    </div>
                  );
                }
                return (
                  <div key={key} className="group flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-gray-50"
                    style={{ boxShadow: `inset 2px 0 0 ${ctxEdgeColor(area)}` }}>
                    <span className="font-mono shrink-0" style={{ color: "var(--text-secondary)" }}>{e.start}–{e.end || "…"}</span>
                    <span className="font-mono shrink-0" style={{ color: "var(--text-tertiary)" }}>{fmtH(e.minutes, false)}</span>
                    <span className="flex-1 truncate" style={{ color: "var(--text)" }}>{e.text}</span>
                    <button onClick={() => startEntry(e.text)} title="Continue this activity now"
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-green-600">▶</button>
                    <button onClick={() => { setEditKey(key); setEditStart(e.start); setEditEnd(e.end || ""); setEditText(e.text); }}
                      title="Edit times / text" className="opacity-0 group-hover:opacity-60 hover:!opacity-100" style={{ color: "var(--text-secondary)" }}>✎</button>
                    <button onClick={() => deleteEntry(e)} title="Delete entry"
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-red-400">✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {byDay.length === 0 && (
          <p className="text-center text-xs py-6" style={{ color: "var(--text-tertiary)" }}>
            No entries for {month}{companyFilter || ctxSel.length ? " with these filters" : ""}.
          </p>
        )}
      </div>
    </div>
  );
}
