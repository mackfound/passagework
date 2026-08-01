/**
 * ui/ — orchestration and rendering. Disposable by design (spec §3).
 *
 * Every keystroke routes through core's resolveIntent — no keydown logic
 * lives anywhere else (spec §7, pedal support depends on this).
 */

import {
  type AppState,
  type Excerpt,
  type PeakEnvelope,
  type ProjectDoc,
  type Region,
  type Source,
  type ViewWindow,
  GRID,
  KEYMAP_HELP,
  NUDGE_COARSE,
  RATE_MAX,
  clampRate,
  clampView,
  entryPosition,
  isReservedKey,
  makeEmptyProject,
  makeExcerpt,
  makePlaceholderSource,
  nextFreeHotkey,
  normalizeRegion,
  nudgeRegion,
  quantize,
  resolveIntent,
  stepRate,
  viewForRegion,
  zoomView,
} from "../core";
import { MediaElementEngine } from "../audio/MediaElementEngine";
import { EngineLoadError, WorkletEngine } from "../audio/WorkletEngine";
import type { PlaybackEngine } from "../audio/PlaybackEngine";
import { decodePeaks } from "../audio/peaks";
import {
  type ProjectListing,
  audioFromDataTransfer,
  deleteCachedPeaks,
  deleteHandle,
  deleteProject,
  imageFromDataTransfer,
  listProjects,
  loadCachedPeaks,
  loadOrSeedProject,
  loadAppState,
  loadProject,
  parseProjectJson,
  pickAudio,
  pickImage,
  pickJsonText,
  resolveAssetUrl,
  resolveAudio,
  saveAppState,
  saveCachedPeaks,
  saveHandle,
  saveProject,
  serializeProject,
} from "../storage";
import { type WaveformHandle, createWaveform } from "./waveform";
import type { AssetData } from "../core";
import { APP_NAME } from "../config";
import "./style.css";

function handleKeyFor(sourceId: string): string {
  return `handle_${sourceId}`;
}

// ---------- state ----------

/** Which implementation is actually running, as opposed to preferred. */
type EngineKind = "worklet" | "media";

/** A built engine and what it is already holding, so a swap back is free. */
interface EngineSlot {
  engine: PlaybackEngine;
  sourceId: string | null;
  duration: number | null;
}

interface UiState {
  doc: ProjectDoc;
  app: AppState;
  /** Created by the arm gesture and kept, so engines can be swapped on it. */
  ctx: AudioContext | null;
  /** Built lazily, then parked rather than disposed. See activateEngine. */
  engines: Map<EngineKind, EngineSlot>;
  engine: PlaybackEngine | null;
  /** What `engine` is. May differ from S.app.engine after a fallback. */
  engineKind: EngineKind;
  /** Duration of the source currently in the engine. */
  duration: number | null;
  /** Which source the engine holds — sources swap as excerpts are triggered. */
  loadedSourceId: string | null;
  /** Session cache: resolved Files by sourceId, so switching back is instant. */
  files: Map<string, File>;
  selectedId: string | null;
  loopingId: string | null;
  draftStart: number | null; // tap-in awaiting its tap-out
  preRollEnabled: boolean;
  imageRole: "part" | "score";
  message: string;
  messageIsError: boolean;
  /** When the strip's current message arrived. Drives its timestamp. */
  messageAt: number | null;
  /**
   * Excerpt-scoped message (§3b): shown as a marginal note on that card
   * instead of in the strip. One at a time, like the strip's own message —
   * otherwise every card accumulates a note nobody reads again.
   */
  note: { excerptId: string; message: string } | null;
  /** Newest last. Capped at LOG_LIMIT; the panel renders it reversed. */
  log: LogEntry[];
  logOpen: boolean;
  /** Messages that have arrived since the panel was last opened. */
  unseen: number;
  linkModal: { open: boolean; hint: string; target: LinkTarget };
  /** Project library dialog (M2): switch/create/import/export/delete. */
  libraryOpen: boolean;
  projectList: ProjectListing[];
  /** Excerpt editor dialog (M2): excerptId null = creating a new excerpt. */
  editor: { open: boolean; excerptId: string | null };
  /** Click-twice confirmations for the two destructive buttons. */
  confirmProjectDelete: boolean;
  confirmExcerptDelete: boolean;
  /** Waveform panel (M3) — authoring only; closed by default so the score
   *  keeps the screen during practice (§8). */
  waveformOpen: boolean;
  peaks: PeakEnvelope | null;
  /** Which source `peaks` describes — sources swap as excerpts are triggered. */
  peaksSourceId: string | null;
  /** Shown in the panel while peaks are absent: decoding, or why they failed. */
  peaksStatus: string;
  /** Visible time window. Null = derive from the excerpt's region on open. */
  view: ViewWindow | null;
  /** Keymap legend. Nothing else in the app advertises a binding. */
  helpOpen: boolean;
}

/**
 * One line of the session log. Session-only: this is not the practice log
 * of §7, which is an append-only persisted event stream with its own shape.
 * Conflating them would make that migration harder, not easier.
 */
interface LogEntry {
  at: number;
  message: string;
  isError: boolean;
}

/** Enough to scroll back through a practice session, bounded so it can't grow. */
const LOG_LIMIT = 200;

/** What the link modal is linking: one excerpt's recording, or its image slot. */
type LinkTarget =
  | { kind: "audio"; excerptId: string }
  | { kind: "image"; excerptId: string; role: "part" | "score" };

let S: UiState;

// ---------- persistence (debounced) ----------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistDoc(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveProject(S.doc), 300);
}

/** Write S.doc now — required before switching away from it or exporting. */
async function flushDoc(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveProject(S.doc);
}

/** Cancel a pending write without saving — used after deleting the active doc. */
function cancelPendingDocSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function persistApp(): void {
  void saveAppState(S.app);
}

// ---------- helpers ----------

function selected(): Excerpt | null {
  return S.doc.excerpts.find((e) => e.id === S.selectedId) ?? null;
}

function sourceOf(exc: Excerpt): Source | null {
  return S.doc.sources.find((s) => s.id === exc.sourceId) ?? null;
}

/** The seed placeholder source has a filename ref with an empty name. */
function isLinked(source: Source | null): boolean {
  return !!source && (source.fileRef.kind === "fsHandle" || source.fileRef.name !== "");
}

/** Drop sources no excerpt points at, and their stored handles. */
function pruneOrphanSources(): void {
  const used = new Set(S.doc.excerpts.map((e) => e.sourceId));
  for (const s of S.doc.sources) {
    if (!used.has(s.id) && s.fileRef.kind === "fsHandle") void deleteHandle(s.fileRef.key);
  }
  S.doc.sources = S.doc.sources.filter((s) => used.has(s.id));
}

/** Drop assets no excerpt references, and their stored handles. */
function pruneOrphanAssets(): void {
  const used = new Set(S.doc.excerpts.flatMap((e) => e.assets.map((a) => a.ref)));
  for (const [key, data] of Object.entries(S.doc.assets)) {
    if (!used.has(key)) {
      if (data.kind === "fsHandle") void deleteHandle(data.key);
      delete S.doc.assets[key];
    }
  }
}

function rateFor(exc: Excerpt): number {
  return clampRate(S.app.workingRates[exc.id] ?? exc.defaultRate);
}

/**
 * Message routing (§3b). Everything lands in the log; where it *shows*
 * depends on whether it is about the app or about one excerpt.
 *
 * `say` is global — the engine, the project, the file system, and every
 * failure. It goes to the footnote strip, which is always on screen.
 *
 * `note` is excerpt-scoped — a recording linked, an image attached, a
 * region marked. It renders as a marginal note on that card, next to the
 * thing it just changed, so the strip stays free for app-level news.
 * Failures stay on `say` even when they concern one excerpt: an error the
 * user needs to act on shouldn't be parked on a card that may be scrolled
 * out of the row.
 */
/**
 * Append unless this is the same line the log already ends with and it
 * arrived inside the dedupe window. Bouncing Space against an untimed
 * excerpt, or holding Esc, fires one identical message per keypress; a log
 * that keeps all of them is a log you stop scrolling. Runs collapse to the
 * entry that started them.
 *
 * Nothing announces this. The only visible effect is the absence of ten
 * identical rows — and, because `say` restamps only on a true append, a
 * strip whose timestamp holds still while the same thing keeps happening
 * rather than flickering once per keystroke.
 *
 * Adjacent only, deliberately: A B A B in quick succession is four real
 * events, and collapsing across the gap would reorder the history.
 *
 * Returns whether a new entry was actually made.
 */
const LOG_DEDUPE_MS = 2500;

function record(message: string, isError: boolean): boolean {
  const now = Date.now();
  const newest = S.log[S.log.length - 1];
  if (newest && newest.message === message && now - newest.at < LOG_DEDUPE_MS) return false;
  S.log.push({ at: now, message, isError });
  if (S.log.length > LOG_LIMIT) S.log.splice(0, S.log.length - LOG_LIMIT);
  // Opening the panel is what marks messages seen; while it is open they
  // are being read as they arrive, so the counter never starts climbing.
  if (!S.logOpen) S.unseen++;
  return true;
}

