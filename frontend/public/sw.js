// Nowspace service worker — offline layers 1+2.
//
// Layer 1 (shell): the app opens with no connectivity. Navigations are
// network-first with the last good index.html as fallback; hashed assets
// are cache-first (immutable by construction).
//
// Layer 2 (data): API GETs are network-first; when the backend is
// unreachable (offline, or Tailscale down) the last good response is
// served instead, marked with X-Nowspace-Offline so the app can show the
// read-only banner with the data's age. Writes are never intercepted —
// they fail honestly.
//
// Deliberately NOT cached: /version.json and /update-check, so the
// update pill never reports from cache.

const VERSION = "v1";
const ASSETS = `nowspace-assets-${VERSION}`;
const DATA = `nowspace-data-${VERSION}`;
const NEVER_CACHE = ["/version.json", "/update-check"];
const DATA_PREFIXES = ["/plan/", "/time/", "/api/", "/memory", "/health"];

self.addEventListener("install", (e) => {
  // Precache the shell AND the assets it references — on the very first
  // visit the page's own asset requests happen before this worker takes
  // control, so cache-as-you-go alone would leave a shell with no script.
  e.waitUntil((async () => {
    const c = await caches.open(ASSETS);
    const res = await fetch("/");
    await c.put("/", res.clone());
    const html = await res.text();
    const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith("/assets/") || u.endsWith(".svg") || u.endsWith(".webmanifest"));
    await Promise.all(urls.map((u) => c.add(u).catch(() => { /* best effort */ })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== ASSETS && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Store a response with the time it was fetched
function stamped(res) {
  const h = new Headers(res.headers);
  h.set("sw-cached-at", new Date().toISOString());
  return res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers: h }));
}

// Serve a cached response marked as an offline fallback
function asOffline(res) {
  const h = new Headers(res.headers);
  h.set("X-Nowspace-Offline", h.get("sw-cached-at") || "");
  return res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers: h }));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.includes(url.pathname)) return;

  // App shell: network-first so deploys land, cached fallback so it opens
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(ASSETS).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Static assets: hashed filenames never change content — cache-first
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/help/")
    || url.pathname.endsWith(".svg") || url.pathname.endsWith(".png")
    || url.pathname === "/manifest.webmanifest") {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)); }
          return res;
        })
      )
    );
    return;
  }

  // API data: network-first, last-good fallback marked offline
  if (DATA_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) stamped(res.clone()).then((s) => caches.open(DATA).then((c) => c.put(req, s)));
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => (hit ? asOffline(hit) : Response.error()))
        )
    );
  }
});
