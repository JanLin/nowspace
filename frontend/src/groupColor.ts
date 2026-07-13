// Stable pastel accent per group name: hash → hue, applied as alpha tints
// so the wash stays soft on both light and dark surfaces. Casing variants
// of the same group get the same color.
export function groupAccent(name: string): { border: string; bg: string; dot: string } {
  const key = name.trim().toLowerCase();
  if (!key) return { border: "var(--border)", bg: "transparent", dot: "var(--text-tertiary)" };
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    border: `hsl(${hue} 45% 55% / 0.55)`,
    bg: `hsl(${hue} 55% 55% / 0.10)`,
    dot: `hsl(${hue} 50% 55% / 0.9)`,
  };
}
