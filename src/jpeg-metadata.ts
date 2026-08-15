/**
 * JPEG metadata lift-and-splice.
 *
 * Canvas/`OffscreenCanvas.convertToBlob` produces a bare JPEG: no EXIF, no
 * ICC, no IPTC. This module lifts the marker segments worth keeping off the
 * *source* JPEG (`extractMetadata`) and re-inserts them into the freshly
 * encoded output (`spliceMetadata`). See PLAN.md §4.4 for the spec this
 * implements.
 *
 * Pure functions over `Uint8Array`. No DOM, no Node APIs — this runs inside
 * a Web Worker and under vitest's node environment alike. Nothing in here
 * throws on malformed input; parsing failures degrade to "no metadata",
 * never a crash, so one corrupt source file can't take down a batch.
 *
 * ---------------------------------------------------------------------------
 * JPEG segment framing, for reference throughout this file:
 *
 *   FF D8                              SOI, no length
 *   FF <marker> <len hi> <len lo> ...   generic segment: len is BIG-ENDIAN,
 *                                       2 bytes, and INCLUDES itself (the two
 *                                       length bytes) but NOT the marker.
 *                                       So a segment's total byte span is
 *                                       2 (marker) + len, and its payload
 *                                       (everything after the length field)
 *                                       is len - 2 bytes. Max len is 0xFFFF,
 *                                       so max payload is 65533 bytes — this
 *                                       is exactly why large ICC profiles
 *                                       must be split across multiple APP2
 *                                       chunks.
 *   FF DA <len> ... <entropy data>     SOS: has a normal length-prefixed
 *                                       header, but everything after that
 *                                       header is entropy-coded scan data,
 *                                       NOT further marker segments, until
 *                                       EOI. We never parse past SOS — we
 *                                       just copy the remaining bytes
 *                                       (scan data + EOI) through verbatim.
 *   FF D9                              EOI, no length
 * ---------------------------------------------------------------------------
 */

import type { JpegMetadata } from './types';

// ---------------------------------------------------------------------------
// Marker byte constants (the byte that follows 0xFF)
// ---------------------------------------------------------------------------

const M_SOI = 0xd8;
const M_EOI = 0xd9;
const M_SOS = 0xda;
const M_APP1 = 0xe1; // EXIF (and sometimes XMP, distinguished by payload magic)
const M_APP2 = 0xe2; // ICC_PROFILE
const M_APP13 = 0xed; // Photoshop IRB / IPTC

// Markers with no length field / no payload: TEM (0x01) and the restart
// markers RST0-RST7 (0xD0-0xD7). They never appear outside entropy-coded
// scan data in a well-formed file, but we tolerate them defensively.
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

// Segment payload magic strings that identify what an APP1/APP2/APP13
// segment actually carries (several different things share the same marker
// byte — e.g. APP1 is used for both EXIF and XMP).
const EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const ICC_MAGIC = [
  0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
]; // "ICC_PROFILE\0"
const PHOTOSHOP_MAGIC = [
  0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70, 0x20, 0x33, 0x2e,
  0x30, 0x00,
]; // "Photoshop 3.0\0"