function say(message: string, isError = false): void {
  if (record(message, isError)) S.messageAt = Date.now();
  S.message = message;
  S.messageIsError = isError;
  renderStatus();
}

function note(excerptId: string, message: string): void {
  S.note = { excerptId, message };
  record(message, false);
  renderStatus();
}

/**
 * What the strip last painted. The cross-fade is for new messages (§3),
 * and render() rebuilds the strip for every unrelated reason — selecting a
 * card, opening the log — so without this the message fades in again each
 * time as if it had just arrived.
 */
let paintedMessage: string | null = null;

/** Drop the marginal note if it belongs to an excerpt that is gone. */
function pruneNote(): void {
  if (S.note && !S.doc.excerpts.some((e) => e.id === S.note!.excerptId)) S.note = null;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

/** Wall clock for the strip and the log. Tabular, so the column aligns. */
function fmtStamp(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/**
 * The word at the left of the strip. The spec names stopped / looping /
 * armed; "playing" is the fourth real state — Esc drops the loop but keeps
 * the audio running (free playback), and calling that "stopped" would be a
 * lie told next to a green dot.
 */
function transportState(): { word: string; running: boolean } {
  const moving = !!S.engine && !S.engine.paused;
  if (S.draftStart !== null) return { word: "armed", running: moving };
  if (S.loopingId !== null) return { word: "looping", running: moving };
  return { word: moving ? "playing" : "stopped", running: moving };
}

// ---------- intent handlers ----------

function triggerExcerpt(hotkey: string): void {
  const exc = S.doc.excerpts.find((e) => e.hotkey === hotkey);
  if (!exc) return;
  if (S.loopingId === exc.id) {
    stopLoop(true);
    return;
  }
  selectExcerpt(exc);
  void startLoop(exc);
}

function selectExcerpt(exc: Excerpt): void {
  S.selectedId = exc.id;
  S.app.selectedExcerptId = exc.id;
  persistApp();
  S.draftStart = null;
  S.imageRole = exc.assets.some((a) => a.role === "part") ? "part" : "score";
  S.view = null; // re-fit the waveform to this excerpt's region
  S.engine?.setRate(rateFor(exc));
  void renderImage();
  render();
  // A different excerpt may play a different recording; the panel follows.
  if (S.waveformOpen) void ensurePeaks();
}

async function startLoop(exc: Excerpt): Promise<void> {
  if (!S.engine) return;
  if (!(await ensureSourceLoaded(exc))) return;
  if (!exc.region) {
    S.loopingId = null;
    S.engine.setLoop(null);
    note(exc.id, "untimed — Space to play, tap I / O to mark it");
    render();
    return;
  }
  const entry = S.preRollEnabled ? entryPosition(exc.region, exc.preRoll) : exc.region.start;
  S.engine.setLoop(exc.loop ? exc.region : null);
  S.engine.setRate(rateFor(exc));
  S.engine.seek(entry);
  S.engine.play();
  S.loopingId = exc.id;
  say(
    S.preRollEnabled && exc.preRoll > 0
      ? `pre-roll ${exc.preRoll.toFixed(1)}s → loop`
      : "looping",
  );
  render();
}

/** Esc: drop the loop, keep playing (free playback). Hotkey re-press: full stop. */
function stopLoop(pause: boolean): void {
  S.engine?.setLoop(null);
  S.loopingId = null;
  if (pause) S.engine?.pause();
  say(pause ? "stopped" : "loop off — free playback");
  render();
}

async function togglePlay(): Promise<void> {
  const exc = selected();
  if (!exc || !S.engine) return;
  if (!(await ensureSourceLoaded(exc))) return;
  if (S.engine.paused) S.engine.play();
  else S.engine.pause();
  renderStatus();
}

/**
 * Make sure the engine holds this excerpt's recording, resolving and
 * loading it on demand. Runs inside a keypress gesture, so a stale
 * handle's permission re-prompt can succeed here (§5). On failure the
 * link modal opens for this excerpt and the trigger is abandoned.
 */
async function ensureSourceLoaded(exc: Excerpt): Promise<boolean> {
  if (!S.engine) return false;
  if (S.loadedSourceId === exc.sourceId) return true;
  const source = sourceOf(exc);
  if (!source) return false;
  let file = S.files.get(exc.sourceId) ?? null;
  if (!file) {
    const resolved = await resolveAudio(source.fileRef);
    if (!resolved.ok) {
      const why = {
        "no-handle": `no recording linked for "${exc.title ?? exc.label}" yet`,
        "permission-denied": "permission to the recording was denied",
        "file-missing": "the recording moved or was deleted",
      }[resolved.reason];
      say(`${why} — press L to link it`, true);
      openLinkModal(why, { kind: "audio", excerptId: exc.id });
      return false;
    }
    file = resolved.file;
  }
  S.files.set(exc.sourceId, file);
  await loadIntoEngine(file, exc.sourceId);
  // a successful load satisfies whatever the audio modal was asking for
  if (S.linkModal.open && S.linkModal.target.kind === "audio") closeLinkModal();
  return true;
}

function setRate(rate: number): void {
  const exc = selected();
  if (!exc) return;
  const next = clampRate(rate);
  S.app.workingRates[exc.id] = next; // sticky-persisted progress, not config (AppState)
  S.engine?.setRate(next);
  persistApp();
  renderStatus();
}

function rateStepIntent(dir: 1 | -1): void {
  const exc = selected();
  if (!exc) return;
  setRate(stepRate(rateFor(exc), dir));
}

function rateReset(): void {
  setRate(RATE_MAX);
}

function tap(edge: "start" | "end"): void {
  const exc = selected();
  if (!exc || !S.engine) return;
  if (S.loadedSourceId !== exc.sourceId) {
    say("play this excerpt first — its recording isn't loaded", true);
    return;
  }
  const pos = quantize(S.engine.getPosition());
  if (edge === "start") {
    if (exc.region) {
      const next = normalizeRegion(pos, exc.region.end, S.duration);
      if (next) {
        exc.region = next;
        note(exc.id, `in → ${fmtTime(pos)}`);
      } else {
        S.draftStart = pos; // tapped past the old end: treat as a fresh in-point
        exc.region = null;
        note(exc.id, `in → ${fmtTime(pos)} — tap O to set the out point`);
      }
    } else {
      S.draftStart = pos;
      note(exc.id, `in → ${fmtTime(pos)} — tap O to set the out point`);
    }
  } else {
    const start = S.draftStart ?? exc.region?.start;
    if (start === undefined) {
      say("tap I first — no in point yet", true);
      return;
    }
    const next = normalizeRegion(start, pos, S.duration);
    if (!next) {
      say("out point must be after the in point", true);
      return;
    }
    exc.region = next;
    S.draftStart = null;
    note(exc.id, `region set ${fmtTime(next.start)} – ${fmtTime(next.end)} — press ${exc.hotkey ?? "its key"} to loop`);
  }
  persistDoc();
  render();
}

function nudge(edge: "start" | "end", dir: 1 | -1, coarse: boolean): void {
  const exc = selected();
  if (!exc?.region) return;
  const next = nudgeRegion(exc.region, edge, dir, S.duration, coarse ? NUDGE_COARSE : GRID);
  if (next === exc.region) return; // hit a wall
  exc.region = next;
  // live-update an active loop so nudges are audible immediately
  if (S.loopingId === exc.id) S.engine?.setLoop(next);
  note(exc.id, `${edge} → ${fmtTime(edge === "start" ? next.start : next.end)}`);
  persistDoc();
  renderStatus();
}

function toggleImage(): void {
  const exc = selected();
  if (!exc) return;
  S.imageRole = S.imageRole === "part" ? "score" : "part";
  void renderImage();
}

function togglePreRoll(): void {
  S.preRollEnabled = !S.preRollEnabled;
  say(S.preRollEnabled ? "pre-roll on" : "pre-roll off");
  render();
}

/**
 * The excerpt's own `loop` flag — authored config, so it persists with the
 * project rather than the session. A live loop follows immediately: the
 * point of the toggle is to hear the difference on the passage in front of
 * you, not on the next one.
 */
function toggleExcerptLoop(): void {
  const exc = selected();
  if (!exc) return;
  exc.loop = !exc.loop;
  if (S.loopingId === exc.id) S.engine?.setLoop(exc.loop ? exc.region : null);
  persistDoc();
  say(exc.loop ? "loop on" : "loop off — plays through");
  render();
}

function toggleLog(): void {
  S.logOpen = !S.logOpen;
  if (S.logOpen) S.unseen = 0; // opening is what marks them read
  render();
}

/**
 * Session-only history, so this asks nothing before discarding it —
 * nothing here is persisted or exported, and the practice log of §7 will
 * be a separate, append-only stream. The panel stays open on "nothing
 * logged yet", which is the confirmation.
 *
 * The strip's current message is left alone: it reports what is true now,
 * not what happened, and blanking it would make the app look asleep.
 */
function clearLog(): void {
  S.log = [];
  S.unseen = 0;
  render();
}

function toggleHelp(): void {
  S.helpOpen = !S.helpOpen;
  render();
}

// ---------- waveform (M3) ----------

/**
 * The window the panel is showing. Derived from the excerpt's region the
 * first time it's needed, then owned by the user's zooming until the
 * selection changes (selectExcerpt clears it).
 */
function currentView(): ViewWindow {
  const duration = S.duration ?? 0;
  S.view ??= viewForRegion(selected()?.region ?? null, duration);
  return clampView(S.view, duration);
}

function toggleWaveform(): void {
  S.waveformOpen = !S.waveformOpen;
  if (S.waveformOpen) {
    S.view = null; // re-fit to the current excerpt on each open
    void ensurePeaks();
  }
  render();
}

function zoomIntent(dir: 1 | -1): void {
  if (!S.waveformOpen || !S.peaks) return;
  const duration = S.duration ?? 0;
  // Anchor on the playhead, not the window centre: while looping, the
  // interesting moment is where playback is.
  const anchor = S.engine?.getPosition() ?? currentView().start;
  S.view = zoomView(currentView(), dir === 1 ? 0.7 : 1 / 0.7, anchor, duration);
  render();
}

/**
 * Get the envelope for the loaded source: cache first, decode on a miss.
 *
 * Decoding is deliberately lazy — nothing computes peaks until the panel is
 * opened, so practising never pays for an analysis pass it won't use. A
 * failure is reported in the panel and nowhere else: tap-to-mark still
 * works without a waveform, so this must never block playback.
 */
async function ensurePeaks(): Promise<void> {
  const sourceId = S.loadedSourceId;
  if (!sourceId) {
    S.peaksStatus = "play this excerpt first — its recording isn't loaded";
    S.peaks = null;
    return;
  }
  if (S.peaksSourceId === sourceId && S.peaks) return;
  const file = S.files.get(sourceId);
  if (!file) {
    S.peaksStatus = "recording unavailable";
    S.peaks = null;
    return;
  }

  S.peaks = null;
  S.peaksSourceId = sourceId;
  S.peaksStatus = "reading cached waveform…";
  render();

  const cached = await loadCachedPeaks(sourceId, file);
  if (cached) {
    // The panel may have been closed, or another source loaded, while this
    // was in flight; only adopt the result if it's still the one wanted.
    if (S.peaksSourceId === sourceId) {
      S.peaks = cached;
      render();
    }
    return;
  }

  S.peaksStatus = `analysing ${file.name}…`;
  render();
  const result = await decodePeaks(file);
  if (S.peaksSourceId !== sourceId) return;
  if (!result.ok) {
    S.peaks = null;
    S.peaksStatus =
      result.reason === "too-large" ? result.detail : `couldn't read a waveform: ${result.detail}`;
    render();
    return;
  }
  S.peaks = result.env;
  render();
  void saveCachedPeaks(sourceId, file, result.env);
}

/** Region edits coming from the panel rather than the keyboard. */
function waveformDraft(region: Region): void {
  const exc = selected();
  if (!exc) return;
  exc.region = region;
  if (S.loopingId === exc.id) S.engine?.setLoop(region);
}

function waveformCommit(region: Region): void {
  const exc = selected();
  if (!exc) return;
  exc.region = region;
  if (S.loopingId === exc.id) S.engine?.setLoop(region);
  persistDoc();
  note(exc.id, `region set ${fmtTime(region.start)} – ${fmtTime(region.end)}`);
  render();
}

function stepSelection(dir: 1 | -1): void {
  const list = S.doc.excerpts;
  if (list.length === 0) return;
  const idx = list.findIndex((e) => e.id === S.selectedId);
  const next = list[(idx + dir + list.length) % list.length];
  if (!next) return;
  selectExcerpt(next);
  if (next.region) void startLoop(next); // pedal flow: next excerpt starts looping
}

function openLinkModal(hint: string, target: LinkTarget): void {
  S.linkModal = { open: true, hint, target };
  render();
}

function closeLinkModal(): void {
  S.linkModal.open = false;
  render();
}

/**
 * Attach a picked/dropped recording to one excerpt. Identical filenames
 * dedup into a single source, so excerpts from the same movement share
 * one recording (and one persisted handle) instead of storing it twice.
 */
async function completeLink(
  file: File,
  handle: FileSystemFileHandle | null,
  excerptId: string,
): Promise<void> {
  const exc = S.doc.excerpts.find((e) => e.id === excerptId);
  if (!exc) return;

  // captured before any mutation: the recording the timings were marked against
  const prevSource = sourceOf(exc);
  const prevLabel = isLinked(prevSource) ? prevSource!.label : null;

  let source = S.doc.sources.find((s) => isLinked(s) && s.label === file.name) ?? null;
  if (!source) {
    const current = sourceOf(exc);
    const shared = S.doc.excerpts.some((e) => e.id !== exc.id && e.sourceId === exc.sourceId);
    if (current && !shared) {
      source = current; // sole user: replace this excerpt's recording in place
    } else {
      source = {
        id: `src_${crypto.randomUUID().slice(0, 8)}`,
        label: "",
        fileRef: { kind: "filename", name: "" },
        duration: null,
        sampleRate: null,
      };
      S.doc.sources.push(source);
    }
    source.label = file.name;
    source.duration = null;
    source.sampleRate = null;
  }
  exc.sourceId = source.id;

  if (handle) {
    // reuse the source's existing key so a re-drop refreshes a stale handle
    const key = source.fileRef.kind === "fsHandle" ? source.fileRef.key : handleKeyFor(source.id);
    await saveHandle(key, handle);
    source.fileRef = { kind: "fsHandle", key };
  } else if (source.fileRef.kind !== "fsHandle") {
    source.fileRef = { kind: "filename", name: file.name };
  }
  const persistent = source.fileRef.kind === "fsHandle";
  pruneOrphanSources();

  S.files.set(source.id, file);
  try {
    await loadIntoEngine(file, source.id);
  } catch {
    // The drop sniff is a courtesy; this is the real verdict. Surface it
    // instead of dying as an unhandled rejection, and drop loadedSourceId
    // so the next trigger reloads — the engine's element is now pointing
    // at the file that just failed.
    S.files.delete(source.id);
    S.loadedSourceId = null;
    S.linkModal.hint = `"${file.name}" won't play in this browser — try another file`;
    render();
    return;
  }
  persistDoc();
  S.linkModal.open = false;
  // Timings are kept on a recording swap — right when re-pointing at the
  // same performance in a moved/renamed file, stale when it's a different
  // one. Warn rather than clear; re-tapping is cheap, lost marks aren't.
  const staleTimings = prevLabel !== null && prevLabel !== file.name && exc.region !== null;
  if (staleTimings) {
    say(`linked: ${file.name} — loop points were marked against "${prevLabel}", re-check them`, true);
  } else if (!persistent) {
    say(`linked for this session: ${file.name} — re-link after a restart`, true);
  } else {
    note(exc.id, `linked ${file.name}`);
  }
  render();
}

async function browseForAudio(excerptId: string): Promise<void> {
  const picked = await pickAudio();
  if (!picked) return;
  await completeLink(picked.file, picked.handle, excerptId);
}

async function dropAudio(dt: DataTransfer, excerptId: string): Promise<void> {
  const result = await audioFromDataTransfer(dt);
  if (!result) return;
  if ("error" in result) {
    S.linkModal.hint = result.error;
    render();
    return;
  }
  await completeLink(result.file, result.handle, excerptId);
}

// ---------- image linking (same modal, image target) ----------

function imageAssetId(excerptId: string, role: "part" | "score"): string {
  return `img_${excerptId}_${role}`;
}

function applyImageAsset(excerptId: string, role: "part" | "score", data: AssetData): void {
  const exc = S.doc.excerpts.find((e) => e.id === excerptId);
  if (!exc) return;
  const assetId = imageAssetId(excerptId, role);
  S.doc.assets[assetId] = data;
  const existing = exc.assets.find((a) => a.role === role);
  if (existing) existing.ref = assetId;
  else exc.assets.push({ type: "image", role, ref: assetId });
  persistDoc();
  S.imageRole = role;
  S.linkModal.open = false;
  // asset mode must be visible, not silent (§5)
  note(excerptId, `${role} image attached (${data.kind === "inline" ? "inline" : "file-backed"})`);
  render();
  void renderImage();
}

async function browseForImage(excerptId: string, role: "part" | "score"): Promise<void> {
  const data = await pickImage(imageAssetId(excerptId, role));
  if (!data) return;
  applyImageAsset(excerptId, role, data);
}

async function dropImage(dt: DataTransfer, excerptId: string, role: "part" | "score"): Promise<void> {
  const result = await imageFromDataTransfer(dt, imageAssetId(excerptId, role));
  if (!result) return;
  if ("error" in result) {
    S.linkModal.hint = result.error;
    render();
    return;
  }
  applyImageAsset(excerptId, role, result.data);
}

/** Modal Enter/B and the browse button route here; the drop handler routes to drop*. */
function browseForTarget(): void {
  const t = S.linkModal.target;
  if (t.kind === "audio") void browseForAudio(t.excerptId);
  else void browseForImage(t.excerptId, t.role);
}

// ---------- project library (M2) ----------

function openLibrary(): void {
  S.libraryOpen = true;
  S.confirmProjectDelete = false;
  render();
  void listProjects().then((list) => {
    S.projectList = list;
    if (S.libraryOpen) render();
  });
}

function closeDialogs(): void {
  S.libraryOpen = false;
  S.editor.open = false;
  render();
}

/**
 * Inline rename: swap the status-bar name button for an input in place —
 * no dialog. Enter/blur commits, Escape cancels. The swap is imperative
 * (outside render()) so typing never fights a re-render; any commit or
 * cancel path ends in render(), which rebuilds the normal bar.
 */
function startRenameInline(btn: HTMLElement): void {
  const input = h("input", "session-edit");
  input.type = "text";
  input.value = S.doc.name;
  input.setAttribute("aria-label", "Project name");
  let cancelled = false;
  const commit = () => {
    if (cancelled) return;
    const name = input.value.trim();
    if (name && name !== S.doc.name) {
      S.doc.name = name;
      // flush, not debounce: the library list reads names straight from IndexedDB
      void flushDoc();
      say(`renamed to "${name}"`);
    } else {
      render();
    }
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // keys type into the name, never reach the keymap
    if (ev.key === "Enter") {
      input.blur(); // commit runs once, via the blur handler
    } else if (ev.key === "Escape") {
      cancelled = true;
      render();
    }
  });
  input.addEventListener("blur", commit);
  btn.replaceWith(input);
  input.focus();
  input.select();
}

/** Point the UI at a different doc. Pure state reset — callers handle IO. */
function adoptDoc(doc: ProjectDoc): void {
  S.doc = doc;
  S.selectedId = doc.excerpts[0]?.id ?? null;
  S.loopingId = null;
  S.loadedSourceId = null;
  S.duration = null;
  S.draftStart = null;
  S.imageRole = "part";
  // Peaks belong to the outgoing project's source; drop them rather than
  // draw the previous recording under the new project's excerpts.
  S.peaks = null;
  S.peaksSourceId = null;
  S.peaksStatus = "";
  S.view = null;
  S.engine?.setLoop(null);
  S.engine?.pause();
  S.app.activeProjectId = doc.id;
  S.app.selectedExcerptId = S.selectedId;
  persistApp();
  S.libraryOpen = false;
  render();
  void renderImage();
}

async function switchProject(id: string): Promise<void> {
  // Picking the project you are already on is a no-op, not a reload.
  // adoptDoc resets the selection to the first excerpt, drops the loop,
  // pauses, and throws away the peak cache — a full session reset in
  // exchange for a click that asked for nothing.
  if (id === S.doc.id) {
    S.libraryOpen = false;
    render();
    return;
  }
  await flushDoc();
  const doc = await loadProject(id);
  if (!doc) {
    say("that project could not be loaded", true);
    return;
  }
  adoptDoc(doc);
  say(`switched to "${doc.name}"`);
}

async function createProject(name: string): Promise<void> {
  const doc = makeEmptyProject(name.trim() || "Untitled");
  await flushDoc(); // save the outgoing project before moving on
  await saveProject(doc);
  adoptDoc(doc);
  say(`created "${doc.name}" — add an excerpt below to get started`);
}

function exportProjectFlow(): void {
  const json = serializeProject(S.doc);
  void flushDoc(); // exported file and IndexedDB should agree
  const name = `${S.doc.name.replace(/[^\w\- ]+/g, "").trim() || "project"}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  say(`exported ${name}`);
}

async function importProjectFlow(): Promise<void> {
  const text = await pickJsonText();
  if (text === null) return;
  let doc: ProjectDoc;
  try {
    doc = parseProjectJson(text);
  } catch (err) {
    say(`import failed: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }
  // Same id = restoring a backup of an existing project: replace it. A
  // fresh id imports alongside. Never invent a new id — re-imports of the
  // same backup must not multiply.
  const replacing =
    doc.id === S.doc.id || S.projectList.some((p) => p.id === doc.id);
  if (doc.id === S.doc.id) cancelPendingDocSave(); // don't clobber the import with the old doc
  else await flushDoc();
  await saveProject(doc);
  adoptDoc(doc);
  say(
    `imported "${doc.name}" (${doc.excerpts.length} excerpt${doc.excerpts.length === 1 ? "" : "s"})${replacing ? " — replaced the stored copy" : ""}`,
  );
}

