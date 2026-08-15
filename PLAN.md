# Resize Tool — Implementation Plan

A zero-install, browser-based batch image resizer for internal company use.
Replaces the current "download files → run Claude Code + `sips` on a Mac → re-upload"
loop described in [`task.md`](./task.md).

---

## 1. Goal

Let any colleague, on their own machine (primarily Windows), point at a folder of
product photos and get every image resized to exactly **3000×3000** — without
installing anything, without uploading images anywhere, and without touching a
terminal.

### Success criteria

- A non-technical user completes a 200-image batch in under 2 minutes, start to finish, from a single link.
- Output is pixel-equivalent to today's `sips -z 3000 3000` results.
- Filenames are unchanged; originals are never modified or moved.
- No image data leaves the user's device.
- Works on a locked-down corporate Windows machine with no admin rights.

---

## 2. Decisions (locked)

| Question | Decision |
|---|---|
| Delivery | **Browser tool, no install.** Static page, all processing client-side. |
| Hosting | **Hosted URL** — one link, always current. |
| Workflow | **Pick a folder → resized output.** Scans subfolders recursively and mirrors their structure. No `original/` moves, no folder deletion. |
| Resize mode | **Hard stretch to 3000×3000.** No fit, pad, or crop. Non-square sources distort, exactly as today. |
| Filenames | **Unchanged** — same basename, same extension, same position in the folder tree. |
| Format | **Unchanged** — JPEG in → JPEG out, PNG in → PNG out. |
| Encoding | **JPEG quality 0.92**, with **EXIF + ICC preserved** from the source. |

### Explicitly out of scope (v1)

- Moving originals into an `original/` folder, and deleting emptied batch folders. Originals stay put.
- Renaming, watermarking, cropping, background removal.
- Any server-side processing, accounts, or logging of file names/content.

---

## 3. User experience

Single page, three states.

> **Revised after first use.** The original plan assumed flat batch folders,
> because that is what `task.md` described. In practice people select a parent
> folder containing several batch subfolders, which scanned as zero images.
> Scanning is now recursive and the source tree's shape is mirrored into the
> output.

**Idle**
```
┌──────────────────────────────────────────────┐
│              Resize to 3000 × 3000           │
│                                              │
│     ┌────────────────────────────────┐       │
│     │   Drop a folder here           │       │
│     │   or  [ Choose folder… ]       │       │
│     └────────────────────────────────┘       │
│                                              │
│   Output: <folder>/resized/    [Change…]     │
│   Your images never leave this computer.     │
└──────────────────────────────────────────────┘
```

**Confirm** — after a folder is selected, before any writing:
> Found **214 images** in `3320`, across **12 folders**. 3 files skipped (unsupported type).
> They'll be written to `3320/resized/`.
> `[ Resize 214 images ]`

**Running** — progress bar, `112 / 214`, current filename, elapsed/remaining
estimate, and a **Cancel** button that stops cleanly between files.

**Done** — summary card:
> ✅ 214 resized · ⚠️ 3 skipped · ❌ 0 failed
> Open output folder · Download report (.csv)

Skipped and failed files are listed by name with a plain-English reason
("`.tif` files aren't supported by browsers", "file is corrupt or not an image").

### Interaction rules

- **One permission prompt.** `showDirectoryPicker({ mode: 'readwrite' })` grants
  read on the batch and write on the `resized/` child in a single dialog.
- **Dragging a folder onto the page works too**, via
  `DataTransferItem.getAsFileSystemHandle()` — same handle type, same code path.
- **Default output is a `resized/` subfolder** inside the chosen folder,
  created on demand. Each image lands at the same relative path it had in the
  source, so `3320/img.jpg` becomes `resized/3320/img.jpg`. One level, not two:
  the tool only ever produces resized copies, so a parent folder wrapping a
  single child would add depth without adding meaning. "Change…" opens a second picker for a different destination.
- **Existing output files**: if `resized/` already contains files at
  matching relative paths, ask once — *Overwrite / Skip already-done / Cancel* — and remember the
  answer for the rest of the batch.
- **Nothing is written until the user confirms.** Scanning is read-only.
- **The output folder is never scanned as input.** A top-level `resized/` is
  skipped during traversal, and so is `done/`, which an interim version used.
  Without this, a second run on the same root would resize its own output and
  the folder would grow on every pass.

