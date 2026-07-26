/**
 * storage/ — IndexedDB, File System Access API, JSON import/export (spec §5).
 * The only layer that knows about persistence.
 *
 * M0: load/save round-trip through the migration machinery only.
 * M1 adds: IndexedDB project store, persisted FileSystemFileHandles with
 * permission re-request, and the re-link prompt for moved files.
 */

import { migrate, type ProjectDoc, type RawDoc } from "../core";

/**
 * Parse exported/stored JSON into a current-version ProjectDoc.
 * Migration errors propagate — callers surface them, never swallow them.
 */
export function parseProjectJson(json: string): ProjectDoc {
  const raw = JSON.parse(json) as RawDoc;
  return migrate(raw) as unknown as ProjectDoc;
}

/** Serialize for export. Pretty-printed: the file is meant to be diffable (spec §4). */
export function serializeProject(doc: ProjectDoc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

export * from "./projects";
export * from "./files";
export * from "./images";
