import { useState, useRef, useEffect } from "react";
import { api, type PlanResponse, type Task } from "../api";
import TaskCheck from "./TaskCheck";

const PRIORITY_BADGE: Record<string, string> = {
  A: "bg-red-100 text-red-700",
  B: "bg-amber-100 text-amber-700",
  C: "bg-green-100 text-green-700",
  D: "bg-gray-100 text-gray-500",
};

const PRIORITIES = ["A", "B", "C", "D"] as const;

const PILLAR_ICONS: Record<string, { symbol: string; title: string }> = {
  social: { symbol: "\u{1F91D}", title: "Social connection" },
  recovery: { symbol: "\u{1F9D8}", title: "Recovery" },
  play: { symbol: "\u{1F3AE}", title: "Purposeful play / tinkering" },
  progress: { symbol: "\u{1F4CA}", title: "Structured progress" },
  longterm: { symbol: "\u{1F3AF}", title: "Long term goals" },
};

function categoryLabel(sourceFile: string): string {
  return sourceFile.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

function sortByPriority(tasks: Task[]): Task[] {
  const order: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  return [...tasks].sort(
    (a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4)
  );
}

/** Compute per-priority sequence numbers based on current order, e.g. A1, A2, B1, B2, B3, C1 */
function computeSeqNumbers(entries: MergedEntry[]): Map<number, number> {
  const counters: Record<string, number> = {};
  const result = new Map<number, number>();
  entries.forEach((entry, i) => {
    const p = entry.task.priority || "C";
    counters[p] = (counters[p] || 0) + 1;
    result.set(i, counters[p]);
  });
  return result;
}

/** Parse group prefix from task text. "Rotary: do X" => { group: "Rotary", label: "do X" } */
function parseGroup(text: string): { group: string; label: string } {
  const idx = text.indexOf(":");
  if (idx > 1 && idx < 30) {
    // Only treat as group if prefix is short (a project/context name, not a full sentence)
    const group = text.slice(0, idx).trim();
    const label = text.slice(idx + 1).trim();
    if (group && group.length > 1 && !/^[A-Da-d]\d*$/.test(group) && label) return { group, label };
  }
  return { group: "", label: text };
}

interface TaskGroup {
  name: string;
  tasks: { task: Task; mergedIdx: number; planIdx: number; completedIdx: number; label: string }[];
}

/** Build ordered groups from merged task list. Ungrouped tasks first, then named in order found. */
function buildGroups(
  entries: MergedEntry[],
  showCompleted: boolean
): TaskGroup[] {
  const groupMap = new Map<string, TaskGroup["tasks"]>();
  const groupOrder: string[] = [];

  entries.forEach((entry, mi) => {
    if (entry.task.priority === "D") return;
    if (entry.task.done && !showCompleted) return;
    const { group, label } = parseGroup(entry.task.text);
    if (!groupMap.has(group)) {
      groupMap.set(group, []);
      groupOrder.push(group);
    }
    groupMap.get(group)!.push({ task: entry.task, mergedIdx: mi, planIdx: entry.planIdx, completedIdx: entry.completedIdx, label });
  });

  // Ungrouped ("") first, then named groups in order found (preserves drag reorder)
  const ungrouped = groupOrder.filter((g) => g === "");
  const named = groupOrder.filter((g) => g !== "");
  return [...ungrouped, ...named].map((name) => ({
    name,
    tasks: groupMap.get(name) || [],
  }));
}

/** Reorder tasks: move all tasks of moveGroup before targetGroup */
function reorderPlanGroups(tasks: Task[], moveGroup: string, targetGroup: string): Task[] {
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
  groupOrder.splice(toIdx, 0, moveGroup);
  const result: Task[] = [];
  for (const g of groupOrder) result.push(...(grouped.get(g) || []));
  return result;
}

interface MergedEntry {
  task: Task;
  planIdx: number;       // index in plan.tasks, or -1
  completedIdx: number;  // index in plan.completed, or -1
}

/** Merge active and completed tasks into one list, sorted by priority, completed at end of each group */
function mergeTasks(active: Task[], completed: Task[]): MergedEntry[] {
  const order: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  const all: MergedEntry[] = [
    ...active.map((t, i) => ({ task: t, planIdx: i, completedIdx: -1 })),
    ...completed.map((t, i) => ({ task: { ...t, done: true }, planIdx: -1, completedIdx: i })),
  ];
  return all.sort((a, b) => {
    const pa = order[a.task.priority] ?? 4;
    const pb = order[b.task.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    // Within same priority, active before done
    if (a.task.done !== b.task.done) return a.task.done ? 1 : -1;
    return 0;
  });
}

/** Auto-focus input for inline task creation */
function AddTaskInput({
  onSubmit,
  onCancel,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
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
      placeholder="New task... (prefix: for group)"
      className="w-full text-sm px-2 py-1.5 border border-blue-300 rounded-lg bg-white outline-none focus:ring-1 focus:ring-blue-400"
    />
  );
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Get the Monday of the week containing the given date */
function getMonday(d: Date): Date {
  const result = new Date(d);
  const day = result.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

/** Format a Date to YYYY-MM-DD */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Get all 7 dates (Mon–Sun) for the week containing the given date */
function getWeekDates(d: Date): Date[] {
  const mon = getMonday(d);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(mon);
    day.setDate(mon.getDate() + i);
    return day;
  });
}

export default function DailyPlan({
  onApproved,
  onTasksChanged,
}: {
  onApproved: (sessionId: string) => void;
  onTasksChanged: (tasks: Task[]) => void;
}) {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [approved, setApproved] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showCarryover, setShowCarryover] = useState(false);
  const [groupView, setGroupView] = useState(false);
  const [priorityMenuIdx, setPriorityMenuIdx] = useState<number | null>(null);
  const dragIdx = useRef<number | null>(null);
  const dragSource = useRef<"tasks" | "carryover">("tasks");
  const dragGroup = useRef<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [addingAt, setAddingAt] = useState<number | null>(null);
  const dragGroupName = useRef<string | null>(null);
  const [dropGroupTarget, setDropGroupTarget] = useState<string | null>(null);

  const today = formatDate(new Date());
  const weekDates = getWeekDates(selectedDate);

  const navigateDay = (offset: number) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    setSelectedDate(d);
    // Auto-fetch for new day
    fetchPlanForDate(d);
  };

  const selectDay = (d: Date) => {
    setSelectedDate(d);
    fetchPlanForDate(d);
  };

  const deleteTask = (planIdx: number, completedIdx: number) => {
    if (!plan) return;
    if (planIdx >= 0) {
      const tasks = [...plan.tasks];
      tasks.splice(planIdx, 1);
      setPlan({ ...plan, tasks });
      onTasksChanged(tasks);
    } else if (completedIdx >= 0) {
      const completed = [...plan.completed];
      completed.splice(completedIdx, 1);
      setPlan({ ...plan, completed });
    }
  };

  const toggleDone = (planIdx: number, completedIdx: number) => {
    if (!plan) return;
    if (planIdx >= 0) {
      // Task is in plan.tasks — flip done flag
      const tasks = [...plan.tasks];
      tasks[planIdx] = { ...tasks[planIdx], done: !tasks[planIdx].done };
      setPlan({ ...plan, tasks });
      onTasksChanged(tasks);
    } else if (completedIdx >= 0) {
      // Task is in plan.completed — move it to plan.tasks as undone
      const completed = [...plan.completed];
      const [moved] = completed.splice(completedIdx, 1);
      const tasks = [...plan.tasks, { ...moved, done: false }];
      setPlan({ ...plan, tasks, completed });
      onTasksChanged(tasks);
    }
  };

  const handleGroupDragStart = (groupName: string) => {
    dragGroupName.current = groupName;
    dragIdx.current = null;
  };

  const handleGroupDragOver = (e: React.DragEvent, targetGroup: string) => {
    if (!dragGroupName.current) return;
    e.preventDefault();
    setDropGroupTarget(targetGroup);
  };

  const handleGroupDrop = (targetGroup: string) => {
    if (!plan || !dragGroupName.current) return;
    if (dragGroupName.current === targetGroup) return;
    const tasks = reorderPlanGroups(plan.tasks, dragGroupName.current, targetGroup);
    setPlan({ ...plan, tasks });
    onTasksChanged(tasks);
    dragGroupName.current = null;
    setDropGroupTarget(null);
  };

  const handleGroupDragEnd = () => {
    dragGroupName.current = null;
    setDropGroupTarget(null);
  };

  const addTask = (afterIdx: number, text: string) => {
    if (!plan) return;
    const newTask: Task = {
      text,
      done: false,
      source_file: "Plan Week.md",
      context: "",
      tags: [],
      priority: "B",
      pillars: [],
      subtasks: [],
      focused: false,
      waiting: false,
    };
    const tasks = [...plan.tasks];
    tasks.splice(afterIdx + 1, 0, newTask);
    setPlan({ ...plan, tasks });
    onTasksChanged(tasks);
    setAddingAt(afterIdx + 1); // keep input open for rapid entry
  };

  const fetchPlanForDate = async (d: Date) => {
    setLoading(true);
    setError("");
    setApproved(false);
    try {
      const data = await api.getPlan(formatDate(d));
      setPlan(data);
      onTasksChanged(data.tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch plan");
    } finally {
      setLoading(false);
    }
  };

  const fetchPlan = () => fetchPlanForDate(selectedDate);

  const approvePlan = async () => {
    if (!plan) return;
    setApproving(true);
    try {
      await api.approvePlan(plan.session_id, plan.tasks);
      setApproved(true);
      onApproved(plan.session_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve plan");
    } finally {
      setApproving(false);
    }
  };

  const setPriority = (idx: number, priority: string) => {
    if (!plan) return;
    const tasks = [...plan.tasks];
    tasks[idx] = { ...tasks[idx], priority };
    const sorted = sortByPriority(tasks);
    setPlan({ ...plan, tasks: sorted });
    onTasksChanged(sorted);
    setPriorityMenuIdx(null);
  };

  const handleDragStart = (idx: number, source: "tasks" | "carryover" = "tasks", group: string | null = null) => {
    dragIdx.current = idx;
    dragSource.current = source;
    dragGroup.current = group;
  };

  const handleDragOver = (e: React.DragEvent, idx: number, group: string | null = null) => {
    // In group view, only allow drops within the same group
    if (groupView && dragGroup.current !== null && group !== dragGroup.current) return;
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDrop = (dropIdx: number) => {
    if (!plan || dragIdx.current === null) return;

    if (dragSource.current === "carryover") {
      // Move from carryover into main task list
      const carryover = [...plan.carryover];
      const [moved] = carryover.splice(dragIdx.current, 1);
      moved.priority = "B";
      const tasks = [...plan.tasks];
      tasks.splice(dropIdx, 0, moved);
      setPlan({ ...plan, tasks, carryover });
      onTasksChanged(tasks);
    } else {
      // Reorder within main task list
      if (dragIdx.current === dropIdx) return;
      const tasks = [...plan.tasks];
      const [moved] = tasks.splice(dragIdx.current, 1);
      tasks.splice(dropIdx, 0, moved);
      setPlan({ ...plan, tasks });
      onTasksChanged(tasks);
    }
    dragIdx.current = null;
    dragSource.current = "tasks";
    dragGroup.current = null;
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    dragIdx.current = null;
    dragSource.current = "tasks";
    dragGroup.current = null;
    setDragOverIdx(null);
  };

  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  /** Build the formatted text for clipboard or vault save */
  const buildPlanText = () => {
    if (!plan) return "";
    const merged = mergeTasks(plan.tasks, plan.completed);
    const seq = computeSeqNumbers(merged);

    if (groupView) {
      const groups = buildGroups(merged, true);
      const parts: string[] = [];
      for (const g of groups) {
        if (g.name) parts.push(`* ${g.name}`);
        for (const entry of g.tasks) {
          const check = entry.task.done ? "x" : " ";
          const prefix = g.name ? "\t" : "";
          parts.push(`${prefix}- [${check}] [${entry.task.priority || "C"}${seq.get(entry.mergedIdx) ?? ""}] ${entry.label}`);
        }
      }
      return parts.join("\n");
    } else {
      return merged.map((e, i) => {
        const check = e.task.done ? "x" : " ";
        return `- [${check}] [${e.task.priority || "C"}${seq.get(i) ?? ""}] ${e.task.text}`;
      }).join("\n");
    }
  };

  const copyPlan = async () => {
    const text = buildPlanText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const savePlanToVault = async () => {
    const text = buildPlanText();
    if (!text) return;
    setSaving(true);
    try {
      await api.saveToVault(text, groupView);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save to vault");
    } finally {
      setSaving(false);
    }
  };

  const bucketTasks = plan?.tasks.filter((t) => t.priority === "D") ?? [];
  const mergedEntries = plan ? mergeTasks(plan.tasks, plan.completed) : [];
  const seqNumbers = computeSeqNumbers(mergedEntries);
  const taskGroups = plan ? buildGroups(mergedEntries, showCompleted) : [];
  const [showBucket, setShowBucket] = useState(false);
  const completedCount = plan?.completed?.length ?? 0;
  const carryoverCount = plan?.carryover?.length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Daily Plan</h2>
        <button
          onClick={fetchPlan}
          disabled={loading}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Day navigation bar — always visible */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigateDay(-1)}
          className="px-2 py-1 text-gray-400 hover:text-gray-700 text-lg font-medium transition-colors"
          title="Previous day"
        >
          ‹
        </button>
        <div className="flex gap-1 flex-1 justify-center">
          {weekDates.map((d, i) => {
            const ds = formatDate(d);
            const isSelected = formatDate(selectedDate) === ds;
            const isToday = ds === today;
            return (
              <button
                key={ds}
                onClick={() => selectDay(d)}
                className={`flex flex-col items-center px-2 py-1 rounded text-xs font-medium transition-colors min-w-[40px] ${
                  isSelected
                    ? "bg-blue-600 text-white"
                    : isToday
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "text-gray-500 hover:bg-gray-100"
                }`}
                title={d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
              >
                <span>{DAY_LABELS[i]}</span>
                <span className={`text-[10px] ${isSelected ? "text-blue-100" : "text-gray-400"}`}>
                  {d.getDate()}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => navigateDay(1)}
          className="px-2 py-1 text-gray-400 hover:text-gray-700 text-lg font-medium transition-colors"
          title="Next day"
        >
          ›
        </button>
      </div>

      {plan && (
        <>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <span>{plan.date}</span>
            <span className="px-2 py-0.5 bg-gray-100 rounded text-xs font-medium">
              {plan.day_type}
            </span>
            <span className="flex-1">{plan.summary}</span>
            <button
              onClick={() => setGroupView(!groupView)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                groupView
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
              title={groupView ? "Switch to flat list" : "Group by prefix (e.g. Rotary:)"}
            >
              {groupView ? "Grouped" : "Group"}
            </button>
          </div>

          {!groupView && (<div className="space-y-0.5">
            {mergedEntries.map((entry, mi) => {
              const { task, planIdx, completedIdx } = entry;
              if (task.priority === "D") return null;
              if (task.done && !showCompleted) return null;
              return (
                <div key={`wrap-${mi}`}>
                  <div
                    draggable={!task.done}
                    onDragStart={!task.done ? () => handleDragStart(planIdx) : undefined}
                    onDragOver={!task.done ? (e) => handleDragOver(e, planIdx) : undefined}
                    onDrop={!task.done ? () => handleDrop(planIdx) : undefined}
                    onDragEnd={!task.done ? handleDragEnd : undefined}
                    onDoubleClick={!task.done ? () => setAddingAt(planIdx) : undefined}
                    className={`group/task flex items-center gap-2 py-1 px-2 rounded text-sm select-none ${
                      task.done
                        ? "opacity-50"
                        : `cursor-grab active:cursor-grabbing ${
                            dragOverIdx === planIdx
                              ? "border-t-2 border-blue-400"
                              : "border-t-2 border-transparent"
                          } hover:bg-gray-50`
                    }`}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleDone(planIdx, completedIdx); }}
                      className={`shrink-0 inline-flex items-center justify-center hover:opacity-70 ${task.done ? "text-green-400" : "text-gray-400 hover:text-green-500"}`}
                      title={task.done ? "Mark undone" : "Mark done"}
                    >
                      <TaskCheck done={task.done} size={15} />
                    </button>
                    <div className="relative shrink-0">
                      {task.done ? (
                        <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}>
                          {task.priority || "C"}{seqNumbers.get(mi) ?? ""}
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => setPriorityMenuIdx(priorityMenuIdx === planIdx ? null : planIdx)}
                            className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}
                            title="Click to change priority"
                          >
                            {task.priority || "C"}{seqNumbers.get(mi) ?? ""}
                          </button>
                          {priorityMenuIdx === planIdx && (
                            <div className="absolute left-0 top-full mt-1 flex gap-0.5 z-10 bg-white rounded shadow-md p-1">
                              {PRIORITIES.filter((p) => p !== task.priority).map((p) => (
                                <button
                                  key={p}
                                  onClick={() => setPriority(planIdx, p)}
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
                    <span className="text-gray-400 text-xs w-24 shrink-0 truncate">
                      {categoryLabel(task.source_file)}
                    </span>
                    <span className={task.done ? "text-gray-400 line-through" : "text-gray-900"}>
                      {task.text}
                    </span>
                    {task.pillars?.length > 0 && (
                      <span className="shrink-0" title={task.pillars.map((p) => PILLAR_ICONS[p]?.title || p).join(", ")}>
                        {task.pillars.map((p) => PILLAR_ICONS[p]?.symbol || p).join("")}
                      </span>
                    )}
                    {task.tags.length > 0 && (
                      <span className="text-xs text-gray-400 shrink-0">
                        {task.tags.map((t) => `#${t}`).join(" ")}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteTask(planIdx, completedIdx); }}
                      className="shrink-0 text-gray-400 hover:text-red-500 opacity-0 group-hover/task:opacity-100 transition-opacity"
                      title="Delete task"
                    >
                      &times;
                    </button>
                  </div>
                  {addingAt === planIdx && (
                    <div className="py-0.5 px-2">
                      <AddTaskInput
                        onSubmit={(text) => addTask(planIdx, text)}
                        onCancel={() => setAddingAt(null)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
            <button
              onClick={() => setAddingAt(plan.tasks.length - 1)}
              className="w-full text-xs text-gray-300 hover:text-blue-400 py-1 transition-colors text-left px-2"
            >
              + Add task
            </button>
            {addingAt === plan.tasks.length - 1 && !mergedEntries.some((e) => {
              return e.planIdx === plan.tasks.length - 1;
            }) && (
              <div className="py-0.5 px-2">
                <AddTaskInput
                  onSubmit={(text) => addTask(plan.tasks.length - 1, text)}
                  onCancel={() => setAddingAt(null)}
                />
              </div>
            )}
          </div>)}

          {groupView && (
            <div className="space-y-3">
              {taskGroups.map((group) => (
                <div
                  key={group.name || "__ungrouped"}
                  draggable={!!group.name}
                  onDragStart={group.name ? (e) => { e.stopPropagation(); handleGroupDragStart(group.name); } : undefined}
                  onDragOver={group.name ? (e) => handleGroupDragOver(e, group.name) : undefined}
                  onDrop={group.name ? (e) => { e.stopPropagation(); handleGroupDrop(group.name); } : undefined}
                  onDragEnd={handleGroupDragEnd}
                  className={group.name && dropGroupTarget === group.name
                    ? "border-t-2 border-blue-400 rounded"
                    : group.name ? "border-t-2 border-transparent" : ""}
                >
                  {group.name && (
                    <div className="flex items-center gap-2 py-1.5 px-2 cursor-grab active:cursor-grabbing">
                      <span className="text-gray-300 text-xs">&#x2630;</span>
                      <span className="text-sm font-semibold text-gray-700">{group.name}</span>
                      <span className="text-xs text-gray-400">({group.tasks.length})</span>
                    </div>
                  )}
                  <div className={`space-y-0.5 ${group.name ? "ml-4 border-l-2 border-gray-100 pl-2" : ""}`}>
                    {group.tasks.map((entry) => {
                      const { task, mergedIdx: mi, planIdx, completedIdx, label } = entry;
                      return (
                        <div key={`gwrap-${mi}`}>
                          <div
                            draggable={!task.done}
                            onDragStart={!task.done ? (e) => { e.stopPropagation(); handleDragStart(planIdx, "tasks", group.name); } : undefined}
                            onDragOver={!task.done ? (e) => handleDragOver(e, planIdx, group.name) : undefined}
                            onDrop={!task.done ? (e) => { e.stopPropagation(); handleDrop(planIdx); } : undefined}
                            onDragEnd={!task.done ? handleDragEnd : undefined}
                            onDoubleClick={!task.done ? () => setAddingAt(planIdx) : undefined}
                            className={`group/task flex items-center gap-2 py-1 px-2 rounded text-sm select-none ${
                              task.done
                                ? "opacity-50"
                                : `cursor-grab active:cursor-grabbing ${
                                    dragOverIdx === planIdx
                                      ? "border-t-2 border-blue-400"
                                      : "border-t-2 border-transparent"
                                  } hover:bg-gray-50`
                            }`}
                          >
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleDone(planIdx, completedIdx); }}
                              className={`shrink-0 inline-flex items-center justify-center hover:opacity-70 ${task.done ? "text-green-400" : "text-gray-400 hover:text-green-500"}`}
                              title={task.done ? "Mark undone" : "Mark done"}
                            >
                              <TaskCheck done={task.done} size={15} />
                            </button>
                            <div className="relative shrink-0">
                              {task.done ? (
                                <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}>
                                  {task.priority || "C"}{seqNumbers.get(mi) ?? ""}
                                </span>
                              ) : (
                                <>
                                  <button
                                    onClick={() => setPriorityMenuIdx(priorityMenuIdx === planIdx ? null : planIdx)}
                                    className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.C}`}
                                    title="Click to change priority"
                                  >
                                    {task.priority || "C"}{seqNumbers.get(mi) ?? ""}
                                  </button>
                                  {priorityMenuIdx === planIdx && (
                                    <div className="absolute left-0 top-full mt-1 flex gap-0.5 z-10 bg-white rounded shadow-md p-1">
                                      {PRIORITIES.filter((p) => p !== task.priority).map((p) => (
                                        <button
                                          key={p}
                                          onClick={() => setPriority(planIdx, p)}
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
                            <span className={task.done ? "text-gray-400 line-through" : "text-gray-900"}>
                              {label}
                            </span>
                            {task.pillars?.length > 0 && (
                              <span className="shrink-0" title={task.pillars.map((p) => PILLAR_ICONS[p]?.title || p).join(", ")}>
                                {task.pillars.map((p) => PILLAR_ICONS[p]?.symbol || p).join("")}
                              </span>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteTask(planIdx, completedIdx); }}
                              className="shrink-0 text-gray-400 hover:text-red-500 opacity-0 group-hover/task:opacity-100 transition-opacity"
                              title="Delete task"
                            >
                              &times;
                            </button>
                          </div>
                          {addingAt === planIdx && (
                            <div className="py-0.5 px-2">
                              <AddTaskInput
                                onSubmit={(text) => {
                                  // If in a named group, auto-prefix with group name
                                  const fullText = group.name && !text.includes(":") ? `${group.name}: ${text}` : text;
                                  addTask(planIdx, fullText);
                                }}
                                onCancel={() => setAddingAt(null)}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {completedCount > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowCompleted(!showCompleted)}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                {showCompleted ? "Hide" : "Show"} {completedCount} completed
              </button>
            </div>
          )}

          {carryoverCount > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowCarryover(!showCarryover)}
                className="text-xs text-amber-500 hover:text-amber-700 transition-colors"
              >
                {showCarryover ? "Hide" : "Show"} {carryoverCount} uncompleted from previous days
              </button>

              {showCarryover && (
                <div className="mt-1 space-y-0.5">
                  {plan.carryover.map((task, i) => (
                    <div
                      key={i}
                      draggable
                      onDragStart={() => handleDragStart(i, "carryover")}
                      onDragEnd={handleDragEnd}
                      className="flex items-center gap-2 py-1 px-2 rounded text-sm cursor-grab active:cursor-grabbing select-none hover:bg-amber-50"
                    >
                      <span className="text-amber-300 cursor-grab shrink-0">
                        &#x2630;
                      </span>
                      <span className="text-gray-400 text-xs w-24 shrink-0 truncate">
                        {categoryLabel(task.source_file)}
                      </span>
                      <span className="text-gray-500">
                        {task.text}
                      </span>
                    </div>
                  ))}
                  <p className="text-xs text-gray-400 mt-1 px-2">
                    Drag tasks up to add them to today's plan
                  </p>
                </div>
              )}
            </div>
          )}

          {bucketTasks.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowBucket(!showBucket)}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                {showBucket ? "Hide" : "Show"} {bucketTasks.length} bucket list (another day)
              </button>

              {showBucket && (
                <div className="mt-1 space-y-0.5">
                  {plan.tasks.map((task, i) => {
                    if (task.priority !== "D") return null;
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2 py-1 px-2 rounded text-sm"
                      >
                        <div className="relative shrink-0">
                          <button
                            onClick={() => setPriorityMenuIdx(priorityMenuIdx === i ? null : i)}
                            className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE.D}`}
                            title="Click to change priority"
                          >
                            D
                          </button>
                          {priorityMenuIdx === i && (
                            <div className="absolute left-0 top-full mt-1 flex gap-0.5 z-10 bg-white rounded shadow-md p-1">
                              {PRIORITIES.filter((p) => p !== "D").map((p) => (
                                <button
                                  key={p}
                                  onClick={() => setPriority(i, p)}
                                  className={`px-1.5 py-0.5 rounded text-xs font-bold cursor-pointer hover:opacity-70 transition-opacity ${PRIORITY_BADGE[p]}`}
                                >
                                  {p}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="text-gray-400 text-xs w-24 shrink-0 truncate">
                          {categoryLabel(task.source_file)}
                        </span>
                        <span className="text-gray-400">{task.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {!approved && (
            <div className="flex gap-3 pt-2">
              <button
                onClick={approvePlan}
                disabled={approving}
                className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                {approving ? "Approving..." : "Approve Plan"}
              </button>
              <button
                onClick={fetchPlan}
                className="px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Regenerate
              </button>
            </div>
          )}

          {approved && (
            <div className="p-3 bg-green-50 text-green-700 rounded-lg text-sm font-medium">
              Plan approved — head to Coaching for your daily question.
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={copyPlan}
              className={`flex-1 py-2 text-xs transition-colors ${
                copied
                  ? "text-green-600 font-medium"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {copied ? "\u2713 Copied to clipboard!" : "Copy to clipboard"}
            </button>
            <button
              onClick={savePlanToVault}
              disabled={saving}
              className={`flex-1 py-2 text-xs transition-colors ${
                saved
                  ? "text-green-600 font-medium"
                  : saving
                    ? "text-gray-300"
                    : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {saved ? "\u2713 Saved to Obsidian!" : saving ? "Saving..." : "Save to Obsidian"}
            </button>
          </div>
        </>
      )}

      {!plan && !loading && (
        <div className="py-12 text-center text-gray-400">
          <p className="text-lg">No plan yet</p>
          <p className="text-sm mt-1">
            Select a day above and click Refresh to load tasks
          </p>
        </div>
      )}
    </div>
  );
}