---

## 4. Technical design

### 4.1 Stack

- **TypeScript + Vite**, no UI framework. The page is a handful of DOM nodes;
  a framework is more dependency surface than it's worth.
- **Zero runtime dependencies.** Resizing, JPEG/PNG encoding, metadata splicing,
  and ZIP writing are all done with platform APIs or ~200 lines of our own code.
- Output is a static bundle (`index.html` + one JS + one CSS).

### 4.2 Pipeline (per image)

```
FileSystemFileHandle
  → .getFile()                                  → File
  → createImageBitmap(file, {
        resizeWidth: 3000, resizeHeight: 3000,   ← the hard stretch
        resizeQuality: 'high',
        imageOrientation: 'from-image',
        colorSpaceConversion: 'none'             ← keep original pixel values
    })                                           → ImageBitmap (3000×3000)
  → drawImage onto OffscreenCanvas(3000, 3000)
  → .convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  → spliceMetadata(originalBytes, encodedBytes)  ← EXIF/ICC carried over
  → outputDir.getFileHandle(name, { create: true })
      .createWritable().write(blob).close()
  → bitmap.close()                               ← free ~36 MB immediately
```

`createImageBitmap`'s `resizeWidth`/`resizeHeight` do the scaling in the
decoder, which is faster and higher quality than drawing to a scaled canvas,
and it ignores aspect ratio — which is exactly the hard-stretch behaviour we
want.

### 4.3 Concurrency and memory

- A pool of **`min(navigator.hardwareConcurrency - 1, 4)` Web Workers**, each
  running the pipeline above on `OffscreenCanvas`. The main thread only
  dispatches handles and updates the UI, so the page never freezes.
- A 3000×3000 RGBA bitmap is ~36 MB; a 6000×4000 source decodes to ~96 MB.
  Cap at 4 workers and `close()` bitmaps eagerly to stay well under browser
  memory limits on a 8 GB Windows laptop.
- Files are streamed one at a time per worker — **the batch is never held in
  memory at once**, so a 2000-image folder works the same as a 20-image one.

### 4.4 Metadata preservation (the fiddly part)

Canvas encoding produces a bare JPEG: no EXIF, no ICC, no IPTC. To honour the
"preserve EXIF/ICC" decision we splice segments from the source:

1. Parse the **source** JPEG's marker segments; keep `APP1` (EXIF), `APP2`
   (ICC_PROFILE, possibly multi-chunk), and `APP13` (IPTC/Photoshop).
2. **Rewrite EXIF `Orientation` to `1`.** `imageOrientation: 'from-image'`
   already baked the rotation into the pixels; copying the original orientation
   tag unchanged would rotate the image a second time in any viewer that
   respects it. This is the single easiest bug to ship here.
3. Drop the embedded EXIF thumbnail (it's a stale 3:2 image of the pre-resize
   file) and update `PixelXDimension`/`PixelYDimension` to 3000×3000.
4. Strip any `APP1`/`APP2` the browser's encoder emitted, then insert our
   segments immediately after `SOI`.

**Colour-space risk.** `colorSpaceConversion: 'none'` asks the decoder to hand
back untransformed pixels, which is what makes copying the original ICC profile
correct. Browser behaviour here is not uniform. Mitigation: a test image in
Adobe RGB is part of the test set (§7); if a target browser ignores the hint and
converts to sRGB anyway, fall back to `colorSpaceConversion: 'default'` and tag
the output sRGB rather than copying a now-wrong profile. Either way the tool
must never emit pixels in one space carrying a profile for another.

**PNG sources** are re-encoded losslessly (`image/png`, no quality parameter);
PNG has no EXIF/ICC segment worth carrying for this use case, so metadata
handling is JPEG-only.

### 4.5 Browser support and fallback

| Browser | Path |
|---|---|
| Chrome / Edge, Windows & Mac | Full: directory picker, writes straight into `resized/` |
| Firefox, Safari | Fallback: `<input webkitdirectory>` to read, **ZIP download** of results |

