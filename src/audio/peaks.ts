/**
 * Decoding a recording down to a peak envelope (spec §6, M3).
 *
 * The only place that turns compressed bytes into samples. Lives in audio/
 * because OfflineAudioContext is Web Audio; the bucketing itself is pure and
 * stays in core/peaks.ts.
 *
 * Two deliberate reductions, both because the target is a 40–80 minute
 * orchestral recording rather than a pop single:
 *
 *  - Decode at PEAK_SAMPLE_RATE, not the file's rate. decodeAudioData
 *    resamples to the context's rate, so an OfflineAudioContext at 8 kHz
 *    cuts the decoded copy ~5.5× versus 44.1 kHz. A waveform drawn at ~1000
 *    columns cannot show anything 8 kHz loses, and peaks are bucketed to
 *    10 ms immediately afterwards regardless.
 *  - Throw away the AudioBuffer as soon as the envelope exists. The envelope
 *    is ~3.4 MB for a symphony; the decoded audio behind it is ~130 MB.
 *
 * Nothing here is on the playback path. MediaElementEngine still streams the
 * original file — this decode exists only so the authoring UI has something
 * to draw, which is exactly the M3 boundary ("playback is unchanged").
 */

import { type PeakEnvelope, bucketSizeFor, computePeaks } from "../core";

/** Enough for an envelope, ~5.5× cheaper to decode than CD rate. */
export const PEAK_SAMPLE_RATE = 8000;

/**
 * Refuse rather than crash the tab. decodeAudioData needs the whole file in
 * memory as bytes *and* as samples, so a multi-gigabyte video would take the
 * page down with no way to report why. Generous on purpose: a lossless
 * 80-minute symphony is ~800 MB, and video containers run larger still.
 */
export const MAX_DECODE_BYTES = 1_500_000_000; // 1.5 GB

export type PeaksResult =
  | { ok: true; env: PeakEnvelope }
  | { ok: false; reason: "too-large" | "decode-failed"; detail: string };

/**
 * Decode a file into a peak envelope. Never throws — callers surface the
 * failure in the waveform panel and carry on, because a missing waveform
 * must not stop anyone from practising with tap-to-mark.
 */
export async function decodePeaks(file: File): Promise<PeaksResult> {
  if (file.size > MAX_DECODE_BYTES) {
    const gb = (file.size / 1e9).toFixed(1);
    return {
      ok: false,
      reason: "too-large",
      detail: `${file.name} is ${gb} GB — too large to analyse for a waveform`,
    };
  }

  // A one-frame context: it is only a decoding host, never rendered.
  const ctx = new OfflineAudioContext(1, 1, PEAK_SAMPLE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch (err) {
    return {
      ok: false,
      reason: "decode-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  const env = computePeaks(channels, buffer.sampleRate, bucketSizeFor(buffer.sampleRate));
  return { ok: true, env };
}
