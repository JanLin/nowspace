const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
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
}

export const api = {
  getPlan: (targetDate?: string) =>
    request<PlanResponse>(targetDate ? `/plan?target_date=${targetDate}` : "/plan"),

  getGoals: () => request<GoalsResponse>("/plan/goals"),

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

  getWeekPlan: () => request<WeekPlanResponse>("/plan/week"),

  saveWeekPlan: (days: DayTasks[]) =>
    request<{ status: string }>("/plan/save-week", {
      method: "POST",
      body: JSON.stringify({ days }),
    }),

  saveToVault: (content: string, grouped: boolean) =>
    request<{ status: string; day: string }>("/plan/save-vault", {
      method: "POST",
      body: JSON.stringify({ content, grouped }),
    }),

  getMemory: () => request<MemoryResponse>("/memory"),

  updateMemory: (session_id: string, summary: string) =>
    request("/memory/update", {
      method: "POST",
      body: JSON.stringify({ session_id, summary }),
    }),
};
