/* StayLog Service Worker

   It caches exactly two kinds of thing, and nothing else:

     1. The app's own files (same origin). Network-first: a deploy shows up on
        the next launch that has a connection, and the cache is the fallback
        when offline.
     2. A short, NAMED list of static third-party assets — the fonts and the
        icon font. Cache-first, because they never change under a fixed URL.

   Every other request goes straight to the network, as if this file did not
   exist. That rule is the whole point of the file, and it is an allowlist on
   purpose.

   The version this replaces cached ANY cross-origin GET as a "third-party
   asset". That swept up the Supabase API: the first answer to "which
   attendance marks exist?" was stored, and every sync afterwards was handed
   that same stored answer without the database ever being asked. New marks
   never appeared until a deploy happened to clear the cache, which made each
   release look like a fix and each next day look like a regression. Live data
   must never be served from a cache, so live data is now never even looked at
   here — it is not on the list. */

const CACHE_NAME = 'staylog-v46';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './cloud.js',
  './cloud-config.js',
  './vendor/supabase.umd.js',
  './manifest.json',
  './staff.html',
  './staff.js',
  './vendor/jspdf.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Prata&family=Manrope:wght@400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css',
];

// The only third-party hosts whose responses may be kept. Fonts and an icon
// font: static, public, versioned by URL. Supabase is deliberately absent.
const STATIC_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
]);

// Decides, for one request, whether this worker touches it at all.
//   'shell'  — the app's own code and pages: network-first
//   'static' — fonts, icons, vendored libraries: cache-first
//   null     — not ours. The browser fetches it untouched.
function routeFor(req) {
  if (req.method !== 'GET') return null;
  // A request carrying credentials is somebody's data, whatever its URL.
  // Belt and braces: the allowlist below already excludes the API, and this
  // keeps it excluded even if an API ever ends up on the app's own origin.
  if (req.headers && req.headers.get && req.headers.get('authorization')) return null;

  let url;
  try { url = new URL(req.url); } catch (e) { return null; }

  if (url.origin === self.location.origin) {
    const p = url.pathname;
    if (p.includes('/vendor/')) return 'static';                 // pinned by version
    if (/\.(png|svg|ico|jpg|jpeg|webp|woff2?)$/i.test(p)) return 'static';
    if (req.mode === 'navigate' || /\.(html|js|json|webmanifest)$/i.test(p) || p.endsWith('/'))
      return 'shell';
    return null;
  }

  if (url.protocol === 'https:' && STATIC_HOSTS.has(url.hostname)) return 'static';
  return null;
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(ASSETS.map(a => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

// Every cache from an earlier version is deleted outright. That is what
// clears the stale API answers the previous worker had stored.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  // 'no-cache' asks the server every time (a 304 when nothing changed). Without
  // it the browser's own HTTP cache could answer: GitHub Pages allows 10
  // minutes, and a release that changed only cloud-config.js was not seen.
  return fetch(req, { cache: 'no-cache' })
    .then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
        return res;
      }
      // A 5xx, a 404 or a captive-portal page is not a new deploy — keep
      // serving what we already have rather than breaking the app.
      return caches.match(req).then(hit => hit || res);
    })
    // Offline. index.html stands in for page loads only — handing it to a
    // script request would execute HTML as JavaScript.
    .catch(() => caches.match(req).then(hit =>
      hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
}

function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && res.status === 200 && res.type !== 'opaque') {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(req, copy));
    }
    return res;
  // A missing font or library offline is an honest failure. The previous
  // version answered it with index.html, which is never the right answer.
  }).catch(() => Response.error()));
}

self.addEventListener('fetch', e => {
  const kind = routeFor(e.request);
  if (!kind) return;                       // not ours to touch
  e.respondWith(kind === 'shell' ? networkFirst(e.request) : cacheFirst(e.request));
});

// Lets the page ask which worker is actually running, so "did my upload
// land?" has an answer on screen.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'version' && e.ports && e.ports[0])
    e.ports[0].postMessage({ cache: CACHE_NAME });
});

// ── Push notifications ──────────────────────────────────────────────────────
// Nothing here touches the cache: these handlers only show and open.
//
// Every push shows a visible notification, even one that cannot be read. iOS
// revokes a subscription after pushes that show nothing, so there is no
// silent path. The payload ({title, body, url, tag}) is written by the Edge
// Function supabase/functions/notify.
function notificationFor(data) {
  let m = null;
  try { m = data && data.json(); } catch (e) { m = null; }
  if (!m || typeof m !== 'object') m = {};
  const title = String(m.title || 'StayLog');
  return { title, options: {
    body: String(m.body || 'Open StayLog to see what changed.'),
    tag: m.tag ? String(m.tag) : undefined,
    icon: './icons/icon-192.png',
    data: { url: clickTarget(m.url) },
  } };
}

// Only the app's own pages may be opened from a notification.
function clickTarget(url) {
  const scope = (self.registration && self.registration.scope) || (self.location.origin + '/');
  try {
    const u = new URL(url || './', scope);
    if (u.origin === self.location.origin) return u.href;
  } catch (e) { /* fall through */ }
  return new URL('./', scope).href;
}

self.addEventListener('push', e => {
  const n = notificationFor(e.data);
  e.waitUntil(self.registration.showNotification(n.title, n.options));
});

// A tap opens the booking or screen it is about. An app already open is
// brought forward and told where to go; otherwise it opens at that address.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = clickTarget(e.notification.data && e.notification.data.url);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url && c.url.startsWith(new URL('./', url).href));
    if (open) {
      open.postMessage({ type: 'open', url });
      return open.focus ? open.focus() : open;
    }
    return self.clients.openWindow(url);
  }));
});

// Exposed for tests, which load this file outside a browser.
if (typeof module !== 'undefined') module.exports = { routeFor, STATIC_HOSTS, CACHE_NAME, notificationFor, clickTarget };
