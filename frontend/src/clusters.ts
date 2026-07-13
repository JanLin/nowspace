import type { CSSProperties } from "react";

// Toolbar cluster styling — the same label means the same color on every
// tab: Tag = blue (context chips), View = violet (layout/period switches),
// Filter = amber (what's shown). Low-alpha tints stay pastel in both themes.
export const CLUSTER: Record<"tag" | "view" | "filter", CSSProperties> = {
  tag: { border: "1px solid hsl(215 45% 55% / 0.35)", backgroundColor: "hsl(215 60% 55% / 0.08)" },
  view: { border: "1px solid hsl(270 40% 60% / 0.35)", backgroundColor: "hsl(270 55% 60% / 0.08)" },
  filter: { border: "1px solid hsl(40 55% 50% / 0.35)", backgroundColor: "hsl(40 65% 55% / 0.08)" },
};

export const CLUSTER_LABEL = "text-[9px] uppercase tracking-wider select-none";
