// 离线壳：network-first，命中网络就顺手回填缓存。
//
// 为什么不是 cache-first：这个仓出货的是裸 ES module（没有打包、文件名不带 hash），
// cache-first 会把 js/css 永久钉在装机那一版 —— 出新 HTML 配旧 JS 的鬼状态只能靠用户清缓存。
// 版本号写死在 CACHE 名里，改的是"离线兜底的那一套"，不是资源的取用顺序。
'use strict';

const VERSION = 'v1';
const CACHE = `pancake-offline-${VERSION}`;
const SHELL = ['index.html', 'css/game.css', 'js/main.js', 'manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
      )
  );
});
