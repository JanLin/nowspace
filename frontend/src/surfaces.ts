/* The extension seam on the frontend — a tab, and (seam 5) a source of
   schedulable items.

   An extension imports NOTHING from here. The generated addons.generated.ts
   passes this module to its `register(host)` at import time, before the app
   renders, and the extension declares the NowspaceHost type locally. That is
   what lets an extension build with no alias, no tsconfig path mapping and
   no `external` entry — and React stays single-copy, since a second bundled
   copy gives you hooks that throw.

   The baseline registers nothing. With an empty registry every one of these
   functions is a no-op and navigation is exactly what it was. */

import type React from "react";

/** The version of what `register(host)` receives — the UI half of HOST_API.
 *  Additive changes (another member, another optional field) do not move it;
 *  removing or changing one does, on a minor release. An extension checks it
 *  and refuses a host it doesn't know rather than failing halfway through
 *  registering. */
export const HOST_UI_API = 1;

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

/* ── What an extension is handed ───────────────────────────────────── */

/** The object passed to an extension's `register()`.
 *
 *  Handed in rather than imported, because an extension cannot import from
 *  the baseline: it is not a published package, and an alias would need a
 *  matching tsconfig path in every extension plus an `external` entry in its
 *  bundler, and would still behave differently in dev and in a build. An
 *  argument needs none of that — the extension declares this type locally and
 *  imports nothing from here at build time, which is also what keeps React
 *  single-copy.
 *
 *  Copy this type into an extension (or take it from a types-only package
 *  later); it is the whole of the frontend contract. */
export type NowspaceHost = {
  HOST_UI_API: number;
  registerSurface: (s: Surface) => void;
  registerWeekSource: (s: WeekSource) => void;
  surfaceEnabled: (s: Surface, settings: unknown) => boolean;
  externalRef: (text: string) => string | null;
  /** Added after HOST_UI_API 1 shipped — additive, so the version holds.
   *  An extension written against the older shape checks for it. */
  showSurface: (id: string) => boolean;
};

/* ── Navigation ────────────────────────────────────────────────────── */

let surfaceOpener: ((id: string) => void) | null = null;

/** The app hands its view setter in at mount. Baseline-internal — an
 *  extension never calls this. */
export const _registerSurfaceOpener = (fn: ((id: string) => void) | null) => {
  surfaceOpener = fn;
};

/** Switch the app to a view — a baseline one ("week", "bucket", "notes",
 *  "habits", "time") or a registered surface's id. Navigation only: nothing
 *  is read, written or refreshed on the way, and an unknown id simply shows
 *  the empty view the app already shows for one. Returns false when no app
 *  is mounted to navigate. */
export const showSurface = (id: string): boolean => {
  if (!surfaceOpener) return false;
  surfaceOpener(id);
  return true;
};

/* ── Week sources ──────────────────────────────────────────────────── */

/** One schedulable thing from somewhere that is not the bucket. */
export type WeekItem = {
  /** Stable within the source. Written onto the week line as `~x<6 hex>`,
   *  which is how the line finds its way back here after a carry-forward or
   *  an archive — including on an instance where the source isn't installed,
   *  because the baseline carries the token without reading it. */
  ref: string;
  text: string;
  /** Optional ISO date the source considers this due. The baseline does not
   *  schedule from it, warn about it, or count it. */
  due?: string;
};

export type WeekSource = {
  id: string;
  /** What is available to schedule. Read-only: the baseline never writes
   *  back through this, and an item appears in a week only when the user
   *  puts it there. */
  list: () => Promise<WeekItem[]>;
  /** The user dropped an item into a day. The source records that however it
   *  likes; the baseline writes the week line with the `~x` token. */
  schedule: (item: WeekItem, day: string) => Promise<void>;
  /** The user ticked the line off. */
  complete: (ref: string) => Promise<void>;
};

const sources: WeekSource[] = [];

/** Registration point only in Stage 0 — no provider ships, so Plan Week is
 *  exactly what it was. What a source may do is deliberately narrow: offer
 *  items, be told one was scheduled, be told one was completed. It never
 *  writes a week file or a bucket file itself, so `extra="forbid"`, the
 *  client-version guard and the mtime guard all keep working. */
export const registerWeekSource = (s: WeekSource) => {
  const at = sources.findIndex((r) => r.id === s.id);
  if (at >= 0) sources[at] = s;
  else sources.push(s);
};

export const weekSources = (): WeekSource[] => [...sources];

/** The `~x<hex>` reference on a week line, or null. Colon-free: a colon on
 *  a week line is read as a "Group:" prefix. Six hex minimum — a generator-
 *  stamped id — and up to forty, because a source without ids yet may key
 *  items by content hash, and a longer ref must round-trip unharmed. */
export const externalRef = (text: string): string | null => {
  const m = (text || "").match(/~x([0-9a-f]{6,40})\b/i);
  return m ? m[1].toLowerCase() : null;
};