async function deleteActiveProject(): Promise<void> {
  // this project's stored handles go with it
  for (const s of S.doc.sources) {
    if (s.fileRef.kind === "fsHandle") void deleteHandle(s.fileRef.key);
    void deleteCachedPeaks(s.id); // derived data, no reason to outlive the source
  }
  for (const data of Object.values(S.doc.assets)) {
    if (data.kind === "fsHandle") void deleteHandle(data.key);
  }
  const deadId = S.doc.id;
  const deadName = S.doc.name;
  cancelPendingDocSave(); // a queued write would resurrect it
  await deleteProject(deadId);
  const remaining = (await listProjects()).filter((p) => p.id !== deadId);
  const nextId = remaining[0]?.id;
  const next = nextId ? await loadProject(nextId) : null;
  if (next) {
    adoptDoc(next);
  } else {
    // nothing left: reseed rather than strand the UI without a doc
    await saveAppState({ ...S.app, activeProjectId: null });
    adoptDoc(await loadOrSeedProject());
  }
  say(`deleted "${deadName}"`);
}

// ---------- excerpt editor (M2) ----------

function openEditor(excerptId: string | null): void {
  S.editor = { open: true, excerptId };
  S.confirmExcerptDelete = false;
  render();
}

/**
 * Validate + apply the editor form. Returns an error string instead of
 * applying when the input is bad — the caller shows it without re-rendering
 * (a render would wipe the form the user is still fixing).
 */
