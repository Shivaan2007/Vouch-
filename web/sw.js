// Minimal service worker: lets the phone install Vouch and receive "Share to Vouch".
// It caches nothing, so every load is fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
