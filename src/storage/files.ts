/**
 * Audio file access (spec §5): FileSystemFileHandles persisted in
 * IndexedDB, permission re-requested on load. The "file moved / permission
 * denied" case surfaces as a typed result, never a crash — ui/ turns
 * `relink-needed` into a prompt.
 */

import type { FileRef } from "../core";
import { STORES, idbDelete, idbGet, idbPut } from "./db";

export type ResolvedAudio =
  | { ok: true; file: File }
  | { ok: false; reason: "no-handle" | "permission-denied" | "file-missing" };

export async function saveHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  await idbPut(STORES.handles, key, handle);
}

export async function deleteHandle(key: string): Promise<void> {
  await idbDelete(STORES.handles, key);
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

/**
 * Video containers count as recordings. <audio> decodes the audio track of
 * an mp4/mov/webm and ignores the video, and a recording ripped from video
 * is an ordinary way to end up with one — rejecting them was the sniff
 * being narrower than the engine, not a real constraint.
 */
export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv"];

let probeEl: HTMLAudioElement | null = null;

/**
 * Cheap "is this plausibly playable" sniff for drops. Deliberately generous:
 * its only job is to catch an obviously wrong drop (a PDF onto the audio
 * slot), because the engine is the actual arbiter and reports a real error
 * when a file that gets past here still won't decode. Widening a false
 * negative costs one bad message; a false negative blocks a valid file
 * outright, which is the worse failure.
 */
export function looksPlayable(file: File): boolean {
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) return true;
  const name = file.name.toLowerCase();
  if ([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].some((ext) => name.endsWith(ext))) return true;
  // Unrecognised extension: ask the element that will do the playing.
  // "" is a definite no; "maybe" and "probably" both pass.
  if (!file.type) return false;
  probeEl ??= new Audio();
  return probeEl.canPlayType(file.type) !== "";
}

/**
 * Resolve a drag-and-drop payload to an audio file plus, when Chromium
 * grants one, a persistable handle (getAsFileSystemHandle). Persisting is
 * the caller's job: which source the handle belongs to isn't known until
 * the caller decides whether this file dedups into an existing source.
 * `handle: null` means session-only — playable now, needing re-selection
 * after a restart. Callers surface that difference honestly.
 */
export async function audioFromDataTransfer(
  dt: DataTransfer,
): Promise<{ file: File; handle: FileSystemFileHandle | null } | { error: string } | null> {
  const item = Array.from(dt.items).find((i) => i.kind === "file");
  if (!item) return null;
  let handle: FileSystemFileHandle | null = null;
  let file: File | null = null;
  if (typeof item.getAsFileSystemHandle === "function") {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === "file") {
        handle = h as FileSystemFileHandle;
        file = await handle.getFile();
      }
    } catch {
      /* fall through to the session-only path */
    }
  }
  file ??= item.getAsFile();
  if (!file) return null;
  if (!looksPlayable(file)) return { error: `"${file.name}" isn't a media file — drop audio or video` };
  return { file, handle };
}

/**
 * Show the recording picker. Returns null if the user cancelled.
 * Requires a user gesture. As with drops, the caller persists the handle.
 *
 * Nothing sniffs the result: choosing a file in a native dialog is an
 * explicit act, and "All Files" stays available on purpose, so the picker
 * is deliberately a superset of what drops accept. It must never be the
 * *only* way in — a file the picker takes and a drop refuses is a bug.
 */
export async function pickAudio(): Promise<{ file: File; handle: FileSystemFileHandle } | null> {
  let handle: FileSystemFileHandle;
  try {
    [handle] = (await window.showOpenFilePicker({
      types: [
        {
          description: "Recording",
          accept: {
            "audio/*": AUDIO_EXTENSIONS,
            "video/*": VIDEO_EXTENSIONS,
          },
        },
      ],
      excludeAcceptAllOption: false,
      multiple: false,
    })) as [FileSystemFileHandle];
  } catch {
    return null; // user cancelled (AbortError)
  }
  return { file: await handle.getFile(), handle };
}
