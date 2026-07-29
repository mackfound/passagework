import { describe, expect, it } from "vitest";
import { makeEmptyProject, makeExcerpt, makePlaceholderSource, nextFreeHotkey } from "./factories";
import { isReservedKey } from "./intents";
import { CURRENT_VERSION, migrate } from "./schema/migrations";
import type { RawDoc } from "./schema/migrations";
import { makeSeedProject } from "./seed";

describe("makeEmptyProject", () => {
  it("is already at the current schema version and survives migrate unchanged", () => {
    const doc = makeEmptyProject("Test");
    expect(doc.schemaVersion).toBe(CURRENT_VERSION);
    expect(migrate(doc as unknown as RawDoc)).toEqual(doc);
  });

  it("mints distinct ids", () => {
    expect(makeEmptyProject("a").id).not.toBe(makeEmptyProject("b").id);
  });
});

describe("makeExcerpt", () => {
  it("omits empty optional fields entirely rather than storing them blank", () => {
    const exc = makeExcerpt({ label: "Mvt I" }, "src_x");
    expect("shortLabel" in exc).toBe(false);
    expect("hotkey" in exc).toBe(false);
    expect(exc.region).toBeNull();
    expect(exc.sourceId).toBe("src_x");
  });

  it("keeps provided optional fields", () => {
    const exc = makeExcerpt({ label: "Mvt I", shortLabel: "I", hotkey: "4" }, "src_x");
    expect(exc.shortLabel).toBe("I");
    expect(exc.hotkey).toBe("4");
  });
});

describe("makePlaceholderSource", () => {
  it("starts unlinked: filename ref with an empty name", () => {
    const src = makePlaceholderSource();
    expect(src.fileRef).toEqual({ kind: "filename", name: "" });
    expect(src.duration).toBeNull();
  });
});

describe("nextFreeHotkey", () => {
  it("suggests the lowest free digit", () => {
    const seed = makeSeedProject(); // uses 1, 2, 3
    expect(nextFreeHotkey(seed.excerpts)).toBe("4");
    expect(nextFreeHotkey([])).toBe("1");
  });

  it("returns undefined when 1-9 are taken", () => {
    const excerpts = [..."123456789"].map((k) =>
      makeExcerpt({ label: k, hotkey: k }, "src_x"),
    );
    expect(nextFreeHotkey(excerpts)).toBeUndefined();
  });
});

describe("isReservedKey", () => {
  it("flags fixed-keymap keys in any case, and only those", () => {
    expect(isReservedKey("l")).toBe(true);
    expect(isReservedKey("L")).toBe(true);
    expect(isReservedKey(" ")).toBe(true);
    expect(isReservedKey("Escape")).toBe(true);
    expect(isReservedKey("5")).toBe(false);
    expect(isReservedKey("d")).toBe(false);
  });
});
