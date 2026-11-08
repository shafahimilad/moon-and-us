// Moon&Us service worker — offline app shell + best-effort reminder delivery
const CACHE = 'moonus-v5';
const SHELL = [
  './', './index.html', './css/style.css', './js/content.js', './js/cycle.js', './js/app.js', './js/insights.js',
  './js/cloud.js', './js/firebase-config.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'moonus-reminders').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for app files (updates show immediately), cache fallback offline. Fonts: cache first.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.host.includes('fonts.googleapis.com') || url.host.includes('fonts.gstatic.com')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html'))));
});

// Reminders handed over by the page (next 7 days). Shown when the browser wakes this worker
// (periodic background sync, where supported). Dedup ids live in the same cache.
async function deliverDue() {
  const c = await caches.open('moonus-reminders');
  const res = await c.match('reminders.json'); if (!res) return;
  const list = await res.json();
  const doneRes = await c.match('delivered.json'); const done = new Set(doneRes ? await doneRes.json() : []);
  const now = Date.now();
  for (const r of list) {
    if (r.when <= now && now - r.when < 12 * 3600 * 1000 && !done.has(r.id)) {
      await self.registration.showNotification('Moon&Us', { body: r.body, tag: r.id, icon: 'icons/icon-192.png', lang: 'fa', dir: 'rtl' });
      done.add(r.id);
    }
  }
  await c.put('delivered.json', new Response(JSON.stringify([...done].slice(-200))));
}
self.addEventListener('periodicsync', e => { if (e.tag === 'moonus-reminders') e.waitUntil(deliverDue()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(ws => (ws[0] ? ws[0].focus() : self.clients.openWindow('./index.html#cycle'))));
});
