import { useEffect, useState } from "react";
import { api, type AppSettings } from "./api";

/** Basic is plain GTD. Advanced is the funnel: stages, shaping, sizes, the
 *  review and the Slate. Handoff (agent dispatch) is its own switch.
 *
 *  Advanced is the default until the settings load, so an existing user never
 *  sees their funnel blink out on a slow start. */
const DEFAULT: AppSettings = { mode: "advanced", funnel: true, handoff: false };

let cached: AppSettings | null = null;

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
