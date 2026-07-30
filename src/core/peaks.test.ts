import { describe, expect, it } from "vitest";

import { GRID } from "./loop";
import {
  MIN_VIEW_SPAN,
  PEAKS_VERSION,
  bucketAt,
  bucketSizeFor,
  clampView,
  computePeaks,
  sampleWindow,
  secondsPerBucket,
  timeToX,
  viewForRegion,
  xToTime,
  zoomView,
} from "./peaks";

/** Ramp 0..1 over `n` samples — every bucket has a distinct, checkable range. */
function ramp(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i / (n - 1);
  return a;
}

describe("computePeaks", () => {
  it("buckets at the 10 ms grid so one bucket is one nudge step", () => {
    expect(bucketSizeFor(8000)).toBe(80);
    const env = computePeaks([new Float32Array(8000)], 8000);
    expect(secondsPerBucket(env)).toBeCloseTo(GRID, 10);
    expect(env.min.length).toBe(100); // 1 s at 10 ms
    expect(env.duration).toBeCloseTo(1, 10);
    expect(env.version).toBe(PEAKS_VERSION);
  });

  it("records the min and max within each bucket", () => {
    // 4 samples per bucket, two buckets: [-1, 1, 0, 0] then [0.5, -0.25, 0, 0]
    const data = new Float32Array([-1, 1, 0, 0, 0.5, -0.25, 0, 0]);
    const env = computePeaks([data], 400, 4);
    expect(Array.from(env.min)).toEqual([-1, -0.25]);
    expect(Array.from(env.max)).toEqual([1, 0.5]);
  });

  it("takes peaks across channels rather than mixing them down", () => {
    // Opposite-phase channels: a mixdown would cancel to silence.
    const l = new Float32Array([1, 1, 1, 1]);
    const r = new Float32Array([-1, -1, -1, -1]);
    const env = computePeaks([l, r], 400, 4);
    expect(env.max[0]).toBe(1);
    expect(env.min[0]).toBe(-1);
  });

  it("pads a short final bucket without leaving Infinity behind", () => {
    const env = computePeaks([new Float32Array([1, 1, 1, 1, 0.5])], 400, 4);
    expect(env.min.length).toBe(2);
    expect(env.min[1]).toBe(0.5);
    expect(env.max[1]).toBe(0.5);
    expect(Number.isFinite(env.min[1]!)).toBe(true);
  });

  it("survives empty input instead of throwing", () => {
    const env = computePeaks([], 8000);
    expect(env.min.length).toBe(0);
    expect(env.duration).toBe(0);
  });
});

describe("bucketAt", () => {
  const env = computePeaks([ramp(8000)], 8000);

  it("maps time to the containing bucket", () => {
    expect(bucketAt(env, 0)).toBe(0);
    expect(bucketAt(env, 0.025)).toBe(2);
  });

  it("clamps out-of-range times into the array", () => {
    expect(bucketAt(env, -5)).toBe(0);
    expect(bucketAt(env, 999)).toBe(env.min.length - 1);
  });
});

describe("sampleWindow", () => {
  const env = computePeaks([ramp(8000)], 8000); // 1 s ramp, 100 buckets

  it("reduces the whole file to the requested column count", () => {
    const cols = sampleWindow(env, { start: 0, end: 1 }, 50);
    expect(cols.min.length).toBe(50);
    // A rising ramp: the last column peaks higher than the first.
    expect(cols.max[49]!).toBeGreaterThan(cols.max[0]!);
  });

  it("widens rather than interpolating when zoomed past bucket resolution", () => {
    // 10 columns over 20 ms = 2 buckets: columns must repeat, not invent values.
    const cols = sampleWindow(env, { start: 0, end: 0.02 }, 10);
    const distinct = new Set(Array.from(cols.max));
    expect(distinct.size).toBeLessThanOrEqual(2);
  });

  it("leaves columns past the end of the recording flat", () => {
    const cols = sampleWindow(env, { start: 0.9, end: 1.5 }, 6);
    expect(cols.max[5]).toBe(0); // beyond duration
    expect(cols.max[0]).toBeGreaterThan(0);
  });

  it("returns empty output for a degenerate window", () => {
    expect(sampleWindow(env, { start: 1, end: 1 }, 10).min.every((v) => v === 0)).toBe(true);
    expect(sampleWindow(env, { start: 0, end: 1 }, 0).min.length).toBe(0);
  });
});

describe("view windows", () => {
  it("pads a region so both edges stay draggable", () => {
    const view = viewForRegion({ start: 10, end: 12 }, 60);
    expect(view.start).toBeCloseTo(9, 10);
    expect(view.end).toBeCloseTo(13, 10);
  });

  it("shows the whole recording for an untimed excerpt", () => {
    expect(viewForRegion(null, 60)).toEqual({ start: 0, end: 60 });
  });

  it("keeps a padded region inside the recording at the edges", () => {
    // Padding a 2 s region by 50% each side wants [-1, 3]; there is no music
    // before 0, so the window shifts in and keeps its 4 s span.
    const view = viewForRegion({ start: 0, end: 2 }, 60);
    expect(view.start).toBe(0);
    expect(view.end).toBeCloseTo(4, 10);
  });

  it("clamps a window wider than the recording to the recording", () => {
    expect(clampView({ start: -10, end: 500 }, 60)).toEqual({ start: 0, end: 60 });
  });

  it("refuses to zoom below the minimum span", () => {
    const view = zoomView({ start: 0, end: 10 }, 0.0001, 5, 60);
    expect(view.end - view.start).toBeCloseTo(MIN_VIEW_SPAN, 10);
  });

  it("holds the anchor time still while zooming", () => {
    const before = { start: 0, end: 10 };
    const after = zoomView(before, 0.5, 4, 60);
    // 4 s sat 40% across the old window; it must sit 40% across the new one.
    expect((4 - after.start) / (after.end - after.start)).toBeCloseTo(0.4, 10);
  });

  it("zooms out without escaping the recording", () => {
    const view = zoomView({ start: 50, end: 60 }, 4, 55, 60);
    expect(view.start).toBeGreaterThanOrEqual(0);
    expect(view.end).toBeLessThanOrEqual(60);
  });
});

describe("pixel mapping", () => {
  const view = { start: 10, end: 20 };

  it("round-trips time through x", () => {
    expect(xToTime(timeToX(13.37, view, 800), view, 800)).toBeCloseTo(13.37, 10);
  });

  it("puts the window edges at the canvas edges", () => {
    expect(timeToX(10, view, 800)).toBe(0);
    expect(timeToX(20, view, 800)).toBe(800);
  });

  it("degrades to the window start rather than NaN at zero width", () => {
    expect(xToTime(0, view, 0)).toBe(10);
    expect(timeToX(15, { start: 5, end: 5 }, 800)).toBe(0);
  });
});
