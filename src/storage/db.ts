/**
 * Minimal promise wrapper over IndexedDB. No library — this is ~60 lines
 * and the zero-dep constraint is the point (spec §0.2).
 *
 * Stores:
 *  - projects: ProjectDoc keyed by project id
 *  - appState: session/progress state, singleton key
 *  - handles:  FileSystemFileHandle values keyed by string (Chromium
 *              structured-clones handles into IndexedDB — spec §5)
 *  - peaks:    derived waveform envelopes keyed by source id (M3). Cache
 *              only: discardable, never exported, and *not* audio — the
 *              §5 ban on copying audio into IndexedDB stands.
 *
 * DB_VERSION bumps when a store is added. openDb's upgrade handler creates
 * whatever is missing, so a bump alone migrates an existing database; the
 * document's own schemaVersion (spec §4) is a separate, unrelated number.
 */

// Persistence key, NOT branding: deliberately decoupled from APP_NAME
// (src/config.ts). Renaming this string would orphan every existing
// user's config — it stays whatever it was first shipped as.
const DB_NAME = "excerpt-looper";
const DB_VERSION = 2; // 2: added the peaks cache (M3)

export const STORES = {
  projects: "projects",
  appState: "appState",
  handles: "handles",
  peaks: "peaks",
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error(`get ${store}/${key} failed`));
  });
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`put ${store}/${key} failed`));
  });
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error ?? new Error(`getAll ${store} failed`));
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`delete ${store}/${key} failed`));
  });
}
