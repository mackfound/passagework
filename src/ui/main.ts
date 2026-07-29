/**
 * ui/ — orchestration and rendering. Disposable by design (spec §3).
 *
 * Every keystroke routes through core's resolveIntent — no keydown logic
 * lives anywhere else (spec §7, pedal support depends on this).
 */

import {
  type AppState,
  type Excerpt,
  type ProjectDoc,
  type Source,
  GRID,
  NUDGE_COARSE,
  RATE_MAX,
  clampRate,
  entryPosition,
  normalizeRegion,
  nudgeRegion,
  quantize,
  resolveIntent,
  stepRate,
} from "../core";
import { MediaElementEngine } from "../audio/MediaElementEngine";
import {
  audioFromDataTransfer,
  deleteHandle,
  imageFromDataTransfer,
  loadOrSeedProject,
  loadAppState,
  pickAudio,
  pickImage,
  resolveAssetUrl,
  resolveAudio,
  saveAppState,
  saveHandle,
  saveProject,
} from "../storage";
import type { AssetData } from "../core";
import "./style.css";

function handleKeyFor(sourceId: string): string {
  return `handle_${sourceId}`;
}

// ---------- state ----------

interface UiState {
  doc: ProjectDoc;
  app: AppState;
  engine: MediaElementEngine | null;
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
  linkModal: { open: boolean; hint: string; target: LinkTarget };
}

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

function rateFor(exc: Excerpt): number {
  return clampRate(S.app.workingRates[exc.id] ?? exc.defaultRate);
}

function say(message: string, isError = false): void {
  S.message = message;
  S.messageIsError = isError;
  renderStatus();
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
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
  S.engine?.setRate(rateFor(exc));
  void renderImage();
  render();
}

