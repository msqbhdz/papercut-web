// 旧发布标记的 Service Worker 墓碑。
// 目的：打破「旧 SW 缓存旧页面 → 旧页面注册旧 SW URL（已 404）→ 永远无法更新」的死锁。
// 它只做三件事：清空所有缓存、自我注销、把已打开的页面拉回网络重新加载。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (error) {
      // 清缓存失败也继续注销，否则会把用户永久锁在旧版本。
    }
    try {
      await self.registration.unregister();
    } catch (error) {
      // 忽略：下次导航仍会走网络。
    }
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try {
          await client.navigate(client.url);
        } catch (error) {
          // 跨源或已关闭的页面无法导航，忽略。
        }
      }
    } catch (error) {
      // 忽略。
    }
  })());
});
