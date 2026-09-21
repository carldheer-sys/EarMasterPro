/**
 * EarMaster Pro service worker.
 *
 * Versioning: __SW_VERSION__ is replaced with a unique build id during
 * `vite build`, so every deploy installs a new SW and the old cache is
 * deleted on activate — no stale content survives an update.
 *
 * Strategies:
 * - Navigations (/, index.html): network-first, cached copy as offline
 *   fallback. The HTML references content-hashed assets, so serving a stale
 *   index would point at files that no longer exist — it must stay fresh.
 * - /catalog/catalog.json + session.eartrainer.json: network-first — small,
 *   correctness-critical metadata that changes when the catalog is rebuilt.
 * - /assets/*, /icons/*, /catalog binaries (.mid/.mp3/.html), misc public
 *   files: cache-first (immutable per build; a version bump evicts them).
 * - Everything else: network-first with cache fallback.
 */
const CACHE_NAME = 'earmaster-pro-__SW_VERSION__'
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

const cachePut = (request, response) => {
  if (response.ok) {
    const copy = response.clone()
    caches.open(CACHE_NAME).then(cache => cache.put(request, copy))
  }
  return response
}

const networkFirst = (request, fallbackUrl) =>
  fetch(request)
    .then(response => cachePut(request, response))
    .catch(() => caches.match(request).then(cached => cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined)))

const cacheFirst = (request) =>
  caches.match(request).then(cached =>
    cached || fetch(request).then(response => cachePut(request, response)))

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Navigations must never be served stale: index.html points at hashed
  // assets that change every build.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request, '/'))
    return
  }

  // Catalog manifest + session metadata: small files that change whenever
  // the catalog is regenerated — always prefer the network.
  if (url.pathname === '/catalog/catalog.json' ||
      url.pathname.endsWith('/session.eartrainer.json')) {
    event.respondWith(networkFirst(request))
    return
  }

  // Immutable-per-build assets: hashed bundles, icons, catalog binaries.
  const isImmutable = APP_SHELL.includes(url.pathname) ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/catalog/')
  if (isImmutable) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Everything else (e.g. CDN sample fetches): network-first, cache fallback
  event.respondWith(networkFirst(request))
})