function saveExcerptFields(rawLabel: string, rawTitle: string, rawHotkey: string): string | null {
  const label = rawLabel.trim();
  const title = rawTitle.trim();
  const hotkey = rawHotkey.trim().toLowerCase();
  if (!label) return "label is required";
  if (hotkey.length > 1) return "hotkey must be a single key";
  if (hotkey && isReservedKey(hotkey)) return `"${hotkey}" is reserved by the app keymap`;
  const clash = S.doc.excerpts.find((e) => e.hotkey === hotkey && e.id !== S.editor.excerptId);
  if (hotkey && clash) return `"${hotkey}" is already used by "${clash.title ?? clash.label}"`;

  if (S.editor.excerptId === null) {
    const source = makePlaceholderSource();
    S.doc.sources.push(source);
    const exc = makeExcerpt(
      { label, ...(title ? { title } : {}), ...(hotkey ? { hotkey } : {}) },
      source.id,
    );
    S.doc.excerpts.push(exc);
    S.selectedId = exc.id;
    S.app.selectedExcerptId = exc.id;
    persistApp();
    note(exc.id, "press L to link its recording");
  } else {
    const exc = S.doc.excerpts.find((e) => e.id === S.editor.excerptId);
    if (!exc) return "excerpt no longer exists";
    exc.label = label;
    if (title) exc.title = title;
    else delete exc.title;
    if (hotkey) exc.hotkey = hotkey;
    else delete exc.hotkey;
    note(exc.id, "saved");
  }
  persistDoc();
  S.editor.open = false;
  render();
  return null;
}

function deleteExcerptFlow(excerptId: string): void {
  const idx = S.doc.excerpts.findIndex((e) => e.id === excerptId);
  if (idx === -1) return;
  const [gone] = S.doc.excerpts.splice(idx, 1);
  pruneOrphanSources();
  pruneOrphanAssets();
  if (S.loopingId === excerptId) {
    S.engine?.setLoop(null);
    S.engine?.pause();
    S.loopingId = null;
  }
  if (S.selectedId === excerptId) {
    S.selectedId = S.doc.excerpts[0]?.id ?? null;
    S.app.selectedExcerptId = S.selectedId;
    persistApp();
  }
  persistDoc();
  S.editor.open = false;
  pruneNote(); // its card is gone; the note would have nowhere to render
  say(`deleted "${gone?.title ?? gone?.label ?? "excerpt"}"`);
  render();
  void renderImage();
}

// ---------- audio boot ----------

/**
 * Make `want` the live engine, building it the first time and reusing it
 * ever after. Returns a note when it could not be had — a browser without
 * AudioWorklet must land on the M1 engine, not on silence (§6 M4).
 *
 * Engines are parked, never disposed. An idle MediaElementEngine costs an
 * <audio> element; an idle WorkletEngine costs the PCM it decoded, which
 * is the point — that decode takes seconds on a symphony, and toggling is
 * how you compare the two. A user who settles on the basic engine gets the
 * memory back on the next launch, because the stored preference means the
 * worklet is never built at all.
 */
