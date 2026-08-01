/**
 * Offline shell cache.
 *
 * Plain JavaScript, not TypeScript: this file is never bundled. Vite's
 * plugin (see vite.config.ts) reads it as a template, substitutes the two
 * placeholders below with the real build manifest, and writes the result to
 * dist/sw.js. tsconfig only includes typed sources, so nothing here is
 * type-checked — which is the price of it being sixty lines of standard
 * worker API rather than a build target of its own.
 *
 * WHAT IT CACHES: the application shell, and nothing else. Your recordings
 * and score images never pass through here. They arrive as File objects
 * from a picker or a drag, become blob: URLs, and blob: URLs do not reach a
 * service worker's fetch handler at all. The guards below make that
 * structural rather than incidental — the worker declines anything that
 * isn't a same-origin GET for a file this build shipped.
 */

const VERSION = "__VERSION__";
const CACHE = `passagework-${VERSION}`;

/** Every file this build emitted, relative to the worker's own directory. */
const PRECACHE = __PRECACHE__;

/** Navigations ask for the directory; the shell that answers them. */
const SHELL = "index.html";

/**
 * Ignore Vary when matching, and do not remove this.
 *
 * Static hosts commonly answer with `Vary: Origin`, and the cache honours
 * Vary by default: a stored entry only matches a request whose listed
 * headers agree. Vite marks the module script and stylesheet `crossorigin`,
 * so the browser requests them in CORS mode and sends an `Origin` header —
 * which the precache fetch never sent. Every lookup for exactly those two
 * files missed, fell through to the network, and failed offline while the
 * fonts and the shell loaded fine, because nothing marks them crossorigin.
 *
 * Ignoring Vary is correct here rather than merely convenient: this cache
 * holds one build of static files that are byte-identical whoever asks for
 * them. There is no content negotiation to preserve.
 */
const MATCH = { ignoreVary: true };

/**
 * Fetch the whole shell up front. addAll is atomic: one failure rejects the
 * install and leaves no cache at all, which is the right outcome — a
 * half-populated cache would serve an app missing its worklet and fail in
 * a much more confusing place than "offline doesn't work yet".
 *
 * Deliberately no skipWaiting(). A new worker waits for the old page to go
 * away rather than swapping the cache under a running session. This app
 * fetches its AudioWorklet module lazily, the first time the seamless
 * engine is built, so an activation mid-session could purge the hashed file
 * the page is about to ask for. The cost is that an update lands on the
 * next launch instead of this one — for a practice tool, that is nothing.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

/**
 * Drop every older version. Cache names carry the content hash, so this is
 * the entire eviction policy: exactly one build is held at a time.
 *
 * claim() without skipWaiting() is not a contradiction. Without a previous
 * worker there is nothing to wait for, so this runs on the very first
 * visit and takes control of the page that just registered it — meaning
 * the first time you open the app offline is the second visit, not the
 * third. On an *update* the wait still applies, because the old worker is
 * still controlling clients.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Cache-first, with no runtime caching of misses.
 *
 * Cache-first is safe because asset filenames carry a content hash: a stale
 * hit is impossible, since changed content means a changed name. And a miss
 * is by definition not part of the shell, so writing it into the cache
 * would grow it without bound and cache things this build never promised.
 * Misses fall through to the network untouched.
 */
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Not ours to answer: writes, other origins, and range requests. The last
  // matters most — media elements ask for byte ranges, and answering one
  // with a whole cached 200 breaks playback in ways that look like a codec
  // bug. The shell contains no media, so declining costs nothing.
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.headers.has("range")) return;

  // A navigation to the directory, to index.html, or to any path under the
  // scope resolves to the one shell this app has.
  if (request.mode === "navigate") {
    event.respondWith(caches.match(SHELL, MATCH).then((hit) => hit ?? fetch(request)));
    return;
  }

  event.respondWith(caches.match(request, MATCH).then((hit) => hit ?? fetch(request)));
});
