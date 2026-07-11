import { useState, useEffect } from "react";
import Nav from "./components/Nav";
import WeekPlan from "./components/WeekPlan";
import Bucket from "./components/Bucket";
import Habits from "./components/Habits";
import TimeTab from "./components/TimeTab";
import Goals from "./components/Goals";
import Coaching from "./components/Coaching";
import Dashboard from "./components/Dashboard";
import Settings from "./components/Settings";
import { useTheme } from "./useTheme";
import { api } from "./api";
import type { Task } from "./api";

type View = "week" | "bucket" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

export default function App() {
  const [view, setView] = useState<View>("week");
  const [vaultReady, setVaultReady] = useState<boolean | null>(null); // null = checking
  const [backendUp, setBackendUp] = useState(false);
  const [coachEnabled, setCoachEnabled] = useState(true);
  const [slowStart, setSlowStart] = useState(false);

  // Wait for the backend before mounting anything that fetches. The desktop
  // app boots its bundled backend at launch, which can take ~15s to unpack —
  // without this gate every initial fetch fails once and never retries.
  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    (async () => {
      while (!cancelled) {
        try {
          await api.health();
          if (!cancelled) setBackendUp(true);
          return;
        } catch {
          if (Date.now() - started > 15000) setSlowStart(true);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Once the backend is up, check if vault is configured and valid
  useEffect(() => {
    if (!backendUp) return;
    api.getSettings().then((s) => {
      const coach = s.coach_enabled !== false;
      setCoachEnabled(coach);
      // The API key only matters when the coach feature is on
      if (s.vault_status.exists && s.vault_status.has_para && (s.api_key_status.configured || !coach)) {
        setVaultReady(true);
      } else {
        setVaultReady(false);
        setView("settings");
      }
    }).catch(() => {
      setVaultReady(false);
      setView("settings");
    });
  }, [backendUp]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [planTasks, setPlanTasks] = useState<Task[]>([]);
  const { theme, setTheme } = useTheme();

  // Update detection: the served assets carry version.json; when the server
  // gets updated (the mini pulls hourly) an already-open app keeps running
  // old code until reloaded. Check when the app comes to the foreground and
  // every 15 minutes. The desktop app bundles frontend+backend together, so
  // its versions always match and this stays quiet there. Dev has HMR.
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch("/version.json", { cache: "no-store" });
        if (!r.ok) return;
        const v = (await r.json()).version;
        if (!cancelled && v && v !== __APP_VERSION__) setUpdateVersion(v);
      } catch { /* offline — try again later */ }
    };
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(check, 15 * 60 * 1000);
    check();
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); clearInterval(iv); };
  }, []);

  if (!backendUp) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3" style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}>
        <img src="/nowspace-compass-icon.svg" alt="Nowspace" className="w-12 h-12 animate-pulse" />
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Starting Nowspace…</p>
        {slowStart && (
          <p className="text-xs max-w-xs text-center" style={{ color: "var(--text-secondary)" }}>
            Still waiting for the backend on port 8000. The desktop app starts
            its own — first launch can take a little while.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col" style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}>
      {/* Sticky top nav */}
      <div className="sticky top-0 z-40 px-2 sm:px-4 py-2" style={{ backgroundColor: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
        <div className="mx-auto max-w-6xl flex items-center gap-2 sm:gap-4">
          <header className="flex items-center gap-2 shrink-0">
            <img src="/nowspace-compass-icon.svg" alt="Nowspace" className="w-6 h-6 sm:w-7 sm:h-7" />
            <h1 className="text-base sm:text-lg font-bold hidden sm:block" style={{ color: "var(--text)" }}>Nowspace</h1>
          </header>
          <Nav current={view} onChange={setView} hideCoach={!coachEnabled} />
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

      {/* New-version pill */}
      {updateVersion && (
        <div className="fixed bottom-20 inset-x-0 z-50 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-full shadow-lg text-xs font-medium"
            style={{ backgroundColor: "var(--accent)", color: "white" }}>
            <span>Nowspace v{updateVersion} is ready</span>
            <button onClick={() => window.location.reload()} className="px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 font-semibold">
              Restart
            </button>
            <button onClick={() => setUpdateVersion(null)} className="opacity-70 hover:opacity-100" aria-label="Dismiss">✕</button>
          </div>
        </div>
      )}

      {/* Scrollable content */}
      <main className="flex-1 overflow-y-auto px-2 sm:px-4 py-2 sm:py-4">
        <div className="mx-auto max-w-6xl">
          <div className={view === "week" ? "" : "hidden"}>
            <WeekPlan />
          </div>
          <div className={view === "bucket" ? "" : "hidden"}>
            <Bucket />
          </div>
          <div className={view === "habits" ? "max-w-3xl mx-auto" : "hidden"}>
            <Habits />
          </div>
          <div className={view === "time" ? "max-w-3xl mx-auto" : "hidden"}>
            <TimeTab />
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
