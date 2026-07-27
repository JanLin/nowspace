import React, { useState, useRef, useEffect } from "react";
import { api } from "../api";
import type { BucketTask, BucketResponse, TaskLink, BucketStage, FunnelSettings } from "../api";
import TaskCheck from "./TaskCheck";
import { Cluster } from "../clusters";
import {
  STAGE_META, ESTIMATES, stageOf, applyResolution, type StageResolution,
  BindDialog, ReadyDialog, DormantDialog, DiscardDialog, EvictionDialog, WeeklyReview,
  FunnelStatsModal,
} from "./Funnel";
import HandoffSurface, { DispatchComposer } from "./Handoff";

// Same annotation as the Plan tab; "-" = unassigned
const PRIORITIES = ["A", "B", "C", "D"] as const;
const HORIZONS: [string, string][] = [["n", "this week"], ["nw", "next week"], ["m", "next month"]];
const PRIORITY_BADGE: Record<string, string> = {
  A: "bg-red-100 text-red-700",
  B: "bg-amber-100 text-amber-700",
  C: "bg-green-100 text-green-700",
  D: "bg-gray-100 text-gray-500",
};
import NoteFilePicker from "./NoteFilePicker";
import {
  type CtxName, type CtxMap, type CtxTags, type CtxSelection, DEFAULT_CTX_TAGS,
  ctxChipClass, ctxEdgeColor, allContextNames, resolveContext,
  stripCtxTokens, stripGroupCtxTag, ctxFeatureEnabled,
  taskVisibleInCtxSelection, loadCtxSelection, saveCtxSelection,
  stripBucketMeta, bucketEnteredWeek, bucketAgeKey, isMonthHorizon, setMonthHorizon,
  BUCKET_META_RE, bucketAnchorKey,
} from "../contexts";
import VaultBrowser, { type VaultBrowserState } from "./VaultBrowser";

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/* ── helpers ────────────────────────────────────────────────── */

function parseGroup(rawText: string): { group: string; label: string } {
  const text = stripGroupCtxTag(rawText);
  const idx = text.indexOf(":");
  if (idx > 1 && idx < 30) {
    const group = text.slice(0, idx).trim();
    const label = text.slice(idx + 1).trim();
    if (group && group.length > 1 && label && !/^[A-Da-d]\d*$/.test(group) && !group.includes("[") && !group.endsWith("http") && !group.endsWith("https"))
      return { group, label };
  }
  return { group: "", label: text };
}

/** Extract wiki links from text */
function extractLinks(text: string): TaskLink[] {
  const links: TaskLink[] = [];
  const re = new RegExp(WIKI_LINK_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    links.push({ name: m[1].trim(), display_text: m[2]?.trim() });
  }
  return links;
}

/** Render text with wiki links and markdown hyperlinks as clickable elements.
    Exported — the Slate reuses it for solve questions' linked notes. */
export function renderWikiText(text: string, onOpenNote?: (path: string, name: string) => void) {
  // Combined regex: wiki links [[...]] and markdown links [text](url)
  const COMBINED_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = COMBINED_RE.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(<span key={`t-${match.index}`}>{text.slice(lastIdx, match.index)}</span>);

    if (match[1] !== undefined) {
      // Wiki link [[name|display]]
      const name = match[1].trim();
      const display = match[2]?.trim() || name;
      parts.push(
        <a
          key={`wl-${match.index}`}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // vaultResolve (not search): it re-indexes on a miss, so a note
            // created moments ago in Obsidian or synced in still opens
            api.vaultResolve(name).then((res) => {
              if (res.path && onOpenNote) onOpenNote(res.path, res.name || name);
            }).catch(() => {});
          }}
          className="inline-flex items-center gap-0.5 px-1.5 py-0 bg-blue-50 text-blue-700 rounded text-[11px] font-medium hover:bg-blue-100 transition-colors"
          title={`Open ${name}`}
        >
          {display}
        </a>
      );
    } else {
      // Markdown link [text](url)
      const linkText = match[3];
      const linkUrl = match[4];
      parts.push(
        <a
          key={`ml-${match.index}`}
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="text-blue-600 underline hover:text-blue-800"
        >
          {linkText}
        </a>
      );
    }
    lastIdx = COMBINED_RE.lastIndex;
  }
  if (lastIdx < text.length) parts.push(<span key="end">{text.slice(lastIdx)}</span>);
  if (parts.length === 0) return <>{text}</>;
  return <>{parts}</>;
}

/* ── Auto-focus input ──────────────────────────────────────── */

function AutoFocusInput({ onSubmit, onCancel, placeholder, className }: {
  onSubmit: (v: string) => void; onCancel: () => void; placeholder?: string; className?: string;
}) {
  // Uncontrolled: Samsung/GBoard IME composition desyncs when React writes
  // `value` per keystroke (backspace gets swallowed) — the DOM owns the text
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { const t = (ref.current?.value || "").trim(); if (t) { onSubmit(t); if (ref.current) ref.current.value = ""; } else onCancel(); };
  return (
    <input ref={ref} type="text" defaultValue="" autoComplete="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); if (e.key === "Escape") onCancel(); }}
      onBlur={submit} placeholder={placeholder} className={className} />
  );
}

function EditInput({ initialValue, onSave, onCancel, className, style }: {
  initialValue: string; onSave: (v: string) => void; onCancel: () => void; className?: string; style?: React.CSSProperties;
}) {
  // Uncontrolled — see AutoFocusInput for the Samsung IME rationale
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = () => { const t = (ref.current?.value || "").trim(); if (t && t !== initialValue) onSave(t); else onCancel(); };
  return (
    <input ref={ref} type="text" defaultValue={initialValue} autoComplete="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) save(); if (e.key === "Escape") onCancel(); }}
      onBlur={save} className={className} style={style} />
  );
}

/* ── Bucket component ──────────────────────────────────────── */

type Section = { name: string; items: { task: BucketTask; originalIdx: number; label: string }[] };

