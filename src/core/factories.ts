/**
 * Factories for library entities created at runtime (M2): new projects,
 * new excerpts, and the placeholder sources that back unlinked excerpts.
 *
 * Ids come from crypto.randomUUID — a platform global in both browsers and
 * node (no import), so core/ stays dependency-free.
 */

import type { Excerpt, ProjectDoc, Source } from "./schema/types";
import { CURRENT_VERSION } from "./schema/migrations";

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function makeEmptyProject(name: string): ProjectDoc {
  return {
    schemaVersion: CURRENT_VERSION,
    id: `prj_${shortId()}`,
    name,
    sources: [],
    excerpts: [],
    assets: {},
  };
}

/**
 * Every new excerpt gets its own unlinked source; linking later fills it
 * in place (or dedups into an existing source by filename).
 */
export function makePlaceholderSource(): Source {
  return {
    id: `src_${shortId()}`,
    label: "",
    fileRef: { kind: "filename", name: "" },
    duration: null,
    sampleRate: null,
  };
}

export interface ExcerptFields {
  label: string;
  title?: string;
  hotkey?: string;
}

/** Defaults match the seed excerpts: untimed, 1.2 s pre-roll, 0.75× start. */
export function makeExcerpt(fields: ExcerptFields, sourceId: string): Excerpt {
  return {
    id: `exc_${shortId()}`,
    label: fields.label,
    ...(fields.title ? { title: fields.title } : {}),
    ...(fields.hotkey ? { hotkey: fields.hotkey } : {}),
    sourceId,
    region: null,
    preRoll: 1.2,
    defaultRate: 0.75,
    loop: true,
    assets: [],
  };
}

const HOTKEY_POOL = [..."123456789"];

/** Suggest the lowest free digit hotkey; undefined when 1–9 are all taken. */
export function nextFreeHotkey(excerpts: readonly Excerpt[]): string | undefined {
  const used = new Set(excerpts.map((e) => e.hotkey));
  return HOTKEY_POOL.find((k) => !used.has(k));
}
