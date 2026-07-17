import type { CSSProperties, ReactNode } from "react";

// Toolbar cluster styling — the same label means the same color on every
// tab: Tag = blue (context chips), View = violet (layout/period switches),
// Filter = amber (what's shown). Low-alpha tints stay pastel in both themes.
export const CLUSTER: Record<"tag" | "view" | "filter", CSSProperties> = {
  tag: { border: "1px solid hsl(215 45% 55% / 0.35)", backgroundColor: "hsl(215 60% 55% / 0.08)" },
  view: { border: "1px solid hsl(270 40% 60% / 0.35)", backgroundColor: "hsl(270 55% 60% / 0.08)" },
  filter: { border: "1px solid hsl(40 55% 50% / 0.35)", backgroundColor: "hsl(40 65% 55% / 0.08)" },
};

export const CLUSTER_LABEL = "text-[9px] uppercase tracking-wider select-none";

/* Collapsible cluster: on small screens it renders as a compact chip
   ("TAG ▸ All") that expands on tap — accordion style, the caller owns
   which one is open. From `sm` up it is always expanded and the label
   is inert, so desktop behavior is unchanged. */
export function Cluster({ kind, label, summary, open, onToggle, children }: {
  kind: "tag" | "view" | "filter";
  label: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className={`${open ? "hidden" : "inline-flex"} sm:hidden items-center gap-1 rounded-lg px-1.5 py-1`}
        style={CLUSTER[kind]}
      >
        <span className={CLUSTER_LABEL} style={{ color: "var(--text-tertiary)" }}>{label}</span>
        {summary && <span className="text-[10px] max-w-[7rem] truncate" style={{ color: "var(--text-secondary)" }}>{summary}</span>}
        <span className="text-[9px]" style={{ color: "var(--text-tertiary)" }}>▸</span>
      </button>
      <span
        className={`${open ? "flex" : "hidden"} sm:flex items-center gap-1 flex-wrap rounded-lg px-1.5 py-1`}
        style={CLUSTER[kind]}
      >
        <button
          type="button"
          onClick={onToggle}
          className={`${CLUSTER_LABEL} sm:pointer-events-none`}
          style={{ color: "var(--text-tertiary)" }}
        >
          {label}
        </button>
        {children}
      </span>
    </>
  );
}
