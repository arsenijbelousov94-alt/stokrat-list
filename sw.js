// sw.js — простой Service Worker для PWA "Реестр участников"
const CACHE_NAME = 'reestr-v1';
const PRECACHE = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API и вебхук — всегда только из сети, никогда не кэшируем
  if (url.pathname === '/api' || url.pathname === '/telegram-webhook') {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push-уведомление пришло без данных (протокол Web Push без шифрованного payload) —
// запрашиваем у сервера, что именно показать.
self.addEventListener('push', (event) => {
  event.waitUntil(
    fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_last_push_notification' })
    })
      .then((res) => res.json())
      .then((data) => {
        return self.registration.showNotification(data.title || 'Реестр участников', {
          body: data.body || 'Новое уведомление',
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          data: { url: data.url || '/' }
        });
      })
      .catch(() => {
        return self.registration.showNotification('Реестр участников', {
          body: 'Новое уведомление',
          icon: '/icons/icon-192.png'
        });
      })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
