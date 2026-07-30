import { describe, expect, it } from "vitest";
import { TimeStretcher } from "./stretch";

const SR = 48000;

function sine(hz: number, frames: number, phase = 0): Float32Array {
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) x[i] = Math.sin(phase + (2 * Math.PI * hz * i) / SR);
  return x;
}

/** Deterministic broadband noise — a signal with no periodicity to hide in. */
function noise(frames: number, seed = 1): Float32Array {
  const x = new Float32Array(frames);
  let s = seed;
  for (let i = 0; i < frames; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = (s / 0x80000000 - 1) * 0.5;
  }
  return x;
}

/**
 * Drive the stretcher exactly as the worklet does: fixed 128-frame quanta,
 * which is also what exercises the partial-drain path.
 */
function renderTo(st: TimeStretcher, frames: number, channels = 2): Float32Array[] {
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const block = Array.from({ length: channels }, () => new Float32Array(128));
  let done = 0;
  while (done < frames) {
    const n = Math.min(128, frames - done);
    st.render(block, n);
    for (let c = 0; c < channels; c++) out[c]!.set(block[c]!.subarray(0, n), done);
    done += n;
  }
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / (to - from));
}

/** Zero-crossing rate. Exact enough for a clean tone, and assumption-free. */
function dominantHz(x: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1]! < 0 !== x[i]! < 0) crossings++;
  }
  return (crossings * SR) / (2 * x.length);
}

function loaded(channels: Float32Array[]): TimeStretcher {
  const st = new TimeStretcher(SR);
  st.setSource(channels);
  return st;
}

describe("TimeStretcher at rate 1.0", () => {
  it("reconstructs the input sample for sample", () => {
    const src = noise(SR);
    const st = loaded([src]);
    const [out] = renderTo(st, 20000, 1);
    // The first hop fades in from an empty overlap tail; everything after
    // it is the input back again, because Hann at 50% overlap sums to one.
    for (let i = 4096; i < 20000; i += 37) {
      expect(out![i]!).toBeCloseTo(src[i]!, 6);
    }
  });

  it("advances position by one frame per frame rendered", () => {
    const st = loaded([noise(SR)]);
    renderTo(st, 12800, 1);
    expect(st.positionFrames).toBeCloseTo(12800, 3);
  });
});

describe("TimeStretcher preserves pitch", () => {
  it("keeps a 440 Hz tone at 440 Hz when slowed to 0.5×", () => {
    const st = loaded([sine(440, 4 * SR)]);
    st.setRate(0.5);
    const [out] = renderTo(st, 2 * SR, 1);
    // Skip the fade-in; measure a whole second in the middle.
    const middle = out!.subarray(SR / 2, SR + SR / 2);
    expect(dominantHz(middle)).toBeGreaterThan(431);
    expect(dominantHz(middle)).toBeLessThan(449);
  });

  it("consumes source at the playback rate", () => {
    const st = loaded([sine(440, 4 * SR)]);
    st.setRate(0.7);
    renderTo(st, SR, 1);
    // A second of output at 0.7× is 0.7 s of source, ± one frame of slide.
    expect(st.positionFrames).toBeGreaterThan(0.7 * SR - 1200);
    expect(st.positionFrames).toBeLessThan(0.7 * SR + 1200);
  });

  it("holds amplitude across the stretch rather than beating", () => {
    const st = loaded([sine(220, 4 * SR)]);
    st.setRate(0.6);
    const [out] = renderTo(st, 2 * SR, 1);
    const level = rms(out!, SR / 2, SR + SR / 2);
    // A unit sine is 0.707 RMS. Overlap-add that misaligns frames cancels
    // and this sags; a window that does not sum to one makes it ripple.
    expect(level).toBeGreaterThan(0.63);
    expect(level).toBeLessThan(0.78);
  });

  it("slides every channel by the same offset, holding the stereo image", () => {
    // Quadrature pair: sin and cos of one tone. A common offset keeps them
    // 90° apart at every sample, so sin² + cos² stays at one. Aligning the
    // channels independently would let that relationship drift.
    const st = loaded([sine(150, 3 * SR), sine(150, 3 * SR, Math.PI / 2)]);
    st.setRate(0.65);
    const [l, r] = renderTo(st, SR);
    let worst = 0;
    for (let i = SR / 4; i < SR * 0.75; i++) {
      worst = Math.max(worst, Math.abs(l![i]! * l![i]! + r![i]! * r![i]! - 1));
    }
    expect(worst).toBeLessThan(0.2);
  });

  it("feeds a mono source to every output channel", () => {
    const st = loaded([noise(SR)]);
    st.setRate(0.8);
    const [l, r] = renderTo(st, 4096);
    expect(Array.from(r!)).toEqual(Array.from(l!));
  });
});