async function activateEngine(want: EngineKind): Promise<string | null> {
  const ctx = S.ctx;
  if (!ctx) return null;
  let kind = want;
  let fellBack: string | null = null;

  if (!S.engines.has(kind)) {
    if (kind === "worklet") {
      try {
        registerEngine("worklet", await WorkletEngine.create(ctx));
      } catch (err) {
        const why =
          err instanceof EngineLoadError ? err.message : "the seamless engine failed to start";
        fellBack = `${why} — using the basic engine`;
        kind = "media";
      }
    }
    if (!S.engines.has(kind)) registerEngine(kind, new MediaElementEngine(ctx));
  }

  const slot = S.engines.get(kind)!;
  S.engine = slot.engine;
  S.engineKind = kind;
  S.loadedSourceId = slot.sourceId;
  if (slot.duration !== null) S.duration = slot.duration;
  return fellBack;
}

/** Subscribe once, at construction — reuse must not stack tick callbacks. */
function registerEngine(kind: EngineKind, engine: PlaybackEngine): void {
  engine.onTick(onTick);
  S.engines.set(kind, { engine, sourceId: null, duration: null });
}

/**
 * Flip engines and carry the loaded recording across (§6 M4). The choice
 * sticks per machine. Playback stops rather than resuming: the swap can
 * involve a decode, and audio restarting on its own after that pause is a
 * surprise, not a convenience.
 */
/**
 * Swap the live engine, carrying the transport across.
 *
 * The badge used to say choosing an engine was "setup, not something done
 * mid-passage", and nothing enforced it: switching mid-loop silently
 * paused you somewhere inside the region with the loop dropped, at the new
 * engine's default rate.
 *
 * Enforcing it would have been the wrong fix. Comparing the two engines is
 * the entire reason both are kept alive, and a comparison you can only
 * make by stopping, switching and restarting is one you cannot actually
 * hear — the memory of the other engine's seam is gone by the time the
 * passage comes back around. So the loop, the rate and the play state all
 * survive the swap, and the switch happens under the passage you are
 * already listening to.
 */
async function toggleEngine(): Promise<void> {
  if (!S.ctx) return;
  const want: EngineKind = S.engineKind === "worklet" ? "media" : "worklet";
  const wanted = S.loadedSourceId;
  const at = S.engine?.getPosition() ?? 0;
  const wasLooping = S.loopingId;
  const wasPlaying = S.engine ? !S.engine.paused : false;

  // Park the outgoing engine. Paused, it renders silence, so both can stay
  // connected to the destination and only the live one is heard.
  S.engine?.setLoop(null);
  S.engine?.pause();
  S.loopingId = null;

  const fellBack = await activateEngine(want);
  S.app.engine = S.engineKind;
  persistApp();

  const named = S.engineKind === "worklet" ? "seamless engine on" : "basic engine on";
  const file = wanted ? S.files.get(wanted) : undefined;
  try {
    // Already holding this recording? Then the swap is free — that is the
    // whole reason the engines are kept.
    if (wanted && file && S.loadedSourceId !== wanted) await loadIntoEngine(file, wanted);
    if (S.loadedSourceId) {
      // Same order as startLoop: loop, rate, seek, play. A fresh engine
      // carries none of this — the rate in particular was being silently
      // reset to 1.0 on every switch.
      const resume = S.doc.excerpts.find((e) => e.id === wasLooping) ?? null;
      const exc = resume ?? selected();
      if (resume?.region && resume.loop) {
        S.engine?.setLoop(resume.region);
        S.loopingId = resume.id;
      }
      if (exc) S.engine?.setRate(rateFor(exc));
      S.engine?.seek(at);
      if (wasPlaying) S.engine?.play();
      onTick(at);
    }
    say(fellBack ?? named, Boolean(fellBack));
  } catch {
    say(`"${file?.name ?? "that recording"}" won't load into that engine — press L to link another`, true);
  }
  render();
}

async function loadIntoEngine(file: File, sourceId: string): Promise<void> {
  let slot = S.engines.get(S.engineKind);
  if (!slot) return;
  // Decoding a long recording takes seconds and blocks nothing visibly;
  // without this the app looks hung on the first trigger.
  if (S.engineKind === "worklet") say(`decoding ${file.name} …`);

  let loaded;
  try {
    loaded = await slot.engine.load({ id: sourceId, file });
  } catch (err) {
    // A recording the worklet can't hold or decode is not a dead end — the
    // M1 engine streams and doesn't care how long the file is.
    if (!(err instanceof EngineLoadError) || S.engineKind !== "worklet" || !S.ctx) throw err;
    await activateEngine("media");
    slot = S.engines.get("media")!;
    say(`${err.message} — using the basic engine`, true);
    loaded = await slot.engine.load({ id: sourceId, file });
  }
  slot.sourceId = sourceId;
  slot.duration = loaded.duration;
  S.duration = loaded.duration;
  S.loadedSourceId = sourceId;
  const source = S.doc.sources.find((s) => s.id === sourceId);
  if (!source) return;
  let dirty = false;
  if (source.duration !== loaded.duration) {
    source.duration = loaded.duration;
    dirty = true;
  }
  // A source's label is its linked filename. Sources linked before that
  // rule existed (M1 set only fileRef) self-heal here on first load.
  if (source.label !== file.name) {
    source.label = file.name;
    dirty = true;
  }
  if (dirty) persistDoc();
  // The engine just swapped recordings; the open panel must not keep showing
  // the previous one's envelope.
  if (S.waveformOpen) void ensurePeaks();
}

/**
 * Runs inside the arm gesture: AudioContext resume + handle permission in
 * one go (§11). Only the selected excerpt's source is resolved here — the
 * rest load lazily on trigger, each inside its own keypress gesture.
 */
async function armAudio(): Promise<void> {
  const ctx = new AudioContext();
  await ctx.resume();
  S.ctx = ctx;
  const fellBack = await activateEngine(S.app.engine ?? "worklet");
  if (fellBack) say(fellBack, true);

  const exc = selected();
  if (!exc) return;
  const source = sourceOf(exc);
  const resolved = source
    ? await resolveAudio(source.fileRef)
    : ({ ok: false, reason: "no-handle" } as const);
  if (resolved.ok) {
    S.files.set(exc.sourceId, resolved.file);
    try {
      await loadIntoEngine(resolved.file, exc.sourceId);
      say(`audio ready: ${resolved.file.name}`);
    } catch {
      say(`"${resolved.file.name}" won't play in this browser — press L to link another`, true);
    }
  } else {
    const why = {
      "no-handle": `no recording linked for "${exc.title ?? exc.label}" yet`,
      "permission-denied": "permission to the recording was denied",
      "file-missing": "the recording moved or was deleted",
    }[resolved.reason];
    say(`${why} — press L to link it`, true);
    openLinkModal(why, { kind: "audio", excerptId: exc.id });
  }
}

/** False until the arming gesture; gates the keymap so the first key can't act. */
let armed = false;
let armOverlay: HTMLElement | null = null;

/**
 * Dismiss the landing overlay and start the audio stack. Idempotent — the
 * click and keydown paths both land here.
 *
 * The overlay exists only because an AudioContext starts suspended and
 * needs a user gesture (§11). The gesture is a precondition, not a command,
 * so whatever key supplied it is consumed by onKeydown and never reaches
 * the keymap: arriving on the main screen must not start playback, trigger
 * an excerpt, or change any state.
 */
function armApp(): void {
  if (armed) return;
  armed = true;
  armOverlay?.remove();
  armOverlay = null;
  render();
  void armAudio().then(() => render());
}

// ---------- rendering ----------

const app = document.querySelector<HTMLDivElement>("#app")!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

let fillEl: HTMLElement;
let regionBarEl: HTMLElement;
/** Live panel, or null when closed. render() owns its lifecycle. */
let waveform: WaveformHandle | null = null;

function render(): void {
  app.textContent = "";
  app.append(renderHeader());

  // stage
  const stage = h("div", "stage");
  stage.append(h("div", "placeholder", "no image for this excerpt yet"));
  app.append(stage);
  void renderImage();

  // waveform panel (M3): between the score and the progress strip, so the
  // image keeps the top of the screen even while authoring
  waveform?.dispose();
  waveform = null;
  if (S.waveformOpen) {
    waveform = createWaveform({
      env: S.peaks,
      status: S.peaksStatus,
      region: selected()?.region ?? null,
      view: currentView(),
      duration: S.duration ?? 0,
      position: () => S.engine?.getPosition() ?? 0,
      onRegionDraft: waveformDraft,
      onRegionCommit: waveformCommit,
      onSeek: (t) => {
        S.engine?.seek(t);
        onTick(t);
      },
      onView: (v) => {
        S.view = v;
        render();
      },
    });
    app.append(waveform.element);
    waveform.mount(); // sizes the canvases now that they have a layout box
  }

  // region progress strip
  regionBarEl = h("div", "regionbar");
  fillEl = h("div", "fill");
  regionBarEl.append(fillEl);
  app.append(regionBarEl);

  // excerpt row
  const row = h("div", "excerpts");
  for (const e of S.doc.excerpts) row.append(renderCard(e));
  const add = h("button", "excerpt addcard t-label", "+ excerpt");
  add.type = "button";
  add.addEventListener("click", () => {
    add.blur();
    openEditor(null);
  });
  row.append(add);
  app.append(row);

  // Docked to the bottom edge, with the log unrolling upward above it, so
  // the strip itself never moves when the panel opens.
  if (S.logOpen) app.append(renderLogPanel());
  app.append(renderFootnote());

  if (S.linkModal.open) renderLinkModal();
  if (S.libraryOpen) renderLibraryModal();
  if (S.editor.open) renderEditorModal();
  if (S.helpOpen) renderHelpModal();
}

