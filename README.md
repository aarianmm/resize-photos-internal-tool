# Resize Photos — Internal Tool

Batch-resizes product photos to exactly **3000 × 3000**, entirely in the browser.
No install, no upload, no terminal.

**→ [Internal user guide](./GUIDE.md)** — send this to colleagues, not this file.
**→ [PLAN.md](./PLAN.md)** — the design and the reasoning behind it.

---

## What it does

Point it at a folder of images. It scans subfolders too, writes resized copies
into a `resized/` subfolder mirroring the original structure, and leaves your
originals exactly where they are.

- **Hard stretch to 3000 × 3000.** Non-square sources are distorted, not padded
  or cropped — matching the `sips -z 3000 3000` behaviour this tool replaces.
- **Filenames, formats and folder structure unchanged.** JPEG in, JPEG out.
  `3320/CARAMELCAFÉ.jpg` becomes `resized/3320/CARAMELCAFÉ.jpg`.
- **EXIF and ICC preserved**, with orientation normalised so nothing gets
  double-rotated.
- **Images never leave the machine.** All processing is client-side; the only
  thing downloaded from the network is the page itself.

## Replaces

The Mac-only workflow in [`task.md`](./task.md) — download batch → run
`sips` → re-upload. That required a Mac, a terminal, and moving every file
twice over the network.

One difference worth knowing: this tool does **not** move originals into
`Done/original/` or delete the emptied batch folder. Originals stay put. See
PLAN.md §2 for why.

Select the parent folder holding several batch folders and it handles them all
in one pass, recreating each batch folder under `resized/`.

---

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # typecheck + production bundle to dist/
npm test           # unit tests (metadata splicing, ZIP writer)
npm run typecheck
npm run fixtures   # regenerate test/fixtures (needs python3 + Pillow, macOS)
```

Zero runtime dependencies. Resizing, JPEG/PNG encoding, metadata splicing and
ZIP writing all use platform APIs or our own code — see PLAN.md §4.1 for why.

### Layout

| Path | What it is |
|---|---|
| `src/types.ts` | Shared contracts between all modules. Changing a type here changes an interface. |
| `src/main.ts` | App state machine and wiring |
| `src/ui.ts` | DOM rendering, progress, summary, CSV report |
| `src/scan.ts` | Directory traversal, format triage, collision check |
| `src/pool.ts` | Web Worker pool, dispatch, cancellation |
| `src/worker.ts` | decode → stretch → encode → splice → write |
| `src/jpeg-metadata.ts` | EXIF/ICC/IPTC parse and splice |
| `src/zip.ts` | Store-only ZIP writer (Firefox/Safari fallback) |
| `src/capabilities.ts` | Feature detection and browser messaging |
| `scripts/make-fixtures.py` | Generates the test fixture set |

### The two things most likely to break

Both have dedicated tests and fixtures. If you are changing either, read
PLAN.md §4.4 first.

1. **EXIF orientation.** The decoder bakes rotation into the pixels, so the
   copied EXIF must say `Orientation: 1`. Copy it verbatim and every rotated
   photo comes out sideways. Fixture: `portrait-orientation6.jpg`.
2. **Colour space.** We ask the decoder for untransformed pixels
   (`colorSpaceConversion: 'none'`) so the original ICC profile stays correct.
   If a browser ignores that hint we must convert to sRGB and tag sRGB — never
   emit pixels in one space carrying a profile for another. Fixture:
   `adobergb-square.jpg`.

### Browser support

| Browser | Behaviour |
|---|---|
| Edge / Chrome (Windows, Mac) | Full: writes straight into `resized/` |
| Firefox / Safari | Fallback: reads the folder, returns results as a `.zip` |

## Deploying

Static build, hosted on Cloudflare Pages. `npm run build` → deploy `dist/`.
`index.html` is served no-cache and assets are content-hashed, so a fix reaches
everyone on their next page load.
