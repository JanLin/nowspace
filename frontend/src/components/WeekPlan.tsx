import React, { useState, useRef, useMemo, useEffect } from "react";
import { api, type WeekPlanResponse, type DayTasks, type Task, type TaskLink, type Habit, type TimeEntry } from "../api";
import TaskLinkPopup from "./TaskLinkPopup";
import NotesPanel from "./NotesPanel";
import DiaryPanel from "./DiaryPanel";
import NoteEditor from "./NoteEditor";
import NoteFilePicker from "./NoteFilePicker";
import TaskCheck from "./TaskCheck";
import { Cluster } from "../clusters";
import VaultBrowser, { type VaultBrowserState } from "./VaultBrowser";
import HabitStrip, { type HabitTime } from "./HabitStrip";
import { shiftTime } from "../timefmt";
import { markDone as markAPDone } from "../actionPoints";
import {
  type CtxName, type CtxMap, type CtxTags, type CtxSelection, CTX_TOKEN_RE, DEFAULT_CTX_TAGS,
  ctxTokenOf, ctxEdgeColor, ctxChipClass, allContextNames,
  stripCtxTokens, stripGroupCtxTag, stripBucketMeta, isPinnedText, resolveContext, ctxFeatureEnabled,
  taskVisibleInCtxSelection, loadCtxSelection, saveCtxSelection,
} from "../contexts";

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

/** Parse group prefix from task text. "Rotary: do X" => { group: "Rotary", label: "do X" }.
    Inline group teaching tags are transparent: "wallet@w: do X" groups as "wallet". */
function parseGroup(rawText: string): { group: string; label: string } {
  const text = stripGroupCtxTag(rawText);
  const idx = text.indexOf(":");
  if (idx > 1 && idx < 30) {
    const group = text.slice(0, idx).trim();
    const label = text.slice(idx + 1).trim();
    if (group && group.length > 1 && label && !/^[A-Da-d]\d*$/.test(group) && !group.includes("[") && !group.endsWith("http") && !group.endsWith("https")) return { group, label };
  }
  return { group: "", label: text };
}