async function startLoop(exc: Excerpt): Promise<void> {
  if (!S.engine) return;
  if (!(await ensureSourceLoaded(exc))) return;
  if (!exc.region) {
    S.loopingId = null;
    S.engine.setLoop(null);
    say(`"${exc.shortLabel ?? exc.label}" is untimed — Space to play, tap I / O to mark it`);
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
        "no-handle": `no recording linked for "${exc.shortLabel ?? exc.label}" yet`,
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

function rateStepIntent(dir: 1 | -1): void {
  const exc = selected();
  if (!exc) return;
  const next = stepRate(rateFor(exc), dir);
  S.app.workingRates[exc.id] = next; // sticky-persisted progress, not config (AppState)
  S.engine?.setRate(next);
  persistApp();
  renderStatus();
}

function rateReset(): void {
  const exc = selected();
  if (!exc) return;
  S.app.workingRates[exc.id] = RATE_MAX;
  S.engine?.setRate(RATE_MAX);
  persistApp();
  renderStatus();
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
        say(`in → ${fmtTime(pos)}`);
      } else {
        S.draftStart = pos; // tapped past the old end: treat as a fresh in-point
        exc.region = null;
        say(`in → ${fmtTime(pos)} — tap O to set the out point`);
      }
    } else {
      S.draftStart = pos;
      say(`in → ${fmtTime(pos)} — tap O to set the out point`);
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
    say(`region set: ${fmtTime(next.start)} – ${fmtTime(next.end)} — press ${exc.hotkey ?? "its key"} to loop`);
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
  say(`${edge} → ${fmtTime(edge === "start" ? next.start : next.end)}`);
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

  // prune sources no excerpt points at any more (and their stored handles)
  const used = new Set(S.doc.excerpts.map((e) => e.sourceId));
  for (const s of S.doc.sources) {
    if (!used.has(s.id) && s.fileRef.kind === "fsHandle") void deleteHandle(s.fileRef.key);
  }
  S.doc.sources = S.doc.sources.filter((s) => used.has(s.id));

  S.files.set(source.id, file);
  await loadIntoEngine(file, source.id);
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
    say(`linked to "${exc.shortLabel ?? exc.label}": ${file.name}`);
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
  say(`${role} image attached (${data.kind === "inline" ? "inline" : "file-backed"})`);
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

// ---------- audio boot ----------

async function loadIntoEngine(file: File, sourceId: string): Promise<void> {
  if (!S.engine) return;
  const loaded = await S.engine.load({ id: sourceId, file });
  S.duration = loaded.duration;
  S.loadedSourceId = sourceId;
  const source = S.doc.sources.find((s) => s.id === sourceId);
  if (source && source.duration !== loaded.duration) {
    source.duration = loaded.duration;
    persistDoc();
  }
}

/**
 * Runs inside the arm gesture: AudioContext resume + handle permission in
 * one go (§11). Only the selected excerpt's source is resolved here — the
 * rest load lazily on trigger, each inside its own keypress gesture.
 */
async function armAudio(): Promise<void> {
  const ctx = new AudioContext();
  await ctx.resume();
  S.engine = new MediaElementEngine(ctx);
  S.engine.onTick(onTick);

  const exc = selected();
  if (!exc) return;
  const source = sourceOf(exc);
  const resolved = source
    ? await resolveAudio(source.fileRef)
    : ({ ok: false, reason: "no-handle" } as const);
  if (resolved.ok) {
    S.files.set(exc.sourceId, resolved.file);
    await loadIntoEngine(resolved.file, exc.sourceId);
    say(`audio ready: ${resolved.file.name}`);
  } else {
    const why = {
      "no-handle": `no recording linked for "${exc.shortLabel ?? exc.label}" yet`,
      "permission-denied": "permission to the recording was denied",
      "file-missing": "the recording moved or was deleted",
    }[resolved.reason];
    say(`${why} — press L to link it`, true);
    openLinkModal(why, { kind: "audio", excerptId: exc.id });
  }
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

let posEl: HTMLElement;
let fillEl: HTMLElement;
let regionBarEl: HTMLElement;

function render(): void {
  app.textContent = "";

  // status bar
  const bar = h("div", "status");
  bar.append(h("span", "project", S.doc.name));
  const exc = selected();
  bar.append(h("span", "rate", exc ? `${rateFor(exc).toFixed(2)}×` : "—"));
  posEl = h("span", "pos");
  bar.append(posEl);
  const loopBadge = h("span", `badge${S.loopingId ? " on" : ""}`, "LOOP");
  const prBadge = h("span", `badge${S.preRollEnabled ? " on" : ""}`, "PRE-ROLL");
  bar.append(loopBadge, prBadge);
  const msg = h("span", `msg${S.messageIsError ? " error" : ""}`, S.message);
  bar.append(msg);
  app.append(bar);

  // stage
  const stage = h("div", "stage");
  stage.append(h("div", "placeholder", "no image for this excerpt yet"));
  app.append(stage);
  void renderImage();

  // region progress strip
  regionBarEl = h("div", "regionbar");
  fillEl = h("div", "fill");
  regionBarEl.append(fillEl);
  app.append(regionBarEl);

  // excerpt row
  const row = h("div", "excerpts");
  for (const e of S.doc.excerpts) {
    const card = h("button", "excerpt");
    card.type = "button";
    if (e.id === S.selectedId) card.classList.add("selected");
    if (e.id === S.loopingId) card.classList.add("looping");
    const top = h("div");
    if (e.hotkey) top.append(h("span", "key", e.hotkey.toUpperCase()));
    top.append(h("span", "short", e.shortLabel ?? e.label));
    card.append(top);
    const detail = h("div", "detail");
    detail.append(h("span", undefined, e.label));
    detail.append(
      e.region
        ? h("span", undefined, `${fmtTime(e.region.start)}–${fmtTime(e.region.end)}`)
        : h("span", "untimed", "untimed"),
    );
    // which recording this card plays — sources differ per excerpt now
    const src = sourceOf(e);
    detail.append(
      isLinked(src)
        ? h("span", "srcname", src!.label)
        : h("span", "srcname missing", "no recording"),
    );
    for (const use of e.assets) {
      const data = S.doc.assets[use.ref];
      if (data) detail.append(h("span", "assetmode", `${use.role}:${data.kind === "inline" ? "inline" : "file"}`));
    }
    card.append(detail);
    // attach buttons: selected card only; mouse is allowed during setup (§10)
    if (e.id === S.selectedId) {
      const attach = h("div", "attach");
      for (const role of ["part", "score"] as const) {
        const btn = h("button", undefined, `${e.assets.some((a) => a.role === role) ? "replace" : "attach"} ${role}`);
        btn.type = "button";
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          attachImage(e, role);
        });
        attach.append(btn);
      }
      card.append(attach);
    }
    card.addEventListener("click", () => {
      selectExcerpt(e);
      card.blur(); // keep keys global; focus ring here would eat Space
    });
    row.append(card);
  }
  app.append(row);

  if (S.linkModal.open) renderLinkModal();
}

function renderLinkModal(): void {
  const target = S.linkModal.target;
  const isAudio = target.kind === "audio";
  const backdrop = h("div", "modal-backdrop");
  const modal = h("div", "modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", isAudio ? "Link audio file" : `Attach ${target.kind === "image" ? target.role : ""} image`);

  modal.append(h("div", "modal-title", isAudio ? "Link recording" : `${target.role === "part" ? "Part" : "Score"} image`));
  modal.append(h("div", "modal-hint", S.linkModal.hint));

  const zone = h("div", "dropzone");
  zone.append(h("div", "dropzone-big", isAudio ? "drop an audio file here" : "drop an image here"));
  zone.append(
    h(
      "div",
      "dropzone-small",
      isAudio
        ? "or press Enter to browse — Esc to cancel"
        : "PNG, JPG, WebP — or press Enter to browse — Esc to cancel",
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
    `${replacing ? "replace the" : "attach a"} ${role} image for "${exc.shortLabel ?? exc.label}"`,
    { kind: "image", excerptId: exc.id, role },
  );
}

function onTick(pos: number): void {
  if (!posEl) return;
  const exc = selected();
  if (exc?.region) {
    posEl.textContent = `${fmtTime(pos)}  ·  ${fmtTime(exc.region.start)}–${fmtTime(exc.region.end)}`;
    const { start, end } = exc.region;
    const frac = (pos - start) / (end - start);
    regionBarEl.classList.toggle("preroll", pos < start);
    fillEl.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
  } else {
    posEl.textContent = fmtTime(pos);
    fillEl.style.width = "0";
  }
}

// ---------- input ----------

function onKeydown(ev: KeyboardEvent): void {
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
    case "triggerExcerpt": triggerExcerpt(intent.hotkey); break;
    case "prevExcerpt": stepSelection(-1); break;
    case "nextExcerpt": stepSelection(1); break;
    case "linkAudio": {
      const exc = selected();
      if (!exc) break;
      const name = exc.shortLabel ?? exc.label;
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
    engine: null,
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
    linkModal: { open: false, hint: "", target: { kind: "audio", excerptId: "" } },
  };

  // A drop that misses the dropzone must not navigate the page away from
  // the app (the browser's default is to open the file).
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", (ev) => ev.preventDefault());

  // One gesture arms everything: AudioContext + file permission (§11).
  const overlay = h("div", "overlay");
  overlay.append(h("div", undefined, "Excerpt Looper"));
  overlay.append(h("div", "hint", "press any key to begin"));
  document.body.append(overlay);

  // "Open the tool, hit one key, the passage loops" (§1): if the arming
  // keypress is an excerpt hotkey, trigger that excerpt once audio is up.
  const arm = (ev?: KeyboardEvent) => {
    window.removeEventListener("keydown", arm as EventListener, true);
    overlay.removeEventListener("click", arm as EventListener);
    overlay.remove();
    render();
    const armKey = ev instanceof KeyboardEvent ? ev.key.toLowerCase() : null;
    void armAudio().then(() => {
      render();
      // triggering handles its own source load (and link modal on failure)
      if (armKey && S.doc.excerpts.some((e) => e.hotkey === armKey)) {
        triggerExcerpt(armKey);
      }
    });
    window.addEventListener("keydown", onKeydown);
  };
  window.addEventListener("keydown", arm as EventListener, true);
  overlay.addEventListener("click", arm as EventListener);
}

void boot();

// Dev-only introspection for scripted E2E checks; stripped from prod builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>)["__looper"] = {
    pos: () => S.engine?.getPosition() ?? null,
    state: () => ({
      selectedId: S.selectedId,
      loopingId: S.loopingId,
      loadedSourceId: S.loadedSourceId,
      duration: S.duration,
      paused: S.engine?.paused ?? null,
    }),
  };
}
