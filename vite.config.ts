import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type Plugin, defineConfig } from "vite";

/** Hand-written, in src/. Read as a template; the manifest is injected below. */
const SW_SOURCE = "src/sw.js";

/**
 * In dist/ but not of it. Static hosts read these at deploy time as
 * configuration rather than content, so they are not part of the app and
 * have no business in its cache.
 *
 * Cloudflare does not serve the file itself — but measured against the
 * live deploy, it answers an unmatched path with index.html and a 200
 * rather than a 404. So precaching this would quietly succeed and store a
 * second copy of the shell under a config file's URL: junk rather than a
 * failure, which is the worse of the two, because nothing would ever have
 * pointed at it or noticed it was there.
 */
const HOST_CONFIG = new Set(["_headers", "_redirects", "_routes.json"]);

/**
 * Bake the shipped file list into dist/sw.js.
 *
 * A service worker can only precache filenames it knows, and Vite content-
 * hashes every asset it emits — so the list has to be produced by the build
 * that produced the files. The alternative is a runtime cache-as-you-go
 * worker, which needs no manifest but only ever holds what a session
 * happened to request: the latin-ext font subset loads only when a glyph
 * needs it, so a user who never typed "Dvořák" would go offline missing it.
 *
 * Doing it here rather than reaching for Workbox keeps the promise on the
 * tin — this app ships zero runtime dependencies, and a precache manifest
 * is thirty lines.
 */
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "passagework-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // closeBundle, not writeBundle: public/ is copied outside the bundle
    // graph and lands later. A manifest that quietly omitted the fonts
    // would be worse than no manifest at all — the app would look cached
    // and then repaint in Georgia the first time it ran offline.
    closeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(outDir, join(e.parentPath, e.name)).split(sep).join("/"))
        // Source maps are for debugging, not for running. A worker must
        // never precache itself: the browser manages that update check.
        .filter((f) => !f.endsWith(".map") && f !== "sw.js" && !HOST_CONFIG.has(f))
        .sort();

      // Version by *content*, not by filename. Vite hashes asset names, but
      // index.html is not hashed, and a browser adopts a new worker only
      // when its bytes differ — so a deploy that changed nothing else would
      // otherwise ship a byte-identical sw.js and never take effect.
      const hash = createHash("sha256");
      for (const f of files) {
        hash.update(f);
        hash.update(readFileSync(join(outDir, f)));
      }
      // The worker's own logic counts too: a change to how it caches makes
      // it a different worker even when every shipped byte is identical,
      // and it should get a cache of its own rather than adopt the last
      // one's. Hashes the template, not the output, so this can't recurse.
      const template = readFileSync(SW_SOURCE, "utf8");
      hash.update(template);

      const source = template
        .replace('"__VERSION__"', JSON.stringify(hash.digest("hex").slice(0, 12)))
        .replace("__PRECACHE__", JSON.stringify(files, null, 2));
      writeFileSync(join(outDir, "sw.js"), source);
    },
  };
}

export default defineConfig({
  /**
   * Relative, so one dist/ works wherever it lands: a GitHub Pages project
   * site at /passagework/, a user page at the domain root, or a folder on a
   * USB stick opened over any static server. An absolute base would have to
   * name the deploy path, and getting it wrong yields a blank page rather
   * than an error anyone can read.
   *
   * Safe here only because there is no client-side routing — every URL this
   * app is ever served at is the directory holding index.html.
   */
  base: "./",
  plugins: [serviceWorker()],
});