describe("TimeStretcher loop wrap", () => {
  const START = SR; // 1.0 s
  const END = SR + 24071; // deliberately not a whole number of periods

  it("wraps once per pass and counts every pass", () => {
    const st = loaded([sine(440, 10 * SR)]);
    st.setLoop(START, END);
    st.seek(START);
    const len = END - START;
    renderTo(st, Math.round(5.5 * len), 1);
    expect(st.takeWraps()).toBe(5);
  });

  it("holds the position inside the region", () => {
    const st = loaded([sine(440, 10 * SR)]);
    st.setLoop(START, END);
    st.seek(START);
    st.setRate(0.7);
    for (let i = 0; i < 400; i++) {
      renderTo(st, 512, 1);
      expect(st.positionFrames).toBeGreaterThanOrEqual(START);
      expect(st.positionFrames).toBeLessThan(END);
    }
  });

  it("does not wrap during pre-roll — entry and loop-start are different points", () => {
    const st = loaded([sine(440, 10 * SR)]);
    st.setLoop(START, END);
    st.seek(START - SR / 2); // enter half a second early (spec §7)
    renderTo(st, SR / 4, 1);
    expect(st.takeWraps()).toBe(0);
    expect(st.positionFrames).toBeLessThan(START);
  });

  it("pulls a seek past the region back into it", () => {
    const st = loaded([sine(440, 10 * SR)]);
    st.setLoop(START, END);
    st.seek(5 * SR);
    renderTo(st, 1024, 1);
    expect(st.positionFrames).toBeGreaterThanOrEqual(START);
    expect(st.positionFrames).toBeLessThan(END);
  });

  it("has no gap at the seam — the whole point of M4", () => {
    const st = loaded([sine(440, 10 * SR)]);
    st.setLoop(START, END);
    st.seek(START);
    st.setRate(0.7);
    const [out] = renderTo(st, 3 * SR, 1);
    // Sweep 5 ms windows across several passes. A seek-based loop drops a
    // window to near silence at each seam; a gapless one never dips.
    const win = Math.round(SR * 0.005);
    let quietest = Infinity;
    for (let i = win * 4; i + win < out!.length; i += win) {
      quietest = Math.min(quietest, rms(out!, i, i + win));
    }
    expect(quietest).toBeGreaterThan(0.5);
  });

  it("clearing the loop lets playback run past the end", () => {
    const st = loaded([sine(440, 10 * SR)]);
    st.setLoop(START, END);
    st.seek(START);
    renderTo(st, 1024, 1);
    st.setLoop(null);
    renderTo(st, 2 * SR, 1);
    expect(st.positionFrames).toBeGreaterThan(END);
    expect(st.takeWraps()).toBe(0);
  });
});

describe("TimeStretcher edges", () => {
  it("renders silence with no source rather than throwing", () => {
    const st = new TimeStretcher(SR);
    const [out] = renderTo(st, 1024, 1);
    expect(out!.every((v) => v === 0)).toBe(true);
  });

  it("runs off the end of the source into silence", () => {
    const st = loaded([sine(440, SR)]);
    st.seek(SR - 1000);
    const [out] = renderTo(st, 8192, 1);
    expect(rms(out!, 6000, 8192)).toBe(0);
  });

  it("never emits a non-finite sample", () => {
    const st = loaded([noise(2 * SR), noise(2 * SR, 99)]);
    st.setRate(0.5);
    st.setLoop(1000, 60000);
    st.seek(1000);
    const [l, r] = renderTo(st, SR);
    expect(l!.every(Number.isFinite)).toBe(true);
    expect(r!.every(Number.isFinite)).toBe(true);
  });

  it("survives a rate change mid-stream without a discontinuity", () => {
    const st = loaded([sine(300, 4 * SR)]);
    st.setRate(0.5);
    renderTo(st, SR, 1);
    st.setRate(1.0);
    const [out] = renderTo(st, 8192, 1);
    // Largest sample-to-sample jump in a 300 Hz unit sine is ~0.04; a click
    // would show up as a step far larger than that.
    let jump = 0;
    for (let i = 1; i < out!.length; i++) jump = Math.max(jump, Math.abs(out![i]! - out![i - 1]!));
    expect(jump).toBeLessThan(0.3);
  });
});
