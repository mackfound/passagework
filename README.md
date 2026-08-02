# Passagework

Loop a short passage against its score, at any tempo, without letting go of your
instrument.

A browser-based tool for the part of practice that is just repetition: pick seven bars,
hear them on a real recording, slow them down, and loop them hands-free while you read the
music. It grew out of orchestral audition prep, but fits anything you'd practice against a
recording.

---

## Why it exists

A DAW loops a region perfectly and wants both hands and a mouse. A media player is one
keystroke away but won't loop fifteen bars, and its slow-down turns an orchestra to mud. A
metronome doesn't know the piece.

What's needed is narrower: a short passage on demand, at a tempo you choose, with the
notation in front of you, driven by one hand that keeps going back to the instrument. Open
it, hit one key, the passage loops.

## What it does

- **Excerpts, not tracks.** A project holds a handful of passages, each with its own in/out
  points, recording and key. Press `3` and bar 47 of the fourth movement loops. Press it
  again to stop.
- **Tap the loop while it plays.** `I` where the passage starts, `O` where it ends, then
  nudge either edge by 10 ms with the arrow keys. A waveform is there if you want it.
- **Slow down without the chipmunk.** 0.50× to 1.00× with the pitch held, and no gap at the
  loop point.
- **The score on screen.** Attach a part and a full score to each passage and flip between
  them with `Tab`. Pinch or use `−` / `=` to zoom. The image gets the whole window.
- **Pre-roll.** Entering a passage starts a beat or two early so you hear the approach.
  Loop wraps go to the loop point itself.

## No backend

The page is static. Recordings open through the file picker and decode in the tab, projects
live in IndexedDB on your disk, and score images are stored in the project or referenced
from a file you still own. No upload, no analytics, no font CDN — there is not a single
network call in the source:

```bash
grep -rn "fetch(\|XMLHttpRequest\|WebSocket\|sendBeacon" src/
```

Loading the page needs the network. Nothing after that does.

Projects are only as durable as the browser profile they live in. The app asks the browser
to treat its storage as persistent and says in the status bar when that is refused.
**Export to JSON** is the real backup: a small readable file of timings rather than audio,
which on re-import asks you to point at the recordings again.

## Getting started

**[passagework.us](https://passagework.us)** — nothing to install, nothing to sign into.
The opening screen waits for a keypress, since browsers only start audio from a real
gesture.

To run it yourself, with [Node](https://nodejs.org) 20.19+ or 22.12+:

```bash
git clone https://github.com/mackfound/passagework.git
```

```bash
cd passagework && npm install && npm run dev
```

`npm run build` type-checks and writes a static `dist/`. Every URL it emits is relative, so
the same build works at a domain root or in any subdirectory.

Built for Chromium desktop. Firefox and Safari run it, but without the File System Access
API a linked recording has to be re-selected each session.

## Setting up a passage

1. Open the project menu (the chevron beside the name) and make a project, or use the one
   that ships with it.
2. Press **`+ excerpt`**, give it a name and a key.
3. Press **`L`** and point it at a recording, or drag one in from Finder for a durable link
   rather than a filename to guess at later.
4. Press its key to play, then **`I`** and **`O`** to tap the loop's edges as they go past.
5. Use **replace part** / **replace score** on the card to attach images.

After that you shouldn't need the mouse again.

## Keyboard

| Key | What it does |
| --- | --- |
| `1` – `9` | loop that excerpt — press again to stop |
| `Space` | play / pause |
| `Esc` | drop the loop, keep playing |
| `PgUp` / `PgDn` | previous / next excerpt (these are what page-turner pedals emit) |
| `I` / `O` | tap the loop in / out point while playing |
| `←` / `→` | nudge the loop start by 10 ms |
| `Shift` + `←` / `→` | nudge the loop end instead |
| `Alt` + `←` / `→` | nudge by 500 ms instead of 10 ms |
| `[` / `]` | slower / faster |
| `\` | reset the rate |
| `P` | pre-roll on / off |
| `Tab` | switch between the part and score images |
| `W` | waveform: drag to set loop points, click to seek |
| `−` / `=` | zoom the score out / in — the waveform instead, while it's open |
| `L` | link or replace this excerpt's recording |

## How it's built

TypeScript and Vite, with **zero runtime dependencies** — `node_modules` holds the
compiler, the bundler and the test runner. Nothing ships to the browser that this repo
didn't write, including the time-stretcher and the favicon.

Four layers, with dependencies pointing inward only:

| Layer | What lives there |
| --- | --- |
| **`core/`** | Pure logic: loop arithmetic, the schema and its migrations, the WSOLA time-stretcher, the keymap. No DOM, no Web Audio, no imports from outside itself, enforced by a test that scans every import. Unit-tested in Node. |
| **`audio/`** | The only layer that knows what an `AudioContext` is. |
| **`storage/`** | IndexedDB, File System Access, JSON import/export. |
| **`ui/`** | Rendering and orchestration. Disposable by design; `core/` should survive a UI rewrite untouched. |

Two engines sit behind one `PlaybackEngine` interface, toggled live from the header:

- **basic** — an `<audio>` element with `preservesPitch`. Streams and starts instantly, but
  seeking a compressed file has latency, so the loop point hiccups.
- **seamless** — decodes to PCM and hands it to an `AudioWorklet` that time-stretches with
  WSOLA and wraps the loop on the audio thread. No seek, no hiccup, and the pitch holds
  down to 0.50×. Decoded stereo runs about 11 MB a minute, so recordings are held under a
  budget and released oldest-first.

Every keystroke resolves through one table in `core/intents.ts`. Nothing else has a
`keydown` handler, which is what makes a Bluetooth page-turner pedal a matter of adding
rows.

## Coming soon

- **Offline support, done properly.** The first attempt was a precaching service worker,
  withdrawn after it twice made the site unopenable.
- **Practice features** — metronome, count-in, tempo ladder, rep counting, session log. The
  schema has carried the fields since the first commit, so they arrive without a migration.
- **PDF scores** via pdf.js, with crop rectangles as asset metadata.
- **Foot pedal support** — `PgUp` / `PgDn` are already bound to previous / next excerpt,
  which is what pedals send.
- **Keyboard focus** — `Tab` is taken by the image toggle and needs to move.
- **Self-recording and A/B** against the reference at the same loop points.
- **A Content-Security-Policy**, so "no backend" is enforced rather than trusted.

## Fonts

Cormorant Garamond and Lora, vendored in `public/fonts/` rather than pulled from a CDN.
Both under the SIL Open Font License 1.1 — see
[`public/fonts/OFL.txt`](public/fonts/OFL.txt).

## License

MIT — see [LICENSE](LICENSE). The bundled fonts keep their own.
