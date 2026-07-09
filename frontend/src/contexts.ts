/* ── Contexts: work / volunteer / personal / custom ────────────
   Convention: trailing @tokens on a task line are Nowspace metadata,
   never shown in the label. A single-letter tag (@w, @f, …) forces a
   context; @pin surfaces a non-work task while Work is selected.
   Group prefixes map to contexts via the `contexts:` section in
   config.yaml; tag letters map to context names via `context_tags:`.
   Unknown letters auto-create a context named after the letter — the
   backend persists it on save, and it can be renamed in Settings.
   Unmapped groups and ungrouped tasks are personal. */

export type CtxName = string; // "work" | "volunteer" | "personal" | custom
export type CtxMap = Record<string, string[]>; // context name → group prefixes
export type CtxTags = Record<string, string>;  // tag letter → context name

export const DEFAULT_CTX_TAGS: CtxTags = { w: "work", v: "volunteer", p: "personal" };

/** Any single-letter tag or @pin — used to strip metadata from labels.
    Single letters only, so "email @john" is never touched. */
export const CTX_TOKEN_RE = /\s*@(pin|[a-z])\b(?!\w)/gi;

/** Inline group teaching: "wallet@w: task" assigns the wallet group to work.
    The backend learns the mapping on save/read and auto-cleans the tag;
    the frontend honors it immediately so the task doesn't misfile meanwhile. */
export const GROUP_CTX_TAG_RE = /^([^:@[\]]{2,29}?)@([a-z])(\s*:)/i;

const EDGE_COLORS: Record<string, string> = {
  work: "#3b82f6",      // blue
  volunteer: "#a855f7", // purple
  personal: "#22c55e",  // green
};
// Palette for custom contexts, assigned deterministically by name
const CUSTOM_PALETTE = ["#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6", "#ef4444", "#84cc16"];

export function ctxEdgeColor(name: CtxName): string {
  if (EDGE_COLORS[name]) return EDGE_COLORS[name];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CUSTOM_PALETTE[h % CUSTOM_PALETTE.length];
}

/** Chip highlight classes per context (custom contexts share amber) */
export function ctxChipClass(name: CtxName): string {
  if (name === "work") return "bg-blue-100 text-blue-700";
  if (name === "volunteer") return "bg-purple-100 text-purple-700";
  if (name === "personal") return "bg-green-100 text-green-700";
  return "bg-amber-100 text-amber-700";
}

/** The @token that assigns a context, from the tag table (e.g. work → "@w") */
export function ctxTokenOf(name: CtxName, tags: CtxTags): string {
  for (const [abbrev, ctx] of Object.entries(tags)) {
    if (ctx === name) return `@${abbrev}`;
  }
  return `@${name.charAt(0)}`;
}

/** Remove @tokens from a text for display */
export function stripCtxTokens(text: string): string {
  return text.replace(CTX_TOKEN_RE, "").trim();
}

export function isPinnedText(text: string): boolean {
  return /@pin\b/i.test(text);
}

/** Drop an inline group tag: "wallet@w: task" → "wallet: task" */
export function stripGroupCtxTag(text: string): string {
  return text.replace(GROUP_CTX_TAG_RE, "$1$3");
}

/** Group-prefix extraction (mirrors the parseGroup rule used by the views) */
function groupPrefix(rawText: string): string {
  const text = stripGroupCtxTag(rawText);
  const idx = text.indexOf(":");
  if (idx > 1 && idx < 30) {
    const group = text.slice(0, idx).trim();
    const label = text.slice(idx + 1).trim();
    if (group && group.length > 1 && label && !/^[A-Da-d]\d*$/.test(group) && !group.includes("[") && !group.endsWith("http") && !group.endsWith("https")) return group;
  }
  return "";
}

/** Resolve a tag letter to its context name; unknown letters name themselves */
function ctxOfTag(letter: string, tags: CtxTags): CtxName {
  const l = letter.toLowerCase();
  return tags[l] ?? DEFAULT_CTX_TAGS[l] ?? l;
}

