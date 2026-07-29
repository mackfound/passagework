/**
 * Project + app-state persistence. Loading always runs the migration path
 * (spec §4) — a doc written by an older build migrates transparently.
 */

import {
  type AppState,
  type ProjectDoc,
  type RawDoc,
  makeSeedProject,
  migrate,
} from "../core";
import { STORES, idbDelete, idbGet, idbGetAll, idbPut } from "./db";

const APP_STATE_KEY = "app";

export interface ProjectListing {
  id: string;
  name: string;
  excerptCount: number;
}

/**
 * List all stored projects. Raw docs are read without migrating — id/name/
 * excerpts can never change meaning across versions (spec §4), and a listing
 * must not fail just because one old doc would.
 */
export async function listProjects(): Promise<ProjectListing[]> {
  const docs = await idbGetAll<RawDoc>(STORES.projects);
  return docs.map((d) => ({
    id: String(d["id"]),
    name: typeof d["name"] === "string" ? d["name"] : "untitled",
    excerptCount: Array.isArray(d["excerpts"]) ? d["excerpts"].length : 0,
  }));
}

export async function loadProject(id: string): Promise<ProjectDoc | null> {
  const raw = await idbGet<RawDoc>(STORES.projects, id);
  return raw ? (migrate(raw) as unknown as ProjectDoc) : null;
}

export async function deleteProject(id: string): Promise<void> {
  await idbDelete(STORES.projects, id);
}

/** Pick a .json file and return its text. Null on cancel. */
export async function pickJsonText(): Promise<string | null> {
  let handle: FileSystemFileHandle;
  try {
    [handle] = (await window.showOpenFilePicker({
      types: [{ description: "Project JSON", accept: { "application/json": [".json"] } }],
      multiple: false,
    })) as [FileSystemFileHandle];
  } catch {
    return null; // user cancelled
  }
  return (await handle.getFile()).text();
}

export async function loadOrSeedProject(): Promise<ProjectDoc> {
  const state = await loadAppState();
  if (state.activeProjectId) {
    const raw = await idbGet<RawDoc>(STORES.projects, state.activeProjectId);
    if (raw) return migrate(raw) as unknown as ProjectDoc;
  }
  const seed = makeSeedProject();
  await saveProject(seed);
  await saveAppState({ ...state, activeProjectId: seed.id });
  return seed;
}

export async function saveProject(doc: ProjectDoc): Promise<void> {
  await idbPut(STORES.projects, doc.id, doc);
}

export async function loadAppState(): Promise<AppState> {
  const state = await idbGet<AppState>(STORES.appState, APP_STATE_KEY);
  return state ?? { activeProjectId: null, workingRates: {} };
}

export async function saveAppState(state: AppState): Promise<void> {
  await idbPut(STORES.appState, APP_STATE_KEY, state);
}
