import { describe, expect, it } from "vitest";
import {
  GRID,
  MIN_REGION,
  RATE_MAX,
  RATE_MIN,
  clampRate,
  entryPosition,
  normalizeRegion,
  nudgeRegion,
  quantize,
  stepRate,
} from "./loop";

describe("quantize", () => {
  it("snaps to the 10 ms grid", () => {
    expect(quantize(1893.4234)).toBeCloseTo(1893.42, 10);
    expect(quantize(1893.4267)).toBeCloseTo(1893.43, 10);
    expect(quantize(0)).toBe(0);
  });
});

describe("rate", () => {
  it("clamps to [0.5, 1.0]", () => {
    expect(clampRate(0.3)).toBe(RATE_MIN);
    expect(clampRate(1.4)).toBe(RATE_MAX);
    expect(clampRate(0.75)).toBe(0.75);
  });

  it("steps on the 0.05 grid without float drift", () => {
    expect(stepRate(0.75, 1)).toBe(0.8);
    expect(stepRate(0.75, -1)).toBe(0.7);
    // off-grid input snaps to grid
    expect(stepRate(0.73, 1)).toBe(0.8);
  });

  it("saturates at the bounds", () => {
    expect(stepRate(1.0, 1)).toBe(1.0);
    expect(stepRate(0.5, -1)).toBe(0.5);
  });
});

describe("entryPosition — pre-roll vs loop-start distinction", () => {
  const region = { start: 1893.42, end: 1904.1 };

  it("enters preRoll seconds before start", () => {
    expect(entryPosition(region, 1.2)).toBeCloseTo(1892.22, 10);
  });

  it("floors at zero near the top of the file", () => {
    expect(entryPosition({ start: 0.5, end: 4 }, 1.2)).toBe(0);
  });

  it("entry with preRoll differs from region.start — loop wraps must use start", () => {
    expect(entryPosition(region, 1.2)).not.toBe(region.start);
    expect(entryPosition(region, 0)).toBe(region.start);
  });
});

describe("normalizeRegion", () => {
  it("quantizes and orders a valid pair", () => {
    expect(normalizeRegion(1.00499, 3.006, 100)).toEqual({ start: 1.0, end: 3.01 });
  });

  it("rejects regions shorter than MIN_REGION", () => {
    expect(normalizeRegion(1.0, 1.0 + MIN_REGION / 2, 100)).toBeNull();
    expect(normalizeRegion(3.0, 1.0, 100)).toBeNull(); // inverted
  });

  it("clamps to source bounds; skips upper bound when duration unknown", () => {
    expect(normalizeRegion(-0.5, 2.0, 100)).toEqual({ start: 0, end: 2.0 });
    expect(normalizeRegion(98, 250, 100)).toEqual({ start: 98, end: 100 });
    expect(normalizeRegion(98, 250, null)).toEqual({ start: 98, end: 250 });
  });
});

describe("nudgeRegion", () => {
  const region = { start: 10.0, end: 12.0 };

  it("moves one edge by one grid step", () => {
    expect(nudgeRegion(region, "start", 1, 100)).toEqual({ start: 10.01, end: 12.0 });
    expect(nudgeRegion(region, "end", -1, 100)).toEqual({ start: 10.0, end: 11.99 });
  });

  it("refuses to cross MIN_REGION — returns input unchanged", () => {
    const tight = { start: 10.0, end: 10.0 + MIN_REGION };
    expect(nudgeRegion(tight, "start", 1, 100)).toEqual(tight);
    expect(nudgeRegion(tight, "end", -1, 100)).toEqual(tight);
  });

  it("refuses to leave source bounds", () => {
    expect(nudgeRegion({ start: 0, end: 2 }, "start", -1, 100)).toEqual({ start: 0, end: 2 });
    expect(nudgeRegion({ start: 98, end: 100 }, "end", 1, 100)).toEqual({ start: 98, end: 100 });
  });

  it("repeated nudges accumulate without float drift off the grid", () => {
    let r = { start: 10.0, end: 12.0 };
    for (let i = 0; i < 100; i++) r = nudgeRegion(r, "start", 1, 100);
    expect(r.start).toBeCloseTo(11.0, 10);
    // still on-grid: distance from grid point is negligible
    expect(Math.abs(r.start / GRID - Math.round(r.start / GRID))).toBeLessThan(1e-6);
  });
});
