/**
 * Project document schema — the on-disk JSON format (spec §4).
 *
 * This file is pure types. Nothing here may import from outside core/.
 *
 * Versioning rules (spec §4, non-negotiable):
 *  - `schemaVersion` is a required integer at the root.
 *  - Never mutate the meaning of an existing field; add a new one and migrate.
 */

export type Seconds = number;

/** Closed time region in source-time seconds. Invariant: start < end. */
export interface Region {
  start: Seconds;
  end: Seconds;
}

/**
 * Reference to bytes that live outside the document.
 * - `fsHandle`: a FileSystemFileHandle persisted in IndexedDB under `key`
 *   (Chromium File System Access API). storage/ owns resolution.
 * - `filename`: fallback for a file re-selected each session via <input>,
 *   matched by name (and duration, for audio). Spec §5.
 */
export type FileRef =
  | { kind: "fsHandle"; key: string }
  | { kind: "filename"; name: string };

/** An audio recording the excerpts point into. */
export interface Source {
  id: string;
  label: string;
  fileRef: FileRef;
  /** Populated on first successful load; null until then. */
  duration: Seconds | null;
  sampleRate: number | null;
}

/**
 * Asset payloads, keyed by asset id at the document root.
 * Per-asset inline-vs-handle choice (spec §5): inline assets can never fail
 * to load and travel with the exported JSON; handle-backed assets need
 * permission re-granted each session and can go stale. The UI must display
 * which mode an asset is in — the auto-inline threshold (storage/ concern)
 * is a safety valve, not a silent branch.
 */
export type AssetData =
  | { kind: "inline"; mime: string; /** base64, no data: prefix */ data: string }
  | { kind: "fsHandle"; key: string };

/** How an excerpt uses an asset. `role` generalizes to takes/recordings later (spec §7). */
export interface AssetUse {
  type: "image";
  role: "part" | "score";
  ref: string;
}

/** Display-only musical coordinates. Never parsed or computed from (spec §11). */
export interface MusicalReference {
  movement?: number;
  rehearsal?: string;
  measures?: string;
  edition?: string;
}

/** Not used by M1; exists so metronome/count-in/tempo-ladder are additive (spec §4). */
export interface TempoInfo {
  bpm: number;
  beatsPerBar: number;
  beatUnit: number;
}

export interface Excerpt {
  id: string;
  label: string;
  shortLabel?: string;
  /**
   * Explicit key binding (e.g. "1", "d"). Optional: unbound excerpts are
   * reachable by prev/next. Explicit rather than positional so reordering
   * the library never remaps muscle memory.
   */
  hotkey?: string;
  sourceId: string;
  /**
   * null = untimed: a first-class state, not a validation error. Seed
   * excerpts ship untimed (spec §12); triggering one arms tap-in instead
   * of playing.
   */
  region: Region | null;
  /** Seconds of lead-in before region.start on entry only — not on loop wrap (spec §7). */
  preRoll: Seconds;
  /** Authored starting rate. Working rate lives in AppState, not here. */
  defaultRate: number;
  loop: boolean;
  reference?: MusicalReference;
  tempo?: TempoInfo;
  assets: AssetUse[];
  notes?: string;
  tags?: string[];
}

export interface ProjectDoc {
  schemaVersion: number;
  id: string;
  name: string;
  sources: Source[];
  excerpts: Excerpt[];
  assets: Record<string, AssetData>;
}

/**
 * Session/progress state. Lives in IndexedDB only — never exported, never
 * committed. Kept out of ProjectDoc so practicing doesn't churn the config
 * file: `defaultRate` is authored, `workingRates` is progress.
 */
export interface AppState {
  activeProjectId: string | null;
  /** excerptId → last-used playback rate (sticky across reloads). */
  workingRates: Record<string, number>;
}
