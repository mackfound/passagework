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
  | { type: "nudge"; edge: "start" | "end"; dir: 1 | -1 }
  | { type: "tap"; edge: "start" | "end" }
  | { type: "toggleImage" }
  | { type: "togglePreRoll" }
  | { type: "triggerExcerpt"; hotkey: string }
  | { type: "prevExcerpt" }
  | { type: "nextExcerpt" }
  | { type: "linkAudio" };

/** Minimal slice of KeyboardEvent so core/ never imports a DOM type. */
export interface KeyStroke {
  key: string;
  shiftKey: boolean;
}

type IntentRule = (k: KeyStroke) => Intent | null;

/**
 * The default keymap. Arrows nudge the loop start; Shift+arrows nudge the
 * end. PageUp/PageDown alias prev/next because that's what page-turner
 * pedals emit.
 */
const rules: Record<string, IntentRule> = {
  " ": () => ({ type: "togglePlay" }),
  escape: () => ({ type: "stopLoop" }),
  "[": () => ({ type: "rateStep", dir: -1 }),
  "]": () => ({ type: "rateStep", dir: 1 }),
  "\\": () => ({ type: "rateReset" }),
  arrowleft: (k) => ({ type: "nudge", edge: k.shiftKey ? "end" : "start", dir: -1 }),
  arrowright: (k) => ({ type: "nudge", edge: k.shiftKey ? "end" : "start", dir: 1 }),
  i: () => ({ type: "tap", edge: "start" }),
  o: () => ({ type: "tap", edge: "end" }),
  tab: () => ({ type: "toggleImage" }),
  p: () => ({ type: "togglePreRoll" }),
  pageup: () => ({ type: "prevExcerpt" }),
  pagedown: () => ({ type: "nextExcerpt" }),
  l: () => ({ type: "linkAudio" }),
};

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
