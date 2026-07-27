import React from "react";
import { api, type TaskLink } from "./api";

/** Resolve a wiki link to a vault file: the backend's answer first, then an
    exact basename match (Obsidian-style), then a fuzzy search. Null means the
    note genuinely isn't there — callers open the manager so it can be fixed,
    never create a file to paper over it. */
export async function resolveLink(link: TaskLink): Promise<{ path: string; name: string } | null> {
  const label = link.display_text || link.name;
  if (link.resolved_path) return { path: link.resolved_path, name: label };
  try {
    const exact = await api.vaultResolve(link.name);
    if (exact.path) return { path: exact.path, name: exact.name || label };
    const found = await api.vaultSearch(link.name, 1);
    if (found.results.length > 0) return { path: found.results[0].path, name: found.results[0].name };
  } catch { /* treat as missing */ }
  return null;
}

/* ── Short press vs long press on one icon ─────────────────
   The task rows are already dense with icons, so 🔗 carries both jobs:
   tap opens the note, hold opens the link manager (right-click does too on
   desktop). Press state is module-level on purpose — only one finger or
   cursor can be pressing at a time, and keeping it out of the component
   means a re-render mid-press can't strand the timer and let one press
   fire both actions. Movement past a few pixels cancels, so dragging a
   task that starts on the icon never counts as a hold. */

const MOVE_CANCEL_PX = 8;

let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressFired = false;
let pressOrigin: { x: number; y: number } | null = null;

function clearPress() {
  if (pressTimer !== undefined) { clearTimeout(pressTimer); pressTimer = undefined; }
}

export function longPressProps(opts: {
  onShort: (el: HTMLElement) => void;
  onLong: (el: HTMLElement) => void;
  ms?: number;
}) {
  const ms = opts.ms ?? 450;
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button === 2) return; // right-click goes through onContextMenu
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      clearPress();
      pressFired = false;
      pressOrigin = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = undefined;
        pressFired = true;
        pressOrigin = null;
        opts.onLong(el);
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pressOrigin) return;
      if (Math.abs(e.clientX - pressOrigin.x) > MOVE_CANCEL_PX || Math.abs(e.clientY - pressOrigin.y) > MOVE_CANCEL_PX) {
        clearPress();
        pressOrigin = null;
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      const wasPressing = pressOrigin !== null;
      clearPress();
      pressOrigin = null;
      if (!pressFired && wasPressing) opts.onShort(el);
      pressFired = false;
    },
    onPointerCancel: () => { clearPress(); pressOrigin = null; },
    onPointerLeave: () => { clearPress(); pressOrigin = null; },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearPress();
      pressOrigin = null;
      pressFired = true;
      opts.onLong(e.currentTarget as HTMLElement);
    },
    // The action already ran on pointerup; swallow the synthesised click so
    // the row underneath doesn't drop into text-edit mode behind the popup.
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); },
  };
}
