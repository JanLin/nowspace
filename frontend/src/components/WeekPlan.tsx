import React, { useState, useRef, useMemo, useEffect } from "react";
import { api, type WeekPlanResponse, type DayTasks, type Task } from "../api";

const PRIORITY_BADGE: Record<string, string> = {
  A: "bg-red-100 text-red-700",
  B: "bg-amber-100 text-amber-700",
  C: "bg-green-100 text-green-700",
  D: "bg-gray-100 text-gray-500",
};

const PRIORITIES = ["A", "B", "C", "D"] as const;

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DAY_LABELS: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

const PILLAR_ICONS: Record<string, { symbol: string; title: string }> = {
  social: { symbol: "\u{1F91D}", title: "Social connection" },
  recovery: { symbol: "\u{1F9D8}", title: "Recovery" },
  play: { symbol: "\u{1F3AE}", title: "Purposeful play / tinkering" },
  progress: { symbol: "\u{1F4CA}", title: "Structured progress" },
  longterm: { symbol: "\u{1F3AF}", title: "Long term goals" },
};

type ViewMode = "day" | "3day" | "5day" | "7day" | "weekend";

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Render text with markdown links as clickable <a> elements */
function renderLinkedText(text: string) {
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(MD_LINK_RE);
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    parts.push(
      <a
        key={match.index}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        className="text-blue-600 underline hover:text-blue-800"
      >
        {match[1]}
      </a>
    );
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  if (parts.length === 1 && typeof parts[0] === "string") return <>{text}</>;
  return <>{parts}</>;
}

/** Parse group prefix from task text. "Rotary: do X" => { group: "Rotary", label: "do X" } */
function parseGroup(text: string): { group: string; label: string } {
  const idx = text.indexOf(":");
  if (idx > 0 && idx < 30) {
    const group = text.slice(0, idx).trim();
    const label = text.slice(idx + 1).trim();
    if (group && label && !group.includes("[") && !group.endsWith("http") && !group.endsWith("https")) return { group, label };
  }
  return { group: "", label: text };
}

/** Collect all unique group names across all days */
function collectGroups(days: DayTasks[]): string[] {
  const groups = new Set<string>();
  for (const day of days) {
    for (const task of day.tasks) {
      const { group } = parseGroup(task.text);
      if (group) groups.add(group);
    }
  }
  return Array.from(groups).sort();
}

/** Reorder tasks within a day: move all tasks of moveGroup before targetGroup */
function reorderGroups(tasks: Task[], moveGroup: string, targetGroup: string, before: boolean): Task[] {
  const grouped = new Map<string, Task[]>();
  const groupOrder: string[] = [];
  for (const task of tasks) {
    const { group } = parseGroup(task.text);
    if (!grouped.has(group)) {
      grouped.set(group, []);
      groupOrder.push(group);
    }
    grouped.get(group)!.push(task);
  }
  const fromIdx = groupOrder.indexOf(moveGroup);
  if (fromIdx === -1) return tasks;
  groupOrder.splice(fromIdx, 1);
  let toIdx = groupOrder.indexOf(targetGroup);
  if (toIdx === -1) return tasks;
  if (!before) toIdx += 1;
  groupOrder.splice(toIdx, 0, moveGroup);
  const result: Task[] = [];
  for (const g of groupOrder) result.push(...(grouped.get(g) || []));
  return result;
}

/** Compute per-priority sequence numbers, e.g. A1, A2, B1, C1, C2 */
function computeSeqNumbers(tasks: Task[]): Map<number, number> {
  const counters: Record<string, number> = {};
  const result = new Map<number, number>();
  tasks.forEach((task, i) => {
    const p = task.priority || "C";
    counters[p] = (counters[p] || 0) + 1;
    result.set(i, counters[p]);
  });
  return result;
}

const PRIORITY_ORDER_MAP: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Sort tasks by priority (A > B > C > D), active before done */
function sortTasksByPriority(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER_MAP[a.priority] ?? 4;
    const pb = PRIORITY_ORDER_MAP[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    if (a.done !== b.done) return a.done ? 1 : -1;
    return 0;
  });
}

/** Move a group to the start or end position within a day */
function moveGroupToPosition(tasks: Task[], groupName: string, position: 'start' | 'end'): Task[] {
  const grouped = new Map<string, Task[]>();
  const groupOrder: string[] = [];
  for (const task of tasks) {
    const { group } = parseGroup(task.text);
    if (!grouped.has(group)) { grouped.set(group, []); groupOrder.push(group); }
    grouped.get(group)!.push(task);
  }
  const idx = groupOrder.indexOf(groupName);
  if (idx === -1) return tasks;
  groupOrder.splice(idx, 1);
  if (position === 'start') groupOrder.unshift(groupName);
  else groupOrder.push(groupName);
  const result: Task[] = [];
  for (const g of groupOrder) result.push(...(grouped.get(g) || []));
  return result;
}

function categoryLabel(sourceFile: string): string {
  return sourceFile.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

/** Auto-focus input when it appears */
function AutoFocusInput({
  onSubmit,
  onCancel,
  placeholder,
  className,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setValue("");
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={submit}
      placeholder={placeholder || "New task... (prefix: for group)"}
      className={className || "w-full text-[11px] px-1.5 py-1 border border-blue-300 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"}
    />
  );
}

/** Inline edit input — pre-filled with existing text, auto-selects all */
function EditInput({
  initialValue,
  onSave,
  onCancel,
  className,
}: {
  initialValue: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialValue) {
      onSave(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") onCancel();
        e.stopPropagation();
      }}
      onBlur={save}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={className || "w-full text-sm px-2 py-1 border border-blue-300 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"}
    />
  );
}

