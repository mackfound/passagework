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
  RATE_MAX,
  SEED_SOURCE_ID,
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
  loadOrSeedProject,
  loadAppState,
  pickAudioFile,
  pickImage,
  resolveAssetUrl,
  resolveAudio,
  saveAppState,
  saveProject,
} from "../storage";
import "./style.css";

const AUDIO_HANDLE_KEY = "handle_main";

// ---------- state ----------

interface UiState {
  doc: ProjectDoc;
  app: AppState;
  engine: MediaElementEngine | null;
  duration: number | null;
  audioReady: boolean;
  selectedId: string | null;
  loopingId: string | null;
  draftStart: number | null; // tap-in awaiting its tap-out
  preRollEnabled: boolean;
  imageRole: "part" | "score";
  message: string;
  messageIsError: boolean;
}

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
  startLoop(exc);
}

function selectExcerpt(exc: Excerpt): void {
  S.selectedId = exc.id;
  S.draftStart = null;
  S.imageRole = exc.assets.some((a) => a.role === "part") ? "part" : "score";
  S.engine?.setRate(rateFor(exc));
  void renderImage();
  render();
}

function startLoop(exc: Excerpt): void {
  if (!S.engine || !S.audioReady) {
    say("no audio linked — press L to link the recording", true);
    return;
  }
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
  say("");
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

function togglePlay(): void {
  if (!S.engine || !S.audioReady) {
    say("no audio linked — press L to link the recording", true);
    return;
  }
  if (S.engine.paused) S.engine.play();
  else S.engine.pause();
  renderStatus();
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
  if (!exc || !S.engine || !S.audioReady) return;
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

function nudge(edge: "start" | "end", dir: 1 | -1): void {
  const exc = selected();
  if (!exc?.region) return;
  const next = nudgeRegion(exc.region, edge, dir, S.duration);
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
  if (next.region) startLoop(next); // pedal flow: next excerpt starts looping
}

async function linkAudio(): Promise<void> {
  const picked = await pickAudioFile(AUDIO_HANDLE_KEY);
  if (!picked) return;
  const source = S.doc.sources.find((s) => s.id === SEED_SOURCE_ID) ?? S.doc.sources[0];
  if (!source) return;
  source.fileRef = picked.ref;
  await loadIntoEngine(picked.file, source.id);
  persistDoc();
  say(`linked: ${picked.file.name}`);
  render();
}

// ---------- audio boot ----------

async function loadIntoEngine(file: File, sourceId: string): Promise<void> {
  if (!S.engine) return;
  const loaded = await S.engine.load({ id: sourceId, file });
  S.duration = loaded.duration;
  S.audioReady = true;
  const source = S.doc.sources.find((s) => s.id === sourceId);
  if (source && source.duration !== loaded.duration) {
    source.duration = loaded.duration;
    persistDoc();
  }
}

/** Runs inside the arm gesture: AudioContext resume + handle permission in one go (§11). */
async function armAudio(): Promise<void> {
  const ctx = new AudioContext();
  await ctx.resume();
  S.engine = new MediaElementEngine(ctx);
  S.engine.onTick(onTick);

  const source = S.doc.sources[0];
  if (!source) return;
  const resolved = await resolveAudio(source.fileRef);
  if (resolved.ok) {
    await loadIntoEngine(resolved.file, source.id);
    say(`audio ready: ${resolved.file.name}`);
  } else {
    const why = {
      "no-handle": "no recording linked yet",
      "permission-denied": "permission to the recording was denied",
      "file-missing": "the recording moved or was deleted",
    }[resolved.reason];
    say(`${why} — press L to link it`, true);
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
          void attachImage(e, role);
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

async function attachImage(exc: Excerpt, role: "part" | "score"): Promise<void> {
  const assetId = `img_${exc.id}_${role}`;
  const data = await pickImage(assetId);
  if (!data) return;
  S.doc.assets[assetId] = data;
  const existing = exc.assets.find((a) => a.role === role);
  if (existing) existing.ref = assetId;
  else exc.assets.push({ type: "image", role, ref: assetId });
  persistDoc();
  S.imageRole = role;
  render();
  void renderImage();
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
  const hotkeys = new Set(
    S.doc.excerpts.flatMap((e) => (e.hotkey ? [e.hotkey.toLowerCase()] : [])),
  );
  const intent = resolveIntent({ key: ev.key, shiftKey: ev.shiftKey }, hotkeys);
  if (!intent) return;
  ev.preventDefault();
  // held-key repeat is wanted for nudging/rate, wrong for everything else
  if (ev.repeat && intent.type !== "nudge" && intent.type !== "rateStep") return;

  switch (intent.type) {
    case "togglePlay": togglePlay(); break;
    case "stopLoop": stopLoop(false); break;
    case "rateStep": rateStepIntent(intent.dir); break;
    case "rateReset": rateReset(); break;
    case "nudge": nudge(intent.edge, intent.dir); break;
    case "tap": tap(intent.edge); break;
    case "toggleImage": toggleImage(); break;
    case "togglePreRoll": togglePreRoll(); break;
    case "triggerExcerpt": triggerExcerpt(intent.hotkey); break;
    case "prevExcerpt": stepSelection(-1); break;
    case "nextExcerpt": stepSelection(1); break;
    case "linkAudio": void linkAudio(); break;
  }
}

// ---------- boot ----------

async function boot(): Promise<void> {
  // Sequenced, not parallel: loadOrSeedProject writes activeProjectId on
  // first run, and a stale parallel read here would later persist null and
  // re-seed (destroying regions) on the next launch.
  const doc = await loadOrSeedProject();
  const appState = await loadAppState();
  S = {
    doc,
    app: appState,
    engine: null,
    duration: doc.sources[0]?.duration ?? null,
    audioReady: false,
    selectedId: doc.excerpts[0]?.id ?? null,
    loopingId: null,
    draftStart: null,
    preRollEnabled: true,
    imageRole: "part",
    message: "",
    messageIsError: false,
  };

  // One gesture arms everything: AudioContext + file permission (§11).
  const overlay = h("div", "overlay");
  overlay.append(h("div", undefined, "Excerpt Looper"));
  overlay.append(h("div", "hint", "press any key to begin"));
  document.body.append(overlay);

  const arm = () => {
    window.removeEventListener("keydown", arm, true);
    overlay.removeEventListener("click", arm);
    overlay.remove();
    render();
    void armAudio().then(() => render());
    window.addEventListener("keydown", onKeydown);
  };
  window.addEventListener("keydown", arm, true);
  overlay.addEventListener("click", arm);
}

void boot();
