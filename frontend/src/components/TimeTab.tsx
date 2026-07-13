import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TimeEntry } from "../api";
import {
  type CtxName, type CtxMap, type CtxTags, type CtxSelection, DEFAULT_CTX_TAGS,
  ctxChipClass, ctxEdgeColor, allContextNames, resolveContext, ctxFeatureEnabled,
  taskVisibleInCtxSelection, loadCtxSelection, saveCtxSelection,
} from "../contexts";
import { normTime } from "../timefmt";

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

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mondayOf(iso: string): Date {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function isoWeekNum(iso: string): number {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const end = to.slice(0, 7);
  while (out.length < 36) {
    const cur = `${y}-${String(m).padStart(2, "0")}`;
    out.push(cur);
    if (cur >= end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/* Donut palette — resolves via --viz-N CSS vars so dark mode swaps
   automatically (both palettes CVD/contrast-validated against the card
   surface; the legend carries the values as text). */
const DONUT_COLORS = Array.from({ length: 8 }, (_, i) => `var(--viz-${i + 1})`);

function Donut({ slices }: { slices: { label: string; minutes: number; color: string }[] }) {
  const total = slices.reduce((n, s) => n + s.minutes, 0);
  const size = 120, r = 56, ir = 32, c = size / 2;
  if (!total) return null;
  if (slices.length === 1) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" className="shrink-0">
        <title>{slices[0].label}</title>
        <circle cx={c} cy={c} r={(r + ir) / 2} fill="none" stroke={slices[0].color} strokeWidth={r - ir} />
      </svg>
    );
  }
  let a = -Math.PI / 2;
  const pt = (ang: number, rad: number) => `${c + rad * Math.cos(ang)},${c + rad * Math.sin(ang)}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" className="shrink-0">
      {slices.map((s) => {
        const a0 = a, a1 = a + (s.minutes / total) * Math.PI * 2;
        a = a1;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        return (
          <path key={s.label}
            d={`M ${pt(a0, r)} A ${r} ${r} 0 ${large} 1 ${pt(a1, r)} L ${pt(a1, ir)} A ${ir} ${ir} 0 ${large} 0 ${pt(a0, ir)} Z`}
            fill={s.color} stroke="var(--bg-secondary)" strokeWidth="2">
            <title>{`${s.label} — ${fmtH(s.minutes, false)}h (${Math.round((s.minutes / total) * 100)}%)`}</title>
          </path>
        );
      })}
    </svg>
  );
}

export default function TimeTab() {
  const [mode, setMode] = useState<"week" | "month" | "custom">("month");
  const [month, setMonth] = useState(nowMonth());
  const [weekAnchor, setWeekAnchor] = useState(() => toISODate(new Date()));
  const [customFrom, setCustomFrom] = useState(() => `${nowMonth()}-01`);
  const [customTo, setCustomTo] = useState(() => toISODate(new Date()));
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

  // Selected period → inclusive date range (a week or custom range can
  // span month files; load() fetches every month it touches)
  const range = useMemo(() => {
    if (mode === "week") {
      const mon = mondayOf(weekAnchor);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return { from: toISODate(mon), to: toISODate(sun) };
    }
    if (mode === "custom") {
      return customFrom <= customTo ? { from: customFrom, to: customTo } : { from: customTo, to: customFrom };
    }
    const [y, m] = month.split("-").map(Number);
    return { from: `${month}-01`, to: toISODate(new Date(y, m, 0)) };
  }, [mode, month, weekAnchor, customFrom, customTo]);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const periodLabel = mode === "month" ? month
    : mode === "week" ? `Week ${isoWeekNum(range.from)} · ${range.from} → ${range.to}`
    : `${range.from} → ${range.to}`;

  const load = () => {
    const { from, to } = rangeRef.current;
    const months = monthsBetween(from, to);
    // The running entry lives in the current month's file — fetch it too
    const withNow = months.includes(nowMonth()) ? months : [...months, nowMonth()];
    Promise.all(withNow.map((m) => api.getTimeLog(m)))
      .then((rs) => {
        setEntries(rs.slice(0, months.length).flatMap((r) => r.entries)
          .filter((e) => e.date >= from && e.date <= to));
        setRunning(rs.map((r) => r.running).find(Boolean) || null);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load time log"));
  };

  useEffect(() => { load(); }, [range.from, range.to]);
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

  // Draft of the running entry's description; null = untouched
  const [runDesc, setRunDesc] = useState<string | null>(null);
  const saveRunDesc = async () => {
    const v = runDesc?.trim();
    if (!v || !running || v === running.text) { setRunDesc(null); return; }
    try { await api.adjustTime({ text: v }); setRunDesc(null); load(); announce(); }
    catch (err) { setError(err instanceof Error ? err.message : "Failed to rename"); }
  };

  const startEntry = async (text: string) => {
    try {
      await api.startTime(text);
      if (mode === "month") setMonth(nowMonth());
      else if (mode === "week") setWeekAnchor(toISODate(new Date()));
      load(); announce();
    }
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
      `# ${invoiceCompany} — ${periodLabel}`,
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
      // Latest entry first within each day — the recent one is what you look for
      .map(([d, es]) => [d, es.sort((a, b) => b.start.localeCompare(a.start))] as const);
  }, [visible]);

  const periodNav = (delta: number) => {
    if (mode === "week") {
      const d = new Date(weekAnchor + "T12:00:00");
      d.setDate(d.getDate() + delta * 7);
      setWeekAnchor(toISODate(d));
      return;
    }
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  // Donut data: top 7 + Other, colors follow the app's area colors when
  // grouping by area, the themed viz palette when grouping by company
  const [pieBy, setPieBy] = useState<"company" | "area">("company");
  const pie = useMemo(() => {
    const src = pieBy === "company" ? sums.byCompany : sums.byArea;
    const sorted = [...src.entries()].filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7);
    const rest = sorted.slice(7).reduce((n, [, m]) => n + m, 0);
    const rows: [string, number][] = rest > 0 ? [...top, ["Other", rest]] : top;
    return rows.map(([label, minutes], i) => ({
      label, minutes,
      color: pieBy === "area" ? ctxEdgeColor(label) : DONUT_COLORS[i % DONUT_COLORS.length],
    }));
  }, [sums, pieBy]);
  const pieTotal = pie.reduce((n, s) => n + s.minutes, 0);

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
              value={runDesc ?? running.text}
              onChange={(ev) => setRunDesc(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") saveRunDesc();
                if (ev.key === "Escape") setRunDesc(null);
              }}
              onBlur={saveRunDesc}
              title="Edit the description — saves when you press Enter or click away"
              className="flex-1 min-w-[10rem] text-sm font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
            />
            {runDesc !== null && runDesc.trim() && runDesc.trim() !== running.text && (
              <button
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={saveRunDesc}
                className="px-2 py-0.5 rounded text-xs font-medium text-white shrink-0"
                style={{ backgroundColor: "var(--accent)" }}
              >
                Save ↵
              </button>
            )}
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
        <div className="flex items-center gap-0.5 rounded-md p-0.5" style={{ backgroundColor: "var(--bg-tertiary)" }}>
          {(["week", "month", "custom"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${mode === m ? "text-white" : ""}`}
              style={mode === m ? { backgroundColor: "var(--accent)" } : { color: "var(--text-secondary)" }}>
              {m}
            </button>
          ))}
        </div>
        {mode !== "custom" ? (
          <>
            <button onClick={() => periodNav(-1)} className="px-1.5 rounded hover:bg-gray-100 text-gray-500">«</button>
            <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{periodLabel}</span>
            <button onClick={() => periodNav(1)} className="px-1.5 rounded hover:bg-gray-100 text-gray-500">»</button>
          </>
        ) : (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="px-1.5 py-0.5 rounded text-xs" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>→</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="px-1.5 py-0.5 rounded text-xs" style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          </>
        )}
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
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="rounded-lg p-3" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold" style={{ color: "var(--text)" }}>Distribution</h3>
            <div className="flex gap-0.5">
              {(["company", "area"] as const).map((k) => (
                <button key={k} onClick={() => setPieBy(k)}
                  className={`px-1.5 py-0.5 rounded text-[10px] capitalize ${pieBy === k ? "font-semibold" : ""}`}
                  style={pieBy === k ? { backgroundColor: "var(--bg-active-solid)", color: "var(--text)" } : { color: "var(--text-secondary)" }}>
                  {k}
                </button>
              ))}
            </div>
          </div>
          {pie.length === 0 ? (
            <p className="text-xs py-4 text-center" style={{ color: "var(--text-tertiary)" }}>No time in this period.</p>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Donut slices={pie} />
              <div className="w-full space-y-0.5">
                {pie.map((s) => (
                  <div key={s.label} className="flex items-center gap-1.5 text-[10px]">
                    <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ backgroundColor: s.color }} />
                    <span className="flex-1 truncate capitalize" style={{ color: "var(--text)" }}>{s.label}</span>
                    <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{fmtH(s.minutes, false)}</span>
                    <span className="font-mono w-7 text-right" style={{ color: "var(--text-tertiary)" }}>
                      {Math.round((s.minutes / (pieTotal || 1)) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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
            No entries for {periodLabel}{companyFilter || ctxSel.length ? " with these filters" : ""}.
          </p>
        )}
      </div>
    </div>
  );
}