The fallback exists so nobody hits a dead end, but the hosted page should
detect a non-supporting browser and say so up front: *"For the best experience
open this in Edge or Chrome — Firefox can still resize, but results arrive as a
.zip you unpack yourself."*

The ZIP writer is **store-only (no compression)** — JPEGs are already
compressed, so deflate buys nothing and costs a dependency. That makes the
writer ~150 lines (local headers, central directory, CRC-32) with no library.
It streams into a `FileSystemWritableFileStream` via `showSaveFilePicker` where
available, otherwise into a Blob. Batches over 4 GB need Zip64 — for v1, warn
and suggest splitting rather than implementing it.

### 4.6 Format support

Three tiers, and the distinction matters more than it first looks:

| Tier | Formats | Behaviour |
|---|---|---|
| Decode **and** encode | JPEG, PNG, WebP | Processed. Same filename, same format. |
| Decode only | GIF, BMP, AVIF | **Skipped with an explanation.** |
| Neither | TIFF, HEIC, RAW, PSD | Skipped with an explanation. |

The middle tier was found during implementation. `OffscreenCanvas.convertToBlob`
can only write JPEG, PNG and WebP — so a `.gif` could be decoded and resized,
but only written back as JPEG bytes. Under the "filenames never change" rule
that produces a `.gif` file that is secretly a JPEG: a file whose contents
contradict its name, which no one would catch until something downstream
choked on it. A clearly reported skip beats silent mislabelling, so those
extensions are triaged out and the user is told to convert to JPEG first.

`task.md` mentions `.tif` as a possible input. Those are detected by extension,
skipped, and reported by name rather than silently dropped. If TIFF turns out
to be common in real batches, that changes the plan (see §9).

---

## 5. Project structure

```
resize-tool/
├─ index.html
├─ src/
│  ├─ main.ts            UI state machine, wiring
│  ├─ ui.ts              DOM rendering, progress, summary, report CSV
│  ├─ scan.ts            directory traversal, format triage, collision check
│  ├─ pool.ts            worker pool, cancellation, backpressure
│  ├─ worker.ts          decode → stretch → encode → splice → write
│  ├─ jpeg-metadata.ts   segment parse + splice, orientation fix
│  ├─ zip.ts             store-only ZIP writer (fallback path)
│  └─ capabilities.ts    feature detection, browser messaging
├─ test/
│  ├─ fixtures/          see §7
│  └─ *.test.ts
├─ PLAN.md
└─ task.md               original Mac/sips instructions (kept for reference)
```

---

## 6. Build phases

Each phase ends at something demonstrable.

**Phase 1 — Core resize, happy path** *(largest chunk)*
Directory picker → scan → worker pool → stretch → JPEG q92 → write to
`resized/`. Progress bar and cancel. No metadata splicing yet.
*Done when:* a real Clarks batch folder resizes correctly on Windows Edge and
output opens at 3000×3000.

**Phase 2 — Metadata**
`jpeg-metadata.ts`: EXIF/ICC/IPTC splice, orientation normalisation, colour
-space validation against the Adobe RGB fixture.
*Done when:* `exiftool` on the output shows the source's profile and camera
data, and orientation is `1` with correct-looking pixels.

**Phase 3 — Robustness**
Collision handling, corrupt-file recovery (one bad file must not kill the
batch), unsupported-format triage, per-file error reporting, CSV report,
memory behaviour verified on a 500-image batch.

**Phase 4 — Fallback + polish**
Firefox/Safari ZIP path, drag-and-drop folders, capability messaging, final
visual pass, empty/error states.

**Phase 5 — Ship**
Deploy to Cloudflare Pages, write the one-page internal guide (§8), pilot with
one colleague on a real batch before wider rollout.

---

## 7. Testing

**Fixture set** (committed under `test/fixtures/`, small files):

- square JPEG, already 3000×3000 (no-op case)
- landscape JPEG 6000×4000 (heavy stretch — verify distortion matches `sips`)
- portrait JPEG with EXIF `Orientation: 6` (the double-rotation trap)
- JPEG tagged **Adobe RGB** (colour-space correctness)
- JPEG with IPTC copyright fields
- filenames with spaces and accents — `CARAMELCAFÉ.jpg`, `OFF WHITE 90H.jpg`
  (called out as a real gotcha in `task.md`)
