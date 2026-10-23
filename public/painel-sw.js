'use strict';
// Service worker do PAINEL (v1.9.19) — o painel como "app" instalável.
// REGRA DE OURO: nunca servir dado velho. Estratégia = rede primeiro em
// tudo; o cache só aparece se a rede cair (a tela abre com o último estado).
// /api NUNCA passa pelo SW: pedido, tempo real (SSE) e login vão direto.
const CACHE = 'painel-app-v1';
const ESSENCIAIS = [
  '/painel', '/painel.css', '/painel.js', '/icons.js',
  '/img/pwa/icon-192.png', '/img/pwa/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ESSENCIAIS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// PUSH (v1.9.20): o servidor manda, o sistema mostra — mesmo com o app
// fechado e a tela bloqueada. Tocar na notificação abre/foca o painel.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch { d = { titulo: 'Novo pedido', corpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Novo pedido', {
    body: d.corpo || '',
    icon: '/img/pwa/icon-192.png',
    badge: '/img/pwa/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/painel' },
    vibrate: [120, 60, 120],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || '/painel';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if (c.url.includes('/painel') && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(destino);
    })
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API e tempo real: rede direta
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok && (url.pathname === '/painel'
          || /\.(css|js|png|svg|mp3|ico)$/.test(url.pathname))) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
