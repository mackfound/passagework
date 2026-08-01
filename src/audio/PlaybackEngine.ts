/**
 * The critical abstraction (spec §3). Everything above this interface must
 * not care whether the implementation is an <audio> element or a worklet.
 *
 * M1: MediaElementEngine — <audio> + preservesPitch, routed through a
 *     MediaElementAudioSourceNode so the Web Audio graph exists for the
 *     metronome later. Pitch-preserved, but the loop seam has a seek hiccup.
 * M4: WorkletEngine — decoded PCM through a WSOLA AudioWorklet. Gapless
 *     and pitch-preserved, behind this same interface, with a toggle to
 *     fall back.
 */

import type { Region, Seconds } from "../core";

export type Unsubscribe = () => void;

/** What an engine needs to start; storage/ resolves FileRefs into this. */
export interface AudioSource {
  /** Stable id — matches Source.id in the project doc. */
  id: string;
  file: Blob;
}

export interface LoadedSource {
  id: string;
  duration: Seconds;
  sampleRate: number | null; // MediaElement path can't know this; worklet can
  channels: number | null;
}

export interface PlaybackEngine {
  load(source: AudioSource): Promise<LoadedSource>;
  /**
   * True when `load` would answer this source from memory. Optional
   * because it is only meaningful to an engine that decodes: a streaming
   * engine has nothing to hold, and the caller treats absent as "no".
   * The ui uses it to decide whether a load is worth warning about.
   */
  holds?(sourceId: string): boolean;
  play(): void;
  pause(): void;
  seek(seconds: Seconds): void;
  /** null clears the loop; playback continues past `end`. */
  setLoop(region: Region | null): void;
  /** 1.0 = original tempo. Implementations clamp to their usable range. */
  setRate(rate: number): void;
  /** Source-time seconds, not wall-time. Poll via rAF, never `timeupdate` (spec §11). */
  getPosition(): Seconds;
  /** Transport state. The one keypress that both starts and stops needs it. */
  readonly paused: boolean;
  onTick(cb: (seconds: Seconds) => void): Unsubscribe;
  /** Fires each time playback wraps from loop end to start — rep counting (spec §7). */
  onLoopWrap(cb: () => void): Unsubscribe;
  dispose(): void;
}