- a PNG with transparency
- a `.tif` and a `.txt` renamed to `.jpg` (triage + corrupt handling)

**Automated:** unit tests for `jpeg-metadata.ts` (parse/splice round-trip,
orientation rewrite) and `zip.ts` (CRC-32 and central directory against a real
unzip). These are the two places where a subtle bug is invisible in the UI.

**Manual matrix:** Windows 11 / Edge and Chrome (primary), macOS / Chrome and
Safari, Firefox on both. Plus one **large-batch run** (500+ images) watching
memory in the task manager.

**Still outstanding — must happen before rollout:**

- **Nobody has seen the UI in a real browser yet.** The build is green, tests
  pass and every module serves, but rendering, the permission prompt, the
  progress bar and the collision modal have not been exercised by a human.
  This is the first thing to do, not the last.
- **Open the fallback `.zip` in Windows Explorer.** The ZIP writer's UTF-8
  filename handling is verified against macOS `unzip` and Python `zipfile`,
  both of which now round-trip `CARAMELCAFÉ.jpg` intact. Explorer is a third
  implementation with its own history of mangling non-ASCII names, and it is
  the one our users actually have. Untested so far.

**Parity check:** run the same folder through `sips -z 3000 3000` on the Mac and
through the tool, and compare dimensions across every file plus a visual diff on
a sample. This is what proves the replacement is safe to hand over.

---

## 8. Deployment and rollout

- **Host:** Cloudflare Pages (free, static, instant rollbacks). Repo push →
  deploy. A custom subdomain makes the link memorable.
- **Headers:** ship `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` only if a future feature needs
  `SharedArrayBuffer` — not required for v1, and they complicate nothing else,
  so leave them off.
- **Cache:** hashed asset filenames, `index.html` set to no-cache, so a fix
  reaches everyone on next load.
- **Internal guide** (one page, with screenshots): what the link is, the three
  clicks, what "your images never leave your computer" means concretely, which
  browser to use, and who to tell when something looks wrong.
- **Pilot before rollout:** one colleague, one real batch, watched. Cheaper than
  discovering a Windows-specific issue across the whole team at once.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Colour shift from ICC/colour-space mismatch | Wrong product colours — the worst possible failure for retail photos | Adobe RGB fixture tested in Phase 2; fall back to sRGB tagging if the browser won't hand back untransformed pixels |
| Double rotation from copied EXIF orientation | Sideways images | Orientation forced to `1`; dedicated fixture |
| TIFF/HEIC inputs turn out to be common | Tool can't process real batches | Skipped-and-reported in v1; if it happens, add a WASM TIFF decoder (adds ~200 KB and real complexity) |
| Corporate policy blocks File System Access | Tool unusable for some users | ZIP fallback path covers it |
| Very large batches exhaust memory | Tab crash mid-batch | Bounded worker pool, eager `bitmap.close()`, 500-image test in Phase 3 |
| Quality 92 visibly degrades a photo | Rejected output | Side-by-side check during the parity run; quality is one constant to change if not |
| Users expect the old `Done/original` behaviour | Confusion during handover | Called out explicitly in the internal guide: originals stay exactly where they are |
| Windows Explorer mangles accented names in the fallback `.zip` | `CARAMELCAFÉ.jpg` extracts as mojibake | UTF-8 flag, UNIX host byte and Unicode Path extra field all set; **still needs a real Explorer test** (§7) |
| "Open output folder" button is impossible | Minor UX gap | No web API can open a native file-explorer window at a directory handle. The output path is stated as text instead of shipping a dead button |

---

## 10. Open questions

Not blocking Phase 1 — worth answering before Phase 5.

1. **Do real batches contain `.tif` or `.png`?** `task.md` mentions them as a
   possibility. If TIFF is actually used, §9's mitigation becomes a scope change.
2. **Typical batch size and source resolution?** Drives whether 4 workers is the
   right cap.
3. **Does anything downstream read EXIF/ICC from these files?** If nothing does,
   Phase 2 could be dropped entirely and the tool ships sooner.
4. **Should the Mac/Dropbox flow keep running in parallel** during rollout, or
   is the tool a straight replacement once the parity check passes?