/**
 * One 52px row (§3c). Everything that used to sit here as prose — the
 * message, the position readout — moved to the footnote strip, which is
 * what makes a single row enough.
 */
function renderHeader(): HTMLElement {
  const bar = h("div", "header");
  bar.append(h("span", "brand", APP_NAME));

  // One visual unit, two targets. Merging them into a single button cost
  // the rename its click — it became a double-click nobody would guess at,
  // and a name you can click but not edit is worse than no affordance at
  // all. The chevron is the menu, the way it reads.
  const session = h("div", "session");
  const nameBtn = h("button", "session-name", S.doc.name);
  nameBtn.type = "button";
  nameBtn.title = "click to rename this project";
  nameBtn.addEventListener("click", () => startRenameInline(nameBtn));
  const menuBtn = h("button", "session-menu");
  menuBtn.type = "button";
  menuBtn.title = "projects: switch, import/export, create";
  menuBtn.setAttribute("aria-label", "projects");
  menuBtn.append(h("span", "chevron"));
  menuBtn.addEventListener("click", () => {
    menuBtn.blur(); // keys stay global; a focus ring here would eat Space
    openLibrary();
  });
  session.append(nameBtn, menuBtn);
  bar.append(session);

  bar.append(h("div", "spacer"));
  bar.append(renderToggles());
  bar.append(renderRate());
  bar.append(h("span", "rule"));

  // The only thing on screen that advertises a key at all.
  const helpBtn = h("button", "helpbtn", "?");
  helpBtn.type = "button";
  helpBtn.title = "keyboard shortcuts";
  helpBtn.setAttribute("aria-label", "keyboard shortcuts");
  helpBtn.addEventListener("click", () => {
    helpBtn.blur(); // keys stay global; a focus ring here would eat Space
    toggleHelp();
  });
  bar.append(helpBtn);
  return bar;
}

/**
 * Three independent toggles, not a radio group — hence no selection
 * indicator beyond the tint. Each is a different kind of setting, which is
 * exactly why they read the same: none of them is the important one.
 */
function renderToggles(): HTMLElement {
  const strip = h("div", "toggles");
  const exc = selected();

  const add = (label: string, on: boolean, title: string, onClick: () => void) => {
    const btn = h("button", on ? "on" : undefined, label);
    btn.type = "button";
    btn.title = title;
    btn.setAttribute("aria-pressed", String(on));
    btn.addEventListener("click", () => {
      btn.blur(); // keys stay global; a focus ring here would eat Space
      onClick();
    });
    strip.append(btn);
  };

  // LOOP writes the excerpt's own `loop` field — authored config, so it
  // persists with the project. Esc's "loop off" is the live override and
  // deliberately does not touch this.
  add(
    "loop",
    exc?.loop ?? false,
    exc?.loop
      ? "this excerpt loops at the out point — click to play through instead"
      : "this excerpt plays through — click to loop it",
    () => toggleExcerptLoop(),
  );
  add(
    "pre-roll",
    S.preRollEnabled,
    "start a beat early when entering an excerpt",
    () => togglePreRoll(),
  );
  const seamless = S.engineKind === "worklet";
  add(
    "seamless",
    seamless,
    seamless
      ? "gapless loops, pitch held down to 0.50× — click for the basic engine"
      : "basic engine: a gap at the loop seam — click for seamless playback",
    () => void toggleEngine(),
  );
  return strip;
}

/**
 * Rate as a visible number, always (§8) — a readout, not a control.
 *
 * It briefly opened a ladder popover on click. Eleven rates in a menu is a
 * lot of surface for something `[` and `]` already do in one keystroke,
 * and this app's whole premise is not reaching for the mouse. The wheel
 * stays because it costs nothing and needs no chrome.
 */
function renderRate(): HTMLElement {
  const exc = selected();
  const figure = h("div", "rate-figure tnum", exc ? `${rateFor(exc).toFixed(2)}×` : "—");
  figure.title = "playback rate — [ and ] to change, \\ to reset, or scroll here";
  // passive:false because a wheel over the rate must nudge it rather than
  // scroll the excerpt row behind it
  figure.addEventListener(
    "wheel",
    (ev) => {
      if (!selected()) return;
      ev.preventDefault();
      rateStepIntent(ev.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  return figure;
}

function renderCard(e: Excerpt): HTMLElement {
  const card = h("button", "excerpt");
  card.type = "button";
  if (e.id === S.selectedId) card.classList.add("selected");

  const head = h("div", "excerpt-head");
  // The chip is the key you press. Excerpts without one are reachable by
  // prev/next, so the slot stays empty rather than inventing a number.
  head.append(h("span", "chip t-label", e.hotkey ? e.hotkey.toUpperCase() : ""));
  head.append(h("span", "title t-figure", e.title ?? e.label));
  // inline vs handle is a real distinction (§5) and must not be silent
  const modes = e.assets
    .map((use) => {
      const data = S.doc.assets[use.ref];
      return data ? `${use.role}: ${data.kind === "inline" ? "inline" : "file"}` : null;
    })
    .filter((s): s is string => s !== null);
  if (modes.length > 0) head.append(h("span", "assetchip t-label", modes.join("  ")));
  card.append(head);

  // locus and timecode on one line, joined by a middot
  const locus = h("div", "locus");
  locus.append(h("span", undefined, e.label));
  locus.append(h("span", "sep", "·"));
  locus.append(
    e.region
      ? h("span", "tnum", `${fmtTime(e.region.start)}–${fmtTime(e.region.end)}`)
      : h("span", "untimed", "untimed"),
  );
  // which recording this card plays — sources differ per excerpt now.
  // The label is the linked filename; a linked source without one (linked
  // by an older build, not yet self-healed by a load) falls back honestly.
  const src = sourceOf(e);
  if (!isLinked(src)) {
    locus.append(h("span", "sep", "·"));
    locus.append(h("span", "missing", "no recording"));
  }
  card.append(locus);

  if (S.note?.excerptId === e.id) card.append(h("div", "note", S.note.message));

  // action buttons: selected card only; mouse is allowed during setup (§10)
  if (e.id === S.selectedId) {
    const actions = h("div", "actions");
    for (const role of ["part", "score"] as const) {
      const btn = h(
        "button",
        undefined,
        `${e.assets.some((a) => a.role === role) ? "replace" : "attach"} ${role}`,
      );
      btn.type = "button";
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        attachImage(e, role);
      });
      actions.append(btn);
    }
    const edit = h("button", undefined, "edit");
    edit.type = "button";
    edit.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEditor(e.id);
    });
    actions.append(edit);
    card.append(actions);
  }

  card.addEventListener("click", () => {
    selectExcerpt(e);
    card.blur(); // keep keys global; focus ring here would eat Space
  });
  return card;
}

/**
 * The footnote strip (§3): transport state at the left, the newest global
 * message in the middle, the log count at the right. Clicking anywhere on
 * it opens the log — the whole strip is the affordance, so there is no
 * small target to hit.
 */
function renderFootnote(): HTMLElement {
  // The whole strip is clickable (§3), but the chips at the right are the
  // real buttons: nesting "clear" inside a strip that was itself
  // role="button" would have been two controls claiming one target. The
  // strip keeps the generous mouse hit area; the keyboard tabs to the
  // chips, which is where the focus ring belongs.
  const strip = h("div", "footnote");

  const { word, running } = transportState();
  strip.append(h("span", `dot${running ? " running" : ""}`));
  strip.append(h("span", `state t-label${running ? " running" : ""}`, word));
  strip.append(h("span", "rule"));

  const fresh = S.message === paintedMessage ? "" : " fresh";
  paintedMessage = S.message;
  strip.append(
    h("span", `stamp t-label tnum${fresh}`, S.messageAt === null ? "" : fmtStamp(S.messageAt)),
  );
  strip.append(h("span", `msg${fresh}${S.messageIsError ? " error" : ""}`, S.message));

  const chip = (className: string, label: string, title: string, onClick: () => void) => {
    const btn = h("button", `${className} t-label`, label);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation(); // the strip behind would toggle the log back
      btn.blur(); // keys stay global; a focus ring here would eat Space
      onClick();
    });
    return btn;
  };

  // Only offered with the log in front of you: a clear button on a closed
  // strip is a button for deleting something you cannot see.
  if (S.logOpen && S.log.length > 0) {
    strip.append(chip("logclear", "clear", "discard the session log", clearLog));
  }
  strip.append(
    chip(
      `logcount${S.logOpen ? " open" : ""}`,
      S.logOpen ? "close log" : `log · ${S.unseen}`,
      S.logOpen ? "close the log" : "session log",
      toggleLog,
    ),
  );

  strip.addEventListener("click", () => toggleLog());
  return strip;
}

