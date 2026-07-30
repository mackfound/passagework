/**
 * The wire between the main thread and the stretch worklet.
 *
 * Its own module because both realms import it and neither should pull in
 * the other: importing the processor from the engine just to read a string
 * would drag the whole DSP into the main bundle.
 */

/** Registered name. Must match on both sides; nothing else enforces it. */
export const STRETCH_PROCESSOR = "passagework-stretch";

export type ToWorklet =
  /** Decoded PCM, one Float32Array per channel. Sent transferred. */
  | { type: "source"; channels: Float32Array[] }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; frame: number }
  /** start null clears the loop; frames, half-open. */
  | { type: "loop"; start: number | null; end: number }
  | { type: "rate"; rate: number };

export interface FromWorklet {
  /** Audible position in source frames. */
  frame: number;
  /** Loop passes completed since the previous report. */
  wraps: number;
}

/**
 * Report the position every third render quantum — 8 ms at 48 kHz, so every
 * animation frame has a value it has not seen before. Cheaper than that is
 * chatter the UI cannot use; sparser than that and the playhead stutters.
 */
export const REPORT_EVERY_QUANTA = 3;
