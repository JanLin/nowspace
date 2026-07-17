import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { api } from "../api";
import type { TimeEntry } from "../api";
import {
  type CtxName, type CtxMap, type CtxTags, type CtxSelection, DEFAULT_CTX_TAGS,
  ctxChipClass, ctxEdgeColor, allContextNames, resolveContext, ctxFeatureEnabled,
  taskVisibleInCtxSelection, loadCtxSelection, saveCtxSelection,
} from "../contexts";
import { normTime } from "../timefmt";
import { CLUSTER, CLUSTER_LABEL } from "../clusters";

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

/** "90", "90m", "1:30", "1h30", "1.5h" → minutes */
function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(\d+(?:\.\d+)?)\s*h$/);
  if (m) return Math.round(+m[1] * 60);
  m = s.match(/^(\d+)\s*h\s*(\d{1,2})\s*m?$/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/^(\d+)\s*m?$/);
  if (m) return +m[1];
  return null;
}

function addMinutesTo(start: string, mins: number): string {
  const [h, mm] = start.split(":").map(Number);
  const t = ((h * 60 + mm + mins) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/* Click-to-edit field: click shows an input, Enter/blur saves, Escape
   cancels. Uncontrolled (Samsung IME) — no Save buttons anywhere. */
function InlineEdit({ value, display, title, className, inputClassName, style, onSave }: {
  value: string;
  display: React.ReactNode;
  title: string;
  className?: string;
  inputClassName?: string;
  style?: React.CSSProperties;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  useEffect(() => {
    if (editing) { committed.current = false; ref.current?.focus(); ref.current?.select(); }
  }, [editing]);
  if (!editing) {
    return (
      <span onClick={() => setEditing(true)} title={title}
        className={`cursor-text hover:underline decoration-dotted underline-offset-2 ${className || ""}`}
        style={style}>
        {display}
      </span>
    );
  }
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const v = (ref.current?.value || "").trim();
    setEditing(false);
    if (v !== value) onSave(v);
  };
  return (
    <input ref={ref} defaultValue={value} autoComplete="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") commit();
        if (ev.key === "Escape") { committed.current = true; setEditing(false); }
      }}
      onBlur={commit}
      className={inputClassName || "w-16 px-1 py-0.5 rounded font-mono text-xs"}
      style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
  );
}

/* Donut palette — resolves via --viz-N CSS vars so dark mode swaps
   automatically (both palettes CVD/contrast-validated against the card
   surface; the legend carries the values as text). */
const DONUT_COLORS = Array.from({ length: 8 }, (_, i) => `var(--viz-${i + 1})`);

