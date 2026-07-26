/**
 * M1 engine (spec §3): an <audio> element with preservesPitch, routed
 * through a MediaElementAudioSourceNode so the Web Audio graph exists for
 * the count-in click later (§7) — even though nothing else uses it yet.
 *
 * Known tradeoff, accepted for M1: the loop seam has an audible hiccup
 * because seeking a compressed file has latency. Pre-roll makes it mostly
 * inaudible; WorkletEngine (M4) removes it behind this same interface.
 * If seams are worse than expected, decode to WAV before rewriting (§11).
 */

import type { Region, Seconds } from "../core";
import { RATE_MAX, RATE_MIN } from "../core";
import type {
  AudioSource,
  LoadedSource,
  PlaybackEngine,
  Unsubscribe,
} from "./PlaybackEngine";

export class MediaElementEngine implements PlaybackEngine {
  private readonly audio: HTMLAudioElement;
  private readonly ctx: AudioContext;
  private readonly node: MediaElementAudioSourceNode;
  private objectUrl: string | null = null;
  private loop: Region | null = null;
  private rafId: number | null = null;
  private tickCbs = new Set<(seconds: Seconds) => void>();
  private wrapCbs = new Set<() => void>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.audio = new Audio();
    // Set every vendor spelling (spec §11).
    this.audio.preservesPitch = true;
    (this.audio as unknown as Record<string, unknown>)["webkitPreservesPitch"] = true;
    (this.audio as unknown as Record<string, unknown>)["mozPreservesPitch"] = true;
    // One MediaElementAudioSourceNode per element, ever — create it once here.
    this.node = ctx.createMediaElementSource(this.audio);
    this.node.connect(ctx.destination);
    // Backstop for hidden tabs: rAF is frozen when the page isn't visible,
    // but audio keeps playing and would blow past the loop end. timeupdate
    // is far too coarse to be the clock (§11) — it exists here only so a
    // hidden tab still wraps at all.
    this.audio.addEventListener("timeupdate", () => this.checkWrap());
  }

  async load(source: AudioSource): Promise<LoadedSource> {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(source.file);
    this.audio.src = this.objectUrl;
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(`failed to load audio for source ${source.id}`));
      };
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", onMeta);
        this.audio.removeEventListener("error", onErr);
      };
      this.audio.addEventListener("loadedmetadata", onMeta);
      this.audio.addEventListener("error", onErr);
    });
    return {
      id: source.id,
      duration: this.audio.duration,
      sampleRate: null, // <audio> can't report this; WorkletEngine will
      channels: null,
    };
  }

  play(): void {
    // AudioContext starts suspended until a user gesture (spec §11); the
    // ui layer resumes it at startup, but resuming here too is harmless
    // and catches any path that missed the gesture.
    if (this.ctx.state === "suspended") void this.ctx.resume();
    void this.audio.play().catch(() => {
      /* autoplay rejection surfaces as silence + paused state; ui shows it */
    });
    this.startPolling();
  }

  pause(): void {
    this.audio.pause();
    this.stopPolling();
  }

  seek(seconds: Seconds): void {
    this.audio.currentTime = seconds;
  }

  setLoop(region: Region | null): void {
    this.loop = region;
  }

  setRate(rate: number): void {
    this.audio.playbackRate = Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
  }

  getPosition(): Seconds {
    return this.audio.currentTime;
  }

  onTick(cb: (seconds: Seconds) => void): Unsubscribe {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onLoopWrap(cb: () => void): Unsubscribe {
    this.wrapCbs.add(cb);
    return () => this.wrapCbs.delete(cb);
  }

  get paused(): boolean {
    return this.audio.paused;
  }

  dispose(): void {
    this.stopPolling();
    this.audio.pause();
    this.node.disconnect();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.audio.src = "";
    this.tickCbs.clear();
    this.wrapCbs.clear();
  }

  /** Position is polled in rAF — `timeupdate` fires at ~250 ms and is useless here (§11). */
  private startPolling(): void {
    if (this.rafId !== null) return;
    const poll = () => {
      this.checkWrap();
      for (const cb of this.tickCbs) cb(this.audio.currentTime);
      this.rafId = requestAnimationFrame(poll);
    };
    this.rafId = requestAnimationFrame(poll);
  }

  /** Loop wrap goes to region.start, never the pre-roll entry point (§7). */
  private checkWrap(): void {
    if (this.loop && !this.audio.paused && this.audio.currentTime >= this.loop.end) {
      // Carry the detection overshoot into the new pass so wall-clock time
      // stays phase-locked to the loop length — the count-in click (§7)
      // will depend on that. Tradeoff: skips up to 40 ms of the loop start
      // (inaudible) rather than drifting ~8 ms per wrap; overshoots beyond
      // the clamp (hidden-tab timeupdate wraps) accept drift instead of
      // eating an audible chunk of the passage.
      const overshoot = this.audio.currentTime - this.loop.end;
      this.audio.currentTime = this.loop.start + Math.min(overshoot, 0.04);
      for (const cb of this.wrapCbs) cb();
    }
  }

  private stopPolling(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
