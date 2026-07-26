/**
 * Enforces spec §3 / §10: core/ imports nothing from outside itself.
 *
 * Tradeoff note: the shared tsconfig includes the DOM lib, so the compiler
 * alone can't stop core/ from referencing DOM types. Splitting into project
 * references would enforce that but complicates the build; this import scan
 * is the reversible choice and catches the failure mode that actually
 * matters (a dependency edge pointing outward).
 *
 * Test files (*.test.ts) are excluded — they import vitest and node builtins
 * by design; the constraint is on shipped core source.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_DIR = join(import.meta.dirname, ".");

function coreSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(e.parentPath, e.name));
}

// Matches static imports, re-exports, and dynamic import() specifiers.
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm;

describe("core/ purity", () => {
  it("has zero imports from outside core/", () => {
    const offenders: string[] = [];
    for (const file of coreSourceFiles(CORE_DIR)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        // Only relative specifiers that resolve inside core/ are legal.
        const insideCore =
          spec.startsWith(".") &&
          !relative(resolve(CORE_DIR), resolve(dirname(file), spec)).startsWith(`..${sep}`);
        if (!insideCore) {
          offenders.push(`${relative(CORE_DIR, file)} imports "${spec}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
