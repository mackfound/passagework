/**
 * Audio file access (spec §5): FileSystemFileHandles persisted in
 * IndexedDB, permission re-requested on load. The "file moved / permission
 * denied" case surfaces as a typed result, never a crash — ui/ turns
 * `relink-needed` into a prompt.
 */

import type { FileRef } from "../core";
import { STORES, idbGet, idbPut } from "./db";

export type ResolvedAudio =
  | { ok: true; file: File }
  | { ok: false; reason: "no-handle" | "permission-denied" | "file-missing" };

export async function saveHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  await idbPut(STORES.handles, key, handle);
}

/**
 * Resolve a FileRef to its File, re-requesting permission if needed.
 * Must run inside a user gesture for requestPermission to succeed —
 * callers route this through the startup arm-gesture (spec §11).
 */
export async function resolveAudio(ref: FileRef): Promise<ResolvedAudio> {
  if (ref.kind !== "fsHandle") return { ok: false, reason: "no-handle" };
  const handle = await idbGet<FileSystemFileHandle>(STORES.handles, ref.key);
  if (!handle) return { ok: false, reason: "no-handle" };

  let perm = await handle.queryPermission({ mode: "read" });
  if (perm === "prompt") perm = await handle.requestPermission({ mode: "read" });
  if (perm !== "granted") return { ok: false, reason: "permission-denied" };

  try {
    return { ok: true, file: await handle.getFile() };
  } catch {
    return { ok: false, reason: "file-missing" };
  }
}

export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"];

export function looksLikeAudio(file: File): boolean {
  if (file.type.startsWith("audio/")) return true;
  const name = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Resolve a drag-and-drop payload to a linked audio file.
 * Prefers a persistable handle (getAsFileSystemHandle, Chromium); falls back
 * to the session-only File with a `filename` ref — playable now, but needing
 * re-selection after a restart. Callers surface that difference honestly.
 */
export async function linkFromDataTransfer(
  dt: DataTransfer,
  handleKey: string,
): Promise<{ file: File; ref: FileRef; persistent: boolean } | { error: string } | null> {
  const item = Array.from(dt.items).find((i) => i.kind === "file");
  if (!item) return null;
  if (typeof item.getAsFileSystemHandle === "function") {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === "file") {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        if (!looksLikeAudio(file)) return { error: `"${file.name}" doesn't look like an audio file` };
        await saveHandle(handleKey, fileHandle);
        return { file, ref: { kind: "fsHandle", key: handleKey }, persistent: true };
      }
    } catch {
      /* fall through to the session-only path */
    }
  }
  const file = item.getAsFile();
  if (!file) return null;
  if (!looksLikeAudio(file)) return { error: `"${file.name}" doesn't look like an audio file` };
  return { file, ref: { kind: "filename", name: file.name }, persistent: false };
}

/**
 * Show the audio file picker and persist the chosen handle.
 * Returns null if the user cancelled. Requires a user gesture.
 */
export async function pickAudioFile(
  handleKey: string,
): Promise<{ file: File; ref: FileRef } | null> {
  let handle: FileSystemFileHandle;
  try {
    [handle] = (await window.showOpenFilePicker({
      types: [
        {
          description: "Audio",
          accept: {
            "audio/*": [".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus"],
          },
        },
      ],
      excludeAcceptAllOption: false,
      multiple: false,
    })) as [FileSystemFileHandle];
  } catch {
    return null; // user cancelled (AbortError)
  }
  await saveHandle(handleKey, handle);
  const file = await handle.getFile();
  return { file, ref: { kind: "fsHandle", key: handleKey } };
}
