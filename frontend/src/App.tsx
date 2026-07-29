import { useState, useEffect, useRef } from "react";
import Nav from "./components/Nav";
import WeekPlan from "./components/WeekPlan";
import Bucket from "./components/Bucket";
import Slate from "./components/Slate";
import TaskSearch, { type SearchHit } from "./components/TaskSearch";
import Habits from "./components/Habits";
import TimeTab from "./components/TimeTab";
import Goals from "./components/Goals";
import NoteEditor from "./components/NoteEditor";
import NoteTabsStrip from "./components/NoteTabsStrip";
import VaultBrowser, { type VaultBrowserState } from "./components/VaultBrowser";
import Settings from "./components/Settings";
import Tour from "./components/Tour";
import HelpGuide from "./components/HelpGuide";
import Philosophy from "./components/Philosophy";
import { useTheme } from "./useTheme";
import { api, CLIENT_SCHEMA_VERSION, type NoteTab } from "./api";

type View = "week" | "bucket" | "slate" | "notes" | "habits" | "time" | "goals" | "coaching" | "dashboard" | "settings";

export default function App() {
  const [view, setView] = useState<View>("week");
  // Notes held open in the Notes tab, one sub-tab each. Opening a note from a
  // task or a [[link]] adds it here and switches to the tab, so notes and
  // tasks live in separate tabs you can flip between (parallel work without an
  // overlay — works at phone width too). The strip is vault-shared, so the
  // same notes are open on every installation.
  const [noteTabs, setNoteTabs] = useState<NoteTab[]>([]);
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [maxOpenNotes, setMaxOpenNotes] = useState(5);
  // Which tab was looked at when — decides who gets closed at the limit.
  // Local: it's about this device's reading, not a shared fact.
  const lastSeen = useRef<Map<string, number>>(new Map());
  const seenTick = useRef(0);
  const notesLoaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Debounced strip write. Tab churn is a workspace gesture, not a record —
  // one write per settled state keeps the synced settings file quiet.
  const persistTabs = (tabs: NoteTab[]) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.saveNotesSettings({ tabs }).catch(() => { /* older backend: strip stays local */ });
    }, 1200);
  };

  const commitTabs = (tabs: NoteTab[]) => { setNoteTabs(tabs); persistTabs(tabs); };

  const showNote = (path: string, name: string) => {
    setView("notes");
    setActiveNote(path);
    lastSeen.current.set(path, ++seenTick.current);
    setNoteTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev; // already open
      let next = [...prev, { path, name, pinned: false }];
      // At the limit, close the unpinned tab left longest unread. Pinned tabs
      // are never evicted, so pinning past the limit is allowed to grow the
      // strip — the number is where Nowspace starts tidying, not a wall.
      while (next.length > maxOpenNotes) {
        const victim = next
          .filter((t) => !t.pinned && t.path !== path)
          .sort((a, b) => (lastSeen.current.get(a.path) ?? 0) - (lastSeen.current.get(b.path) ?? 0))[0];
        if (!victim) break;
        next = next.filter((t) => t.path !== victim.path);
      }
      persistTabs(next);
      return next;
    });
  };

  const selectNote = (path: string) => {
    setActiveNote(path);
    lastSeen.current.set(path, ++seenTick.current);
  };

  const closeNote = (path: string) => {
    setNoteTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      persistTabs(next);
      if (activeNote === path) {
        const at = prev.findIndex((t) => t.path === path);
        setActiveNote(next.length ? next[Math.min(at, next.length - 1)].path : null);
      }
      return next;
    });
  };

  const togglePinNote = (path: string) =>
    commitTabs(noteTabs.map((t) => (t.path === path ? { ...t, pinned: !t.pinned } : t)));

  const reorderNotes = (fromPath: string, toPath: string) => {
    const from = noteTabs.findIndex((t) => t.path === fromPath);
    const to = noteTabs.findIndex((t) => t.path === toPath);
    if (from === -1 || to === -1) return;
    const next = [...noteTabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commitTabs(next);
  };

  const clearAllNotes = () => { setActiveNote(null); commitTabs([]); };

  // The Notes tab's own vault panel and status bar, mirroring how Plan and
  // Bucket carry a corner button and a bottom bar.
  const [vaultOpen, setVaultOpen] = useState(false);
  const notesVaultStateRef = useRef<VaultBrowserState | null>(null);
  const [noteStatus, setNoteStatus] = useState<{ saving: boolean; unsaved: boolean; path: string } | null>(null);
  // Breadcrumb click in the editor: show that folder in the vault panel,
  // opening it if it was closed. The nonce lets the same folder be asked for
  // twice — you may have browsed elsewhere in between.
  const [vaultFocus, setVaultFocus] = useState<{ path: string; nonce: number } | undefined>();
  const showVaultFolder = (folder: string) => {
    setVaultOpen(true);
    setVaultFocus((prev) => ({ path: folder, nonce: (prev?.nonce ?? 0) + 1 }));
  };
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
      // Restore the shared note strip once — a later load must not stamp on
      // tabs opened since, and never triggers a write of what we just read
      if (!notesLoaded.current && s.notes) {
        notesLoaded.current = true;
        if (s.notes.max_open) setMaxOpenNotes(s.notes.max_open);
        const restored = s.notes.tabs || [];
        if (restored.length > 0) {
          setNoteTabs(restored);
          setActiveNote(restored[0].path);
          restored.forEach((t) => lastSeen.current.set(t.path, ++seenTick.current));
        }
      }
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
      <div className="h-screen flex flex-col items-center justify-center gap-3" style={{ height: "100dvh", backgroundColor: "var(--bg)", color: "var(--text)" }}>
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
    /* Height must be the DYNAMIC viewport, not 100vh. On phones 100vh is the
       large viewport — it excludes the collapsible URL bar — so the shell
       ends up taller than what's visible, the document itself gains that
       much scroll, and everything inside <main> (the pinned Tag/View/Filter
       toolbars) drifts up under the sticky nav. dvh tracks the visible box,
       so the document never scrolls and pinned means pinned. The h-screen
       class stays as the fallback: browsers without dvh drop the inline
       declaration and land on 100vh. */
    <div className="h-screen flex flex-col" style={{ height: "100dvh", backgroundColor: "var(--bg)", color: "var(--text)" }}>
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
          <Nav current={view} onChange={setView} hideCoach={!coachEnabled} onSearch={() => setSearchOpen(true)} />
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

      {/* Notes tab: vault button and status bar — the same corner-button and
          bottom-bar pattern the Plan and Bucket tabs use. */}
      {view === "notes" && (
        <>
          <div className={`fixed bottom-8 z-40 flex items-end gap-2 ${vaultOpen ? "right-6 md:right-[max(21.5rem,calc(50vw-14.5rem))]" : "right-6"}`}>
            <div
              className="relative cursor-pointer transition-all duration-200 hover:scale-105"
              title="Vault — browse, search, add a note or folder anywhere"
              onClick={() => setVaultOpen((v) => !v)}
            >
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg shadow-md border-2 transition-colors ${
                vaultOpen ? "bg-blue-200 border-blue-500" : "bg-white border-gray-200 hover:border-blue-300"
              }`}>📁</div>
            </div>
          </div>
          <div className="fixed bottom-0 left-0 right-0 z-30 backdrop-blur border-t px-4 py-1"
            style={{ backgroundColor: "color-mix(in srgb, var(--bg) 95%, transparent)", borderColor: "var(--border)" }}>
            <div className="max-w-6xl mx-auto flex items-center gap-2 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              {noteStatus && activeNote ? (
                <span className={`px-2 py-0.5 rounded font-medium ${
                  noteStatus.saving ? "bg-blue-100 text-blue-700"
                    : noteStatus.unsaved ? "bg-amber-100 text-amber-700"
                    : "bg-green-100 text-green-700"
                }`}>
                  {noteStatus.saving ? "Saving…" : noteStatus.unsaved ? "Unsaved" : "✓ Saved"}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded" style={{ backgroundColor: "var(--bg-secondary)" }}>No note open</span>
              )}
              {activeNote && <span className="truncate">{activeNote}</span>}
              <span className="flex-1" />
              <span className="whitespace-nowrap">{noteTabs.length}/{maxOpenNotes} open</span>
            </div>
          </div>
        </>
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
            <NoteTabsStrip
              tabs={noteTabs}
              activePath={activeNote}
              maxOpen={maxOpenNotes}
              onSelect={selectNote}
              onClose={closeNote}
              onTogglePin={togglePinNote}
              onReorder={reorderNotes}
              onClearAll={clearAllNotes}
            />
            <div className="flex gap-0 items-start">
              <div className={`min-w-0 ${vaultOpen ? "flex-1" : "w-full"}`}>
                {activeNote ? (
                  <NoteEditor
                    key={activeNote}
                    embedded
                    initialPath={activeNote}
                    initialName={noteTabs.find((t) => t.path === activeNote)?.name}
                    /* Closing a note closes the tab — the Notes tab is where
                       you are, so it shouldn't throw you back to Plan */
                    onClose={() => closeNote(activeNote)}
                    onStatus={setNoteStatus}
                    onOpenFolder={showVaultFolder}
                  />
                ) : (
                  <div className="max-w-lg mx-auto text-center py-16 px-4" style={{ color: "var(--text-secondary)" }}>
                    <div className="text-3xl mb-2">📝</div>
                    <p className="text-sm">No note open yet.</p>
                    <p className="text-xs mt-1">Tap a <span className="font-mono">[[link]]</span> in your notes, or a linked note on a task, and it opens here — flip back to Plan any time without losing your place. The 📁 button opens the vault: browse, search, and make a note or folder anywhere.</p>
                  </div>
                )}
              </div>
              {/* Vault panel — opening a note from here adds it as a sub-tab,
                  so browsing and reading happen in the same place */}
              {vaultOpen && (
                <div className="w-full md:w-80 shrink-0 border-l md:pl-0 max-h-[calc(100dvh-160px)] overflow-hidden sticky top-[72px] self-start rounded-lg"
                  style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--bg-secondary)" }}>
                  <VaultBrowser
                    onClose={() => setVaultOpen(false)}
                    stateRef={notesVaultStateRef}
                    onOpenNote={showNote}
                    focusFolder={vaultFocus}
                  />
                </div>
              )}
            </div>
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
            <Settings
              onVaultReady={() => {
                if (!vaultReady) {
                  setVaultReady(true);
                  setView("week");
                }
              }}
              theme={theme}
              onThemeChange={setTheme}
              onOpenTour={() => setTourOpen(true)}
              onOpenGuide={() => setGuideOpen(true)}
              onOpenPhilosophy={() => setPhilosophyOpen(true)}
            />
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
