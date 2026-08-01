const CACHE_NAME = 'gargi-library-v1'
const APP_ROOT = new URL('./', self.registration.scope)
const CORE_FILES = [
  APP_ROOT.href,
  new URL('manifest.webmanifest', APP_ROOT).href,
  new URL('favicon.svg', APP_ROOT).href,
]

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    const homeResponse = await fetch(APP_ROOT.href, { cache: 'reload' })
    await cache.put(APP_ROOT.href, homeResponse.clone())

    const html = await homeResponse.text()
    const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(match => new URL(match[1], APP_ROOT))
      .filter(url => url.origin === self.location.origin)
      .map(url => url.href)

    await cache.addAll([...new Set([...CORE_FILES.slice(1), ...assetPaths])])
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        const cache = await caches.open(CACHE_NAME)
        await cache.put(APP_ROOT.href, response.clone())
        return response
      } catch {
        return (await caches.match(APP_ROOT.href)) || Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cached = await caches.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(request, response.clone())
    }
    return response
  })())
})
