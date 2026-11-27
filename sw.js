// So the website opens without a connection. Its own files are fetched as usual and
// kept; when the network fails, the kept copy is used. Nothing else is touched: your
// tasks go to and from Google as before, and aren't kept here.
var CACHE = 'tabandtick-app';
var FILES = ['./', 'index.html', 'style.css', 'jquery.js', 'auth.js', 'script.js', 'tasks.js', 'shared.js',
  'app.webmanifest', 'icons/logo.svg', 'icons/icon-32.png', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE).then(function(cache) { return cache.addAll(FILES); }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

function ours(request) {
  var url = new URL(request.url), scope = new URL(self.registration.scope);
  if (request.method !== 'GET' || url.origin !== scope.origin || url.pathname.indexOf(scope.pathname) !== 0) return false;
  var path = url.pathname.slice(scope.pathname.length) || './';
  return FILES.indexOf(path) >= 0;
}

self.addEventListener('fetch', function(event) {
  if (!ours(event.request)) return;
  event.respondWith(fetch(event.request).then(function(response) {
    if (response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function(cache) { cache.put(event.request, copy); });
    }
    return response;
  }).catch(function() {
    return caches.match(event.request, { ignoreSearch: true }).then(function(kept) {
      return kept || caches.match('index.html');
    });
  }));
});
