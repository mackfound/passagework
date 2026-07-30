/**
 * Waveform peak envelopes and view-window arithmetic (spec §6, M3).
 *
 * Pure time/array math, like the rest of core/: no DOM, no Web Audio, no
 * canvas. Decoding lives in audio/, caching in storage/, drawing in ui/ —
 * this file only turns samples into buckets and buckets into columns.
 *
 * Bucket size is deliberately GRID (10 ms), the same quantum taps and
 * nudges use (spec §2.5). At maximum zoom one bucket is exactly one nudge
 * step, so the waveform can never imply precision the loop points don't
 * have. It also bounds the cache: a 70-minute symphony is 420k buckets,
 * ~3.4 MB of Float32 — small enough for IndexedDB, where a decoded copy of
 * the audio would be unthinkable (spec §5).
 */

import { GRID } from "./loop";
import type { Seconds } from "./schema/types";

/**
 * Bumped whenever the envelope layout changes. Caches key on it, so an old
 * cached envelope is discarded rather than misread.
 */
export const PEAKS_VERSION = 1;

/**
 * Min/max amplitude per bucket, in source time.
 *
 * `min`/`max` are parallel arrays of the same length; sample values are the
 * usual −1..1 float range. Two arrays rather than an interleaved one so the
 * draw loop reads sequentially and so structured-clone into IndexedDB stays
 * a single copy per array.
 */
export interface PeakEnvelope {
  version: number;
  /** Rate of the decoded signal these were taken from, not the file's own. */
  sampleRate: number;
  samplesPerBucket: number;
  duration: Seconds;
  min: Float32Array;
  max: Float32Array;
}

/**
 * A visible time window. Structurally identical to Region but deliberately
 * a separate type: a Region is authored musical content bound by
 * MIN_REGION, a view is transient camera state with no such floor.
 */
export interface ViewWindow {
  start: Seconds;
  end: Seconds;
}

/** Samples per bucket for a given decode rate — one bucket per 10 ms grid cell. */
export function bucketSizeFor(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * GRID));
}

export function secondsPerBucket(env: PeakEnvelope): Seconds {
  return env.samplesPerBucket / env.sampleRate;
}

/**
 * Reduce decoded channel data to a peak envelope.
 *
 * Peaks are taken across all channels at once rather than from a mixdown:
 * mixing would let a transient present in one channel cancel against the
 * other, and it would need a second full-length allocation. Both matter on
 * an orchestral file.
 *
 * Synchronous and O(samples) by design — it runs once per recording and the
 * result is cached forever, so the simplicity is worth more than the one
 * ~0.5 s pass on a symphony-length file.
 */
export function computePeaks(
  channels: readonly Float32Array[],
  sampleRate: number,
  samplesPerBucket: number = bucketSizeFor(sampleRate),
): PeakEnvelope {
  if (channels.length === 0 || sampleRate <= 0 || samplesPerBucket <= 0) {
    return {
      version: PEAKS_VERSION,
      sampleRate: Math.max(1, sampleRate),
      samplesPerBucket: Math.max(1, samplesPerBucket),
      duration: 0,
      min: new Float32Array(0),
      max: new Float32Array(0),
    };
  }

  const length = channels[0]!.length;
  const buckets = Math.ceil(length / samplesPerBucket);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const from = b * samplesPerBucket;
    const to = Math.min(from + samplesPerBucket, length);
    let lo = Infinity;
    let hi = -Infinity;
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = data[i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // A zero-length tail bucket would leave ±Infinity in the array.
    min[b] = lo === Infinity ? 0 : lo;
    max[b] = hi === -Infinity ? 0 : hi;
  }

  return {
    version: PEAKS_VERSION,
    sampleRate,
    samplesPerBucket,
    duration: length / sampleRate,
    min,
    max,
  };
}

/** Bucket index containing a time, clamped into range. */
export function bucketAt(env: PeakEnvelope, t: Seconds): number {
  const idx = Math.floor(t / secondsPerBucket(env));
  return Math.min(env.min.length - 1, Math.max(0, idx));
}

