const SETUP_BUILD = 'finish2';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async()=>{
 await clients.claim();
 const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
 for(const client of windows){
  const url=new URL(client.url);
  if(url.origin===self.location.origin && url.pathname==='/push-preview-v2/' && url.searchParams.get('build')!==SETUP_BUILD){
   await client.navigate('/push-preview-v2/?build='+SETUP_BUILD);
  }
 }
})()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'BreakerOps', {
    body: d.body || '',
    tag: typeof d.tag === 'string' && /^chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.tag) ? d.tag : undefined,
    renotify: false,
    icon: '/assets/img/brand-icon-v2.png',
    badge: '/assets/img/brand-icon-v2.png',
    data: { url: d.url || 'https://www.breakerops.com/push-preview-v2/calendar/' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || 'https://www.breakerops.com/push-preview-v2/calendar/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('breakerops.com') && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    return clients.openWindow(url);
  }));
});
