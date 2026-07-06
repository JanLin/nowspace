/* ── Contexts: work / volunteer / personal ─────────────────────
   Convention: trailing @tokens on a task line are Nowspace metadata,
   never shown in the label. @w/@v/@p force a context; @pin surfaces a
   personal/volunteer task in Work mode. Group prefixes map to contexts
   via the `contexts:` section in config.yaml; unmapped groups and
   ungrouped tasks are personal. Empty mapping = feature off. */

export type CtxName = "work" | "volunteer" | "personal";
export type CtxMode = CtxName | "all";
export type CtxMap = Record<string, string[]>;

export const CTX_TOKEN_RE = /\s*@(w|v|p|pin)\b/gi;
const CTX_OVERRIDES: Record<string, CtxName> = { w: "work", v: "volunteer", p: "personal" };

/** Inline group teaching: "wallet@w: task" assigns the wallet group to work.
    The backend learns the mapping on save/read and auto-cleans the tag;
    the frontend honors it immediately so the task doesn't misfile meanwhile. */
export const GROUP_CTX_TAG_RE = /^([^:@[\]]{2,29}?)@(w|v|p)(\s*:)/i;

export const CTX_TOKEN_OF: Record<CtxName, string> = { work: "@w", volunteer: "@v", personal: "@p" };
export const CTX_EDGE_COLOR: Record<CtxName, string> = {
  work: "#3b82f6",      // blue
  volunteer: "#a855f7", // purple
  personal: "#22c55e",  // green
};

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

/** Resolve a task's context: inline group tag > @token override > group mapping > personal */
export function resolveContext(text: string, ctxMap: CtxMap): CtxName {
  const gt = text.match(GROUP_CTX_TAG_RE);
  if (gt) return CTX_OVERRIDES[gt[2].toLowerCase()];
  const m = text.match(/@(w|v|p)\b/i);
  if (m) return CTX_OVERRIDES[m[1].toLowerCase()];
  const group = groupPrefix(text);
  if (group) {
    const g = group.toLowerCase();
    for (const [ctx, groups] of Object.entries(ctxMap)) {
      if ((groups || []).some((x) => x.toLowerCase() === g)) return (ctx as CtxName) || "personal";
    }
  }
  return "personal";
}

/** Feature is on only when some context has group mappings */
export function ctxFeatureEnabled(ctxMap: CtxMap): boolean {
  return Object.values(ctxMap).some((groups) => (groups || []).length > 0);
}

/** Shared visibility rule:
    - Work mode also admits pinned exceptions
    - Personal mode also admits volunteer tasks (volunteering happens in
      private time; Volunteer mode remains for volunteer-only focus) */
export function taskVisibleInCtxMode(text: string, mode: CtxMode, ctxMap: CtxMap): boolean {
  if (!ctxFeatureEnabled(ctxMap) || mode === "all") return true;
  const ctx = resolveContext(text, ctxMap);
  if (ctx === mode) return true;
  if (mode === "work" && isPinnedText(text)) return true;
  if (mode === "personal" && ctx === "volunteer") return true;
  return false;
}

const CTX_MODE_KEY = "nowspace-ctx-mode";

export function loadCtxMode(): CtxMode {
  const saved = localStorage.getItem(CTX_MODE_KEY);
  return saved === "work" || saved === "volunteer" || saved === "personal" ? saved : "all";
}

export function saveCtxMode(mode: CtxMode): void {
  localStorage.setItem(CTX_MODE_KEY, mode);
  window.dispatchEvent(new CustomEvent("ctx-mode-changed"));
}
