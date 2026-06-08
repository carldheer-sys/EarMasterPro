const CACHE_NAME = 'ear-master-desktop-v2'
const APP_SHELL = ['/', '/manifest.desktop.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone()
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
      return response
    }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/')))
  )
})
