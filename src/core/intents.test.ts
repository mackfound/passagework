import { describe, expect, it } from "vitest";
import { KEYMAP_HELP, isReservedKey, reservedKeys, resolveIntent } from "./intents";

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

  it("leaves ? unbound — Shift+/ is a chord, so the legend is button-only", () => {
    expect(resolveIntent(stroke("?"), hotkeys)).toBeNull();
  });
});

/**
 * The legend is the only discoverability the app has, so a binding the
 * legend doesn't mention is invisible, and a legend row naming a binding
 * that no longer exists is a lie. Both directions fail here rather than
 * shipping.
 */
describe("KEYMAP_HELP stays in step with the keymap", () => {
  const covered = KEYMAP_HELP.flatMap((row) => row.covers);

  it("documents every reserved key", () => {
    const undocumented = reservedKeys().filter((k) => !covered.includes(k));
    expect(undocumented).toEqual([]);
  });

  it("names no key the keymap doesn't bind", () => {
    const phantom = covered.filter((k) => !isReservedKey(k));
    expect(phantom).toEqual([]);
  });

  it("documents each key exactly once", () => {
    const dupes = covered.filter((k, i) => covered.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it("gives every row something to display", () => {
    for (const row of KEYMAP_HELP) {
      expect(row.keys.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });
});
