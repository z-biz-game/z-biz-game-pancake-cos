// 离线壳：network-first，命中网络就顺手回填缓存。
//
// 为什么不是 cache-first：这个仓出货的是裸 ES module（没有打包、文件名不带 hash），
// cache-first 会把 js/css 永久钉在装机那一版 —— 出新 HTML 配旧 JS 的鬼状态只能靠用户清缓存。
// 版本号写死在 CACHE 名里，改的是"离线兜底的那一套"，不是资源的取用顺序。
'use strict';

const VERSION = 'v2';
const CACHE = `pancake-offline-${VERSION}`;
// 首次安装就断网时，"能打开"要求的是整张图：模块图、饼摞美术、图标，一个都不能少。
// test/assets.test.mjs 会从 js/main.js 走真实 import 图，这张表和磁盘/引用不一致就红，
// 所以新增模块却忘了登记兜底清单会被测试拦住，而不是等到离线打开时变成白屏。
const SHELL = [
  'index.html',
  'css/game.css',
  'manifest.webmanifest',
  'js/sw-register.js',
  'js/main.js',
  'js/game.js',
  'js/view.js',
  'js/motion.js',
  'js/store.js',
  'js/theme.js',
  'js/audio/synth.js',
  'js/data/lots.js',
  'js/engine/rules.js',
  'js/engine/perms.js',
  'js/engine/graph.js',
  'js/engine/make.js',
  'js/engine/library.js',
  'js/engine/tiers.js',
  'art/grain-256.png',
  'art/spatula-720x96.png',
  'art/win-plate-240.png',
  'art/og-1200x630.png',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/favicon-48.png',
  'icons/favicon-96.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon-1024.png',
];

self.addEventListener('install', (ev) => {
  // 逐条 put，不用 addAll：addAll 是原子的，一张图 404 就让整份清单全军覆没，而外面那个
  // catch 会把这件事做得更隐蔽 —— 离线兜底“存在”，但里面是空的。
  ev.waitUntil(
    caches.open(CACHE).then(async (c) => {
      let cached = 0;
      for (const path of SHELL) {
        try {
          const res = await fetch(path);
          if (res && res.ok) { await c.put(path, res); cached++; }
        } catch { /* 单条缺失只少这一条 */ }
      }
      return cached;
    })
  );
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
