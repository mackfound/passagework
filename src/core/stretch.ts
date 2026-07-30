/**
 * WSOLA time-stretching with sample-accurate loop wrap (spec §3, M4).
 *
 * Why this lives in core/ rather than audio/: it is arithmetic over
 * Float32Arrays — no DOM, no Web Audio, no dependencies — and §9 asks for
 * real unit tests of precisely this kind of thing ("loop wrap arithmetic,
 * rate clamping"). Keeping it here means the algorithm is tested in node
 * and the AudioWorkletProcessor is left as a shell with nothing testable
 * in it. audio/ owns the realm and the plumbing; core/ owns the math.
 *
 * WSOLA rather than a phase vocoder or SoundTouch/Rubber Band via WASM
 * (§3 leaves the choice open): it is a couple hundred lines with no build
 * step and no dependency — a reasonable thing to own rather than depend on
 * — and it leaves transients intact, which matters more for orchestral
 * attacks than the smoothness a phase vocoder buys. It is also well behaved
 * across the whole 0.5×–1.0× range this app clamps to (§10); phase vocoders
 * earn their keep well below that.
 *
 * The loop is not a seek. Reads wrap modulo the loop region, so the
 * overlap-add crosses the seam exactly as it crosses any other frame
 * boundary — the similarity search even aligns the loop's end against its
 * start. Gapless is a property of the design here, not a thing chased with
 * timers. That is the whole point of M4.
 *
 * All positions are source frames (samples), not seconds. Seconds are the
 * engine's business.
 */

/** Analysis/synthesis frame length. 24 ms ≈ 1150 frames at 48 kHz. */
export const STRETCH_FRAME_MS = 24;

/**
 * How far the similarity search may slide a frame, ±12 ms. It has to span
 * at least one period of the lowest pitch that matters, or low strings beat
 * against themselves: 12 ms covers down to ~42 Hz.
 */
export const STRETCH_SEARCH_MS = 12;

/**
 * The similarity search compares every 4th sample. Alignment is driven by
 * the low end of the spectrum, so decimating costs nothing audible and cuts
 * the search — by far the most expensive thing in the audio thread — to a
 * quarter. Raise it to 1 if alignment ever looks suspect; the shape of the
 * code does not change.
 */
const CORR_DECIMATION = 4;

/** Periodic Hann. At 50% overlap w[k] + w[k + N/2] === 1, so overlap-add at
 *  rate 1.0 with no slide reconstructs the input rather than colouring it. */