function bytesStartWith(bytes: Uint8Array, offset: number, magic: number[]): boolean {
  if (offset + magic.length > bytes.length) return false;
  for (let k = 0; k < magic.length; k++) {
    if (bytes[offset + k] !== magic[k]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Step 1: split a JPEG into header segments + verbatim scan-data tail
// ---------------------------------------------------------------------------

interface RawSegment {
  marker: number;
  /** Complete segment bytes, including the 0xFF marker byte and (if present) the length field. */
  bytes: Uint8Array;
}

interface ParsedJpeg {
  segments: RawSegment[];
  /** Everything from the start of the SOS segment's entropy data through EOI, copied verbatim. */
  tail: Uint8Array;
}

/**
 * Walk a JPEG's marker segments from just after SOI up to (and including
 * the header of) SOS. Returns null for anything that doesn't look like a
 * well-formed JPEG — callers treat that as "nothing to do here", never as
 * an exception.
 */
function parseHeaderSegments(bytes: Uint8Array): ParsedJpeg | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== M_SOI) return null;

  const segments: RawSegment[] = [];
  let i = 2;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null; // sync lost — not a marker where we expect one

    // Tolerate 0xFF fill/padding bytes before the real marker code.
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j++;
    if (j >= bytes.length) return null;
    const marker = bytes[j];
    // segment "starts" at i for output purposes but the marker code is at j;
    // to keep things simple (and match how every real encoder writes files —
    // no padding in practice) we just require j === i + 1. If a file pads,
    // we still don't crash: it just fails to parse and we return null,
    // degrading to "no metadata preserved" per the never-throw contract.
    if (j !== i + 1) return null;

    if (marker === M_EOI) {
      segments.push({ marker, bytes: bytes.slice(i, i + 2) });
      return { segments, tail: new Uint8Array(0) };
    }

    if (isStandaloneMarker(marker)) {
      segments.push({ marker, bytes: bytes.slice(i, i + 2) });
      i += 2;
      continue;
    }

    if (i + 4 > bytes.length) return null; // no room for a length field
    const len = (bytes[i + 2] << 8) | bytes[i + 3]; // big-endian, includes itself
    if (len < 2) return null; // malformed: length must at least cover itself
    const segEnd = i + 2 + len;
    if (segEnd > bytes.length) return null; // truncated file

    segments.push({ marker, bytes: bytes.slice(i, segEnd) });

    if (marker === M_SOS) {
      // Everything from here on is entropy-coded scan data (with byte
      // stuffing that makes it unsafe to scan for markers) followed by
      // EOI. Copy it through untouched.
      return { segments, tail: bytes.slice(segEnd) };
    }

    i = segEnd;
  }

  return null; // ran off the end without ever finding SOS
}

// ---------------------------------------------------------------------------
// Step 2: minimal TIFF/EXIF reader+writer, just enough to normalise
// Orientation, drop the IFD1 thumbnail, and patch pixel dimensions.
// ---------------------------------------------------------------------------

// TIFF field type -> byte width. Types 1-12 per TIFF 6.0 / EXIF 2.3.
const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_INTEROP_IFD_POINTER = 0xa005; // dropped on rebuild rather than re-pointed (rare, avoids a dangling offset)
const TAG_PIXEL_X_DIMENSION = 0xa002;
const TAG_PIXEL_Y_DIMENSION = 0xa003;

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  /** typeSize * count. If <= 4 the value lives inline in `raw4`; if > 4, `data` holds a copy of the out-of-line bytes. */
  size: number;
  /** The 4-byte value/offset field, verbatim, when the entry is inline. */
  raw4: Uint8Array;
  /** Out-of-line payload, when size > 4. */
  data?: Uint8Array;
}

interface TiffIfd {
  entries: TiffEntry[];
}

/** Read one IFD (tag table) at `offset` within `tiff`. Returns null on any bounds/format problem. */
function readIfd(tiff: Uint8Array, offset: number, little: boolean): TiffIfd | null {
  if (offset < 0 || offset + 2 > tiff.length) return null;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const count = dv.getUint16(offset, little);
  const entriesStart = offset + 2;
  const tableEnd = entriesStart + count * 12;
  if (tableEnd + 4 > tiff.length) return null; // need room for the trailing next-IFD offset too

  const entries: TiffEntry[] = [];
  for (let k = 0; k < count; k++) {
    const eOff = entriesStart + k * 12;
    const tag = dv.getUint16(eOff, little);
    const type = dv.getUint16(eOff + 2, little);
    const cnt = dv.getUint32(eOff + 4, little);
    const typeSize = TIFF_TYPE_SIZE[type];
    if (!typeSize) return null; // unrecognised field type — bail out, don't guess
    const size = typeSize * cnt;

    if (size > 4) {
      const dataOffset = dv.getUint32(eOff + 8, little);
      if (dataOffset < 0 || dataOffset + size > tiff.length) return null;
      entries.push({ tag, type, count: cnt, size, raw4: new Uint8Array(4), data: tiff.slice(dataOffset, dataOffset + size) });
    } else {
      entries.push({ tag, type, count: cnt, size, raw4: tiff.slice(eOff + 8, eOff + 12) });
    }
  }
  return { entries };
}

