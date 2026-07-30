/**
 * Peak-envelope cache (spec §6, M3).
 *
 * Derived data, so it lives in IndexedDB and nowhere else: putting envelopes
 * in the project JSON would add megabytes of base64 to every export for
 * something regenerable from the recording in a second. That keeps exports
 * the human-readable, diffable backup §4 asks for.
 *
 * This is not a copy of the audio (§5) — it is a 10 ms amplitude summary,
 * roughly 0.3% of the decoded signal, and it is discardable at any moment.
 */

import type { PeakEnvelope } from "../core";
import { PEAKS_VERSION } from "../core";
import { STORES, idbDelete, idbGet, idbPut } from "./db";

interface CachedPeaks {
  fingerprint: string;
  env: PeakEnvelope;
}

/**
 * Identifies the bytes an envelope was computed from. Name and size are free
 * — no read, no permission — and together they catch the case that actually
 * happens: a source re-linked to a different recording keeps its id, so a
 * key of source id alone would serve a stale waveform for new audio.
 * PEAKS_VERSION is folded in so a layout change invalidates every entry.
 */
function fingerprint(file: File): string {
  return `${PEAKS_VERSION}:${file.size}:${file.name}`;
}

export async function loadCachedPeaks(
  sourceId: string,
  file: File,
): Promise<PeakEnvelope | null> {
  const hit = await idbGet<CachedPeaks>(STORES.peaks, sourceId);
  if (!hit || hit.fingerprint !== fingerprint(file)) return null;
  // Guard against an envelope written by an older layout that happened to
  // share a fingerprint — cheaper than trusting it and drawing garbage.
  if (hit.env?.version !== PEAKS_VERSION) return null;
  return hit.env;
}

export async function saveCachedPeaks(
  sourceId: string,
  file: File,
  env: PeakEnvelope,
): Promise<void> {
  await idbPut(STORES.peaks, sourceId, { fingerprint: fingerprint(file), env } satisfies CachedPeaks);
}

export async function deleteCachedPeaks(sourceId: string): Promise<void> {
  await idbDelete(STORES.peaks, sourceId);
}
