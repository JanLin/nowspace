/* The extension seam on the frontend — a tab, and (seam 5) a source of
   schedulable items.

   An extension imports `registerSurface` from here and nothing else from the
   baseline except React, which the host provides: bundling a second copy
   gives you two Reacts and hooks that throw. Registration happens at import
   time, from the generated `addons.generated.ts`, before the app renders.

   The baseline registers nothing. With an empty registry every one of these
   functions is a no-op and navigation is exactly what it was. */

import type React from "react";

export type Surface = {
  /** Stable id, matching the extension: "relay" for nowspace-relay. Also the
   *  route prefix (/api/relay/*) and the settings key (relay.enabled). */
  id: string;
  icon: string;
  name: string;
  /** Where it sits in the nav. The built-ins are 10 Plan, 20 Bucket,
   *  30 Notes, 40 Habits, 50 Time, 90 Settings — so 25 lands between Bucket
   *  and Notes. Unset sorts after the built-ins but before Settings. */
  order?: number;
  /** Dotted path into the vault settings, e.g. "relay.enabled". Absent means
   *  always on. A surface whose flag is off is not rendered at all — not
   *  hidden with CSS, not mounted. */
  enabledBy?: string;
  component: React.ComponentType<{ onOpenNote: (path: string, name: string) => void }>;
};

const registered: Surface[] = [];

export const registerSurface = (s: Surface) => {
  // Last registration of an id wins, so a reload during development doesn't
  // stack duplicates of the same tab.
  const at = registered.findIndex((r) => r.id === s.id);
  if (at >= 0) registered[at] = s;
  else registered.push(s);
};

/** A copy, so a caller iterating can't reorder the registry underneath. */
export const surfaces = (): Surface[] => [...registered];

/** Resolve a surface's `enabledBy` against the settings blob.
 *
 *  Pure and total: an unknown path, a settings object that hasn't loaded, or
 *  a non-boolean value all read as off. A tab that appears because a fetch
 *  failed is worse than one that stays away. */
export const surfaceEnabled = (s: Surface, settings: unknown): boolean => {
  if (!s.enabledBy) return true;
  let node: unknown = settings;
  for (const key of s.enabledBy.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return node === true;
};

/* ── Seam 5 lands here: registerWeekSource ─────────────────────────── */
