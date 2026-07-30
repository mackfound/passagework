/**
 * Input layer: key codes → intents, in one table (spec §7).
 *
 * This indirection is what makes a Bluetooth page-turner pedal free later —
 * pedals emit ordinary key events (§2.8), so support means adding rows to
 * this table, never adding keydown handlers elsewhere. ui/ must dispatch
 * every key through resolveIntent and nothing else.
 */

export type Intent =
  | { type: "togglePlay" }
  | { type: "stopLoop" }
  | { type: "rateStep"; dir: 1 | -1 }
  | { type: "rateReset" }
  | { type: "nudge"; edge: "start" | "end"; dir: 1 | -1; coarse: boolean }
  | { type: "tap"; edge: "start" | "end" }
  | { type: "toggleImage" }
  | { type: "togglePreRoll" }
  | { type: "toggleWaveform" }
  | { type: "zoom"; dir: 1 | -1 }
  | { type: "triggerExcerpt"; hotkey: string }
  | { type: "prevExcerpt" }
  | { type: "nextExcerpt" }
  | { type: "linkAudio" };

/** Minimal slice of KeyboardEvent so core/ never imports a DOM type. */
export interface KeyStroke {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
}

type IntentRule = (k: KeyStroke) => Intent | null;

/**
 * The default keymap. Arrows nudge the loop start; Shift+arrows nudge the
 * end; Alt turns either into a coarse 500 ms jump. PageUp/PageDown alias
 * prev/next because that's what page-turner pedals emit.
 */
const rules: Record<string, IntentRule> = {
  " ": () => ({ type: "togglePlay" }),
  escape: () => ({ type: "stopLoop" }),
  "[": () => ({ type: "rateStep", dir: -1 }),
  "]": () => ({ type: "rateStep", dir: 1 }),
  "\\": () => ({ type: "rateReset" }),
  arrowleft: (k) => ({ type: "nudge", edge: k.shiftKey ? "end" : "start", dir: -1, coarse: k.altKey }),
  arrowright: (k) => ({ type: "nudge", edge: k.shiftKey ? "end" : "start", dir: 1, coarse: k.altKey }),
  i: () => ({ type: "tap", edge: "start" }),
  o: () => ({ type: "tap", edge: "end" }),
  tab: () => ({ type: "toggleImage" }),
  p: () => ({ type: "togglePreRoll" }),
  w: () => ({ type: "toggleWaveform" }),
  // Unshifted +/−, so zooming needs no modifier while an instrument is up.
  "=": () => ({ type: "zoom", dir: 1 }),
  "-": () => ({ type: "zoom", dir: -1 }),
  pageup: () => ({ type: "prevExcerpt" }),
  pagedown: () => ({ type: "nextExcerpt" }),
  l: () => ({ type: "linkAudio" }),
};

/**
 * True for keys the fixed keymap owns. An excerpt hotkey bound to one of
 * these would be silently shadowed (fixed bindings win in resolveIntent),
 * so editors should refuse them up front.
 */
export function isReservedKey(key: string): boolean {
  return key.toLowerCase() in rules;
}

/**
 * Resolve a keystroke against the fixed keymap and the project's excerpt
 * hotkeys. Excerpt hotkeys lose to fixed bindings — binding an excerpt to
 * Space would otherwise shadow play/pause silently.
 */
export function resolveIntent(
  stroke: KeyStroke,
  excerptHotkeys: ReadonlySet<string>,
): Intent | null {
  const key = stroke.key.toLowerCase();
  const rule = rules[key];
  if (rule) return rule(stroke);
  if (excerptHotkeys.has(key)) return { type: "triggerExcerpt", hotkey: key };
  return null;
}
