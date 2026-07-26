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
import { STORES, idbGet, idbPut } from "./db";

const APP_STATE_KEY = "app";

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