function renderLogPanel(): HTMLElement {
  const panel = h("div", "logpanel");
  if (S.log.length === 0) {
    panel.append(h("div", "logempty", "nothing logged yet"));
    return panel;
  }
  // newest first: the thing you just did is the thing you came to read
  for (let i = S.log.length - 1; i >= 0; i--) {
    const entry = S.log[i]!;
    const rowEl = h("div", `logrow${i === S.log.length - 1 ? " newest" : ""}`);
    rowEl.append(h("span", "stamp t-label tnum", fmtStamp(entry.at)));
    rowEl.append(h("span", "msg", entry.message));
    panel.append(rowEl);
  }
  return panel;
}

/**
 * The keymap legend, built from core's KEYMAP_HELP rather than a copy kept
 * here — a legend that drifts from the keymap is worse than none, and a
 * test in core/ fails the build if the two disagree.
 */
/**
 * The corner "×". Absolutely placed so it costs the dialog no layout, and
 * it goes in first: with Escape and the backdrop already closing these, it
 * is the affordance for people who look for one rather than a new rule to
 * learn, so it should never be what the eye lands on.
 */
function closeButton(modal: HTMLElement, onClose: () => void): void {
  const btn = h("button", "modal-close", "×");
  btn.type = "button";
  btn.setAttribute("aria-label", "close");
  btn.addEventListener("click", () => {
    btn.blur(); // keys stay global; a focus ring here would eat Space
    onClose();
  });
  modal.append(btn);
}

function renderHelpModal(): void {
  const backdrop = h("div", "modal-backdrop");
  const modal = h("div", "modal help");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Keyboard shortcuts");
  closeButton(modal, toggleHelp);
  modal.append(h("div", "modal-title", "Keys"));

  const list = h("div", "keylist");
  for (const row of KEYMAP_HELP) {
    list.append(h("kbd", undefined, row.keys));
    list.append(h("span", undefined, row.description));
  }
  modal.append(list);
  modal.append(h("div", "modal-hint", "Esc to close"));

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) toggleHelp();
  });
  backdrop.append(modal);
  app.append(backdrop);
}

function renderLibraryModal(): void {
  const backdrop = h("div", "modal-backdrop");
  const modal = h("div", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Projects");
  closeButton(modal, closeDialogs);
  modal.append(h("div", "modal-title", "Projects"));

  const list = h("div", "projlist");
  for (const p of S.projectList) {
    const row = h("button", `projrow${p.id === S.doc.id ? " active" : ""}`);
    row.type = "button";
    row.append(h("span", "projrow-name", p.name));
    row.append(
      h("span", "projrow-count", `${p.excerptCount} excerpt${p.excerptCount === 1 ? "" : "s"}`),
    );
    row.addEventListener("click", () => void switchProject(p.id));
    list.append(row);
  }
  if (S.projectList.length === 0) list.append(h("div", "modal-hint", "loading…"));
  modal.append(list);

  const form = h("form", "newproj");
  const nameInput = h("input");
  nameInput.type = "text";
  nameInput.placeholder = "new project name";
  nameInput.setAttribute("aria-label", "New project name");
  const createBtn = h("button", "browse", "create");
  createBtn.type = "submit";
  form.append(nameInput, createBtn);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void createProject(nameInput.value);
  });
  modal.append(form);

  const actions = h("div", "modal-actions");
  const exportBtn = h("button", "browse", "export .json");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", () => exportProjectFlow());
  const importBtn = h("button", "browse", "import .json");
  importBtn.type = "button";
  importBtn.addEventListener("click", () => void importProjectFlow());
  const delBtn = h(
    "button",
    "browse danger",
    S.confirmProjectDelete ? "really delete? click again" : "delete this project",
  );
  delBtn.type = "button";
  delBtn.addEventListener("click", () => {
    if (S.confirmProjectDelete) void deleteActiveProject();
    else {
      S.confirmProjectDelete = true;
      render();
    }
  });
  actions.append(exportBtn, importBtn, delBtn);
  modal.append(actions);
  modal.append(h("div", "modal-hint", "Esc to close — export is the backup: keep those files somewhere safe"));

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) closeDialogs();
  });
  backdrop.append(modal);
  app.append(backdrop);
}

function renderEditorModal(): void {
  const editing = S.doc.excerpts.find((e) => e.id === S.editor.excerptId) ?? null;
  const backdrop = h("div", "modal-backdrop");
  const modal = h("div", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", editing ? "Edit excerpt" : "New excerpt");
  closeButton(modal, closeDialogs);
  modal.append(h("div", "modal-title", editing ? "Edit excerpt" : "New excerpt"));

  const form = h("form", "excform");
  const field = (labelText: string, value: string, placeholder: string): HTMLInputElement => {
    const wrap = h("label", "excfield");
    wrap.append(h("span", undefined, labelText));
    const input = h("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    wrap.append(input);
    form.append(wrap);
    return input;
  };
  // Title first: it is what the excerpt card shows and what you reach for
  // during practice. `field` appends in call order, so this is the order.
  const titleIn = field("title", editing?.title ?? "", "IV/2");
  const labelIn = field("label", editing?.label ?? "", "Mvt IV — Fig 2, mm. 6–12");
  const hotkeyIn = field(
    "hotkey",
    editing?.hotkey ?? nextFreeHotkey(S.doc.excerpts) ?? "",
    "one key, e.g. 4",
  );
  hotkeyIn.maxLength = 1;

  const errEl = h("div", "form-error", "");
  form.append(errEl);

  const actions = h("div", "modal-actions");
  const saveBtn = h("button", "browse", editing ? "save" : "add excerpt");
  saveBtn.type = "submit";
  actions.append(saveBtn);
  if (editing) {
    const delBtn = h(
      "button",
      "browse danger",
      S.confirmExcerptDelete ? "really delete? click again" : "delete excerpt",
    );
    delBtn.type = "button";
    delBtn.addEventListener("click", () => {
      if (S.confirmExcerptDelete) deleteExcerptFlow(editing.id);
      else {
        S.confirmExcerptDelete = true;
        delBtn.textContent = "really delete? click again"; // no render: keep the form intact
      }
    });
    actions.append(delBtn);
  }
  form.append(actions);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const err = saveExcerptFields(labelIn.value, titleIn.value, hotkeyIn.value);
    if (err) errEl.textContent = err; // leave the form as typed
  });
  modal.append(form);
  modal.append(h("div", "modal-hint", "Esc to cancel — timings are set later by tapping I/O during playback"));

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) closeDialogs();
  });
  backdrop.append(modal);
  app.append(backdrop);
  titleIn.focus(); // the top field, whichever one that is
}

function renderLinkModal(): void {
  const target = S.linkModal.target;
  const isAudio = target.kind === "audio";
  const backdrop = h("div", "modal-backdrop");
  const modal = h("div", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", isAudio ? "Link audio file" : `Attach ${target.kind === "image" ? target.role : ""} image`);
  closeButton(modal, closeLinkModal);

  modal.append(h("div", "modal-title", isAudio ? "Link recording" : `${target.role === "part" ? "Part" : "Score"} image`));
  modal.append(h("div", "modal-hint", S.linkModal.hint));

  const zone = h("div", "dropzone");
  zone.append(h("div", "dropzone-big", isAudio ? "drop a recording here" : "drop an image here"));
  zone.append(
    h(
      "div",
      "dropzone-small",
      isAudio
        ? "audio or video — or press Enter to browse — Esc to cancel"
        : "PNG, JPG, WebP, GIF, AVIF — or press Enter to browse — Esc to cancel",
    ),
  );
  zone.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    zone.classList.remove("over");
    if (!ev.dataTransfer) return;
    if (target.kind === "audio") void dropAudio(ev.dataTransfer, target.excerptId);
    else void dropImage(ev.dataTransfer, target.excerptId, target.role);
  });
  modal.append(zone);

  const browse = h("button", "browse", "browse files");
  browse.type = "button";
  browse.addEventListener("click", () => browseForTarget());
  modal.append(browse);

  // clicking the backdrop (not the modal) cancels — mouse parity with Esc
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) closeLinkModal();
  });

  backdrop.append(modal);
  app.append(backdrop);
}

function renderStatus(): void {
  // cheap refresh of the chrome without touching the image
  const scroll = app.querySelector(".excerpts")?.scrollLeft ?? 0;
  render();
  const rowEl = app.querySelector(".excerpts");
  if (rowEl) rowEl.scrollLeft = scroll;
}

