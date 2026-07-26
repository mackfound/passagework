/**
 * Ambient declarations for the File System Access API bits TypeScript's DOM
 * lib doesn't ship (Chromium-only surface — spec targets Chromium desktop).
 */

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

interface FileSystemHandle {
  queryPermission(descriptor?: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor?: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}
