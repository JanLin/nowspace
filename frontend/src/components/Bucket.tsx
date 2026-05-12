import React, { useState, useRef, useEffect } from "react";
import { api } from "../api";
import type { BucketTask, BucketResponse, TaskLink } from "../api";
import NoteFilePicker from "./NoteFilePicker";
import NoteEditor from "./NoteEditor";
import VaultBrowser, { type VaultBrowserState } from "./VaultBrowser";

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/* ── helpers ────────────────────────────────────────────────── */

function parseGroup(text: string): { group: string; label: string } {
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
  const [pinFilters, setPinFilters] = useState(true);
  const [addingAt, setAddingAt] = useState<{ afterIdx: number; group?: string } | null>(null);
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
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
    try { await api.saveBucket(entry.tasks, entry.pinned_groups); recordMtime(); } catch { /* auto-save retry */ }
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
    try { await api.saveBucket(entry.tasks, entry.pinned_groups); recordMtime(); } catch { /* auto-save retry */ }
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
          setExternalChange(true);
        }
      } catch { /* ignore */ }
    };
    const onVisChange = () => { if (!document.hidden) check(); };
    const onFocus = () => check();
    document.addEventListener("visibilitychange", onVisChange);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [data]);

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
      await api.saveBucket(data.tasks, data.pinned_groups);
      setSaved(true); setDirty(false); setExternalChange(false);
      recordMtime();
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    finally { setSaving(false); }
  };

  // Auto-save: 2s debounce
  useEffect(() => {
    if (autoSaveTimerRef.current) { clearTimeout(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
    if (dirty && !saving && data) {
      autoSaveTimerRef.current = setTimeout(saveBucket, 2000);
    }
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [dirty, saving, data]);

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

  const deleteTask = (idx: number) => {
    const next = [...tasks];
    next.splice(idx, 1);
    updateTasks(next);
  };

  const editTask = (idx: number, newText: string) => {
    const next = [...tasks];
    const old = next[idx];
    const { group } = parseGroup(old.text);
    next[idx] = { ...old, text: group ? `${group}: ${newText}` : newText };
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
    if (collapsedGroups.has(groupName)) {
      setCollapsedGroups((prev) => { const n = new Set(prev); n.delete(groupName); return n; });
    }

    dragRef.current = null; setDropTarget(null); setDropGroupTarget(null);
  };
  const handleDragEnd = () => { dragRef.current = null; setDropTarget(null); setDropGroupTarget(null); };

  /* ── build groups ────────────────────────────────────── */

  const allGroups = new Map<string, number>();
  tasks.forEach((t) => {
    const { group } = parseGroup(t.text);
    if (group) allGroups.set(group, (allGroups.get(group) || 0) + 1);
  });

  /* ── group collapse ──────────────────────────────────── */

  const toggleCollapseGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const collapseAll = () => setCollapsedGroups(new Set(allGroups.keys()));
  const expandAll = () => setCollapsedGroups(new Set());
  const allCollapsed = collapsedGroups.size > 0 && collapsedGroups.size >= allGroups.size;

  const sortedGroups = [...allGroups.entries()].sort((a, b) => {
    const aPin = data.pinned_groups.includes(a[0]) ? 0 : 1;
    const bPin = data.pinned_groups.includes(b[0]) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    return b[1] - a[1];
  }).slice(0, 9);

  const buildSections = (): Section[] => {
    const byGroup = new Map<string, Section>();
    const filtered = filterGroup
      ? tasks.map((t, i) => ({ task: t, originalIdx: i })).filter(({ task }) => parseGroup(task.text).group === filterGroup)
      : tasks.map((t, i) => ({ task: t, originalIdx: i }));

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
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];


  /* ── render ──────────────────────────────────────────── */

  return (
    <div className={`space-y-3 pb-12 ${vaultBrowserOpen ? "" : "max-w-3xl mx-auto"}`}>
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      <div className={`relative ${pinFilters ? "sticky top-0 z-30 pb-2 -mx-4 px-4 border-b" : ""}`} style={pinFilters ? { background: 'var(--bg)', borderColor: 'var(--border)' } : undefined}>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <span>{tasks.length} task{tasks.length !== 1 ? "s" : ""} in bucket</span>
        <button onClick={allCollapsed ? expandAll : collapseAll}
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          {allCollapsed ? "Expand all" : "Collapse all"}
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

      {/* Tasks + side panels: flex layout */}
      <div className="flex gap-0 items-start">
      <div className={`space-y-2 ${vaultBrowserOpen ? "flex-1 min-w-0" : "max-w-2xl w-full"}`}>
        {sections.map((section, si) => {
          const displayName = section.name || "Un-grouped";
          const hasMultipleSections = sections.length > 1;
          const showHeader = section.name || hasMultipleSections;
          return (
          <div key={`${displayName}-${si}`}>
            {showHeader && (
              <div className={`text-xs font-semibold tracking-wide px-1 py-1 flex items-center gap-1 relative cursor-pointer select-none transition-colors ${
                dropGroupTarget === section.name ? "bg-blue-100 rounded" : ""
              }`}
                onClick={() => toggleCollapseGroup(section.name)}
                onDragOver={(e) => handleDragOverGroup(e, section.name)}
                onDragLeave={() => setDropGroupTarget(null)}
                onDrop={(e) => { e.preventDefault(); handleDropOnGroup(section.name); }}
                style={{ color: section.name ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{collapsedGroups.has(section.name) ? "▸" : "▾"}</span> {displayName}
                <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>({section.items.length})</span>
              </div>
            )}
            {!collapsedGroups.has(section.name) && (
            <div className={showHeader ? "ml-4 border-l-2 pl-2" : ""} style={showHeader ? { borderColor: 'var(--border)' } : undefined}>
              {section.items.map(({ task, originalIdx, label }) => {
                const taskLinks = extractLinks(label);
                const hasLinks = taskLinks.length > 0;
                const hasSubtasks = task.subtasks && task.subtasks.length > 0;
                const isExpanded = expandedSubtasks.has(originalIdx);
                // Strip wiki links from display label
                const displayLabel = label.replace(WIKI_LINK_RE, "").trim();

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
                                className={`shrink-0 text-[10px] ${sub.done ? "text-green-400" : "text-gray-300 hover:text-green-400"}`}>
                                {sub.done ? "✓" : "○"}
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
          <button onDoubleClick={() => setAddingAt({ afterIdx: tasks.length - 1 })}
            className="w-full text-left text-sm py-2 px-2" style={{ color: 'var(--text-tertiary)' }}>
            + Add task (double-click)
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