/** Overwrite a SHORT or LONG inline value, respecting byte order. Any other type is left untouched (caller keeps the original entry). */
function makeInlineValue(type: number, little: boolean, value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  if (type === 3) dv.setUint16(0, value, little);
  else dv.setUint32(0, value, little); // type 4 (LONG); other types shouldn't reach here
  return buf;
}

function readInlineNumber(entry: TiffEntry, little: boolean): number | null {
  if (entry.type !== 3 && entry.type !== 4) return null;
  const dv = new DataView(entry.raw4.buffer, entry.raw4.byteOffset, 4);
  return entry.type === 3 ? dv.getUint16(0, little) : dv.getUint32(0, little);
}

/** Assign out-of-line data offsets for entries whose value doesn't fit inline, starting at `ifdEnd`. Mutates `entries` in place. Returns the cursor after the last blob (word-aligned). */
function layoutIfdData(entries: TiffEntry[], ifdEnd: number): number {
  let cursor = ifdEnd;
  for (const e of entries) {
    if (e.size > 4) {
      if (cursor % 2 !== 0) cursor += 1; // TIFF convention: word-align out-of-line data
      (e as TiffEntry & { finalOffset: number }).finalOffset = cursor;
      cursor += e.size;
    }
  }
  return cursor;
}

/** Serialize one IFD (header table, next-IFD-offset forced to 0) plus its out-of-line data into `out`, starting at `ifdOffset`. */
function writeIfd(out: Uint8Array, ifdOffset: number, entries: TiffEntry[], little: boolean): void {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint16(ifdOffset, entries.length, little);
  let eOff = ifdOffset + 2;
  for (const e of entries) {
    dv.setUint16(eOff, e.tag, little);
    dv.setUint16(eOff + 2, e.type, little);
    dv.setUint32(eOff + 4, e.count, little);
    const withOffset = e as TiffEntry & { finalOffset?: number };
    if (e.size > 4 && withOffset.finalOffset !== undefined && e.data) {
      dv.setUint32(eOff + 8, withOffset.finalOffset, little);
      out.set(e.data, withOffset.finalOffset);
    } else {
      out.set(e.raw4, eOff + 8);
    }
    eOff += 12;
  }
  dv.setUint32(eOff, 0, little); // next-IFD offset: always 0 — we never chain to IFD1 (drops the thumbnail)
}

interface RebuiltExif {
  /** Complete APP1 segment: marker + length + "Exif\0\0" + rebuilt TIFF. */
  segment: Uint8Array;
  hadOrientation: boolean;
}

/**
 * Rebuild an APP1/EXIF segment with:
 *  - Orientation forced to 1 (if present)
 *  - IFD1 (the thumbnail IFD chained off IFD0) dropped entirely, along with
 *    its thumbnail JPEG data — we simply never parse or copy it, and force
 *    IFD0's next-IFD-offset to 0.
 *  - ExifIFD and GPS IFD sub-tables preserved and re-pointed to their new
 *    locations (their contents survive relocation).
 *
 * Returns null if the payload isn't recognisable EXIF, or doesn't parse
 * cleanly — callers treat that as "no EXIF to keep", never a crash.
 */
