const CACHE_NAME = 'kho-truyen-v13';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

// Install - cache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch - Network-first for code assets, Cache-first for others
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for scripts and html so bug fixes apply immediately
  if (url.origin === location.origin && (url.pathname.endsWith('.js') || url.pathname.endsWith('.html') || url.pathname.endsWith('/'))) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for offline assets
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
