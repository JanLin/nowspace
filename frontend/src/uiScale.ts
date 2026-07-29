import { useState, useEffect } from "react";

/** Text size, as a percentage. Deliberately in localStorage rather than the
 *  vault settings file: this is about the screen in front of you, not how you
 *  work. Your Mac, iPad and phone can all be talking to the same Nowspace on
 *  the mini and still each keep their own — browser storage never syncs, which
 *  is exactly what makes it the right home for this. The theme works the same
 *  way. */
const KEY = "nowspace-ui-scale";
export const SCALE_MIN = 80;
// 150 is the last step whose header still fits a 360px phone once the
// tab labels drop; beyond it the top row starts to overflow.
export const SCALE_MAX = 150;
export const SCALE_STEP = 10;

function clamp(n: number): number {
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(n / SCALE_STEP) * SCALE_STEP));
}

function load(): number {
  const raw = parseInt(localStorage.getItem(KEY) || "", 10);
  return Number.isFinite(raw) ? clamp(raw) : 100;
}

/** Apply with CSS zoom, not a root font-size: the app has ~340 hard-coded
 *  px sizes, so rem scaling would move almost nothing. zoom scales the whole
 *  layout the way the browser's own Ctrl +/- does — including the dense task
 *  rows this is mostly needed for. */
function apply(scale: number) {
  const root = document.documentElement;
  root.style.zoom = scale === 100 ? "" : `${scale}%`;
  // The shell is one viewport tall; zoom would render it taller than the
  // screen and hand the document a scrollbar, which is what makes the pinned
  // toolbars drift under the nav. .app-shell divides by this.
  root.style.setProperty("--ui-zoom", String(scale / 100));
  // Media queries don't see zoom — the CSS viewport stays the same width —
  // so the nav can't shed its labels on its own when the row outgrows the
  // screen. Flag it here instead.
  root.classList.toggle("ui-scaled-up", scale > 110);
}

// Applied before React mounts so nothing flashes at the wrong size
apply(load());

/** The desktop app has no Ctrl +/-, so the shortcut is ours to provide there.
 *  In a browser it already works and remembers itself per site — overriding it
 *  would replace something good with something merely equivalent. */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" &&
    (("__TAURI__" in window) || ("__TAURI_INTERNALS__" in window));
}

export function useUiScale() {
  const [scale, setScaleState] = useState<number>(load);

  const setScale = (next: number) => {
    const v = clamp(next);
    setScaleState(v);
    localStorage.setItem(KEY, String(v));
    apply(v);
    window.dispatchEvent(new CustomEvent("ui-scale-changed", { detail: { scale: v } }));
  };

  // Keep every mounted copy of the control in step
  useEffect(() => {
    const onChange = (e: Event) => {
      const v = (e as CustomEvent).detail?.scale;
      if (typeof v === "number") setScaleState(v);
    };
    window.addEventListener("ui-scale-changed", onChange);
    return () => window.removeEventListener("ui-scale-changed", onChange);
  }, []);

  return { scale, setScale, min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP };
}

/** Cmd/Ctrl + = / - / 0, desktop app only. Mounted once, from App. */
export function useUiScaleShortcuts(enabled = isDesktopApp()) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const current = load();
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setStored(current + SCALE_STEP); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setStored(current - SCALE_STEP); }
      else if (e.key === "0") { e.preventDefault(); setStored(100); }
    };
    const setStored = (n: number) => {
      const v = clamp(n);
      localStorage.setItem(KEY, String(v));
      apply(v);
      window.dispatchEvent(new CustomEvent("ui-scale-changed", { detail: { scale: v } }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
