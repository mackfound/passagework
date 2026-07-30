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
  // No binding opens the legend: "?" is Shift+/, a two-handed chord, which
  // is exactly the gesture this app exists to avoid. The status-bar button
  // is the only way in, and that is the right one.
};

/** Every key the fixed keymap claims. Drives the legend's drift test. */
export function reservedKeys(): string[] {
  return Object.keys(rules);
}

/**
 * The keymap in human terms — the legend ui/ renders (spec §8: nothing in
 * this app is discoverable without it).
 *
 * It lives here, beside `rules`, rather than in ui/ because a legend that
 * disagrees with the keymap is worse than no legend. `covers` names the
 * `rules` entries each row documents, and a test asserts the two sides
 * match exactly — so adding a binding without documenting it fails the
 * build rather than shipping a quiet lie. Rows with an empty `covers` are
 * modifiers or dynamic bindings that have no row of their own in `rules`.
 */
export interface KeyHelp {
  keys: string;
  description: string;
  covers: string[];
}

export const KEYMAP_HELP: readonly KeyHelp[] = [
  { keys: "1 – 9", description: "loop that excerpt — press again to stop", covers: [] },
  { keys: "Space", description: "play / pause", covers: [" "] },
  { keys: "Esc", description: "drop the loop, keep playing", covers: ["escape"] },
  { keys: "PgUp / PgDn", description: "previous / next excerpt (pedal keys)", covers: ["pageup", "pagedown"] },
  { keys: "I / O", description: "tap the loop in / out point while playing", covers: ["i", "o"] },
  { keys: "← / →", description: "nudge the loop start by 10 ms", covers: ["arrowleft", "arrowright"] },
  { keys: "Shift + ← / →", description: "nudge the loop end instead", covers: [] },
  { keys: "Alt + ← / →", description: "nudge by 500 ms instead of 10 ms", covers: [] },
  { keys: "[ / ]", description: "slower / faster", covers: ["[", "]"] },
  { keys: "\\", description: "reset the rate", covers: ["\\"] },
  { keys: "P", description: "pre-roll on / off", covers: ["p"] },
  { keys: "Tab", description: "switch between the part and score images", covers: ["tab"] },
  { keys: "W", description: "waveform: drag to set loop points, click to seek", covers: ["w"] },
  { keys: "− / =", description: "zoom the waveform out / in", covers: ["-", "="] },
  { keys: "L", description: "link or replace this excerpt's recording", covers: ["l"] },
];

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
