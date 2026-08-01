/**
 * Recovery worker. It exists to remove itself.
 *
 * This file used to precache the app shell for offline use. That cost more
 * than it bought: it made the site unopenable twice, on a real machine, in
 * ways that looked to the user like the domain had stopped existing — and
 * a practice tool you cannot open is worse than one that needs the network
 * to start. Offline support is worth having, but not on trust, and not
 * before it can be tested against the states that actually broke it.
 *
 * Simply not registering a worker would not have been enough. A browser
 * already holding a broken registration cannot be reached by any change to
 * the page, because the broken worker is the thing stopping the page from
 * loading. What a browser does still do is re-fetch this file to check for
 * an update — that request goes to the network, not through the worker —
 * so this is the one piece of code that can reach a stuck browser and let
 * it out.
 *
 * Hence the shape: take over at once rather than waiting for the tabs that
 * cannot load, drop everything the old worker cached, unregister, and
 * reload whatever windows are open so the site simply appears.
 *
 * There is deliberately no fetch handler. A worker that intercepts nothing
 * cannot fail a request, which is the entire failure mode being retired.
 *
 * To restore offline support, revert the commit that added this file: the
 * precache worker, its build-time manifest, and the registration all go
 * back together. Do it behind the DevTools checks in the README first.
 */

// Do not wait for existing clients. The tabs this needs to rescue are the
// ones failing to load, and waiting on them would wait forever.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      // Reload open windows so recovery looks like the site working again
      // rather than something the user has to know to do.
      for (const client of await self.clients.matchAll({ type: "window" })) {
        client.navigate(client.url);
      }
    })(),
  );
});
