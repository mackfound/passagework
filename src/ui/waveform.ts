/**
 * Waveform authoring panel (spec §6, M3).
 *
 * Drawing and pointer handling only. Every time/pixel calculation it needs
 * comes from core/peaks — this file owns no arithmetic worth testing, which
 * is the point: the part that could be wrong is unit-tested in core, and the
 * part that can only be judged by eye is verified by looking at it (§9).
 *
 * Two stacked canvases. The peaks layer is expensive and static, redrawn
 * only when the envelope or view changes; the overlay carries the region
 * shading, its handles, and the playhead, and is cheap enough to repaint on
 * every tick. One canvas would mean re-rendering the whole envelope 60×/s.
 */

import {
  type PeakEnvelope,
  type Region,
  type Seconds,
  type ViewWindow,
  MIN_REGION,
  normalizeRegion,
  quantize,
  sampleWindow,
  timeToX,
  xToTime,
  zoomView,
} from "../core";

/** Pointer must land within this many px of an edge to grab it. */
const HANDLE_GRAB_PX = 7;

/** Below this much movement a press is a click (seek), not a drag (region). */
const DRAG_SLOP_PX = 3;

export interface WaveformDeps {
  /** null while decoding or after a failure; `status` says which. */
  env: PeakEnvelope | null;
  status: string;
  region: Region | null;
  view: ViewWindow;
  duration: Seconds;
  /** Live playhead position, read per frame rather than pushed. */
  position: () => Seconds;
  /** Fires continuously during a drag — cheap, must not persist. */
  onRegionDraft: (region: Region) => void;
  /** Fires once on release — the point at which the doc is written. */
  onRegionCommit: (region: Region) => void;
  onSeek: (t: Seconds) => void;
  onView: (view: ViewWindow) => void;
}

export interface WaveformHandle {
  element: HTMLElement;
  /**
   * Call once after the element is in the document. A canvas is a replaced
   * element, so `inset: 0` does not stretch it — it keeps its intrinsic
   * 300×150 until sized in script, and it cannot be sized before layout.
   * Doing this on mount rather than waiting for rAF matters because rAF and
   * ResizeObserver are both frozen while the page isn't rendering (§11), and
   * an unsized canvas maps pointers against the wrong width.
   */
  mount: () => void;
  /** Repaint the overlay only. Safe to call at frame rate. */
  tick: () => void;
  dispose: () => void;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function createWaveform(deps: WaveformDeps): WaveformHandle {
  const root = document.createElement("div");
  root.className = "waveform";

  const peaksCanvas = document.createElement("canvas");
  peaksCanvas.className = "wf-peaks";
  const overlay = document.createElement("canvas");
  overlay.className = "wf-overlay";
  root.append(peaksCanvas, overlay);

  const hint = document.createElement("div");
  hint.className = "wf-hint";
  root.append(hint);

  // Mutable across pointer events and frames; deps.region is the authored
  // value, `draft` is what the pointer is currently proposing.
  let draft: Region | null = null;
  let width = 0;
  let height = 0;

  const regionNow = (): Region | null => draft ?? deps.region;

  function resize(): boolean {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(root.clientWidth));
    const h = Math.max(1, Math.floor(root.clientHeight));
    if (w === width && h === height) return false;
    width = w;
    height = h;
    for (const c of [peaksCanvas, overlay]) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return true;
  }

  /**
   * Re-measure before anything that depends on the width. Cheap (resize
   * returns early when nothing moved) and it is the only thing standing
   * between a missed frame callback and pointer coordinates computed
   * against a width the canvas no longer has.
   */
  function ensureSized(): void {
    if (resize()) drawPeaks();
  }

