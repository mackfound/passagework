/**
 * ui/ — rendering and input. Disposable by design (spec §3).
 * M0: prove the layers wire together. Nothing plays yet.
 */

import { CURRENT_VERSION } from "../core";

const app = document.querySelector<HTMLDivElement>("#app");
if (app) {
  app.innerHTML = `
    <main class="m0">
      <h1>Excerpt Looper</h1>
      <p>M0 skeleton — schema v${CURRENT_VERSION}. Nothing plays yet.</p>
    </main>
  `;
}
