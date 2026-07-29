/**
 * Export/import round-trip (spec §5): the exported .json is the backup
 * story, so what comes back from parse must be exactly what went out —
 * and parse must reject what migrate would reject, loudly.
 */

import { describe, expect, it } from "vitest";
import { MigrationError, makeSeedProject } from "../core";
import { parseProjectJson, serializeProject } from "./index";

describe("serialize/parse round-trip", () => {
  it("returns an identical document", () => {
    const doc = makeSeedProject();
    expect(parseProjectJson(serializeProject(doc))).toEqual(doc);
  });

  it("pretty-prints with a trailing newline (diffable, spec §4)", () => {
    const json = serializeProject(makeSeedProject());
    expect(json.endsWith("}\n")).toBe(true);
    expect(json.split("\n").length).toBeGreaterThan(10);
  });

  it("propagates migration errors for invalid documents", () => {
    expect(() => parseProjectJson(`{"name":"no version"}`)).toThrow(MigrationError);
    expect(() => parseProjectJson(`{"schemaVersion":999}`)).toThrow(MigrationError);
  });

  it("propagates JSON syntax errors", () => {
    expect(() => parseProjectJson("not json")).toThrow(SyntaxError);
  });
});
