import React, { useState, useRef, useEffect } from "react";
import { api } from "../api";
import type { BucketTask, BucketResponse, TaskLink } from "../api";
import TaskCheck from "./TaskCheck";
import NoteFilePicker from "./NoteFilePicker";
import {
  type CtxName, type CtxMap, type CtxTags, type CtxSelection, DEFAULT_CTX_TAGS,
  ctxChipClass, ctxEdgeColor, allContextNames, resolveContext,
  stripCtxTokens, stripGroupCtxTag, ctxFeatureEnabled,
  taskVisibleInCtxSelection, loadCtxSelection, saveCtxSelection,
  stripBucketMeta, bucketEnteredWeek, bucketAgeKey, isMonthHorizon, setMonthHorizon,
} from "../contexts";
import NoteEditor from "./NoteEditor";
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

/** Render text with wiki links and markdown hyperlinks as clickable elements */
function renderWikiText(text: string, onOpenNote?: (path: string, name: string) => void) {
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
            api.vaultSearch(name, 1).then((res) => {
              if (res.results.length > 0 && onOpenNote) {
                onOpenNote(res.results[0].path, name);
              }
            });
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
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { const t = value.trim(); if (t) { onSubmit(t); setValue(""); } else onCancel(); };
  return (
    <input ref={ref} type="text" value={value} onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
      onBlur={submit} placeholder={placeholder} className={className} />
  );
}

function EditInput({ initialValue, onSave, onCancel, className }: {
  initialValue: string; onSave: (v: string) => void; onCancel: () => void; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = () => { const t = value.trim(); if (t && t !== initialValue) onSave(t); else onCancel(); };
  return (
    <input ref={ref} type="text" value={value} onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); }}
      onBlur={save} className={className} />
  );
}

/* ── Bucket component ──────────────────────────────────────── */

type Section = { name: string; items: { task: BucketTask; originalIdx: number; label: string }[] };

