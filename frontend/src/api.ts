// API base: dev talks to the local uvicorn; the Tauri app talks to its
// bundled sidecar; a production build served by the backend itself uses
// relative URLs, so it works from any host (LAN, Tailscale, phone).
// VITE_API_URL overrides everything (e.g. the staging setup).
const BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:8000" : __API_BASE__);

// Offline awareness: the service worker marks cache-fallback responses
// with X-Nowspace-Offline (when that data was fetched). State changes are
// broadcast as window events for the app-level banner.
let offlineNow = false;
function setOffline(state: boolean, at?: string | null) {
  if (state === offlineNow) return;
  offlineNow = state;
  window.dispatchEvent(new CustomEvent(state ? "nowspace-offline" : "nowspace-online", { detail: { at: at || null } }));
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (e) {
    setOffline(true, null);
    const method = (options?.method || "GET").toUpperCase();
    if (method !== "GET") throw new Error("Offline — this change can't be saved right now");
    throw e instanceof Error ? e : new Error("Network unavailable");
  }
  const cachedAt = res.headers.get("X-Nowspace-Offline");
  if (cachedAt !== null) setOffline(true, cachedAt);
  else setOffline(false);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

export interface Subtask {
  text: string;
  done: boolean;
}

export interface TaskLink {
  name: string;
  display_text?: string;
  resolved_path?: string;
}

export interface Task {
  text: string;
  done: boolean;
  source_file: string;
  context: string;
  tags: string[];
  priority: string;
  pillars: string[];
  subtasks: Subtask[];
  focused: boolean;
  waiting: boolean;
  links: TaskLink[];
  clean_text: string;
}

export interface PlanResponse {
  session_id: string;
  date: string;
  day_type: string;
  tasks: Task[];
  completed: Task[];
  carryover: Task[];
  summary: string;
}

export interface CoachResponse {
  session_id: string;
  message: string;
  session_complete: boolean;
}

export interface PillarBalance {
  name: string;
  score: number;
}

export interface MemoryResponse {
  pillars: string[];
  pillar_balance: PillarBalance[];
  patterns: string[];
  goals: string[];
  weekly_log: string;
}

export interface GoalsResponse {
  goals: string[];
}

export interface DayTasks {
  day: string;
  heading: string;
  tasks: Task[];
}

export interface WeekPlanResponse {
  week_label: string;
  goals: string[];
  days: DayTasks[];
  is_future: boolean;
  offset: number;
  is_archive: boolean;
}

export interface BucketTask {
  text: string;
  priority: string;
  horizon?: string; // "" | "n" this week | "nw" next week | "m" next month
  focused: boolean;
  waiting: boolean;
  subtasks: Subtask[];
}

export interface BucketResponse {
  tasks: BucketTask[];
  pinned_groups: string[];
  mtime?: number | null;
}

export interface Habit {
  name: string;
  domain: string; // body | mind | soul | sleep | custom
  variants: string[];
  target: number;
  period: "week" | "day";
  morning: boolean;
  duration: number; // minutes per occurrence; 0 = untimed
  week_count: number;
  days_done: number;
  today_count: number;
  history: boolean[]; // oldest→newest, week-target met
  established: boolean;
}

export interface TimeEntry {
  date: string;   // YYYY-MM-DD
  start: string;  // HH:MM
  end: string | null; // null = running
  text: string;
  minutes: number;
}

export interface DayNotesResponse {
  day?: string;
  content?: string;
  groups?: Record<string, string[]>;
  ungrouped?: string[];
  wiki_links?: string[];
  days?: Record<string, { day: string; content: string; groups: Record<string, string[]>; ungrouped: string[]; wiki_links: string[] }>;
  general?: string;
}

export const api = {
  health: () => request<{ status: string }>("/health"),
  updateCheck: () => request<{ version: string | null }>("/update-check"),
  saveDiaryFolder: (folder: string) =>
    request<{ status: string; diary_folder: string }>("/api/settings/diary-folder", {
      method: "POST",
      body: JSON.stringify({ folder }),
    }),

  getPlan: (targetDate?: string) =>
    request<PlanResponse>(targetDate ? `/plan?target_date=${targetDate}` : "/plan"),

  getGoals: () => request<GoalsResponse>("/plan/goals"),

  saveGoals: (goals: string[], offset: number = 0) =>
    request<{ status: string; count: number }>("/plan/goals", {
      method: "PUT",
      body: JSON.stringify({ goals, offset }),
    }),

  getPreviousWeekGoals: (currentOffset: number = 0) =>
    request<WeekPlanResponse>(`/plan/week?offset=${currentOffset - 1}`).then(r => r.goals).catch(() => [] as string[]),

  startSession: () =>
    request<{ session_id: string; task_count: number }>("/plan/start-session", {
      method: "POST",
    }),

  approvePlan: (session_id: string, tasks?: Task[]) =>
    request("/plan/approve", {
      method: "POST",
      body: JSON.stringify({ session_id, tasks }),
    }),

  startCoach: (session_id: string) =>
    request<CoachResponse>("/coach", {
      method: "POST",
      body: JSON.stringify({ session_id }),
    }),

  respondCoach: (session_id: string, message: string) =>
    request<CoachResponse>("/coach/respond", {
      method: "POST",
      body: JSON.stringify({ session_id, message }),
    }),

  getWeekPlan: (offset: number = 0) =>
    request<WeekPlanResponse>(`/plan/week?offset=${offset}`),

  getWeekModified: (offset: number = 0) =>
    request<{ mtime: number | null }>(`/plan/week-modified?offset=${offset}`),

  saveWeekPlan: (days: DayTasks[], offset: number = 0, expectedMtime?: number | null) =>
    request<{ status: string; mtime?: number }>("/plan/save-week", {
      method: "POST",
      body: JSON.stringify({ days, offset, expected_mtime: expectedMtime ?? null }),
    }),

  createNextWeek: () =>
    request<{ status: string; week_label: string }>("/plan/create-next-week", {
      method: "POST",
    }),

  transitionWeek: () =>
    request<{ status: string; archived: string; new_week: string }>("/plan/transition-week", {
      method: "POST",
    }),

  saveToVault: (content: string, grouped: boolean) =>
    request<{ status: string; day: string }>("/plan/save-vault", {
      method: "POST",
      body: JSON.stringify({ content, grouped }),
    }),

  // Bucket
  getBucket: () => request<BucketResponse>("/plan/bucket"),

  getBucketModified: () =>
    request<{ mtime: number | null }>("/plan/bucket-modified"),

  saveBucket: (tasks: BucketTask[], pinned_groups: string[], expectedMtime?: number | null) =>
    request<{ status: string; mtime?: number }>("/plan/bucket/save", {
      method: "POST",
      body: JSON.stringify({ tasks, pinned_groups, expected_mtime: expectedMtime ?? null }),
    }),

  moveToBucket: (task_index: number, day_idx: number, week_offset: number = 0, horizon: string = "") =>
    request<{ status: string; bucket_count: number }>("/plan/bucket/move", {
      method: "POST",
      body: JSON.stringify({ task_index, direction: "to_bucket", day_idx, week_offset, horizon }),
    }),

  moveFromBucket: (task_index: number, day_idx: number, week_offset: number = 0) =>
    request<{ status: string; bucket_count: number }>("/plan/bucket/move", {
      method: "POST",
      body: JSON.stringify({ task_index, direction: "from_bucket", day_idx, week_offset }),
    }),

  // Carry forward
  getCarryForward: (offset: number = -1) =>
    request<{ tasks: { text: string; from_day: string; subtasks: Subtask[]; focused: boolean; waiting: boolean; priority: string }[]; week_label: string; found: boolean }>(
      `/plan/carry-forward?offset=${offset}`
    ),

  resolveCarry: (text: string, sourceOffset: number, action: "done" | "delete") =>
    request<{ status: string }>("/plan/carry-forward/resolve", {
      method: "POST",
      body: JSON.stringify({ text, source_offset: sourceOffset, action }),
    }),

  carryForward: (tasks: { text: string; day: string; subtasks: { text: string; done: boolean }[]; focused: boolean; waiting: boolean; priority: string }[], offset: number = 0, sourceOffset?: number) =>
    request<{ status: string; count: number }>("/plan/carry-forward", {
      method: "POST",
      body: JSON.stringify({ tasks, offset, source_offset: sourceOffset }),
    }),

  getMemory: () => request<MemoryResponse>("/memory"),

  updateMemory: (session_id: string, summary: string) =>
    request("/memory/update", {
      method: "POST",
      body: JSON.stringify({ session_id, summary }),
    }),

  // Vault
  vaultSearch: (q: string, limit: number = 10) =>
    request<{ results: { name: string; path: string; folder: string; section: string }[] }>(
      `/api/vault/search?q=${encodeURIComponent(q)}&limit=${limit}`
    ),

  // Resolve a wiki-link name to a path by unique basename (Obsidian-style),
  // for click-to-open on [[links]]. Returns { path: null } when unresolved.
  vaultResolve: (name: string) =>
    request<{ path: string | null; name: string }>(
      `/api/vault/resolve?name=${encodeURIComponent(name)}`
    ),

  referenceLinks: () =>
    request<{ links: Record<string, string> }>("/api/vault/reference-links"),

  vaultFolder: (path: string = "1-Projects") =>
    request<{ path: string; files: { name: string; path: string; type: string; modified: string }[] }>(
      `/api/vault/folder?path=${encodeURIComponent(path)}`
    ),

  vaultMove: (source: string, destination: string) =>
    request<{ success: boolean; new_path: string }>("/api/vault/move", {
      method: "POST",
      body: JSON.stringify({ source, destination }),
    }),

  vaultDelete: (path: string) =>
    request<{ success: boolean; path: string }>(
      `/api/vault/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" }
    ),

  getPinnedNotes: () =>
    request<{ pinned: string[] }>("/api/vault/pinned-notes"),

  savePinnedNotes: (pinned: string[]) =>
    request<{ pinned: string[] }>("/api/vault/pinned-notes", {
      method: "PUT",
      body: JSON.stringify({ pinned }),
    }),

  vaultLinkedDocs: async (group: string) => {
    const raw = await request<{
      folder_path: string | null;
      call_logs: { name: string; path: string }[];
      project_files: { name: string; path: string }[];
      subfolders: { name: string; path: string }[];
      wiki_refs: { name: string; path: string }[];
    }>(`/api/vault/linked-docs?group=${encodeURIComponent(group)}`);
    const docs: { name: string; path: string; type: string }[] = [
      ...(raw.call_logs || []).map(d => ({ ...d, type: "call_log" })),
      ...(raw.project_files || []).map(d => ({ ...d, type: "project" })),
      ...(raw.subfolders || []).map(d => ({ ...d, type: "subfolder" })),
    ];
    return { group, folder: raw.folder_path || "", docs };
  },

  // Notes
  getNotes: (day?: string, offset: number = 0) => {
    const params = new URLSearchParams({ offset: String(offset) });
    if (day) params.set("day", day);
    return request<DayNotesResponse>(`/plan/notes?${params}`);
  },

  appendNote: (day: string, entry: string, group: string = "", timestamp: boolean = true, offset: number = 0) =>
    request<{ status: string; day: string }>("/plan/notes/append", {
      method: "POST",
      body: JSON.stringify({ day, entry, group, timestamp, offset }),
    }),

  putNotes: (day: string, content: string, offset: number = 0) =>
    request<{ status: string; day: string }>("/plan/notes", {
      method: "PUT",
      body: JSON.stringify({ day, content, offset }),
    }),

  // Vault note read/write (for in-app editor)
  readNote: (path: string) =>
    request<{ content: string; modified: string; path: string }>(
      `/api/notes/read?path=${encodeURIComponent(path)}`
    ),

  writeNote: (path: string, content: string) =>
    request<{ success: boolean; modified: string; path: string }>("/api/notes/write", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),

  createNote: (folder: string, name: string, template: string = "") =>
    request<{ success: boolean; modified: string; path: string }>("/api/notes/create", {
      method: "POST",
      body: JSON.stringify({ folder, name, template }),
    }),

  // Settings
  getSettings: () =>
    request<{
      vault_path: string;
      vault_root: string;
      reference_links: Record<string, string>;
      vault_status: VaultStatus;
      api_key_status: ApiKeyStatus;
      contexts: Record<string, string[]>;
      context_tags: Record<string, string>;
      coach_enabled?: boolean;
      diary_folder?: string;
    }>("/api/settings"),

  // Habits
  getHabits: () =>
    request<{ found: boolean; habits: Habit[] }>("/plan/habits"),

  initHabits: () =>
    request<{ status: string }>("/plan/habits/init", { method: "POST" }),

  saveHabits: (habits: { name: string; domain: string; variants: string[]; target: number; period: string; morning: boolean; duration: number }[]) =>
    request<{ status: string; count: number }>("/plan/habits/save", {
      method: "POST",
      body: JSON.stringify({ habits }),
    }),

  // Time tracking
  getTimeLog: (month?: string) =>
    request<{ month: string; entries: TimeEntry[]; running: TimeEntry | null }>(
      month ? `/time/log?month=${month}` : "/time/log"),

  startTime: (text: string) =>
    request<{ status: string; running: TimeEntry }>("/time/start", {
      method: "POST", body: JSON.stringify({ text }) }),

  stopTime: () =>
    request<{ status: string }>("/time/stop", { method: "POST" }),

  adjustTime: (patch: { start?: string; text?: string }) =>
    request<{ status: string; running: TimeEntry }>("/time/adjust", {
      method: "POST", body: JSON.stringify(patch) }),

  addTimeEntry: (entry: { date: string; start: string; end: string | null; text: string }) =>
    request<{ status: string }>("/time/add", { method: "POST", body: JSON.stringify(entry) }),

  updateTimeEntry: (u: { date: string; index: number; start: string; end: string | null; text: string; delete?: boolean }) =>
    request<{ status: string }>("/time/update", { method: "POST", body: JSON.stringify(u) }),

  saveContextSettings: (contexts: Record<string, string[]>, context_tags: Record<string, string>) =>
    request<{ status: string; contexts: Record<string, string[]>; context_tags: Record<string, string> }>(
      "/api/settings/contexts",
      { method: "POST", body: JSON.stringify({ contexts, context_tags }) }
    ),

  validateVault: (vault_path: string) =>
    request<{
      vault_path: string;
      vault_root: string;
      vault_status: VaultStatus;
      reference_links: Record<string, string>;
    }>("/api/settings/validate-vault", {
      method: "POST",
      body: JSON.stringify({ vault_path }),
    }),

  updateVaultPath: (vault_path: string, create_structure: boolean = false) =>
    request<{
      status: string;
      vault_path: string;
      vault_root: string;
      created_folders: string[];
      reference_links: Record<string, string>;
      vault_status: VaultStatus;
    }>("/api/settings/vault-path", {
      method: "PUT",
      body: JSON.stringify({ vault_path, create_structure }),
    }),

  updateReferenceLinks: (reference_links: Record<string, string>) =>
    request<{ status: string; reference_links: Record<string, string> }>("/api/settings/reference-links", {
      method: "PUT",
      body: JSON.stringify({ reference_links }),
    }),

  addReferenceLink: (name: string, path: string) =>
    request<{ status: string; reference_links: Record<string, string> }>("/api/settings/reference-links", {
      method: "POST",
      body: JSON.stringify({ name, path }),
    }),

  deleteReferenceLink: (name: string) =>
    request<{ status: string; reference_links: Record<string, string> }>(
      `/api/settings/reference-links/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    ),

  listVaultFolders: (path: string = "") =>
    request<{ folders: { name: string; path: string }[]; current: string }>(
      `/api/settings/vault-folders?path=${encodeURIComponent(path)}`
    ),

  browseFolders: (path: string = "") =>
    request<{ folders: { name: string; path: string }[]; current: string; parent: string | null }>(
      `/api/settings/browse-folders?path=${encodeURIComponent(path)}`
    ),
};

export interface ApiKeyStatus {
  configured: boolean;
  masked: string;
  source: string;
}

export interface VaultStatus {
  exists: boolean;
  has_para: boolean;
  para_folders: string[];
  has_config: boolean;
  file_count: number;
}
