import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const SW_SOURCE = "src/sw.js";

/**
 * Ship src/sw.js as dist/sw.js.
 *
 * It used to do more: walk the built output, hash it, and inject a
 * precache manifest so the worker could serve the app offline. That
 * machinery went when the worker did — see src/sw.js for why, and the
 * commit that shortened this file for how to bring both back.
 *
 * This still has to run, and dist/sw.js still has to be served, precisely
 * because the worker is being withdrawn. A browser holding the old
 * registration can only be reached through this URL; stop publishing it
 * and every already-broken browser stays broken.
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
    // graph and lands later, and this should be the last word on dist/.
    closeBundle() {
      copyFileSync(SW_SOURCE, join(outDir, "sw.js"));
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