function rebuildExifSegment(segBytes: Uint8Array): RebuiltExif | null {
  // segBytes = FF E1 <len:2> "Exif\0\0" <TIFF...>
  if (segBytes.length < 4 + 6 + 8) return null;
  if (!bytesStartWith(segBytes, 4, EXIF_MAGIC)) return null;
  const tiffStart = 4 + 6;
  const tiff = segBytes.subarray(tiffStart);

  if (tiff.length < 8) return null;
  let little: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) little = true; // "II"
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) little = false; // "MM"
  else return null;

  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (dv.getUint16(2, little) !== 42) return null; // TIFF magic
  const ifd0Offset = dv.getUint32(4, little);

  const ifd0 = readIfd(tiff, ifd0Offset, little);
  if (!ifd0) return null;

  let hadOrientation = false;
  let exifIfdPointerOffset: number | undefined;
  let gpsIfdPointerOffset: number | undefined;
  const ifd0Entries: TiffEntry[] = [];

  for (const e of ifd0.entries) {
    if (e.tag === TAG_ORIENTATION) {
      const orig = readInlineNumber(e, little);
      if (orig !== null) {
        if (orig !== 1) hadOrientation = true;
        ifd0Entries.push({ ...e, raw4: makeInlineValue(e.type, little, 1) });
      } else {
        ifd0Entries.push(e); // unrecognised type for this tag — leave untouched rather than guess
      }
      continue;
    }
    if (e.tag === TAG_EXIF_IFD_POINTER) {
      exifIfdPointerOffset = readInlineNumber(e, little) ?? undefined;
      continue; // rebuilt and re-pointed below, not copied generically
    }
    if (e.tag === TAG_GPS_IFD_POINTER) {
      gpsIfdPointerOffset = readInlineNumber(e, little) ?? undefined;
      continue;
    }
    ifd0Entries.push(e);
  }

  let exifEntries: TiffEntry[] | null = null;
  if (exifIfdPointerOffset !== undefined) {
    const exifIfd = readIfd(tiff, exifIfdPointerOffset, little);
    if (exifIfd) {
      exifEntries = exifIfd.entries.filter((e) => e.tag !== TAG_INTEROP_IFD_POINTER);
    }
  }

  let gpsEntries: TiffEntry[] | null = null;
  if (gpsIfdPointerOffset !== undefined) {
    const gpsIfd = readIfd(tiff, gpsIfdPointerOffset, little);
    if (gpsIfd) gpsEntries = gpsIfd.entries;
  }

  // Reserve placeholder entries for the sub-IFD pointers; their inline
  // values get filled in once we know the sub-IFDs' final offsets.
  if (exifEntries) {
    ifd0Entries.push({ tag: TAG_EXIF_IFD_POINTER, type: 4, count: 1, size: 4, raw4: new Uint8Array(4) });
  }
  if (gpsEntries) {
    ifd0Entries.push({ tag: TAG_GPS_IFD_POINTER, type: 4, count: 1, size: 4, raw4: new Uint8Array(4) });
  }

  // TIFF 6.0 requires IFD entries sorted in ascending tag order.
  ifd0Entries.sort((a, b) => a.tag - b.tag);
  if (exifEntries) exifEntries.sort((a, b) => a.tag - b.tag);
  if (gpsEntries) gpsEntries.sort((a, b) => a.tag - b.tag);

  // --- layout pass ---
  const HEADER_SIZE = 8;
  const ifd0Offset2 = HEADER_SIZE;
  const ifd0HeaderEnd = ifd0Offset2 + 2 + ifd0Entries.length * 12 + 4;
  let cursor = layoutIfdData(ifd0Entries, ifd0HeaderEnd);

  let exifIfdOffsetFinal = 0;
  if (exifEntries) {
    if (cursor % 2 !== 0) cursor += 1;
    exifIfdOffsetFinal = cursor;
    const exifHeaderEnd = exifIfdOffsetFinal + 2 + exifEntries.length * 12 + 4;
    cursor = layoutIfdData(exifEntries, exifHeaderEnd);
  }

  let gpsIfdOffsetFinal = 0;
  if (gpsEntries) {
    if (cursor % 2 !== 0) cursor += 1;
    gpsIfdOffsetFinal = cursor;
    const gpsHeaderEnd = gpsIfdOffsetFinal + 2 + gpsEntries.length * 12 + 4;
    cursor = layoutIfdData(gpsEntries, gpsHeaderEnd);
  }

  // Now that final offsets are known, fill in the sub-IFD pointer values.
  if (exifEntries) {
    const ptr = ifd0Entries.find((e) => e.tag === TAG_EXIF_IFD_POINTER);
    if (ptr) ptr.raw4 = makeInlineValue(4, little, exifIfdOffsetFinal);
  }
  if (gpsEntries) {
    const ptr = ifd0Entries.find((e) => e.tag === TAG_GPS_IFD_POINTER);
    if (ptr) ptr.raw4 = makeInlineValue(4, little, gpsIfdOffsetFinal);
  }

  const totalTiffSize = cursor;
  const outTiff = new Uint8Array(totalTiffSize);
  const outDv = new DataView(outTiff.buffer);
  outTiff[0] = little ? 0x49 : 0x4d;
  outTiff[1] = little ? 0x49 : 0x4d;
  outDv.setUint16(2, 42, little);
  outDv.setUint32(4, ifd0Offset2, little);

  writeIfd(outTiff, ifd0Offset2, ifd0Entries, little);
  if (exifEntries) writeIfd(outTiff, exifIfdOffsetFinal, exifEntries, little);
  if (gpsEntries) writeIfd(outTiff, gpsIfdOffsetFinal, gpsEntries, little);

  const payload = new Uint8Array(6 + outTiff.length);
  payload.set(EXIF_MAGIC, 0);
  payload.set(outTiff, 6);

  const segment = wrapSegment(M_APP1, payload);
  if (!segment) return null;
  return { segment, hadOrientation };
}

