/**
 * M4 engine (spec §3, §6): gapless and pitch-preserved, behind the same
 * PlaybackEngine interface MediaElementEngine implements.
 *
 * The whole recording is decoded to PCM and handed to an AudioWorklet,
 * which time-stretches with WSOLA and wraps the loop inside the audio
 * thread. That removes both M1 compromises at once: there is no seek at the
 * seam to hiccup, and slowing down no longer leans on the browser's
 * `preservesPitch`, whose quality collapsed well above the 0.5× the spec
 * predicted (0.70× was the honest floor in practice).
 *
 * The cost is memory: decoded stereo PCM is ~11 MB per minute at 48 kHz, so
 * a symphony is most of a gigabyte, and the decode peaks at roughly twice
 * that while the copies are made. Hence MAX_PCM_BYTES below — past it this
 * engine refuses to load and the UI keeps MediaElementEngine, which streams
 * and does not care how long the file is. Storing Int16 instead of Float32
 * would halve the footprint at no audible cost and is the obvious next move
 * if that limit ever bites; it changes this file and nothing else.
 *
 * Decoded recordings are kept, not discarded on the next load. A project
 * whose excerpts point at different movements was re-decoding on every
 * switch — seconds of silence to move between two passages, repeatedly,
 * which is exactly the motion this app exists to make cheap. They now stay
 * in the worklet and switching is a pointer swap. MAX_PCM_BYTES became the
 * budget for all of them together rather than for one, so the ceiling did
 * not move; past it the least recently used are released.
 */

import type { Region, Seconds } from "../core";
import { clampRate } from "../core";
import type {
  AudioSource,
  LoadedSource,
  PlaybackEngine,
  Unsubscribe,
} from "./PlaybackEngine";
import {
  type FromWorklet,
  type ToWorklet,
  STRETCH_PROCESSOR,
} from "./stretch-protocol";
// Vite bundles the processor and its core/ imports into one standalone
// script and hands back its URL. addModule needs a URL, not a module.
import processorUrl from "./stretch-processor.ts?worker&url";

/**
 * Total budget for every recording held at once. 900 MB of Float32 is about
 * 39 minutes of 48 kHz stereo — a couple of symphony movements, not a full
 * opera. A single recording larger than this is refused outright; several
 * that overflow it together are released oldest-first instead. The number
 * is a memory ceiling, not a musical judgement; see the header.
 */
export const MAX_PCM_BYTES = 900_000_000;

export type EngineFailure = "unsupported" | "too-large" | "decode-failed";

export class EngineLoadError extends Error {
  constructor(
    readonly reason: EngineFailure,
    message: string,
  ) {
    super(message);
    this.name = "EngineLoadError";
  }
}

/** Duration without decoding, so the size guard can run first. */
function probeDuration(file: Blob): Promise<Seconds> {
  return new Promise((resolve, reject) => {
    const el = new Audio();
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onErr);
      el.src = "";
      URL.revokeObjectURL(url);
    };
    const onMeta = () => {
      const d = el.duration;
      cleanup();
      Number.isFinite(d) && d > 0
        ? resolve(d)
        : reject(new EngineLoadError("decode-failed", "the recording reports no duration"));
    };
    const onErr = () => {
      cleanup();
      reject(new EngineLoadError("decode-failed", "this browser can't read that recording"));
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onErr);
    el.src = url;
  });
}

/**
 * addModule per context, not per engine. A context has one worklet global
 * scope, so evaluating the module twice would call registerProcessor twice
 * with the same name — and the engine toggle builds a fresh engine every
 * time it is flipped back.
 */
const moduleReady = new WeakMap<BaseAudioContext, Promise<void>>();

export class WorkletEngine implements PlaybackEngine {
  private readonly ctx: AudioContext;
  private readonly node: AudioWorkletNode;
  private readonly sr: number;
  private playing = false;
  private posFrames = 0;
  /**
   * What the worklet is holding, by source id, with what it costs and what
   * load() answered for it. Insertion order is the LRU order: a cache hit
   * re-inserts, so the front is the coldest. The samples themselves live on
   * the audio thread — only the bookkeeping is here.
   */
  private readonly held = new Map<string, { bytes: number; loaded: LoadedSource }>();
  private rafId: number | null = null;
  private tickCbs = new Set<(seconds: Seconds) => void>();
  private wrapCbs = new Set<() => void>();

