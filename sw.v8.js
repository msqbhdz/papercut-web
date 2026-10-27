'use strict';

// 经典脚本：不使用 import/export，避免在无构建的项目里引入模块边界。
const CACHE = 'papercut-v11';
const ENTRY = './index.html';

// 与 index.html 的引用（含其 import 图）逐一对应；部署在 /papercut-web/ 子路径下，全部相对。
const PRECACHE = [
  './',
  './index.html',
  './style.v4.css',
  './manifest.json',
  './js/symmetry.v6.js',
  './js/draw.v6.js',
  './js/export.v6.js',
  './js/main.v8.js',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((key) => key !== CACHE);
    await Promise.all(stale.map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function fetchAndFill(cache, request) {
  const response = await fetch(request);
  // 只回填成功的基本响应，避免把 opaque/错误页写进缓存。
  if (response && response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      return await fetchAndFill(cache, request);
    } catch (error) {
      if (request.mode === 'navigate') {
        const fallback = await cache.match(ENTRY);
        if (fallback) return fallback;
      }
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
