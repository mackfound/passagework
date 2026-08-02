/**
 * Generate the favicon set from one description of the mark.
 *
 * The mark is an end-repeat sign — dots, thin barline, thick barline —
 * because that is the notation for the thing this app does, and a
 * musician reads it without translating. Gold figure on the app's own
 * dark ground rather than a bare glyph on transparency: --gold against
 * Chrome's light tab strip measures 2.0:1, below even the 3:1 floor for
 * non-text graphics, where against --bg it is 9.2:1. Carrying its own
 * ground also means one drawing works in both tab strips, on the
 * bookmarks bar, and on an iOS home screen, where transparency would
 * composite onto the wallpaper.
 *
 * Everything below is drawn in a 32-unit square and scaled, so 1 unit is
 * half a pixel at the size that actually matters.
 *
 * No rasteriser is assumed to be installed, and none is worth a
 * dependency for five shapes. The PNG and ICO writers below are the
 * whole of it, on node:zlib alone.
 *
 *   node tools/make-icons.mjs     (or: npm run icons)
 *
 * Outputs are committed. Re-run only when the mark changes.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const OUT = fileURLToPath(new URL("../public/", import.meta.url));

const BG = [0x14, 0x13, 0x10]; // --bg
const INK = [0xe1, 0xad, 0x66]; // --gold

/**
 * Engraved thick:thin is about 3:1. Held to that here, the thin barline
 * lands under one pixel at 16px and renders as a grey smear rather than
 * a line, so it is opened out to roughly 2:1 — still legibly a pair of
 * unequal bars, but with both above the pixel floor.
 *
 * The gap between the bars is then set wider than the thin bar itself.
 * That gap is the only thing telling a reader there are two bars at all;
 * lose it and the pair fuses into one fat blot.
 */
const DOT = { cx: 7.7, r: 3.35, cy: [11.2, 20.8] };
const THIN = { x: 15.1, w: 3.1 };
const THICK = { x: 21.4, w: 6.3 };
const BAR = { y: 3.6, h: 24.8 };

/** 2px at the 16px size, matching every other radius in the app. */
const TILE_RADIUS = 4;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="${TILE_RADIUS}" fill="#141310"/>
  <g fill="#e1ad66">
    <circle cx="${DOT.cx}" cy="${DOT.cy[0]}" r="${DOT.r}"/>
    <circle cx="${DOT.cx}" cy="${DOT.cy[1]}" r="${DOT.r}"/>
    <rect x="${THIN.x}" y="${BAR.y}" width="${THIN.w}" height="${BAR.h}"/>
    <rect x="${THICK.x}" y="${BAR.y}" width="${THICK.w}" height="${BAR.h}"/>
  </g>
</svg>
`;

// ---------- geometry ----------

function inTile(x, y, r) {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  if (r <= 0) return true;
  // Clamp into the rectangle the corner arcs are centred on; only the
  // four corners can then fall outside.
  const dx = x - Math.min(Math.max(x, r), 32 - r);
  const dy = y - Math.min(Math.max(y, r), 32 - r);
  return dx * dx + dy * dy <= r * r;
}

function inGlyph(x, y) {
  for (const cy of DOT.cy) {
    const dx = x - DOT.cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= DOT.r * DOT.r) return true;
  }
  if (y < BAR.y || y > BAR.y + BAR.h) return false;
  return (
    (x >= THIN.x && x <= THIN.x + THIN.w) ||
    (x >= THICK.x && x <= THICK.x + THICK.w)
  );
}

/**
 * Analytic coverage by supersampling: 16 samples a pixel is plenty for
 * shapes this simple, and it antialiases the dots and the tile corners
 * without anything resembling a scanline renderer.
 */
function rasterize(size, radius) {
  const N = 4;
  const scale = size / 32;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let ink = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const u = (x + (sx + 0.5) / N) / scale;
          const v = (y + (sy + 0.5) / N) / scale;
          if (inTile(u, v, radius)) tile++;
          if (inGlyph(u, v)) ink++;
        }
      }
      const a = tile / (N * N);
      if (a === 0) continue;
      // The glyph never leaves the tile, so ink coverage is bounded by
      // it; compose in premultiplied space and divide back out.
      const i = Math.min(ink / (N * N), a);
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round((INK[c] * i + BG[c] * (a - i)) / a);
      }
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// ---------- containers ----------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, sum]);
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none. These images are tiny.
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG-encoded entries, which every browser has read for over a decade. */
function ico(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(([size, data], n) => {
    const e = 6 + n * 16;
    dir[e] = size >= 256 ? 0 : size; // 0 encodes 256
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...entries.map(([, data]) => data)]);
}

// ---------- emit ----------

const wrote = [];
function write(name, data) {
  writeFileSync(OUT + name, data);
  wrote.push(`${name}  ${data.length} bytes`);
}

write("favicon.svg", SVG);

write(
  "favicon.ico",
  ico([16, 32, 48].map((s) => [s, png(s, rasterize(s, TILE_RADIUS))])),
);

// Square and opaque to the edge: iOS applies its own rounded mask, and
// rounding it here would show as a light fringe inside that mask.
write("apple-touch-icon.png", png(180, rasterize(180, 0)));

console.log(wrote.join("\n"));
