import { describe, expect, it } from "vitest";
import { CURRENT_VERSION, MigrationError, migrate, migrations } from "./migrations";

const v1Doc = {
  schemaVersion: 1,
  id: "prj_test",
  name: "Test Project",
  sources: [],
  excerpts: [],
  assets: {},
};

describe("migrate", () => {
  it("brings a v1 document to CURRENT_VERSION without altering content", () => {
    const out = migrate(v1Doc);
    expect(out.schemaVersion).toBe(CURRENT_VERSION);
    const { schemaVersion: _a, ...outRest } = out;
    const { schemaVersion: _b, ...inRest } = v1Doc;
    expect(outRest).toEqual(inRest);
  });

  it("does not mutate the input document", () => {
    const input = structuredClone(v1Doc);
    migrate(input);
    expect(input).toEqual(v1Doc);
  });

  it("is a no-op on a document already at CURRENT_VERSION", () => {
    const current = { ...v1Doc, schemaVersion: CURRENT_VERSION };
    expect(migrate(current)).toEqual(current);
  });

  it("rejects documents from a future version", () => {
    expect(() => migrate({ ...v1Doc, schemaVersion: CURRENT_VERSION + 1 })).toThrow(
      MigrationError,
    );
  });

  it("rejects missing or invalid schemaVersion", () => {
    for (const bad of [undefined, null, "1", 1.5, 0, -1]) {
      expect(() => migrate({ ...v1Doc, schemaVersion: bad })).toThrow(MigrationError);
    }
  });
});

describe("migrations array", () => {
  it("covers every version step up to CURRENT_VERSION", () => {
    expect(migrations.length).toBe(CURRENT_VERSION - 1);
  });
});

/**
 * The first migration that actually moves data. Everything a stored or
 * exported project could be holding has to come through it — this is the
 * only thing standing between a rename and someone's excerpt names.
 */
describe("v2 → v3: shortLabel becomes title", () => {
  const v2 = (excerpts: unknown[]) => ({ ...v1Doc, schemaVersion: 2, excerpts });

  it("carries the value across", () => {
    const out = migrate(v2([{ id: "e1", label: "Mvt IV — Fig 2", shortLabel: "IV/2" }]));
    expect(out["excerpts"]).toEqual([{ id: "e1", label: "Mvt IV — Fig 2", title: "IV/2" }]);
  });

  it("renames on every excerpt, not just the first", () => {
    const out = migrate(v2([{ id: "a", shortLabel: "A" }, { id: "b", shortLabel: "B" }]));
    expect(out["excerpts"]).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
  });

  it("leaves an excerpt that never had one alone", () => {
    const out = migrate(v2([{ id: "e1", label: "only a label" }]));
    expect(out["excerpts"]).toEqual([{ id: "e1", label: "only a label" }]);
  });

  it("drops a blank rather than storing an empty title", () => {
    const out = migrate(v2([{ id: "e1", shortLabel: "" }]));
    expect(out["excerpts"]).toEqual([{ id: "e1" }]);
  });

  it("keeps an existing title and still removes the old key", () => {
    const out = migrate(v2([{ id: "e1", title: "kept", shortLabel: "stale" }]));
    expect(out["excerpts"]).toEqual([{ id: "e1", title: "kept" }]);
  });

  it("preserves every other field on the excerpt", () => {
    const full = {
      id: "e1",
      label: "L",
      shortLabel: "S",
      hotkey: "4",
      sourceId: "src",
      region: { start: 1, end: 2 },
      preRoll: 1.2,
      defaultRate: 0.75,
      loop: true,
      assets: [],
    };
    const { shortLabel: _dropped, ...rest } = full;
    const [out] = migrate(v2([full]))["excerpts"] as Record<string, unknown>[];
    expect(out).toEqual({ ...rest, title: "S" });
    // toEqual treats an undefined value as absent; this is what proves the
    // old key is actually gone rather than merely emptied.
    expect("shortLabel" in out!).toBe(false);
  });

  it("runs as part of the v1 chain, not only from v2", () => {
    const out = migrate({ ...v1Doc, excerpts: [{ id: "e1", shortLabel: "I/5" }] });
    expect(out["excerpts"]).toEqual([{ id: "e1", title: "I/5" }]);
    expect(out["schemaVersion"]).toBe(CURRENT_VERSION);
  });

  it("does not mutate the excerpts it was handed", () => {
    const input = v2([{ id: "e1", shortLabel: "IV/2" }]);
    migrate(input);
    expect(input.excerpts).toEqual([{ id: "e1", shortLabel: "IV/2" }]);
  });

  it("survives junk where excerpts should be", () => {
    // Migrations must be total (see the header): a malformed doc is the
    // parser's problem to report, not something to crash the load path.
    expect(() => migrate({ ...v1Doc, excerpts: "not an array" })).not.toThrow();
    expect(() => migrate({ ...v1Doc, excerpts: [null, 42, "x"] })).not.toThrow();
  });
});
