/* BuzzHub service worker: delivers buzzer alerts as phone notifications, even when the page is closed. */
const SHELL = 'buzzhub-shell-v4';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png']).catch(() => {}))); });
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

/* Offline: the app itself opens without a connection. API calls are never cached. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); return res; }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|woff2?)$/.test(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); } return res; })));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'BuzzHub', body: event.data?.text() }; }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  const urgent = data.kind === 'buzz';
  event.waitUntil((async () => {
    // Tell any open buzzer page so it can play its alarm too
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'push', data }));
    await self.registration.showNotification(data.title || 'BuzzHub', {
      body: data.body || '',
      tag: data.tag || 'buzzhub',
      renotify: true,
      requireInteraction: urgent,
      vibrate: urgent ? [500, 200, 500, 200, 900] : [200, 100, 200],
      icon: '/icon-512.png',
      badge: '/icon-192.png',
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname === url && 'focus' in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