/** Get display text for a task, stripping [[wiki links]] if clean_text is available */
function getDisplayText(task: Task): string {
  // clean_text has [[...]] stripped; fall back to parsing the label from group prefix
  const base = task.clean_text || task.text;
  return stripCtxTokens(parseGroup(base).label);
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
/** ISO date of the viewed day: Monday of the current real week + offset weeks + day index */
function viewedDateISO(weekOffset: number, dayIdx: number): string {
  const now = new Date();
  const d = new Date(now);
  d.setDate(now.getDate() - ((now.getDay() + 6) % 7) + weekOffset * 7 + dayIdx);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
  // Uncontrolled on purpose: Samsung/GBoard keyboards type through an IME
  // composition, and React writing `value` back each keystroke desyncs it —
  // insertions survive but backspace gets swallowed. The DOM owns the text;
  // we only read it on submit. The autocomplete/correct attrs keep the
  // keyboard out of composition mode where possible.
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = (ref.current?.value || "").trim();
    if (trimmed) {
      onSubmit(trimmed);
      if (ref.current) ref.current.value = "";
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      defaultValue=""
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
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
  // Uncontrolled — see AutoFocusInput for the Samsung IME rationale
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const save = () => {
    const trimmed = (ref.current?.value || "").trim();
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
      defaultValue={initialValue}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
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
  const [weekOffset, setWeekOffset] = useState(0);
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
  // Any click outside the badge/menu dismisses the picker (same pattern as
  // the Bucket tab) — wrappers carry .plan-pop so in-menu clicks survive
  useEffect(() => {
    if (!priorityMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".plan-pop")) setPriorityMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [priorityMenu]);
  const [groupView, setGroupView] = useState(true);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Contexts: group→context mapping from config; empty = feature off
  const [ctxMap, setCtxMap] = useState<CtxMap>({});
  // Tag letters → context names (@w → work, plus user-defined like @f → fun)
  const [ctxTags, setCtxTags] = useState<CtxTags>(DEFAULT_CTX_TAGS);
  // Selection is a set of contexts (multi-select); empty = show everything
  const [ctxSel, setCtxSelState] = useState<CtxSelection>(loadCtxSelection);
  const ctxEnabled = ctxFeatureEnabled(ctxMap);
  const setCtxSel = (sel: CtxSelection) => {
    setCtxSelState(sel);
    saveCtxSelection(sel);
  };
  // Functional update so rapid successive toggles never work from stale state
  const toggleCtx = (name: CtxName) => {
    setCtxSelState((prev) => {
      const next = prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name];
      saveCtxSelection(next);
      return next;
    });
  };

  // A task is visible when its context is selected (empty selection = all);
  // pinned personal/volunteer tasks also surface while Work is selected
  const taskVisibleInMode = (text: string): boolean => taskVisibleInCtxSelection(text, ctxSel, ctxMap, ctxTags);

  // Habits: gentle chips above the day/grid (current week only)
  const [habits, setHabits] = useState<Habit[]>([]);
  const refreshHabits = () => {
    api.getHabits().then((r) => setHabits(r.found ? r.habits : [])).catch(() => {});
  };

  // Time tracking: one running entry, surfaced as a status-bar chip
  const [runningTime, setRunningTime] = useState<TimeEntry | null>(null);
  const [timeAdjustOpen, setTimeAdjustOpen] = useState(false);
  const [timeAdjustVal, setTimeAdjustVal] = useState("");
  const [timeAdjustText, setTimeAdjustText] = useState("");
  const [, setTimeTick] = useState(0);
  const refreshTime = () => {
    api.getTimeLog().then((r) => setRunningTime(r.running)).catch(() => {});
  };
  const trackedTextOf = (task: Task): string => stripBucketMeta(stripCtxTokens(task.text));
  const startTracking = async (task: Task) => {
    try {
      const r = await api.startTime(trackedTextOf(task));
      setRunningTime(r.running);
      window.dispatchEvent(new CustomEvent("time-changed"));
    } catch { /* backend down — chip stays as-is */ }
  };
  const stopTracking = async () => {
    try {
      await api.stopTime();
      setRunningTime(null);
      setTimeAdjustOpen(false);
      window.dispatchEvent(new CustomEvent("time-changed"));
    } catch { /* ignore */ }
  };
  const adjustTracking = async (patch: { start?: string; text?: string }) => {
    try {
      const r = await api.adjustTime(patch);
      setRunningTime(r.running);
      setTimeAdjustOpen(false);
      window.dispatchEvent(new CustomEvent("time-changed"));
    } catch { /* invalid time — leave popover open */ }
  };

  // Inline add state
  const [addingAt, setAddingAt] = useState<{ dayIdx: number; afterIdx: number; group?: string | null } | null>(null);

  // Drag state — supports both task and group dragging
  const dragRef = useRef<{ fromDay: number; fromIdx: number; group: string | null } | null>(null);
  const dragGroupRef = useRef<{ fromDay: number; groupName: string } | null>(null);
  // zone disambiguates indicators that share the same raw index: "task" lights a
  // row's top border, "gap" lights a standalone between-groups bar, "end" the
  // end-of-list bar. Exactly one indicator may render for a given dropTarget.
  const [dropTarget, setDropTarget] = useState<{ day: number; idx: number; zone?: "task" | "gap" | "end" } | null>(null);
  const [dropGroupTarget, setDropGroupTarget] = useState<{ day: number; groupName: string } | null>(null);
  const [editingTask, setEditingTask] = useState<{ dayIdx: number; taskIdx: number } | null>(null);
  const [groupPicker, setGroupPicker] = useState<{ dayIdx: number; taskIdx: number } | null>(null);
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<string>>(new Set());
  const [editingSubtask, setEditingSubtask] = useState<{ dayIdx: number; taskIdx: number; subIdx: number } | null>(null);
  const [addingSubtask, setAddingSubtask] = useState<{ dayIdx: number; taskIdx: number } | null>(null);
  const [addSubAfter, setAddSubAfter] = useState<number | null>(null); // insert after this sub-task index
  const [subDropTarget, setSubDropTarget] = useState<{ dayIdx: number; taskIdx: number; subIdx: number } | null>(null);

  // Desktop notifications
  const notifPermission = useRef<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().then((p) => { notifPermission.current = p; });
    }
  }, []);
  const sendNotification = (title: string, body: string, tag?: string) => {
    if (notifPermission.current !== "granted") return;
    try {
      const n = new Notification(title, { body, icon: "🍅", tag: tag ?? title, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* Safari/iOS fallback — ignore */ }
  };

  // Pomodoro state
  const [pomodoroPrompt, setPomodoroPrompt] = useState<{ dayIdx: number; taskIdx: number; taskText: string } | null>(null);
  const [pomodoro, setPomodoro] = useState<{
    taskIdx: number;
    dayIdx: number;
    taskText: string;
    duration: number;
    remaining: number;
    graceUsed: boolean;
    graceRemaining: number;
    state: "running" | "grace" | "break" | "breakRunning" | "done";
    startedAt: number;
  } | null>(null);
  const [pomodoroPos, setPomodoroPos] = useState<{ x: number; y: number } | null>(null);
  // Ultra focus: while the pomodoro runs, cover every other task with a
  // redaction curtain; lifts when the pomodoro stops or on any navigation
  const [ultraFocus, setUltraFocus] = useState(false);
  const pomodoroDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Bucket state
  const [bucketCount, setBucketCount] = useState(0);
  const [bucketHighlight, setBucketHighlight] = useState(false);
  const [bucketOpen, setBucketOpen] = useState(false);
  const [bucketTasks, setBucketTasks] = useState<import("../api").BucketTask[]>([]);
  const [bucketExpandedGroups, setBucketExpandedGroups] = useState<Set<string>>(new Set());
  const bucketQuickAddRef = useRef<HTMLInputElement>(null);
  const [bucketAddingGroup, setBucketAddingGroup] = useState<string | null>(null);
  const bucketDragRef = useRef<{ bucketIdx: number } | null>(null);

  // Carry forward
  const [carryForwardOpen, setCarryForwardOpen] = useState(false);
  const [carryTasks, setCarryTasks] = useState<{ text: string; from_day: string; subtasks: { text: string; done: boolean }[]; focused: boolean; waiting: boolean; priority: string; selected: boolean; targetDay: string }[]>([]);
  const [carryLabel, setCarryLabel] = useState("");
  const [carryLoading, setCarryLoading] = useState(false);
  const [carryExpandedGroups, setCarryExpandedGroups] = useState<Set<string>>(new Set());
  const [dailyCarryOpen, setDailyCarryOpen] = useState(false);
  const dailyCarryRef = useRef<HTMLDivElement>(null);
  const carryDragRef = useRef<{ carryIdx: number } | null>(null);
  const carryGroupDragRef = useRef<{ groupName: string } | null>(null);
  // Day-nav buttons double as drop targets (carry/bucket → that day)
  const [dayNavDropTarget, setDayNavDropTarget] = useState<number | null>(null);
  // Mobile bottom sheets: collapsed "peek" mode keeps the panel reachable
  // while the page content above stays visible and scrollable.
  const [sheetPeek, setSheetPeek] = useState(false);
  const sheetClass = (width: string) =>
    `fixed inset-x-0 bottom-0 z-40 rounded-t-xl border-t shadow-2xl ${
      sheetPeek ? "max-h-12 overflow-hidden" : "max-h-[45vh] overflow-y-auto"
    } md:sticky md:inset-x-auto md:bottom-auto md:z-auto md:top-[80px] md:max-h-[calc(100vh-260px)] md:overflow-y-auto md:shrink-0 md:border-l md:border-t-0 md:rounded-none md:shadow-none md:self-start ${width}`;
  const SheetGrip = () => (
    <button
      onClick={() => setSheetPeek((v) => !v)}
      className="md:hidden sticky top-0 z-10 w-full flex items-center justify-center py-1.5"
      style={{ backgroundColor: "var(--bg-secondary)" }}
      aria-label={sheetPeek ? "Expand panel" : "Collapse panel"}
      title={sheetPeek ? "Expand panel" : "Collapse panel"}
    >
      <span className="w-10 h-1 rounded-full" style={{ backgroundColor: "var(--border-strong)" }} />
    </button>
  );
  // "Carry all" destination — follows the viewed day, still user-overridable
  const [carryDaySel, setCarryDaySel] = useState("monday");
  const [carryHighlight, setCarryHighlight] = useState(false);

  // Vault browser
  const [vaultBrowserOpen, setVaultBrowserOpen] = useState(false);
  useEffect(() => {
    if (bucketOpen || carryForwardOpen || dailyCarryOpen || vaultBrowserOpen) setSheetPeek(false);
  }, [bucketOpen, carryForwardOpen, dailyCarryOpen, vaultBrowserOpen]);
  const vaultBrowserStateRef = useRef<VaultBrowserState | null>(null);

  // Bottom bar visibility
  const [showBottomBar, setShowBottomBar] = useState(true);
  const [pinFilters, setPinFilters] = useState(true);

  // Goals banner
  const [goalsExpanded, setGoalsExpanded] = useState(false);
  const [goalsEditing, setGoalsEditing] = useState(false);
  const [goalsDraft, setGoalsDraft] = useState("");
  const [goalsSaving, setGoalsSaving] = useState(false);
  const [goalsSaved, setGoalsSaved] = useState(false);

  // Undo / Redo
  type UndoEntry = {
    type: "tasks" | "goals" | "both";
    days: DayTasks[];
    goals: string[];
  };
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const MAX_UNDO = 40;
  const [undoCount, setUndoCount] = useState(0); // triggers re-render for indicator

  const pushUndo = (type: UndoEntry["type"] = "tasks") => {
    if (!data) return;
    undoStack.current.push({
      type,
      days: JSON.parse(JSON.stringify(data.days)),
      goals: [...(data.goals || [])],
    });
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = []; // clear redo on new action
    setUndoCount(undoStack.current.length);
  };

  const performUndo = async () => {
    if (!data || undoStack.current.length === 0) return;
    const entry = undoStack.current.pop()!;
    // Save current state to redo
    redoStack.current.push({
      type: entry.type,
      days: JSON.parse(JSON.stringify(data.days)),
      goals: [...(data.goals || [])],
    });
    // Restore
    const restoredData = { ...data, days: entry.days, goals: entry.goals };
    setData(restoredData);
    setUndoCount(undoStack.current.length);

    // Persist to disk based on what changed
    if (entry.type === "tasks" || entry.type === "both") {
      setDirty(true);
      // Immediate save for undo (don't wait for debounce)
      try {
        const res = await api.saveWeekPlan(entry.days, dataOffsetRef.current, lastKnownMtime.current);
        if (res.mtime) lastKnownMtime.current = res.mtime;
      } catch (e) {
        if (e instanceof Error && e.message.includes("changed on disk")) setExternalChange(true);
        /* otherwise auto-save will retry */
      }
    }
    if (entry.type === "goals" || entry.type === "both") {
      try {
        await api.saveGoals(entry.goals, weekOffset);
      } catch { /* silent */ }
    }
  };

  const performRedo = async () => {
    if (!data || redoStack.current.length === 0) return;
    const entry = redoStack.current.pop()!;
    // Save current state to undo
    undoStack.current.push({
      type: entry.type,
      days: JSON.parse(JSON.stringify(data.days)),
      goals: [...(data.goals || [])],
    });
    // Restore
    const restoredData = { ...data, days: entry.days, goals: entry.goals };
    setData(restoredData);
    setUndoCount(undoStack.current.length);

    // Persist
    if (entry.type === "tasks" || entry.type === "both") {
      setDirty(true);
      try {
        const res = await api.saveWeekPlan(entry.days, dataOffsetRef.current, lastKnownMtime.current);
        if (res.mtime) lastKnownMtime.current = res.mtime;
      } catch (e) {
        if (e instanceof Error && e.message.includes("changed on disk")) setExternalChange(true);
        /* otherwise auto-save will retry */
      }
    }
    if (entry.type === "goals" || entry.type === "both") {
      try {
        await api.saveGoals(entry.goals, weekOffset);
      } catch { /* silent */ }
    }
  };

  // Ctrl+Z / Ctrl+Shift+Z keyboard listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          performRedo();
        } else {
          performUndo();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "y") {
        e.preventDefault();
        performRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [data, weekOffset]);

  // Clear undo/redo when switching weeks
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setUndoCount(0);
  }, [weekOffset]);

  // External file change detection
  const lastKnownMtime = useRef<number | null>(null);
  const [externalChange, setExternalChange] = useState(false);

  // The offset the currently displayed data was loaded for — saves and
  // freshness checks must use THIS, never the live weekOffset state, or a
  // mid-navigation save/compare can hit the wrong week's file.
  const dataOffsetRef = useRef(0);
  const fetchSeq = useRef(0);

  // Record mtime after every save or fetch
  const recordMtime = async (ofs: number = dataOffsetRef.current) => {
    try {
      const r = await api.getWeekModified(ofs);
      lastKnownMtime.current = r.mtime;
    } catch { /* ignore */ }
  };

  // The notes scratchpad writes to the same week file — its saves are not
  // "external changes"; just refresh the baseline so the poll stays quiet.
  useEffect(() => {
    const onNotesSaved = () => { recordMtime(); };
    window.addEventListener("notes-saved", onNotesSaved);
    return () => window.removeEventListener("notes-saved", onNotesSaved);
  }, []);

  // Detect external changes (another device via Syncthing/the mini, or
  // Obsidian) on focus AND on a 30s poll. Clean tab → reload silently;
  // unsaved local edits → show the banner and let the save guard arbitrate.
  useEffect(() => {
    const check = async () => {
      if (document.hidden || !data) return;
      try {
        const r = await api.getWeekModified(dataOffsetRef.current);
        if (r.mtime && lastKnownMtime.current && r.mtime > lastKnownMtime.current) {
          // A reload mid-keystroke resets the input under the user's fingers
          // (eaten backspaces, garbled text on mobile IMEs) — if any text
          // field is active, fall back to the banner.
          const el = document.activeElement as HTMLElement | null;
          const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
          if (dirty || addingAt || typing) setExternalChange(true);
          else {
            fetchWeek();
            // Let the notes scratchpad refresh too — it reads the same file
            window.dispatchEvent(new CustomEvent("week-external-reload"));
          }
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
  }, [data, weekOffset, dirty, addingAt]);

  /** Mutate week data with undo tracking. Call instead of setData+setDirty. */
  const applyTaskChange = (newDays: DayTasks[]) => {
    if (!data) return;
    pushUndo("tasks");
    setData({ ...data, days: newDays });
    setDirty(true);
  };

  // Link popup
  const [linkPopup, setLinkPopup] = useState<{ dayIdx: number; taskIdx: number; links: TaskLink[]; pos: { top: number; left: number } } | null>(null);

  const openLinkPopup = (dayIdx: number, taskIdx: number, links: TaskLink[], e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setLinkPopup({ dayIdx, taskIdx, links, pos: { top: rect.bottom + 4, left: rect.left } });
  };

  const addLinkToTask = (dayIdx: number, taskIdx: number, name: string) => {
    if (!data) return;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const task = { ...days[dayIdx].tasks[taskIdx] };
    // Append [[name]] to the task text
    task.text = task.text + ` [[${name}]]`;
    // Update links array
    task.links = [...(task.links || []), { name, resolved_path: undefined }];
    days[dayIdx].tasks[taskIdx] = task;
    applyTaskChange(days);
    // Refresh popup
    setLinkPopup((prev) => prev ? { ...prev, links: task.links } : null);
  };

  const removeLinkFromTask = (dayIdx: number, taskIdx: number, linkName: string) => {
    if (!data) return;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const task = { ...days[dayIdx].tasks[taskIdx] };
    // Remove [[name]] or [[name|display]] from text
    task.text = task.text
      .replace(new RegExp(`\\s*\\[\\[${linkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'g'), '')
      .trim();
    task.links = (task.links || []).filter(l => l.name !== linkName);
    days[dayIdx].tasks[taskIdx] = task;
    applyTaskChange(days);
    // Update picker if open
    setNotePicker((prev) => prev && prev.dayIdx === dayIdx && prev.taskIdx === taskIdx
      ? { ...prev, links: task.links } : prev);
  };

  // Notes panel state
  const [showNotesPanel, setShowNotesPanel] = useState(true);
  // Mobile: toolbar clusters collapse to chips; one open at a time
  const [openCluster, setOpenCluster] = useState<"tag" | "view" | "filter" | null>(null);
  const toggleCluster = (k: "tag" | "view" | "filter") => setOpenCluster((prev) => (prev === k ? null : k));
  const [habitsOpen, setHabitsOpen] = useState(false);
  // Diary: opened explicitly per day, closes on any navigation
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [diaryFolder, setDiaryFolder] = useState("");
  const [notesPanelPct, setNotesPanelPct] = useState(50); // percentage width for notes panel
  const splitterDragging = useRef(false);
  const splitterContainer = useRef<HTMLDivElement | null>(null);

  // Note editor state
  const [noteEditor, setNoteEditor] = useState<{ path: string; name: string } | null>(null);

  // Note file picker state
  const [notePicker, setNotePicker] = useState<{
    dayIdx: number; taskIdx: number; group: string; links: import("../api").TaskLink[];
    pos: { top: number; left: number };
  } | null>(null);

  // Get current day name for notes
  const currentDayName = data?.days[selectedDayIdx]?.day || "monday";

  const openCarryForward = async () => {
    setCarryLoading(true);
    try {
      // Pull from the week before the one being viewed
      // When viewing wk14 (offset=1), pull from wk13 (offset=0 → current week)
      const sourceOffset = weekOffset - 1;
      const r = await api.getCarryForward(sourceOffset);
      if (!r.found || r.tasks.length === 0) {
        setError("No uncompleted tasks found in previous week");
        setCarryLoading(false);
        return;
      }
      setCarryTasks(r.tasks.map((t) => ({ ...t, priority: t.priority || "C", selected: true, targetDay: "monday" })));
      setCarryLabel(r.week_label);
      setCarryForwardOpen(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load carry-forward tasks");
    }
    setCarryLoading(false);
  };

  const pullFromCarry = async (carryIdx: number, dayIdx: number) => {
    if (!data || isArchive) return;
    const task = carryTasks[carryIdx];
    if (!task) return;
    try {
      const dayName = data.days[dayIdx]?.day || "monday";
      const sourceOffset = weekOffset - 1;
      await api.carryForward(
        [{ text: task.text.replace(/\s*@pin\b/gi, ""), day: dayName, subtasks: task.subtasks, focused: task.focused, waiting: task.waiting, priority: task.priority }],
        weekOffset, sourceOffset
      );
      setCarryTasks((prev) => prev.filter((_, i) => i !== carryIdx));
      fetchWeek();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to carry task");
    }
  };

  const pullCarryGroup = async (groupName: string, dayIdx: number) => {
    if (!data || isArchive) return;
    const dayName = data.days[dayIdx]?.day || "monday";
    const groupTasks = carryTasks.filter((t) => parseGroup(t.text).group === groupName);
    if (groupTasks.length === 0) return;
    try {
      const sourceOffset = weekOffset - 1;
      await api.carryForward(
        groupTasks.map((t) => ({ text: t.text.replace(/\s*@pin\b/gi, ""), day: dayName, subtasks: t.subtasks, focused: t.focused, waiting: t.waiting, priority: t.priority })),
        weekOffset, sourceOffset
      );
      setCarryTasks((prev) => prev.filter((t) => parseGroup(t.text).group !== groupName));
      fetchWeek();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to carry group");
    }
  };

  const carryAllToDay = async (dayName: string) => {
    if (carryTasks.length === 0) return;
    setCarryLoading(true);
    try {
      const sourceOffset = weekOffset - 1;
      await api.carryForward(
        carryTasks.map((t) => ({ text: t.text.replace(/\s*@pin\b/gi, ""), day: dayName, subtasks: t.subtasks, focused: t.focused, waiting: t.waiting, priority: t.priority })),
        weekOffset, sourceOffset
      );
      setCarryTasks([]);
      setCarryForwardOpen(false);
      fetchWeek();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to carry forward");
    }
    setCarryLoading(false);
  };

  // Quick capture into the bucket from the panel: "Group: task" reuses an
  // existing group's casing and keeps the group contiguous.
  const addToBucket = async (raw: string, fixedGroup?: string) => {
    const text = raw.trim();
    if (!text) return;
    try {
      const current = await api.getBucket();
      const parsed = fixedGroup ? { group: fixedGroup, label: text } : parseGroup(text);
      let canonical = parsed.group;
      if (parsed.group) {
        const existing = current.tasks.map((bt) => parseGroup(bt.text).group)
          .find((g) => g && g.toLowerCase() === parsed.group.toLowerCase());
        if (existing) canonical = existing;
      }
      const newTask = {
        text: canonical ? `${canonical}: ${parsed.label}` : text,
        priority: "", focused: false, waiting: false, subtasks: [],
      };
      let insertAfter = current.tasks.length - 1;
      if (canonical) {
        for (let i = current.tasks.length - 1; i >= 0; i--) {
          if (parseGroup(current.tasks[i].text).group.toLowerCase() === canonical.toLowerCase()) { insertAfter = i; break; }
        }
      }
      const next = [...current.tasks];
      next.splice(insertAfter + 1, 0, newTask);
      await api.saveBucket(next, current.pinned_groups);
      refreshBucket();
      window.dispatchEvent(new CustomEvent("bucket-changed"));
      if (canonical) setBucketExpandedGroups((prev) => new Set(prev).add(canonical));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add to bucket");
    }
  };

  const carryAllToBucket = async () => {
    if (carryTasks.length === 0) return;
    setCarryLoading(true);
    try {
      const currentBucket = await api.getBucket();
      const newTasks = [
        ...currentBucket.tasks,
        ...carryTasks.map((t) => ({
          text: t.text,
          priority: t.priority || "C",
          focused: t.focused,
          waiting: t.waiting,
          subtasks: t.subtasks,
        })),
      ];
      await api.saveBucket(newTasks, currentBucket.pinned_groups);
      refreshBucket();
      window.dispatchEvent(new CustomEvent("bucket-changed"));
      setCarryTasks([]);
      setCarryForwardOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to move to bucket");
    }
    setCarryLoading(false);
  };

  // Resolve a carry item in place: "done" = it actually happened last week
  // (forgot to tick), "delete" = no longer relevant. Both write to the
  // source week file and drop the item from the panel.
  const resolveCarryItem = async (carryIdx: number, action: "done" | "delete") => {
    const task = carryTasks[carryIdx];
    if (!task) return;
    try {
      await api.resolveCarry(task.text, weekOffset - 1, action);
      setCarryTasks((prev) => prev.filter((_, i) => i !== carryIdx));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update task");
    }
  };

  const carrySingleToBucket = async (carryIdx: number) => {
    const task = carryTasks[carryIdx];
    if (!task) return;
    try {
      const currentBucket = await api.getBucket();
      const newTasks = [
        ...currentBucket.tasks,
        { text: task.text, priority: task.priority || "C", focused: task.focused, waiting: task.waiting, subtasks: task.subtasks },
      ];
      await api.saveBucket(newTasks, currentBucket.pinned_groups);
      refreshBucket();
      window.dispatchEvent(new CustomEvent("bucket-changed"));
      setCarryTasks((prev) => prev.filter((_, i) => i !== carryIdx));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to move to bucket");
    }
  };

  // Fetch bucket count on load + refresh when bucket changes from Bucket tab
  const refreshBucket = () => {
    api.getBucket().then((r) => {
      setBucketCount(r.tasks.length);
      setBucketTasks(r.tasks);
    }).catch(() => {});
  };

  // Auto-load current week on mount
  useEffect(() => {
    if (!data && !loading) fetchWeek(0);
  }, []);

  useEffect(() => {
    const refresh = refreshBucket;
    refresh();
    const handleWeekChanged = () => { fetchWeek(); };
    window.addEventListener("week-changed", handleWeekChanged);
    window.addEventListener("bucket-changed", refresh);
    return () => {
      window.removeEventListener("week-changed", handleWeekChanged);
      window.removeEventListener("bucket-changed", refresh);
    };
  }, []);

  useEffect(() => {
    refreshHabits();
    refreshTime();
    // Refetch on focus and after edits elsewhere, so a Habits.md created or
    // edited after page load (Habits tab, Obsidian) shows up without a reload
    window.addEventListener("week-changed", refreshHabits);
    window.addEventListener("habits-changed", refreshHabits);
    window.addEventListener("focus", refreshHabits);
    window.addEventListener("time-changed", refreshTime);
    window.addEventListener("focus", refreshTime);
    const timeTicker = setInterval(() => setTimeTick((x) => x + 1), 30000);
    return () => {
      window.removeEventListener("week-changed", refreshHabits);
      window.removeEventListener("habits-changed", refreshHabits);
      window.removeEventListener("focus", refreshHabits);
      window.removeEventListener("time-changed", refreshTime);
      window.removeEventListener("focus", refreshTime);
      clearInterval(timeTicker);
    };
  }, []);

  // Load context mapping + tag table from config (feature off when empty).
  // Re-fetch on window focus so tags auto-created by the backend (e.g. a new
  // @f typed in Obsidian) and Settings-tab edits show up without a reload.
  useEffect(() => {
    const load = () => api.getSettings().then((s) => {
      setDiaryFolder(s.diary_folder || "");
      setCtxMap(s.contexts || {});
      setCtxTags({ ...DEFAULT_CTX_TAGS, ...(s.context_tags || {}) });
    }).catch(() => {});
    load();
    window.addEventListener("focus", load);
    window.addEventListener("ctx-config-changed", load);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("ctx-config-changed", load);
    };
  }, []);

  // Auto-fetch last week's incomplete tasks — only on the current week. Past weeks are
  // read-only archive; future weeks are for planning ahead, not catching up.
  // Refetch on every weekOffset change so stale carry state doesn't survive navigation.
  useEffect(() => {
    if (weekOffset !== 0) {
      setCarryTasks([]);
      setCarryForwardOpen(false);
      return;
    }
    api.getCarryForward(-1).then((r) => {
      if (r.found && r.tasks.length > 0) {
        setCarryTasks(r.tasks.map((t) => ({ ...t, priority: t.priority || "C", selected: true, targetDay: "monday" })));
        setCarryLabel(r.week_label);
      } else {
        setCarryTasks([]);
      }
    }).catch(() => {});
  }, [weekOffset]);

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

  const fetchWeek = async (offset?: number) => {
    const ofs = offset ?? weekOffset;
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError("");
    setDirty(false);
    setExternalChange(false);
    // A stale mtime must never be compared against another week's file
    lastKnownMtime.current = null;
    try {
      const result = await api.getWeekPlan(ofs);
      if (seq !== fetchSeq.current) return; // superseded by a newer navigation
      setData(result);
      dataOffsetRef.current = ofs;
      recordMtime(ofs);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : "Failed to load week plan");
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  };

  // Goals helpers
  const goalsAsList = (data?.goals || []).filter(g => g && g.trim());
  const hasGoals = goalsAsList.length > 0;

  const startEditingGoals = () => {
    setGoalsDraft(goalsAsList.join("\n"));
    setGoalsEditing(true);
    setGoalsExpanded(true);
  };

  const saveGoals = async (text: string) => {
    const goals = text.split("\n").map(l => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
    pushUndo("goals");
    setGoalsSaving(true);
    try {
      await api.saveGoals(goals, weekOffset);
      if (data) {
        setData({ ...data, goals });
      }
      setGoalsEditing(false);
      setGoalsSaved(true);
      setTimeout(() => setGoalsSaved(false), 1500);
    } catch {
      // stay in editing mode on failure
    } finally {
      setGoalsSaving(false);
    }
  };

  const carryOverGoals = async () => {
    try {
      const prevGoals = await api.getPreviousWeekGoals(weekOffset);
      if (prevGoals.length > 0) {
        setGoalsDraft(prevGoals.join("\n"));
        setGoalsEditing(true);
        setGoalsExpanded(true);
      }
    } catch {
      // silently ignore
    }
  };

  /** Flush unsaved changes to disk immediately (call before navigation). */
  const flushIfDirty = async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (dirty && data && !isArchive) {
      await saveWeek();
    }
  };

  const navigateWeek = async (direction: -1 | 1) => {
    const newOffset = weekOffset + direction;
    // Only allow 1 week forward max
    if (newOffset > 1) return;

    // Save pending changes before leaving this week
    await flushIfDirty();

    // If navigating forward to next week, ensure the file exists
    if (newOffset === 1) {
      try {
        await api.createNextWeek();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create next week");
        return;
      }
    }

    setWeekOffset(newOffset);
    await fetchWeek(newOffset);
  };

  // Navigate one day forward/backward, wrapping across weeks
  // Direction of the last day change — drives the slide-in animation
  const [slideDir, setSlideDir] = useState<0 | 1 | -1>(0);
  const slideClass = slideDir === 1 ? "day-enter-fwd" : slideDir === -1 ? "day-enter-back" : "";
  const goToDay = (i: number) => {
    setSlideDir(i > selectedDayIdx ? 1 : i < selectedDayIdx ? -1 : 0);
    setSelectedDayIdx(i);
  };

  // Swipe left/right in day view changes the day (touch screens)
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onDayTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    // Don't hijack text editing/selection surfaces
    if (target.closest("textarea, input, [contenteditable]")) { swipeStart.current = null; return; }
    swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onDayTouchEnd = (e: React.TouchEvent) => {
    const s = swipeStart.current;
    swipeStart.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    // Decisive horizontal gesture only — vertical scrolling stays untouched
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2.5 * Math.abs(dy)) {
      navigateDay(dx < 0 ? 1 : -1);
    }
  };

  const navigateDay = async (direction: -1 | 1) => {
    setSlideDir(direction);
    const newIdx = selectedDayIdx + direction;
    if (newIdx >= 0 && newIdx <= 6) {
      setSelectedDayIdx(newIdx);
    } else if (newIdx < 0) {
      // Go to previous week, Sunday
      await navigateWeek(-1);
      setSelectedDayIdx(6);
    } else {
      // Go to next week, Monday
      await navigateWeek(1);
      setSelectedDayIdx(0);
    }
  };

  // Navigate to today (current week + current day)
  const goToToday = async () => {
    if (weekOffset !== 0) {
      await flushIfDirty();
      setWeekOffset(0);
      await fetchWeek(0);
    }
    const jsDay = new Date().getDay();
    setSelectedDayIdx(jsDay === 0 ? 6 : jsDay - 1);
  };

  // Diary only stays open for the day it was opened on
  useEffect(() => { setDiaryOpen(false); }, [selectedDayIdx, viewMode, weekOffset]);

  // Ultra focus drops on navigation and whenever the pomodoro goes away
  useEffect(() => { setUltraFocus(false); }, [selectedDayIdx, viewMode, weekOffset]);
  useEffect(() => { if (!pomodoro) setUltraFocus(false); }, [pomodoro]);
  const ultraFocusActive = ultraFocus && !!pomodoro && viewMode === "day";
  const ufRedactRow = (dayIdx: number, taskIdx: number) =>
    ultraFocusActive && !(pomodoro!.dayIdx === dayIdx && pomodoro!.taskIdx === taskIdx) ? "uf-redact" : "";
  const ufRedactGroup = (groupName: string) =>
    ultraFocusActive && groupName.toLowerCase() !== (parseGroup(pomodoro!.taskText).group || "").toLowerCase() ? "uf-redact" : "";

  // Check if currently viewing today
  const isOnToday = weekOffset === 0 && selectedDayIdx === todayIdx;

  // Where carry-forward actions land: the day being viewed in day view,
  // today in week views.
  const carryTargetIdx = viewMode === "day" ? selectedDayIdx : todayIdx;
  const carryTargetLabel = DAY_LABELS[data?.days[carryTargetIdx]?.day || ""] || "today";

  // How far the carry panel looks for open tasks: everything before the day
  // being planned — so planning tomorrow tonight (or a day in a future week)
  // includes today and earlier days, not just "before today".
  const carryCutoffIdx = weekOffset === 0
    ? (viewMode === "day" ? Math.max(selectedDayIdx, todayIdx) : todayIdx)
    : (viewMode === "day" ? selectedDayIdx : 0);
  useEffect(() => {
    const d = data?.days[carryTargetIdx]?.day;
    if (d) setCarryDaySel(d);
  }, [carryTargetIdx, data]);

  const isArchive = weekOffset < 0;

  const saveWeek = async () => {
    if (!data || isArchive) return;
    setSaving(true);
    try {
      const res = await api.saveWeekPlan(data.days, dataOffsetRef.current, lastKnownMtime.current);
      setSaved(true);
      setDirty(false);
      setExternalChange(false);
      if (res.mtime) lastKnownMtime.current = res.mtime; else recordMtime();
      setTimeout(() => setSaved(false), 2000);
      // Let read-only views (Habits tab) recompute from the saved file
      window.dispatchEvent(new CustomEvent("week-saved"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save";
      if (msg.includes("changed on disk")) {
        // Another device (or Obsidian) changed the file — don't clobber.
        // The banner offers Reload; auto-save stays paused until then.
        setExternalChange(true);
      } else {
        setError(msg);
      }
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
    if (dirty && !autoSavePaused && !saving && data && !isArchive && !externalChange) {
      autoSaveTimerRef.current = setTimeout(() => {
        saveWeek();
      }, 2000);
    }
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [dirty, autoSavePaused, saving, data, externalChange]);

  // Splitter drag for notes panel resize
  const onSplitterDown = (e: React.MouseEvent) => {
    e.preventDefault();
    splitterDragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!splitterDragging.current || !splitterContainer.current) return;
      const rect = splitterContainer.current.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const tasksPct = Math.min(75, Math.max(25, (x / rect.width) * 100));
      setNotesPanelPct(Math.round(100 - tasksPct));
    };
    const onUp = () => {
      splitterDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Pomodoro timer tick
  const pomodoroState = pomodoro?.state ?? null;
  const pomodoroStartedAt = pomodoro?.startedAt ?? null;
  useEffect(() => {
    if (!pomodoroState || pomodoroState === "done" || pomodoroState === "break") return;

    const interval = setInterval(() => {
      setPomodoro((prev) => {
        if (!prev) return null;

        if (prev.state === "grace") {
          if (prev.graceRemaining <= 1) {
            sendNotification(
              "🍅 Grace Period Over!",
              `"${prev.taskText}" — Pomodoro is starting now!`,
              "pomo-grace"
            );
            return { ...prev, graceRemaining: 0, state: "running" };
          }
          return { ...prev, graceRemaining: prev.graceRemaining - 1 };
        }

        if (prev.state === "breakRunning") {
          if (prev.remaining <= 1) {
            sendNotification("☕ Break Over!", "Ready to start another round?", "pomo-break-done");
            return { ...prev, remaining: 0, state: "done" };
          }
          return { ...prev, remaining: prev.remaining - 1 };
        }

        // Running state
        if (prev.remaining <= 1) {
          sendNotification("🍅 Pomodoro Complete!", `"${prev.taskText}" — Time for a break?`, "pomo-done");
          return { ...prev, remaining: 0, state: "break" };
        }
        if (prev.remaining === 61) {
          sendNotification("🍅 1 Minute Left", `"${prev.taskText}" — wrapping up soon`, "pomo-warn");
        }
        return { ...prev, remaining: prev.remaining - 1 };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [pomodoroState, pomodoroStartedAt]);

  const startPomodoro = (dayIdx: number, taskIdx: number, taskText: string, minutes: number) => {
    // Time tracking stays a separate, deliberate ▶ action — the pomodoro
    // is a focus timer only.
    setPomodoro({
      taskIdx, dayIdx, taskText,
      duration: minutes * 60,
      remaining: minutes * 60,
      graceUsed: false,
      graceRemaining: 0,
      state: "running",
      startedAt: Date.now(),
    });
    setPomodoroPrompt(null);
  };

  const startGrace = (minutes: number) => {
    setPomodoro((prev) => prev ? { ...prev, state: "grace", graceUsed: true, graceRemaining: minutes * 60 } : null);
  };

  const startBreak = () => {
    setPomodoro((prev) => prev ? { ...prev, remaining: 5 * 60, state: "breakRunning" } : null);
  };

  const stopPomodoro = () => {
    setPomodoro(null);
    setPomodoroPrompt(null);
    setPomodoroPos(null);
  };

  const restartPomodoro = () => {
    setPomodoro((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        remaining: prev.duration,
        graceUsed: false,
        graceRemaining: 0,
        state: "running" as const,
        startedAt: Date.now(),
      };
    });
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const canGrace = pomodoro && !pomodoro.graceUsed && pomodoro.state === "running" && (Date.now() - pomodoro.startedAt) < 5 * 60 * 1000;

  const addTask = (dayIdx: number, afterIdx: number, text: string, group?: string | null) => {
    if (!data) return;
    let fullText = group ? `${group}: ${text}` : text;
    // Task added while a context filter is active must stay visible in it:
    // if it wouldn't resolve into the selection, tag it with the first
    // selected context so it doesn't vanish from the current view.
    if (ctxEnabled && ctxSel.length > 0 && !ctxSel.includes(resolveContext(fullText, ctxMap, ctxTags))) {
      fullText = `${fullText} ${ctxTokenOf(ctxSel[0], ctxTags)}`;
    }
    const newTask: Task = {
      text: fullText, done: false, source_file: "Plan Week.md", context: "", tags: [], priority: "B", pillars: [], subtasks: [], focused: false, waiting: false,
    };
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks.splice(afterIdx + 1, 0, newTask);
      return { ...d, tasks };
    });
    applyTaskChange(days);
    setAddingAt({ dayIdx, afterIdx: afterIdx + 1 });
  };

  // Log a habit completion: a checked Habit: task lands in today. The strip
  // only renders on the current week, so todayIdx is always the right target.
  const logHabit = (habit: Habit, variant?: string, time?: HabitTime) => {
    if (!data || weekOffset !== 0) return;
    const label = variant || habit.name;
    const newTask: Task = {
      text: `Habit: ${label}`, done: true, source_file: "Plan Week.md", context: "", tags: [],
      priority: "C", pillars: [], subtasks: [], focused: false, waiting: false,
    };
    const days = data.days.map((d, di) => (di === todayIdx ? { ...d, tasks: [...d.tasks, newTask] } : d));
    applyTaskChange(days);
    setHabits((prev) => prev.map((h) => h.name === habit.name
      ? { ...h, week_count: h.week_count + 1, days_done: h.today_count === 0 ? h.days_done + 1 : h.days_done, today_count: h.today_count + 1 }
      : h));
    // Timed habits also write a time-log entry, so intent (duration in the
    // habit) can be compared against reality (the month log)
    if (time) {
      api.addTimeEntry({
        date: new Date().toISOString().slice(0, 10),
        start: time.start,
        end: shiftTime(time.start, time.minutes),
        text: label,
      }).then(() => window.dispatchEvent(new CustomEvent("time-changed"))).catch(() => {});
    }
  };

  // Drop the @pin marker from a task text — pins never survive a carry;
  // surfacing an errand during work hours is a per-day decision.
  const unpinText = (t: Task): Task =>
    isPinnedText(t.text) ? { ...t, text: t.text.replace(/\s*@pin\b/gi, ""), clean_text: "" } : t;

  // Move a task from a previous day to the current day (daily carry-over)
  const moveTaskToDay = (fromDayIdx: number, fromTaskIdx: number, toDayIdx: number) => {
    if (!data || fromDayIdx === toDayIdx) return;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const [moved] = days[fromDayIdx].tasks.splice(fromTaskIdx, 1);
    days[toDayIdx].tasks.push(unpinText(moved));
    applyTaskChange(days);
  };

  // Move ALL of a day's open (and context-visible) tasks to another day
  const moveOpenTasksToDay = (fromDayIdx: number, toDayIdx: number) => {
    if (!data || fromDayIdx === toDayIdx) return;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const open = days[fromDayIdx].tasks.filter((t) => !t.done && taskVisibleInMode(t.text));
    days[fromDayIdx] = { ...days[fromDayIdx], tasks: days[fromDayIdx].tasks.filter((t) => t.done || !taskVisibleInMode(t.text)) };
    days[toDayIdx] = { ...days[toDayIdx], tasks: [...days[toDayIdx].tasks, ...open.map(unpinText)] };
    applyTaskChange(days);
  };

  // Resolve an earlier-day task in place: mark done (did it, forgot to tick)
  // or delete (no longer relevant). Used by the daily-carry panel.
  const resolveDayTask = (dayIdx: number, taskIdx: number, action: "done" | "delete") => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      if (action === "delete") tasks.splice(taskIdx, 1);
      else tasks[taskIdx] = unpinText({ ...tasks[taskIdx], done: true });
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  // Send all mode-visible open tasks from days before today to the bucket
  const earlierDaysToBucket = async (beforeDayIdx: number) => {
    if (!data) return;
    const moved: Task[] = [];
    const days = data.days.map((d, di) => {
      if (di >= beforeDayIdx) return d;
      const open = d.tasks.filter((t) => !t.done && taskVisibleInMode(t.text));
      if (open.length === 0) return d;
      moved.push(...open);
      return { ...d, tasks: d.tasks.filter((t) => t.done || !taskVisibleInMode(t.text)) };
    });
    if (moved.length === 0) return;
    try {
      const currentBucket = await api.getBucket();
      const newTasks = [
        ...currentBucket.tasks,
        ...moved.map((t) => ({ text: t.text, priority: t.priority || "C", focused: t.focused, waiting: t.waiting, subtasks: t.subtasks })),
      ];
      await api.saveBucket(newTasks, currentBucket.pinned_groups);
      applyTaskChange(days);
      refreshBucket();
      window.dispatchEvent(new CustomEvent("bucket-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to move to bucket");
    }
  };

  // Move all open tasks from previous days to today.
  // Bulk moves only touch tasks visible in the active context mode — what the
  // panel shows is exactly what moves; hidden contexts stay put.
  const carryAllFromPreviousDays = (uptoIdx: number, toDayIdx: number) => {
    if (!data) return;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const moved: Task[] = [];
    for (let di = 0; di < uptoIdx; di++) {
      if (di === toDayIdx) continue;
      const openTasks = days[di].tasks.filter((t) => !t.done && taskVisibleInMode(t.text));
      const remaining = days[di].tasks.filter((t) => t.done || !taskVisibleInMode(t.text));
      moved.push(...openTasks.map(unpinText));
      days[di] = { ...days[di], tasks: remaining };
    }
    days[toDayIdx] = { ...days[toDayIdx], tasks: [...days[toDayIdx].tasks, ...moved] };
    applyTaskChange(days);
  };

  // A completed task that came from a call note flips its AP line to "AP ✓"
  // in the source file, so the call log itself shows the action is done.
  const syncAPDone = (task: Task) => {
    const links = [...task.text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
    if (links.length === 0) return;
    const label = stripBucketMeta(stripCtxTokens(parseGroup(task.text).label))
      .replace(/\[\[[^\]]+\]\]/g, "").trim();
    links.forEach(async (name) => {
      try {
        const res = await api.vaultSearch(name, 1);
        if (res.results.length === 0) return;
        const { path } = res.results[0];
        const note = await api.readNote(path);
        const updated = markAPDone(note.content, label);
        if (updated) await api.writeNote(path, updated);
      } catch { /* cosmetic sync — never block completion */ }
    });
  };

  const toggleDone = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const completing = !data.days[dayIdx]?.tasks[taskIdx]?.done;
    // Completing the pomodoro's task ends the pomodoro (and ultra focus)
    if (completing && pomodoro && pomodoro.dayIdx === dayIdx && pomodoro.taskIdx === taskIdx) {
      setPomodoro(null);
    }
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const newDone = !tasks[taskIdx].done;
      const subtasks = newDone && tasks[taskIdx].subtasks?.length
        ? tasks[taskIdx].subtasks.map((s) => ({ ...s, done: true }))
        : tasks[taskIdx].subtasks;
      tasks[taskIdx] = { ...tasks[taskIdx], done: newDone, subtasks };
      // Completing a pinned exception clears the pin
      if (newDone) tasks[taskIdx] = unpinText(tasks[taskIdx]);
      if (newDone) syncAPDone(tasks[taskIdx]);
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  const togglePinned = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const t = tasks[taskIdx];
      tasks[taskIdx] = isPinnedText(t.text)
        ? { ...t, text: t.text.replace(/\s*@pin\b/gi, ""), clean_text: "" }
        : { ...t, text: `${t.text.trimEnd()} @pin`, clean_text: "" };
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  const toggleFocus = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks[taskIdx] = { ...tasks[taskIdx], focused: !tasks[taskIdx].focused };
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  const toggleWaiting = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks[taskIdx] = { ...tasks[taskIdx], waiting: !tasks[taskIdx].waiting };
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  const deleteTask = (dayIdx: number, taskIdx: number) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      tasks.splice(taskIdx, 1);
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  const sendToBucket = async (dayIdx: number, taskIdx: number, horizon: string = "") => {
    if (!data || isArchive) return;
    pushUndo("tasks");
    try {
      const result = await api.moveToBucket(taskIdx, dayIdx, weekOffset, horizon);
      setBucketCount(result.bucket_count);
      // Remove from local state
      const days = data.days.map((d, di) => {
        if (di !== dayIdx) return d;
        const tasks = [...d.tasks];
        tasks.splice(taskIdx, 1);
        return { ...d, tasks };
      });
      setData({ ...data, days });
      // Notify Bucket component to refresh
      window.dispatchEvent(new CustomEvent("bucket-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send to bucket");
    }
  };

  const sendGroupToBucket = async (dayIdx: number, groupName: string) => {
    if (!data || isArchive) return;
    const day = data.days[dayIdx];
    if (!day) return;
    // Collect indices of tasks in this group (reverse order to avoid index shifting)
    const indices: number[] = [];
    day.tasks.forEach((t, i) => {
      if (!t.done && parseGroup(t.text).group === groupName) indices.push(i);
    });
    if (indices.length === 0) return;
    try {
      // Send from highest index first so earlier indices stay valid
      for (const idx of indices.reverse()) {
        await api.moveToBucket(idx, dayIdx, weekOffset);
      }
      // Refresh state
      const weekResult = await api.getWeekPlan(weekOffset);
      setData(weekResult);
      const bucketResult = await api.getBucket();
      setBucketCount(bucketResult.tasks.length);
      setBucketTasks(bucketResult.tasks);
      window.dispatchEvent(new CustomEvent("bucket-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send group to bucket");
    }
  };

  const pullFromBucket = async (bucketIdx: number, dayIdx: number, targetGroup?: string | null) => {
    if (!data || isArchive) return;
    try {
      await api.moveFromBucket(bucketIdx, dayIdx, weekOffset);
      // Refresh both
      const weekResult = await api.getWeekPlan(weekOffset);
      // If dropped on a group, re-prefix the last task added to that day
      if (targetGroup && weekResult.days[dayIdx]) {
        const dayTasks = weekResult.days[dayIdx].tasks;
        if (dayTasks.length > 0) {
          const lastTask = dayTasks[dayTasks.length - 1];
          const { group, label } = parseGroup(lastTask.text);
          if (group !== targetGroup) {
            lastTask.text = `${targetGroup}: ${label}`;
            // Save the re-prefixed version (freshly fetched — no stale-write guard needed)
            await api.saveWeekPlan(weekResult.days, weekOffset);
          }
        }
      }
      setData(weekResult);
      recordMtime();
      refreshBucket();
      window.dispatchEvent(new CustomEvent("bucket-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to pull from bucket");
    }
  };

  const moveToGroup = (dayIdx: number, taskIdx: number, newGroup: string | null) => {
    if (!data) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const task = { ...tasks[taskIdx] };
      const { label } = parseGroup(task.text);
      task.text = newGroup ? `${newGroup}: ${label}` : label;
      tasks[taskIdx] = task;
      return { ...d, tasks };
    });
    applyTaskChange(days);
    setGroupPicker(null);
  };

  const editTask = (dayIdx: number, taskIdx: number, newText: string) => {
    if (!data) return;
    let trimmed = newText.trim();
    if (!trimmed) return; // don't allow empty — use delete instead
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      // The edit input shows the label with @tokens stripped — re-append the
      // original tokens unless the user typed their own into the new text.
      if (!/@(w|v|p|pin)\b/i.test(trimmed)) {
        const oldTokens = tasks[taskIdx].text.match(CTX_TOKEN_RE);
        if (oldTokens) trimmed = `${trimmed} ${oldTokens.map((t) => t.trim()).join(" ")}`;
      }
      // Preserve group prefix if the task had one and user edited only the label.
      // Clear clean_text so getDisplayText reads from the updated text instead of
      // the now-stale server-side clean version (otherwise the rendered label
      // reverts to what the server originally parsed, making the edit look lost).
      tasks[taskIdx] = { ...tasks[taskIdx], text: trimmed, clean_text: "" };
      return { ...d, tasks };
    });
    applyTaskChange(days);
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
    applyTaskChange(days);
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
    applyTaskChange(days);
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
    applyTaskChange(days);
    setEditingSubtask(null);
  };

  const addSubtask = (dayIdx: number, taskIdx: number, text: string) => {
    if (!data) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const subtasks = [...(tasks[taskIdx].subtasks || [])];
      if (addSubAfter !== null && addSubAfter < subtasks.length) {
        subtasks.splice(addSubAfter + 1, 0, { text: trimmed, done: false });
        setAddSubAfter(addSubAfter + 1);
      } else {
        subtasks.push({ text: trimmed, done: false });
      }
      tasks[taskIdx] = { ...tasks[taskIdx], subtasks };
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  const demoteToSubtask = (targetDayIdx: number, targetTaskIdx: number) => {
    if (!data || !dragRef.current) return;
    const { fromDay, fromIdx } = dragRef.current;
    if (fromDay === targetDayIdx && fromIdx === targetTaskIdx) return; // can't drop on self
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const [removed] = days[fromDay].tasks.splice(fromIdx, 1);
    // Adjust target index if same day and source was before target
    const adjustedIdx = (fromDay === targetDayIdx && fromIdx < targetTaskIdx) ? targetTaskIdx - 1 : targetTaskIdx;
    const targetTask = days[targetDayIdx].tasks[adjustedIdx];
    const { label } = parseGroup(removed.text);
    const newSub = { text: label, done: removed.done };
    days[targetDayIdx].tasks[adjustedIdx] = { ...targetTask, subtasks: [...(targetTask.subtasks || []), newSub] };
    applyTaskChange(days);
    dragRef.current = null;
    setDropTarget(null);
    // Auto-expand subtasks so the user sees the result
    const key = `${targetDayIdx}-${adjustedIdx}`;
    setExpandedSubtasks((prev) => new Set(prev).add(key));
  };

  const startBreakdown = (dayIdx: number, taskIdx: number) => {
    const key = `${dayIdx}-${taskIdx}`;
    const task = data?.days[dayIdx]?.tasks[taskIdx];
    const hasSubtasks = !!(task?.subtasks?.length);
    const wasExpanded = expandedSubtasks.has(key);

    if (wasExpanded && hasSubtasks) {
      // Toggle collapse if already expanded and has subtasks
      setExpandedSubtasks((prev) => { const next = new Set(prev); next.delete(key); return next; });
      setAddingSubtask(null);
      return;
    }
    // Expand and show input only when no subtasks yet
    setExpandedSubtasks((prev) => new Set(prev).add(key));
    if (!hasSubtasks) {
      setAddingSubtask({ dayIdx, taskIdx });
      setAddSubAfter(null);
    }
  };

  const cancelAddSubtask = (dayIdx: number, taskIdx: number) => {
    setAddingSubtask(null);
    setAddSubAfter(null);
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
    applyTaskChange(days);
    setPriorityMenu(null);
  };

  // Badge menu for a planned task — priority row, park-in-bucket row
  // (n/nw/m horizons or plain 🪣), and move-to-weekday row. Mirrors the
  // Bucket tab's picker so both tabs steer tasks the same way.
  const planTaskMenu = (dayIdx: number, taskIdx: number, task: Task) => (
    <div className="absolute left-0 top-full mt-0.5 z-20 rounded shadow-md p-1 space-y-1" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex gap-0.5">
        {PRIORITIES.filter((p) => p !== task.priority).map((p) => (
          <button key={p} onClick={(e) => { e.stopPropagation(); setPriority(dayIdx, taskIdx, p); }}
            className={`px-1 py-0 rounded text-[10px] font-bold cursor-pointer hover:opacity-70 ${PRIORITY_BADGE[p]}`}>
            {p}
          </button>
        ))}
      </div>
      <div className="flex gap-0.5 pt-0.5" style={{ borderTop: "1px solid var(--border)" }}>
        {([["", "🪣", "Back into the bucket"], ["n", "n", "Bucket — this week"], ["nw", "nw", "Bucket — next week"], ["m", "m", "Bucket — next month"]] as const).map(([hz, lbl, tip]) => (
          <button key={lbl} onClick={(e) => { e.stopPropagation(); setPriorityMenu(null); sendToBucket(dayIdx, taskIdx, hz); }}
            title={tip}
            className="px-1 py-0 rounded text-[10px] font-mono text-gray-500 hover:bg-blue-100 hover:text-blue-700"
            style={{ border: "1px solid var(--border)" }}>
            {lbl}
          </button>
        ))}
      </div>
      <div className="flex gap-0.5 pt-0.5" style={{ borderTop: "1px solid var(--border)" }}>
        {DAY_SHORT.map((d, di) => di !== dayIdx && (
          <button key={d} onClick={(e) => { e.stopPropagation(); setPriorityMenu(null); moveTaskToDay(dayIdx, taskIdx, di); }}
            title={`Move to ${d}`}
            className="px-1 py-0 rounded text-[10px] hover:bg-blue-100 hover:text-blue-700"
            style={{ color: "var(--text-secondary)" }}>
            {d.slice(0, 2)}
          </button>
        ))}
      </div>
    </div>
  );

  // --- Task drag handlers ---
  const handleDragStart = (dayIdx: number, taskIdx: number, group: string | null = null, e?: React.DragEvent) => {
    dragRef.current = { fromDay: dayIdx, fromIdx: taskIdx, group };
    dragGroupRef.current = null;
    // Set dataTransfer so the drag works with external drop targets (bucket icon)
    if (e) {
      e.dataTransfer.setData("text/plain", JSON.stringify({ dayIdx, taskIdx }));
      e.dataTransfer.effectAllowed = "move";
    }
  };

  const handleDragOver = (e: React.DragEvent, dayIdx: number, taskIdx: number, _group: string | null = null, nextIdx?: number) => {
    // Accept individual task drags, group drags, subtask-to-task promotions, and vault note drops
    const dominated = dragGroupRef.current || dragRef.current ||
      e.dataTransfer.types.includes("subtask") || e.dataTransfer.types.includes("bucket-task") ||
      e.dataTransfer.types.includes("carry-task") || e.dataTransfer.types.includes("carry-group") ||
      e.dataTransfer.types.includes("daily-carry-task") || e.dataTransfer.types.includes("daily-carry-day") ||
      e.dataTransfer.types.includes("vault-note-name");
    if (!dominated) return;
    if (dragGroupRef.current && dragGroupRef.current.fromDay !== dayIdx) return;
    e.preventDefault();
    // Keep the container-level "drop at end" fallback from overwriting the row indicator
    e.stopPropagation();

    // A row indicator replaces any group-header highlight from a group drag
    setDropGroupTarget(null);

    // For vault note drops, just highlight the task (no reorder)
    if (e.dataTransfer.types.includes("vault-note-name")) {
      setDropTarget({ day: dayIdx, idx: taskIdx, zone: "task" });
      return;
    }

    // Use mouse Y position relative to the element to decide above vs below.
    // In priority-sorted views the row below is not taskIdx + 1 in the stored
    // array — callers pass the next *displayed* row's index as nextIdx.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertIdx = e.clientY < midY ? taskIdx : (nextIdx ?? taskIdx + 1);
    setDropTarget({ day: dayIdx, idx: insertIdx, zone: "task" });
  };

  const handleDayDragOver = (e: React.DragEvent, dayIdx: number) => {
    e.preventDefault();
    if (!data) return;
    setDropTarget({ day: dayIdx, idx: data.days[dayIdx].tasks.length, zone: "end" });
  };

  const handleDrop = (dayIdx: number, taskIdx: number, e?: React.DragEvent, targetGroup?: string | null) => {
    if (!data) return;

    // Handle vault note dropped onto task — add wiki link
    if (e && e.dataTransfer.types.includes("vault-note-name")) {
      const noteName = e.dataTransfer.getData("vault-note-name");
      if (noteName) {
        addLinkToTask(dayIdx, taskIdx, noteName);
      }
      setDropTarget(null);
      return;
    }

    // Handle carry forward task dropped into day
    if (e && e.dataTransfer.types.includes("carry-task")) {
      try {
        const carryData = e.dataTransfer.getData("carry-task");
        if (carryData) {
          const { carryIdx } = JSON.parse(carryData);
          pullFromCarry(carryIdx, dayIdx);
          setDropTarget(null);
          return;
        }
      } catch { /* not a carry drop */ }
    }

    // Handle carry forward group dropped into day
    if (e && e.dataTransfer.types.includes("carry-group")) {
      try {
        const carryData = e.dataTransfer.getData("carry-group");
        if (carryData) {
          const { groupName } = JSON.parse(carryData);
          pullCarryGroup(groupName, dayIdx);
          setDropTarget(null);
          return;
        }
      } catch { /* not a carry group drop */ }
    }

    // Handle a "Before Today" task dropped into a day
    if (e && e.dataTransfer.types.includes("daily-carry-task")) {
      try {
        const raw = e.dataTransfer.getData("daily-carry-task");
        if (raw) {
          const { dayIdx: fromDay, taskIdx: fromTask } = JSON.parse(raw);
          moveTaskToDay(fromDay, fromTask, dayIdx);
          setDropTarget(null);
          return;
        }
      } catch { /* not a daily-carry drop */ }
    }

    // Handle a whole "Before Today" day section dropped into a day
    if (e && e.dataTransfer.types.includes("daily-carry-day")) {
      try {
        const raw = e.dataTransfer.getData("daily-carry-day");
        if (raw) {
          const { dayIdx: fromDay } = JSON.parse(raw);
          moveOpenTasksToDay(fromDay, dayIdx);
          setDropTarget(null);
          return;
        }
      } catch { /* not a daily-carry-day drop */ }
    }

    // Handle bucket task dropped into day/grid view
    if (e && e.dataTransfer.types.includes("bucket-task")) {
      try {
        const bucketData = e.dataTransfer.getData("bucket-task");
        if (bucketData) {
          const { bucketIdx } = JSON.parse(bucketData);
          pullFromBucket(bucketIdx, dayIdx, targetGroup || null);
          setDropTarget(null);
          return;
        }
      } catch { /* not a bucket drop */ }
    }

    // Handle subtask promoted to standalone task
    if (e && e.dataTransfer.types.includes("subtask")) {
      try {
        const subtaskData = e.dataTransfer.getData("subtask");
        if (subtaskData) {
          const from = JSON.parse(subtaskData);
          const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
          const parentTask = days[from.dayIdx].tasks[from.taskIdx];
          const subs = [...(parentTask.subtasks || [])];
          const [promoted] = subs.splice(from.subIdx, 1);
          days[from.dayIdx].tasks[from.taskIdx] = { ...parentTask, subtasks: subs };
          // Create new standalone task from subtask text, with target group prefix if applicable
          const newText = targetGroup ? `${targetGroup}: ${promoted.text}` : promoted.text;
          const newTask: Task = {
            text: newText, done: promoted.done, source_file: "Plan Week.md", context: "", tags: [],
            priority: "B", pillars: [], subtasks: [], focused: false, waiting: false,
          };
          const insertIdx = Math.min(taskIdx, days[dayIdx].tasks.length);
          days[dayIdx].tasks.splice(insertIdx, 0, newTask);
          applyTaskChange(days);
          setDropTarget(null);
          return;
        }
      } catch { /* not a subtask drop */ }
    }

    // Handle group dropped on a task position (same-day or cross-day)
    if (dragGroupRef.current) {
      const fromDay = dragGroupRef.current.fromDay;
      const groupName = dragGroupRef.current.groupName;
      const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));

      // Extract group tasks from source day
      // Cross-day: only move incomplete tasks, completed stay for history
      const sourceTasks = days[fromDay].tasks;
      const isCrossDay = fromDay !== dayIdx;
      const groupTasks = sourceTasks.filter((t) =>
        parseGroup(t.text).group === groupName && (!isCrossDay || !t.done)
      );
      days[fromDay].tasks = sourceTasks.filter((t) =>
        !(parseGroup(t.text).group === groupName && (!isCrossDay || !t.done))
      );

      if (fromDay === dayIdx) {
        // Same-day move: find insert position in the remaining array
        const remaining = days[dayIdx].tasks;
        let insertIdx = remaining.length;
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
        const insertIdx = Math.min(taskIdx, days[dayIdx].tasks.length);
        days[dayIdx].tasks.splice(insertIdx, 0, ...groupTasks);
      }

      applyTaskChange(days);
      dragGroupRef.current = null;
      setDropTarget(null);
      setDropGroupTarget(null);
      return;
    }

    if (!dragRef.current) return;
    const { fromDay, fromIdx } = dragRef.current;

    // Land where the indicator showed: dropTarget holds the midpoint-adjusted
    // insert index from the last dragOver; taskIdx alone is just the hovered row.
    const rawTarget = dropTarget && dropTarget.day === dayIdx ? dropTarget.idx : taskIdx;

    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    let [movedTask] = days[fromDay].tasks.splice(fromIdx, 1);

    // Re-prefix task if moving between groups
    if (targetGroup !== undefined) {
      const { label } = parseGroup(movedTask.text);
      const newText = targetGroup ? `${targetGroup}: ${label}` : label;
      movedTask.text = newText;
    }

    // Dragging to another day is a carry — pins never survive a carry
    if (fromDay !== dayIdx) movedTask = unpinText(movedTask);

    // Flat views display priority-sorted, so the card only stays where it was
    // dropped if its priority matches that position — adopt the anchor's band.
    if (!groupView) {
      const origTasks = data.days[dayIdx].tasks;
      let anchor: Task | undefined;
      if (rawTarget < origTasks.length) {
        anchor = origTasks[rawTarget];
      } else {
        // End-of-list drop: anchor on the visually last active task (worst band)
        const actives = origTasks.filter((t) => !t.done && t !== movedTask);
        anchor = actives.reduce<Task | undefined>((worst, t) =>
          !worst || (PRIORITY_ORDER_MAP[t.priority] ?? 4) >= (PRIORITY_ORDER_MAP[worst.priority] ?? 4) ? t : worst
        , undefined);
      }
      if (anchor && anchor !== movedTask && anchor.priority) movedTask.priority = anchor.priority;
    }

    let insertIdx = rawTarget;
    if (fromDay === dayIdx && fromIdx < rawTarget) insertIdx = Math.max(0, insertIdx - 1);
    insertIdx = Math.min(insertIdx, days[dayIdx].tasks.length);

    days[dayIdx].tasks.splice(insertIdx, 0, movedTask);
    applyTaskChange(days);
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
    // A group-header highlight replaces any stale row indicator
    setDropTarget(null);
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
    applyTaskChange(days);
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
    applyTaskChange(days);
    dragGroupRef.current = null;
    setDropGroupTarget(null);
  };

  // --- View helpers ---
  const visibleDays: number[] = (() => {
    switch (viewMode) {
      case "day": return [selectedDayIdx];
      case "3day": {
        const idx = selectedDayIdx;
        // Selected day is always the first visible, clamped so we don't exceed Sunday
        const start = Math.min(idx, 4);  // max start is Friday (4) → Fri, Sat, Sun
        return [start, start + 1, start + 2];
      }
      case "5day": return [0, 1, 2, 3, 4];
      case "weekend": return [5, 6];
      default: return [0, 1, 2, 3, 4, 5, 6];
    }
  })();

  const gridCols = viewMode === "3day" ? "grid-cols-3" : viewMode === "weekend" ? "grid-cols-2" : viewMode === "5day" ? "grid-cols-5" : "grid-cols-7";

  const getFilteredTasks = (tasks: Task[]): Task[] => {
    let filtered = tasks.filter((t) => taskVisibleInMode(t.text));
    if (filterGroup) {
      filtered = filtered.filter((t) => parseGroup(t.text).group === filterGroup);
    }
    if (!showCompleted) {
      filtered = filtered.filter((t) => !t.done || (t.subtasks?.some((s) => !s.done)));
    }
    return filtered;
  };

  const buildDayGroups = (tasks: Task[]): { name: string; items: { task: Task; originalIdx: number; label: string }[] }[] => {
    // Build CONTIGUOUS sections — each run of same-prefix tasks is its own section.
    // Ungrouped tasks between groups appear as separate sections so they can be
    // individually repositioned relative to named groups.
    const sections: { name: string; items: { task: Task; originalIdx: number; label: string }[] }[] = [];
    tasks.forEach((task, idx) => {
      const { group } = parseGroup(task.text);
      const label = getDisplayText(task);
      if (!taskVisibleInMode(task.text)) return;
      if (filterGroup && group !== filterGroup) return;
      if (!showCompleted && task.done && !(task.subtasks?.some((s) => !s.done))) return;
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
  const reorderSubtask = (dayIdx: number, taskIdx: number, fromIdx: number, toIdx: number) => {
    if (!data || fromIdx === toIdx) return;
    const days = data.days.map((d, di) => {
      if (di !== dayIdx) return d;
      const tasks = [...d.tasks];
      const task = { ...tasks[taskIdx] };
      const subs = [...(task.subtasks || [])];
      const [moved] = subs.splice(fromIdx, 1);
      subs.splice(toIdx, 0, moved);
      task.subtasks = subs;
      tasks[taskIdx] = task;
      return { ...d, tasks };
    });
    applyTaskChange(days);
  };

  // Promote a subtask to a standalone task (inserted right after its parent)
  const promoteSubtask = (dayIdx: number, taskIdx: number, subIdx: number, targetGroup?: string | null) => {
    if (!data) return;
    const days = data.days.map((d) => ({ ...d, tasks: [...d.tasks] }));
    const parentTask = days[dayIdx].tasks[taskIdx];
    const subs = [...(parentTask.subtasks || [])];
    const [promoted] = subs.splice(subIdx, 1);
    days[dayIdx].tasks[taskIdx] = { ...parentTask, subtasks: subs };
    // Determine group: use explicit targetGroup, or inherit from parent
    const parentGroup = parseGroup(parentTask.text).group;
    const group = targetGroup !== undefined ? targetGroup : parentGroup;
    const newText = group ? `${group}: ${promoted.text}` : promoted.text;
    const newTask: Task = {
      text: newText, done: promoted.done, source_file: "Plan Week.md", context: "", tags: [],
      priority: "B", pillars: [], subtasks: [], focused: false, waiting: false,
    };
    // Insert right after the parent task
    days[dayIdx].tasks.splice(taskIdx + 1, 0, newTask);
    applyTaskChange(days);
  };

  const renderSubtasks = (dayIdx: number, taskIdx: number, task: Task, compact: boolean) => {
    const key = `${dayIdx}-${taskIdx}`;
    if (!expandedSubtasks.has(key)) return null;
    const subtasks = task.subtasks || [];
    const textSize = compact ? "text-[10px]" : "text-xs";
    const isAdding = addingSubtask?.dayIdx === dayIdx && addingSubtask?.taskIdx === taskIdx;
    // Don't render empty container — only show when there are subtasks or actively adding
    if (!subtasks.length && !isAdding) return null;

    return (
      <div
        className={`${compact ? "ml-5" : "ml-8"} pl-2 border-l-2 border-amber-200 ${textSize} py-0.5`}
        onDoubleClick={(e) => { e.stopPropagation(); setAddingSubtask({ dayIdx, taskIdx }); setAddSubAfter(null); }}
        onDragOver={(e) => {
          // Accept subtask reorder drags within this container
          if (e.dataTransfer.types.includes("subtask")) {
            e.preventDefault(); e.stopPropagation();
            return;
          }
          // Accept main task drops to demote to subtask
          if (dragRef.current && !(dragRef.current.fromDay === dayIdx && dragRef.current.fromIdx === taskIdx)) {
            e.preventDefault(); e.stopPropagation();
            e.currentTarget.classList.add("bg-amber-50", "ring-1", "ring-amber-300");
          }
        }}
        onDragLeave={(e) => { e.currentTarget.classList.remove("bg-amber-50", "ring-1", "ring-amber-300"); }}
        onDrop={(e) => {
          e.stopPropagation();
          e.currentTarget.classList.remove("bg-amber-50", "ring-1", "ring-amber-300");
          if (dragRef.current) { demoteToSubtask(dayIdx, taskIdx); return; }
        }}
      >
        {subtasks.map((sub, si) => (
          <React.Fragment key={si}>
            <div
              className={`group/sub flex items-center gap-1 py-1 border-t-2 border-transparent ${
                subDropTarget?.dayIdx === dayIdx && subDropTarget?.taskIdx === taskIdx && subDropTarget?.subIdx === si ? "!border-amber-400" : ""
              }`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setAddSubAfter(si);
                setAddingSubtask({ dayIdx, taskIdx });
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("subtask")) {
                  e.preventDefault(); e.stopPropagation();
                  setSubDropTarget({ dayIdx, taskIdx, subIdx: si });
                }
              }}
              onDragLeave={() => setSubDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault(); e.stopPropagation();
                setSubDropTarget(null);
                try {
                  const from = JSON.parse(e.dataTransfer.getData("subtask"));
                  if (from.dayIdx === dayIdx && from.taskIdx === taskIdx && from.subIdx !== si) {
                    reorderSubtask(dayIdx, taskIdx, from.subIdx, si);
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
                    e.dataTransfer.setData("subtask", JSON.stringify({ dayIdx, taskIdx, subIdx: si }));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setSubDropTarget(null)}
                  className="shrink-0 text-[10px] text-gray-300 cursor-grab active:cursor-grabbing hover:text-gray-500 select-none leading-none"
                  title="Drag to reorder"
                >≡</span>
              )}
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
                  className={`flex-1 ${sub.done ? "text-gray-400 line-through" : "cursor-text hover:text-amber-700"}`}
                  style={!sub.done ? { color: "var(--text)" } : undefined}
                >
                  {sub.text}
                </span>
              )}
              {!sub.done && (
                <button
                  onClick={(e) => { e.stopPropagation(); promoteSubtask(dayIdx, taskIdx, si); }}
                  className="shrink-0 text-[10px] text-gray-300 hover:text-blue-500 opacity-0 group-hover/sub:opacity-100 transition-opacity"
                  title="Promote to standalone task"
                >
                  ↑
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); deleteSubtask(dayIdx, taskIdx, si); }}
                className="shrink-0 text-[10px] text-gray-300 hover:text-red-500 opacity-0 group-hover/sub:opacity-100 transition-opacity"
              >
                &times;
              </button>
            </div>
            {/* Insert-after input */}
            {isAdding && addSubAfter === si && (
              <div className="py-0.5">
                <AutoFocusInput
                  onSubmit={(text) => { addSubtask(dayIdx, taskIdx, text); }}
                  onCancel={() => cancelAddSubtask(dayIdx, taskIdx)}
                  placeholder="Add step..."
                  className={`w-full ${textSize} px-1.5 py-0.5 border border-amber-300 rounded bg-white outline-none focus:ring-1 focus:ring-amber-400`}
                />
              </div>
            )}
          </React.Fragment>
        ))}
        {/* Add subtask input at end — only when adding at end (not after a specific sub-task) */}
        {isAdding && addSubAfter === null && (
          <div className="py-0.5">
            <AutoFocusInput
              onSubmit={(text) => { addSubtask(dayIdx, taskIdx, text); }}
              onCancel={() => cancelAddSubtask(dayIdx, taskIdx)}
              placeholder="Add step..."
              className={`w-full ${textSize} px-1.5 py-0.5 border border-amber-300 rounded bg-white outline-none focus:ring-1 focus:ring-amber-400`}
            />
          </div>
        )}
      </div>
    );
  };

  // --- Compact task item for grid views (5day, 7day, weekend) ---
  const renderCompactTaskItem = (task: Task, dayIdx: number, taskIdx: number, displayText: string, group: string | null, seqLabel: string = "", nextIdx?: number) => {
    const taskCtx = ctxEnabled ? resolveContext(task.text, ctxMap, ctxTags) : null;
    const pinned = ctxEnabled && isPinnedText(task.text);
    // Exception = visible only because it's pinned while Work is selected
    const isException = pinned && taskCtx !== null && ctxSel.includes("work") && !ctxSel.includes(taskCtx);
    // Edges help whenever more than one context is on screen
    const showEdge = taskCtx !== null && (ctxSel.length === 0 || ctxSel.length > 1 || isException);
    return (
    <div
      key={`${task.text}-${taskIdx}`}
      draggable={!task.done}
      onDragStart={(e) => handleDragStart(dayIdx, taskIdx, group, e)}
      onDragOver={(e) => handleDragOver(e, dayIdx, taskIdx, group, nextIdx)}
      onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, taskIdx, e); }}
      onDragEnd={handleDragEnd}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setAddingAt({ dayIdx, afterIdx: taskIdx, group });
      }}
      style={showEdge ? { boxShadow: `inset 2px 0 0 ${ctxEdgeColor(taskCtx!)}` } : undefined}
      className={`group flex items-start gap-1 py-0.5 px-1 rounded text-[11px] leading-tight select-none ${
        dropTarget?.day === dayIdx && dropTarget?.idx === taskIdx && (dropTarget?.zone ?? "task") === "task"
          ? "border-t-2 border-blue-400"
          : "border-t-2 border-transparent"
      } ${
        task.done
          ? "opacity-40"
          : isException
            ? "opacity-75 cursor-grab active:cursor-grabbing hover:bg-white/80"
            : "cursor-grab active:cursor-grabbing hover:bg-white/80"
      }`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); toggleDone(dayIdx, taskIdx); }}
        className={`shrink-0 inline-flex items-center justify-center hover:opacity-70 ${task.done ? "text-green-400" : "text-gray-400 hover:text-green-500"}`}
        title={task.done ? "Mark undone" : "Mark done"}
      >
        <TaskCheck done={task.done} size={13} />
      </button>
      <div className="plan-pop relative shrink-0">
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
            {priorityMenu?.day === dayIdx && priorityMenu?.task === taskIdx && planTaskMenu(dayIdx, taskIdx, task)}
          </>
        )}
      </div>
      {editingTask?.dayIdx === dayIdx && editingTask?.taskIdx === taskIdx ? (
        <EditInput
          initialValue={displayText}
          onSave={(text) => {
            const prefix = group ? `${group}: ` : parseGroup(task.text).group ? `${parseGroup(task.text).group}: ` : "";
            editTask(dayIdx, taskIdx, prefix + text);
          }}
          onCancel={() => setEditingTask(null)}
          className="flex-1 text-[11px] px-1 py-0.5 border border-blue-300 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"
        />
      ) : (
        <span
          onClick={(e) => { e.stopPropagation(); if (!task.done) setEditingTask({ dayIdx, taskIdx }); }}
          className={`break-words flex-1 ${task.focused && !task.done ? "font-bold" : ""} ${task.done ? "text-gray-400 line-through" : "cursor-text hover:text-blue-700"}`}
          style={!task.done ? { color: "var(--text)" } : undefined}
        >
          {task.waiting && <span className="mr-0.5 cursor-pointer" title="Remove wait" onClick={(e) => { e.stopPropagation(); toggleWaiting(dayIdx, taskIdx); }}>⏳</span>}
          {renderLinkedText(displayText)}
        </span>
      )}
      {/* Wait hourglass toggle — only show when not already waiting */}
      {!task.done && !task.waiting && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleWaiting(dayIdx, taskIdx); }}
          className="shrink-0 text-[10px] transition-opacity opacity-0 group-hover:opacity-30 hover:!opacity-100"
          title="Mark as waiting"
        >
          ⏳
        </button>
      )}
      {/* Start time tracking (auto-pauses whatever was running) */}
      {!task.done && (
        <button
          onClick={(e) => { e.stopPropagation(); startTracking(task); }}
          className="shrink-0 text-[10px] transition-opacity opacity-0 group-hover:opacity-30 hover:!opacity-100"
          title="Track time on this task"
        >
          ▶
        </button>
      )}
      {/* Pin toggle — personal/volunteer tasks only: surface during Work mode */}
      {ctxEnabled && !task.done && taskCtx !== "work" && (
        <button
          onClick={(e) => { e.stopPropagation(); togglePinned(dayIdx, taskIdx); }}
          className={`shrink-0 text-[10px] transition-opacity ${pinned ? "opacity-100" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"}`}
          title={pinned ? "Unpin — stop showing during Work mode" : "Pin — show during Work mode"}
        >
          📌
        </button>
      )}
      {/* Focus horn icon */}
      {!task.done && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (task.focused) {
              toggleFocus(dayIdx, taskIdx);
              if (pomodoro?.taskIdx === taskIdx && pomodoro?.dayIdx === dayIdx) stopPomodoro();
            } else {
              toggleFocus(dayIdx, taskIdx);
              setPomodoroPrompt({ dayIdx, taskIdx, taskText: task.text });
            }
          }}
          className={`shrink-0 text-[10px] transition-opacity ${task.focused ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"}`}
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
          className="shrink-0 text-[10px] opacity-0 group-hover:opacity-30 hover:!opacity-100 transition-opacity"
          title="Break down into steps"
        >
          🐘
        </button>
      ) : null}
      {/* Link icon */}
      {task.links?.length > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); openLinkPopup(dayIdx, taskIdx, task.links, e); }}
          className="shrink-0 text-[10px] text-blue-400 hover:text-blue-600 transition-opacity opacity-70 hover:opacity-100"
          title={`${task.links.length} linked note${task.links.length > 1 ? "s" : ""}`}
        >
          🔗{task.links.length > 1 && <sup className="text-[8px] font-bold">{task.links.length}</sup>}
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); deleteTask(dayIdx, taskIdx); }}
        className="shrink-0 text-[10px] text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Delete task"
      >
        &times;
      </button>
    </div>
    );
  };

  // --- Full-size task item for Day view ---
  const renderDayTaskItem = (task: Task, dayIdx: number, taskIdx: number, displayText: string, seqLabel: string, group: string | null, nextIdx?: number) => {
    const taskCtx = ctxEnabled ? resolveContext(task.text, ctxMap, ctxTags) : null;
    const pinned = ctxEnabled && isPinnedText(task.text);
    // A pinned personal/volunteer task shown inside Work mode = the exception
    // Exception = visible only because it's pinned while Work is selected
    const isException = pinned && taskCtx !== null && ctxSel.includes("work") && !ctxSel.includes(taskCtx);
    // Edges help whenever more than one context is on screen
    const showEdge = taskCtx !== null && (ctxSel.length === 0 || ctxSel.length > 1 || isException);
    return (
    <div key={`day-${taskIdx}`}>
      <div
        draggable={!task.done}
        onDragStart={!task.done ? (e) => handleDragStart(dayIdx, taskIdx, group, e) : undefined}
        onDragOver={(e) => handleDragOver(e, dayIdx, taskIdx, group, nextIdx)}
        onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, taskIdx, e); }}
        onDragEnd={handleDragEnd}
        onDoubleClick={(e) => { e.stopPropagation(); setAddingAt({ dayIdx, afterIdx: taskIdx, group }); }}
        style={showEdge ? { boxShadow: `inset 2px 0 0 ${ctxEdgeColor(taskCtx!)}` } : undefined}
        className={`group flex items-center gap-2 py-1 px-2 rounded text-sm select-none ${
          dropTarget?.day === dayIdx && dropTarget?.idx === taskIdx && (dropTarget?.zone ?? "task") === "task"
            ? "border-t-2 border-blue-400"
            : "border-t-2 border-transparent"
        } ${
          task.done
            ? "opacity-50"
            : isException
              ? "opacity-75 cursor-grab active:cursor-grabbing hover:bg-gray-50"
              : "cursor-grab active:cursor-grabbing hover:bg-gray-50"
        }`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); toggleDone(dayIdx, taskIdx); }}
          className={`shrink-0 inline-flex items-center justify-center hover:opacity-70 ${task.done ? "text-green-400" : "text-gray-400 hover:text-green-500"}`}
          title={task.done ? "Mark undone" : "Mark done"}
        >
          <TaskCheck done={task.done} size={15} />
        </button>
        <div className="plan-pop relative shrink-0">
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
              {priorityMenu?.day === dayIdx && priorityMenu?.task === taskIdx && planTaskMenu(dayIdx, taskIdx, task)}
            </>
          )}
        </div>
        {editingTask?.dayIdx === dayIdx && editingTask?.taskIdx === taskIdx ? (
          <EditInput
            initialValue={displayText}
            onSave={(text) => {
              const prefix = group ? `${group}: ` : parseGroup(task.text).group ? `${parseGroup(task.text).group}: ` : "";
              editTask(dayIdx, taskIdx, prefix + text);
            }}
            onCancel={() => setEditingTask(null)}
            className="flex-1 text-sm px-1.5 py-0.5 border border-blue-300 rounded bg-white outline-none focus:ring-1 focus:ring-blue-400"
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); if (!task.done) setEditingTask({ dayIdx, taskIdx }); }}
            className={`flex-1 ${task.focused && !task.done ? "font-bold" : ""} ${task.done ? "line-through" : "cursor-text hover:text-blue-700"}`}
            style={{ color: task.done ? "var(--text-tertiary)" : "var(--text)" }}
          >
            {task.waiting && <span className="mr-1 cursor-pointer" title="Remove wait" onClick={(e) => { e.stopPropagation(); toggleWaiting(dayIdx, taskIdx); }}>⏳</span>}
            {renderLinkedText(displayText)}
          </span>
        )}
        {task.pillars?.length > 0 && (
          <span className="shrink-0" title={task.pillars.map((p) => PILLAR_ICONS[p]?.title || p).join(", ")}>
            {task.pillars.map((p) => PILLAR_ICONS[p]?.symbol || p).join("")}
          </span>
        )}
        {/* Wait hourglass toggle — only show when not already waiting */}
        {!task.done && !task.waiting && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleWaiting(dayIdx, taskIdx); }}
            className="shrink-0 text-sm transition-opacity opacity-0 group-hover:opacity-30 hover:!opacity-100"
            title="Mark as waiting"
          >
            ⏳
          </button>
        )}
        {/* Start time tracking (auto-pauses whatever was running) */}
        {!task.done && (
          <button
            onClick={(e) => { e.stopPropagation(); startTracking(task); }}
            className="shrink-0 text-sm transition-opacity opacity-0 group-hover:opacity-30 hover:!opacity-100"
            title="Track time on this task"
          >
            ▶
          </button>
        )}
        {/* Pin toggle — personal/volunteer tasks only: surface during Work mode */}
        {ctxEnabled && !task.done && taskCtx !== "work" && (
          <button
            onClick={(e) => { e.stopPropagation(); togglePinned(dayIdx, taskIdx); }}
            className={`shrink-0 text-sm transition-opacity ${pinned ? "opacity-100" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"}`}
            title={pinned ? "Unpin — stop showing during Work mode" : "Pin — show during Work mode"}
          >
            📌
          </button>
        )}
        {/* Focus horn icon */}
        {!task.done && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (task.focused) {
                toggleFocus(dayIdx, taskIdx);
                if (pomodoro?.taskIdx === taskIdx && pomodoro?.dayIdx === dayIdx) stopPomodoro();
              } else {
                toggleFocus(dayIdx, taskIdx);
                setPomodoroPrompt({ dayIdx, taskIdx, taskText: task.text });
              }
            }}
            className={`shrink-0 text-sm transition-opacity ${task.focused ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"}`}
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
            className="shrink-0 text-sm opacity-0 group-hover:opacity-30 hover:!opacity-100 transition-opacity"
            title="Break down into steps (white elephant)"
          >
            🐘
          </button>
        ) : null}
        {/* Link icon — opens file picker for linking vault notes */}
        {!task.done && viewMode === "day" && (() => {
          const taskGroup = group || parseGroup(task.text).group;
          const hasLinks = task.links && task.links.length > 0;
          return (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.target as HTMLElement).getBoundingClientRect();
                setNotePicker({
                  dayIdx, taskIdx, group: taskGroup,
                  links: task.links || [],
                  pos: { top: rect.bottom + 4, left: rect.left - 100 },
                });
              }}
              className={`shrink-0 text-sm transition-opacity ${
                hasLinks ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-30 hover:!opacity-100"
              }`}
              title={`${hasLinks ? "Open" : "Add"} notes${taskGroup ? ` for ${taskGroup}` : ""}`}
            >
              🔗{hasLinks && task.links.length > 1 && <sup className="text-[8px] font-bold">{task.links.length}</sup>}
            </button>
          );
        })()}
        {/* Move to group picker */}
        {!task.done && (
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setGroupPicker(groupPicker?.dayIdx === dayIdx && groupPicker?.taskIdx === taskIdx ? null : { dayIdx, taskIdx });
              }}
              className="shrink-0 text-gray-400 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              title="Move to group"
            >
              📂
            </button>
            {groupPicker?.dayIdx === dayIdx && groupPicker?.taskIdx === taskIdx && (
              <div className="absolute bottom-6 right-0 z-30 rounded-lg shadow-xl border p-2 min-w-[140px] max-h-48 overflow-y-auto" style={{ backgroundColor: "var(--card)", borderColor: "var(--card-border)" }}>
                <div className="text-[10px] text-gray-400 font-medium mb-1 px-1">Move to group:</div>
                <button
                  onClick={(e) => { e.stopPropagation(); moveToGroup(dayIdx, taskIdx, null); }}
                  className="w-full text-left px-2 py-1 text-xs rounded hover:bg-gray-100 text-gray-600"
                >
                  — No group (ungrouped)
                </button>
                {allGroups.map((g) => (
                  <button
                    key={g}
                    onClick={(e) => { e.stopPropagation(); moveToGroup(dayIdx, taskIdx, g); }}
                    className={`w-full text-left px-2 py-1 text-xs rounded hover:bg-blue-50 hover:text-blue-700 ${
                      parseGroup(task.text).group === g ? "font-bold text-blue-600" : "text-gray-700"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); deleteTask(dayIdx, taskIdx); }}
          className="shrink-0 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Delete task"
        >
          &times;
        </button>
      </div>
    </div>
    );
  };

  const renderAddInput = (dayIdx: number, afterIdx: number) => {
    if (!addingAt || addingAt.dayIdx !== dayIdx || addingAt.afterIdx !== afterIdx) return null;
    return (
      <div className="py-0.5 px-1">
        <AutoFocusInput
          placeholder={addingAt.group ? `Add to ${addingAt.group}...` : "Add task..."}
          onSubmit={(text) => addTask(dayIdx, afterIdx, text, addingAt.group)}
          onCancel={() => setAddingAt(null)}
        />
      </div>
    );
  };

  // Count completed across visible days for the toggle label
  const completedCount = data
    ? visibleDays.reduce((sum, di) => sum + data.days[di].tasks.filter((t) => t.done && taskVisibleInMode(t.text)).length, 0)
    : 0;

  // Daily carry count: open tasks from days before the carry cutoff,
  // counting only tasks visible in the active context mode
  const dailyCarryCount = data && weekOffset >= 0 && carryCutoffIdx > 0
    ? data.days.slice(0, carryCutoffIdx).reduce((sum, d) => sum + d.tasks.filter((t) => !t.done && taskVisibleInMode(t.text)).length, 0)
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

    // Daily carry: open tasks from previous days in the same week
    const dailyCarryTasks: { dayIdx: number; dayName: string; task: Task; taskIdx: number }[] = [];
    if (weekOffset === 0 || weekOffset === 1) {
      for (let di = 0; di < selectedDayIdx; di++) {
        const prevDay = data.days[di];
        if (!prevDay) continue;
        const dayLabel = DAY_LABELS[prevDay.day] || prevDay.day;
        prevDay.tasks.forEach((t, ti) => {
          if (!t.done && taskVisibleInMode(t.text)) dailyCarryTasks.push({ dayIdx: di, dayName: dayLabel, task: t, taskIdx: ti });
        });
      }
    }

    return (
      <div key={`day-${selectedDayIdx}`} className={`flex flex-col md:flex-row max-w-5xl mx-auto ${slideClass}`} ref={splitterContainer}
        onTouchStart={onDayTouchStart} onTouchEnd={onDayTouchEnd}>
      {/* Left column — Tasks */}
      <div className={`space-y-2 ${showNotesPanel ? "min-w-0 w-full md:w-[var(--tasks-w)]" : "w-full max-w-lg mx-auto"}`}
        style={showNotesPanel ? ({ "--tasks-w": `${100 - notesPanelPct}%` } as React.CSSProperties) : undefined}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (types.includes("carry-task") || types.includes("carry-group") || types.includes("bucket-task") || types.includes("daily-carry-task") || types.includes("daily-carry-day")) e.preventDefault();
        }}
        onDrop={(e) => {
          const types = e.dataTransfer.types;
          if (types.includes("carry-task") || types.includes("carry-group") || types.includes("bucket-task") || types.includes("daily-carry-task") || types.includes("daily-carry-day")) handleDrop(selectedDayIdx, day.tasks.length, e);
        }}>
        {/* Habit chips — current week only, shrink as the week goes well */}
        {weekOffset === 0 && habits.length > 0 && !ultraFocusActive && (
          <>
            <button
              onClick={() => setHabitsOpen((o) => !o)}
              className="sm:hidden flex items-center gap-1.5 text-[11px] px-1.5 py-1 rounded-lg"
              style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
            >
              🌱 Habits
              <span style={{ color: "var(--text-tertiary)" }}>
                {habits.filter((h) => (h.period === "day" ? h.today_count > 0 : h.week_count >= h.target)).length}/{habits.length} on track
              </span>
              <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>{habitsOpen ? "▾" : "▸"}</span>
            </button>
            <div className={`${habitsOpen ? "block" : "hidden"} sm:block`}>
              <HabitStrip habits={habits} onLog={logHabit} />
            </div>
          </>
        )}
        {/* Day info bar */}
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          <span className="font-medium whitespace-nowrap" style={{ color: "var(--text)" }}>
            {(day.heading || "").replace(/^#+\s*/, "") || DAY_LABELS[day.day] || day.day}
          </span>
          <span className="px-2 py-0.5 bg-gray-100 rounded text-xs font-medium">
            {selectedDayIdx >= 5 ? "weekend" : "weekday"}
          </span>
          <span className="flex-1 whitespace-nowrap">
            {filteredTasks.filter(t => !t.done).length} tasks for {DAY_LABELS[day.day] || day.day}
          </span>
          {viewMode === "day" && (
            <button
              onClick={() => {
                const opening = !showNotesPanel;
                setShowNotesPanel(opening);
                // On phones the notes stack below the tasks — take the user there
                if (opening && window.innerWidth < 768) {
                  setTimeout(() => document.getElementById("day-notes-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
                }
              }}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${showNotesPanel ? "bg-blue-100 text-blue-700" : "hover:opacity-80"}`}
              style={!showNotesPanel ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
              title={showNotesPanel ? "Hide notes panel" : "Show notes panel"}
            >
              Notes
            </button>
          )}
          {viewMode === "day" && diaryFolder && (
            <button
              onClick={() => {
                const opening = !diaryOpen;
                setDiaryOpen(opening);
                if (opening) {
                  setShowNotesPanel(true);
                  if (window.innerWidth < 768) {
                    setTimeout(() => document.getElementById("day-notes-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
                  }
                }
              }}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${diaryOpen ? "bg-purple-100 text-purple-700" : "hover:opacity-80"}`}
              style={!diaryOpen ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
              title={diaryOpen ? "Back to notes" : "Open the diary for this day"}
            >
              Diary
            </button>
          )}
        </div>

        {/* Tasks — flat view */}
        {!groupView && (() => {
          const sortedTasks = sortTasksByPriority(filteredTasks);
          return (
          <div
            className="space-y-0.5"
            onDragOver={(e) => { if (dragGroupRef.current) return; e.preventDefault(); e.stopPropagation(); setDropTarget({ day: selectedDayIdx, idx: day.tasks.length, zone: "end" }); }}
            onDrop={(e) => { e.stopPropagation(); handleDrop(selectedDayIdx, day.tasks.length, e); }}
          >
            {sortedTasks.map((task, fi) => {
              const originalIdx = day.tasks.indexOf(task);
              // Raw index of the next *displayed* row, for below-midpoint drops
              const nextIdx = fi + 1 < sortedTasks.length ? day.tasks.indexOf(sortedTasks[fi + 1]) : day.tasks.length;
              const seq = seqNumbers.get(filteredTasks.indexOf(task)) ?? "";
              return (
                <div key={`flat-${originalIdx}`} className={ufRedactRow(selectedDayIdx, originalIdx)}>
                  {renderDayTaskItem(task, selectedDayIdx, originalIdx, getDisplayText(task), String(seq), null, nextIdx)}
                  {renderSubtasks(selectedDayIdx, originalIdx, task, false)}
                </div>
              );
            })}
            {/* Bottom drop zone indicator */}
            {dropTarget?.day === selectedDayIdx && dropTarget?.idx === day.tasks.length && (
              <div className="h-0.5 bg-blue-400 rounded" />
            )}
            {!ultraFocusActive && <button
              onClick={() => setAddingAt({ dayIdx: selectedDayIdx, afterIdx: day.tasks.length })}
              className="w-full text-xs text-gray-300 hover:text-blue-400 py-1 transition-colors text-left px-2"
            >
              + Add task
            </button>}
            {addingAt?.dayIdx === selectedDayIdx && addingAt?.afterIdx === day.tasks.length && (
              <div className="py-0.5 px-2">
                <AutoFocusInput
                  onSubmit={(text) => addTask(selectedDayIdx, day.tasks.length - 1, text)}
                  onCancel={() => setAddingAt(null)}
                  className="w-full text-sm px-2 py-1.5 border border-blue-300 rounded-lg bg-white outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
            )}
          </div>
          );
        })()}

        {/* Tasks — grouped view */}
        {groupView && (
          <div
            className="space-y-1"
            onDragOver={(e) => { if (!dragGroupRef.current) { e.preventDefault(); e.stopPropagation(); } }}
            onDrop={(e) => { e.stopPropagation(); if (!dragGroupRef.current) handleDrop(selectedDayIdx, day.tasks.length, e); }}
          >
            {/* Top-of-list drop zone — drop here to place above first group */}
            <div
              onDragOver={(e) => {
                if (dragGroupRef.current) {
                  // Group drag to start position
                  e.preventDefault(); e.stopPropagation();
                  setDropGroupTarget({ day: selectedDayIdx, groupName: "__start__" });
                  return;
                }
                e.preventDefault(); e.stopPropagation();
                setDropTarget({ day: selectedDayIdx, idx: 0, zone: "gap" });
              }}
              onDrop={(e) => {
                if (dragGroupRef.current) {
                  e.stopPropagation();
                  handleGroupDropToPosition(selectedDayIdx, 'start');
                  return;
                }
                e.stopPropagation(); handleDrop(selectedDayIdx, 0, e, null);
              }}
              className={`rounded transition-all ${
                dropGroupTarget?.day === selectedDayIdx && dropGroupTarget?.groupName === "__start__"
                  ? "h-3 bg-blue-400"
                  : dropTarget?.day === selectedDayIdx && dropTarget?.idx === 0 && dropTarget?.zone === "gap"
                    ? "h-3 bg-blue-400" : dropTarget || dropGroupTarget ? "h-4" : "h-1"
              }`}
            />
            {groups.map((section, sectionIdx) => {
              const firstOrigIdx = section.items[0]?.originalIdx ?? 0;
              const sectionKey = section.name ? `${section.name}-${firstOrigIdx}` : `ungrouped-${firstOrigIdx}`;
              const isCollapsed = section.name ? collapsedGroups.has(section.name) : false;
              const doneInSection = section.items.filter((e) => e.task.done).length;
              const activeInSection = section.items.length - doneInSection;
              return (
                <div key={sectionKey}>
                  {/* Drop zone before group — insert above this group (tasks only, not groups) */}
                  {section.name && (
                    <div
                      onDragOver={(e) => {
                        if (dragGroupRef.current) {
                          // Let group drags pass through to group headers
                          return;
                        }
                        e.preventDefault(); e.stopPropagation();
                        setDropTarget({ day: selectedDayIdx, idx: firstOrigIdx, zone: "gap" });
                      }}
                      onDrop={(e) => {
                        if (dragGroupRef.current) return;
                        e.stopPropagation(); handleDrop(selectedDayIdx, firstOrigIdx, e);
                      }}
                      className={`rounded transition-all ${
                        dropTarget?.day === selectedDayIdx && dropTarget?.idx === firstOrigIdx && dropTarget?.zone === "gap"
                          ? "h-3 bg-blue-400" : dropTarget ? "h-4" : "h-1"
                      }`}
                    />
                  )}
                  {/* Group header — draggable, collapsible, also a drop target for inserting before group */}
                  {section.name ? (
                    <div
                      draggable
                      onDragStart={(e) => { e.stopPropagation(); handleGroupDragStart(selectedDayIdx, section.name); }}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => {
                        if (dragGroupRef.current) {
                          // Group drag — use group drag handler
                          handleGroupDragOver(e, selectedDayIdx, section.name);
                        } else if (dragRef.current) {
                          // Task drag — insert before this group; light the gap bar above the header
                          e.preventDefault(); e.stopPropagation();
                          setDropTarget({ day: selectedDayIdx, idx: firstOrigIdx, zone: "gap" });
                        }
                      }}
                      onDrop={(e) => {
                        if (dragGroupRef.current) {
                          e.stopPropagation();
                          handleGroupDrop(selectedDayIdx, section.name);
                        } else if (dragRef.current) {
                          e.stopPropagation();
                          handleDrop(selectedDayIdx, firstOrigIdx, e);
                        }
                      }}
                      className={`flex items-center gap-1.5 py-2 px-2 cursor-grab active:cursor-grabbing rounded group/hdr hover:bg-gray-50 border-2 transition-colors ${
                        dropGroupTarget?.day === selectedDayIdx && dropGroupTarget?.groupName === section.name
                          ? "border-blue-400 bg-blue-50" : "border-transparent"
                      } ${ufRedactGroup(section.name)}`}
                    >
                      <span className="text-gray-300 group-hover/hdr:text-gray-400 text-xs select-none" title="Drag to move group">&#x2630;</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleCollapsed(section.name); }}
                        className="text-gray-400 hover:text-gray-600 text-xs w-4 text-center"
                        title={isCollapsed ? "Expand group" : "Collapse group"}
                      >
                        {isCollapsed ? "▸" : "▾"}
                      </button>
                      <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{section.name}</span>
                      <span className="text-xs text-gray-400">
                        ({activeInSection}{doneInSection > 0 && <span className="text-green-500"> +{doneInSection}✓</span>})
                      </span>
                    </div>
                  ) : null}
                  {/* Tasks within section — hidden when collapsed */}
                  {!isCollapsed && (
                    <div className={section.name ? "ml-4 border-l-2 pl-2" : ""} style={section.name ? { borderColor: "var(--border)" } : undefined}>
                      {section.items.map((entry) => {
                        const seq = seqNumbers.get(filteredTasks.indexOf(entry.task)) || "";
                        return (
                          <div key={`wrap-day-${entry.originalIdx}`} className={ufRedactRow(selectedDayIdx, entry.originalIdx)}>
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
            {/* Bottom drop zone — after all sections */}
            <div
              onDragOver={(e) => {
                if (dragGroupRef.current) {
                  // Group drag to end position
                  e.preventDefault(); e.stopPropagation();
                  setDropGroupTarget({ day: selectedDayIdx, groupName: "__end__" });
                  return;
                }
                e.preventDefault(); e.stopPropagation();
                setDropTarget({ day: selectedDayIdx, idx: day.tasks.length, zone: "end" });
              }}
              onDrop={(e) => {
                if (dragGroupRef.current) {
                  e.stopPropagation();
                  handleGroupDropToPosition(selectedDayIdx, 'end');
                  return;
                }
                e.stopPropagation(); handleDrop(selectedDayIdx, day.tasks.length, e);
              }}
              className={`rounded transition-all ${
                dropGroupTarget?.day === selectedDayIdx && dropGroupTarget?.groupName === "__end__"
                  ? "h-3 bg-blue-400"
                  : dropTarget?.day === selectedDayIdx && dropTarget?.idx === day.tasks.length
                    ? "h-3 bg-blue-400" : dropTarget || dropGroupTarget ? "h-4" : "h-2"
              }`}
            />
            {/* Add task button */}
            {!ultraFocusActive && <button
              onClick={() => setAddingAt({ dayIdx: selectedDayIdx, afterIdx: day.tasks.length })}
              className="w-full text-xs text-gray-300 hover:text-blue-400 py-1 transition-colors text-left px-2"
            >
              + Add task
            </button>}
            {addingAt?.dayIdx === selectedDayIdx && addingAt?.afterIdx === day.tasks.length && (
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

      {/* Splitter handle */}
      {showNotesPanel && (
        <div
          onMouseDown={onSplitterDown}
          className="hidden md:block w-1.5 cursor-col-resize flex-shrink-0 group relative"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
          <div className="h-full w-px mx-auto bg-gray-200 group-hover:bg-blue-400 transition-colors" />
        </div>
      )}

      {/* Right column — Notes Panel. Sticky + viewport-fitted so its own
          scrollbar reaches the bottom without scrolling the page. */}
      {showNotesPanel && (
        <div id="day-notes-panel" className="min-w-0 md:pl-2 max-h-[calc(100vh-260px)] overflow-y-auto md:sticky top-[80px] self-start w-full md:w-[var(--notes-w)]"
          style={{ "--notes-w": `${notesPanelPct}%` } as React.CSSProperties}>
          {diaryOpen && diaryFolder ? (
            <DiaryPanel key={`diary-${weekOffset}-${selectedDayIdx}`} date={viewedDateISO(weekOffset, selectedDayIdx)} folder={diaryFolder} />
          ) : (
            <NotesPanel
              dayName={day.day}
              weekOffset={weekOffset}
              isArchive={isArchive}
              onOpenNote={(path, name) => setNoteEditor({ path, name })}
            />
          )}
        </div>
      )}
      </div>
    );
  };

  // --- Grid view renderer (5day, 7day, weekend) ---
  const renderGridView = () => {
    if (!data) return null;
    return (
      <>
        {weekOffset === 0 && habits.length > 0 && (
          <div className="mb-2">
            <HabitStrip habits={habits} onLog={logHabit} compact />
          </div>
        )}
        {/* On phones the 5/7-day grids scroll horizontally with readable columns
            instead of crushing; 2-3 columns still fit natively. */}
        <div className="overflow-x-auto"
          onTouchStart={viewMode === "3day" ? onDayTouchStart : undefined}
          onTouchEnd={viewMode === "3day" ? onDayTouchEnd : undefined}>
        <div
          key={viewMode === "3day" ? `grid-${visibleDays[0]}` : "grid"}
          className={`grid ${gridCols} gap-2 ${viewMode === "3day" ? slideClass : ""} ${viewMode === "5day" ? "min-w-[560px] sm:min-w-0" : viewMode === "7day" ? "min-w-[784px] sm:min-w-0" : ""}`}>
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
                  isToday ? "border-blue-300 bg-blue-50/30" : ""
                }`}
                style={!isToday ? { borderColor: "var(--card-border)", backgroundColor: "var(--bg-secondary)" } : undefined}
                onDragOver={(e) => handleDayDragOver(e, dayIdx)}
                onDrop={(e) => handleDrop(dayIdx, day.tasks.length, e)}
                onDoubleClick={() => setAddingAt({ dayIdx, afterIdx: day.tasks.length - 1 })}
              >
                {/* Day header */}
                <div className="flex items-center justify-between mb-2 pb-1 border-b" style={{ borderColor: "var(--border)" }}>
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
                {!groupView ? (() => {
                  const sortedTasks = sortTasksByPriority(filteredTasks);
                  return (
                  <div className="space-y-0.5">
                    {sortedTasks.length > 0 ? (
                      sortedTasks.map((task, fi) => {
                        const originalIdx = day.tasks.indexOf(task);
                        // Raw index of the next *displayed* row, for below-midpoint drops
                        const nextIdx = fi + 1 < sortedTasks.length ? day.tasks.indexOf(sortedTasks[fi + 1]) : day.tasks.length;
                        const seq = seqNumbers.get(filteredTasks.indexOf(task)) ?? "";
                        return (
                          <div key={`wrap-${originalIdx}`}>
                            {renderCompactTaskItem(task, dayIdx, originalIdx, getDisplayText(task), null, String(seq), nextIdx)}
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
                    {sortedTasks.length === 0 && renderAddInput(dayIdx, -1)}
                  </div>
                  );
                })() : (
                  <div
                    className="space-y-0.5"
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDrop={(e) => handleDrop(dayIdx, day.tasks.length, e)}
                  >
                    {/* Top drop zone for ungrouped tasks above first group */}
                    <div
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget({ day: dayIdx, idx: 0, zone: "gap" }); }}
                      onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, 0, e, null); }}
                      className={`h-0.5 rounded transition-colors ${
                        dropTarget?.day === dayIdx && dropTarget?.idx === 0 && dropTarget?.zone === "gap" ? "bg-blue-400" : "bg-transparent"
                      }`}
                    />
                    {buildDayGroups(day.tasks).map((section) => {
                      const firstOrigIdx = section.items[0]?.originalIdx ?? 0;
                      const sectionKey = section.name ? `${section.name}-${firstOrigIdx}` : `ungrouped-${firstOrigIdx}`;
                      const isCollapsed = section.name ? collapsedGroups.has(section.name) : false;
                      const doneInSection = section.items.filter((e) => e.task.done).length;
                      const activeInSection = section.items.length - doneInSection;
                      return (
                        <div key={sectionKey}>
                          {/* Drop zone before group — insert above this group */}
                          {section.name && (
                            <div
                              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget({ day: dayIdx, idx: firstOrigIdx, zone: "gap" }); }}
                              onDrop={(e) => { e.stopPropagation(); handleDrop(dayIdx, firstOrigIdx, e); }}
                              className={`rounded transition-all ${
                                dropTarget?.day === dayIdx && dropTarget?.idx === firstOrigIdx && dropTarget?.zone === "gap" ? "h-1.5 bg-blue-400" : dropTarget ? "h-2" : "h-0.5"
                              }`}
                            />
                          )}
                          {/* Group header — draggable, collapsible, also a drop target */}
                          {section.name ? (
                            <div
                              draggable
                              onDragStart={(e) => { e.stopPropagation(); handleGroupDragStart(dayIdx, section.name); }}
                              onDragEnd={handleDragEnd}
                              onDragOver={(e) => {
                                if (dragRef.current && !dragGroupRef.current) {
                                  e.preventDefault(); e.stopPropagation();
                                  setDropTarget({ day: dayIdx, idx: firstOrigIdx, zone: "gap" });
                                }
                              }}
                              onDrop={(e) => {
                                if (dragRef.current) {
                                  e.stopPropagation();
                                  handleDrop(dayIdx, firstOrigIdx, e);
                                }
                              }}
                              className="text-[10px] font-bold text-gray-500 px-1 mb-0.5 cursor-grab active:cursor-grabbing flex items-center gap-0.5 group/hdr hover:bg-white/60 rounded border-t-2 border-transparent"
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
                {/* Bottom + Add task button — available in all grid views */}
                <button
                  onClick={(e) => { e.stopPropagation(); setAddingAt({ dayIdx, afterIdx: day.tasks.length }); }}
                  className="w-full text-[10px] text-gray-300 hover:text-blue-400 py-1 mt-1 transition-colors text-left px-1"
                >
                  + Add task
                </button>
                {renderAddInput(dayIdx, day.tasks.length)}
              </div>
            );
          })}
        </div>
        </div>

        <p className="text-[10px] text-gray-300 text-center">
          Double-click a task to add after it &middot; Click &#x25CB; to complete/uncomplete &middot; Click day name for day view{groupView && " \u00b7 Drag group headers to reorder"}
        </p>
      </>
    );
  };

  return (
    <div>

    {/* Error + filters: always full width. NOTE: the pinned toolbar is
        position:sticky — it must stay a direct child of the component root,
        or its containing block shrinks to the toolbar and pinning is a no-op. */}
      {error && (
        <div className="p-3 mb-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {data && (
          <div className={`relative ${pinFilters ? "sticky top-0 z-30 pb-2 -mx-2 px-2 sm:-mx-4 sm:px-4 border-b" : ""}`} style={pinFilters ? { backgroundColor: "var(--bg)", borderColor: "var(--border)" } : undefined}>
          {isArchive && (
            <div className="px-3 py-1.5 bg-amber-50 text-amber-700 rounded-lg text-xs font-medium text-center">
              📁 Archive — read only
            </div>
          )}
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigateWeek(-1)}
                disabled={loading}
                className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-30 transition-colors"
                title="Previous week"
              >
                «
              </button>
              <span className="font-medium whitespace-nowrap" style={{ color: "var(--text)" }}>
                {(() => {
                  const m = data.week_label.match(/wk(\d+)/i);
                  if (m) return `Week ${m[1]}`;
                  if (!data.week_label) {
                    // ISO week number from current date + offset
                    const d = new Date();
                    d.setDate(d.getDate() + weekOffset * 7);
                    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
                    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
                    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
                    const wk = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
                    return `Week ${wk}`;
                  }
                  return data.week_label;
                })()}
              </span>
              {!isOnToday && (
                <button
                  onClick={goToToday}
                  className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                  title="Go to today"
                >
                  Today
                </button>
              )}
              <button
                onClick={() => navigateWeek(1)}
                disabled={loading || weekOffset >= 1}
                className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-30 transition-colors"
                title="Next week"
              >
                »
              </button>
            </div>
            <div className="flex gap-1 items-center flex-wrap justify-end">
              {/* Context filter — toggleable chips, combine freely; only when contexts are configured.
                  Core three always show; custom contexts only when present in this week or selected. */}
              {ctxEnabled && (
                <Cluster kind="tag" label="Tag" open={openCluster === "tag"} onToggle={() => toggleCluster("tag")}
                  summary={ctxSel.length ? ctxSel.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join("+") : "All"}>
                  {allContextNames(ctxMap, ctxTags).filter((name) => {
                    if (["work", "volunteer", "personal"].includes(name)) return true;
                    if (ctxSel.includes(name)) return true;
                    return (data?.days || []).some((d) => d.tasks.some((t) => resolveContext(t.text, ctxMap, ctxTags) === name));
                  }).map((name) => {
                    const active = ctxSel.includes(name);
                    return (
                      <button
                        key={name}
                        onClick={() => toggleCtx(name)}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${active ? ctxChipClass(name) : "hover:opacity-80"}`}
                        style={!active ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
                        title={`${active ? "Hide" : "Show"} ${name} tasks${name === "work" ? " (Work also surfaces pinned exceptions)" : ""} — combine chips freely`}
                      >
                        {name.charAt(0).toUpperCase() + name.slice(1)}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setCtxSel([])}
                    className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${ctxSel.length === 0 ? "bg-gray-200 text-gray-700" : "hover:opacity-80"}`}
                    style={ctxSel.length !== 0 ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
                    title="Show every context"
                  >
                    All
                  </button>
                </Cluster>
              )}
              {/* Filter cluster: grouping, group dropdown, done visibility */}
              <Cluster kind="filter" label="Filter" open={openCluster === "filter"} onToggle={() => toggleCluster("filter")}
                summary={filterGroup || (groupView ? "Grouped" : "Flat")}>
              <button
                onClick={() => setGroupView(!groupView)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  groupView ? "bg-blue-100 text-blue-700" : "hover:opacity-80"
                }`}
                style={!groupView ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
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
                    showCompleted ? "bg-green-100 text-green-700" : "hover:opacity-80"
                  }`}
                  style={!showCompleted ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
                >
                  {showCompleted ? `Hide ${completedCount} done` : `Show ${completedCount} done`}
                </button>
              )}

              </Cluster>

              {/* View cluster — layout modes */}
              <Cluster kind="view" label="View" open={openCluster === "view"} onToggle={() => toggleCluster("view")}
                summary={viewMode === "day" ? "Day" : viewMode === "3day" ? "3 Day" : viewMode === "5day" ? "Mon-Fri" : viewMode === "7day" ? "Full week" : "Weekend"}>
              <button
                onClick={() => setViewMode("day")}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  viewMode === "day" ? "bg-blue-100 text-blue-700" : "hover:opacity-80"
                }`}
                style={viewMode !== "day" ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
              >
                Day
              </button>
              {(["3day", "5day", "7day", "weekend"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    viewMode === mode ? "bg-blue-100 text-blue-700" : "hover:opacity-80"
                  } ${mode === "7day" || mode === "weekend" ? "hidden sm:inline-block" : ""}`}
                  style={viewMode !== mode ? { backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" } : undefined}
                >
                  {mode === "3day" ? "3 Day" : mode === "5day" ? "Mon-Fri" : mode === "7day" ? "Full week" : "Weekend"}
                </button>
              ))}
              </Cluster>
              {/* Pin/unpin toggle */}
              <button
                onClick={() => setPinFilters(!pinFilters)}
                className={`ml-0.5 w-5 h-5 flex items-center justify-center rounded text-[11px] transition-colors ${
                  pinFilters ? "text-blue-400 hover:text-blue-600" : "text-gray-400 hover:text-gray-600"
                }`}
                title={pinFilters ? "Unpin toolbar" : "Pin toolbar"}
              >
                {pinFilters ? "✦" : "✧"}
              </button>
            </div>
          </div>

          {/* Day navigation bar — shown in Day and 3-Day views */}
          {(viewMode === "day" || viewMode === "3day") && (
            <div className="flex items-center gap-2 max-w-lg mx-auto">
              <button
                onClick={() => navigateDay(-1)}
                disabled={loading || (viewMode === "3day" && selectedDayIdx <= 0)}
                className="px-1 sm:px-2 py-1 text-gray-400 hover:text-gray-700 text-lg font-medium transition-colors disabled:opacity-20"
                title="Previous day"
              >
                ‹
              </button>
              <div className="flex gap-1 flex-1 justify-center">
                {data.days.map((d, i) => {
                  const isSelected = i === selectedDayIdx;
                  const isVisible = viewMode === "3day" && visibleDays.includes(i);
                  const isToday = i === todayIdx;
                  const shortName = DAY_SHORT[i];
                  return (
                    <button
                      key={d.day}
                      onClick={() => goToDay(i)}
                      onDragOver={(e) => {
                        // Day buttons accept carry/bucket drops — carry to THAT day,
                        // regardless of which day is being viewed
                        const types = e.dataTransfer.types;
                        if (types.includes("carry-task") || types.includes("carry-group") || types.includes("bucket-task") || types.includes("daily-carry-task") || types.includes("daily-carry-day")) {
                          e.preventDefault();
                          e.stopPropagation();
                          setDayNavDropTarget(i);
                        }
                      }}
                      onDragLeave={() => setDayNavDropTarget((prev) => (prev === i ? null : prev))}
                      onDrop={(e) => {
                        setDayNavDropTarget(null);
                        e.stopPropagation();
                        if (e.dataTransfer.types.includes("carry-task")) {
                          try { const { carryIdx } = JSON.parse(e.dataTransfer.getData("carry-task")); pullFromCarry(carryIdx, i); return; } catch { /* ignore */ }
                        }
                        if (e.dataTransfer.types.includes("carry-group")) {
                          try { const { groupName } = JSON.parse(e.dataTransfer.getData("carry-group")); pullCarryGroup(groupName, i); return; } catch { /* ignore */ }
                        }
                        if (e.dataTransfer.types.includes("bucket-task")) {
                          try { const { bucketIdx } = JSON.parse(e.dataTransfer.getData("bucket-task")); pullFromBucket(bucketIdx, i); return; } catch { /* ignore */ }
                        }
                        if (e.dataTransfer.types.includes("daily-carry-task")) {
                          try { const { dayIdx: fromDay, taskIdx: fromTask } = JSON.parse(e.dataTransfer.getData("daily-carry-task")); moveTaskToDay(fromDay, fromTask, i); return; } catch { /* ignore */ }
                        }
                        if (e.dataTransfer.types.includes("daily-carry-day")) {
                          try { const { dayIdx: fromDay } = JSON.parse(e.dataTransfer.getData("daily-carry-day")); moveOpenTasksToDay(fromDay, i); return; } catch { /* ignore */ }
                        }
                      }}
                      className={`flex flex-col items-center px-1 sm:px-2 py-1 rounded text-xs font-medium transition-colors min-w-[34px] sm:min-w-[40px] ${
                        dayNavDropTarget === i ? "ring-2 ring-purple-400 " : ""
                      }${
                        isSelected
                          ? "bg-blue-600 text-white"
                          : isVisible
                            ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                            : isToday
                              ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                              : "hover:opacity-80"
                      }`}
                      style={!(isSelected || isVisible || isToday) ? { color: "var(--text-secondary)" } : undefined}
                    >
                      <span>{shortName}</span>
                      <span className={`text-[10px] ${
                        isSelected ? "text-blue-100"
                          : isVisible ? "text-blue-400"
                          : d.tasks.filter(t => !t.done && taskVisibleInMode(t.text)).length > 0 ? "text-gray-500" : "text-gray-300"
                      }`}>
                        {d.tasks.filter(t => !t.done && taskVisibleInMode(t.text)).length}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => navigateDay(1)}
                disabled={loading || (viewMode === "3day" && selectedDayIdx >= 6)}
                className="px-1 sm:px-2 py-1 text-gray-400 hover:text-gray-700 text-lg font-medium transition-colors disabled:opacity-20"
                title="Next day"
              >
                ›
              </button>
            </div>
          )}
          </div>
      )}

    {/* Tasks + side panels: flex layout */}
    <div className={`flex gap-0 items-start ${
      bucketOpen || carryForwardOpen || dailyCarryOpen || vaultBrowserOpen
        ? (sheetPeek ? "pb-16 md:pb-0" : "pb-[48vh] md:pb-0") : ""
    }`}>
    <div className={`space-y-3 pb-12 ${bucketOpen || carryForwardOpen || dailyCarryOpen || vaultBrowserOpen ? "flex-1 min-w-0" : "w-full"}`}>

      {data && (
        <>
          {/* Goals Banner */}
          {!isArchive && (
            <div className="rounded-lg border transition-all" style={{ backgroundColor: "var(--amber-bg)", borderColor: "var(--amber-border)" }}>
              {/* Header row — always visible */}
              <button
                onClick={() => setGoalsExpanded(!goalsExpanded)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
              >
                <span className="text-sm">🎯</span>
                <span className="text-xs font-semibold" style={{ color: "var(--amber-text)" }}>Goals</span>
                {hasGoals && !goalsExpanded && (
                  <span className="text-xs truncate flex-1 opacity-70" style={{ color: "var(--amber-text)" }}>
                    — {goalsAsList.slice(0, 3).join(" · ")}{goalsAsList.length > 3 ? " …" : ""}
                  </span>
                )}
                {!hasGoals && !goalsExpanded && (
                  <span className="text-xs italic flex-1 opacity-60" style={{ color: "var(--amber-text)" }}>No goals set for this week</span>
                )}
                {hasGoals && (
                  <span className="text-[10px] px-1.5 rounded-full opacity-80" style={{ color: "var(--amber-text)", backgroundColor: "var(--amber-border)" }}>{goalsAsList.length}</span>
                )}
                <span className="text-[10px] opacity-60" style={{ color: "var(--amber-text)" }}>{goalsExpanded ? "▾" : "▸"}</span>
              </button>

              {/* Expanded content */}
              {goalsExpanded && (
                <div className="px-3 pb-2 space-y-1.5">
                  {goalsEditing ? (
                    /* Editing mode — textarea */
                    <div className="space-y-1.5">
                      <textarea
                        autoFocus
                        value={goalsDraft}
                        onChange={(e) => setGoalsDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { setGoalsEditing(false); }
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { saveGoals(goalsDraft); }
                        }}
                        placeholder="One goal per line..."
                        className="w-full text-xs rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-1 min-h-[60px]"
                        style={{ color: "var(--text)", backgroundColor: "var(--bg-secondary)", borderColor: "var(--amber-border)" }}
                        rows={Math.max(3, goalsDraft.split("\n").length + 1)}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => saveGoals(goalsDraft)}
                          disabled={goalsSaving}
                          className="px-2 py-0.5 rounded text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                        >
                          {goalsSaving ? "Saving…" : "Save"}
                        </button>
                        <button
                          onClick={() => setGoalsEditing(false)}
                          className="px-2 py-0.5 rounded text-xs font-medium transition-colors hover:opacity-80"
                          style={{ color: "var(--amber-text)" }}
                        >
                          Cancel
                        </button>
                        <span className="text-[10px] ml-auto opacity-60" style={{ color: "var(--amber-text)" }}>⌘+Enter to save</span>
                      </div>
                    </div>
                  ) : hasGoals ? (
                    /* Display mode — bullet list */
                    <div className="space-y-0.5">
                      {goalsAsList.map((g, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-xs" style={{ color: "var(--amber-text)", opacity: 0.85 }}>
                          <span className="mt-0.5 text-[8px] opacity-60">●</span>
                          <span>{g}</span>
                        </div>
                      ))}
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditingGoals(); }}
                        className="text-[10px] mt-1 transition-colors hover:opacity-100 opacity-60"
                        style={{ color: "var(--amber-text)" }}
                      >
                        Edit goals
                      </button>
                    </div>
                  ) : (
                    /* Empty state */
                    <div className="flex items-center gap-2 py-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditingGoals(); }}
                        className="px-2 py-0.5 rounded text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                      >
                        Set goals
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); carryOverGoals(); }}
                        className="px-2 py-0.5 rounded text-xs font-medium transition-colors hover:opacity-80"
                        style={{ color: "var(--amber-text)", borderColor: "var(--amber-border)", border: "1px solid" }}
                      >
                        Carry over from last week
                      </button>
                    </div>
                  )}
                  {goalsSaved && (
                    <span className="text-[10px] text-green-600 font-medium">✓ Saved</span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Render the appropriate view */}
          {viewMode === "day" ? renderDayView() : renderGridView()}
        </>
      )}

      {!data && !loading && (
        <div className="py-12 text-center text-gray-400">
          <p className="text-sm">Loading week plan...</p>
        </div>
      )}

      {/* Pomodoro start prompt */}
      {pomodoroPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setPomodoroPrompt(null)}>
          <div className="rounded-xl shadow-xl p-5 space-y-3 max-w-xs" style={{ backgroundColor: "var(--card)" }} onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <span className="text-3xl">🍅</span>
              <p className="text-sm font-semibold text-gray-800 mt-1">Start Pomodoro?</p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">{pomodoroPrompt.taskText}</p>
            </div>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => startPomodoro(pomodoroPrompt.dayIdx, pomodoroPrompt.taskIdx, pomodoroPrompt.taskText, 15)}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 transition-colors"
              >
                15 min
              </button>
              <button
                onClick={() => startPomodoro(pomodoroPrompt.dayIdx, pomodoroPrompt.taskIdx, pomodoroPrompt.taskText, 30)}
                className="px-4 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors"
              >
                30 min
              </button>
            </div>
            <button
              onClick={() => setPomodoroPrompt(null)}
              className="w-full text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Skip — just focus
            </button>
          </div>
        </div>
      )}

      {/* Carry Forward Dialog - removed, now a side panel */}

      {/* Floating pomodoro timer */}
      {pomodoro && (
        <div
          className="fixed z-40 rounded-2xl shadow-2xl border p-4 w-56"
          style={{
            backgroundColor: "var(--card)",
            borderColor: "var(--card-border)",
            left: pomodoroPos ? `${pomodoroPos.x}px` : "24px",
            top: pomodoroPos ? `${pomodoroPos.y}px` : "50%",
            transform: pomodoroPos ? "none" : "translateY(-50%)",
          }}
        >
          {/* Drag handle */}
          <div
            className="flex justify-center mb-1 cursor-move select-none"
            title="Drag to move"
            onMouseDown={(e) => {
              e.preventDefault();
              const el = e.currentTarget.parentElement!;
              const rect = el.getBoundingClientRect();
              pomodoroDragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
              const onMove = (ev: MouseEvent) => {
                if (!pomodoroDragRef.current) return;
                const dx = ev.clientX - pomodoroDragRef.current.startX;
                const dy = ev.clientY - pomodoroDragRef.current.startY;
                setPomodoroPos({
                  x: Math.max(0, Math.min(window.innerWidth - 224, pomodoroDragRef.current.origX + dx)),
                  y: Math.max(0, Math.min(window.innerHeight - 100, pomodoroDragRef.current.origY + dy)),
                });
              };
              const onUp = () => { pomodoroDragRef.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          >
            <span className="text-gray-300 text-xs tracking-widest">⋯⋯⋯</span>
          </div>
          {/* Tomato with timer */}
          <div className="flex flex-col items-center gap-1">
            <div className={`text-5xl select-none ${pomodoro.state === "running" ? "animate-spin-slow" : pomodoro.state === "breakRunning" ? "" : ""}`}
              style={pomodoro.state === "running" ? { animation: "spin 8s linear infinite" } : undefined}
            >
              {pomodoro.state === "breakRunning" ? "☕" : pomodoro.state === "break" || pomodoro.state === "done" ? "✅" : "🍅"}
            </div>
            <div className={`text-2xl font-mono font-bold tabular-nums ${
              pomodoro.state === "grace" ? "text-amber-600" :
              pomodoro.state === "breakRunning" ? "text-green-600" :
              pomodoro.state === "break" || pomodoro.state === "done" ? "text-green-600" :
              pomodoro.remaining < 60 ? "text-red-600" : "text-gray-800"
            }`}>
              {pomodoro.state === "grace"
                ? formatTime(pomodoro.graceRemaining)
                : formatTime(pomodoro.remaining)}
            </div>
            {pomodoro.state === "grace" && (
              <span className="text-[10px] text-amber-600 font-medium">Grace pause</span>
            )}
          </div>

          {/* Task name */}
          <p className="text-xs text-gray-600 text-center mt-1 truncate" title={pomodoro.taskText}>
            🎺 {pomodoro.taskText}
          </p>

          {/* Ultra focus — redact every other task until this pomodoro ends */}
          <button
            onClick={() => setUltraFocus((v) => !v)}
            className={`w-full mt-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              ultraFocus ? "bg-gray-800 text-white hover:bg-gray-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
            title={ultraFocus ? "Lift the curtain" : "Cover every other task until this pomodoro ends"}
          >
            {ultraFocus ? "🕶 Ultra focus on" : "🕶 Ultra focus"}
          </button>

          {/* Controls */}
          <div className="flex flex-col gap-1.5 mt-3">
            {/* Running state: grace + stop */}
            {pomodoro.state === "running" && (
              <>
                {canGrace && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => startGrace(5)}
                      className="flex-1 py-1.5 bg-amber-100 text-amber-700 rounded-lg text-xs font-medium hover:bg-amber-200 transition-colors"
                    >
                      Grace 5m
                    </button>
                    <button
                      onClick={() => startGrace(10)}
                      className="flex-1 py-1.5 bg-amber-100 text-amber-700 rounded-lg text-xs font-medium hover:bg-amber-200 transition-colors"
                    >
                      Grace 10m
                    </button>
                  </div>
                )}
                <button
                  onClick={stopPomodoro}
                  className="w-full py-1.5 text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  Stop
                </button>
              </>
            )}

            {/* Grace state: just show waiting */}
            {pomodoro.state === "grace" && (
              <p className="text-[10px] text-amber-500 text-center">Resuming after grace...</p>
            )}

            {/* Break suggestion */}
            {pomodoro.state === "break" && (
              <>
                <p className="text-xs text-green-700 font-medium text-center">Time's up! Well done.</p>
                <button
                  onClick={startBreak}
                  className="w-full py-1.5 bg-green-100 text-green-700 rounded-lg text-xs font-medium hover:bg-green-200 transition-colors"
                >
                  ☕ Take 5 min break
                </button>
                <button
                  onClick={restartPomodoro}
                  className="w-full py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-medium hover:bg-red-200 transition-colors"
                >
                  🍅 Start another
                </button>
                <button
                  onClick={stopPomodoro}
                  className="w-full py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Finish
                </button>
              </>
            )}

            {/* Break running */}
            {pomodoro.state === "breakRunning" && (
              <p className="text-[10px] text-green-600 text-center">Enjoy your break...</p>
            )}

            {/* Done (after break) */}
            {pomodoro.state === "done" && (
              <>
                <p className="text-xs text-green-700 font-medium text-center">Break over! Ready?</p>
                <button
                  onClick={restartPomodoro}
                  className="w-full py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-medium hover:bg-red-200 transition-colors"
                >
                  🍅 Start another
                </button>
                <button
                  onClick={stopPomodoro}
                  className="w-full py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Finish
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* CSS for slow spin animation */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>

    {/* Bucket & Carry icons — above status bar, togglable */}
    {data && showBottomBar && (
      <div className={`fixed bottom-8 z-40 flex items-end gap-2 right-6 ${
        vaultBrowserOpen ? "md:right-[max(21.5rem,calc(50vw-14.5rem))]"
          : (bucketOpen || carryForwardOpen || dailyCarryOpen) ? "md:right-[max(19.5rem,calc(50vw-16.5rem))]" : ""
      }`}>
        {/* Vault browser */}
        <div
          className={`relative cursor-pointer transition-all duration-200 hover:scale-105`}
          title="Vault Browser"
          onClick={() => {
            const opening = !vaultBrowserOpen;
            setVaultBrowserOpen(opening);
            if (opening) { setBucketOpen(false); setCarryForwardOpen(false); setDailyCarryOpen(false); }
          }}
        >
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg shadow-md border-2 transition-colors ${
            vaultBrowserOpen ? "bg-blue-200 border-blue-500" : "bg-white border-gray-200 hover:border-blue-300"
          }`}>{"\uD83D\uDCC1"}</div>
        </div>

        {/* Daily carry — open tasks from days before the planned day */}
        {weekOffset >= 0 && (
          <div
            className={`relative cursor-pointer transition-all duration-200 hover:scale-105`}
            title={dailyCarryCount > 0 ? `${dailyCarryCount} open tasks from earlier days` : "Carry forward — pull open tasks into the day you're planning"}
            onClick={() => {
              const opening = !dailyCarryOpen;
              setDailyCarryOpen(opening);
              if (opening) { setBucketOpen(false); setCarryForwardOpen(false); setVaultBrowserOpen(false); }
            }}
          >
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg shadow-md border-2 transition-colors ${
              dailyCarryOpen ? "bg-purple-200 border-purple-500" : "bg-white border-gray-200 hover:border-purple-300"
            }`}>⏩</div>
            <span className={`absolute -top-1 -right-1 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center ${dailyCarryCount > 0 ? "bg-purple-500" : "bg-gray-300"}`}>
              {dailyCarryCount > 99 ? "99+" : dailyCarryCount}
            </span>
          </div>
        )}

        {/* Weekly carry forward — only on current week, only when today or a later day is visible */}
        {/* Available anywhere in the current week — in day view the visible day
            is often a past day being reviewed, and carrying must still work. */}
        {weekOffset === 0 && carryTasks.filter((t) => taskVisibleInMode(t.text)).length > 0 && (
          <div
            className={`relative cursor-pointer transition-all duration-200 ${carryHighlight ? "scale-110" : "hover:scale-105"}`}
            title={`⏩ Carry Forward (${carryTasks.filter((t) => taskVisibleInMode(t.text)).length} tasks)`}
            onClick={() => {
              if (carryForwardOpen) { setCarryForwardOpen(false); }
              else { setBucketOpen(false); setCarryForwardOpen(true); setDailyCarryOpen(false); setVaultBrowserOpen(false); }
            }}
          >
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg shadow-md border-2 transition-colors ${
              carryForwardOpen ? "bg-purple-200 border-purple-500" : carryHighlight ? "bg-purple-100 border-purple-400" : "bg-white border-gray-200 hover:border-purple-300"
            }`}>⏩</div>
            <span className="absolute -top-1 -right-1 bg-purple-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
              {(() => { const n = carryTasks.filter((t) => taskVisibleInMode(t.text)).length; return n > 99 ? "99+" : n; })()}
            </span>
          </div>
        )}

        {/* Bucket */}
        {!isArchive && (
          <div
            className={`relative cursor-pointer transition-all duration-200 ${bucketHighlight ? "scale-110" : "hover:scale-105"}`}
            title={`🪣 Bucket (${bucketCount})`}
            onClick={() => { const opening = !bucketOpen; setBucketOpen(opening); if (opening) { refreshBucket(); setCarryForwardOpen(false); setDailyCarryOpen(false); setVaultBrowserOpen(false); } }}
            onDragOver={(e) => {
              if (dragRef.current || dragGroupRef.current || carryDragRef.current || carryGroupDragRef.current || e.dataTransfer.types.includes("carry-task") || e.dataTransfer.types.includes("carry-group")) {
                e.preventDefault(); setBucketHighlight(true);
              }
            }}
            onDragLeave={() => setBucketHighlight(false)}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation(); setBucketHighlight(false);
              if (e.dataTransfer.types.includes("carry-task")) {
                try { const { carryIdx } = JSON.parse(e.dataTransfer.getData("carry-task")); carrySingleToBucket(carryIdx); } catch { /* ignore */ }
                return;
              }
              if (e.dataTransfer.types.includes("carry-group")) {
                try {
                  const { groupName } = JSON.parse(e.dataTransfer.getData("carry-group"));
                  const groupTasks = carryTasks.filter((t) => parseGroup(t.text).group === groupName);
                  if (groupTasks.length > 0) {
                    (async () => {
                      const currentBucket = await api.getBucket();
                      const newTasks = [...currentBucket.tasks, ...groupTasks.map((t) => ({ text: t.text, priority: t.priority || "C", focused: t.focused, waiting: t.waiting, subtasks: t.subtasks }))];
                      await api.saveBucket(newTasks, currentBucket.pinned_groups);
                      refreshBucket(); window.dispatchEvent(new CustomEvent("bucket-changed"));
                      setCarryTasks((prev) => prev.filter((t) => parseGroup(t.text).group !== groupName));
                    })().catch(() => {});
                  }
                } catch { /* ignore */ }
                return;
              }
              if (dragGroupRef.current) {
                sendGroupToBucket(dragGroupRef.current.fromDay, dragGroupRef.current.groupName);
                dragGroupRef.current = null; dragRef.current = null;
              } else if (dragRef.current) {
                sendToBucket(dragRef.current.fromDay, dragRef.current.fromIdx);
                dragRef.current = null; dragGroupRef.current = null;
              } else {
                try { const d = JSON.parse(e.dataTransfer.getData("text/plain")); if (typeof d.dayIdx === "number" && typeof d.taskIdx === "number") sendToBucket(d.dayIdx, d.taskIdx); } catch { /* ignore */ }
              }
            }}
          >
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg shadow-md border-2 transition-colors ${
              bucketOpen ? "bg-amber-200 border-amber-500" : bucketHighlight ? "bg-amber-100 border-amber-400" : "bg-white border-gray-200 hover:border-amber-300"
            }`}>🪣</div>
            {bucketCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {bucketCount > 99 ? "99+" : bucketCount}
              </span>
            )}
          </div>
        )}
      </div>
    )}

    {/* Status bar — always at very bottom */}
    {data && (
      <div className="fixed bottom-0 left-0 right-0 z-40 backdrop-blur border-t px-4 py-1" style={{ backgroundColor: "color-mix(in srgb, var(--bg) 95%, transparent)", borderColor: "var(--border)" }}>
        {/* flex-wrap: on phones the running-timer pill drops to its own row
            instead of pushing the stop button off the right edge */}
        <div className="max-w-6xl mx-auto flex flex-wrap items-center gap-x-2 gap-y-1">
          {!isArchive && (
            <button
              onClick={() => {
                if (autoSavePaused) { saveWeek(); setAutoSavePaused(false); }
                else { setAutoSavePaused(true); }
              }}
              disabled={saving}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                saved ? "bg-green-100 text-green-700"
                  : autoSavePaused ? "bg-amber-100 text-amber-700"
                  : dirty ? "bg-blue-100 text-blue-700"
                  : ""
              }`}
              style={!(saved || autoSavePaused || dirty) ? { backgroundColor: "var(--bg-secondary)", color: "var(--text-tertiary)" } : undefined}
            >
              {saved ? "✓ Saved" : saving ? "Saving…" : autoSavePaused ? "⏸ Paused" : dirty ? "Saving…" : "Auto-save"}
            </button>
          )}
          {!isArchive && (
            <div className="flex items-center gap-0.5">
              <button onClick={performUndo} disabled={undoStack.current.length === 0}
                className="px-1 py-0.5 rounded text-xs text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-20 transition-colors"
                title={`Undo (${undoStack.current.length}) — Ctrl+Z`}>↩</button>
              <button onClick={performRedo} disabled={redoStack.current.length === 0}
                className="px-1 py-0.5 rounded text-xs text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-20 transition-colors"
                title="Redo — Ctrl+Shift+Z">↪</button>
            </div>
          )}
          <button onClick={() => fetchWeek()} disabled={loading}
            className="px-2 py-0.5 rounded text-[10px] font-medium hover:opacity-80 disabled:opacity-50 transition-colors"
            style={{ backgroundColor: "var(--bg-secondary)", color: "var(--text-tertiary)" }}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          {externalChange && (
            <div className="flex items-center gap-1.5 text-[10px] text-blue-600">
              <span>📄 File changed</span>
              <button onClick={() => fetchWeek()} className="font-semibold underline">Reload</button>
              <button onClick={() => setExternalChange(false)} className="text-blue-400">✕</button>
            </div>
          )}
          {runningTime && (() => {
            const [sh, sm] = runningTime.start.split(":").map(Number);
            const now = new Date();
            const elapsed = Math.max(0, now.getHours() * 60 + now.getMinutes() - (sh * 60 + sm));
            const shiftStart = (delta: number) => {
              const t = Math.max(0, sh * 60 + sm + delta);
              return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
            };
            return (
              <div className="relative flex items-center gap-1">
                <button
                  onClick={() => { setTimeAdjustVal(runningTime.start); setTimeAdjustText(runningTime.text); setTimeAdjustOpen(!timeAdjustOpen); }}
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 hover:bg-green-200 max-w-[9rem] sm:max-w-[16rem] truncate"
                  title={`Tracking since ${runningTime.start} — click to adjust the start time or description`}
                >
                  ⏱ {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} · {runningTime.text}
                </button>
                <button onClick={stopTracking} className="px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-600 hover:bg-red-200" title="Stop tracking">■</button>
                {timeAdjustOpen && (
                  <div className="absolute bottom-7 left-0 z-50 rounded-lg shadow-xl border p-2 flex flex-col gap-1.5"
                    style={{ backgroundColor: "var(--card)", borderColor: "var(--card-border)" }}>
                    <input value={timeAdjustText} onChange={(e) => setTimeAdjustText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") adjustTracking({ start: timeAdjustVal, text: timeAdjustText.trim() || undefined }); if (e.key === "Escape") setTimeAdjustOpen(false); }}
                      placeholder="description"
                      title="Edit what this time entry is about"
                      className="w-64 max-w-[70vw] px-1.5 py-0.5 rounded text-[10px] border" style={{ backgroundColor: "var(--bg)", color: "var(--text)", borderColor: "var(--border)" }} />
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>started</span>
                      <input value={timeAdjustVal} onChange={(e) => setTimeAdjustVal(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") adjustTracking({ start: timeAdjustVal, text: timeAdjustText.trim() || undefined }); if (e.key === "Escape") setTimeAdjustOpen(false); }}
                        className="w-14 px-1 py-0.5 rounded text-[10px] font-mono border" style={{ backgroundColor: "var(--bg)", color: "var(--text)", borderColor: "var(--border)" }} />
                      {[-5, -15, -30].map((d) => (
                        <button key={d} onClick={() => { setTimeAdjustVal(shiftStart(d)); adjustTracking({ start: shiftStart(d), text: timeAdjustText.trim() || undefined }); }}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 hover:bg-gray-200">{d}m</button>
                      ))}
                      <button onClick={() => adjustTracking({ start: timeAdjustVal, text: timeAdjustText.trim() || undefined })} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-600 text-white">Set</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          <div className="flex-1" />
          <button
            onClick={() => setShowBottomBar(!showBottomBar)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              showBottomBar ? "bg-gray-100 text-gray-400 hover:bg-gray-200" : "bg-blue-50 text-blue-500 hover:bg-blue-100"
            }`}
            title={showBottomBar ? "Hide toolbar" : "Show toolbar"}
          >
            {showBottomBar ? "🪣 ▾" : "🪣 ▴"}
          </button>
        </div>
      </div>
    )}

    {/* Bucket side panel */}
    {bucketOpen && (
      <div className={sheetClass("md:w-72")} style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
        <SheetGrip />
        <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border-strong)" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>🪣 Bucket ({bucketTasks.length})</h3>
          <button onClick={() => setBucketOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
        </div>
        <div className="px-2 pt-2">
          <input
            ref={bucketQuickAddRef}
            defaultValue=""
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = (bucketQuickAddRef.current?.value || "").trim();
              if (v) { addToBucket(v); if (bucketQuickAddRef.current) bucketQuickAddRef.current.value = ""; }
            }}
            placeholder={'Add — "Group: task"'}
            className="w-full text-xs px-2 py-1 rounded outline-none focus:ring-1 focus:ring-blue-400"
            style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
          />
        </div>
        <div className="p-2 space-y-0.5">
          {bucketTasks.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-4">Empty — drag tasks here to defer</p>
          )}
          {(() => {
            // Build grouped sections for bucket panel — coalesce by group name
            type BucketSection = { name: string; items: { task: import("../api").BucketTask; idx: number; label: string }[] };
            const byGroup = new Map<string, BucketSection>();
            bucketTasks.forEach((task, idx) => {
              if (!taskVisibleInMode(task.text)) return;
              const { group, label } = parseGroup(stripBucketMeta(stripCtxTokens(task.text)));
              let section = byGroup.get(group);
              if (!section) {
                section = { name: group, items: [] };
                byGroup.set(group, section);
              }
              section.items.push({ task, idx, label });
            });
            const sections = [...byGroup.values()];

            const toggleBucketGroup = (name: string) => {
              setBucketExpandedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name); else next.add(name);
                return next;
              });
            };

            const renderBucketItem = (task: import("../api").BucketTask, idx: number, label: string) => (
              <div
                key={idx}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("bucket-task", JSON.stringify({ bucketIdx: idx }));
                  e.dataTransfer.effectAllowed = "move";
                  bucketDragRef.current = { bucketIdx: idx };
                }}
                onDragEnd={() => { bucketDragRef.current = null; }}
                className="flex items-center gap-1.5 py-1 px-2 rounded hover:bg-white text-xs cursor-grab active:cursor-grabbing group/bt transition-colors"
              >
                <span className={`flex-1 truncate ${task.focused ? "font-bold" : ""}`} style={{ color: "var(--text)" }} title={label}>
                  {task.waiting && <span className="text-amber-500 mr-1">⏳</span>}
                  {label}
                </span>
                <button
                  onClick={() => pullFromBucket(idx, carryTargetIdx)}
                  className="text-[10px] text-purple-400 hover:text-purple-700 opacity-0 group-hover/bt:opacity-100 shrink-0 transition-opacity"
                  title={`Add to ${carryTargetLabel} (drag also works)`}
                >
                  → {carryTargetLabel}
                </button>
              </div>
            );

            return sections.map((section, si) => {
              // If only one section and ungrouped, show tasks directly (no header)
              if (!section.name && sections.length === 1) {
                return section.items.map(({ task, idx, label }) => renderBucketItem(task, idx, label));
              }
              const displayName = section.name || "Un-grouped";
              const isExpanded = bucketExpandedGroups.has(section.name);
              return (
                <div key={`bg-${si}-${displayName}`} className="mb-0.5">
                  <button
                    onClick={() => toggleBucketGroup(section.name)}
                    className="w-full flex items-center gap-1 py-1 px-2 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-white rounded transition-colors"
                  >
                    <span className="text-[10px]">{isExpanded ? "▾" : "▸"}</span>
                    <span>{displayName}</span>
                    <span className="text-[10px] text-gray-400">({section.items.length})</span>
                  </button>
                  {isExpanded && (
                    <div className="ml-3 border-l border-gray-200 pl-1">
                      {section.items.map(({ task, idx, label }) => renderBucketItem(task, idx, label))}
                      {bucketAddingGroup === section.name ? (
                        <input
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) addToBucket(v, section.name || undefined);
                              setBucketAddingGroup(null);
                            }
                            if (e.key === "Escape") setBucketAddingGroup(null);
                          }}
                          onBlur={() => setBucketAddingGroup(null)}
                          placeholder={`Add to ${displayName}...`}
                          className="w-full text-xs px-2 py-1 my-0.5 rounded outline-none focus:ring-1 focus:ring-blue-400"
                          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }}
                        />
                      ) : (
                        <button
                          onClick={() => setBucketAddingGroup(section.name)}
                          className="text-[10px] text-gray-400 hover:text-blue-500 py-0.5 px-2"
                        >
                          + add
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      </div>
    )}
    {/* Carry Forward side panel (right, matching bucket style) */}
    {carryForwardOpen && (
      <div className={sheetClass("md:w-72")} style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
        <SheetGrip />
        <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border-strong)" }}>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>⏩ Carry Forward ({carryTasks.filter((t) => taskVisibleInMode(t.text)).length})</h3>
            <p className="text-[10px] text-gray-500">From week {carryLabel.replace(/^\d{4}-wk0?/, "")}</p>
          </div>
          <button onClick={() => setCarryForwardOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
        </div>
        <div className="p-2 space-y-0.5">
          {carryTasks.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-4">No tasks to carry forward</p>
          )}
          {(() => {
            // Build grouped sections matching bucket style
            const sections: { name: string; items: { task: typeof carryTasks[0]; idx: number; label: string }[] }[] = [];
            carryTasks.forEach((task, idx) => {
              if (!taskVisibleInMode(task.text)) return;
              const { group, label } = parseGroup(stripCtxTokens(task.text));
              const last = sections[sections.length - 1];
              if (last && last.name === group) {
                last.items.push({ task, idx, label });
              } else {
                sections.push({ name: group, items: [{ task, idx, label }] });
              }
            });

            const toggleCarryGroup = (name: string) => {
              setCarryExpandedGroups((prev) => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name); else next.add(name);
                return next;
              });
            };

            const prioBadge = (p: string) => (
              <span className={`inline-block text-[9px] font-bold mr-1 px-1 rounded shrink-0 ${
                p === "A" ? "bg-red-100 text-red-700" : p === "B" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"
              }`}>{p}</span>
            );

            const renderCarryItem = (task: typeof carryTasks[0], idx: number, label: string) => (
              <div
                key={`carry-${idx}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("carry-task", JSON.stringify({ carryIdx: idx }));
                  e.dataTransfer.effectAllowed = "move";
                  carryDragRef.current = { carryIdx: idx };
                }}
                onDragEnd={() => { carryDragRef.current = null; }}
                className="flex items-center gap-1.5 py-1 px-2 rounded hover:bg-white text-xs cursor-grab active:cursor-grabbing group/ct transition-colors"
              >
                {prioBadge(task.priority || "C")}
                <span className={`flex-1 truncate ${task.focused ? "font-bold" : ""}`} style={{ color: "var(--text)" }} title={label}>
                  {task.waiting && <span className="text-amber-500 mr-1">⏳</span>}
                  {label}
                </span>
                <span className="text-[9px] text-gray-300 shrink-0">{task.from_day.slice(0, 3)}</span>
                <button
                  onClick={() => pullFromCarry(idx, carryTargetIdx)}
                  title={`Carry to ${carryTargetLabel}`}
                  className="shrink-0 text-purple-500 hover:text-purple-700 font-bold opacity-0 group-hover/ct:opacity-100 transition-opacity"
                >
                  →
                </button>
                <button
                  onClick={() => resolveCarryItem(idx, "done")}
                  title="It was actually done — mark completed in last week's file"
                  className="shrink-0 text-green-500 hover:text-green-700 opacity-0 group-hover/ct:opacity-100 transition-opacity"
                >
                  ✓
                </button>
                <button
                  onClick={() => resolveCarryItem(idx, "delete")}
                  title="No longer relevant — remove from last week's file"
                  className="shrink-0 text-gray-400 hover:text-red-500 opacity-0 group-hover/ct:opacity-100 transition-opacity"
                >
                  ✕
                </button>
              </div>
            );

            return sections.map((section, si) => {
              if (!section.name) {
                return section.items.map(({ task, idx, label }) => renderCarryItem(task, idx, label));
              }
              const isExpanded = carryExpandedGroups.has(section.name);
              return (
                <div key={`cg-${si}`} className="mb-0.5">
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("carry-group", JSON.stringify({ groupName: section.name }));
                      e.dataTransfer.effectAllowed = "move";
                      carryGroupDragRef.current = { groupName: section.name };
                    }}
                    onDragEnd={() => { carryGroupDragRef.current = null; }}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    <div className="flex items-center">
                      <button
                        onClick={() => toggleCarryGroup(section.name)}
                        className="flex-1 flex items-center gap-1 py-1 px-2 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-white rounded transition-colors"
                      >
                        <span className="text-[10px]">{isExpanded ? "▾" : "▸"}</span>
                        <span>{section.name}</span>
                        <span className="text-[10px] text-gray-400">({section.items.length})</span>
                      </button>
                      <button
                        onClick={() => pullCarryGroup(section.name, carryTargetIdx)}
                        title={`Carry group to ${carryTargetLabel}`}
                        className="shrink-0 px-1.5 text-xs text-purple-500 hover:text-purple-700 font-bold"
                      >
                        →
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="ml-3 border-l border-gray-200 pl-1">
                      {section.items.map(({ task, idx, label }) => renderCarryItem(task, idx, label))}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
        {/* Bottom actions — sticky so they're visible without scrolling the list */}
        {carryTasks.length > 0 && (
          <div className="p-2 border-t border-gray-200 flex flex-col gap-1.5 sticky bottom-0" style={{ backgroundColor: "var(--bg-secondary)" }}>
            <div className="flex gap-1">
              <select
                value={carryDaySel}
                onChange={(e) => setCarryDaySel(e.target.value)}
                className="flex-1 text-[10px] border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600"
              >
                <option value="monday">Monday</option>
                <option value="tuesday">Tuesday</option>
                <option value="wednesday">Wednesday</option>
                <option value="thursday">Thursday</option>
                <option value="friday">Friday</option>
                <option value="saturday">Saturday</option>
                <option value="sunday">Sunday</option>
              </select>
              <button
                onClick={() => carryAllToDay(carryDaySel)}
                disabled={carryLoading}
                className="px-2 py-1 bg-purple-600 text-white rounded text-[10px] font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {carryLoading ? "..." : `Carry all →`}
              </button>
            </div>
            <button
              onClick={carryAllToBucket}
              disabled={carryLoading}
              className="w-full px-2 py-1 bg-amber-500 text-white rounded text-[10px] font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {carryLoading ? "Moving..." : `🪣 All to Bucket`}
            </button>
          </div>
        )}
      </div>
    )}
    {/* Daily carry side panel (right, matching carry-forward style) */}
    {dailyCarryOpen && data && weekOffset >= 0 && (
      <div className={sheetClass("md:w-72")} style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
        <SheetGrip />
        <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border-strong)" }}>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>⏩ Carry Forward ({dailyCarryCount})</h3>
            <p className="text-[10px] text-gray-500">
              {carryCutoffIdx > 0
                ? `Open tasks from ${DAY_LABELS[data.days[0]?.day] || "Mon"}–${DAY_LABELS[data.days[carryCutoffIdx - 1]?.day] || ""} → ${carryTargetLabel}`
                : "Nothing earlier in this week"}
            </p>
          </div>
          <button onClick={() => setDailyCarryOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
        </div>
        <div className="p-2 space-y-0.5">
          {dailyCarryCount === 0 && (
            <div className="text-center py-4 space-y-2">
              <p className="text-xs text-gray-400">No open tasks from earlier days</p>
              <button
                onClick={() => { setDailyCarryOpen(false); openCarryForward(); }}
                className="px-2 py-1 rounded bg-purple-600 text-white text-[10px] font-medium hover:bg-purple-700 transition-colors"
              >
                ⏪ Pull from the week before →
              </button>
            </div>
          )}
          {(() => {
            // Collect open tasks from days before today, grouped by day then by group
            const items: { dayIdx: number; dayName: string; taskIdx: number; task: Task; group: string; label: string }[] = [];
            for (let di = 0; di < carryCutoffIdx; di++) {
              const prevDay = data.days[di];
              if (!prevDay) continue;
              const dayLabel = DAY_LABELS[prevDay.day] || prevDay.day;
              prevDay.tasks.forEach((t, ti) => {
                if (!t.done && taskVisibleInMode(t.text)) {
                  const { group, label } = parseGroup(stripCtxTokens(t.text));
                  items.push({ dayIdx: di, dayName: dayLabel, taskIdx: ti, task: t, group, label });
                }
              });
            }

            // Group by source day
            const byDay = new Map<number, typeof items>();
            items.forEach((it) => {
              if (!byDay.has(it.dayIdx)) byDay.set(it.dayIdx, []);
              byDay.get(it.dayIdx)!.push(it);
            });

            const prioBadge = (p: string) => (
              <span className={`inline-block text-[9px] font-bold mr-1 px-1 rounded shrink-0 ${
                p === "A" ? "bg-red-100 text-red-700" : p === "B" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"
              }`}>{p}</span>
            );

            const targetDayName = carryTargetLabel;

            return Array.from(byDay.entries()).map(([di, dayItems]) => (
              <div key={`dc-${di}`} className="mb-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("daily-carry-day", JSON.stringify({ dayIdx: di }));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  className="flex items-center gap-1 py-1 px-2 cursor-grab active:cursor-grabbing"
                >
                  <span className="text-[10px] font-medium text-purple-500">{dayItems[0].dayName}</span>
                  <span className="text-[10px] text-gray-400">({dayItems.length})</span>
                  <button
                    onClick={() => moveOpenTasksToDay(di, carryTargetIdx)}
                    className="ml-auto text-[9px] text-purple-400 hover:text-purple-700 transition-colors"
                  >
                    Move all →
                  </button>
                </div>
                {dayItems.map((it) => (
                  <div
                    key={`dc-${it.dayIdx}-${it.taskIdx}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("daily-carry-task", JSON.stringify({ dayIdx: it.dayIdx, taskIdx: it.taskIdx }));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className="flex items-center gap-1.5 py-1 px-2 rounded hover:bg-white text-xs group/dc transition-colors cursor-grab active:cursor-grabbing"
                  >
                    {prioBadge(it.task.priority || "C")}
                    <span className={`flex-1 truncate ${it.task.focused ? "font-bold" : ""}`} style={{ color: "var(--text)" }} title={it.label}>
                      {it.task.waiting && <span className="text-amber-500 mr-1">⏳</span>}
                      {it.label}
                    </span>
                    <button
                      onClick={() => resolveDayTask(it.dayIdx, it.taskIdx, "done")}
                      className="text-[11px] text-green-500 hover:text-green-700 opacity-0 group-hover/dc:opacity-100 shrink-0 transition-opacity"
                      title="It was actually done — mark completed on that day"
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => resolveDayTask(it.dayIdx, it.taskIdx, "delete")}
                      className="text-[11px] text-gray-400 hover:text-red-500 opacity-0 group-hover/dc:opacity-100 shrink-0 transition-opacity"
                      title="No longer relevant — delete"
                    >
                      ✕
                    </button>
                    <button
                      onClick={() => moveTaskToDay(it.dayIdx, it.taskIdx, carryTargetIdx)}
                      className="text-[10px] text-purple-400 hover:text-purple-700 opacity-0 group-hover/dc:opacity-100 shrink-0 transition-opacity"
                      title={`Move to ${targetDayName}`}
                    >
                      →
                    </button>
                  </div>
                ))}
              </div>
            ));
          })()}
        </div>
        {/* Bottom actions — sticky so they're visible without scrolling the list */}
        {dailyCarryCount > 0 && (
          <div className="p-2 border-t border-gray-200 flex flex-col gap-1.5 sticky bottom-0" style={{ backgroundColor: "var(--bg-secondary)" }}>
            <button
              onClick={() => { carryAllFromPreviousDays(carryCutoffIdx, carryTargetIdx); setDailyCarryOpen(false); }}
              className="w-full px-2 py-1.5 bg-purple-600 text-white rounded text-[10px] font-medium hover:bg-purple-700 transition-colors"
            >
              Move all to {carryTargetLabel} →
            </button>
            <button
              onClick={() => { earlierDaysToBucket(carryCutoffIdx); setDailyCarryOpen(false); }}
              className="w-full px-2 py-1 bg-amber-500 text-white rounded text-[10px] font-medium hover:bg-amber-600 transition-colors"
            >
              🪣 All to Bucket
            </button>
          </div>
        )}
      </div>
    )}
    {/* Vault browser side panel */}
    {vaultBrowserOpen && (
      <div className={sheetClass("md:w-80")} style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
        <SheetGrip />
        <VaultBrowser
          onClose={() => setVaultBrowserOpen(false)}
          stateRef={vaultBrowserStateRef}
          onOpenNote={(path, name) => setNoteEditor({ path, name })}
        />
      </div>
    )}
    </div>{/* end flex container for tasks + side panels */}

    {/* Task link popup */}
    {linkPopup && (
      <TaskLinkPopup
        links={linkPopup.links}
        position={linkPopup.pos}
        onClose={() => setLinkPopup(null)}
        onAddLink={(name) => {
          addLinkToTask(linkPopup.dayIdx, linkPopup.taskIdx, name);
        }}
        onOpenInApp={(path, name) => { setLinkPopup(null); setNoteEditor({ path, name }); }}
      />
    )}
    {/* Note file picker popup */}
    {notePicker && (
      <NoteFilePicker
        existingLinks={notePicker.links}
        group={notePicker.group}
        position={notePicker.pos}
        weekOffset={weekOffset}
        onSelect={(path, name) => {
          setNotePicker(null);
          setNoteEditor({ path, name });
        }}
        onAddLink={(name, path) => {
          addLinkToTask(notePicker.dayIdx, notePicker.taskIdx, name);
        }}
        onRemoveLink={(name) => {
          removeLinkFromTask(notePicker.dayIdx, notePicker.taskIdx, name);
        }}
        onClose={() => setNotePicker(null)}
      />
    )}
    {/* Note editor modal */}
    {noteEditor && (
      <NoteEditor
        initialPath={noteEditor.path}
        initialName={noteEditor.name}
        onClose={() => setNoteEditor(null)}
      />
    )}
    </div>
  );
}