export default function WeekPlan() {
  const [data, setData] = useState<WeekPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(() => {
    const jsDay = new Date().getDay();
    return jsDay === 0 ? 6 : jsDay - 1;
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [autoSavePaused, setAutoSavePaused] = useState(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [priorityMenu, setPriorityMenu] = useState<{ day: number; task: number } | null>(null);
  const [groupView, setGroupView] = useState(true);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Inline add state
  const [addingAt, setAddingAt] = useState<{ dayIdx: number; afterIdx: number } | null>(null);

  // Drag state — supports both task and group dragging
  const dragRef = useRef<{ fromDay: number; fromIdx: number; group: string | null } | null>(null);
  const dragGroupRef = useRef<{ fromDay: number; groupName: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ day: number; idx: number } | null>(null);
  const [dropGroupTarget, setDropGroupTarget] = useState<{ day: number; groupName: string } | null>(null);
  const [editingTask, setEditingTask] = useState<{ dayIdx: number; taskIdx: number } | null>(null);
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<string>>(new Set());
  const [editingSubtask, setEditingSubtask] = useState<{ dayIdx: number; taskIdx: number; subIdx: number } | null>(null);
  const [addingSubtask, setAddingSubtask] = useState<{ dayIdx: number; taskIdx: number } | null>(null);

  const allGroups = useMemo(() => (data ? collectGroups(data.days) : []), [data]);

  const toggleCollapsed = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const todayIdx = (() => {
    if (!data) return 0;
    if (data.is_future) return 0;
    const jsDay = new Date().getDay();
    return jsDay === 0 ? 6 : jsDay - 1;
  })();

  const fetchWeek = async () => {
    setLoading(true);
    setError("");
    setDirty(false);
    try {
      const result = await api.getWeekPlan();
      // Preserve file order as-is — group view order is the master order
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load week plan");
    } finally {
      setLoading(false);
    }
  };

  const saveWeek = async () => {
    if (!data) return;
    setSaving(true);
    try {
      await api.saveWeekPlan(data.days);
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Auto-save: save every 30s when dirty and not paused
  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (dirty && !autoSavePaused && !saving && data) {
      autoSaveTimerRef.current = setTimeout(() => {
        saveWeek();
      }, 30000);
    }
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [dirty, autoSavePaused, saving, data]);

  const addTask = (dayIdx: number, afterIdx: number, text: string) => {
    if (!data) return;
    const newTask: Task = {
      text, done: false, source_file: "Plan Week.md", context: "", tags: [], priority: "C", pillars: [], subtasks: [], focused: false, waiting: false,
    };
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks.splice(afterIdx + 1, 0, newTask);
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
    setAddingAt({ dayIdx, afterIdx: afterIdx + 1 });
  };

  const toggleDone = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks[taskIdx] = { ...tasks[taskIdx], done: !tasks[taskIdx].done };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const toggleFocus = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks[taskIdx] = { ...tasks[taskIdx], focused: !tasks[taskIdx].focused };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const toggleWaiting = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks[taskIdx] = { ...tasks[taskIdx], waiting: !tasks[taskIdx].waiting };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const deleteTask = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks.splice(taskIdx, 1);
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const editTask = (dayIdx: number, taskIdx: number, newText: string) => {
    if (!data) return;
    const trimmed = newText.trim();
    if (!trimmed) return; // don't allow empty — use delete instead
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      // Preserve group prefix if the task had one and user edited only the label
      tasks[taskIdx] = { ...tasks[taskIdx], text: trimmed };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
    setEditingTask(null);
  };

  // --- Subtask handlers ---
  const toggleExpandSubtasks = (dayIdx: number, taskIdx: number) => {
    const key = `${dayIdx}-${taskIdx}`;
    setExpandedSubtasks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSubtaskDone = (dayIdx: number, taskIdx: number, subIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const subtasks = [...(tasks[taskIdx].subtasks || [])];
      subtasks[subIdx] = { ...subtasks[subIdx], done: !subtasks[subIdx].done };
      tasks[taskIdx] = { ...tasks[taskIdx], subtasks };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const deleteSubtask = (dayIdx: number, taskIdx: number, subIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const subtasks = [...(tasks[taskIdx].subtasks || [])];
      subtasks.splice(subIdx, 1);
      tasks[taskIdx] = { ...tasks[taskIdx], subtasks };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const editSubtask = (dayIdx: number, taskIdx: number, subIdx: number, newText: string) => {
    if (!data) return;
    const trimmed = newText.trim();
    if (!trimmed) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const subtasks = [...(tasks[taskIdx].subtasks || [])];
      subtasks[subIdx] = { ...subtasks[subIdx], text: trimmed };
      tasks[taskIdx] = { ...tasks[taskIdx], subtasks };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
    setEditingSubtask(null);
  };

  const addSubtask = (dayIdx: number, taskIdx: number, text: string) => {
    if (!data) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const subtasks = [...(tasks[taskIdx].subtasks || []), { text: trimmed, done: false }];
      tasks[taskIdx] = { ...tasks[taskIdx], subtasks };
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
  };

  const startBreakdown = (dayIdx: number, taskIdx: number) => {
    const key = `${dayIdx}-${taskIdx}`;
    setExpandedSubtasks((prev) => new Set(prev).add(key));
    setAddingSubtask({ dayIdx, taskIdx });
  };

  const cancelAddSubtask = (dayIdx: number, taskIdx: number) => {
    setAddingSubtask(null);
    // Collapse if task still has no subtasks
    if (data) {
      const task = data.days[dayIdx]?.tasks[taskIdx];
      if (!task?.subtasks?.length) {
        const key = `${dayIdx}-${taskIdx}`;
        setExpandedSubtasks((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    }
  };

  const setPriority = (dayIdx: number, taskIdx: number, priority: string) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks[taskIdx] = { ...tasks[taskIdx], priority };
      // Don't re-sort — group view order is master; seq numbers will update automatically
      return { ...d, tasks };
    });
    setData({ ...data, days });
    setDirty(true);
    setPriorityMenu(null);
  };

  // --- Task drag handlers ---
  const handleDragStart = (dayIdx: number, taskIdx: number, group: string | null = null) => {
    dragRef.current = { fromDay: dayIdx, fromIdx: taskIdx, group };
    dragGroupRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent, dayIdx: number, taskIdx: number, _group: string | null = null) => {
    // Accept both individual task drags and group drags on task positions
    if (dragGroupRef.current) {
      if (dragGroupRef.current.fromDay !== dayIdx) return;
      e.preventDefault();
      setDropTarget({ day: dayIdx, idx: taskIdx });
      return;
    }
    if (!dragRef.current) return;
    e.preventDefault();
    setDropTarget({ day: dayIdx, idx: taskIdx });
  };

  const handleDayDragOver = (e: React.DragEvent, dayIdx: number) => {
    e.preventDefault();
    if (!data) return;
    setDropTarget({ day: dayIdx, idx: data.days[dayIdx].tasks.length });
  };

  const handleDrop = (dayIdx: number, taskIdx: number) => {
    if (!data) return;

    // Handle group dropped on a task position (same-day or cross-day)
    if (dragGroupRef.current) {
      const fromDay = dragGroupRef.current.fromDay;
      const groupName = dragGroupRef.current.groupName;
      const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));

      // Extract group tasks from source day
      const sourceTasks = days[fromDay].tasks;
      const groupTasks = sourceTasks.filter((t) => parseGroup(t.text).group === groupName);
      days[fromDay].tasks = sourceTasks.filter((t) => parseGroup(t.text).group !== groupName);

      if (fromDay === dayIdx) {
        // Same-day move: find insert position in the remaining array
        const remaining = days[dayIdx].tasks;
        let insertIdx = remaining.length;
        // taskIdx refers to original array — find the target task in remaining
        const origTasks = data.days[dayIdx].tasks;
        for (let i = taskIdx; i < origTasks.length; i++) {
          const pos = remaining.indexOf(origTasks[i]);
          if (pos >= 0) { insertIdx = pos; break; }
        }
        if (insertIdx === remaining.length && taskIdx > 0) {
          for (let i = taskIdx - 1; i >= 0; i--) {
            const pos = remaining.indexOf(origTasks[i]);
            if (pos >= 0) { insertIdx = pos + 1; break; }
          }
        }
        remaining.splice(insertIdx, 0, ...groupTasks);
      } else {
        // Cross-day move: insert group tasks at target position in destination day
        const insertIdx = Math.min(taskIdx, days[dayIdx].tasks.length);
        days[dayIdx].tasks.splice(insertIdx, 0, ...groupTasks);
      }

      setData({ ...data, days });
      setDirty(true);
      dragGroupRef.current = null;
      setDropTarget(null);
      setDropGroupTarget(null);
      return;
    }

    if (!dragRef.current) return;
    const { fromDay, fromIdx } = dragRef.current;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const [movedTask] = days[fromDay].tasks.splice(fromIdx, 1);
    let insertIdx = taskIdx;
    if (fromDay === dayIdx && fromIdx < taskIdx) insertIdx = Math.max(0, insertIdx - 1);
    days[dayIdx].tasks.splice(insertIdx, 0, movedTask);
    setData({ ...data, days });
    setDirty(true);
    dragRef.current = null;
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    dragRef.current = null;
    dragGroupRef.current = null;
    setDropTarget(null);
    setDropGroupTarget(null);
  };

  // --- Group drag handlers ---
  const handleGroupDragStart = (dayIdx: number, groupName: string) => {
    dragGroupRef.current = { fromDay: dayIdx, groupName };
    dragRef.current = null;
  };

  const handleGroupDragOver = (e: React.DragEvent, dayIdx: number, groupName: string) => {
    if (!dragGroupRef.current) return;
    e.preventDefault();
    setDropGroupTarget({ day: dayIdx, groupName });
  };

  const handleGroupDrop = (dayIdx: number, targetGroupName: string) => {
    if (!data || !dragGroupRef.current) return;
    if (dragGroupRef.current.fromDay !== dayIdx) return;
    const moveGroup = dragGroupRef.current.groupName;
    if (moveGroup === targetGroupName) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      return { ...d, tasks: reorderGroups(d.tasks, moveGroup, targetGroupName, true) };
    });
    setData({ ...data, days });
    setDirty(true);
    dragGroupRef.current = null;
    setDropGroupTarget(null);
  };

  // --- Group drop to absolute position (start/end) ---
  const handleGroupDropToPosition = (dayIdx: number, position: 'start' | 'end') => {
    if (!data || !dragGroupRef.current) return;
    if (dragGroupRef.current.fromDay !== dayIdx) return;
    const groupName = dragGroupRef.current.groupName;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      return { ...d, tasks: moveGroupToPosition(d.tasks, groupName, position) };
    });
    setData({ ...data, days });
    setDirty(true);
    dragGroupRef.current = null;
    setDropGroupTarget(null);
  };

  // --- View helpers ---
  const visibleDays: number[] = (() => {
    switch (viewMode) {
      case "day": return [selectedDayIdx];
      case "3day": {
        // From selected day forward, but if Sat/Sun show days before
        const idx = selectedDayIdx;
        if (idx >= 5) {
          // Saturday(5) or Sunday(6): show backwards to fill 3 days
          return [Math.max(0, idx - 2), Math.max(0, idx - 1), idx].filter((v, i, a) => a.indexOf(v) === i);
        }
        // Weekday: show forward, clamp to end of week
        const days = [idx, Math.min(6, idx + 1), Math.min(6, idx + 2)];
        return [...new Set(days)];
      }
      case "5day": return [0, 1, 2, 3, 4];
      case "weekend": return [5, 6];
      default: return [0, 1, 2, 3, 4, 5, 6];
    }
  })();

  const gridCols = viewMode === "3day" ? "grid-cols-3" : viewMode === "weekend" ? "grid-cols-2" : viewMode === "5day" ? "grid-cols-5" : "grid-cols-7";

  const getFilteredTasks = (tasks: Task[]): Task[] => {
    let filtered = tasks;
    if (filterGroup) {
      filtered = filtered.filter((t) => parseGroup(t.text).group === filterGroup);
    }
    if (!showCompleted) {
      filtered = filtered.filter((t) => !t.done);
    }
    return filtered;
  };

  const buildDayGroups = (tasks: Task[]): { name: string; items: { task: Task; originalIdx: number; label: string }[] }[] => {
    // Build CONTIGUOUS sections — each run of same-prefix tasks is its own section.
    // Ungrouped tasks between groups appear as separate sections so they can be
    // individually repositioned relative to named groups.
    const sections: { name: string; items: { task: Task; originalIdx: number; label: string }[] }[] = [];
    tasks.forEach((task, idx) => {
      const { group, label } = parseGroup(task.text);
      if (filterGroup && group !== filterGroup) return;
      if (!showCompleted && task.done) return;
      const last = sections[sections.length - 1];
      if (last && last.name === group) {
        last.items.push({ task, originalIdx: idx, label });
      } else {
        sections.push({ name: group, items: [{ task, originalIdx: idx, label }] });
      }
    });
    return sections;
  };

  // --- Subtask list renderer ---
  const renderSubtasks = (dayIdx: number, taskIdx: number, task: Task, compact: boolean) => {
    const key = `${dayIdx}-${taskIdx}`;
    if (!expandedSubtasks.has(key)) return null;
    const subtasks = task.subtasks || [];
    const textSize = compact ? "text-[10px]" : "text-xs";
    const isAdding = addingSubtask?.dayIdx === dayIdx && addingSubtask?.taskIdx === taskIdx;

    return (
      <div className={`${compact ? "ml-5" : "ml-8"} pl-2 border-l-2 border-amber-200 ${textSize} py-0.5`}>
        {subtasks.map((sub, si) => (
          <div key={si} className="group/sub flex items-center gap-1.5 py-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); toggleSubtaskDone(dayIdx, taskIdx, si); }}
              className={`shrink-0 text-[10px] leading-none hover:opacity-70 ${sub.done ? "text-green-400" : "text-gray-300 hover:text-green-400"}`}
            >
              {sub.done ? "\u2713" : "\u25CB"}
            </button>
            {editingSubtask?.dayIdx === dayIdx && editingSubtask?.taskIdx === taskIdx && editingSubtask?.subIdx === si ? (
              <EditInput
                initialValue={sub.text}
                onSave={(text) => editSubtask(dayIdx, taskIdx, si, text)}
                onCancel={() => setEditingSubtask(null)}
                className={`flex-1 ${textSize} px-1 py-0.5 border border-amber-300 rounded bg-white outline-none focus:ring-1 focus:ring-amber-400`}
              />
            ) : (
              <span
                onClick={(e) => { e.stopPropagation(); if (!sub.done) setEditingSubtask({ dayIdx, taskIdx, subIdx: si }); }}
                className={`flex-1 ${sub.done ? "text-gray-400 line-through" : "text-gray-700 cursor-text hover:text-amber-700"}`}
              >
                {sub.text}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); deleteSubtask(dayIdx, taskIdx, si); }}
              className="shrink-0 text-[10px] text-gray-300 hover:text-red-500 opacity-0 group-hover/sub:opacity-100 transition-opacity"
            >
              &times;
            </button>
          </div>
        ))}
        {/* Add subtask input */}
        {isAdding ? (
          <div className="py-0.5">
            <AutoFocusInput
              onSubmit={(text) => { addSubtask(dayIdx, taskIdx, text); }}
              onCancel={() => cancelAddSubtask(dayIdx, taskIdx)}
              placeholder="Add step..."
              className={`w-full ${textSize} px-1.5 py-0.5 border border-amber-300 rounded bg-white outline-none focus:ring-1 focus:ring-amber-400`}
            />
          </div>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setAddingSubtask({ dayIdx, taskIdx }); }}
            className="text-gray-300 hover:text-amber-500 py-0.5 transition-colors"
          >
            + Add step
          </button>
        )}
      </div>
    );
  };

  // --- Compact task item for grid views (5day, 7day, weekend) ---
  const renderCompactTaskItem = (task: Task, dayIdx: number, taskIdx: number, displayText: string, group: string | null, seqLabel: string = "") => (
    <div
      key={`${task.text}-${taskIdx}`}
      draggable={!task.done}
      onDragStart={() => handleDragStart(dayIdx, taskIdx, group)}
      onDragOver={(e) => handleDragOver(e, dayIdx, taskIdx, group)}
      onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, taskIdx); }}
      onDragEnd={handleDragEnd}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setAddingAt({ dayIdx, afterIdx: taskIdx });
      }}
      className={`group/task flex items-start gap-1 py-0.5 px-1 rounded text-[11px] leading-tight select-none ${
        dropTarget?.day === dayIdx && dropTarget?.idx === taskIdx
          ? "border-t-2 border-blue-400"
          : "border-t-2 border-transparent"
      } ${
        task.done
          ? "opacity-40"
          : "cursor-grab active:cursor-grabbing hover:bg-white/80"
      }`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); toggleDone(dayIdx, taskIdx); }}
        className={`shrink-0 text-[10px] leading-none hover:opacity-70 ${task.done ? "text-green-400" : "text-gray-300 hover:text-green-400"}`}
        title={task.done ? "Mark undone" : "Mark done"}
      >
        {task.done ? "\u2713" : "\u25CB"}
      </button>
      <div className="relative shrink-0">
        {task.done ? (
          <span className={`px-1 py-0 rounded text-[10px] font-bold ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}>
            {task.priority || "C"}{seqLabel}
          </span>
        ) : (
          <>
            <button
              onClick={() => setPriorityMenu(
                priorityMenu?.day === dayIdx && priorityMenu?.task === taskIdx ? null : { day: dayIdx, task: taskIdx }
              )}
              className={`px-1 py-0 rounded text-[10px] font-bold cursor-pointer hover:opacity-70 ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}
            >
              {task.priority || "C"}{seqLabel}
            </button>
            {priorityMenu?.day === dayIdx && priorityMenu?.task === taskIdx && (
              <div className="absolute left-0 top-full mt-0.5 flex gap-0.5 z-20 bg-white rounded shadow-md p-0.5">
                {PRIORITIES.filter((p) => p !== task.priority).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPriority(dayIdx, taskIdx, p)}
                    className={`px-1 py-0 rounded text-[10px] font-bold cursor-pointer hover:opacity-70 ${PRIORITY_BADGE[p]}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {editingTask?.dayIdx === dayIdx && editingTask?.taskIdx === taskIdx ? (
        <EditInput
          initialValue={task.text}
          onSave={(text) => editTask(dayIdx, taskIdx, text)}
          onCancel={() => setEditingTask(null)}
          className="flex-1 text-[11px] px-1 py-0.5 border border-blue-300 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"
        />
      ) : (
        <span
          onClick={(e) => { e.stopPropagation(); if (!task.done) setEditingTask({ dayIdx, taskIdx }); }}
          className={`break-words flex-1 ${task.focused && !task.done ? "font-bold" : ""} ${task.done ? "text-gray-400 line-through" : "text-gray-800 cursor-text hover:text-blue-700"}`}
        >
          {task.waiting && <span className="mr-0.5" title="Waiting">⏳</span>}
          {renderLinkedText(displayText)}
        </span>
      )}
      {/* Wait hourglass toggle */}
      {!task.done && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleWaiting(dayIdx, taskIdx); }}
          className={`shrink-0 text-[10px] transition-opacity ${task.waiting ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/task:opacity-30 hover:!opacity-100"}`}
          title={task.waiting ? "Remove wait" : "Mark as waiting"}
        >
          ⏳
        </button>
      )}
      {/* Focus horn icon */}
      {!task.done && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleFocus(dayIdx, taskIdx); }}
          className={`shrink-0 text-[10px] transition-opacity ${task.focused ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/task:opacity-30 hover:!opacity-100"}`}
          title={task.focused ? "Remove focus" : "Set as focus"}
        >
          🎺
        </button>
      )}
      {/* Elephant icon — breakdown indicator */}
      {task.subtasks?.length > 0 ? (
        <button
          onClick={(e) => { e.stopPropagation(); toggleExpandSubtasks(dayIdx, taskIdx); }}
          className="shrink-0 text-[10px] opacity-60 hover:opacity-100 transition-opacity"
          title={`${task.subtasks.length} step${task.subtasks.length > 1 ? "s" : ""} — click to ${expandedSubtasks.has(`${dayIdx}-${taskIdx}`) ? "collapse" : "expand"}`}
        >
          🐘
        </button>
      ) : !task.done ? (
        <button
          onClick={(e) => { e.stopPropagation(); startBreakdown(dayIdx, taskIdx); }}
          className="shrink-0 text-[10px] opacity-0 group-hover/task:opacity-30 hover:!opacity-100 transition-opacity"
          title="Break down into steps"
        >
          🐘
        </button>
      ) : null}
      <button
        onClick={(e) => { e.stopPropagation(); deleteTask(dayIdx, taskIdx); }}
        className="shrink-0 text-[10px] text-gray-400 hover:text-red-500 opacity-0 group-hover/task:opacity-100 transition-opacity"
        title="Delete task"
      >
        &times;
      </button>
    </div>
  );

  // --- Full-size task item for Day view ---
  const renderDayTaskItem = (task: Task, dayIdx: number, taskIdx: number, displayText: string, seqLabel: string, group: string | null) => (
    <div key={`day-${taskIdx}`}>
      <div
        draggable={!task.done}
        onDragStart={!task.done ? () => handleDragStart(dayIdx, taskIdx, group) : undefined}
        onDragOver={(e) => handleDragOver(e, dayIdx, taskIdx, group)}
        onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, taskIdx); }}
        onDragEnd={handleDragEnd}
        onDoubleClick={(e) => { e.stopPropagation(); setAddingAt({ dayIdx, afterIdx: taskIdx }); }}
        className={`group/task flex items-center gap-2 py-1 px-2 rounded text-sm select-none ${
          dropTarget?.day === dayIdx && dropTarget?.idx === taskIdx
            ? "border-t-2 border-blue-400"
            : "border-t-2 border-transparent"
        } ${
          task.done
            ? "opacity-50"
            : "cursor-grab active:cursor-grabbing hover:bg-gray-50"
        }`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); toggleDone(dayIdx, taskIdx); }}
          className={`shrink-0 hover:opacity-70 ${task.done ? "text-green-400" : "text-gray-300 hover:text-green-400"}`}
          title={task.done ? "Mark undone" : "Mark done"}
        >
          {task.done ? "\u2713" : "\u25CB"}
        </button>
        <div className="relative shrink-0">
          {task.done ? (
            <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}>
              {task.priority || "C"}{seqLabel}
            </span>
          ) : (
            <>
              <button
                onClick={() => setPriorityMenu(
                  priorityMenu?.day === dayIdx && priorityMenu?.task === taskIdx ? null : { day: dayIdx, task: taskIdx }
                )}
                className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}
                title="Click to change priority"
              >
                {task.priority || "C"}{seqLabel}
              </button>
              {priorityMenu?.day === dayIdx && priorityMenu?.task === taskIdx && (
                <div className="absolute left-0 top-full mt-1 flex gap-0.5 z-10 bg-white rounded shadow-md p-1">
                  {PRIORITIES.filter((p) => p !== task.priority).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPriority(dayIdx, taskIdx, p)}
                      className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[p]}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {editingTask?.dayIdx === dayIdx && editingTask?.taskIdx === taskIdx ? (
          <EditInput
            initialValue={task.text}
            onSave={(text) => editTask(dayIdx, taskIdx, text)}
            onCancel={() => setEditingTask(null)}
            className="flex-1 text-sm px-1.5 py-0.5 border border-blue-300 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); if (!task.done) setEditingTask({ dayIdx, taskIdx }); }}
            className={`flex-1 ${task.focused && !task.done ? "font-bold" : ""} ${task.done ? "text-gray-400 line-through" : "text-gray-900 cursor-text hover:text-blue-700"}`}
          >
            {task.waiting && <span className="mr-1" title="Waiting">⏳</span>}
            {renderLinkedText(displayText)}
          </span>
        )}
        {task.pillars?.length > 0 && (
          <span className="shrink-0" title={task.pillars.map((p) => PILLAR_ICONS[p]?.title || p).join(", ")}>
            {task.pillars.map((p) => PILLAR_ICONS[p]?.symbol || p).join("")}
          </span>
        )}
        {/* Wait hourglass toggle */}
        {!task.done && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleWaiting(dayIdx, taskIdx); }}
            className={`shrink-0 text-sm transition-opacity ${task.waiting ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/task:opacity-30 hover:!opacity-100"}`}
            title={task.waiting ? "Remove wait" : "Mark as waiting"}
          >
            ⏳
          </button>
        )}
        {/* Focus horn icon */}
        {!task.done && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleFocus(dayIdx, taskIdx); }}
            className={`shrink-0 text-sm transition-opacity ${task.focused ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover/task:opacity-30 hover:!opacity-100"}`}
            title={task.focused ? "Remove focus" : "Set as focus"}
          >
            🎺
          </button>
        )}
        {/* Elephant icon — breakdown indicator */}
        {task.subtasks?.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpandSubtasks(dayIdx, taskIdx); }}
            className="shrink-0 text-sm opacity-60 hover:opacity-100 transition-opacity"
            title={`${task.subtasks.length} step${task.subtasks.length > 1 ? "s" : ""} — click to ${expandedSubtasks.has(`${dayIdx}-${taskIdx}`) ? "collapse" : "expand"}`}
          >
            🐘
          </button>
        ) : !task.done ? (
          <button
            onClick={(e) => { e.stopPropagation(); startBreakdown(dayIdx, taskIdx); }}
            className="shrink-0 text-sm opacity-0 group-hover/task:opacity-30 hover:!opacity-100 transition-opacity"
            title="Break down into steps (white elephant)"
          >
            🐘
          </button>
        ) : null}
        <button
          onClick={(e) => { e.stopPropagation(); deleteTask(dayIdx, taskIdx); }}
          className="shrink-0 text-gray-400 hover:text-red-500 opacity-0 group-hover/task:opacity-100 transition-opacity"
          title="Delete task"
        >
          &times;
        </button>
      </div>
    </div>
  );

  const renderAddInput = (dayIdx: number, afterIdx: number) => {
    if (!addingAt || addingAt.dayIdx !== dayIdx || addingAt.afterIdx !== afterIdx) return null;
    return (
      <div className="py-0.5 px-1">
        <AutoFocusInput
          onSubmit={(text) => addTask(dayIdx, afterIdx, text)}
          onCancel={() => setAddingAt(null)}
        />
      </div>
    );
  };

  // Count completed across visible days for the toggle label
  const completedCount = data
    ? visibleDays.reduce((sum, di) => sum + data.days[di].tasks.filter((t) => t.done).length, 0)
    : 0;

  // --- Day view renderer ---
  const renderDayView = () => {
    if (!data) return null;
    const day = data.days[selectedDayIdx];
    if (!day) return null;

    const filteredTasks = getFilteredTasks(day.tasks);
    const seqNumbers = computeSeqNumbers(filteredTasks);

    // Build groups for grouped view
    const groups = buildDayGroups(day.tasks);

    return (
      <div className="max-w-lg mx-auto space-y-2">
        {/* Day info bar */}
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span className="font-medium text-gray-700">
            {(day.heading || "").replace(/^#+\s*/, "") || DAY_LABELS[day.day] || day.day}
          </span>
          <span className="px-2 py-0.5 bg-gray-100 rounded text-xs font-medium">
            {selectedDayIdx >= 5 ? "weekend" : "weekday"}
          </span>
          <span className="flex-1">
            {filteredTasks.filter(t => !t.done).length} tasks for {DAY_LABELS[day.day] || day.day}
          </span>
        </div>

        {/* Tasks — flat view */}
        {!groupView && (
          <div
            className="space-y-0.5"
            onDragOver={(e) => { if (dragGroupRef.current) return; e.preventDefault(); setDropTarget({ day: selectedDayIdx, idx: day.tasks.length }); }}
            onDrop={() => handleDrop(selectedDayIdx, day.tasks.length)}
          >
            {filteredTasks.map((task, fi) => {
              const originalIdx = day.tasks.indexOf(task);
              const seq = seqNumbers.get(fi) ?? "";
              return (
                <div key={`flat-${originalIdx}`}>
                  {renderDayTaskItem(task, selectedDayIdx, originalIdx, task.text, String(seq), null)}
                  {renderSubtasks(selectedDayIdx, originalIdx, task, false)}
                </div>
              );
            })}
            {/* Bottom drop zone indicator */}
            {dropTarget?.day === selectedDayIdx && dropTarget?.idx === day.tasks.length && (
              <div className="h-0.5 bg-blue-400 rounded" />
            )}
            <button
              onClick={() => setAddingAt({ dayIdx: selectedDayIdx, afterIdx: day.tasks.length - 1 })}
              className="w-full text-xs text-gray-300 hover:text-blue-400 py-1 transition-colors text-left px-2"
            >
              + Add task
            </button>
            {addingAt?.dayIdx === selectedDayIdx && addingAt?.afterIdx === day.tasks.length - 1 && !filteredTasks.some(t => day.tasks.indexOf(t) === day.tasks.length - 1) && (
              <div className="py-0.5 px-2">
                <AutoFocusInput
                  onSubmit={(text) => addTask(selectedDayIdx, day.tasks.length - 1, text)}
                  onCancel={() => setAddingAt(null)}
                  className="w-full text-sm px-2 py-1.5 border border-blue-300 rounded-lg bg-white outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
            )}
          </div>
        )}

        {/* Tasks — grouped view */}
        {groupView && (
          <div
            className="space-y-1"
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={() => handleDrop(selectedDayIdx, day.tasks.length)}
          >
            {groups.map((section, sectionIdx) => {
              const firstOrigIdx = section.items[0]?.originalIdx ?? 0;
              const sectionKey = section.name ? `${section.name}-${firstOrigIdx}` : `ungrouped-${firstOrigIdx}`;
              const isCollapsed = section.name ? collapsedGroups.has(section.name) : false;
              const doneInSection = section.items.filter((e) => e.task.done).length;
              const activeInSection = section.items.length - doneInSection;
              return (
                <div key={sectionKey}>
                  {/* Group header — draggable, collapsible, and accepts drops */}
                  {section.name ? (
                    <div
                      draggable
                      onDragStart={(e) => { e.stopPropagation(); handleGroupDragStart(selectedDayIdx, section.name); }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropTarget({ day: selectedDayIdx, idx: firstOrigIdx });
                      }}
                      onDrop={(e) => { e.stopPropagation(); handleDrop(selectedDayIdx, firstOrigIdx); }}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center gap-1.5 py-1.5 px-2 cursor-grab active:cursor-grabbing rounded group/hdr hover:bg-gray-50 ${
                        dropTarget?.day === selectedDayIdx && dropTarget?.idx === firstOrigIdx
                          ? "border-t-2 border-blue-400" : "border-t-2 border-transparent"
                      }`}
                    >
                      <span className="text-gray-300 group-hover/hdr:text-gray-400 text-xs select-none" title="Drag to move group">&#x2630;</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleCollapsed(section.name); }}
                        className="text-gray-400 hover:text-gray-600 text-xs w-4 text-center"
                        title={isCollapsed ? "Expand group" : "Collapse group"}
                      >
                        {isCollapsed ? "▸" : "▾"}
                      </button>
                      <span className="text-sm font-semibold text-gray-700">{section.name}</span>
                      <span className="text-xs text-gray-400">
                        ({activeInSection}{doneInSection > 0 && <span className="text-green-500"> +{doneInSection}✓</span>})
                      </span>
                    </div>
                  ) : null}
                  {/* Tasks within section — hidden when collapsed */}
                  {!isCollapsed && (
                    <div className={section.name ? "ml-4 border-l-2 border-gray-100 pl-2" : ""}>
                      {section.items.map((entry) => {
                        const seq = seqNumbers.get(filteredTasks.indexOf(entry.task)) || "";
                        return (
                          <div key={`wrap-day-${entry.originalIdx}`}>
                            {renderDayTaskItem(entry.task, selectedDayIdx, entry.originalIdx, entry.label, String(seq), section.name || null)}
                            {renderSubtasks(selectedDayIdx, entry.originalIdx, entry.task, false)}
                            {renderAddInput(selectedDayIdx, entry.originalIdx)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Add task button */}
            <button
              onClick={() => setAddingAt({ dayIdx: selectedDayIdx, afterIdx: day.tasks.length - 1 })}
              className="w-full text-xs text-gray-300 hover:text-blue-400 py-1 transition-colors text-left px-2"
            >
              + Add task
            </button>
            {addingAt?.dayIdx === selectedDayIdx && addingAt?.afterIdx === day.tasks.length - 1 && (
              <div className="py-0.5 px-2">
                <AutoFocusInput
                  onSubmit={(text) => addTask(selectedDayIdx, day.tasks.length - 1, text)}
                  onCancel={() => setAddingAt(null)}
                  className="w-full text-sm px-2 py-1.5 border border-blue-300 rounded-lg bg-white outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
            )}
          </div>
        )}

        {/* Auto-save status is shown in the header button */}
      </div>
    );
  };

  // --- Grid view renderer (5day, 7day, weekend) ---
  const renderGridView = () => {
    if (!data) return null;
    return (
      <>
        <div className={`grid ${gridCols} gap-2`}>
          {visibleDays.map((dayIdx) => {
            const day = data.days[dayIdx];
            const isToday = dayIdx === todayIdx;
            const dayName = DAY_LABELS[day.day] || day.day;
            const filteredTasks = getFilteredTasks(day.tasks);
            const seqNumbers = computeSeqNumbers(filteredTasks);
            const taskCount = filteredTasks.filter((t) => !t.done).length;
            const doneCount = filteredTasks.filter((t) => t.done).length;

            return (
              <div
                key={day.day}
                className={`rounded-lg border p-2 min-h-[200px] ${
                  isToday ? "border-blue-300 bg-blue-50/30" : "border-gray-200 bg-gray-50/50"
                }`}
                onDragOver={(e) => handleDayDragOver(e, dayIdx)}
                onDrop={() => handleDrop(dayIdx, day.tasks.length)}
                onDoubleClick={() => setAddingAt({ dayIdx, afterIdx: day.tasks.length - 1 })}
              >
                {/* Day header */}
                <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-100">
                  <button
                    onClick={() => { setSelectedDayIdx(dayIdx); setViewMode("day"); }}
                    className={`text-xs font-bold hover:text-blue-600 transition-colors ${isToday ? "text-blue-700" : "text-gray-600"}`}
                  >
                    {dayName}
                  </button>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-gray-400">
                      {taskCount}{doneCount > 0 && <span className="text-green-500"> +{doneCount}</span>}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setAddingAt({ dayIdx, afterIdx: day.tasks.length - 1 }); }}
                      className="text-gray-300 hover:text-blue-500 text-sm leading-none transition-colors"
                      title="Add task"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Tasks */}
                {!groupView ? (
                  <div className="space-y-0.5">
                    {filteredTasks.length > 0 ? (
                      filteredTasks.map((task, fi) => {
                        const originalIdx = day.tasks.indexOf(task);
                        const seq = seqNumbers.get(fi) ?? "";
                        return (
                          <div key={`wrap-${originalIdx}`}>
                            {renderCompactTaskItem(task, dayIdx, originalIdx, task.text, null, String(seq))}
                            {renderSubtasks(dayIdx, originalIdx, task, true)}
                            {renderAddInput(dayIdx, originalIdx)}
                          </div>
                        );
                      })
                    ) : (
                      <div
                        className="text-[10px] text-gray-300 text-center py-4 cursor-pointer hover:text-blue-400 transition-colors"
                        onDoubleClick={(e) => { e.stopPropagation(); setAddingAt({ dayIdx, afterIdx: -1 }); }}
                      >
                        Double-click to add task
                      </div>
                    )}
                    {filteredTasks.length === 0 && renderAddInput(dayIdx, -1)}
                  </div>
                ) : (
                  <div
                    className="space-y-0.5"
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDrop={() => handleDrop(dayIdx, day.tasks.length)}
                  >
                    {buildDayGroups(day.tasks).map((section) => {
                      const firstOrigIdx = section.items[0]?.originalIdx ?? 0;
                      const sectionKey = section.name ? `${section.name}-${firstOrigIdx}` : `ungrouped-${firstOrigIdx}`;
                      const isCollapsed = section.name ? collapsedGroups.has(section.name) : false;
                      const doneInSection = section.items.filter((e) => e.task.done).length;
                      const activeInSection = section.items.length - doneInSection;
                      return (
                        <div key={sectionKey}>
                          {section.name ? (
                            <div
                              draggable
                              onDragStart={(e) => { e.stopPropagation(); handleGroupDragStart(dayIdx, section.name); }}
                              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget({ day: dayIdx, idx: firstOrigIdx }); }}
                              onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, firstOrigIdx); }}
                              onDragEnd={handleDragEnd}
                              className={`text-[10px] font-bold text-gray-500 px-1 mb-0.5 cursor-grab active:cursor-grabbing flex items-center gap-0.5 group/hdr hover:bg-white/60 rounded ${
                                dropTarget?.day === dayIdx && dropTarget?.idx === firstOrigIdx
                                  ? "border-t-2 border-blue-400" : "border-t-2 border-transparent"
                              }`}
                            >
                              <span className="text-gray-300 group-hover/hdr:text-gray-400 text-[9px] select-none">&#x2630;</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleCollapsed(section.name); }}
                                className="text-gray-400 hover:text-gray-600 text-[9px] w-3 text-center"
                                title={isCollapsed ? "Expand" : "Collapse"}
                              >
                                {isCollapsed ? "▸" : "▾"}
                              </button>
                              {section.name}
                              <span className="text-gray-300 font-normal">
                                ({activeInSection}{doneInSection > 0 ? `+${doneInSection}✓` : ""})
                              </span>
                            </div>
                          ) : null}
                          {!isCollapsed && (
                            <div className={`space-y-0.5 ${section.name ? "ml-1.5 border-l border-gray-200 pl-1" : ""}`}>
                              {section.items.map((entry) => {
                                const seq = seqNumbers.get(filteredTasks.indexOf(entry.task)) ?? "";
                                return (
                                  <div key={`wrap-${entry.originalIdx}`}>
                                    {renderCompactTaskItem(entry.task, dayIdx, entry.originalIdx, entry.label, section.name || null, String(seq))}
                                    {renderSubtasks(dayIdx, entry.originalIdx, entry.task, true)}
                                    {renderAddInput(dayIdx, entry.originalIdx)}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {buildDayGroups(day.tasks).length === 0 && (
                      <div
                        className="text-[10px] text-gray-300 text-center py-4 cursor-pointer hover:text-blue-400 transition-colors"
                        onDoubleClick={(e) => { e.stopPropagation(); setAddingAt({ dayIdx, afterIdx: -1 }); }}
                      >
                        Double-click to add task
                      </div>
                    )}
                    {buildDayGroups(day.tasks).length === 0 && renderAddInput(dayIdx, -1)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-gray-300 text-center">
          Double-click a task to add after it &middot; Click &#x25CB; to complete/uncomplete &middot; Click day name for day view{groupView && " \u00b7 Drag group headers to reorder"}
        </p>
      </>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Week Plan</h2>
        <div className="flex items-center gap-2">
          {data && (
            <button
              onClick={() => {
                if (autoSavePaused) {
                  // Resume: save immediately then re-enable auto-save
                  saveWeek();
                  setAutoSavePaused(false);
                } else {
                  setAutoSavePaused(true);
                }
              }}
              disabled={saving}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                saved
                  ? "bg-green-100 text-green-700"
                  : autoSavePaused
                    ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                    : dirty
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-gray-100 text-gray-400"
              }`}
            >
              {saved ? "\u2713 Saved!" : saving ? "Saving..." : autoSavePaused ? "\u23F8 Paused — click to save" : dirty ? "Auto-saving..." : "Auto-save"}
            </button>
          )}
          <button
            onClick={fetchWeek}
            disabled={loading}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {loading ? "Loading..." : data ? "Refresh" : "Load Week"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-gray-700">{data.week_label}</span>
            <div className="flex gap-1 items-center flex-wrap justify-end">
              {/* Group toggle */}
              <button
                onClick={() => setGroupView(!groupView)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  groupView ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
                title={groupView ? "Switch to flat list" : "Group by prefix (e.g. Rotary:)"}
              >
                {groupView ? "Grouped" : "Group"}
              </button>

              {/* Group filter dropdown */}
              {allGroups.length > 0 && (
                <select
                  value={filterGroup || ""}
                  onChange={(e) => setFilterGroup(e.target.value || null)}
                  className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border-0 cursor-pointer hover:bg-gray-200 transition-colors"
                >
                  <option value="">All groups</option>
                  {allGroups.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              )}

              {/* Show/hide completed */}
              {completedCount > 0 && (
                <button
                  onClick={() => setShowCompleted(!showCompleted)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    showCompleted ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  }`}
                >
                  {showCompleted ? `Hide ${completedCount} done` : `Show ${completedCount} done`}
                </button>
              )}

              <span className="w-px h-4 bg-gray-200" />

              {/* View mode toggles — Day with day picker */}
              <button
                onClick={() => setViewMode("day")}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  viewMode === "day" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
              >
                Day
              </button>
              {(["3day", "5day", "7day", "weekend"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    viewMode === mode ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  }`}
                >
                  {mode === "3day" ? "3 Day" : mode === "5day" ? "Mon-Fri" : mode === "7day" ? "Full week" : "Weekend"}
                </button>
              ))}
            </div>
          </div>

          {/* Day navigation bar — shown in Day view */}
          {viewMode === "day" && (
            <div className="flex items-center gap-2 max-w-lg mx-auto">
              <button
                onClick={() => setSelectedDayIdx(Math.max(0, selectedDayIdx - 1))}
                disabled={selectedDayIdx === 0}
                className="px-2 py-1 text-gray-400 hover:text-gray-700 text-lg font-medium transition-colors disabled:opacity-20"
                title="Previous day"
              >
                ‹
              </button>
              <div className="flex gap-1 flex-1 justify-center">
                {data.days.map((d, i) => {
                  const isSelected = i === selectedDayIdx;
                  const isToday = i === todayIdx;
                  const shortName = DAY_SHORT[i];
                  return (
                    <button
                      key={d.day}
                      onClick={() => setSelectedDayIdx(i)}
                      className={`flex flex-col items-center px-2 py-1 rounded text-xs font-medium transition-colors min-w-[40px] ${
                        isSelected
                          ? "bg-blue-600 text-white"
                          : isToday
                            ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                            : "text-gray-500 hover:bg-gray-100"
                      }`}
                    >
                      <span>{shortName}</span>
                      <span className={`text-[10px] ${
                        isSelected ? "text-blue-100"
                          : d.tasks.filter(t => !t.done).length > 0 ? "text-gray-500" : "text-gray-300"
                      }`}>
                        {d.tasks.filter(t => !t.done).length}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setSelectedDayIdx(Math.min(6, selectedDayIdx + 1))}
                disabled={selectedDayIdx === 6}
                className="px-2 py-1 text-gray-400 hover:text-gray-700 text-lg font-medium transition-colors disabled:opacity-20"
                title="Next day"
              >
                ›
              </button>
            </div>
          )}

          {/* Render the appropriate view */}
          {viewMode === "day" ? renderDayView() : renderGridView()}
        </>
      )}

      {!data && !loading && (
        <div className="py-12 text-center text-gray-400">
          <p className="text-lg">No week plan loaded</p>
          <p className="text-sm mt-1">Click Load Week to read Plan Week.md</p>
        </div>
      )}
    </div>
  );
}
