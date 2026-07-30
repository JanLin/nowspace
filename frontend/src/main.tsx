import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { installDragAutoScroll } from "./dragScroll";

// One listener for every drag in the app — tasks, groups, bucket and carry
// rows — so a drag can reach past the edge of the screen.
installDragAutoScroll();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Offline support: the service worker precaches the shell and serves the
// last-known data when the backend is unreachable. Skipped in dev (HMR
// and service workers fight over freshness).
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline support is best-effort */ });
  });
}