export default function Bucket({ onOpenNote }: { onOpenNote: (path: string, name: string) => void }) {
  const [data, setData] = useState<BucketResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [openCluster, setOpenCluster] = useState<"tag" | "view" | "filter" | null>(null);
  const toggleCluster = (k: "tag" | "view" | "filter") => setOpenCluster((prev) => (prev === k ? null : k));

  // ── Funnel state ──────────────────────────────────────────
  const [funnel, setFunnel] = useState<FunnelSettings | null>(null);
  const bindingLimit = funnel?.binding_limit ?? 4;
  // "" = active pipeline (captured + ready); dormant/discarded only on request
  const [stageFilter, setStageFilter] = useState<"" | BucketStage>("");
  const [stageDialog, setStageDialog] = useState<{ idx: number; kind: "bind" | "ready" | "dormant" | "discard" } | null>(null);
  const [evictionFor, setEvictionFor] = useState<number | null>(null); // idx of item waiting for a Binding slot
  const [reviewOpen, setReviewOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [composerFor, setComposerFor] = useState<{ idx: number; area: string } | null>(null);

  // Context filter — follows the selection set in the week view (shared via localStorage)
  const [ctxMap, setCtxMap] = useState<CtxMap>({});
  const [ctxTags, setCtxTags] = useState<CtxTags>(DEFAULT_CTX_TAGS);
  const [ctxSel, setCtxSelState] = useState<CtxSelection>(loadCtxSelection);
  const ctxEnabled = ctxFeatureEnabled(ctxMap);
  const setCtxSel = (sel: CtxSelection) => { setCtxSelState(sel); saveCtxSelection(sel); };
  // Functional update so rapid successive toggles never work from stale state
  const toggleCtx = (name: CtxName) => {
    setCtxSelState((prev) => {
      const next = prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name];
      saveCtxSelection(next);
      return next;
    });
  };
  useEffect(() => {
    const load = () => api.getSettings().then((s) => {
      setCtxMap(s.contexts || {});
      setCtxTags({ ...DEFAULT_CTX_TAGS, ...(s.context_tags || {}) });
      if (s.funnel) setFunnel(s.funnel);
    }).catch(() => {});
    load();
    const sync = () => setCtxSelState(loadCtxSelection());
    window.addEventListener("ctx-mode-changed", sync);
    window.addEventListener("ctx-config-changed", load);
    return () => {
      window.removeEventListener("ctx-mode-changed", sync);
      window.removeEventListener("ctx-config-changed", load);
    };
  }, []);
  const taskVisibleInMode = (text: string): boolean => taskVisibleInCtxSelection(text, ctxSel, ctxMap, ctxTags);

  // GTD board view: file bucket tasks into This week / Next week / This month / Backlog
  const [boardView, setBoardView] = useState(() => localStorage.getItem("nowspace-bucket-board") === "1");
  const toggleBoardView = () => {
    setBoardView((v) => { localStorage.setItem("nowspace-bucket-board", v ? "0" : "1"); return !v; });
  };
  // Tasks filed to a week this session (labels only, for visible progress)
  const [pinFilters, setPinFilters] = useState(true);
  const [addingAt, setAddingAt] = useState<{ afterIdx: number; group?: string } | null>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const [prioMenu, setPrioMenu] = useState<number | null>(null);
  // Any click outside the badge/menu dismisses the picker — the wrapper
  // spans carry .prio-pop so clicks inside the menu don't self-close
  useEffect(() => {
    if (prioMenu === null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".prio-pop")) setPrioMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [prioMenu]);
  const [horizonFilter, setHorizonFilter] = useState<"" | "n" | "nw" | "m" | "none">("");
  const [editingTask, setEditingTask] = useState<number | null>(null);
  const [groupPicker, setGroupPicker] = useState<number | null>(null);
  const [breakdownIdx, setBreakdownIdx] = useState<number | null>(null);
  const [addSubAfter, setAddSubAfter] = useState<number | null>(null); // insert after this sub-task index
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<number>>(new Set());
  const [editingSubtask, setEditingSubtask] = useState<{ taskIdx: number; subIdx: number } | null>(null);
  const [subDropTarget, setSubDropTarget] = useState<{ taskIdx: number; subIdx: number } | null>(null);
  const [notePicker, setNotePicker] = useState<{
    idx: number; group: string; links: TaskLink[];
    pos: { top: number; left: number };
  } | null>(null);
  // Groups collapse by default (accordion, like the bucket panel) so the
  // tab isn't one endless list; the expanded set persists across visits.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem("bucket-expanded-groups") || "[]")); }
    catch { return new Set<string>(); }
  });
  const persistExpanded = (s: Set<string>) => {
    try { localStorage.setItem("bucket-expanded-groups", JSON.stringify([...s])); } catch { /* private mode */ }
    return s;
  };
  const isGroupCollapsed = (name: string) => !expandedGroups.has(name);
  const expandGroup = (name: string) =>
    setExpandedGroups((prev) => persistExpanded(new Set(prev).add(name)));
  const [vaultBrowserOpen, setVaultBrowserOpen] = useState(false);
  const vaultBrowserStateRef = useRef<VaultBrowserState | null>(null);
  const dragRef = useRef<{ fromIdx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [dropGroupTarget, setDropGroupTarget] = useState<string | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Undo / Redo
  type UndoEntry = { tasks: BucketTask[]; pinned_groups: string[] };
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const MAX_UNDO = 40;
  const [undoCount, setUndoCount] = useState(0);

  const pushUndo = () => {
    if (!data) return;
    undoStack.current.push({
      tasks: JSON.parse(JSON.stringify(data.tasks)),
      pinned_groups: [...data.pinned_groups],
    });
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
  };

  const performUndo = async () => {
    if (!data || undoStack.current.length === 0) return;
    const entry = undoStack.current.pop()!;
    redoStack.current.push({
      tasks: JSON.parse(JSON.stringify(data.tasks)),
      pinned_groups: [...data.pinned_groups],
    });
    setData({ tasks: entry.tasks, pinned_groups: entry.pinned_groups });
    setUndoCount(undoStack.current.length);
    try {
      const res = await api.saveBucket(entry.tasks, entry.pinned_groups, lastKnownMtime.current);
      if (res.mtime) lastKnownMtime.current = res.mtime; else recordMtime();
    } catch (e) {
      if (e instanceof Error && e.message.includes("changed on disk")) setExternalChange(true);
      /* otherwise auto-save will retry */
    }
  };

  const performRedo = async () => {
    if (!data || redoStack.current.length === 0) return;
    const entry = redoStack.current.pop()!;
    undoStack.current.push({
      tasks: JSON.parse(JSON.stringify(data.tasks)),
      pinned_groups: [...data.pinned_groups],
    });
    setData({ tasks: entry.tasks, pinned_groups: entry.pinned_groups });
    setUndoCount(undoStack.current.length);
    try {
      const res = await api.saveBucket(entry.tasks, entry.pinned_groups, lastKnownMtime.current);
      if (res.mtime) lastKnownMtime.current = res.mtime; else recordMtime();
    } catch (e) {
      if (e instanceof Error && e.message.includes("changed on disk")) setExternalChange(true);
      /* otherwise auto-save will retry */
    }
  };

  // Ctrl+Z / Ctrl+Shift+Z keyboard listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) performRedo(); else performUndo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "y") { e.preventDefault(); performRedo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [data]);

  // External file change detection
  const lastKnownMtime = useRef<number | null>(null);
  const [externalChange, setExternalChange] = useState(false);

  const recordMtime = async () => {
    try { const r = await api.getBucketModified(); lastKnownMtime.current = r.mtime; } catch { /* ignore */ }
  };

  useEffect(() => {
    const check = async () => {
      if (document.hidden || !data) return;
      try {
        const r = await api.getBucketModified();
        if (r.mtime && lastKnownMtime.current && r.mtime > lastKnownMtime.current) {
          // Clean tab reloads silently; unsaved edits or active typing keep the banner
          const el = document.activeElement as HTMLElement | null;
          const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
          if (dirty || typing) setExternalChange(true);
          else fetchBucket();
        }
      } catch { /* ignore */ }
    };
    const onVisChange = () => { if (!document.hidden) check(); };
    const onFocus = () => check();
    document.addEventListener("visibilitychange", onVisChange);
    window.addEventListener("focus", onFocus);
    const poll = setInterval(check, 30000);
    return () => {
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [data, dirty]);

  const fetchBucket = async () => {
    setLoading(true); setError(""); setExternalChange(false);
    try { setData(await api.getBucket()); setDirty(false); recordMtime(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load bucket"); }
    finally { setLoading(false); }
  };

  const saveBucket = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await api.saveBucket(data.tasks, data.pinned_groups, lastKnownMtime.current);
      setSaved(true); setDirty(false); setExternalChange(false);
      if (res.mtime) lastKnownMtime.current = res.mtime; else recordMtime();
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save";
      // Changed on another device / in Obsidian — don't clobber; banner offers Reload
      if (msg.includes("changed on disk")) { setExternalChange(true); }
      else {
        setError(msg);
        // Funnel gate refusals (422) would otherwise loop the 2s auto-save
        // forever — revert the offending change and keep the message visible.
        if (/Binding holds|needs|unknown stage|unknown mode/.test(msg) && undoStack.current.length > 0) {
          const entry = undoStack.current.pop()!;
          setData({ tasks: entry.tasks, pinned_groups: entry.pinned_groups });
          setUndoCount(undoStack.current.length);
          setDirty(false);
        }
        // Version skew: every retry would fail identically — stop the loop
        // and leave the explanation on screen (App shows the banner too).
        if (msg.includes("out of date")) setDirty(false);
      }
    }
    finally { setSaving(false); }
  };

  // Auto-save: 2s debounce
  useEffect(() => {
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    if (dirty && !saving && data && !externalChange) {
      autoSaveTimerRef.current = setTimeout(saveBucket, 2000);
    }
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [dirty, saving, data, externalChange]);

  useEffect(() => { fetchBucket(); }, []);

  useEffect(() => {
    const handler = () => { fetchBucket(); };
    window.addEventListener("bucket-changed", handler);
    return () => window.removeEventListener("bucket-changed", handler);
  }, []);

  // Task search reveal: make the item visible (right stage lens, list view,
  // group expanded), then scroll to it and flash.
  useEffect(() => {
    const reveal = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || d.source !== "bucket") return;
      setFilterGroup(null);
      setHorizonFilter("");
      const st = d.stage || "captured";
      // dormant/discarded are silent by default — switch the lens to them;
      // binding lives in the always-visible strip; the rest is the default view
      setStageFilter(st === "dormant" || st === "discarded" ? st : "");
      if (boardView) toggleBoardView();
      if (d.group) expandGroup(d.group);
      const locate = () => document.querySelector(`[data-task-anchor="${CSS.escape(`bucket:${d.key}`)}"]`);
      const flash = (el: HTMLElement) => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.transition = "box-shadow 0.3s";
        el.style.boxShadow = "0 0 0 2px var(--accent)";
        el.style.borderRadius = "8px";
        setTimeout(() => { el.style.boxShadow = ""; }, 2200);
      };
      setTimeout(() => {
        const el = locate();
        if (el instanceof HTMLElement) { flash(el); return; }
        // stale local data — the search saw fresher state; reload and retry
        window.dispatchEvent(new CustomEvent("bucket-changed"));
        setTimeout(() => {
          const el2 = locate();
          if (el2 instanceof HTMLElement) flash(el2);
        }, 700);
      }, 250);
    };
    window.addEventListener("nowspace-reveal", reveal);
    return () => window.removeEventListener("nowspace-reveal", reveal);
  }, [boardView]);

  if (!data) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <button onClick={fetchBucket} disabled={loading}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50">
            {loading ? "Loading..." : "Load Bucket"}
          </button>
        </div>
        {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}
        <p className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>No bucket loaded</p>
      </div>
    );
  }

  const tasks = data.tasks;

  /* ── task operations ─────────────────────────────────── */

  const updateTasks = (newTasks: BucketTask[]) => {
    pushUndo();
    setData({ ...data, tasks: newTasks });
    setDirty(true);
  };

  const addTask = (afterIdx: number, text: string, group?: string) => {
    const fullText = group ? `${group}: ${text}` : text;
    // Capture is never judged: new items are always captured, no required fields
    const newTask: BucketTask = { text: fullText, priority: "", focused: false, waiting: false, subtasks: [], stage: "captured" };
    const next = [...tasks];
    next.splice(afterIdx + 1, 0, newTask);
    updateTasks(next);
    setAddingAt(null);
  };

  // Quick-add from the top bar: "Group: task" files under that group,
  // reusing an existing group's casing; plain text lands un-grouped.
  const quickAdd = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const { group, label } = parseGroup(text);
    let canonical = group;
    if (group) {
      const existing = tasks.map((t) => parseGroup(t.text).group)
        .find((g) => g && g.toLowerCase() === group.toLowerCase());
      if (existing) canonical = existing;
    }
    const newTask: BucketTask = {
      text: canonical ? `${canonical}: ${label}` : text,
      priority: "", focused: false, waiting: false, subtasks: [], stage: "captured",
    };
    // Keep groups contiguous: insert after the group's last task
    let insertAfter = tasks.length - 1;
    if (canonical) {
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (parseGroup(tasks[i].text).group.toLowerCase() === canonical.toLowerCase()) { insertAfter = i; break; }
      }
    }
    const next = [...tasks];
    next.splice(insertAfter + 1, 0, newTask);
    updateTasks(next);
    if (canonical && isGroupCollapsed(canonical)) expandGroup(canonical);
  };

  const setPriority = (idx: number, p: string) => {
    const next = [...tasks];
    // Clearing the priority also clears the horizon (the prefix rides the letter)
    next[idx] = { ...next[idx], priority: p, horizon: p ? next[idx].horizon : "" };
    updateTasks(next);
    setPrioMenu(null);
  };

  const setTaskHorizon = (idx: number, h: string) => {
    const next = [...tasks];
    // A horizon needs a letter to ride on — default to C
    next[idx] = { ...next[idx], horizon: h, priority: next[idx].priority || (h ? "C" : next[idx].priority) };
    updateTasks(next);
    setPrioMenu(null);
  };

  const deleteTask = (idx: number) => {
    const next = [...tasks];
    next.splice(idx, 1);
    updateTasks(next);
  };

  const editTask = (idx: number, newText: string) => {
    const next = [...tasks];
    const old = next[idx];
    const { group } = parseGroup(old.text);
    // The edit input shows the label with @tokens stripped — re-append the
    // original tokens unless the user typed their own into the new text.
    let text = newText;
    if (!/@(w|v|p|pin)\b/i.test(text)) {
      const oldTokens = old.text.match(/\s*@(w|v|p|pin)\b/gi);
      if (oldTokens) text = `${text} ${oldTokens.map((t) => t.trim()).join(" ")}`;
    }
    // Tilde metadata (~id identity, ~w age) is hidden from the edit input —
    // re-append it so a rename never resets the item's age or, worse, its
    // identity (a lost ~id makes the save gate treat it as a new item).
    const meta = old.text.match(new RegExp(BUCKET_META_RE.source, "gi"));
    if (meta) text = `${text} ${meta.map((t) => t.trim()).join(" ")}`;
    next[idx] = { ...old, text: group ? `${group}: ${text}` : text };
    updateTasks(next);
    setEditingTask(null);
  };

  // One picker for both views — list rows and board cards open the same menu.
  // withPlan adds a day row (board cards have no separate → Plan affordance)
  const prioHorizonMenu = (task: BucketTask, idx: number, withPlan = false) => (
    <div className="absolute left-0 top-full mt-0.5 z-20 rounded shadow-md p-1 space-y-1" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex gap-0.5">
        {PRIORITIES.filter((pr) => pr !== task.priority).map((pr) => (
          <button key={pr} onClick={(e) => { e.stopPropagation(); setPriority(idx, pr); }}
            className={`px-1 py-0 rounded text-[10px] font-bold ${PRIORITY_BADGE[pr]}`}>
            {pr}
          </button>
        ))}
        {task.priority && (
          <button onClick={(e) => { e.stopPropagation(); setPriority(idx, ""); }}
            className="px-1 py-0 rounded text-[10px] font-bold text-gray-400" style={{ border: "1px solid var(--border)" }}>
            -
          </button>
        )}
      </div>
      <div className="flex gap-0.5">
        {HORIZONS.map(([h, name]) => (
          <button key={h} onClick={(e) => { e.stopPropagation(); setTaskHorizon(idx, task.horizon === h ? "" : h); }}
            title={name}
            className={`px-1 py-0 rounded text-[10px] font-mono ${task.horizon === h ? "bg-blue-100 text-blue-700 font-bold" : "text-gray-500"}`}
            style={task.horizon !== h ? { border: "1px solid var(--border)" } : undefined}>
            {h}
          </button>
        ))}
      </div>
      {/* Estimate — the whole definition of ready (bounded = sized).
          On a captured item, tapping a size IS the GTD fast path: the task
          is its own next action, so size it and it's Ready in one tap. */}
      {(stageOf(task) === "ready" || stageOf(task) === "captured") && (
        <div className="flex gap-0.5 items-center">
          {ESTIMATES.map(([e, name]) => (
            <button key={e} onClick={(ev) => {
              ev.stopPropagation();
              if (stageOf(task) === "captured") {
                updateTasks(tasks.map((t, i) => (i === idx
                  ? { ...t, stage: "ready", estimate: e } : t)));
                setPrioMenu(null);
              } else {
                setEstimate(idx, task.estimate === e ? "" : e);
              }
            }}
              title={stageOf(task) === "captured" ? `${name} — sizes it and marks it Ready` : name}
              className={`px-1 py-0 rounded text-[10px] font-mono ${task.estimate === e ? "bg-emerald-100 text-emerald-700 font-bold" : "text-gray-500"}`}
              style={task.estimate !== e ? { border: "1px solid var(--border)" } : undefined}>
              {e}
            </button>
          ))}
          <span className="text-[8px] pl-0.5" style={{ color: "var(--text-tertiary)" }}>
            {stageOf(task) === "captured" ? "size → ready" : "size"}
          </span>
        </div>
      )}
      {/* Stage transitions — each opens its gate dialog */}
      <div className="flex gap-0.5 pt-0.5" style={{ borderTop: "1px solid var(--border)" }}>
        {stageOf(task) !== "binding" && stageOf(task) !== "ready" && (
          <button onClick={(e) => { e.stopPropagation(); setPrioMenu(null); requestBind(idx); }}
            title="Promote to Binding — the small set you're carrying"
            className="px-1 py-0 rounded text-[10px] font-medium text-purple-600 hover:bg-purple-100">bind</button>
        )}
        {stageOf(task) !== "ready" && (
          <button onClick={(e) => { e.stopPropagation(); setPrioMenu(null); setStageDialog({ idx, kind: "ready" }); }}
            title="Mark Ready — needs a next action and a size"
            className="px-1 py-0 rounded text-[10px] font-medium text-emerald-600 hover:bg-emerald-100">ready</button>
        )}
        {stageOf(task) === "ready" && (
          <button onClick={(e) => {
            e.stopPropagation(); setPrioMenu(null);
            // Undo a misclassification (e.g. a migration-grandfathered
            // "ready" that was never actually bound): back to the inbox,
            // from where it can be bound normally. Steps and size stay.
            updateTasks(tasks.map((t, i) => (i === idx
              ? { ...t, stage: "captured", ready_since: "", horizon: "" } : t)));
          }}
            title="Wasn't actually bound? Send it back to Captured — bind it from there"
            className="px-1 py-0 rounded text-[10px] font-medium text-gray-500 hover:bg-gray-100">inbox</button>
        )}
        <button onClick={(e) => { e.stopPropagation(); setPrioMenu(null); setStageDialog({ idx, kind: "dormant" }); }}
          title="Park with a wake date"
          className="px-1 py-0 rounded text-[10px] font-medium text-sky-600 hover:bg-sky-100">sleep</button>
        <button onClick={(e) => { e.stopPropagation(); setPrioMenu(null); setStageDialog({ idx, kind: "discard" }); }}
          title="Discard with a reason"
          className="px-1 py-0 rounded text-[10px] font-medium text-gray-500 hover:bg-gray-100">drop</button>
        {(stageOf(task) === "ready" || stageOf(task) === "binding") && task.mode !== "rehearse" && (
          <button onClick={(e) => { e.stopPropagation(); setPrioMenu(null); requestHandoff(idx); }}
            title="Hand off to the area's agent — Nowspace checks everything named stays inside the area"
            className="px-1 py-0 rounded text-[10px] font-medium text-teal-600 hover:bg-teal-100">agent</button>
        )}
      </div>
      {withPlan && stageOf(task) === "ready" && (
        <div className="flex gap-0.5 pt-0.5" style={{ borderTop: "1px solid var(--border)" }}>
          {dayNames.map((d, di) => (
            <button key={d} onClick={(e) => { e.stopPropagation(); setPrioMenu(null); moveToPlan(idx, di); }}
              title={`Move into ${d} (leaves the bucket)`}
              className="px-1 py-0 rounded text-[10px] hover:bg-blue-100 hover:text-blue-700"
              style={{ color: "var(--text-secondary)" }}>
              {d.slice(0, 2)}
            </button>
          ))}
        </div>
      )}
      {withPlan && stageOf(task) !== "ready" && (
        <p className="text-[9px] px-1 pt-0.5" style={{ color: "var(--text-tertiary)", borderTop: "1px solid var(--border)" }}>
          Only Ready items can be scheduled
        </p>
      )}
    </div>
  );

  const moveToGroup = (idx: number, newGroup: string | null) => {
    const next = [...tasks];
    const task = { ...next[idx] };
    const { label } = parseGroup(task.text);
    task.text = newGroup ? `${newGroup}: ${label}` : label;
    next[idx] = task;
    updateTasks(next);
    setGroupPicker(null);
  };

  const togglePin = (groupName: string) => {
    pushUndo();
    const pinned = [...data.pinned_groups];
    const i = pinned.indexOf(groupName);
    if (i >= 0) pinned.splice(i, 1);
    else pinned.push(groupName);
    setData({ ...data, pinned_groups: pinned });
    setDirty(true);
  };

  const toggleWaiting = (idx: number) => {
    const next = [...tasks];
    next[idx] = { ...next[idx], waiting: !next[idx].waiting };
    updateTasks(next);
  };

  const toggleExpandSubtasks = (idx: number) => {
    setExpandedSubtasks((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const startBreakdown = (idx: number) => {
    setExpandedSubtasks((prev) => new Set(prev).add(idx));
    setBreakdownIdx(idx);
    setAddSubAfter(null); // add at end by default
  };

  const addSubtask = (taskIdx: number, text: string) => {
    const next = [...tasks];
    const task = { ...next[taskIdx], subtasks: [...(next[taskIdx].subtasks || [])] };
    if (addSubAfter !== null && addSubAfter < task.subtasks.length) {
      task.subtasks.splice(addSubAfter + 1, 0, { text, done: false });
      setAddSubAfter(addSubAfter + 1); // next insert goes after the newly added one
    } else {
      task.subtasks.push({ text, done: false });
    }
    next[taskIdx] = task;
    updateTasks(next);
    // Keep input open for chaining (Enter adds next step)
  };

  const cancelBreakdown = (taskIdx: number) => {
    setBreakdownIdx(null);
    setAddSubAfter(null);
    // Collapse if task has no subtasks
    if (!tasks[taskIdx]?.subtasks?.length) {
      setExpandedSubtasks((prev) => { const n = new Set(prev); n.delete(taskIdx); return n; });
    }
  };

  const editSubtask = (taskIdx: number, subIdx: number, newText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    const next = [...tasks];
    const task = { ...next[taskIdx], subtasks: [...next[taskIdx].subtasks] };
    task.subtasks[subIdx] = { ...task.subtasks[subIdx], text: trimmed };
    next[taskIdx] = task;
    updateTasks(next);
    setEditingSubtask(null);
  };

  const reorderSubtask = (taskIdx: number, fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const next = [...tasks];
    const task = { ...next[taskIdx], subtasks: [...next[taskIdx].subtasks] };
    const [moved] = task.subtasks.splice(fromIdx, 1);
    task.subtasks.splice(toIdx, 0, moved);
    next[taskIdx] = task;
    updateTasks(next);
  };

  const toggleSubtaskDone = (taskIdx: number, subIdx: number) => {
    const next = [...tasks];
    const task = { ...next[taskIdx], subtasks: [...next[taskIdx].subtasks] };
    task.subtasks[subIdx] = { ...task.subtasks[subIdx], done: !task.subtasks[subIdx].done };
    next[taskIdx] = task;
    updateTasks(next);
  };

  const deleteSubtask = (taskIdx: number, subIdx: number) => {
    const next = [...tasks];
    const task = { ...next[taskIdx], subtasks: [...next[taskIdx].subtasks] };
    task.subtasks.splice(subIdx, 1);
    next[taskIdx] = task;
    updateTasks(next);
  };

  // Promote a step to its own bucket task — mirrors the Planning tab's ↑.
  // The new task lands right after its parent and inherits group, priority
  // and horizon, so it stays in the same planning lane (save stamps it
  // with the current week as a fresh entry).
  const promoteSubtask = (taskIdx: number, subIdx: number) => {
    const parent = tasks[taskIdx];
    if (!parent) return;
    const subs = [...(parent.subtasks || [])];
    const [promoted] = subs.splice(subIdx, 1);
    if (!promoted) return;
    const { group } = parseGroup(parent.text);
    const next = [...tasks];
    next[taskIdx] = { ...parent, subtasks: subs };
    next.splice(taskIdx + 1, 0, {
      text: group ? `${group}: ${promoted.text}` : promoted.text,
      priority: parent.priority, horizon: parent.horizon || "",
      focused: false, waiting: false, subtasks: [],
      // A promoted step is its own topic again — it re-enters as captured
      // and earns its own bounds (the parent's estimate isn't its estimate)
      stage: "captured",
    });
    updateTasks(next);
  };

  const addLinkToTask = (idx: number, name: string) => {
    const next = [...tasks];
    const task = { ...next[idx] };
    // Don't add duplicate
    if (task.text.includes(`[[${name}]]`)) return;
    task.text = task.text + ` [[${name}]]`;
    next[idx] = task;
    updateTasks(next);
    // Update notePicker links
    const links = extractLinks(task.text);
    setNotePicker((prev) => prev && prev.idx === idx ? { ...prev, links } : prev);
  };

  const removeLinkFromTask = (idx: number, linkName: string) => {
    const next = [...tasks];
    const task = { ...next[idx] };
    task.text = task.text
      .replace(new RegExp(`\\s*\\[\\[${linkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'g'), '')
      .trim();
    next[idx] = task;
    updateTasks(next);
    const links = extractLinks(task.text);
    setNotePicker((prev) => prev && prev.idx === idx ? { ...prev, links } : prev);
  };

  // Re-point a link at another note. One text mutation, not remove+add:
  // both of those read the same `tasks` snapshot, so back-to-back calls
  // would drop the first. Rewriting in place also keeps the link where it
  // sat in the text.
  const replaceLinkOnTask = (idx: number, oldName: string, newName: string) => {
    const next = [...tasks];
    const task = { ...next[idx] };
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    task.text = task.text.replace(new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, 'g'), `[[${newName}]]`);
    next[idx] = task;
    updateTasks(next);
    const links = extractLinks(task.text);
    setNotePicker((prev) => prev && prev.idx === idx ? { ...prev, links } : prev);
  };

  const moveToPlan = async (taskIdx: number, dayIdx: number) => {
    try {
      // Flush pending edits first — the move endpoint indexes into the file
      if (dirty) await saveBucket();
      await api.moveFromBucket(taskIdx, dayIdx, 0);
      await fetchBucket();
      window.dispatchEvent(new CustomEvent("week-changed"));
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to move"); }
  };

  /* ── funnel operations ───────────────────────────────── */

  const applyStageResolution = (idx: number, r: StageResolution) => {
    updateTasks(tasks.map((t, i) => (i === idx ? applyResolution(t, r) : t)));
    setStageDialog(null);
  };

  // Binding entry always goes through here: a free slot opens the bind
  // dialog; a full Binding opens the eviction dialog instead. The dialog
  // cannot be bypassed — the server refuses over-limit saves anyway.
  const requestBind = (idx: number) => {
    const count = tasks.filter((t) => stageOf(t) === "binding").length;
    if (count >= bindingLimit) setEvictionFor(idx);
    else setStageDialog({ idx, kind: "bind" });
  };

  // "Already decided" inside the bind flow still passes the ready gate
  const handleBindResolve = (idx: number, r: StageResolution) => {
    if (r.kind === "ready") { setStageDialog({ idx, kind: "ready" }); return; }
    applyStageResolution(idx, r);
  };

  const evictThenBind = (evictIdx: number, r: StageResolution) => {
    updateTasks(tasks.map((t, i) => (i === evictIdx ? applyResolution(t, r) : t)));
    const incoming = evictionFor;
    setEvictionFor(null);
    if (incoming !== null) setStageDialog({ idx: incoming, kind: "bind" });
  };

  const setEstimate = (idx: number, e: "" | "s" | "m" | "l") => {
    updateTasks(tasks.map((t, i) => (i === idx ? { ...t, estimate: e } : t)));
    setPrioMenu(null);
  };

  const finishReview = async (focus: string, secs: number) => {
    setReviewOpen(false);
    try {
      const r = await api.saveFunnelSettings({
        last_review: new Date().toISOString().slice(0, 10),
        last_review_secs: secs,
        week_focus: focus,
      });
      setFunnel(r.funnel);
    } catch { /* review edits are already saved with the bucket */ }
  };

  // Due when no review has completed since Monday of the current week
  const reviewDue = (() => {
    if (!funnel) return false;
    if (!funnel.last_review) return true;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return new Date(funnel.last_review) < monday;
  })();

  const bindingItems = tasks
    .map((t, i) => ({ task: t, originalIdx: i }))
    .filter(({ task }) => stageOf(task) === "binding" && taskVisibleInMode(task.text));

  // Hand off to the item's area agent (handoff brief): the area is derived
  // from the item's group, never chosen here. Ready/binding only; rehearse never.
  const requestHandoff = async (idx: number) => {
    const t = tasks[idx];
    if (!t || t.mode === "rehearse") return;
    const { group } = parseGroup(t.text);
    if (!group) { setError("Handoff needs a group that maps to an agent area"); return; }
    try {
      const r = await api.handoffAreaForGroup(group);
      if (!r.area) { setError(`Group “${group}” doesn't map to an area with an agent binding (Settings → Agent areas)`); return; }
      if (dirty) await saveBucket();
      setComposerFor({ idx, area: r.area });
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); }
  };

  /* ── drag & drop ─────────────────────────────────────── */

  const handleDragStart = (idx: number) => { dragRef.current = { fromIdx: idx }; };
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    if (!dragRef.current && !e.dataTransfer.types.includes("vault-note-name")) return;
    e.preventDefault(); setDropTarget(idx); setDropGroupTarget(null);
  };
  const handleDragOverGroup = (e: React.DragEvent, groupName: string) => {
    if (!dragRef.current) return;
    e.preventDefault(); setDropGroupTarget(groupName); setDropTarget(null);
  };
  const handleDrop = (idx: number, targetGroup: string, e?: React.DragEvent) => {
    // Handle vault note dropped onto task — add wiki link
    if (e && e.dataTransfer.types.includes("vault-note-name")) {
      const noteName = e.dataTransfer.getData("vault-note-name");
      if (noteName) {
        addLinkToTask(idx, noteName);
      }
      setDropTarget(null);
      return;
    }
    if (!dragRef.current) return;
    const { fromIdx } = dragRef.current;
    const next = [...tasks];
    const task = { ...next[fromIdx] };
    const { group: srcGroup, label } = parseGroup(task.text);

    // Update group if dropping into a different group
    if (srcGroup !== targetGroup) {
      task.text = targetGroup ? `${targetGroup}: ${label}` : label;
    }

    next.splice(fromIdx, 1);
    let insertIdx = idx;
    if (fromIdx < idx) insertIdx = Math.max(0, insertIdx - 1);
    next.splice(insertIdx, 0, task);
    updateTasks(next);
    dragRef.current = null; setDropTarget(null); setDropGroupTarget(null);
  };
  const handleDropOnGroup = (groupName: string) => {
    if (!dragRef.current) return;
    const { fromIdx } = dragRef.current;
    const next = [...tasks];
    const task = { ...next[fromIdx] };
    const { group: srcGroup, label } = parseGroup(task.text);

    // Update group prefix
    task.text = groupName ? `${groupName}: ${label}` : label;

    // Remove from old position
    next.splice(fromIdx, 1);

    // Find the last task in the target group and insert after it
    let insertIdx = next.length; // default: end
    for (let i = next.length - 1; i >= 0; i--) {
      if (parseGroup(next[i].text).group === groupName) {
        insertIdx = i + 1;
        break;
      }
    }
    // If no tasks in this group yet, find where this group header would be
    if (insertIdx === next.length) {
      for (let i = 0; i < next.length; i++) {
        if (parseGroup(next[i].text).group === groupName) {
          insertIdx = i;
          break;
        }
      }
    }
    next.splice(insertIdx, 0, task);
    updateTasks(next);

    // Expand the group if collapsed
    if (isGroupCollapsed(groupName)) expandGroup(groupName);

    dragRef.current = null; setDropTarget(null); setDropGroupTarget(null);
  };
  const handleDragEnd = () => { dragRef.current = null; setDropTarget(null); setDropGroupTarget(null); };

  /* ── build groups ────────────────────────────────────── */

  const visibleTaskCount = tasks.filter((t) => taskVisibleInMode(t.text)).length;

  const allGroups = new Map<string, number>();
  tasks.forEach((t) => {
    if (!taskVisibleInMode(t.text)) return;
    const { group } = parseGroup(t.text);
    if (group) allGroups.set(group, (allGroups.get(group) || 0) + 1);
  });

  /* ── group collapse ──────────────────────────────────── */

  const toggleCollapseGroup = (name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return persistExpanded(next);
    });
  };

  const collapseAll = () => setExpandedGroups(persistExpanded(new Set()));
  const expandAll = () => setExpandedGroups(persistExpanded(new Set(["", ...allGroups.keys()])));
  const allCollapsed = expandedGroups.size === 0;

  const sortedGroups = [...allGroups.entries()].sort((a, b) => {
    const aPin = data.pinned_groups.includes(a[0]) ? 0 : 1;
    const bPin = data.pinned_groups.includes(b[0]) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    return b[1] - a[1];
  }).slice(0, 9);

  const buildSections = (): Section[] => {
    const byGroup = new Map<string, Section>();
    let filtered = tasks.map((t, i) => ({ task: t, originalIdx: i }))
      .filter(({ task }) => taskVisibleInMode(task.text));
    // Stage lens: the default view is the active pipeline (captured + ready).
    // Binding lives in its strip; dormant is silent until woken; discarded
    // only appears when explicitly asked for.
    filtered = filtered.filter(({ task }) => {
      const st = stageOf(task);
      if (stageFilter) return st === stageFilter;
      return st === "captured" || st === "ready";
    });
    if (horizonFilter) {
      filtered = filtered.filter(({ task }) =>
        horizonFilter === "none" ? !(task.horizon || "") : (task.horizon || "") === horizonFilter);
    }
    if (filterGroup) {
      filtered = filtered.filter(({ task }) => parseGroup(task.text).group === filterGroup);
    }

    filtered.forEach(({ task, originalIdx }) => {
      const { group, label } = parseGroup(task.text);
      let section = byGroup.get(group);
      if (!section) {
        section = { name: group, items: [] };
        byGroup.set(group, section);
      }
      section.items.push({ task, originalIdx, label });
    });
    return [...byGroup.values()];
  };

  const sections = buildSections();

  /* ── GTD board: actions + duplicate sweep ─────────────── */

  const todayIdx = (() => { const d = new Date().getDay(); return d === 0 ? 6 : d - 1; })();

  // Weeks a task has sat in the bucket (from its ~wYYWW entry stamp)
  const bucketAgeWeeks = (text: string): number | null => {
    const w = bucketEnteredWeek(text);
    if (!w) return null;
    const now = new Date();
    const jan4 = new Date(now.getFullYear(), 0, 4);
    const curWeek = Math.ceil(((now.getTime() - jan4.getTime()) / 86400000 + ((jan4.getDay() + 6) % 7) + 1) / 7);
    const curYY = now.getFullYear() % 100;
    return Math.max(0, (curYY * 52 + curWeek) - (w.yy * 52 + w.week));
  };

  // File a bucket task into this week (offset 0, today) or next week (offset 1, Monday).
  // Flush any unsaved local edits first so the server-side move sees current state.
  // Duplicate sweep: same normalized text (group + label, tokens stripped)
  const dupeGroups = (() => {
    const byNorm = new Map<string, number[]>();
    tasks.forEach((t, i) => {
      if (!taskVisibleInMode(t.text)) return;
      const norm = stripBucketMeta(stripCtxTokens(t.text)).toLowerCase().replace(/\s+/g, " ").trim();
      if (!norm) return;
      byNorm.set(norm, [...(byNorm.get(norm) || []), i]);
    });
    return [...byNorm.values()].filter((idxs) => idxs.length > 1);
  })();

  // Keep the oldest copy of each duplicate set, delete the rest
  const mergeDupes = () => {
    const drop = new Set<number>();
    dupeGroups.forEach((idxs) => {
      const keep = [...idxs].sort((a, b) => bucketAgeKey(tasks[a].text) - bucketAgeKey(tasks[b].text))[0];
      idxs.forEach((i) => { if (i !== keep) drop.add(i); });
    });
    updateTasks(tasks.filter((_, i) => !drop.has(i)));
  };

  // GTD sort: within each project group, order by horizon (n → nw → m → none),
  // then priority (A → B → C → D → none). Group order (first appearance) is kept
  // and each group's tasks become contiguous. Reorders + saves; drag still works.
  const sortBucketGTD = () => {
    const horizonRank = (h?: string) => (({ n: 0, nw: 1, m: 2 } as Record<string, number>)[h || ""] ?? 3);
    const priorityRank = (p?: string) => (({ A: 0, B: 1, C: 2, D: 3 } as Record<string, number>)[(p || "").toUpperCase()] ?? 4);
    const order: string[] = [];
    const byGroup = new Map<string, BucketTask[]>();
    tasks.forEach((t) => {
      const { group } = parseGroup(t.text);
      if (!byGroup.has(group)) { byGroup.set(group, []); order.push(group); }
      byGroup.get(group)!.push(t);
    });
    const sorted: BucketTask[] = [];
    for (const g of order) {
      const items = byGroup.get(g)!.slice().sort((a, b) => {
        const h = horizonRank(a.horizon) - horizonRank(b.horizon);
        if (h !== 0) return h;
        return priorityRank(a.priority) - priorityRank(b.priority);
      });
      sorted.push(...items);
    }
    updateTasks(sorted);
  };

  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];


  /* ── render ──────────────────────────────────────────── */

  return (
    <div className={`space-y-3 pb-12 ${vaultBrowserOpen ? "" : "max-w-3xl mx-auto"}`}>
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      {/* Negative top: <main> carries py-2/sm:py-4, and a sticky child pins at
          its CONTENT edge — that padding strip stays open and scrolling rows
          show through it under the nav. Pulling top up by the same amount
          parks the bar flush against the nav. Rest layout is untouched: a
          sticky offset only applies once the box is stuck. */}
      <div className={`relative ${pinFilters ? "sticky -top-2 sm:-top-4 z-30 pb-2 -mx-2 px-2 sm:-mx-4 sm:px-4 border-b" : ""}`} style={pinFilters ? { background: 'var(--bg)', borderColor: 'var(--border)' } : undefined}>
      {/* Toolbar — three labeled clusters: Tag / View / Filter */}
      <div className="flex items-start flex-wrap gap-x-2 gap-y-1.5 text-xs pr-6" style={{ color: 'var(--text-secondary)' }}>
        <span className="whitespace-nowrap py-1.5">{visibleTaskCount} task{visibleTaskCount !== 1 ? "s" : ""}</span>
        <button onClick={() => setReviewOpen(true)}
          className="whitespace-nowrap px-2 py-1 mt-0.5 rounded text-[10px] font-medium transition-colors"
          style={reviewDue
            ? { background: "rgb(245 158 11 / 0.12)", color: "#b45309", border: "1px solid rgb(245 158 11 / 0.4)" }
            : { background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
          title="The weekly review: reconcile slips, check Binding, refill slots, set the week's line. ~5 minutes.">
          🧭 Review{reviewDue ? " · due" : ""}
        </button>
        {ctxEnabled && (
          <Cluster kind="tag" label="Tag" open={openCluster === "tag"} onToggle={() => toggleCluster("tag")}
            summary={ctxSel.length ? ctxSel.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join("+") : "All"}>
            {allContextNames(ctxMap, ctxTags).filter((name) => {
              if (["work", "volunteer", "personal"].includes(name)) return true;
              if (ctxSel.includes(name)) return true;
              return tasks.some((t) => resolveContext(t.text, ctxMap, ctxTags) === name);
            }).map((name) => {
              const active = ctxSel.includes(name);
              return (
                <button key={name} onClick={() => toggleCtx(name)}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${active ? ctxChipClass(name) : ""}`}
                  style={!active ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}>
                  {name.charAt(0).toUpperCase() + name.slice(1)}
                </button>
              );
            })}
            <button onClick={() => setCtxSel([])}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${ctxSel.length === 0 ? "bg-gray-200 text-gray-700" : ""}`}
              style={ctxSel.length !== 0 ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}>
              All
            </button>
          </Cluster>
        )}
        <Cluster kind="view" label="View" open={openCluster === "view"} onToggle={() => toggleCluster("view")}
          summary={boardView ? "Board" : "List"}>
          <button onClick={toggleBoardView}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${boardView ? "bg-blue-100 text-blue-700" : ""}`}
            style={!boardView ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}
            title="Horizon board: This week / Next week / Next month / Someday — virtual, nothing moves">
            {boardView ? "List" : "Board"}
          </button>
          <button onClick={allCollapsed ? expandAll : collapseAll}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
          <button onClick={sortBucketGTD}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            title="Sort each group by horizon (n → nw → m → none), then priority (A–D, blank last)">
            Sort GTD
          </button>
          <button onClick={() => setStatsOpen(true)}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            title="Funnel diagnostics — time in stage, Binding exits, slip rate. System metrics only.">
            📊 Stats
          </button>
          <button onClick={() => setHandoffOpen(true)}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            title="Agent handoff — drafting / in flight / returned. Opens, empties, closes.">
            🤝 Handoff
          </button>
        </Cluster>
      </div>

      {/* Filter cluster — group chips */}
      <div className="flex gap-1 items-center flex-wrap mt-1.5">
      <Cluster kind="filter" label="Filter" open={openCluster === "filter"} onToggle={() => toggleCluster("filter")}
        summary={filterGroup || "All"}>
        <button onClick={() => setFilterGroup(null)}
          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
            !filterGroup ? "bg-blue-100 text-blue-700" : ""
          }`} style={filterGroup ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}>All</button>
        {sortedGroups.map(([name, count]) => (
          <div key={name} className="flex items-center gap-0.5">
            <button onClick={() => setFilterGroup(filterGroup === name ? null : name)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                filterGroup === name ? "bg-blue-100 text-blue-700" : ""
              }`} style={filterGroup !== name ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}>
              {name} <span className="text-[10px] opacity-60">({count})</span>
            </button>
            <button onClick={() => togglePin(name)} title={data.pinned_groups.includes(name) ? "Unpin" : "Pin"}
              className={`text-[10px] transition-opacity ${data.pinned_groups.includes(name) ? "text-amber-500" : "text-gray-300 hover:text-amber-400"}`}>
              ⭐
            </button>
          </div>
        ))}
        <span className="w-px h-4 shrink-0" style={{ backgroundColor: "var(--border)" }} />
        {/* Stage lens — default shows the active pipeline (captured + ready);
            the Binding chip surfaces binding items as full list rows (edit,
            🔗, 🐘) alongside the summary strip */}
        {([["", "Active"], ["captured", "Captured"], ["binding", "Binding"], ["ready", "Ready"], ["dormant", "Dormant"], ["discarded", "Discarded"]] as const).map(([st, name]) => (
          <button key={st || "active"} onClick={() => setStageFilter(st as "" | BucketStage)}
            title={st ? STAGE_META[st as BucketStage].hint : "Captured + Ready (Binding has its own strip; Dormant stays silent)"}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${stageFilter === st ? "bg-blue-100 text-blue-700" : ""}`}
            style={stageFilter !== st ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}>
            {name}
          </button>
        ))}
        <span className="w-px h-4 shrink-0" style={{ backgroundColor: "var(--border)" }} />
        {([["", "Any time"], ["n", "n"], ["nw", "nw"], ["m", "m"], ["none", "unplanned"]] as const).map(([h, name]) => (
          <button key={h || "any"} onClick={() => setHorizonFilter(h)}
            title={h === "n" ? "this week" : h === "nw" ? "next week" : h === "m" ? "next month" : h === "none" ? "no horizon set" : "all horizons"}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${h ? "font-mono" : ""} ${horizonFilter === h ? "bg-blue-100 text-blue-700" : ""}`}
            style={horizonFilter !== h ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}>
            {name}
          </button>
        ))}
      </Cluster>
      </div>
      <button
        onClick={() => setPinFilters(!pinFilters)}
        className={`absolute top-1 right-1 px-1 py-0.5 rounded text-[9px] transition-colors ${
          pinFilters ? "text-gray-300 hover:text-gray-500" : "text-blue-400 hover:text-blue-600"
        }`}
        title={pinFilters ? "Unpin toolbar" : "Pin toolbar"}
      >
        📌
      </button>
      </div>

      {/* GTD board — file each task into a horizon, one decision per card */}
      {boardView && (
        <div className="space-y-3">
          {dupeGroups.length > 0 && (
            <div className="px-3 py-2 rounded-lg text-xs space-y-1.5"
              style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-strong)" }}>
              <div className="flex items-center gap-3">
                <span style={{ color: "var(--text)" }}>
                  🔁 {dupeGroups.length} duplicate {dupeGroups.length === 1 ? "set" : "sets"} found
                  ({dupeGroups.reduce((n, g) => n + g.length - 1, 0)} redundant cop{dupeGroups.reduce((n, g) => n + g.length - 1, 0) === 1 ? "y" : "ies"})
                </span>
                <button onClick={mergeDupes}
                  className="px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-medium hover:bg-amber-600">
                  Merge — keep oldest of each
                </button>
              </div>
              {/* Which tasks, so merging is an informed choice */}
              <ul className="space-y-0.5" style={{ color: "var(--text-secondary)" }}>
                {dupeGroups.map((idxs, gi) => (
                  <li key={gi} className="truncate">
                    ×{idxs.length} — {stripBucketMeta(stripCtxTokens(tasks[idxs[0]].text))}
                  </li>
                ))}
              </ul>
              <p className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                Keeps each set's oldest copy — with its own priority, horizon and
                subtasks — and deletes the newer copies.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-start">
            {(() => {
              const visible = tasks.map((t, i) => ({ t, i }))
                .filter(({ t }) => taskVisibleInMode(t.text))
                // The board files work into horizons, i.e. schedules — only
                // Ready items belong here (the Bucket–Timing contract)
                .filter(({ t }) => stageOf(t) === "ready")
                .filter(({ t }) => !filterGroup || parseGroup(t.text).group === filterGroup)
                .sort((a, b) => bucketAgeKey(a.t.text) - bucketAgeKey(b.t.text));
              // Legacy ~m month tokens count as the "m" horizon
              const horizonOf = (task: BucketTask) => (task.horizon || (isMonthHorizon(task.text) ? "m" : ""));

              const card = ({ t, i }: { t: BucketTask; i: number }) => {
                const { label } = parseGroup(stripBucketMeta(stripCtxTokens(t.text)));
                const links = extractLinks(t.text);
                // [[wiki links]] collapse to the 🔗 icon; a link-only task
                // falls back to the note's name so the card isn't blank
                const displayLabel = label.replace(WIKI_LINK_RE, "").trim()
                  || (links[0] ? (links[0].display_text || links[0].name) : label);
                const entered = bucketEnteredWeek(t.text);
                const ctx = ctxEnabled ? resolveContext(t.text, ctxMap, ctxTags) : null;
                const hz = horizonOf(t);
                return (
                  <div key={`bc-${i}`} className="rounded-lg p-2 text-xs space-y-1"
                    style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)",
                      boxShadow: ctx ? `inset 2px 0 0 ${ctxEdgeColor(ctx)}` : undefined }}>
                    <div className="flex items-start gap-1">
                      <span className="prio-pop relative shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); setPrioMenu(prioMenu === i ? null : i); }}
                          className={`px-1 rounded text-[9px] font-bold cursor-pointer hover:opacity-70 ${t.priority ? PRIORITY_BADGE[t.priority] || PRIORITY_BADGE.C : "text-gray-400"}`}
                          style={{
                            ...(!t.priority ? { border: "1px solid var(--border)" } : {}),
                            ...(t.priority === "A" && hz !== "n" ? { boxShadow: "0 0 0 1.5px rgb(245 158 11 / 0.7)" } : {}),
                          }}
                          title={t.priority === "A" && hz !== "n" ? "An A shouldn't wait — this week or downgrade" : "Click to set priority and horizon"}>
                          {hz + (t.priority || "-")}
                        </button>
                        {prioMenu === i && prioHorizonMenu(t, i, true)}
                      </span>
                      {editingTask === i ? (
                        <EditInput initialValue={label.replace(WIKI_LINK_RE, "").trim()} onSave={(nt) => editTask(i, nt)} onCancel={() => setEditingTask(null)}
                          className="flex-1 text-xs px-1 py-0.5 border rounded outline-none focus:ring-1 focus:ring-blue-400"
                          style={{ borderColor: "var(--border-strong)", background: "var(--bg)", color: "var(--text)" }} />
                      ) : (
                        <span onClick={() => setEditingTask(i)} className="flex-1 leading-snug cursor-text hover:text-blue-600" style={{ color: "var(--text)" }}>{displayLabel}</span>
                      )}
                      {links.length > 0 && (
                        <button onClick={(e) => {
                          e.stopPropagation();
                          const rect = (e.target as HTMLElement).getBoundingClientRect();
                          const { group } = parseGroup(t.text);
                          setNotePicker(notePicker?.idx === i ? null : {
                            idx: i, group, links,
                            pos: { top: rect.bottom + 4, left: rect.left - 100 }
                          });
                        }}
                          className="shrink-0 text-[10px] opacity-80 hover:opacity-100" title="Linked notes">
                          🔗{links.length > 1 && <sup className="text-[8px] font-bold">{links.length}</sup>}
                        </button>
                      )}
                      <button onClick={() => deleteTask(i)} title="Drop — delete this task"
                        className="shrink-0 glyph-action hover:text-red-500">✕</button>
                    </div>
                    <div className="flex items-center gap-1 text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                      {(() => {
                        const age = entered ? bucketAgeWeeks(t.text) : null;
                        return age !== null && (
                          <span title={`In the bucket since week ${entered!.week} — columns sort oldest first`}>
                            {age === 0 ? "new this week" : `${age}w in bucket`}
                          </span>
                        );
                      })()}
                      {t.waiting && <span>⏳</span>}
                    </div>
                  </div>
                );
              };

              const column = (title: string, items: { t: BucketTask; i: number }[], hint: string) => {
                // Same grouping as the list view, inside each column
                const byGroup = new Map<string, { t: BucketTask; i: number }[]>();
                items.forEach((it) => {
                  const g = parseGroup(stripBucketMeta(stripCtxTokens(it.t.text))).group;
                  if (!byGroup.has(g)) byGroup.set(g, []);
                  byGroup.get(g)!.push(it);
                });
                return (
                  <div className="rounded-lg p-2 space-y-1.5 min-h-[120px]"
                    style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
                    <div className="flex items-center gap-1 px-1">
                      <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>{title}</span>
                      <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>({items.length})</span>
                    </div>
                    {[...byGroup.entries()].map(([g, its]) => (
                      <div key={g || "ungrouped"} className="space-y-1.5">
                        <button
                          onClick={() => toggleCollapseGroup(g)}
                          className="w-full text-left px-1 text-[10px] font-semibold flex items-center gap-1 hover:opacity-80"
                          style={{ color: "var(--text-secondary)" }}
                          title={isGroupCollapsed(g) ? "Expand group" : "Collapse group"}
                        >
                          <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>{isGroupCollapsed(g) ? "▸" : "▾"}</span>
                          {g || "Un-grouped"} <span className="font-normal" style={{ color: "var(--text-tertiary)" }}>({its.length})</span>
                        </button>
                        {!isGroupCollapsed(g) && its.map(card)}
                      </div>
                    ))}
                    {items.length === 0 && <p className="text-[9px] text-center py-3" style={{ color: "var(--text-tertiary)" }}>{hint}</p>}
                  </div>
                );
              };

              return (
                <>
                  {column("This week", visible.filter(({ t }) => horizonOf(t) === "n"), "Move cards here with the n button")}
                  {column("Next week", visible.filter(({ t }) => horizonOf(t) === "nw"), "Move cards here with the nw button")}
                  {column("Next month", visible.filter(({ t }) => horizonOf(t) === "m"), "Move cards here with the m button")}
                  {column("Someday", visible.filter(({ t }) => horizonOf(t) === ""), "Everything unprefixed lives here, oldest first")}
                </>
              );
            })()}
          </div>
          <p className="text-[10px] text-center" style={{ color: "var(--text-tertiary)" }}>
            Columns are virtual horizons (nA / nwA / mA prefixes in the file) — nothing leaves the bucket until you pick a weekday in a card's badge menu.
            Only Ready items appear here; Captured and Binding live in the list view.
          </p>
        </div>
      )}

      {/* Tasks + side panels: flex layout */}
      <div className={`flex gap-0 items-start ${boardView ? "hidden" : ""}`}>
      <div className={`space-y-2 ${vaultBrowserOpen ? "flex-1 min-w-0" : "max-w-2xl w-full"}`}>
        {/* Week focus line — set in the weekly review */}
        {funnel?.week_focus && (
          <p className="text-[11px] italic px-1" style={{ color: "var(--text-tertiary)" }}>
            This week: {funnel.week_focus}
          </p>
        )}

        {/* Binding strip — the small set of topics being carried (WIP-limited) */}
        {bindingItems.length > 0 && (
          <div className="rounded-xl p-2.5 space-y-1.5"
            style={{ background: "var(--bg-secondary)", border: "1px solid rgb(168 85 247 / 0.25)" }}>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>🧠 Binding</span>
              <span className={`text-[10px] font-mono px-1 rounded ${bindingItems.length >= bindingLimit ? "bg-purple-100 text-purple-700 font-bold" : ""}`}
                style={bindingItems.length < bindingLimit ? { color: "var(--text-tertiary)" } : undefined}>
                {bindingItems.length}/{bindingLimit}
              </span>
              <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                — what you're actively carrying
              </span>
            </div>
            {bindingItems.map(({ task, originalIdx }) => {
              const stripLinks = extractLinks(task.text);
              return (
              <div key={originalIdx} data-task-anchor={`bucket:${bucketAnchorKey(task.text)}`}
                className="pl-1.5 py-1 flex items-start gap-1.5 group/bind" style={{ borderLeft: "2px solid rgb(168 85 247 / 0.4)" }}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs" style={{ color: "var(--text)" }}>
                    {task.question || "(no question)"}
                    {task.mode === "rehearse" && (
                      <span className="ml-1.5 text-[9px] px-1 rounded bg-purple-100 text-purple-600" title="Retrieval practice — safe for the evening slate; never hand it to an AI">rehearse</span>
                    )}
                  </p>
                  {/* Linked notes render as clickable chips — clarify in the
                      note without leaving the strip to hunt for it */}
                  <p className="text-[10px] truncate" style={{ color: "var(--text-tertiary)" }}>
                    {renderWikiText(stripBucketMeta(stripCtxTokens(task.text)), onOpenNote)}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.target as HTMLElement).getBoundingClientRect();
                    const { group } = parseGroup(task.text);
                    setNotePicker(notePicker?.idx === originalIdx ? null : {
                      idx: originalIdx, group, links: stripLinks,
                      pos: { top: rect.bottom + 4, left: rect.left - 100 },
                    });
                  }}
                    className={`px-1 rounded text-[10px] transition-opacity ${stripLinks.length ? "opacity-80" : "opacity-0 group-hover/bind:opacity-100 max-sm:opacity-60"}`}
                    title="Link a vault note to this question">
                    🔗{stripLinks.length > 1 && <sup className="text-[8px] font-bold">{stripLinks.length}</sup>}
                  </button>
                  <span className="flex gap-1 opacity-0 group-hover/bind:opacity-100 transition-opacity max-sm:opacity-60">
                  <button onClick={() => setStageDialog({ idx: originalIdx, kind: "ready" })}
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-100 text-emerald-700"
                    title="Bound it: next action + size → Ready">ready</button>
                  <button onClick={() => setStageDialog({ idx: originalIdx, kind: "dormant" })}
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-sky-100 text-sky-700" title="Park with a wake date">sleep</button>
                  <button onClick={() => setStageDialog({ idx: originalIdx, kind: "discard" })}
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-gray-100 text-gray-500" title="Discard with a reason">drop</button>
                  </span>
                </div>
              </div>
              );
            })}
          </div>
        )}

        {/* Quick add — "Group: task" files it under that group */}
        <div className="flex items-center gap-1.5">
          <input
            ref={quickAddRef}
            defaultValue=""
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = (quickAddRef.current?.value || "").trim();
              if (v) { quickAdd(v); if (quickAddRef.current) quickAddRef.current.value = ""; }
            }}
            placeholder={'Add task — "Group: task" files it under the group'}
            className="flex-1 min-w-0 text-sm px-2.5 py-1.5 rounded-lg outline-none focus:ring-1 focus:ring-blue-400"
            style={{ background: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }}
          />
          <button
            onClick={() => {
              const v = (quickAddRef.current?.value || "").trim();
              if (v) { quickAdd(v); if (quickAddRef.current) quickAddRef.current.value = ""; }
            }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-white shrink-0"
            style={{ backgroundColor: "var(--accent)" }}
            title="Add to bucket"
          >
            ＋
          </button>
        </div>
        {sections.map((section, si) => {
          const displayName = section.name || "Un-grouped";
          const hasMultipleSections = sections.length > 1;
          const showHeader = section.name || hasMultipleSections;
          return (
          <div key={`${displayName}-${si}`}>
            {showHeader && (
              <div className={`group text-xs font-semibold tracking-wide px-1 py-1 flex items-center gap-1 relative cursor-pointer select-none transition-colors ${
                dropGroupTarget === section.name ? "bg-blue-100 rounded" : ""
              }`}
                onClick={() => toggleCollapseGroup(section.name)}
                onDragOver={(e) => handleDragOverGroup(e, section.name)}
                onDragLeave={() => setDropGroupTarget(null)}
                onDrop={(e) => { e.preventDefault(); handleDropOnGroup(section.name); }}
                style={{ color: section.name ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{isGroupCollapsed(section.name) ? "▸" : "▾"}</span> {displayName}
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>({section.items.length})</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isGroupCollapsed(section.name)) expandGroup(section.name);
                    const last = section.items[section.items.length - 1];
                    setAddingAt({ afterIdx: last ? last.originalIdx : tasks.length - 1, group: section.name || undefined });
                  }}
                  className="opacity-0 group-hover:opacity-100 text-[11px] px-1 rounded transition-opacity"
                  style={{ color: 'var(--text-secondary)' }}
                  title={`Add task to ${displayName}`}
                >
                  ＋
                </button>
              </div>
            )}
            {!isGroupCollapsed(section.name) && (
            <div className={showHeader ? "ml-4 border-l-2 pl-2" : ""} style={showHeader ? { borderColor: 'var(--border)' } : undefined}>
              {section.items.map(({ task, originalIdx, label }) => {
                const taskLinks = extractLinks(label);
                const hasLinks = taskLinks.length > 0;
                const hasSubtasks = task.subtasks && task.subtasks.length > 0;
                const isExpanded = expandedSubtasks.has(originalIdx);
                // Strip wiki links from display label
                const displayLabel = stripBucketMeta(stripCtxTokens(label.replace(WIKI_LINK_RE, "").trim()));

                return (
                  <div key={originalIdx} data-task-anchor={`bucket:${bucketAnchorKey(task.text)}`}>
                    <div
                      draggable
                      onDragStart={() => handleDragStart(originalIdx)}
                      onDragOver={(e) => handleDragOver(e, originalIdx)}
                      onDrop={(e) => { e.preventDefault(); handleDrop(originalIdx, section.name, e); }}
                      onDragEnd={handleDragEnd}
                      onDoubleClick={(e) => { e.stopPropagation(); setAddingAt({ afterIdx: originalIdx, group: section.name || undefined }); }}
                      className={`group flex max-sm:flex-wrap items-center gap-1.5 py-1.5 px-2 rounded-lg transition-colors cursor-grab active:cursor-grabbing ${
                        dropTarget === originalIdx ? "border-t-2 border-blue-400" : "border-t-2 border-transparent"
                      }`}>

                      {/* Wait icon — left side when active */}
                      {task.waiting && (
                        <span className="text-xs cursor-pointer" title="Remove wait"
                          onClick={(e) => { e.stopPropagation(); toggleWaiting(originalIdx); }}>⏳</span>
                      )}

                      {/* Priority badge — click to set (A/B/C/D, - clears) */}
                      <span className="prio-pop relative shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); setPrioMenu(prioMenu === originalIdx ? null : originalIdx); }}
                          className={`px-1 py-0 rounded text-[10px] font-bold cursor-pointer hover:opacity-70 ${
                            task.priority ? PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C : "text-gray-400"
                          }`}
                          style={{
                            ...(!task.priority ? { border: "1px solid var(--border)" } : {}),
                            ...(task.priority === "A" && task.horizon !== "n" ? { boxShadow: "0 0 0 1.5px rgb(245 158 11 / 0.7)" } : {}),
                          }}
                          title={task.priority === "A" && task.horizon !== "n"
                            ? "An A shouldn't wait — plan it this week or downgrade it"
                            : "Click to set priority and horizon (n = this week, nw = next week, m = next month)"}
                        >
                          {(task.horizon || "") + (task.priority || "-")}
                        </button>
                        {prioMenu === originalIdx && prioHorizonMenu(task, originalIdx, true)}
                      </span>

                      {/* Stage pill — captured stays unmarked (the default is not a judgment) */}
                      {stageOf(task) !== "captured" && (
                        <span className={`shrink-0 text-[8px] px-1 rounded font-medium ${STAGE_META[stageOf(task)].chip}`}
                          title={stageOf(task) === "dormant" && task.wake_date
                            ? `Dormant — wakes ${task.wake_date}`
                            : STAGE_META[stageOf(task)].hint}>
                          {stageOf(task) === "ready" ? (task.estimate ? `rdy·${task.estimate}` : "rdy") : STAGE_META[stageOf(task)].label.toLowerCase()}
                        </span>
                      )}

                      {/* Task text */}
                      {editingTask === originalIdx ? (
                        <EditInput initialValue={displayLabel} onSave={(t) => editTask(originalIdx, t)} onCancel={() => setEditingTask(null)}
                          className="flex-1 text-sm px-1.5 py-0.5 border rounded outline-none focus:ring-1 focus:ring-blue-400" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg)', color: 'var(--text)' }} />
                      ) : (
                        <span onClick={() => setEditingTask(originalIdx)}
                          className={`flex-1 text-sm cursor-text hover:text-blue-600 ${task.focused ? "font-bold" : ""}`}
                          style={{ color: 'var(--text)' }}>
                          {renderWikiText(displayLabel, onOpenNote)}
                        </span>
                      )}

                      {/* Action icons — a full-width second row on phones
                          (the title was getting squeezed); sm:contents
                          dissolves the wrapper on larger screens */}
                      <div className="flex items-center gap-1.5 w-full justify-end sm:contents">
                      {/* ⏳ Waiting toggle */}
                      {!task.waiting && (
                        <button onClick={(e) => { e.stopPropagation(); toggleWaiting(originalIdx); }}
                          className="text-xs opacity-0 group-hover:opacity-30 hover:!opacity-100 transition-opacity"
                          title="Mark as waiting">⏳</button>
                      )}

                      {/* 🐘 Break down */}
                      <button onClick={(e) => { e.stopPropagation(); hasSubtasks ? toggleExpandSubtasks(originalIdx) : startBreakdown(originalIdx); }}
                        className={`text-xs transition-opacity ${hasSubtasks ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"}`}
                        title={hasSubtasks ? `${task.subtasks.length} steps` : "Break down task"}>
                        🐘{hasSubtasks && <sup className="text-[8px] font-bold">{task.subtasks.length}</sup>}
                      </button>

                      {/* 🔗 Link vault note */}
                      <button onClick={(e) => {
                        e.stopPropagation();
                        const rect = (e.target as HTMLElement).getBoundingClientRect();
                        const { group } = parseGroup(task.text);
                        setNotePicker(notePicker?.idx === originalIdx ? null : {
                          idx: originalIdx, group,
                          links: extractLinks(task.text),
                          pos: { top: rect.bottom + 4, left: rect.left - 100 }
                        });
                      }}
                        className={`text-xs transition-opacity ${hasLinks ? "opacity-80" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"}`}
                        title="Link vault note">
                        🔗{hasLinks && taskLinks.length > 1 && <sup className="text-[8px] font-bold">{taskLinks.length}</sup>}
                      </button>

                      {/* 📂 Move to group */}
                      <div className="relative">
                        <button onClick={(e) => { e.stopPropagation(); setGroupPicker(groupPicker === originalIdx ? null : originalIdx); }}
                          className="text-xs opacity-0 group-hover:opacity-30 hover:!opacity-100 transition-opacity"
                          title="Move to group">📂</button>
                        {groupPicker === originalIdx && (
                          <div className="absolute top-6 right-0 z-30 rounded-lg shadow-xl border p-2 min-w-[140px] max-h-48 overflow-y-auto" style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
                            <div className="text-[10px] font-medium mb-1 px-1" style={{ color: 'var(--text-tertiary)' }}>Move to:</div>
                            <button onClick={(e) => { e.stopPropagation(); moveToGroup(originalIdx, null); }}
                              className={`w-full text-left px-2 py-1 text-xs rounded ${!parseGroup(task.text).group ? "font-bold text-blue-600" : ""}`} style={parseGroup(task.text).group ? { color: 'var(--text-secondary)' } : undefined}>
                              — No group
                            </button>
                            {[...allGroups.keys()].map((g) => (
                              <button key={g} onClick={(e) => { e.stopPropagation(); moveToGroup(originalIdx, g); }}
                                className={`w-full text-left px-2 py-1 text-xs rounded hover:bg-blue-50 hover:text-blue-700 ${
                                  parseGroup(task.text).group === g ? "font-bold text-blue-600" : ""
                                }`} style={parseGroup(task.text).group !== g ? { color: 'var(--text)' } : undefined}>
                                {g}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Delete */}
                      <button onClick={(e) => { e.stopPropagation(); deleteTask(originalIdx); }}
                        className="text-xs glyph-action hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">&times;</button>
                      </div>{/* end phone action row */}
                    </div>

                    {/* Subtasks */}
                    {isExpanded && (
                      <div className="ml-8 pl-2 border-l-2 border-amber-200 space-y-0.5 mb-1">
                        {task.subtasks.map((sub, si) => (
                          <React.Fragment key={si}>
                            <div
                              className={`group/sub flex items-center gap-1 py-0.5 text-xs border-t-2 border-transparent ${
                                subDropTarget?.taskIdx === originalIdx && subDropTarget?.subIdx === si ? "!border-amber-400" : ""
                              }`}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setAddSubAfter(si);
                                setBreakdownIdx(originalIdx);
                              }}
                              onDragOver={(e) => {
                                if (e.dataTransfer.types.includes("bucket-subtask")) {
                                  e.preventDefault(); e.stopPropagation();
                                  setSubDropTarget({ taskIdx: originalIdx, subIdx: si });
                                }
                              }}
                              onDragLeave={() => setSubDropTarget(null)}
                              onDrop={(e) => {
                                e.preventDefault(); e.stopPropagation();
                                setSubDropTarget(null);
                                try {
                                  const from = JSON.parse(e.dataTransfer.getData("bucket-subtask"));
                                  if (from.taskIdx === originalIdx && from.subIdx !== si) {
                                    reorderSubtask(originalIdx, from.subIdx, si);
                                  }
                                } catch { /* ignore */ }
                              }}
                            >
                              {/* Drag handle */}
                              {!sub.done && (
                                <span
                                  draggable
                                  onDragStart={(e) => {
                                    e.stopPropagation();
                                    e.dataTransfer.setData("bucket-subtask", JSON.stringify({ taskIdx: originalIdx, subIdx: si }));
                                    e.dataTransfer.effectAllowed = "move";
                                  }}
                                  onDragEnd={() => setSubDropTarget(null)}
                                  className="shrink-0 text-[10px] text-gray-300 cursor-grab active:cursor-grabbing hover:text-gray-500 select-none leading-none"
                                  title="Drag to reorder"
                                >≡</span>
                              )}
                              <button onClick={() => toggleSubtaskDone(originalIdx, si)}
                                className={`shrink-0 inline-flex items-center justify-center hover:opacity-70 ${sub.done ? "text-green-400" : "text-gray-400 hover:text-green-500"}`}>
                                <TaskCheck done={sub.done} size={12} />
                              </button>
                              {editingSubtask?.taskIdx === originalIdx && editingSubtask?.subIdx === si ? (
                                <EditInput
                                  initialValue={sub.text}
                                  onSave={(t) => editSubtask(originalIdx, si, t)}
                                  onCancel={() => setEditingSubtask(null)}
                                  className="flex-1 text-xs px-1 py-0.5 border border-amber-300 rounded outline-none focus:ring-1 focus:ring-amber-400" style={{ background: 'var(--bg)', color: 'var(--text)' }} />
                              ) : (
                                <span
                                  onClick={(e) => { e.stopPropagation(); if (!sub.done) setEditingSubtask({ taskIdx: originalIdx, subIdx: si }); }}
                                  className={`flex-1 ${sub.done ? "line-through" : "cursor-text hover:text-amber-700"}`}
                                  style={{ color: sub.done ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
                                >{sub.text}</span>
                              )}
                              {!sub.done && (
                                <button onClick={(e) => { e.stopPropagation(); promoteSubtask(originalIdx, si); }}
                                  className="shrink-0 text-[10px] glyph-action hover:text-blue-500 ml-auto"
                                  title="Promote to standalone bucket task">↑</button>
                              )}
                              <button onClick={() => deleteSubtask(originalIdx, si)}
                                className={`text-[10px] glyph-action hover:text-red-500 ${sub.done ? "ml-auto" : ""}`}>×</button>
                            </div>
                            {/* Insert-after input */}
                            {breakdownIdx === originalIdx && addSubAfter === si && (
                              <div className="py-0.5">
                                <AutoFocusInput
                                  onSubmit={(t) => addSubtask(originalIdx, t)}
                                  onCancel={() => cancelBreakdown(originalIdx)}
                                  placeholder="Add step..."
                                  className="text-xs px-1.5 py-0.5 border border-amber-300 rounded outline-none focus:ring-1 focus:ring-amber-400 w-full" style={{ background: 'var(--bg)', color: 'var(--text)' }} />
                              </div>
                            )}
                          </React.Fragment>
                        ))}
                        {/* Add subtask input at end — only when adding at end (not after a specific sub-task) */}
                        {breakdownIdx === originalIdx && addSubAfter === null && (
                          <div className="py-0.5">
                            <AutoFocusInput
                              onSubmit={(t) => addSubtask(originalIdx, t)}
                              onCancel={() => cancelBreakdown(originalIdx)}
                              placeholder="Add step..."
                              className="text-xs px-1.5 py-0.5 border border-amber-300 rounded outline-none focus:ring-1 focus:ring-amber-400 w-full" style={{ background: 'var(--bg)', color: 'var(--text)' }} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Inline add after group */}
              {addingAt && section.items.some(({ originalIdx }) => originalIdx === addingAt.afterIdx) && (
                <div className="py-1 px-2">
                  <AutoFocusInput
                    onSubmit={(t) => addTask(addingAt.afterIdx, t, addingAt.group)}
                    onCancel={() => setAddingAt(null)}
                    placeholder={section.name ? `Add to ${section.name}...` : "Add task..."}
                    className="w-full text-sm px-2 py-1 border rounded outline-none focus:ring-1 focus:ring-blue-400" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg)', color: 'var(--text)' }} />
                </div>
              )}
            </div>
            )}
          </div>
          );
        })}

        {/* Add task at bottom */}
        {!addingAt ? (
          <button onClick={() => setAddingAt({ afterIdx: tasks.length - 1 })}
            className="w-full text-left text-sm py-2 px-2" style={{ color: 'var(--text-tertiary)' }}>
            + Add task
          </button>
        ) : !sections.some(s => s.items.some(({ originalIdx }) => originalIdx === addingAt.afterIdx)) && (
          <div className="py-1 px-2">
            <AutoFocusInput
              onSubmit={(t) => addTask(addingAt.afterIdx, t)}
              onCancel={() => setAddingAt(null)}
              placeholder="Add task..."
              className="w-full text-sm px-2 py-1 border rounded outline-none focus:ring-1 focus:ring-blue-400" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg)', color: 'var(--text)' }} />
          </div>
        )}
      </div>

      {/* Vault browser side panel */}
      {vaultBrowserOpen && (
        <div className="hidden md:block w-80 shrink-0 border-l overflow-y-auto max-h-[calc(100vh-80px)] sticky top-[80px] self-start relative" style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
          <VaultBrowser
            onClose={() => setVaultBrowserOpen(false)}
            stateRef={vaultBrowserStateRef}
            onOpenNote={onOpenNote}
          />
        </div>
      )}
      </div>{/* end flex container */}

      {/* NoteFilePicker popup — outside the list container, which is
          display:none in board view (that would hide even this fixed popup) */}
      {notePicker && (
        <NoteFilePicker
          existingLinks={notePicker.links}
          group={notePicker.group}
          position={notePicker.pos}
          onSelect={(path, name) => {
            setNotePicker(null);
            onOpenNote(path, name);
          }}
          onAddLink={(name) => addLinkToTask(notePicker.idx, name)}
          onRemoveLink={(name) => removeLinkFromTask(notePicker.idx, name)}
          onReplaceLink={(oldName, newName) => replaceLinkOnTask(notePicker.idx, oldName, newName)}
          onClose={() => setNotePicker(null)}
        />
      )}


      {/* Floating vault browser icon */}
      <div className="fixed bottom-12 right-4 z-30 flex flex-col gap-1.5">
        <div
          onClick={() => setVaultBrowserOpen(!vaultBrowserOpen)}
          className={`w-9 h-9 rounded-full flex items-center justify-center cursor-pointer shadow-lg transition-all text-sm ${
            vaultBrowserOpen
              ? "bg-teal-600 text-white ring-2 ring-teal-400"
              : "hover:scale-110"
          }`}
          style={!vaultBrowserOpen ? { backgroundColor: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border)" } : undefined}
          title="Vault Browser"
        >
          📂
        </div>
      </div>

      {/* Funnel dialogs — every stage transition passes through its gate */}
      {stageDialog?.kind === "bind" && tasks[stageDialog.idx] && (
        <BindDialog task={tasks[stageDialog.idx]}
          onResolve={(r) => handleBindResolve(stageDialog.idx, r)}
          onCancel={() => setStageDialog(null)} />
      )}
      {stageDialog?.kind === "ready" && tasks[stageDialog.idx] && (
        <ReadyDialog task={tasks[stageDialog.idx]}
          onResolve={(r) => applyStageResolution(stageDialog.idx, r)}
          onCancel={() => setStageDialog(null)} />
      )}
      {stageDialog?.kind === "dormant" && tasks[stageDialog.idx] && (
        <DormantDialog task={tasks[stageDialog.idx]}
          onResolve={(r) => applyStageResolution(stageDialog.idx, r)}
          onCancel={() => setStageDialog(null)} />
      )}
      {stageDialog?.kind === "discard" && tasks[stageDialog.idx] && (
        <DiscardDialog task={tasks[stageDialog.idx]}
          onResolve={(r) => applyStageResolution(stageDialog.idx, r)}
          onCancel={() => setStageDialog(null)} />
      )}
      {evictionFor !== null && tasks[evictionFor] && (
        <EvictionDialog bindingItems={bindingItems} limit={bindingLimit}
          incoming={tasks[evictionFor]}
          onEvict={evictThenBind}
          onCancel={() => setEvictionFor(null)} />
      )}
      {reviewOpen && (
        <WeeklyReview tasks={tasks} limit={bindingLimit} weekFocus={funnel?.week_focus || ""}
          onApply={(idx, updated) => updateTasks(tasks.map((t, i) => (i === idx ? updated : t)))}
          onFinish={finishReview}
          onClose={() => setReviewOpen(false)} />
      )}
      {statsOpen && <FunnelStatsModal onClose={() => setStatsOpen(false)} />}
      {handoffOpen && <HandoffSurface onClose={() => setHandoffOpen(false)} onOpenNote={onOpenNote} />}
      {composerFor && tasks[composerFor.idx] && (
        <DispatchComposer task={tasks[composerFor.idx]} area={composerFor.area}
          onDone={() => { setComposerFor(null); setHandoffOpen(true); }}
          onCancel={() => setComposerFor(null)} />
      )}

      {/* Sticky bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 backdrop-blur border-t px-4 py-1.5" style={{ background: 'color-mix(in srgb, var(--bg) 95%, transparent)', borderColor: 'var(--border)' }}>
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <button onClick={saveBucket} disabled={saving || !dirty}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              saved ? "bg-green-100 text-green-700"
                : dirty ? "bg-blue-100 text-blue-700"
                : ""
            }`} style={!saved && !dirty ? { background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' } : undefined}>
            {saved ? "✓ Saved" : saving ? "Saving…" : dirty ? "Saving…" : "Auto-save"}
          </button>
          <div className="flex items-center gap-0.5">
            <button onClick={performUndo} disabled={undoStack.current.length === 0}
              className="px-1 py-0.5 rounded text-xs disabled:opacity-20 transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              title={`Undo (${undoStack.current.length}) — Ctrl+Z`}>↩</button>
            <button onClick={performRedo} disabled={redoStack.current.length === 0}
              className="px-1 py-0.5 rounded text-xs disabled:opacity-20 transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              title="Redo — Ctrl+Shift+Z">↪</button>
          </div>
          <button onClick={fetchBucket} disabled={loading}
            className="px-2 py-0.5 rounded text-[10px] font-medium disabled:opacity-50 transition-colors" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          {externalChange && (
            <div className="flex items-center gap-1.5 text-[10px] text-blue-600">
              <span>📄 File changed</span>
              <button onClick={() => fetchBucket()} className="font-semibold underline">Reload</button>
              <button onClick={() => setExternalChange(false)} className="text-blue-400">✕</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
