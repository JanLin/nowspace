import { useState, useEffect } from "react";
import Nav from "./components/Nav";
import WeekPlan from "./components/WeekPlan";
import Bucket from "./components/Bucket";
import Slate from "./components/Slate";
import TaskSearch, { type SearchHit } from "./components/TaskSearch";
import Habits from "./components/Habits";
import TimeTab from "./components/TimeTab";
import Goals from "./components/Goals";
import NoteEditor from "./components/NoteEditor";
import Settings from "./components/Settings";
import Tour from "./components/Tour";
import HelpGuide from "./components/HelpGuide";
import Philosophy from "./components/Philosophy";
import { useTheme } from "./useTheme";
import { api, CLIENT_SCHEMA_VERSION } from "./api";

type View = "week" | "bucket" | "slate" | "notes" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

export default function App() {
  const [view, setView] = useState<View>("week");
  // The note currently open in the Notes tab. Opening a note from a task or a
  // [[link]] loads it here and switches to the tab, so notes and tasks live in
  // separate tabs you can flip between (parallel work without an overlay —
  // works at phone width too).
  const [openNote, setOpenNote] = useState<{ path: string; name: string } | null>(null);
  const showNote = (path: string, name: string) => { setOpenNote({ path, name }); setView("notes"); };
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
          const h = await api.health();
          if (!cancelled) {
            setBackendUp(true);
            applySkew(h);
          }
          return;
        } catch {
          if (Date.now() - started > 15000) setSlowStart(true);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [schemaSkew, setSchemaSkew] = useState<"client-old" | "backend-old" | "vault-newer" | null>(null);

  // Version-skew check: every instance (desktop app, PWA, dev) must speak
  // the same bucket schema or writes are refused — surface the mismatch
  // proactively instead of at the first save. Three cases:
  //  - backend newer than this UI  → stale bundle (PWA cache) → reload
  //  - backend older than this UI  → server needs updating
  //  - VAULT newer than both       → the marker synced in with the files:
  //    another device already upgraded. This is the only signal an
  //    isolated matched pair (the desktop app) can ever receive.
  const applySkew = (h: { schema_version?: number; vault_schema?: number }) => {
    const backendSchema = h.schema_version ?? 1;
    const vaultSchema = h.vault_schema ?? 0;
    if (backendSchema > CLIENT_SCHEMA_VERSION) setSchemaSkew("client-old");
    else if (backendSchema < CLIENT_SCHEMA_VERSION) setSchemaSkew("backend-old");
    else if (vaultSchema > CLIENT_SCHEMA_VERSION) setSchemaSkew("vault-newer");
    else setSchemaSkew(null);
  };

  // Re-check every 5 minutes: Syncthing can deliver an upgraded vault (or a
  // deployment can update the backend) while the app sits open.
  useEffect(() => {
    if (!backendUp) return;
    const t = setInterval(() => { api.health().then(applySkew).catch(() => {}); }, 5 * 60_000);
    return () => clearInterval(t);
  }, [backendUp]);

  // Once the backend is up, check if vault is configured and valid
  useEffect(() => {
    if (!backendUp) return;
    api.getSettings().then((s) => {
      const coach = s.coach_enabled !== false;
      setCoachEnabled(coach);
      if (s.funnel?.evening_cutoff) setEveningCutoff(s.funnel.evening_cutoff);
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
  const { theme, setTheme } = useTheme();

  // The Slate opens from the compass logo (no tab — the app's face is the
  // ambient surface). After the evening cutoff a quiet half-moon appears
  // next to the logo: a state signal, never a badge or a count. Entry stays
  // available at any hour — the surface filters itself by time.
  const [eveningCutoff, setEveningCutoff] = useState("21:00");
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinuteTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const isEvening = (() => {
    void minuteTick; // recompute each minute
    const [ch, cm] = eveningCutoff.split(":").map((x) => parseInt(x, 10));
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    return mins >= (isNaN(ch) ? 21 : ch) * 60 + (isNaN(cm) ? 0 : cm) || mins < 5 * 60;
  })();

  // Offline banner: api.ts broadcasts state changes when the service
  // worker starts (or stops) serving cache fallbacks. false = online,
  // string/null = offline (string carries the cached data's timestamp).
  const [offlineAt, setOfflineAt] = useState<string | null | false>(false);
  useEffect(() => {
    const off = (e: Event) => setOfflineAt((e as CustomEvent).detail?.at ?? null);
    const on = () => setOfflineAt(false);
    window.addEventListener("nowspace-offline", off);
    window.addEventListener("nowspace-online", on);
    return () => {
      window.removeEventListener("nowspace-offline", off);
      window.removeEventListener("nowspace-online", on);
    };
  }, []);

  // Task search: 🔍 in the header or ⌘K / Ctrl-K. Picking a hit switches
  // to the owning tab and fires nowspace-reveal so the view scrolls to and
  // flashes the task.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const pickSearchHit = (hit: SearchHit) => {
    setSearchOpen(false);
    setView(hit.source === "bucket" ? "bucket" : "week");
    // let the tab mount/show before the view tries to scroll
    setTimeout(() => window.dispatchEvent(new CustomEvent("nowspace-reveal", { detail: hit })), 120);
  };

  // First-run tour + help. The tour auto-opens once the vault is ready on a
  // browser that has never finished (or skipped) it.
  const [tourOpen, setTourOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [philosophyOpen, setPhilosophyOpen] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  useEffect(() => {
    if (vaultReady && !localStorage.getItem("nowspace-tour-seen")) setTourOpen(true);
  }, [vaultReady]);
  const closeTour = () => {
    localStorage.setItem("nowspace-tour-seen", "1");
    setTourOpen(false);
  };

  // Update detection. Web/PWA: the served assets carry version.json — when
  // the server gets updated (the mini pulls hourly) an already-open app
  // keeps running old code until reloaded, so check on foreground and every
  // 5 minutes and offer a restart. Desktop: the bundle only changes via a
  // rebuild, so instead ask our backend once per launch what version the
  // configured deployment runs (update_check_url in config.yaml — it tracks
  // main) and offer to skip that version. Dev has HMR.
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV || !backendUp) return;
    const isNewer = (v: string) => {
      const a = v.split(".").map(Number), b = __APP_VERSION__.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
      return false;
    };
    if (__IS_TAURI__) {
      api.updateCheck().then(({ version }) => {
        if (version && isNewer(version) && localStorage.getItem("nowspace-skipped-update") !== version) {
          setUpdateVersion(version);
        }
      }).catch(() => {});
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch("/version.json", { cache: "no-store" });
        if (!r.ok) return;
        const v = (await r.json()).version;
        if (!cancelled && v && isNewer(v)) setUpdateVersion(v);
      } catch { /* offline — try again later */ }
    };
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(check, 5 * 60 * 1000);
    check();
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); clearInterval(iv); };
  }, [backendUp]);

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
          <header className="shrink-0">
            <button
              onClick={() => setView(view === "slate" ? "week" : "slate")}
              className="flex items-center gap-2 rounded-md px-0.5 transition-opacity hover:opacity-80"
              title={isEvening
                ? "The evening slate — what you're rehearsing (tap again to leave)"
                : "The slate — the questions you're carrying (tap again to leave)"}
              aria-label="Open the slate"
            >
              <img src="/nowspace-compass-icon.svg" alt="" className="w-6 h-6 sm:w-7 sm:h-7" />
              <h1 className="text-base sm:text-lg font-bold hidden sm:block" style={{ color: "var(--text)" }}>Nowspace</h1>
              {isEvening && <span className="text-xs -ml-1" aria-hidden="true">🌒</span>}
            </button>
          </header>
          <Nav current={view} onChange={setView} hideCoach={!coachEnabled} />
          {/* Task search */}
          <button
            onClick={() => setSearchOpen(true)}
            className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-sm transition-colors"
            style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
            title="Search tasks — Plan week + Bucket (⌘K)"
            aria-label="Search tasks"
          >
            🔍
          </button>
          {/* Help: replay the tour or open the guide */}
          <div className="relative shrink-0">
            <button
              data-tour="help"
              onClick={() => setHelpMenuOpen(!helpMenuOpen)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-sm font-semibold transition-colors"
              style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
              title="Help"
            >
              ?
            </button>
            {helpMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setHelpMenuOpen(false)} />
                <div className="absolute right-0 top-9 z-50 rounded-lg shadow-xl p-1 w-40"
                  style={{ backgroundColor: "var(--card)", border: "1px solid var(--card-border)" }}>
                  <button
                    onClick={() => { setHelpMenuOpen(false); setTourOpen(true); }}
                    className="w-full text-left px-2 py-1.5 rounded text-xs hover:opacity-80"
                    style={{ color: "var(--text)" }}
                  >
                    🧭 Take the tour
                  </button>
                  <button
                    onClick={() => { setHelpMenuOpen(false); setGuideOpen(true); }}
                    className="w-full text-left px-2 py-1.5 rounded text-xs hover:opacity-80"
                    style={{ color: "var(--text)" }}
                  >
                    📖 Open the guide
                  </button>
                  <button
                    onClick={() => { setHelpMenuOpen(false); setPhilosophyOpen(true); }}
                    className="w-full text-left px-2 py-1.5 rounded text-xs hover:opacity-80"
                    style={{ color: "var(--text)" }}
                  >
                    🧘 The philosophy
                  </button>
                </div>
              </>
            )}
          </div>
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

      {/* Version-skew banner: this instance and its backend disagree on the
          bucket data format — writes are refused server-side until they
          match, so say it up front instead of failing at the first save. */}
      {schemaSkew && (
        <div className="px-3 py-1.5 text-center text-xs font-medium flex items-center justify-center gap-2"
          style={{ backgroundColor: "rgb(245 158 11 / 0.15)", color: "#b45309", borderBottom: "1px solid rgb(245 158 11 / 0.4)" }}>
          {schemaSkew === "client-old" ? (
            <>
              ⚠️ This Nowspace app is older than its server — bucket edits will be
              refused to protect your data.
              <button onClick={() => window.location.reload()} className="underline font-semibold">
                Reload to update
              </button>
            </>
          ) : schemaSkew === "vault-newer" ? (
            <>⚠️ Another device already writes a newer data format to this vault —
              update this Nowspace installation before editing the bucket.</>
          ) : (
            <>⚠️ The Nowspace server on this machine is out of date — update it
              (desktop app: rebuild the backend) before editing the bucket.</>
          )}
        </div>
      )}

      {/* Offline banner */}
      {offlineAt !== false && (
        <div className="px-3 py-1.5 text-center text-xs font-medium"
          style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>
          📴 Offline — showing your plan as of{" "}
          {offlineAt ? new Date(offlineAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : "your last visit"}.
          Changes won't be saved until you're back online.
        </div>
      )}

      {/* New-version pill */}
      {updateVersion && (
        <div className="fixed bottom-20 inset-x-0 z-50 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-full shadow-lg text-xs font-medium"
            style={{ backgroundColor: "var(--accent)", color: "white" }}>
            {__IS_TAURI__ ? (
              <>
                <span title="Update: git pull, ./build-backend.sh, npm run tauri:build">
                  Nowspace v{updateVersion} is out — rebuild the app to update
                </span>
                <button
                  onClick={() => { localStorage.setItem("nowspace-skipped-update", updateVersion); setUpdateVersion(null); }}
                  className="px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 font-semibold"
                  title="Don't show again for this version"
                >
                  Skip this version
                </button>
              </>
            ) : (
              <>
                <span>Nowspace v{updateVersion} is ready</span>
                <button onClick={() => window.location.reload()} className="px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 font-semibold">
                  Restart
                </button>
              </>
            )}
            <button onClick={() => setUpdateVersion(null)} className="opacity-70 hover:opacity-100" aria-label="Dismiss">✕</button>
          </div>
        </div>
      )}

      {/* Scrollable content */}
      <main className="flex-1 overflow-y-auto px-2 sm:px-4 py-2 sm:py-4">
        <div className="mx-auto max-w-6xl">
          <div className={view === "week" ? "" : "hidden"}>
            <WeekPlan onOpenNote={showNote} />
          </div>
          <div className={view === "bucket" ? "" : "hidden"}>
            <Bucket onOpenNote={showNote} />
          </div>
          <div className={view === "slate" ? "" : "hidden"}>
            <Slate active={view === "slate"} onOpenNote={showNote} />
          </div>
          <div className={view === "notes" ? "" : "hidden"}>
            {openNote ? (
              <NoteEditor
                key={openNote.path}
                embedded
                initialPath={openNote.path}
                initialName={openNote.name}
                onClose={() => setView("week")}
              />
            ) : (
              <div className="max-w-lg mx-auto text-center py-16 px-4" style={{ color: "var(--text-secondary)" }}>
                <div className="text-3xl mb-2">📝</div>
                <p className="text-sm">No note open yet.</p>
                <p className="text-xs mt-1">Tap a <span className="font-mono">[[link]]</span> in your notes, or a linked note on a task, and it opens here — flip back to Plan any time without losing your place.</p>
              </div>
            )}
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
          {/* Coach + Dashboard are parked — see the note in Nav.tsx */}
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

      {searchOpen && <TaskSearch onPick={pickSearchHit} onClose={() => setSearchOpen(false)} />}
      {tourOpen && <Tour onClose={closeTour} onOpenGuide={() => { closeTour(); setGuideOpen(true); }} />}
      {guideOpen && <HelpGuide onClose={() => setGuideOpen(false)} />}
      {philosophyOpen && <Philosophy onClose={() => setPhilosophyOpen(false)} />}
    </div>
  );
}
