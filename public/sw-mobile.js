const CACHE_NAME = 'ear-master-mobile-v2'
const APP_SHELL = ['/', '/manifest.mobile.webmanifest', '/Saved_Sessions/catalog.json', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  const networkFirst = url.pathname.startsWith('/Saved_Sessions/')
  event.respondWith(
    networkFirst
      ? fetch(event.request).then(response => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
          return response
        }).catch(() => caches.match(event.request))
      : caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
          return response
        }).catch(() => caches.match('/')))
  )
})
