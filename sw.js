// Service worker: answers every request for the game's own files from the cache that
// js/offline.js fills (keyed by path, without the ?v= version), so the game runs offline.
// Anything not cached yet goes to the network as usual. The manifest and the downloader's
// own requests (?h=) always go to the network.
const CACHE = 'sgp-assets-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url), scope = self.registration.scope;
  if (url.origin !== self.location.origin || !url.href.startsWith(scope)) return;
  if (url.searchParams.has('h') || url.searchParams.has('t')) return;
  let rel = url.pathname.slice(new URL(scope).pathname.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (rel === 'assets/manifest.json') return;
  e.respondWith(caches.open(CACHE).then(c => c.match(scope + rel)).then(hit => hit || fetch(req)));
});