function Donut({ slices, onHover, onSelect }: {
  slices: { label: string; minutes: number; color: string }[];
  onHover?: (label: string | null) => void;
  onSelect?: (label: string) => void;
}) {
  const total = slices.reduce((n, s) => n + s.minutes, 0);
  const size = 120, r = 56, ir = 32, c = size / 2;
  if (!total) return null;
  if (slices.length === 1) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" className="shrink-0">
        <title>{slices[0].label}</title>
        <circle cx={c} cy={c} r={(r + ir) / 2} fill="none" stroke={slices[0].color} strokeWidth={r - ir}
          style={onSelect ? { cursor: "pointer" } : undefined}
          onMouseEnter={() => onHover?.(slices[0].label)} onMouseLeave={() => onHover?.(null)}
          onClick={() => onSelect?.(slices[0].label)} />
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
            fill={s.color} stroke="var(--bg-secondary)" strokeWidth="2"
            style={onSelect ? { cursor: "pointer" } : undefined}
            onMouseEnter={() => onHover?.(s.label)} onMouseLeave={() => onHover?.(null)}
            onClick={() => onSelect?.(s.label)}>
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



  // Invoice view
  const [invoiceCompany, setInvoiceCompany] = useState("");
  const [quarterRound, setQuarterRound] = useState(false);
  const [copied, setCopied] = useState(false);

  // The single entry row: idle = start/log form; running = live editor
  const entryDate = useRef<HTMLInputElement>(null);
  const entryStart = useRef<HTMLInputElement>(null);
  const entryEnd = useRef<HTMLInputElement>(null);
  const entryDur = useRef<HTMLInputElement>(null);
  const entryText = useRef<HTMLInputElement>(null);

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

  // Running-entry edits committed from the unified row
  const adjustRunningStart = async () => {
    const raw = (entryStart.current?.value || "").trim();
    const s = normTime(raw);
    if (!s) { setError(`"${raw}" is not a time — use HH:MM or HHMM (e.g. 1945)`); return; }
    if (running && s === running.start) return;
    try { await api.adjustTime({ start: s }); load(); announce(); }
    catch (err) { setError(err instanceof Error ? err.message : "Failed to adjust"); }
  };
  const adjustRunningText = async () => {
    const v = (entryText.current?.value || "").trim();
    if (!v || (running && v === running.text)) return;
    try { await api.adjustTime({ text: v }); load(); announce(); }
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
    if (companyFilter) {
      // "(no company)" filters to entries WITHOUT a company prefix
      const match = companyFilter === "(no company)"
        ? company === ""
        : company.toLowerCase() === companyFilter.toLowerCase();
      if (!match) return false;
    }
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
    const byAreaGroups = new Map<string, Map<string, number>>();
    visible.forEach((e) => {
      const { company, sub } = parseEntry(e.text);
      const area = resolveContext(`${company}: x`, ctxMap, ctxTags);
      byArea.set(area, (byArea.get(area) || 0) + e.minutes);
      const c = company || "(no company)";
      byCompany.set(c, (byCompany.get(c) || 0) + e.minutes);
      if (!bySub.has(c)) bySub.set(c, new Map());
      const s = sub || "(general)";
      bySub.get(c)!.set(s, (bySub.get(c)!.get(s) || 0) + e.minutes);
      if (!byAreaGroups.has(area)) byAreaGroups.set(area, new Map());
      byAreaGroups.get(area)!.set(c, (byAreaGroups.get(area)!.get(c) || 0) + e.minutes);
    });
    return { byArea, byCompany, bySub, byAreaGroups, total: visible.reduce((n, e) => n + e.minutes, 0) };
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

  const patchEntry = async (e: TimeEntry, fields: { start?: string; end?: string | null; text?: string }) => {
    try {
      await api.updateTimeEntry({
        date: e.date,
        index: dayIndexOf(e),
        start: fields.start ?? e.start,
        end: fields.end === undefined ? e.end : fields.end,
        text: fields.text ?? e.text,
      });
      load(); announce();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to update"); }
  };

  const saveStart = (e: TimeEntry, raw: string) => {
    const s = normTime(raw);
    if (!s) { setError(`"${raw}" is not a time — use HH:MM or HHMM (e.g. 1945)`); return; }
    patchEntry(e, { start: s });
  };

  const saveEnd = (e: TimeEntry, raw: string) => {
    if (!raw.trim()) { patchEntry(e, { end: null }); return; }
    const s = normTime(raw);
    if (!s) { setError(`"${raw}" is not a time — use HH:MM or HHMM (e.g. 1945)`); return; }
    patchEntry(e, { end: s });
  };

  const saveDuration = (e: TimeEntry, raw: string) => {
    const mins = parseDuration(raw);
    if (mins == null || mins <= 0) { setError(`"${raw}" is not a duration — use minutes (90), H:MM (1:30) or 1h30`); return; }
    patchEntry(e, { end: addMinutesTo(e.start, mins) });
  };

  const saveText = (e: TimeEntry, raw: string) => {
    if (raw.trim()) patchEntry(e, { text: raw.trim() });
  };

  // Moving to another date = delete here + re-add there (handles months)
  const moveEntryDate = async (e: TimeEntry, newDate: string) => {
    if (!newDate || newDate === e.date) return;
    try {
      await api.updateTimeEntry({ date: e.date, index: dayIndexOf(e), start: e.start, end: e.end, text: e.text, delete: true });
      await api.addTimeEntry({ date: newDate, start: e.start, end: e.end, text: e.text });
      load(); announce();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to move entry"); }
  };

  // One button: with an end or duration it logs a finished entry on the
  // chosen date; without, it starts tracking now (back-dating the start
  // when one was typed).
  const submitEntry = async () => {
    const text = (entryText.current?.value || "").trim();
    if (!text) { setError("Describe the activity first"); return; }
    const date = entryDate.current?.value || toISODate(new Date());
    const startRaw = (entryStart.current?.value || "").trim();
    const endRaw = (entryEnd.current?.value || "").trim();
    const durRaw = (entryDur.current?.value || "").trim();
    const start = startRaw ? normTime(startRaw) : null;
    if (startRaw && !start) { setError(`"${startRaw}" is not a time — use HH:MM or HHMM`); return; }
    const clear = () => [entryStart, entryEnd, entryDur, entryText].forEach((r) => { if (r.current) r.current.value = ""; });
    if (endRaw || durRaw) {
      if (!start) { setError("A finished entry needs a start time"); return; }
      let end: string | null = null;
      if (endRaw) {
        end = normTime(endRaw);
        if (!end) { setError(`"${endRaw}" is not a time — use HH:MM or HHMM`); return; }
      } else {
        const mins = parseDuration(durRaw);
        if (mins == null || mins <= 0) { setError(`"${durRaw}" is not a duration — use minutes (90), H:MM (1:30) or 1h30`); return; }
        end = addMinutesTo(start, mins);
      }
      try { await api.addTimeEntry({ date, start, end, text }); clear(); load(); announce(); }
      catch (err) { setError(err instanceof Error ? err.message : "Failed to add entry"); }
      return;
    }
    if (date !== toISODate(new Date())) { setError("A past entry needs an end time or duration"); return; }
    try {
      await api.startTime(text);
      if (start) await api.adjustTime({ start });
      clear(); load(); announce();
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to start"); }
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
  const [hoverSlice, setHoverSlice] = useState<string | null>(null);
  // Tapped slice: pins its breakdown open AND filters the entries — the
  // touch-first gesture; hover stays as a free preview on desktop
  const [expandedSlice, setExpandedSlice] = useState<string | null>(null);
  // Pinned = stuck to the bottom of the screen while entries scroll above
  const [pinDistribution, setPinDistribution] = useState(true);
  useEffect(() => { setHoverSlice(null); setExpandedSlice(null); }, [pieBy, range.from, range.to]);
  const shownSlice = hoverSlice ?? expandedSlice;
  const breakdown = useMemo(() => {
    if (!shownSlice) return null;
    const m = pieBy === "company" ? sums.bySub.get(shownSlice) : sums.byAreaGroups.get(shownSlice);
    if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [shownSlice, pieBy, sums]);
  const selectSlice = (label: string) => {
    if (label === "Other") return;
    const off = expandedSlice === label;
    setExpandedSlice(off ? null : label);
    if (pieBy === "company") setCompanyFilter(off ? "" : label);
    else toggleCtx(label);
  };

  void tick;

  return (
    <div className="space-y-5 pb-12">
      {error && <div className="p-2 bg-red-50 text-red-700 rounded text-xs">{error}</div>}

      {/* One entry row — idle: start or log; running: live editor */}
      <div key={running ? `run-${running.start}|${running.text}` : "idle"}
        className="rounded-lg p-3" style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
        <div className="flex items-center gap-1.5 flex-wrap">
          {running && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />}
          <input ref={entryDate} type="date" defaultValue={running ? running.date : toISODate(new Date())} disabled={!!running}
            className="px-1.5 py-1 rounded text-xs disabled:opacity-40"
            style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          <input ref={entryStart} placeholder="start (= now)" autoComplete="off" defaultValue={running ? running.start : ""}
            onKeyDown={running ? (ev) => { if (ev.key === "Enter") adjustRunningStart(); } : undefined}
            onBlur={running ? adjustRunningStart : undefined}
            title={running ? "Started earlier? Type the real start time and press Enter" : "Leave empty to start now"}
            className="w-24 px-1.5 py-1 rounded text-xs font-mono"
            style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          <input ref={entryEnd} placeholder="end" autoComplete="off" disabled={!!running}
            className="w-16 px-1.5 py-1 rounded text-xs font-mono disabled:opacity-40"
            style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          {running ? (
            <span className="w-16 text-center text-xs font-mono py-1" style={{ color: "var(--text-secondary)" }}>{fmtH(running.minutes, false)}h</span>
          ) : (
            <input ref={entryDur} placeholder="dur 1:30" autoComplete="off"
              className="w-16 px-1.5 py-1 rounded text-xs font-mono"
              style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          )}
          <input ref={entryText} placeholder="what are you doing… (Company/Sub: works inline)" defaultValue={running ? running.text : ""}
            autoComplete="off" autoCorrect="off" spellCheck={false}
            onKeyDown={(ev) => { if (ev.key === "Enter") { if (running) adjustRunningText(); else submitEntry(); } }}
            onBlur={running ? adjustRunningText : undefined}
            className="flex-1 min-w-[10rem] px-2 py-1 rounded text-xs font-medium"
            style={{ backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />
          {running ? (
            <button onClick={stopEntry} className="px-2.5 py-1 rounded bg-red-100 text-red-700 text-xs font-medium hover:bg-red-200 shrink-0">■ Stop</button>
          ) : (
            <button onClick={submitEntry} className="px-2.5 py-1 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700 shrink-0">▶ Start</button>
          )}
        </div>
        {!running && (
          <p className="text-[10px] mt-1" style={{ color: "var(--text-tertiary)" }}>
            Empty start = now. Fill an end time or duration to log a finished activity instead — Start becomes a plain add.
          </p>
        )}
      </div>

      {/* Month nav + filters (same chips as the Plan tab) */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 flex-wrap rounded-lg px-1.5 py-1" style={CLUSTER.view}>
        <span className={CLUSTER_LABEL} style={{ color: "var(--text-tertiary)" }}>View</span>
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
        </span>
        {ctxEnabled && (
        <span className="flex items-center gap-1 flex-wrap rounded-lg px-1.5 py-1" style={CLUSTER.tag}>
        <span className={CLUSTER_LABEL} style={{ color: "var(--text-tertiary)" }}>Tag</span>
        {allContextNames(ctxMap, ctxTags).filter((n) =>
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
          <button onClick={() => { setCtxSelState([]); saveCtxSelection([]); }}
            className={`px-2 py-0.5 rounded text-xs font-medium ${ctxSel.length === 0 ? "bg-gray-200 text-gray-700" : ""}`}
            style={ctxSel.length !== 0 ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}>
            All
          </button>
        </span>
        )}
        <span className="flex items-center gap-1 rounded-lg px-1.5 py-1" style={CLUSTER.filter}>
        <span className={CLUSTER_LABEL} style={{ color: "var(--text-tertiary)" }}>Filter</span>
        <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}
          className="px-1.5 py-0.5 rounded text-xs" style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "none" }}>
          <option value="">All companies</option>
          <option value="(no company)">(no company)</option>
          {companies.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        </span>
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
                return (
                  <div key={key} className="group flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-gray-50"
                    style={{ boxShadow: `inset 2px 0 0 ${ctxEdgeColor(area)}` }}>
                    <span className="font-mono shrink-0 flex items-center gap-0.5" style={{ color: "var(--text-secondary)" }}>
                      <InlineEdit value={e.start} display={e.start} title="Click to edit start time"
                        onSave={(v) => saveStart(e, v)} />
                      –
                      <InlineEdit value={e.end || ""} display={e.end || "…"} title="Click to edit end time (empty = running)"
                        onSave={(v) => saveEnd(e, v)} />
                    </span>
                    <InlineEdit value={fmtH(e.minutes, false)} display={fmtH(e.minutes, false)}
                      title="Click to set duration (90, 1:30 or 1h30) — adjusts the end time"
                      className="font-mono shrink-0" style={{ color: "var(--text-tertiary)" }}
                      inputClassName="w-12 px-1 py-0.5 rounded font-mono text-xs"
                      onSave={(v) => saveDuration(e, v)} />
                    <InlineEdit value={e.text} display={e.text} title="Click to edit description"
                      className="flex-1 truncate" style={{ color: "var(--text)" }}
                      inputClassName="flex-1 min-w-0 w-full px-1.5 py-0.5 rounded text-xs"
                      onSave={(v) => saveText(e, v)} />
                    <span className="relative w-4 h-4 shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100" title="Move to another date">
                      <span style={{ color: "var(--text-secondary)" }}>📅</span>
                      <input type="date" defaultValue={e.date}
                        onChange={(ev) => moveEntryDate(e, ev.target.value)}
                        className="absolute inset-0 w-4 h-4 opacity-0 cursor-pointer" />
                    </span>
                    <button onClick={() => startEntry(e.text)} title="Continue this activity now"
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-green-600">▶</button>
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

      {/* Distribution — pinned to the screen bottom while entries scroll;
          the 📌 lets it flow with the page like the other pinnable bars */}
      <div className={pinDistribution ? "sticky bottom-0 z-20 rounded-lg p-3" : "rounded-lg p-3"}
        style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)",
          ...(pinDistribution ? { boxShadow: "0 -4px 12px rgba(0,0,0,0.18)" } : {}) }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold" style={{ color: "var(--text)" }}>Distribution — total {fmtH(pieTotal, false)}h</h3>
          <div className="flex items-center gap-0.5">
            {(["company", "area"] as const).map((k) => (
              <button key={k} onClick={() => setPieBy(k)}
                className={`px-1.5 py-0.5 rounded text-[10px] capitalize ${pieBy === k ? "font-semibold" : ""}`}
                style={pieBy === k ? { backgroundColor: "var(--bg-active-solid)", color: "var(--text)" } : { color: "var(--text-secondary)" }}>
                {k}
              </button>
            ))}
            <button onClick={() => setPinDistribution(!pinDistribution)}
              className={`px-1 py-0.5 rounded text-[11px] transition-colors ${pinDistribution ? "text-blue-400 hover:text-blue-600" : "text-gray-400 hover:text-gray-600"}`}
              title={pinDistribution ? "Unpin — scroll with the page" : "Pin to the bottom of the screen"}>
              {pinDistribution ? "✦" : "✧"}
            </button>
          </div>
        </div>
        {pie.length === 0 ? (
          <div className="text-xs py-4 text-center space-y-2" style={{ color: "var(--text-tertiary)" }}>
            <p>No time in this period{companyFilter || ctxSel.length ? " with these filters" : ""}.</p>
            {(companyFilter || ctxSel.length > 0) && (
              <button
                onClick={() => { setCompanyFilter(""); setCtxSelState([]); saveCtxSelection([]); setExpandedSlice(null); }}
                className="px-2 py-1 rounded text-[10px] font-medium text-white"
                style={{ backgroundColor: "var(--accent)" }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-4">
            <Donut slices={pie} onHover={setHoverSlice} onSelect={selectSlice} />
            <div className="flex-1 min-w-0 space-y-0.5">
              {pie.map((s) => (
                <div key={s.label}>
                  <div onClick={() => selectSlice(s.label)}
                    onMouseEnter={() => setHoverSlice(s.label)} onMouseLeave={() => setHoverSlice(null)}
                    className={`flex items-center gap-1.5 text-[10px] cursor-pointer hover:opacity-80 rounded px-0.5 ${expandedSlice === s.label ? "font-semibold" : ""}`}
                    style={expandedSlice === s.label ? { backgroundColor: "var(--bg-tertiary)" } : undefined}
                    title={s.label === "Other" ? undefined : "Tap to filter the entries and show the breakdown"}>
                    <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ backgroundColor: s.color }} />
                    <span className="flex-1 truncate capitalize" style={{ color: "var(--text)" }}>
                      {s.label !== "Other" && <span className="mr-0.5" style={{ color: "var(--text-tertiary)" }}>{expandedSlice === s.label ? "▾" : "▸"}</span>}
                      {s.label}
                    </span>
                    <span className="font-mono" style={{ color: "var(--text-secondary)" }}>{fmtH(s.minutes, false)}</span>
                    <span className="font-mono w-7 text-right" style={{ color: "var(--text-tertiary)" }}>
                      {Math.round((s.minutes / (pieTotal || 1)) * 100)}%
                    </span>
                  </div>
                  {shownSlice === s.label && breakdown && (
                    <div className="ml-4 border-l pl-2 py-0.5" style={{ borderColor: "var(--border)" }}>
                      {breakdown.map(([name, mins]) => (
                        <div key={name} className="flex items-center gap-1.5 text-[10px]">
                          <span className="flex-1 truncate" style={{ color: "var(--text-secondary)" }}>{name}</span>
                          <span className="font-mono" style={{ color: "var(--text-tertiary)" }}>{fmtH(mins, false)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-[10px] mt-2" style={{ color: "var(--text-tertiary)" }}>
          Tap a slice or row to filter the entries and expand {pieBy === "company" ? "its sub-projects" : "its groups"}; tap again to clear.
        </p>
      </div>

    </div>
  );
}
