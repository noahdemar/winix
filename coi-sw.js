// Adds cross-origin isolation headers (COOP/COEP) to this site's responses. SharedArrayBuffer, which winix needs,
// is only available when the page is cross-origin isolated. GitHub Pages cannot set these headers, so this service
// worker adds them in the browser. Opaque responses are passed through unchanged (they cannot be rewritten).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.status === 0 || response.type === 'opaque') return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    })
  );
});
