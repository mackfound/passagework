import { describe, expect, it } from "vitest";
import { resolveIntent } from "./intents";

const hotkeys = new Set(["1", "2", "3", "d"]);
const stroke = (key: string, shiftKey = false, altKey = false) => ({ key, shiftKey, altKey });

describe("resolveIntent", () => {
  it("maps fixed bindings", () => {
    expect(resolveIntent(stroke(" "), hotkeys)).toEqual({ type: "togglePlay" });
    expect(resolveIntent(stroke("Escape"), hotkeys)).toEqual({ type: "stopLoop" });
    expect(resolveIntent(stroke("["), hotkeys)).toEqual({ type: "rateStep", dir: -1 });
    expect(resolveIntent(stroke("]"), hotkeys)).toEqual({ type: "rateStep", dir: 1 });
    expect(resolveIntent(stroke("\\"), hotkeys)).toEqual({ type: "rateReset" });
  });

  it("shift routes arrow nudges to the end edge; alt makes them coarse", () => {
    expect(resolveIntent(stroke("ArrowLeft"), hotkeys)).toEqual({
      type: "nudge",
      edge: "start",
      dir: -1,
      coarse: false,
    });
    expect(resolveIntent(stroke("ArrowRight", true), hotkeys)).toEqual({
      type: "nudge",
      edge: "end",
      dir: 1,
      coarse: false,
    });
    expect(resolveIntent(stroke("ArrowRight", true, true), hotkeys)).toEqual({
      type: "nudge",
      edge: "end",
      dir: 1,
      coarse: true,
    });
  });

  it("is case-insensitive for letter keys (caps lock must not break tap-in)", () => {
    expect(resolveIntent(stroke("I"), hotkeys)).toEqual({ type: "tap", edge: "start" });
    expect(resolveIntent(stroke("o"), hotkeys)).toEqual({ type: "tap", edge: "end" });
  });

  it("resolves excerpt hotkeys, letters included", () => {
    expect(resolveIntent(stroke("1"), hotkeys)).toEqual({ type: "triggerExcerpt", hotkey: "1" });
    expect(resolveIntent(stroke("D"), hotkeys)).toEqual({ type: "triggerExcerpt", hotkey: "d" });
  });

  it("fixed bindings shadow excerpt hotkeys", () => {
    const clash = new Set([" ", "i"]);
    expect(resolveIntent(stroke(" "), clash)).toEqual({ type: "togglePlay" });
    expect(resolveIntent(stroke("i"), clash)).toEqual({ type: "tap", edge: "start" });
  });

  it("aliases pedal keys to prev/next excerpt", () => {
    expect(resolveIntent(stroke("PageUp"), hotkeys)).toEqual({ type: "prevExcerpt" });
    expect(resolveIntent(stroke("PageDown"), hotkeys)).toEqual({ type: "nextExcerpt" });
  });

  it("returns null for unbound keys", () => {
    expect(resolveIntent(stroke("q"), hotkeys)).toBeNull();
    expect(resolveIntent(stroke("F5"), hotkeys)).toBeNull();
  });
});
