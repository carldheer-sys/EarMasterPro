/**
 * EarMaster Pro service worker.
 *
 * Versioning: __SW_VERSION__ is replaced with a unique build id during
 * `vite build`, so every deploy installs a new SW and the old cache is
 * deleted on activate — no stale content survives an update.
 *
 * CarPlay / iOS WebKit Optimizations:
 * - Pre-caches all 16 Sonofield Synth MP3s and 12 Sonofield Drone MP3s on
 *   install so zero network requests are needed in the car.
 * - Synthesizes RFC 7233 `206 Partial Content` responses (`Content-Range`,
 *   `Accept-Ranges: bytes`) directly from cached ArrayBuffers when WebKit
 *   issues `Range: bytes=start-end` audio requests.
 * - Bounds `networkFirst` metadata fetches to a 1200ms timeout before serving
 *   the cached copy (with background revalidation), preventing hangs when
 *   Wireless CarPlay's 5GHz Wi-Fi AP has no internet route and iOS is failing
 *   over to cellular data.
 */
const CACHE_NAME = 'earmaster-pro-__SW_VERSION__'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/granular-processor.js',
  '/samples/sonofield-drone/C.mp3',
  '/samples/sonofield-drone/Cs.mp3',
  '/samples/sonofield-drone/D.mp3',
  '/samples/sonofield-drone/Ds.mp3',
  '/samples/sonofield-drone/E.mp3',
  '/samples/sonofield-drone/F.mp3',
  '/samples/sonofield-drone/Fs.mp3',
  '/samples/sonofield-drone/G.mp3',
  '/samples/sonofield-drone/Gs.mp3',
  '/samples/sonofield-drone/A.mp3',
  '/samples/sonofield-drone/As.mp3',
  '/samples/sonofield-drone/B.mp3',
  '/samples/sonofield-synth/G2.mp3',
  '/samples/sonofield-synth/As2.mp3',
  '/samples/sonofield-synth/Cs3.mp3',
  '/samples/sonofield-synth/E3.mp3',
  '/samples/sonofield-synth/G3.mp3',
  '/samples/sonofield-synth/As3.mp3',
  '/samples/sonofield-synth/Cs4.mp3',
  '/samples/sonofield-synth/E4.mp3',
  '/samples/sonofield-synth/G4.mp3',
  '/samples/sonofield-synth/As4.mp3',
  '/samples/sonofield-synth/Cs5.mp3',
  '/samples/sonofield-synth/E5.mp3',
  '/samples/sonofield-synth/G5.mp3',
  '/samples/sonofield-synth/As5.mp3',
  '/samples/sonofield-synth/Cs6.mp3',
  '/samples/sonofield-synth/E6.mp3',
]

const NETWORK_TIMEOUT_MS = 1200

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
  if (response && response.status === 200) {
    const copy = response.clone()
    caches.open(CACHE_NAME).then(cache => cache.put(request.url || request, copy))
  }
  return response
}

/**
 * Build an RFC 7233 206 Partial Content response from a full 200 Response
 * when WebKit sends a `Range: bytes=start-end` header for audio assets.
 */
async function respondWithRange(request, fullResponse) {
  if (!fullResponse) return fullResponse
  const rangeHeader = request.headers && request.headers.get && request.headers.get('range')
  if (!rangeHeader || fullResponse.status === 206) return fullResponse

  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return fullResponse

  const buffer = await fullResponse.clone().arrayBuffer()
  const total = buffer.byteLength
  const start = parseInt(match[1], 10)
  const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1

  if (Number.isNaN(start) || start >= total || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    })
  }

  const sliced = buffer.slice(start, end + 1)
  const contentType = (fullResponse.headers && fullResponse.headers.get && fullResponse.headers.get('content-type')) || 'audio/mpeg'
  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(sliced.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  })
}

const networkFirst = (request, fallbackUrl, timeoutMs = NETWORK_TIMEOUT_MS) => {
  const fetchPromise = fetch(request).then(response => cachePut(request, response))
  const timedFetch = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw-network-timeout')), timeoutMs)
    fetchPromise.then(
      res => { clearTimeout(t); resolve(res) },
      err => { clearTimeout(t); reject(err) }
    )
  })
  return timedFetch.catch(() =>
    caches.match(request.url || request).then(cached =>
      cached || (fallbackUrl ? caches.match(fallbackUrl) : fetchPromise)))
}

const cacheFirst = (request) =>
  caches.match(request.url || request).then(cached => {
    if (cached) return respondWithRange(request, cached)
    // Fetch full asset (strip Range so Cache API can store status 200)
    const cleanReq = (request.headers && request.headers.get && request.headers.get('range'))
      ? new Request(request.url, { method: 'GET' })
      : request
    return fetch(cleanReq)
      .then(response => cachePut(cleanReq, response))
      .then(response => respondWithRange(request, response))
  })

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
  // the catalog is regenerated — prefer network with fast CarPlay timeout.
  if (url.pathname === '/catalog/catalog.json' ||
      url.pathname.endsWith('/session.eartrainer.json')) {
    event.respondWith(networkFirst(request))
    return
  }

  // Immutable-per-build assets: hashed bundles, icons, catalog binaries,
  // local Sonofield samples (/samples/*), and immutable CDN instrument samples.
  const isImmutable = APP_SHELL.includes(url.pathname) ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/catalog/') ||
    url.pathname.startsWith('/samples/') ||
    url.pathname.includes('/tonejs-instruments/samples/')
  if (isImmutable) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Everything else: network-first, cache fallback
  event.respondWith(networkFirst(request))
})
