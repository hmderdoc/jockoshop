// jockoshop service worker: the editor keeps working offline once it has been visited.
// Registered by main.ts in production builds only (not in dev, not in the Tauri shell).
//
// What is cached how:
//   - the page itself and tdfonts/index.json: network first, the cache when offline
//   - /assets/* (hashed by Vite, so a URL never changes content): cache first
//   - fonts, shadeans.wasm, the icon and manifest: the cache, refreshed in the background
// There is no build-time list of files: install reads index.html and caches what it links to.
const CACHE = "jockoshop-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.png", "/shadeans.wasm", "/tdfonts/index.json"];

const linkedAssets = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const index = await fetch("/index.html", { cache: "no-cache" });
    const urls = [...SHELL, ...linkedAssets(await index.clone().text())];
    await cache.put("/index.html", index);
    // each on its own: a build without shadeans.wasm must still install
    await Promise.allSettled(urls.map((u) => cache.add(new Request(u, { cache: "no-cache" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

/** After a fresh index.html: drop cached bundles the new build no longer links to. */
async function pruneAssets(cache, html) {
  const keep = new Set(linkedAssets(html));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    // the raw VGA font is linked from the JS, not the page; keep anything that is not a script or stylesheet
    if (path.startsWith("/assets/") && /\.(js|css)$/.test(path) && !keep.has(path)) await cache.delete(req);
  }
}

async function networkFirst(cache, req, fallbackKey) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(fallbackKey, res.clone());
      if (fallbackKey === "/index.html") void pruneAssets(cache, await res.clone().text());
    }
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackKey);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(cache, req) {
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(cache, req) {
  const hit = await cache.match(req);
  const refresh = fetch(req).then(async (res) => { if (res.ok) await cache.put(req, res.clone()); return res; });
  if (hit) { refresh.catch(() => {}); return hit; }
  return refresh;
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (request.mode === "navigate" || url.pathname === "/index.html") return networkFirst(cache, request, "/index.html");
    if (url.pathname === "/tdfonts/index.json") return networkFirst(cache, request, url.pathname);
    if (url.pathname.startsWith("/assets/")) return cacheFirst(cache, request);
    return staleWhileRevalidate(cache, request);
  })());
});