export default function Bucket() {
  const [data, setData] = useState<BucketResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);

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
  const [filedWeek, setFiledWeek] = useState<string[]>([]);
  const [filedNext, setFiledNext] = useState<string[]>([]);
  const [pinFilters, setPinFilters] = useState(true);
  const [addingAt, setAddingAt] = useState<{ afterIdx: number; group?: string } | null>(null);
  const [quickAddText, setQuickAddText] = useState("");
  const [editingTask, setEditingTask] = useState<number | null>(null);
  const [dayPicker, setDayPicker] = useState<number | null>(null);
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
  const [noteEditor, setNoteEditor] = useState<{ path: string; name: string } | null>(null);
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
      if (msg.includes("changed on disk")) setExternalChange(true); else setError(msg);
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
    const newTask: BucketTask = { text: fullText, priority: "C", focused: false, waiting: false, subtasks: [] };
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
      priority: "C", focused: false, waiting: false, subtasks: [],
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
    next[idx] = { ...old, text: group ? `${group}: ${text}` : text };
    updateTasks(next);
    setEditingTask(null);
  };

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

  const moveToPlan = async (taskIdx: number, dayIdx: number) => {
    try {
      await api.moveFromBucket(taskIdx, dayIdx, 0);
      await fetchBucket();
      setDayPicker(null);
      window.dispatchEvent(new CustomEvent("week-changed"));
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to move"); }
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
  const expandAll = () => setExpandedGroups(persistExpanded(new Set(allGroups.keys())));
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

  // File a bucket task into this week (offset 0, today) or next week (offset 1, Monday).
  // Flush any unsaved local edits first so the server-side move sees current state.
  const fileToWeek = async (idx: number, offset: 0 | 1) => {
    const label = stripBucketMeta(stripCtxTokens(parseGroup(tasks[idx]?.text || "").label));
    try {
      if (dirty) await saveBucket();
      if (offset === 1) { try { await api.createNextWeek(); } catch { /* already exists */ } }
      await api.moveFromBucket(idx, offset === 0 ? todayIdx : 0, offset);
      if (offset === 0) setFiledWeek((p) => [...p, label]); else setFiledNext((p) => [...p, label]);
      await fetchBucket();
      window.dispatchEvent(new CustomEvent("week-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to file task");
    }
  };

  const setHorizon = (idx: number, month: boolean) => {
    const next = [...tasks];
    next[idx] = { ...next[idx], text: setMonthHorizon(next[idx].text, month) };
    updateTasks(next);
  };

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
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];


  /* ── render ──────────────────────────────────────────── */

  return (
    <div className={`space-y-3 pb-12 ${vaultBrowserOpen ? "" : "max-w-3xl mx-auto"}`}>
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      <div className={`relative ${pinFilters ? "sticky top-0 z-30 pb-2 -mx-2 px-2 sm:-mx-4 sm:px-4 border-b" : ""}`} style={pinFilters ? { background: 'var(--bg)', borderColor: 'var(--border)' } : undefined}>
      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <span className="whitespace-nowrap">{visibleTaskCount} task{visibleTaskCount !== 1 ? "s" : ""} in bucket{ctxEnabled && ctxSel.length > 0 ? ` (${ctxSel.join(" + ")})` : ""}</span>
        {ctxEnabled && (
          <span className="flex gap-0.5">
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
          </span>
        )}
        <button onClick={allCollapsed ? expandAll : collapseAll}
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
        <button onClick={toggleBoardView}
          className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${boardView ? "bg-blue-100 text-blue-700" : ""}`}
          style={!boardView ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : undefined}
          title="GTD board: file tasks into This week / Next week / This month / Backlog">
          {boardView ? "List" : "Board"}
        </button>
      </div>

      {/* Group filter bar */}
      <div className="flex gap-1 items-center flex-wrap">
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
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-strong)" }}>
              <span style={{ color: "var(--text)" }}>
                🔁 {dupeGroups.length} duplicate {dupeGroups.length === 1 ? "set" : "sets"} found
                ({dupeGroups.reduce((n, g) => n + g.length - 1, 0)} redundant cop{dupeGroups.reduce((n, g) => n + g.length - 1, 0) === 1 ? "y" : "ies"})
              </span>
              <button onClick={mergeDupes}
                className="px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-medium hover:bg-amber-600">
                Merge — keep oldest of each
              </button>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-start">
            {(() => {
              const visible = tasks.map((t, i) => ({ t, i }))
                .filter(({ t }) => taskVisibleInMode(t.text))
                .filter(({ t }) => !filterGroup || parseGroup(t.text).group === filterGroup)
                .sort((a, b) => bucketAgeKey(a.t.text) - bucketAgeKey(b.t.text));
              const backlog = visible.filter(({ t }) => !isMonthHorizon(t.text));
              const month = visible.filter(({ t }) => isMonthHorizon(t.text));

              const card = ({ t, i }: { t: BucketTask; i: number }) => {
                const { group, label } = parseGroup(stripBucketMeta(stripCtxTokens(t.text)));
                const entered = bucketEnteredWeek(t.text);
                const ctx = ctxEnabled ? resolveContext(t.text, ctxMap, ctxTags) : null;
                const inMonth = isMonthHorizon(t.text);
                return (
                  <div key={`bc-${i}`} className="rounded-lg p-2 text-xs space-y-1"
                    style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)",
                      boxShadow: ctx ? `inset 2px 0 0 ${ctxEdgeColor(ctx)}` : undefined }}>
                    <div className="flex items-start gap-1">
                      <span className="flex-1 leading-snug" style={{ color: "var(--text)" }}>{label}</span>
                      <button onClick={() => deleteTask(i)} title="Drop — delete this task"
                        className="shrink-0 text-gray-300 hover:text-red-500">✕</button>
                    </div>
                    <div className="flex items-center gap-1 text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                      {group && <span className="font-medium">{group}</span>}
                      {entered && <span>wk{entered.week}</span>}
                      {t.waiting && <span>⏳</span>}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => fileToWeek(i, 0)} title="Move into this week (today)"
                        className="flex-1 px-1 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 text-[9px] font-medium">Week</button>
                      <button onClick={() => fileToWeek(i, 1)} title="Move into next week (Monday)"
                        className="flex-1 px-1 py-0.5 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-100 text-[9px] font-medium">Next</button>
                      <button onClick={() => setHorizon(i, !inMonth)}
                        title={inMonth ? "Send back to Backlog" : "Do within this month"}
                        className="flex-1 px-1 py-0.5 rounded bg-amber-50 text-amber-600 hover:bg-amber-100 text-[9px] font-medium">
                        {inMonth ? "Backlog" : "Month"}
                      </button>
                    </div>
                  </div>
                );
              };

              const column = (title: string, count: number, hint: string, body: React.ReactNode) => (
                <div className="rounded-lg p-2 space-y-2 min-h-[120px]"
                  style={{ backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border)" }}>
                  <div className="flex items-center gap-1 px-1">
                    <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>{title}</span>
                    <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>({count})</span>
                  </div>
                  {body}
                  {count === 0 && <p className="text-[9px] text-center py-3" style={{ color: "var(--text-tertiary)" }}>{hint}</p>}
                </div>
              );

              return (
                <>
                  {column("This week", filedWeek.length, "File cards here with the Week button",
                    <>{filedWeek.map((l, j) => (
                      <div key={`fw-${j}`} className="rounded px-2 py-1 text-[10px] opacity-60 line-through"
                        style={{ backgroundColor: "var(--bg)", color: "var(--text-secondary)" }}>{l}</div>
                    ))}</>)}
                  {column("Next week", filedNext.length, "File cards here with the Next button",
                    <>{filedNext.map((l, j) => (
                      <div key={`fn-${j}`} className="rounded px-2 py-1 text-[10px] opacity-60 line-through"
                        style={{ backgroundColor: "var(--bg)", color: "var(--text-secondary)" }}>{l}</div>
                    ))}</>)}
                  {column("This month", month.length, "Mark cards with the Month button",
                    <>{month.map(card)}</>)}
                  {column("Backlog", backlog.length, "Everything else lives here, oldest first",
                    <>{backlog.map(card)}</>)}
                </>
              );
            })()}
          </div>
          <p className="text-[10px] text-center" style={{ color: "var(--text-tertiary)" }}>
            Week files to today · Next files to Monday — reshuffle the exact day in the week view · Filed cards reset when you leave
          </p>
        </div>
      )}

      {/* Tasks + side panels: flex layout */}
      <div className={`flex gap-0 items-start ${boardView ? "hidden" : ""}`}>
      <div className={`space-y-2 ${vaultBrowserOpen ? "flex-1 min-w-0" : "max-w-2xl w-full"}`}>
        {/* Quick add — "Group: task" files it under that group */}
        <div className="flex items-center gap-1.5">
          <input
            value={quickAddText}
            onChange={(e) => setQuickAddText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && quickAddText.trim()) { quickAdd(quickAddText); setQuickAddText(""); } }}
            placeholder={'Add task — "Group: task" files it under the group'}
            className="flex-1 min-w-0 text-sm px-2.5 py-1.5 rounded-lg outline-none focus:ring-1 focus:ring-blue-400"
            style={{ background: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }}
          />
          <button
            onClick={() => { if (quickAddText.trim()) { quickAdd(quickAddText); setQuickAddText(""); } }}
            disabled={!quickAddText.trim()}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 shrink-0"
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
                  <div key={originalIdx}>
                    <div
                      draggable
                      onDragStart={() => handleDragStart(originalIdx)}
                      onDragOver={(e) => handleDragOver(e, originalIdx)}
                      onDrop={(e) => { e.preventDefault(); handleDrop(originalIdx, section.name, e); }}
                      onDragEnd={handleDragEnd}
                      onDoubleClick={(e) => { e.stopPropagation(); setAddingAt({ afterIdx: originalIdx, group: section.name || undefined }); }}
                      className={`group flex items-center gap-1.5 py-1.5 px-2 rounded-lg transition-colors cursor-grab active:cursor-grabbing ${
                        dropTarget === originalIdx ? "border-t-2 border-blue-400" : "border-t-2 border-transparent"
                      }`}>

                      {/* Wait icon — left side when active */}
                      {task.waiting && (
                        <span className="text-xs cursor-pointer" title="Remove wait"
                          onClick={(e) => { e.stopPropagation(); toggleWaiting(originalIdx); }}>⏳</span>
                      )}

                      {/* Task text */}
                      {editingTask === originalIdx ? (
                        <EditInput initialValue={displayLabel} onSave={(t) => editTask(originalIdx, t)} onCancel={() => setEditingTask(null)}
                          className="flex-1 text-sm px-1.5 py-0.5 border rounded outline-none focus:ring-1 focus:ring-blue-400" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg)', color: 'var(--text)' }} />
                      ) : (
                        <span onClick={() => setEditingTask(originalIdx)}
                          className={`flex-1 text-sm cursor-text hover:text-blue-600 ${task.focused ? "font-bold" : ""}`}
                          style={{ color: 'var(--text)' }}>
                          {renderWikiText(displayLabel, (path, name) => setNoteEditor({ path, name }))}
                        </span>
                      )}

                      {/* Action icons — show on hover */}
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

                      {/* Move to plan */}
                      <div className="relative">
                        <button onClick={() => setDayPicker(dayPicker === originalIdx ? null : originalIdx)}
                          className="text-xs text-gray-300 hover:text-green-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Move to week plan">→ Plan</button>
                        {dayPicker === originalIdx && (
                          <div className="absolute top-6 right-0 z-20 rounded-lg shadow-lg border p-2 flex gap-1" style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
                            {dayNames.map((d, di) => (
                              <button key={d} onClick={() => moveToPlan(originalIdx, di)}
                                className="px-2 py-1 rounded text-xs hover:bg-blue-100 hover:text-blue-700 transition-colors">{d}</button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Delete */}
                      <button onClick={(e) => { e.stopPropagation(); deleteTask(originalIdx); }}
                        className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">&times;</button>
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
                              <button onClick={() => deleteSubtask(originalIdx, si)}
                                className="text-[10px] text-gray-300 hover:text-red-500 ml-auto">×</button>
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

      {/* NoteFilePicker popup */}
      {notePicker && (
        <NoteFilePicker
          existingLinks={notePicker.links}
          group={notePicker.group}
          position={notePicker.pos}
          onSelect={(path, name) => {
            setNotePicker(null);
            setNoteEditor({ path, name });
          }}
          onAddLink={(name) => addLinkToTask(notePicker.idx, name)}
          onRemoveLink={(name) => removeLinkFromTask(notePicker.idx, name)}
          onClose={() => setNotePicker(null)}
        />
      )}

      {/* Vault browser side panel */}
      {vaultBrowserOpen && (
        <div className="hidden md:block w-80 shrink-0 border-l overflow-y-auto max-h-[calc(100vh-80px)] sticky top-[80px] self-start relative" style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
          <VaultBrowser
            onClose={() => setVaultBrowserOpen(false)}
            stateRef={vaultBrowserStateRef}
            onOpenNote={(path, name) => setNoteEditor({ path, name })}
          />
        </div>
      )}
      </div>{/* end flex container */}

      {/* Note editor modal */}
      {noteEditor && (
        <NoteEditor
          initialPath={noteEditor.path}
          initialName={noteEditor.name}
          onClose={() => setNoteEditor(null)}
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
