/* BuzzHub service worker: delivers buzzer alerts as phone notifications, even when the page is closed. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
