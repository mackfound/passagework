# Passagework

Loop a short passage against its score, at any tempo, without letting go of your
instrument.

Passagework is a browser-based practice tool for the part of practice that is just
repetition: pick seven bars, hear them on a real recording, slow them down, and loop them
hands-free while you read the music. It grew out of orchestral audition prep, but the shape
fits anything you'd practice against a recording — concerto entrances, chamber parts, solo
repertoire, contemporary works with a fixed track.

---

## Why it exists

A DAW loops a region perfectly and wants both hands and a mouse. A media player is one
keystroke away but won't loop fifteen bars, and its slow-down turns an orchestra to mud. A
metronome doesn't know the piece.

What's actually needed is narrower: a short passage on demand, at a tempo you choose, with
the notation in front of you, driven by one hand that keeps going back to the instrument.
Open it, hit one key, the passage loops.

## What it does

- **Excerpts, not tracks.** A project holds a handful of passages, each with its own
  in/out points, its own recording, and its own key. Press `3`, and bar 47 of the fourth
  movement starts looping. Press it again to stop.
- **Tap the loop while it plays.** Hit `I` where the passage starts and `O` where it ends,
  then nudge either edge by 10 ms with the arrow keys. A waveform is there if you want it,
  but you never need it.
- **Slow down without the chipmunk.** 0.50× to 1.00× with the pitch held, and no gap at
  the loop point — the seam is stitched inside the audio thread rather than by seeking.
- **The score on screen.** Attach a part and a full score to each passage and flip between
  them with `Tab`. The image gets the whole window; everything else is a thin strip.
- **Zoom in on the page.** Pinch, drag to pan, or use the `−` / `=` keys, for when the
  stand is across the room rather than in front of you.
- **Pre-roll.** Entering a passage starts a beat or two early so you hear the approach.
  Loop wraps go to the loop point itself, not the pre-roll.
- **Works offline.** After one visit the whole app is cached on your machine. A practice
  room with no signal is the normal case, not an edge case.
- **Nothing to sign into.** No account, no sync, no telemetry.

## No backend

There isn't one. The page is static — your browser downloads some HTML, CSS and
JavaScript, and everything after that happens on your machine. Recordings open through the
file picker and decode in the tab, projects live in IndexedDB on your disk, and score
images are stored in the project or referenced from a file you still own. No upload, no
analytics, no font CDN: there is not a single network call in the application source, which
takes one line to check.

```bash
grep -rn "fetch(\|XMLHttpRequest\|WebSocket\|sendBeacon" src/
```

A service worker caches the app itself on first load, so it opens with no network after
that. It only ever holds files the build shipped — your audio never reaches it, since blob
URLs don't pass through a service worker at all.

Projects are only as durable as the browser profile they live in, so **Export to JSON** is
the real backup. It writes a small, readable, diffable file of timings rather than audio,
and re-importing it asks you to point at the recordings again.

## Getting started

### Use it in the browser

**[passagework.pages.dev](https://passagework.pages.dev)** — nothing to install, nothing to
sign into. Point it at a recording on your machine and start marking passages.

### Or run it yourself

Requires [Node](https://nodejs.org) 20.19+ or 22.12+.

```bash
git clone https://github.com/mackfound/passagework.git
```

```bash
cd passagework && npm install && npm run dev
```

`npm run build` type-checks and writes a static `dist/`. Every URL it emits is relative, so
the same build works at a domain root, at a GitHub Pages project path like `/passagework/`,
or in any subdirectory — there's nothing to configure per deploy. The build also generates
`dist/sw.js`, the offline cache, with that build's file list and a content hash baked in.

Built for Chromium desktop; Firefox and Safari run it, but without the File System Access
API a linked recording has to be re-selected each session.

## Setting up a passage

1. Open the project menu (the chevron beside the name) and make a project, or use the one
   that ships with it.
2. Press **`+ excerpt`**, give it a name and a key.
3. Press **`L`** and point it at a recording — or drag one in from Finder, which gives it a
   durable link rather than a filename to guess at later.
4. Press its key to start playing, then **`I`** and **`O`** to tap the loop's edges as they
   go past. **`←`/`→`** nudge the start by 10 ms, **`Shift`** for the end, **`Alt`** for
   half-second jumps.
5. Use **replace part** / **replace score** on the card to attach images.

After that, setup is over and you shouldn't need the mouse again.

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

TypeScript and Vite, with **zero runtime dependencies** — the only things in
`node_modules` are the compiler, the bundler and the test runner. Nothing ships to the
browser that this repo didn't write, including the time-stretcher.

Four layers, with dependencies pointing inward only:

| Layer | What lives there |
| --- | --- |
| **`core/`** | Pure logic. No DOM, no Web Audio, no imports from outside itself — enforced by a test that scans every import. Loop arithmetic, the schema and its migrations, the WSOLA time-stretcher, the keymap. All of it runs and is unit-tested in Node. |
| **`audio/`** | The only layer that knows what an `AudioContext` is. Two engines behind one `PlaybackEngine` interface. |
| **`storage/`** | IndexedDB, File System Access, JSON import/export. |
| **`ui/`** | Rendering and orchestration. Deliberately disposable — `core/` is meant to survive a UI rewrite untouched. |

### The two engines

Toggled live from the header, so you can hear the difference under the passage you're
already listening to.

- **basic** — an `<audio>` element with `preservesPitch`, routed through the Web Audio
  graph. Streams, so it doesn't care how long the file is, and starts instantly. Seeking a
  compressed file has latency, so there's an audible hiccup at the loop point.
- **seamless** — decodes the whole recording to PCM and hands it to an `AudioWorklet` that
  time-stretches with WSOLA and wraps the loop on the audio thread. No seek at the seam, so
  no hiccup, and the pitch holds down to 0.50× where the browser's own stretching has long
  since turned to mush. It costs memory — decoded stereo runs about 11 MB per minute — so
  decoded recordings are held under a budget and released oldest-first past it.

### Keyboard input

Every keystroke resolves through one table in `core/intents.ts` that maps key codes to
intents. No component anywhere else has a `keydown` handler, which is what makes a
Bluetooth page-turner pedal a matter of adding rows rather than a rewrite — pedals emit
ordinary key events.

## Coming soon

- **Practice features** — metronome, count-in, tempo ladder, rep counting, and a session
  log. The schema has carried unused `tempo`, `tags` and `notes` fields since the first
  commit, so these arrive without a migration.
- **PDF scores** via pdf.js, with crop rectangles stored as asset metadata, instead of
  pre-cropped images.
- **Foot pedal support** — most of the way there already, since `PgUp`/`PgDn` are bound to
  previous/next excerpt and that's what pedals send.
- **Keyboard focus** — `Tab` currently switches between the part and score images, which
  leaves nothing free to move focus with. That binding needs to move.
- **Self-recording and A/B** — capture a take against an excerpt and toggle between it and
  the reference at the same loop points.

## Fonts

Cormorant Garamond and Lora, vendored in `public/fonts/` rather than pulled from a CDN, so
the app makes no third-party requests and still works in ten years. Both are under the SIL
Open Font License 1.1 — see [`public/fonts/OFL.txt`](public/fonts/OFL.txt) for the license
and the copyright holders.

## License

MIT — see [LICENSE](LICENSE). The bundled fonts are not covered by it; they keep their own.
