import { useState, useEffect } from "react";

type Theme = "light" | "dark" | "system";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("nowspace-theme") as Theme | null;
    return stored || "system";
  });

  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      const dark = theme === "dark"
        || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
      // The markdown editor takes its palette from the nearest
      // data-color-mode ancestor. Setting it on <html> means every editor —
      // the note, the day's notes, anything added later — follows the theme
      // without each one having to remember to ask. Both were pinned to
      // "light", which is why a dark app had a white note in it.
      root.setAttribute("data-color-mode", dark ? "dark" : "light");
    };

    applyTheme();
    localStorage.setItem("nowspace-theme", theme);

    // Listen for system preference changes when using "system"
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme();
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  return { theme, setTheme };
}
