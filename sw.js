// Offline cache for the app shell. Bump VERSION when you change any file.
const VERSION = 'v7';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'words2000.js', 'sentences.js', 'manifest.json', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', e => {
  // cache:'reload' skips the browser's HTTP cache so a fresh copy is stored
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Always ask the server for the latest file (cache:'no-cache' revalidates instead of reusing a stale copy);
// fall back to the offline copy when there is no signal. API calls are never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