function hann(length: number): Float64Array {
  const w = new Float64Array(length);
  for (let i = 0; i < length; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
  return w;
}

export class TimeStretcher {
  readonly sampleRate: number;
  /** Synthesis hop — one produced block. Half a frame. */
  private readonly hop: number;
  private readonly frame: number;
  private readonly search: number;
  private readonly window: Float64Array;
  /** Decimated copy of the segment the previous frame wants to continue into. */
  private readonly template: Float64Array;

  private src: Float32Array[] = [];
  private frames = 0;

  private rate = 1;
  private loopStart = 0;
  private loopEnd = 0;
  private loopLen = 0;
  /** True once playback has reached the loop; pre-roll must not wrap (§7). */
  private wrapReads = false;

  /** Nominal read position for the next frame, in source frames. Fractional. */
  private pos = 0;
  /** Where the previous frame would have continued, had it not been cut. */
  private natural = 0;
  /** Windowed second half of the previous frame, awaiting its overlap partner. */
  private tail: Float32Array[] = [];
  /** One produced block, drained by render() in whatever sizes it asks for. */
  private ready: Float32Array[] = [];
  private readyLen = 0;
  private readyRead = 0;
  private wraps = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    // Odd frame lengths would leave hop*2 !== frame; round the hop instead.
    this.hop = Math.max(32, Math.round((sampleRate * STRETCH_FRAME_MS) / 2000));
    this.frame = this.hop * 2;
    this.search = Math.max(0, Math.round((sampleRate * STRETCH_SEARCH_MS) / 1000));
    this.window = hann(this.frame);
    this.template = new Float64Array(Math.ceil(this.hop / CORR_DECIMATION));
  }

  /** Frame length in samples — the engine reports it as the latency floor. */
  get frameLength(): number {
    return this.frame;
  }

  get sourceFrames(): number {
    return this.frames;
  }

  /**
   * Adopt decoded PCM. The arrays are held by reference and never copied —
   * a symphony is hundreds of megabytes and there must only ever be one.
   */
  setSource(channels: Float32Array[]): void {
    this.src = channels;
    this.frames = channels[0]?.length ?? 0;
    this.tail = channels.map(() => new Float32Array(this.hop));
    this.ready = channels.map(() => new Float32Array(this.hop));
    this.seek(0);
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  /** Frames, half-open [start, end). Pass null to play straight through. */
  setLoop(start: number | null, end?: number): void {
    if (start === null || end === undefined || end - start <= 0) {
      this.loopStart = 0;
      this.loopEnd = 0;
      this.loopLen = 0;
      this.wrapReads = false;
      return;
    }
    this.loopStart = start;
    this.loopEnd = end;
    this.loopLen = end - start;
  }

  /**
   * Jump. Drops the produced block and the overlap tail, so the first
   * output after a seek fades in over one hop (~12 ms) instead of clicking.
   * Loop wraps deliberately do not come through here — that is what makes
   * them seamless.
   */
  seek(frame: number): void {
    this.pos = Math.max(0, frame);
    this.natural = this.pos;
    this.readyLen = 0;
    this.readyRead = 0;
    this.wrapReads = false;
    for (const t of this.tail) t.fill(0);
  }

  /**
   * Audible source position, accounting for output already produced but not
   * yet drained. Without that correction the playhead runs one hop ahead of
   * what is coming out of the speakers.
   *
   * While the loop is armed this is held inside the region. Both edges need
   * it: `pos` runs up to a hop past the end before the next frame wraps it,
   * and the seam crossfade puts the drain cursor a hop before the start.
   * Neither is worth more than a comment as audio, but a playhead that
   * strays outside the shaded region reads as a bug.
   */
  get positionFrames(): number {
    const p = this.pos - (this.readyLen - this.readyRead) * this.rate;
    if (!this.wrapReads || this.loopLen === 0) return p;
    if (p >= this.loopEnd) return this.loopStart + ((p - this.loopStart) % this.loopLen);
    return p < this.loopStart ? this.loopStart : p;
  }

  /** Wraps since the last call. The engine turns these into onLoopWrap. */
  takeWraps(): number {
    const n = this.wraps;
    this.wraps = 0;
    return n;
  }

  /**
   * Fill `count` frames of each channel of `out`. Channels beyond the
   * source's are fed from it cyclically, so a mono recording reaches both
   * ears rather than only the left.
   */
  render(out: Float32Array[], count: number): void {
    if (this.ready.length === 0 || this.frames === 0) {
      for (const ch of out) ch.fill(0, 0, count);
      return;
    }
    let done = 0;
    while (done < count) {
      if (this.readyRead >= this.readyLen) this.produce();
      const n = Math.min(count - done, this.readyLen - this.readyRead);
      for (let c = 0; c < out.length; c++) {
        const dst = out[c]!;
        const src = this.ready[c % this.ready.length]!;
        for (let i = 0; i < n; i++) dst[done + i] = src[this.readyRead + i]!;
      }
      this.readyRead += n;
      done += n;
    }
  }

  // ---------- internals ----------

  /** Produce one hop of output and advance the analysis position. */
  private produce(): void {
    const { hop, window } = this;

    // Wrap before reading, so the whole frame is drawn from the loop's
    // coordinate space. A single subtraction is not enough here: a seek can
    // land arbitrarily far past the end while a loop is armed.
    if (this.loopLen > 0 && this.pos >= this.loopStart) {
      this.wrapReads = true;
      if (this.pos >= this.loopEnd) {
        this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLen);
        this.wraps++;
      }
    } else {
      this.wrapReads = false;
    }

    const base = Math.round(this.pos);
    // At rate 1.0 the natural continuation is the exact continuation, so
    // skip the search: playback is then bit-transparent and free.
    const a = this.rate === 1 || this.search === 0 ? base : base + this.bestOffset(base);

    for (let c = 0; c < this.src.length; c++) {
      const s = this.src[c]!;
      const out = this.ready[c]!;
      const tail = this.tail[c]!;
      for (let k = 0; k < hop; k++) {
        out[k] = tail[k]! + window[k]! * this.read(s, a + k);
      }
      for (let k = 0; k < hop; k++) {
        tail[k] = window[hop + k]! * this.read(s, a + hop + k);
      }
    }

    this.natural = a + hop;
    this.readyLen = hop;
    this.readyRead = 0;
    this.pos += hop * this.rate;
  }

  /**
   * Slide the frame by up to ±search to the offset whose opening overlap
   * best continues the previous frame. Normalised by candidate energy —
   * a raw dot product just picks whichever candidate is loudest.
   *
   * Correlating channel 0 alone, then applying that one offset to every
   * channel, is not a shortcut: sliding channels independently would smear
   * the stereo image, which is far more audible than the alignment a second
   * correlation would buy.
   */
  private bestOffset(base: number): number {
    const { hop, search, template } = this;
    const ref = this.src[0]!;
    for (let i = 0, k = 0; k < hop; i++, k += CORR_DECIMATION) {
      template[i] = this.read(ref, this.natural + k);
    }

    let bestD = 0;
    let bestScore = this.similarity(ref, base);
    for (let d = -search; d <= search; d++) {
      if (d === 0) continue;
      const score = this.similarity(ref, base + d);
      // Strictly greater, and zero scored first: a tie keeps the frame
      // where it naturally falls instead of jittering between equals.
      if (score > bestScore) {
        bestScore = score;
        bestD = d;
      }
    }
    return bestD;
  }

  private similarity(s: Float32Array, at: number): number {
    const { hop, template } = this;
    let dot = 0;
    let energy = 0;
    for (let i = 0, k = 0; k < hop; i++, k += CORR_DECIMATION) {
      const c = this.read(s, at + k);
      dot += template[i]! * c;
      energy += c * c;
    }
    return energy > 1e-12 ? dot / Math.sqrt(energy) : 0;
  }

  /**
   * One sample, wrapped into the loop when the loop is armed and clamped to
   * silence outside the source. The loops run at most once per call in
   * practice — positions are normalised in produce() and a frame overhangs
   * by well under one region (MIN_REGION is 100 ms, a frame plus its search
   * is 36 ms) — but they are written to be correct for any region.
   */
  private read(s: Float32Array, i: number): number {
    let j = i;
    if (this.wrapReads) {
      while (j >= this.loopEnd) j -= this.loopLen;
      while (j < this.loopStart) j += this.loopLen;
    }
    return j >= 0 && j < s.length ? s[j]! : 0;
  }
}