/**
 * Reduce an envelope to one min/max pair per drawn column.
 *
 * Zoomed out, a column spans many buckets and takes their extremes; zoomed
 * in past bucket resolution, several columns read the same bucket and the
 * waveform simply widens. Both are correct — the envelope never
 * interpolates, so a column can't show detail that was never measured.
 */
export function sampleWindow(
  env: PeakEnvelope,
  view: ViewWindow,
  columns: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(Math.max(0, columns));
  const max = new Float32Array(Math.max(0, columns));
  if (columns <= 0 || env.min.length === 0) return { min, max };

  const spb = secondsPerBucket(env);
  const span = view.end - view.start;
  if (span <= 0) return { min, max };

  for (let c = 0; c < columns; c++) {
    const from = view.start + (span * c) / columns;
    const to = view.start + (span * (c + 1)) / columns;
    // Outside the recording entirely: leave the column flat rather than
    // clamping onto the first/last bucket, which would smear the ends.
    if (to <= 0 || from >= env.duration) continue;

    // Columns are half-open [from, to): the last bucket is the one holding
    // the instant before `to`, so ceil()-1 rather than floor(). Using floor
    // pulls in the bucket that *starts* at `to`, which smears every column
    // one bucket rightward and duplicates transients at high zoom.
    const b0 = Math.max(0, Math.floor(from / spb));
    const b1 = Math.max(b0, Math.min(env.min.length - 1, Math.ceil(to / spb) - 1));
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = b0; b <= b1; b++) {
      if (env.min[b]! < lo) lo = env.min[b]!;
      if (env.max[b]! > hi) hi = env.max[b]!;
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

// ---------- view-window arithmetic ----------

/** Shortest window the view may zoom to: 20 grid cells across. */
export const MIN_VIEW_SPAN: Seconds = GRID * 20;

/** Clamp a window into [0, duration], preserving its span where possible. */
export function clampView(view: ViewWindow, duration: Seconds): ViewWindow {
  const span = Math.min(Math.max(view.end - view.start, MIN_VIEW_SPAN), duration);
  let start = view.start;
  if (start + span > duration) start = duration - span;
  if (start < 0) start = 0;
  return { start, end: start + span };
}

/**
 * Default window for authoring an excerpt: the region plus context on each
 * side, so both edges are draggable without the surrounding music vanishing.
 * An untimed excerpt gets the whole recording — you have to find the passage
 * before you can trim it.
 */
export function viewForRegion(
  region: ViewWindow | null,
  duration: Seconds,
  padFraction = 0.5,
): ViewWindow {
  if (!region) return { start: 0, end: duration };
  const pad = Math.max(MIN_VIEW_SPAN / 2, (region.end - region.start) * padFraction);
  return clampView({ start: region.start - pad, end: region.end + pad }, duration);
}

/**
 * Zoom about a fixed time, so the moment under the cursor (or the playhead)
 * stays put. factor < 1 zooms in.
 */
export function zoomView(
  view: ViewWindow,
  factor: number,
  anchor: Seconds,
  duration: Seconds,
): ViewWindow {
  const span = view.end - view.start;
  if (span <= 0) return clampView(view, duration);
  const nextSpan = Math.min(Math.max(span * factor, MIN_VIEW_SPAN), duration);
  const ratio = (anchor - view.start) / span; // where the anchor sits, 0..1
  return clampView({ start: anchor - ratio * nextSpan, end: anchor + (1 - ratio) * nextSpan }, duration);
}

// ---------- pixel mapping ----------

/** Time → x within a `width`-pixel canvas. Not clamped: callers cull offscreen. */
export function timeToX(t: Seconds, view: ViewWindow, width: number): number {
  const span = view.end - view.start;
  if (span <= 0) return 0;
  return ((t - view.start) / span) * width;
}

/** x → time. Inverse of timeToX; unquantized, since callers own the grid. */
export function xToTime(x: number, view: ViewWindow, width: number): Seconds {
  if (width <= 0) return view.start;
  return view.start + (x / width) * (view.end - view.start);
}