/** Resolve a task's context: inline group tag > @token override > group mapping > personal */
export function resolveContext(text: string, ctxMap: CtxMap, tags: CtxTags = DEFAULT_CTX_TAGS): CtxName {
  const gt = text.match(GROUP_CTX_TAG_RE);
  if (gt) return ctxOfTag(gt[2], tags);
  const m = text.match(/@([a-z])\b(?!\w)/i);
  if (m) return ctxOfTag(m[1], tags);
  const group = groupPrefix(text);
  if (group) {
    const g = group.toLowerCase();
    for (const [ctx, groups] of Object.entries(ctxMap)) {
      if ((groups || []).some((x) => x.toLowerCase() === g)) return ctx || "personal";
    }
  }
  return "personal";
}

/** Feature is on only when some context has group mappings */
export function ctxFeatureEnabled(ctxMap: CtxMap): boolean {
  return Object.values(ctxMap).some((groups) => (groups || []).length > 0);
}

/** All known context names: core three + configured + tag-defined, in stable order */
export function allContextNames(ctxMap: CtxMap, tags: CtxTags): CtxName[] {
  const core = ["work", "volunteer", "personal"];
  const rest = new Set<string>([...Object.keys(ctxMap), ...Object.values(tags)]);
  core.forEach((c) => rest.delete(c));
  return [...core, ...[...rest].sort()];
}

/** The active filter is a set of contexts; empty selection = show everything.
    Combine freely — e.g. Personal + Volunteer for the full private-time view. */
export type CtxSelection = CtxName[];

/** Shared visibility rule: a task shows when its context is selected.
    Pinned tasks also surface while Work is selected. */
export function taskVisibleInCtxSelection(text: string, sel: CtxSelection, ctxMap: CtxMap, tags: CtxTags = DEFAULT_CTX_TAGS): boolean {
  if (!ctxFeatureEnabled(ctxMap) || sel.length === 0) return true;
  const ctx = resolveContext(text, ctxMap, tags);
  if (sel.includes(ctx)) return true;
  if (sel.includes("work") && isPinnedText(text)) return true;
  return false;
}

/* ── Bucket metadata (tilde tokens, hidden from labels) ─────────
   ~w2628 = entered the bucket in ISO week 28 of 2026 (YYWW) — age hint
   ~m     = "this month" GTD horizon on the bucket board */

export const BUCKET_META_RE = /\s*~(w\d{4}|m)\b/gi;

export function stripBucketMeta(text: string): string {
  return text.replace(BUCKET_META_RE, "").trim();
}

/** Entered-week stamp as {yy, week} or null if unstamped */
export function bucketEnteredWeek(text: string): { yy: number; week: number } | null {
  const m = text.match(/~w(\d{2})(\d{2})\b/i);
  return m ? { yy: parseInt(m[1], 10), week: parseInt(m[2], 10) } : null;
}

/** Sortable age key (higher = newer); unstamped sorts newest */
export function bucketAgeKey(text: string): number {
  const w = bucketEnteredWeek(text);
  return w ? w.yy * 100 + w.week : 9999;
}

export function isMonthHorizon(text: string): boolean {
  return /~m\b/i.test(text);
}

export function setMonthHorizon(text: string, on: boolean): string {
  const without = text.replace(/\s*~m\b/gi, "");
  return on ? `${without.trimEnd()} ~m` : without;
}

const CTX_MODE_KEY = "nowspace-ctx-mode";

export function loadCtxSelection(): CtxSelection {
  const saved = localStorage.getItem(CTX_MODE_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) return parsed.filter((c): c is string => typeof c === "string");
  } catch { /* legacy single-mode value */ }
  return ["work", "volunteer", "personal"].includes(saved) ? [saved] : [];
}

export function saveCtxSelection(sel: CtxSelection): void {
  localStorage.setItem(CTX_MODE_KEY, JSON.stringify(sel));
  window.dispatchEvent(new CustomEvent("ctx-mode-changed"));
}
