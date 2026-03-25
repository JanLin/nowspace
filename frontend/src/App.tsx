import { useState } from "react";
import Nav from "./components/Nav";
import WeekPlan from "./components/WeekPlan";
import Goals from "./components/Goals";
import Coaching from "./components/Coaching";
import Dashboard from "./components/Dashboard";
import type { Task } from "./api";

type View = "week" | "goals" | "coaching" | "dashboard";

export default function App() {
  const [view, setView] = useState<View>("week");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [planTasks, setPlanTasks] = useState<Task[]>([]);

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto px-4 py-6 space-y-6 max-w-6xl">
        <header className="text-center">
          <h1 className="text-xl font-bold text-gray-900">Coach</h1>
        </header>

        <Nav current={view} onChange={setView} />

        <main className="min-h-[60vh]">
          <div className={view === "week" ? "" : "hidden"}>
            <WeekPlan />
          </div>
          <div className={view === "goals" ? "max-w-3xl mx-auto" : "hidden"}>
            <Goals />
          </div>
          <div className={view === "coaching" ? "max-w-3xl mx-auto" : "hidden"}>
            <Coaching sessionId={sessionId} tasks={planTasks} onTasksChanged={setPlanTasks} />
          </div>
          <div className={view === "dashboard" ? "max-w-3xl mx-auto" : "hidden"}>
            <Dashboard />
          </div>
        </main>
      </div>
    </div>
  );
}
