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
