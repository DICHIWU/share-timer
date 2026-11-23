/* 小組分享計時 — service worker
   Precache every app asset; serve from cache first and refresh in the background
   (stale-while-revalidate). Bump CACHE_VERSION whenever assets change. */
'use strict';

const CACHE_VERSION = 'v11';
const CACHE_PREFIX = 'share-timer-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
  './icons/logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch other origins

  const isNavigation = req.mode === 'navigate';

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    let cached = await cache.match(req, { ignoreSearch: true });
    if (!cached && isNavigation) {
      cached = (await cache.match('./index.html')) || (await cache.match('./'));
    }

    const network = fetch(req)
      .then((res) => {
        // Only store clean same-origin responses (Safari rejects redirected navigations)
        if (res && res.ok && res.type === 'basic' && !res.redirected) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    const res = await network;
    if (res) return res;
    return new Response('離線中，且此檔案尚未快取。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
