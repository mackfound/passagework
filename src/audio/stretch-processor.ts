/**
 * The audio-thread shell for M4 (spec §3, §6).
 *
 * Deliberately thin: message plumbing and a render call. Every decision
 * worth testing lives in core/stretch, which runs in node — there is
 * nothing here a test could meaningfully assert that a listen would not
 * catch faster.
 *
 * Runs in AudioWorkletGlobalScope, which TypeScript's DOM lib does not
 * describe. The declarations below are module-scoped rather than ambient so
 * they cannot leak `sampleRate` into main-thread files, where it would mean
 * something else entirely.
 */

import { TimeStretcher } from "../core/stretch";
import {
  type FromWorklet,
  type ToWorklet,
  REPORT_EVERY_QUANTA,
  STRETCH_PROCESSOR,
} from "./stretch-protocol";

declare const sampleRate: number;
declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort };
};
declare function registerProcessor(name: string, ctor: unknown): void;

class StretchProcessor extends AudioWorkletProcessor {
  private readonly stretcher = new TimeStretcher(sampleRate);
  /**
   * Decoded recordings, by source id. Held here rather than on the main
   * thread because that is where they already are: the PCM was transferred
   * in, and selecting between them costs a pointer instead of a structured
   * clone of a hundred megabytes. The main thread owns the budget and
   * sends "evict"; this map does no thinking.
   */
  private readonly sources = new Map<string, Float32Array[]>();
  private current: string | null = null;
  private playing = false;
  private quanta = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToWorklet>) => {
      const msg = ev.data;
      switch (msg.type) {
        case "source":
          this.sources.set(msg.id, msg.channels);
          this.current = msg.id;
          this.stretcher.setSource(msg.channels);
          break;
        case "select": {
          const channels = this.sources.get(msg.id);
          // Missing means the two sides disagree about what is held. Keep
          // playing what we have rather than dropping into silence; the
          // main thread will decode and send it as a "source".
          if (!channels) break;
          this.current = msg.id;
          this.stretcher.setSource(channels);
          break;
        }
        case "evict":
          for (const id of msg.ids) this.sources.delete(id);
          if (this.current !== null && !this.sources.has(this.current)) {
            this.current = null;
            this.stretcher.setSource([]);
          }
          break;
        case "play":
          this.playing = true;
          break;
        case "pause":
          this.playing = false;
          break;
        case "seek":
          this.stretcher.seek(msg.frame);
          break;
        case "loop":
          this.stretcher.setLoop(msg.start, msg.end);
          break;
        case "rate":
          this.stretcher.setRate(msg.rate);
          break;
      }
      // Answer every command, so a seek or a pause moves the playhead
      // without waiting on the next playing report.
      this.report();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    if (this.playing) {
      this.stretcher.render(out, out[0]?.length ?? 0);
      if (++this.quanta >= REPORT_EVERY_QUANTA) {
        this.quanta = 0;
        this.report();
      }
    } else {
      for (const ch of out) ch.fill(0);
    }
    // Never false: this node lives as long as the engine, and returning
    // false would silently retire it with no way back.
    return true;
  }

  private report(): void {
    const msg: FromWorklet = {
      frame: this.stretcher.positionFrames,
      wraps: this.stretcher.takeWraps(),
    };
    this.port.postMessage(msg);
  }
}

registerProcessor(STRETCH_PROCESSOR, StretchProcessor);
