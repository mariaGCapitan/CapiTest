// Permite abrir CapiTest sin conexión. Primero intenta la red (para tener siempre la última versión)
// y, si no hay, usa la copia guardada.

const CACHE = 'capitest-v9';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/util.js', 'js/layout.js', 'js/import.js', 'js/grading.js',
  'js/pdf.js', 'js/omr.js', 'js/scan.js', 'js/excel.js',
  'vendor/jspdf.umd.min.js', 'vendor/jsQR.js', 'vendor/qrcode.js', 'vendor/xlsx.full.min.js',
  'img/logo_gc.png', 'img/logo_junta.png', 'icons/favicon-32.png', 'icons/favicon-64.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // no-cache: pregunta siempre al servidor si hay versión nueva, en vez de fiarse de la caché del navegador.
  const fresh = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache' })
    : fetch(new Request(e.request, { cache: 'no-cache' }));
  e.respondWith(
    fresh
      .then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
