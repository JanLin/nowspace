import { useEffect, useState } from "react";
import { api, type AppSettings } from "./api";

/** Basic is plain GTD. Advanced is the funnel: stages, shaping, sizes, the
 *  review and the Slate. Handoff (agent dispatch) is its own switch.
 *
 *  Advanced is the default until the settings load, so an existing user never
 *  sees their funnel blink out on a slow start. */
const DEFAULT: AppSettings = { mode: "advanced", funnel: true, handoff: false };

let cached: AppSettings | null = null;
let cachedAddons: Record<string, unknown> = {};

/* ── One settings read, retried until it lands ──────────────────────────
 *
 * Both hooks below are called at the top of App, which is *above* the gate
 * that waits for the backend — the gate stops panels from mounting, not
 * hooks that have already run. So on a cold start their first read happens
 * while the backend is still coming up: the desktop app is unpacking its
 * sidecar, or a phone has just woken the radio and not yet reached the Mac.
 *
 * That first read used to fail once and never be tried again. `app` has a
 * default so nothing showed, but `addons` falls back to none — and a
 * registered extension tab that is not in the answer is not rendered at all.
 * The Relay tab vanished for the whole session and came back on a manual
 * reload, which is exactly what it looked like from the phone.
 *
 * So: keep asking. Backoff to 30s, and ask straight away when the person
 * comes back to the app or the network returns, because that is the moment
 * the answer is most likely to have changed.
 */

const listeners = new Set<() => void>();
let inFlight = false;
let landed = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function refresh(): void {
  if (inFlight) return;
  inFlight = true;
  api.getSettings()
    .then((s) => {
      inFlight = false;
      attempt = 0;
      landed = true;
      // Absent `app` means a backend that predates it — keep what we knew.
      if (s.app) cached = s.app;
      // Absent `addons` means a backend older than the seam: no tabs, and
      // that is an answer, not a failure.
      cachedAddons = (s.addons as Record<string, unknown>) ?? {};
      listeners.forEach((fn) => fn());
    })
    .catch(() => {
      inFlight = false;
      attempt += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(refresh, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
    });
}

/** Retry now rather than on the backoff's schedule. */
function refreshNow(): void {
  clearTimeout(retryTimer);
  attempt = 0;
  refresh();
}

/** Subscribe a hook to the shared read, starting it if it has not run. */
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Own closures per subscriber, not the shared `refreshNow`:
  // addEventListener de-duplicates an identical function, so two hooks would
  // register one listener and the first to unmount would take it away from
  // the other.
  // A settings save shouts; every surface re-reads.
  const onSaved = () => refreshNow();
  window.addEventListener("app-mode-changed", onSaved);
  // Coming back to the app, or back onto the network, is the likeliest
  // moment for a read that failed to succeed — and the moment a phone's
  // throttled background timers start running again. Nothing is polled:
  // once an answer is in hand these ask nothing, because they only fire
  // while there is still nothing to show.
  const onWake = () => { if (!landed && !document.hidden) refreshNow(); };
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("online", onWake);
  if (!landed) refresh();
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("app-mode-changed", onSaved);
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("online", onWake);
  };
}

/** The extension namespaces from the vault settings, as stored.
 *
 *  Only used to answer a surface's `enabledBy` — the baseline never looks
 *  inside one. Empty until the settings arrive, so a tab appears when its
 *  switch is known to be on rather than before. */
export function useAddonSettings(): Record<string, unknown> {
  const [addons, setAddons] = useState<Record<string, unknown>>(cachedAddons);
  useEffect(() => subscribe(() => setAddons(cachedAddons)), []);
  return addons;
}

export function useAppMode(): AppSettings {
  const [mode, setMode] = useState<AppSettings>(cached ?? DEFAULT);
  useEffect(() => subscribe(() => setMode(cached ?? DEFAULT)), []);
  return mode;
}
