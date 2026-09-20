/**
 * EarMaster Pro service worker.
 *
 * - App shell + static assets: cache-first (immutable build output).
 * - /catalog/* (songs' session JSON, MIDI, audio): cache-first, populated
 *   lazily on first load — once a section has been opened it plays offline.
 * - Everything else: network-first with cache fallback.
 */
const CACHE_NAME = 'earmaster-pro-v1'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/granular-processor.js',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const isCatalog = url.pathname.startsWith('/catalog/')
  const isShell = APP_SHELL.includes(url.pathname) ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/')

  if (isCatalog || isShell) {
    // Cache-first: catalog assets and build output are immutable
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached
        return fetch(request).then(response => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
          }
          return response
        })
      })
    )
    return
  }

  // Network-first for everything else (navigation, API)
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
        }
        return response
      })
      .catch(() => caches.match(request).then(cached => cached || caches.match('/')))
  )
})
