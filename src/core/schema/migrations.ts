/**
 * Schema migrations (spec §4).
 *
 * Placement tradeoff: §3 lists "schema + migrations" under core/, while §4
 * names `storage/migrations.ts`. Migration functions are pure (doc) => doc
 * transforms — testable in node with no persistence knowledge — so they live
 * here in core/ and storage/ applies them at load time. That's the reversible
 * choice: moving pure functions out to storage/ later is trivial; untangling
 * IndexedDB awareness out of them would not be.
 *
 * Rules:
 *  - `migrations[i]` migrates a document from version i+1 to i+2.
 *  - Every migration is total: it must succeed on any valid doc of its
 *    input version. No I/O, no validation side quests.
 *  - Never mutate the input; return a new object.
 */

/** A raw, not-yet-trusted document. Migrations run before type narrowing. */
export type RawDoc = Record<string, unknown>;

export type Migration = (doc: RawDoc) => RawDoc;

/**
 * v1 → v2: identity. Exists so the migration machinery is exercised from the
 * first commit (spec §4) — the first *real* migration slots in as 2 → 3.
 */
const v1ToV2: Migration = (doc) => ({ ...doc });

export const migrations: readonly Migration[] = [v1ToV2];

export const CURRENT_VERSION = migrations.length + 1;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Bring a stored document up to CURRENT_VERSION.
 * Throws MigrationError on missing/invalid version or a document from a
 * future version (never silently downgrade — spec §4).
 */
export function migrate(doc: RawDoc): RawDoc {
  const version = doc["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new MigrationError(
      `document has no valid schemaVersion (got ${JSON.stringify(version)})`,
    );
  }
  if (version > CURRENT_VERSION) {
    throw new MigrationError(
      `document is schemaVersion ${version}, but this build only understands up to ${CURRENT_VERSION}. ` +
        `Update the app rather than risking data loss.`,
    );
  }
  let out = doc;
  for (let v = version; v < CURRENT_VERSION; v++) {
    const step = migrations[v - 1];
    if (!step) throw new MigrationError(`missing migration for v${v} → v${v + 1}`);
    out = step(out);
  }
  return { ...out, schemaVersion: CURRENT_VERSION };
}
