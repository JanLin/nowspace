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

/** The extension namespaces from the vault settings, as stored.
 *
 *  Only used to answer a surface's `enabledBy` — the baseline never looks
 *  inside one. Empty until the settings arrive, so a tab appears when its
 *  switch is known to be on rather than before. */
export function useAddonSettings(): Record<string, unknown> {
  const [addons, setAddons] = useState<Record<string, unknown>>(cachedAddons);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getSettings()
        .then((s) => {
          if (!alive) return;
          cachedAddons = (s.addons as Record<string, unknown>) ?? {};
          setAddons(cachedAddons);
        })
        .catch(() => { /* an older backend has no addons key: no tabs, no noise */ });
    };
    load();
    window.addEventListener("app-mode-changed", load);
    return () => { alive = false; window.removeEventListener("app-mode-changed", load); };
  }, []);

  return addons;
}

export function useAppMode(): AppSettings {
  const [mode, setMode] = useState<AppSettings>(cached ?? DEFAULT);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getSettings()
        .then((s) => {
          if (!alive || !s.app) return;
          cached = s.app;
          setMode(s.app);
        })
        .catch(() => { /* keep whatever we last knew */ });
    };
    load();
    // Settings writes the new mode and shouts; every surface re-reads
    window.addEventListener("app-mode-changed", load);
    return () => { alive = false; window.removeEventListener("app-mode-changed", load); };
  }, []);

  return mode;
}