/**
 * Patch PixelXDimension (0xA002) / PixelYDimension (0xA003) inside an
 * already-rebuilt EXIF segment's ExifIFD, in place. Both tags, when
 * present, are inline SHORT or LONG values (count 1), so this never needs
 * to move any bytes — only overwrite up to 4 bytes per tag at their
 * existing position.
 */
function patchExifDimensions(exifSeg: Uint8Array, width: number, height: number): Uint8Array {
  if (exifSeg.length < 4 + 6 + 8) return exifSeg;
  if (!bytesStartWith(exifSeg, 4, EXIF_MAGIC)) return exifSeg;
  const tiffStart = 4 + 6;
  const tiff = exifSeg.subarray(tiffStart);
  if (tiff.length < 8) return exifSeg;

  let little: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) little = true;
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) little = false;
  else return exifSeg;

  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (dv.getUint16(2, little) !== 42) return exifSeg;
  const ifd0Offset = dv.getUint32(4, little);
  const ifd0 = readIfd(tiff, ifd0Offset, little);
  if (!ifd0) return exifSeg;

  const exifPtr = ifd0.entries.find((e) => e.tag === TAG_EXIF_IFD_POINTER);
  if (!exifPtr) return exifSeg; // nothing to patch — no ExifIFD present
  const exifIfdOffset = readInlineNumber(exifPtr, little);
  if (exifIfdOffset === null) return exifSeg;

  // Locate the raw entry offsets for the two dimension tags by re-reading
  // the IFD table directly (readIfd doesn't retain each entry's own byte
  // offset, and we need it here to patch in place).
  if (exifIfdOffset < 0 || exifIfdOffset + 2 > tiff.length) return exifSeg;
  const count = dv.getUint16(exifIfdOffset, little);
  const entriesStart = exifIfdOffset + 2;

  const out = exifSeg.slice(); // work on a private copy; never mutate the caller's bytes
  const outTiff = out.subarray(tiffStart);
  const outDv = new DataView(outTiff.buffer, outTiff.byteOffset, outTiff.byteLength);

  for (let k = 0; k < count; k++) {
    const eOff = entriesStart + k * 12;
    if (eOff + 12 > tiff.length) break;
    const tag = dv.getUint16(eOff, little);
    if (tag !== TAG_PIXEL_X_DIMENSION && tag !== TAG_PIXEL_Y_DIMENSION) continue;
    const type = dv.getUint16(eOff + 2, little);
    const value = tag === TAG_PIXEL_X_DIMENSION ? width : height;
    if (type === 3) outDv.setUint16(eOff + 8, value, little);
    else if (type === 4) outDv.setUint32(eOff + 8, value, little);
    // any other type: leave untouched, don't guess a layout we don't understand
  }

  return out;
}

// ---------------------------------------------------------------------------
// Step 3: ICC profile reassembly + description lookup
// ---------------------------------------------------------------------------

const ICC_CHUNK_HEADER_SIZE = 12 + 2; // "ICC_PROFILE\0" + chunk index (1) + chunk count (1)

