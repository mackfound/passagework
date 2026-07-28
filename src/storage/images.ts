/**
 * Score image assets (spec §5): per-asset inline vs handle.
 *
 * Inline (base64 in the project JSON) keeps exports self-contained and can
 * never fail to load; handles keep the JSON small but need permission each
 * session and go stale when files move. Auto-inline under the threshold is
 * a safety valve for pathological scans, not a silent branch — ui/ must
 * show each asset's mode.
 */

import type { AssetData } from "../core";
import { STORES, idbGet, idbPut } from "./db";

export const INLINE_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB — deliberately high

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack limits on String.fromCharCode
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export function looksLikeImage(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const name = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * The inline-vs-handle decision (spec §5), shared by picker and drop paths:
 * inline under the threshold, persist the handle above it. A large file
 * with no handle can't persist at all — that's an error, not a silent
 * session-only asset (unlike audio, images have no re-link-on-boot flow).
 */
async function assetFromImageFile(
  file: File,
  handle: FileSystemFileHandle | null,
  assetKey: string,
): Promise<AssetData | { error: string }> {
  if (file.size <= INLINE_THRESHOLD_BYTES) {
    return { kind: "inline", mime: file.type || "image/png", data: await fileToBase64(file) };
  }
  if (!handle) {
    const mb = (INLINE_THRESHOLD_BYTES / 1024 / 1024).toFixed(0);
    return { error: `"${file.name}" is over ${mb} MB and can't be embedded — use browse instead` };
  }
  await idbPut(STORES.handles, assetKey, handle);
  return { kind: "fsHandle", key: assetKey };
}

/**
 * Pick an image and convert it to AssetData. Returns null on cancel.
 */
export async function pickImage(assetKey: string): Promise<AssetData | null> {
  let handle: FileSystemFileHandle;
  try {
    [handle] = (await window.showOpenFilePicker({
      types: [
        { description: "Score image", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp"] } },
      ],
      multiple: false,
    })) as [FileSystemFileHandle];
  } catch {
    return null;
  }
  const file = await handle.getFile();
  const data = await assetFromImageFile(file, handle, assetKey);
  return "error" in data ? null : data;
}

/**
 * Resolve a drag-and-drop payload to an image asset. Mirrors
 * linkFromDataTransfer in files.ts: prefers a persistable handle
 * (getAsFileSystemHandle, Chromium), falls back to the bare File — which
 * still persists fine when it inlines under the threshold.
 */
export async function imageFromDataTransfer(
  dt: DataTransfer,
  assetKey: string,
): Promise<{ data: AssetData; name: string } | { error: string } | null> {
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
      /* fall through to the bare-File path */
    }
  }
  file ??= item.getAsFile();
  if (!file) return null;
  if (!looksLikeImage(file)) return { error: `"${file.name}" doesn't look like an image` };
  const data = await assetFromImageFile(file, handle, assetKey);
  return "error" in data ? data : { data, name: file.name };
}

/**
 * Resolve AssetData to a displayable URL. Inline assets cannot fail;
 * handle-backed ones return null when missing or denied (ui shows a
 * re-link affordance).
 */
export async function resolveAssetUrl(data: AssetData): Promise<string | null> {
  if (data.kind === "inline") {
    return `data:${data.mime};base64,${data.data}`;
  }
  const handle = await idbGet<FileSystemFileHandle>(STORES.handles, data.key);
  if (!handle) return null;
  let perm = await handle.queryPermission({ mode: "read" });
  if (perm === "prompt") perm = await handle.requestPermission({ mode: "read" });
  if (perm !== "granted") return null;
  try {
    return URL.createObjectURL(await handle.getFile());
  } catch {
    return null;
  }
}
