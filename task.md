# Clarks Resize — Standing Instructions

## Task

Periodically, new batches of product photos are dropped as folders directly
inside `CLARKS RESIZE/` (siblings of the `Done/` folder). Each batch folder
is named after a style/order number (e.g. `3320`, `3321`) or occasionally a
product name (e.g. `PENDULA`, `HANA`). Each batch folder is a **flat**
directory of `.jpg` images — no subfolders.

For every such batch folder, do the following:

1. Resize a **copy** of every image to exactly **3000x3000 pixels** (hard
   resize, not aspect-preserving — see "Resize method" below).
2. Save the resized copies into `Done/resized/<folder name>/`.
3. Move the **original, un-resized** files into `Done/original/<folder name>/`.
4. Delete the now-empty batch folder from the top level of `CLARKS RESIZE/`.

**Never touch anything already inside `Done/`** (neither `Done/resized/`
nor `Done/original/`) — those are already-completed batches. Only process
folders that sit at the top level alongside `Done/`.

## Resize method

Use macOS's built-in `sips` tool (no ImageMagick needed/installed). This
resizes to the exact target dimensions, stretching non-square source images
if necessary (do not pad, letterbox, or crop — just force 3000x3000):

```bash
sips -z 3000 3000 /path/to/image.jpg
```

`sips -z <height> <width>` overwrites the file in place, so always run it
on the **copy** in `Done/resized/...`, never on the original.

## Step-by-step commands

Assume the batch folder is `NNNN` (replace with the actual folder name) and
you are in the `CLARKS RESIZE` directory.

```bash
cd "/Users/aarian/Library/CloudStorage/Dropbox/CLARKS RESIZE"

# 1. Create destination folders
mkdir -p "Done/resized/NNNN" "Done/original/NNNN"

# 2. Copy all images into the resized destination
for f in "NNNN"/*.jpg; do
  cp "$f" "Done/resized/NNNN/$(basename "$f")"
done

# 3. Resize the copies in place to exactly 3000x3000
sips -z 3000 3000 "Done/resized/NNNN"/*.jpg

# 4. Verify counts match and every resized file is 3000x3000
src_count=$(ls "NNNN" | wc -l)
dst_count=$(ls "Done/resized/NNNN" | wc -l)
echo "source=$src_count resized=$dst_count"   # must match

find "Done/resized/NNNN" -name "*.jpg" -print0 | while IFS= read -r -d '' f; do
  dims=$(sips -g pixelWidth -g pixelHeight "$f" | tail -2 | awk '{print $2}' | tr '\n' 'x')
  [ "$dims" != "3000x3000x" ] && echo "MISMATCH: $f -> $dims"
done
# no output from the loop above = all good

# 5. Only after verification passes, move originals out
for f in "NNNN"/*.jpg; do
  mv "$f" "Done/original/NNNN/"
done

# 6. Remove the now-empty batch folder
rmdir "NNNN"
```

## Notes / gotchas

- If multiple batch folders need processing, repeat the whole procedure
  once per folder — don't mix files from different batches together.
- Some filenames contain spaces or accented characters (e.g. `CARAMELCAFÉ`,
  `OFF WHITE 90H`) — always quote paths and use glob expansion (`*.jpg`)
  rather than manually typing filenames.
- After deleting an empty batch folder, Dropbox sometimes silently
  recreates it as an empty placeholder during sync. Re-check the top level
  a little after finishing and `rmdir` it again if it reappeared empty —
  this is expected Dropbox behavior, not a leftover file.
- Do not rename files — resized and original copies must keep identical
  filenames to their source.
- If a batch folder contains file types other than `.jpg` (e.g. `.png`,
  `.jpeg`, `.tif`), extend the glob patterns above (`*.jpg` →
  `*.jpg *.jpeg *.png` etc.) accordingly; `sips -z 3000 3000` works on all
  common image formats.