  function drawPeaks(): void {
    const ctx = peaksCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (!deps.env) {
      hint.textContent = deps.status;
      return;
    }
    hint.textContent = "";

    const mid = height / 2;
    const cols = sampleWindow(deps.env, deps.view, Math.floor(width));
    ctx.strokeStyle = cssVar(root, "--dim", "#9b9797");
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < cols.min.length; x++) {
      // +0.5 puts the 1px stroke on a device pixel instead of straddling two.
      const px = x + 0.5;
      const top = mid - cols.max[x]! * mid;
      const bottom = mid - cols.min[x]! * mid;
      ctx.moveTo(px, top);
      // A silent column would be a zero-length segment and vanish; give it
      // the centre line so silence reads as silence rather than as a gap.
      ctx.lineTo(px, Math.max(bottom, top + 1));
    }
    ctx.stroke();
  }

  function drawOverlay(): void {
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (!deps.env) return;

    const region = regionNow();
    if (region) {
      const x0 = timeToX(region.start, deps.view, width);
      const x1 = timeToX(region.end, deps.view, width);
      // Gold, not green: the region is authored config — the same thing the
      // selected card's border marks — and green is reserved for sound
      // actually moving, which here is the playhead below.
      const edge = cssVar(root, "--gold-edge", "#b68235");
      ctx.fillStyle = edge;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x0, 0, x1 - x0, height);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = edge;
      ctx.lineWidth = 2;
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        // Grab tabs, so the draggable edges are visible and not just felt.
        ctx.fillRect(x - 3, 0, 6, 7);
        ctx.fillRect(x - 3, height - 7, 6, 7);
      }
    }

    const pos = deps.position();
    if (pos >= deps.view.start && pos <= deps.view.end) {
      const x = timeToX(pos, deps.view, width);
      ctx.strokeStyle = cssVar(root, "--green", "#8ecf9e");
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  function redrawAll(): void {
    resize();
    drawPeaks();
    drawOverlay();
  }

  // ---------- pointer authoring ----------

  type Grab = { kind: "edge"; edge: "start" | "end" } | { kind: "new"; anchor: Seconds };
  let grab: Grab | null = null;
  let downX = 0;
  let moved = false;

  function timeAt(ev: PointerEvent): Seconds {
    const rect = overlay.getBoundingClientRect();
    return xToTime(ev.clientX - rect.left, deps.view, width);
  }

  overlay.addEventListener("pointerdown", (ev) => {
    if (!deps.env || ev.button !== 0) return;
    ensureSized();
    overlay.setPointerCapture(ev.pointerId);
    downX = ev.clientX;
    moved = false;
    const region = regionNow();
    const t = timeAt(ev);
    const rect = overlay.getBoundingClientRect();
    const px = ev.clientX - rect.left;

    if (region) {
      const dStart = Math.abs(px - timeToX(region.start, deps.view, width));
      const dEnd = Math.abs(px - timeToX(region.end, deps.view, width));
      if (Math.min(dStart, dEnd) <= HANDLE_GRAB_PX) {
        grab = { kind: "edge", edge: dStart <= dEnd ? "start" : "end" };
        return;
      }
    }
    grab = { kind: "new", anchor: t };
  });

  overlay.addEventListener("pointermove", (ev) => {
    if (!deps.env) return;
    ensureSized();
    if (!grab) {
      // Cursor affordance: only the edges are grabbable.
      const region = regionNow();
      const rect = overlay.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const near =
        region !== null &&
        Math.min(
          Math.abs(px - timeToX(region.start, deps.view, width)),
          Math.abs(px - timeToX(region.end, deps.view, width)),
        ) <= HANDLE_GRAB_PX;
      overlay.style.cursor = near ? "ew-resize" : "crosshair";
      return;
    }

    if (Math.abs(ev.clientX - downX) > DRAG_SLOP_PX) moved = true;
    if (!moved) return;

    const t = quantize(timeAt(ev));
    const region = regionNow();
    let next: Region | null = null;
    if (grab.kind === "edge" && region) {
      next =
        grab.edge === "start"
          ? normalizeRegion(t, region.end, deps.duration)
          : normalizeRegion(region.start, t, deps.duration);
    } else if (grab.kind === "new") {
      next = normalizeRegion(Math.min(grab.anchor, t), Math.max(grab.anchor, t), deps.duration);
    }
    // normalizeRegion returns null below MIN_REGION; hold the last good
    // draft rather than dropping the region mid-gesture.
    if (next) {
      draft = next;
      deps.onRegionDraft(next);
      drawOverlay();
    }
  });

  function endDrag(ev: PointerEvent): void {
    if (!grab) return;
    const wasNew = grab.kind === "new";
    const anchor = grab.kind === "new" ? grab.anchor : 0;
    grab = null;
    if (overlay.hasPointerCapture(ev.pointerId)) overlay.releasePointerCapture(ev.pointerId);

    if (!moved) {
      // A press that never moved is a seek, not a one-sample region.
      draft = null;
      if (wasNew) deps.onSeek(quantize(anchor));
      drawOverlay();
      return;
    }
    if (draft) {
      const committed = draft;
      draft = null;
      deps.onRegionCommit(committed);
    }
  }

  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  // Wheel zooms about the cursor: the gesture every waveform editor has, and
  // the only way to reach 10 ms precision inside a 70-minute recording.
  overlay.addEventListener(
    "wheel",
    (ev) => {
      if (!deps.env) return;
      ensureSized();
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 1.25 : 0.8;
      deps.onView(zoomView(deps.view, factor, timeAt(ev as unknown as PointerEvent), deps.duration));
    },
    { passive: false },
  );

  // Canvases have no intrinsic size until laid out; size on the next frame,
  // then follow the container (the excerpt row wraps at narrow widths).
  const ro = new ResizeObserver(() => redrawAll());
  ro.observe(root);
  requestAnimationFrame(redrawAll);

  return {
    element: root,
    mount: redrawAll,
    tick: () => {
      if (deps.env) drawOverlay();
    },
    dispose: () => ro.disconnect(),
  };
}

/** Shortest region the panel will author — mirrors core's floor. */
export { MIN_REGION };
