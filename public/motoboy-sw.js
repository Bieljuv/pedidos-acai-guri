'use strict';
// Service worker do MOTOBOY (v1.16.24) — só push: o servidor manda, o
// sistema mostra, mesmo com a página fechada e a tela bloqueada. Tocar
// na notificação abre/foca a página de entregas. Sem cache e sem fetch:
// a página do motoboy tem que estar sempre atualizada.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch { d = { titulo: 'Nova entrega', corpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Nova entrega', {
    body: d.corpo || '',
    icon: '/img/pwa/icon-192.png',
    badge: '/img/pwa/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/motoboy' },
    vibrate: [200, 100, 200],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || '/motoboy';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if (c.url.includes('/motoboy') && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(destino);
    })
  );
});
