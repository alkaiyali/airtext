/* eslint-disable no-undef */
const CACHE_NAME = 'airtext-v5'
const CORE_ASSETS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/fonts/instrument-sans-latin-wght.woff2']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== location.origin) return

  // Never cache the WebSocket room route or invite URLs: the ?join= param is
  // a bearer credential and must not persist in a cache keyed without it.
  if (url.pathname.startsWith('/room/') || url.searchParams.has('join')) return

  // Always go to the network first for the app shell and assets; only fall
  // back to cache when offline. This guarantees fresh code after deploys.
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && !url.search) {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    }).catch(() => caches.match(request)),
  )
})
