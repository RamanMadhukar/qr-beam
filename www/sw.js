// Keeps QR Beam working with no network. Bump VERSION when you change files.
const VERSION = 'qr-beam-v3';

const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/native.js',
  './js/protocol.js',
  './js/store.js',
  './js/scanner.js',
  './js/scan-worker.js',
  './js/qr-worker.js',
  './vendor/capacitor.js',
  './vendor/qrcode.js',
  './vendor/jsQR.js',
  './vendor/zxing/zxing-reader.js',
  './vendor/zxing/zxing_reader.wasm',
  './vendor/fonts/bricolage-grotesque-600.woff2',
  './vendor/fonts/bricolage-grotesque-700.woff2',
  './vendor/fonts/ibm-plex-sans-400.woff2',
  './vendor/fonts/ibm-plex-sans-500.woff2',
  './vendor/fonts/ibm-plex-sans-600.woff2',
  './vendor/fonts/ibm-plex-mono-400.woff2',
  './vendor/fonts/ibm-plex-mono-500.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // Network first so updates show up straight away; the cache covers offline use.
  event.respondWith(
    fetch(request, { cache: 'no-cache' }) // revalidate, so an update is never hidden by the HTTP cache
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
