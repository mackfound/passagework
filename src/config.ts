/**
 * App identity — the one place the product name lives. UI surfaces (arm
 * overlay, status bar, document title) must read it from here, so a future
 * rename is a one-line change.
 *
 * Two places deliberately do NOT follow this constant:
 *  - the IndexedDB database name (storage/db.ts): it's a persistence key,
 *    and renaming it would orphan every existing user's config;
 *  - index.html's <title>: it's the pre-JS fallback and can't import TS —
 *    boot overwrites it with APP_NAME anyway.
 */

export const APP_NAME = "Passagework";
