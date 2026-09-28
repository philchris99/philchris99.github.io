// Offline-Unterstützung: App-Seite und Logos im Gerät zwischenspeichern.
// Daten (/api/…) werden nicht hier gespeichert – das macht die App selbst (letzter Stand + Warteschlange).
const CACHE = 'strauss-v6';
const SHELL = ['/', '/bau', '/bau.webmanifest', '/i18n-hu.js', '/logo.png', '/logo-house.png', '/logo-strauss.png', '/logo-wordmark.png', '/manifest.webmanifest', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Handwerker-Anleitung und ihre geschützten Fotos nicht im App-Speicher ablegen
  // Dokumente für Gäste (Rechnung, Wohnungsgeberbestätigung) ebenfalls nicht
  if (/^\/(anleitung|dok)(\/|$)/.test(url.pathname) || url.pathname.startsWith('/g/') || url.pathname.endsWith('.pdf') || url.pathname === '/pdf-lib.min.js') return;
  if (req.mode === 'navigate') { // immer die neueste Version, ohne Netz die gespeicherte
    const page = /^\/bau(\/|$)/.test(url.pathname) ? '/bau' : '/'; // Baustellenassistent getrennt speichern
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(page, copy)); }
      return res;
    }).catch(() => caches.match(page)));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});
