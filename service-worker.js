/* ============================================================
   Labour Job Card System — service-worker.js (PWA Offline)
   Developed by Kurban Ali
   ============================================================ */

const CACHE_NAME = "labour-jobcard-v29";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js?v=31",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

/* Install: cache app shell */
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

/* Activate: purani cache delete + turant sab open tabs control me lo */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Fetch: network-first for Firebase/CDN aur app shell (HTML/JS) —
   taaki naya update turant mile; sirf network fail hone par (offline) cache use ho */
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Firebase / Google auth / database requests — hamesha network
  if (
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com") ||
    url.hostname.includes("firebaseapp.com") ||
    url.hostname.includes("google.com")
  ) {
    return; // browser default (network)
  }

  // App shell — network-first, offline hone par hi cache se dikhao
  if (event.request.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
