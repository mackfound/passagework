/**
 * Loop arithmetic — pure time math (spec §3).
 *
 * All positions are source-time seconds on a 10 ms grid (spec §2.5).
 */

import type { Region, Seconds } from "./schema/types";

/** M1 clamps here because preservesPitch quality degrades below ~0.5× (spec §11). */
export const RATE_MIN = 0.5;
export const RATE_MAX = 1.0;
export const RATE_STEP = 0.05;

/** 10 ms — both the tap quantum and the keyboard nudge step. */
export const GRID: Seconds = 0.01;

/** Shortest legal region. Guards nudges from inverting start/end. */
export const MIN_REGION: Seconds = 0.1;

/** Snap a position to the 10 ms grid (round-half-up in grid units). */
export function quantize(pos: Seconds): Seconds {
  // Round in integer centiseconds, then divide once: `x * GRID` accumulates
  // float error (301 * 0.01 = 3.0100000000000002), `x / 100` yields the
  // canonical closest double. INV_GRID must stay in sync with GRID.
  const INV_GRID = 100;
  return Math.round(pos * INV_GRID) / INV_GRID;
}

export function clampRate(rate: number): number {
  return Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
}

/** Step rate by ±RATE_STEP, staying on the 0.05 grid so 0.75 never drifts to 0.7500001. */
export function stepRate(rate: number, dir: 1 | -1): number {
  const stepped = Math.round((rate + dir * RATE_STEP) / RATE_STEP) * RATE_STEP;
  return clampRate(Number(stepped.toFixed(2)));
}

/**
 * Where playback starts when *entering* an excerpt: preRoll seconds before
 * region.start, floored at 0. Loop wraps go to region.start instead — the
 * two entry points must never be conflated (spec §7).
 */
export function entryPosition(region: Region, preRoll: Seconds): Seconds {
  return Math.max(0, region.start - preRoll);
}

/**
 * Validate a candidate start/end pair into a Region, or null if unusable.
 * Quantizes both edges; enforces order, MIN_REGION, and source bounds.
 * duration may be null when the source hasn't loaded yet (skip upper bound).
 */
export function normalizeRegion(
  start: Seconds,
  end: Seconds,
  duration: Seconds | null,
): Region | null {
  const s = quantize(Math.max(0, start));
  const e = quantize(duration === null ? end : Math.min(end, duration));
  if (e - s < MIN_REGION) return null;
  return { start: s, end: e };
}

/**
 * Move one edge of a region by ±GRID. Returns the input unchanged (not null)
 * when the nudge would violate MIN_REGION or source bounds — a rejected
 * nudge should feel like hitting a wall, not destroy the region.
 */
export function nudgeRegion(
  region: Region,
  edge: "start" | "end",
  dir: 1 | -1,
  duration: Seconds | null,
): Region {
  const delta = dir * GRID;
  const next: Region =
    edge === "start"
      ? { start: quantize(region.start + delta), end: region.end }
      : { start: region.start, end: quantize(region.end + delta) };
  if (next.start < 0) return region;
  if (duration !== null && next.end > duration) return region;
  if (next.end - next.start < MIN_REGION - GRID / 2) return region;
  return next;
}