async function renderImage(): Promise<void> {
  const stage = app.querySelector(".stage");
  if (!stage) return;
  const exc = selected();
  stage.textContent = "";
  if (!exc) {
    stage.append(h("div", "placeholder", "select an excerpt"));
    return;
  }
  const use = exc.assets.find((a) => a.role === S.imageRole) ?? exc.assets[0];
  const data = use ? S.doc.assets[use.ref] : undefined;
  if (!use || !data) {
    stage.append(
      h("div", "placeholder", `no ${S.imageRole} image yet — attach one on the excerpt card below`),
    );
    return;
  }
  const url = await resolveAssetUrl(data);
  if (!url) {
    stage.append(h("div", "placeholder", `${S.imageRole} image is file-backed and unavailable — re-attach it`));
    return;
  }
  const img = h("img");
  img.src = url;
  img.alt = `${exc.label} — ${use.role}`;
  stage.append(img);
}

function attachImage(exc: Excerpt, role: "part" | "score"): void {
  const replacing = exc.assets.some((a) => a.role === role);
  openLinkModal(
    `${replacing ? "replace the" : "attach a"} ${role} image for "${exc.title ?? exc.label}"`,
    { kind: "image", excerptId: exc.id, role },
  );
}

/**
 * The header carries no status text and the footnote strip's contents are
 * fixed (§3, §3c), so the running timecode has no home in the chrome any
 * more. The region strip is the position readout now — full width, legible
 * from three feet, and it says the one thing that matters mid-passage:
 * where you are between the in and out points.
 */
function onTick(pos: number): void {
  waveform?.tick();
  if (!fillEl) return;
  const exc = selected();
  if (exc?.region) {
    const { start, end } = exc.region;
    const frac = (pos - start) / (end - start);
    regionBarEl.classList.toggle("preroll", pos < start);
    fillEl.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
  } else {
    fillEl.style.width = "0";
  }
}

// ---------- input ----------

function onKeydown(ev: KeyboardEvent): void {
  // The arming keystroke is swallowed whole: it only supplies the user
  // gesture the AudioContext needs (§11), so it must not also mean
  // something. preventDefault stops Space scrolling the page on the way.
  if (!armed) {
    ev.preventDefault();
    if (ev.repeat) return;
    armApp();
    return;
  }
  // The legend has no input to type into, so like the link modal it
  // swallows everything — reading the keys shouldn't be able to start
  // playback underneath. Escape closes it; nothing opens it from the
  // keyboard (see the keymap: the status-bar button is the only way in).
  if (S.helpOpen) {
    ev.preventDefault();
    if (ev.repeat) return;
    if (ev.key === "Escape") toggleHelp();
    return;
  }
  // The link modal owns the keyboard while open: Enter/B browse, Esc/L
  // close. Everything else is swallowed so Space can't start playback
  // underneath a dialog.
  if (S.linkModal.open) {
    ev.preventDefault();
    if (ev.repeat) return;
    const k = ev.key.toLowerCase();
    if (k === "enter" || k === "b") browseForTarget();
    else if (k === "escape" || k === "l") closeLinkModal();
    return;
  }
  // Library/editor dialogs contain text inputs, so unlike the link modal
  // they swallow nothing: keys type normally, Enter submits the form,
  // Escape closes. Returning before resolveIntent keeps Space/I/O/etc.
  // from triggering playback underneath.
  if (S.libraryOpen || S.editor.open) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeDialogs();
    }
    return;
  }
  // The log panel is dismissed before the keymap sees Escape — otherwise
  // closing it would also stop the loop.
  if (ev.key === "Escape" && S.logOpen) {
    ev.preventDefault();
    S.logOpen = false;
    render();
    return;
  }
  // any focused text input owns its keys (inline rename stops propagation
  // itself; this catches every current and future input outside a dialog)
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
  const hotkeys = new Set(
    S.doc.excerpts.flatMap((e) => (e.hotkey ? [e.hotkey.toLowerCase()] : [])),
  );
  const intent = resolveIntent(
    { key: ev.key, shiftKey: ev.shiftKey, altKey: ev.altKey },
    hotkeys,
  );
  if (!intent) return;
  ev.preventDefault();
  // held-key repeat is wanted for nudging/rate, wrong for everything else
  if (ev.repeat && intent.type !== "nudge" && intent.type !== "rateStep") return;

  switch (intent.type) {
    case "togglePlay": void togglePlay(); break;
    case "stopLoop": stopLoop(false); break;
    case "rateStep": rateStepIntent(intent.dir); break;
    case "rateReset": rateReset(); break;
    case "nudge": nudge(intent.edge, intent.dir, intent.coarse); break;
    case "tap": tap(intent.edge); break;
    case "toggleImage": toggleImage(); break;
    case "togglePreRoll": togglePreRoll(); break;
    case "toggleWaveform": toggleWaveform(); break;
    case "zoom": zoomIntent(intent.dir); break;
    case "triggerExcerpt": triggerExcerpt(intent.hotkey); break;
    case "prevExcerpt": stepSelection(-1); break;
    case "nextExcerpt": stepSelection(1); break;
    case "linkAudio": {
      const exc = selected();
      if (!exc) break;
      const name = exc.title ?? exc.label;
      openLinkModal(
        isLinked(sourceOf(exc))
          ? `replace the recording for "${name}"`
          : `link a recording for "${name}"`,
        { kind: "audio", excerptId: exc.id },
      );
      break;
    }
  }
}

// ---------- boot ----------

async function boot(): Promise<void> {
  // Sequenced, not parallel: loadOrSeedProject writes activeProjectId on
  // first run, and a stale parallel read here would later persist null and
  // re-seed (destroying regions) on the next launch.
  const doc = await loadOrSeedProject();
  const appState = await loadAppState();
  const selectedId =
    doc.excerpts.find((e) => e.id === appState.selectedExcerptId)?.id ??
    doc.excerpts[0]?.id ??
    null;
  const selectedExc = doc.excerpts.find((e) => e.id === selectedId);
  S = {
    doc,
    app: appState,
    ctx: null,
    engines: new Map(),
    engine: null,
    // The preference, until arming proves what this browser can actually
    // give us. Rendering it now keeps the badge from flipping on arm.
    engineKind: appState.engine ?? "worklet",
    duration: doc.sources.find((s) => s.id === selectedExc?.sourceId)?.duration ?? null,
    loadedSourceId: null,
    files: new Map(),
    selectedId,
    loopingId: null,
    draftStart: null,
    preRollEnabled: true,
    imageRole: "part",
    message: "",
    messageIsError: false,
    messageAt: null,
    note: null,
    log: [],
    logOpen: false,
    unseen: 0,
    linkModal: { open: false, hint: "", target: { kind: "audio", excerptId: "" } },
    libraryOpen: false,
    projectList: [],
    editor: { open: false, excerptId: null },
    confirmProjectDelete: false,
    confirmExcerptDelete: false,
    waveformOpen: false,
    peaks: null,
    peaksSourceId: null,
    peaksStatus: "",
    view: null,
    helpOpen: false,
  };

  // A drop that misses the dropzone must not navigate the page away from
  // the app (the browser's default is to open the file).
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());

  // Click-outside closes the log. This runs after the strip's own handler
  // has already re-rendered, so the target is detached — but its ancestors
  // come with it, and closest() still answers correctly.
  window.addEventListener("click", (ev) => {
    if (!S.logOpen) return;
    const el = ev.target instanceof Element ? ev.target : null;
    if (el?.closest(".footnote, .logpanel")) return;
    S.logOpen = false;
    render();
  });

  document.title = APP_NAME; // config wins over the index.html fallback

  // One gesture arms everything: AudioContext + file permission (§11).
  const overlay = h("div", "overlay");
  overlay.append(h("div", "wordmark", APP_NAME));
  overlay.append(h("div", "hint", "press any key to begin"));
  document.body.append(overlay);
  armOverlay = overlay;
  overlay.addEventListener("click", armApp);

  // A single keydown listener for the whole app's life, gated on `armed`.
  // The previous shape registered this one from inside a capture-phase arm
  // handler, so the arming keystroke bubbled straight back into it — Space
  // armed the app and started playback in the same press.
  window.addEventListener("keydown", onKeydown);
}

void boot();

// Dev-only introspection for scripted E2E checks; stripped from prod builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>)["__looper"] = {
    pos: () => S.engine?.getPosition() ?? null,
    state: () => ({
      projectId: S.doc.id,
      selectedId: S.selectedId,
      loopingId: S.loopingId,
      loadedSourceId: S.loadedSourceId,
      duration: S.duration,
      engine: S.engineKind,
      paused: S.engine?.paused ?? null,
      region: S.doc.excerpts.find((e) => e.id === S.selectedId)?.region ?? null,
      waveformOpen: S.waveformOpen,
      view: S.view,
      peakBuckets: S.peaks?.min.length ?? null,
    }),
  };
}
