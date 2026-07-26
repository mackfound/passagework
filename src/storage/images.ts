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

/**
 * Pick an image and convert it to AssetData. Inline under the threshold;
 * above it, persist the picker handle. Returns null on cancel.
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
  if (file.size <= INLINE_THRESHOLD_BYTES) {
    return { kind: "inline", mime: file.type || "image/png", data: await fileToBase64(file) };
  }
  await idbPut(STORES.handles, assetKey, handle);
  return { kind: "fsHandle", key: assetKey };
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