/** Concatenate the profile bytes out of a set of ordered APP2/ICC_PROFILE segments. */
function reassembleIccProfile(iccSegments: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const seg of iccSegments) {
    const payload = seg.subarray(4); // strip marker + length
    const data = payload.subarray(ICC_CHUNK_HEADER_SIZE);
    parts.push(data);
    total += data.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Best-effort read of the ICC profile's `desc` tag (profileDescriptionTag).
 * Handles the two type encodings seen in the wild: legacy
 * `textDescriptionType` ('desc', ICC v2 — e.g. macOS's own Adobe RGB
 * profile) and `multiLocalizedUnicodeType` ('mluc', ICC v4). All ICC
 * integer fields are big-endian regardless of the host JPEG's TIFF byte
 * order — that's an ICC spec rule, not something we infer per-file.
 */
function readIccDescription(profile: Uint8Array): string | undefined {
  if (profile.length < 132) return undefined;
  const dv = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  const tagCount = dv.getUint32(128, false);
  const tableStart = 132;
  if (tableStart + tagCount * 12 > profile.length) return undefined;

  for (let t = 0; t < tagCount; t++) {
    const eOff = tableStart + t * 12;
    const sig =
      String.fromCharCode(profile[eOff]) +
      String.fromCharCode(profile[eOff + 1]) +
      String.fromCharCode(profile[eOff + 2]) +
      String.fromCharCode(profile[eOff + 3]);
    if (sig !== 'desc') continue;

    const tagOffset = dv.getUint32(eOff + 4, false);
    const tagSize = dv.getUint32(eOff + 8, false);
    if (tagOffset + tagSize > profile.length || tagSize < 12) return undefined;
    const tag = profile.subarray(tagOffset, tagOffset + tagSize);
    const tagDv = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
    const type =
      String.fromCharCode(tag[0]) + String.fromCharCode(tag[1]) + String.fromCharCode(tag[2]) + String.fromCharCode(tag[3]);

    if (type === 'desc') {
      // textDescriptionType: sig(4) reserved(4) asciiCount(4) asciiString(asciiCount, NUL-terminated)
      if (tag.length < 12) return undefined;
      const asciiCount = tagDv.getUint32(8, false);
      const end = Math.min(12 + asciiCount, tag.length);
      let str = '';
      for (let i = 12; i < end; i++) {
        if (tag[i] === 0) break;
        str += String.fromCharCode(tag[i]);
      }
      return str.length > 0 ? str : undefined;
    }

    if (type === 'mluc') {
      // multiLocalizedUnicodeType: sig(4) reserved(4) recordCount(4) recordSize(4) then records of
      // langCode(2) countryCode(2) length(4, bytes) offset(4, from tag start), string is UTF-16BE.
      if (tag.length < 16) return undefined;
      const recordCount = tagDv.getUint32(8, false);
      if (recordCount < 1) return undefined;
      const recordsStart = 16;
      const strLen = tagDv.getUint32(recordsStart + 4, false);
      const strOffset = tagDv.getUint32(recordsStart + 8, false);
      if (strOffset + strLen > tag.length) return undefined;
      let str = '';
      for (let i = strOffset; i + 1 < strOffset + strLen; i += 2) {
        const code = (tag[i] << 8) | tag[i + 1];
        if (code === 0) break;
        str += String.fromCharCode(code);
      }
      return str.length > 0 ? str : undefined;
    }

    return undefined; // unrecognised tag type
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Segment wrapping helper
// ---------------------------------------------------------------------------

/** Wrap a payload as a complete marker segment (marker + big-endian length + payload). Returns null if the payload is too large to fit a 16-bit length (never throws). */
function wrapSegment(marker: number, payload: Uint8Array): Uint8Array | null {
  const len = payload.length + 2; // length field includes itself, per JPEG spec
  if (len > 0xffff) return null;
  const out = new Uint8Array(2 + len);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(payload, 4);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lift the marker segments worth preserving off a source JPEG: EXIF (APP1),
 * ICC profile (APP2, possibly multi-chunk), and Photoshop/IPTC (APP13).
 *
 * The returned EXIF (if any) already has Orientation normalised to 1 and
 * the IFD1 thumbnail dropped — see `rebuildExifSegment`. Pixel dimensions
 * are NOT patched here (this function doesn't know the output size); that
 * happens in `spliceMetadata`, which does receive `dims`.
 *
 * Returns null when the input isn't a JPEG, or when it is but carries none
 * of APP1/APP2/APP13.
 */
export function extractMetadata(sourceBytes: Uint8Array): JpegMetadata | null {
  try {
    const parsed = parseHeaderSegments(sourceBytes);
    if (!parsed) return null;

    let exifSeg: Uint8Array | undefined;
    const iccSegs: Uint8Array[] = [];
    let iptcSeg: Uint8Array | undefined;

    for (const seg of parsed.segments) {
      if (seg.marker === M_APP1 && !exifSeg && seg.bytes.length > 4 && bytesStartWith(seg.bytes, 4, EXIF_MAGIC)) {
        exifSeg = seg.bytes;
      } else if (seg.marker === M_APP2 && seg.bytes.length > 4 && bytesStartWith(seg.bytes, 4, ICC_MAGIC)) {
        iccSegs.push(seg.bytes);
      } else if (seg.marker === M_APP13 && !iptcSeg && seg.bytes.length > 4 && bytesStartWith(seg.bytes, 4, PHOTOSHOP_MAGIC)) {
        iptcSeg = seg.bytes;
      }
    }

    if (!exifSeg && iccSegs.length === 0 && !iptcSeg) return null;

    let finalExif: Uint8Array | undefined;
    let hadOrientation = false;
    if (exifSeg) {
      const rebuilt = rebuildExifSegment(exifSeg);
      if (rebuilt) {
        finalExif = rebuilt.segment;
        hadOrientation = rebuilt.hadOrientation;
      }
      // If rebuild failed (malformed/unrecognisable EXIF), we simply drop
      // EXIF from the result rather than propagate the raw, un-normalised
      // segment — copying an un-rewritten Orientation would risk the
      // double-rotation bug this module exists to prevent.
    }

    let iccDescription: string | undefined;
    if (iccSegs.length > 0) {
      const profile = reassembleIccProfile(iccSegs);
      iccDescription = readIccDescription(profile);
    }

    if (!finalExif && iccSegs.length === 0 && !iptcSeg) return null;

    const result: JpegMetadata = {
      icc: iccSegs,
      hadOrientation,
    };
    if (finalExif) result.exif = finalExif;
    if (iptcSeg) result.iptc = iptcSeg;
    if (iccDescription) result.iccDescription = iccDescription;
    return result;
  } catch {
    // Belt and suspenders: any unexpected bounds error anywhere above
    // degrades to "nothing preserved", never a crash.
    return null;
  }
}

/**
 * Splice previously-extracted metadata onto a freshly encoded JPEG.
 *
 * Strips any APP1/APP2 the browser's own encoder emitted (canvas encoders
 * generally don't emit these, but we don't rely on that), then inserts our
 * segments immediately after SOI in the order EXIF -> ICC -> IPTC. The EXIF
 * segment's PixelXDimension/PixelYDimension are patched to `dims` here,
 * since only the caller of spliceMetadata knows the final output size.
 *
 * On any parse failure of `encodedJpeg`, returns it unchanged — metadata
 * splicing must never be the reason a batch fails.
 */
export function spliceMetadata(
  encodedJpeg: Uint8Array,
  meta: JpegMetadata,
  dims: { width: number; height: number },
): Uint8Array {
  const parsed = parseHeaderSegments(encodedJpeg);
  if (!parsed) return encodedJpeg;

  const toInsert: Uint8Array[] = [];
  if (meta.exif) {
    toInsert.push(patchExifDimensions(meta.exif, dims.width, dims.height));
  }
  for (const chunk of meta.icc) {
    toInsert.push(chunk);
  }
  if (meta.iptc) {
    toInsert.push(meta.iptc);
  }

  const kept = parsed.segments.filter((seg) => seg.marker !== M_APP1 && seg.marker !== M_APP2);

  let totalLen = 2; // SOI
  for (const s of toInsert) totalLen += s.length;
  for (const s of kept) totalLen += s.bytes.length;
  totalLen += parsed.tail.length;

  const out = new Uint8Array(totalLen);
  let offset = 0;
  out[0] = 0xff;
  out[1] = M_SOI;
  offset = 2;
  for (const s of toInsert) {
    out.set(s, offset);
    offset += s.length;
  }
  for (const s of kept) {
    out.set(s.bytes, offset);
    offset += s.bytes.length;
  }
  out.set(parsed.tail, offset);
  offset += parsed.tail.length;

  return out;
}
