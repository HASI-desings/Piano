/**
 * Piano Master - Offline Service Worker
 * Caches all App Shell files + Built-in Audio
 */
const CACHE_NAME = 'piano-master-v2';

// MUST Match the exact folder structure strings
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json',
    './audio/default.mp3' // Ensure you place an mp3 file here in your project
];

// Install Event: Pre-cache all files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('SW: Pre-caching offline assets');
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate Event: Cleanup old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                          .map(name => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch Event: Stale-While-Revalidate / Cache-First strategy
self.addEventListener('fetch', event => {
    // Only intercept local GET requests
    if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            if (cachedResponse) {
                return cachedResponse; // Instantly return from cache (Offline Support)
            }
            
            // If it's not in the cache, fetch from network and cache it dynamically
            return fetch(event.request).then(networkResponse => {
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, networkResponse.clone());
                    return networkResponse;
                });
            });
        })
    );
});