  /**
   * Async because addModule is. Rejects when the browser has no
   * AudioWorklet or the module fails to load — the caller falls back.
   */
  static async create(ctx: AudioContext): Promise<WorkletEngine> {
    if (!ctx.audioWorklet) {
      throw new EngineLoadError("unsupported", "this browser has no AudioWorklet");
    }
    let ready = moduleReady.get(ctx);
    if (!ready) {
      ready = ctx.audioWorklet.addModule(processorUrl);
      moduleReady.set(ctx, ready);
    }
    try {
      await ready;
    } catch (err) {
      // Don't cache a failure: a module that failed to fetch may load on a
      // later attempt, and a cached rejection would make that impossible.
      moduleReady.delete(ctx);
      throw err;
    }
    return new WorkletEngine(ctx);
  }

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.node = new AudioWorkletNode(ctx, STRETCH_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      // Fixed at two: a mono source is fanned out by the stretcher rather
      // than reconfiguring the graph per recording.
      outputChannelCount: [2],
    });
    this.node.connect(ctx.destination);
    this.node.port.onmessage = (ev: MessageEvent<FromWorklet>) => {
      this.posFrames = ev.data.frame;
      for (let i = 0; i < ev.data.wraps; i++) {
        for (const cb of this.wrapCbs) cb();
      }
    };
  }

  private send(msg: ToWorklet, transfer?: Transferable[]): void {
    if (transfer) this.node.port.postMessage(msg, transfer);
    else this.node.port.postMessage(msg);
  }

  /** True when load() would answer from memory. See PlaybackEngine.holds. */
  holds(sourceId: string): boolean {
    return this.held.has(sourceId);
  }

  /**
   * Release the oldest recordings until `incoming` more bytes fit. `keep`
   * is the one being loaded now and is never a candidate — evicting it
   * would decode a recording only to throw it away.
   */
  private makeRoom(incoming: number, keep: string): void {
    let total = incoming;
    for (const entry of this.held.values()) total += entry.bytes;
    if (total <= MAX_PCM_BYTES) return;

    const dropped: string[] = [];
    // Map iterates in insertion order and a hit re-inserts, so the front
    // is the least recently used.
    for (const [id, entry] of this.held) {
      if (id === keep) continue;
      this.held.delete(id);
      dropped.push(id);
      total -= entry.bytes;
      if (total <= MAX_PCM_BYTES) break;
    }
    if (dropped.length > 0) this.send({ type: "evict", ids: dropped });
  }

  async load(source: AudioSource): Promise<LoadedSource> {
    const hit = this.held.get(source.id);
    if (hit) {
      this.held.delete(source.id); // re-insert at the back: most recently used
      this.held.set(source.id, hit);
      this.send({ type: "select", id: source.id });
      this.posFrames = 0;
      this.playing = false;
      return hit.loaded;
    }

    const duration = await probeDuration(source.file);
    // Assume stereo for the estimate — the true channel count is only known
    // after decoding, which is the thing being guarded against.
    const estimate = duration * this.sr * 2 * Float32Array.BYTES_PER_ELEMENT;
    if (estimate > MAX_PCM_BYTES) {
      throw new EngineLoadError(
        "too-large",
        `${Math.round(duration / 60)} min is too long to hold in memory for time-stretching`,
      );
    }

    let buf: AudioBuffer;
    try {
      // decodeAudioData takes ownership of the ArrayBuffer, so the
      // compressed copy is released before the decoded one peaks.
      buf = await this.ctx.decodeAudioData(await source.file.arrayBuffer());
    } catch {
      throw new EngineLoadError("decode-failed", "this browser can't decode that recording");
    }

    // Beyond stereo, take the front pair. Surround orchestral rips are rare
    // enough that a real downmix is not worth carrying; a listener would
    // hear the missing centre and can re-encode.
    const count = Math.min(buf.numberOfChannels, 2);
    const channels: Float32Array[] = [];
    for (let c = 0; c < count; c++) {
      const data = new Float32Array(buf.length);
      buf.copyFromChannel(data, c);
      channels.push(data);
    }
    const bytes = channels.reduce((n, a) => n + a.byteLength, 0);
    this.makeRoom(bytes, source.id);
    this.send(
      { type: "source", id: source.id, channels },
      channels.map((a) => a.buffer),
    );
    this.posFrames = 0;
    this.playing = false;

    const loaded: LoadedSource = {
      id: source.id,
      duration: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
    };
    this.held.set(source.id, { bytes, loaded });
    return loaded;
  }

  play(): void {
    // Same belt-and-braces as M1: the ui layer resumes on the arm gesture,
    // but a path that missed the gesture should not fail silently (§11).
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.playing = true;
    this.send({ type: "play" });
    this.startPolling();
  }

  pause(): void {
    this.playing = false;
    this.send({ type: "pause" });
    this.stopPolling();
  }

  seek(seconds: Seconds): void {
    this.posFrames = seconds * this.sr;
    this.send({ type: "seek", frame: this.posFrames });
  }

  setLoop(region: Region | null): void {
    this.send(
      region
        ? { type: "loop", start: region.start * this.sr, end: region.end * this.sr }
        : { type: "loop", start: null, end: 0 },
    );
  }

  setRate(rate: number): void {
    this.send({ type: "rate", rate: clampRate(rate) });
  }

  getPosition(): Seconds {
    return this.posFrames / this.sr;
  }

  get paused(): boolean {
    return !this.playing;
  }

  onTick(cb: (seconds: Seconds) => void): Unsubscribe {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onLoopWrap(cb: () => void): Unsubscribe {
    this.wrapCbs.add(cb);
    return () => this.wrapCbs.delete(cb);
  }

  dispose(): void {
    this.stopPolling();
    this.send({ type: "pause" });
    // Hand back the PCM explicitly rather than waiting for the node to be
    // collected. Switching engines on a symphony would otherwise hold most
    // of a gigabyte until the collector got round to it — and with several
    // recordings held, that much again per recording.
    if (this.held.size > 0) this.send({ type: "evict", ids: [...this.held.keys()] });
    this.held.clear();
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.tickCbs.clear();
    this.wrapCbs.clear();
  }

  /**
   * Ticks are still driven from rAF, matching M1 so the UI cannot tell the
   * engines apart. The difference is what happens when a tab is hidden and
   * rAF freezes (§11): here the loop keeps wrapping correctly in the audio
   * thread, so there is no coarse `timeupdate` backstop to get wrong.
   */
  private startPolling(): void {
    if (this.rafId !== null) return;
    const poll = () => {
      const pos = this.getPosition();
      for (const cb of this.tickCbs) cb(pos);
      this.rafId = requestAnimationFrame(poll);
    };
    this.rafId = requestAnimationFrame(poll);
  }

  private stopPolling(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
