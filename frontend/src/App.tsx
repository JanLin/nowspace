import { useState, useEffect } from "react";
import Nav from "./components/Nav";
import WeekPlan from "./components/WeekPlan";
import Bucket from "./components/Bucket";
import Goals from "./components/Goals";
import Coaching from "./components/Coaching";
import Dashboard from "./components/Dashboard";
import Settings from "./components/Settings";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { Task } from "./api";

type View = "week" | "bucket" | "goals" | "coaching" | "dashboard" | "settings";

export default function App() {
  const [view, setView] = useState<View>("week");
  const [vaultReady, setVaultReady] = useState<boolean | null>(null); // null = checking

  // On mount, check if vault is configured and valid
  useEffect(() => {
    api.getSettings().then((s) => {
      if (s.vault_status.exists && s.vault_status.has_para && s.api_key_status.configured) {
        setVaultReady(true);
      } else {
        setVaultReady(false);
        setView("settings");
      }
    }).catch(() => {
      setVaultReady(false);
      setView("settings");
    });
  }, []);
  const [sessionId] = useState<string | null>(null);
  const [planTasks, setPlanTasks] = useState<Task[]>([]);
  const { theme, setTheme } = useTheme();

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}>
      {/* Sticky top nav */}
      <div className="sticky top-0 z-40 px-2 sm:px-4 py-2" style={{ backgroundColor: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
        <div className="mx-auto max-w-6xl flex items-center gap-2 sm:gap-4">
          <header className="flex items-center gap-2 shrink-0">
            <img src="/nowspace-compass-icon.svg" alt="Nowspace" className="w-6 h-6 sm:w-7 sm:h-7" />
            <h1 className="text-base sm:text-lg font-bold hidden sm:block" style={{ color: "var(--text)" }}>Nowspace</h1>
          </header>
          <Nav current={view} onChange={setView} />
          {/* Theme toggle */}
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light")}
            className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-sm transition-colors"
            style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
            title={`Theme: ${theme}`}
          >
            {theme === "light" ? "☀️" : theme === "dark" ? "🌙" : "💻"}
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <main className="flex-1 overflow-y-auto px-2 sm:px-4 py-2 sm:py-4">
        <div className="mx-auto max-w-6xl">
          <div className={view === "week" ? "" : "hidden"}>
            <WeekPlan />
          </div>
          <div className={view === "bucket" ? "" : "hidden"}>
            <Bucket />
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
          <div className={view === "settings" ? "max-w-3xl mx-auto" : "hidden"}>
            <Settings onVaultReady={() => {
              if (!vaultReady) {
                setVaultReady(true);
                setView("week");
              }
            }} />
          </div>
        </div>
      </main>
    </div>
  );
}
