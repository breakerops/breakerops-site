self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'BreakerOps', {
    body: d.body || '',
    icon: '/assets/img/brand-icon-v2.png',
    badge: '/assets/img/brand-icon-v2.png',
    data: { url: d.url || 'https://www.breakerops.com/push-preview/calendar/' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || 'https://www.breakerops.com/push-preview/calendar/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('breakerops.com') && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    return clients.openWindow(url);
  }));
});
