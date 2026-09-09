/* StayLog Service Worker — offline support with same-day updates

   App shell (index.html, app.js, manifest) is network-first: a deploy shows up
   on the next launch that has a connection, and falls back to cache offline.
   Fonts and libraries are cache-first — they never change under a fixed URL. */
const CACHE_NAME = 'staylog-v6';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Prata&family=Manrope:wght@400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(ASSETS.map(a => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isAppShell = req => {
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  return req.mode === 'navigate' || /\.(html|js|json)$/.test(url.pathname) || url.pathname.endsWith('/');
};

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  if (isAppShell(e.request)) {
    // Newest code wins; the cache is the fallback, not the default
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
          }
          return res;
        })
        // Offline: serve the cached copy. index.html is a fallback for page
        // loads only — handing it to a script request would execute HTML as JS.
        .catch(() => caches.match(e.request).then(hit =>
          hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  // Versioned third-party assets: cache first, they never change
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
