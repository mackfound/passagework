/**
 * Seed project (spec §12): three Dvořák 9 excerpts, timings null for the
 * user to set at first run. Untimed is a first-class state — triggering an
 * untimed excerpt arms tap-in rather than erroring.
 *
 * The placeholder source exists so excerpts have a valid sourceId before
 * any audio has been linked; linking the first file fills in its fileRef.
 */

import type { ProjectDoc } from "./schema/types";
import { CURRENT_VERSION } from "./schema/migrations";

export const SEED_SOURCE_ID = "src_main";

export function makeSeedProject(): ProjectDoc {
  return {
    schemaVersion: CURRENT_VERSION,
    id: "prj_default",
    name: "Fall 2026 Auditions",
    sources: [
      {
        // label stays empty until a file is linked: it always holds the
        // linked filename (ui shows "no recording" while it's empty),
        // matching makePlaceholderSource in factories.ts.
        id: SEED_SOURCE_ID,
        label: "",
        fileRef: { kind: "filename", name: "" },
        duration: null,
        sampleRate: null,
      },
    ],
    excerpts: [
      {
        id: "exc_iv_fig2",
        label: "Mvt IV — Fig 2, mm. 6–12",
        shortLabel: "IV/2",
        hotkey: "1",
        sourceId: SEED_SOURCE_ID,
        region: null,
        preRoll: 1.2,
        defaultRate: 0.75,
        loop: true,
        reference: { movement: 4, rehearsal: "2", measures: "6-12" },
        notes: "Allegro con fuoco — triplet sequence",
        tags: ["dvorak9"],
        assets: [],
      },
      {
        id: "exc_i_fig5",
        label: "Mvt I — Fig 5, mm. 9–23",
        shortLabel: "I/5",
        hotkey: "2",
        sourceId: SEED_SOURCE_ID,
        region: null,
        preRoll: 1.2,
        defaultRate: 0.75,
        loop: true,
        reference: { movement: 1, rehearsal: "5", measures: "9-23" },
        notes: "Allegro molto, 2/4 — dotted rhythms against triplets",
        tags: ["dvorak9"],
        assets: [],
      },
      {
        id: "exc_iv_fig9",
        label: "Mvt IV — 14 before Fig 9 → Fig 9",
        shortLabel: "IV/9−14",
        hotkey: "3",
        sourceId: SEED_SOURCE_ID,
        region: null,
        preRoll: 1.2,
        defaultRate: 0.75,
        loop: true,
        reference: { movement: 4, rehearsal: "9", measures: "−14–0" },
        notes: "Allegro con fuoco — measured repetition (slashed stems)",
        tags: ["dvorak9"],
        assets: [],
      },
    ],
    assets: {},
  };
}
