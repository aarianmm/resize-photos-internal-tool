import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractMetadata, spliceMetadata } from '../src/jpeg-metadata';
import type { JpegMetadata } from '../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}

// ---------------------------------------------------------------------------
// Independent JPEG helpers for assertions. Deliberately re-implemented here
// rather than imported from src/jpeg-metadata.ts, so these tests check the
// module's actual output bytes rather than its own self-consistency.
// ---------------------------------------------------------------------------

/** All complete segments in `bytes` matching `markerByte`, scanning from just after SOI up to SOS. */
function segmentsOf(bytes: Uint8Array, markerByte: number): Uint8Array[] {
  const found: Uint8Array[] = [];
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const segEnd = i + 2 + len;
    if (marker === markerByte) found.push(bytes.slice(i, segEnd));
    if (marker === 0xda) break; // SOS: stop before entropy-coded scan data
    i = segEnd;
  }
  return found;
}

/** Everything from the first SOS segment's scan data through EOI, copied verbatim. Used to verify splicing never touches pixel data. */
function scanDataTail(bytes: Uint8Array): Uint8Array {
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xda) return bytes.slice(i + 2 + len);
    i += 2 + len;
  }
  return new Uint8Array(0);
}

function assertFramingAndScanDataPreserved(spliced: Uint8Array, encodedOriginal: Uint8Array): void {
  expect(spliced[0]).toBe(0xff);
  expect(spliced[1]).toBe(0xd8);
  expect(spliced[spliced.length - 2]).toBe(0xff);
  expect(spliced[spliced.length - 1]).toBe(0xd9);
  const originalTail = scanDataTail(encodedOriginal);
  expect(originalTail.length).toBeGreaterThan(0);
  const splicedTail = spliced.slice(spliced.length - originalTail.length);
  expect(splicedTail).toEqual(originalTail);
}

/** Read the EXIF Orientation tag (0x0112) out of a full APP1 segment. Assumes IFD0 holds it directly, which is where every fixture/synthetic segment here puts it. */
function readExifOrientation(exifSegment: Uint8Array): number | null {
  const tiff = exifSegment.slice(10); // past "FF E1 <len:2> Exif\0\0"
  const little = tiff[0] === 0x49;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd0Offset = dv.getUint32(4, little);
  const count = dv.getUint16(ifd0Offset, little);
  for (let k = 0; k < count; k++) {
    const eOff = ifd0Offset + 2 + k * 12;
    if (dv.getUint16(eOff, little) === 0x0112) return dv.getUint16(eOff + 8, little);
  }
  return null;
}

/** Read PixelXDimension (0xA002) / PixelYDimension (0xA003) out of a full APP1 segment's ExifIFD, if present. */
function readExifPixelDims(exifSegment: Uint8Array): { x: number | null; y: number | null } {
  const tiff = exifSegment.slice(10);
  const little = tiff[0] === 0x49;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd0Offset = dv.getUint32(4, little);
  const count = dv.getUint16(ifd0Offset, little);
  let exifIfdOffset: number | null = null;
  for (let k = 0; k < count; k++) {
    const eOff = ifd0Offset + 2 + k * 12;
    if (dv.getUint16(eOff, little) === 0x8769) exifIfdOffset = dv.getUint32(eOff + 8, little);
  }
  if (exifIfdOffset === null) return { x: null, y: null };
  const c2 = dv.getUint16(exifIfdOffset, little);
  let x: number | null = null;
  let y: number | null = null;
  for (let k = 0; k < c2; k++) {
    const eOff = exifIfdOffset + 2 + k * 12;
    const tag = dv.getUint16(eOff, little);
    const type = dv.getUint16(eOff + 2, little);
    const value = type === 3 ? dv.getUint16(eOff + 8, little) : dv.getUint32(eOff + 8, little);
    if (tag === 0xa002) x = value;
    if (tag === 0xa003) y = value;
  }
  return { x, y };
}

function containsSequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Synthetic segment builders — for cases no fixture covers (IPTC, a
// multi-chunk ICC profile, and an EXIF blob with a real ExifIFD + thumbnail).
// ---------------------------------------------------------------------------

function injectSegmentsAfterSOI(base: Uint8Array, segments: Uint8Array[]): Uint8Array {
  let total = 2;
  for (const s of segments) total += s.length;
  total += base.length - 2;
  const out = new Uint8Array(total);
  out[0] = 0xff;
  out[1] = 0xd8;
  let offset = 2;
  for (const s of segments) {
    out.set(s, offset);
    offset += s.length;
  }
  out.set(base.subarray(2), offset);
  return out;
}

/** Build N APP2/ICC_PROFILE chunk segments whose reassembled payload is `totalProfileBytes` long, capping each chunk's profile-data slice at `chunkPayloadCap` bytes (kept well under the 65533-byte segment ceiling). */
function buildIccChunks(totalProfileBytes: number, chunkPayloadCap: number): Uint8Array[] {
  const profile = new Uint8Array(totalProfileBytes);
  for (let i = 0; i < totalProfileBytes; i++) profile[i] = i % 256;

  const chunkCount = Math.ceil(totalProfileBytes / chunkPayloadCap);
  const segments: Uint8Array[] = [];
  for (let c = 0; c < chunkCount; c++) {
    const start = c * chunkPayloadCap;
    const end = Math.min(start + chunkPayloadCap, totalProfileBytes);
    const slice = profile.subarray(start, end);

    const header = new Uint8Array(14); // "ICC_PROFILE\0" + chunk index (1-based) + chunk count
    header.set(new TextEncoder().encode('ICC_PROFILE'), 0);
    header[11] = 0x00;
    header[12] = c + 1;
    header[13] = chunkCount;

    const payload = new Uint8Array(header.length + slice.length);
    payload.set(header, 0);
    payload.set(slice, header.length);

    const len = payload.length + 2;
    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    seg[2] = (len >> 8) & 0xff;
    seg[3] = len & 0xff;
    seg.set(payload, 4);
    segments.push(seg);
  }
  return segments;
}

/** A minimal Photoshop Image Resource Block carrying one (dummy) IPTC-NAA resource, wrapped as a complete APP13 segment. */
function buildPhotoshopIrbSegment(): Uint8Array {
  const sig = new TextEncoder().encode('Photoshop 3.0');
  const eightBim = new TextEncoder().encode('8BIM');
  const resourceId = new Uint8Array([0x04, 0x04]); // 0x0404 = IPTC-NAA record
  const name = new Uint8Array([0x00, 0x00]); // empty Pascal string, padded to even length
  const data = new TextEncoder().encode('synthetic IPTC payload for round-trip testing');
  const dataPadded = data.length % 2 === 0 ? data : new Uint8Array([...data, 0x00]);
  const dataSize = new Uint8Array(4);
  new DataView(dataSize.buffer).setUint32(0, data.length, false);

  const irb = new Uint8Array(eightBim.length + resourceId.length + name.length + dataSize.length + dataPadded.length);
  let o = 0;
  irb.set(eightBim, o);
  o += eightBim.length;
  irb.set(resourceId, o);
  o += resourceId.length;
  irb.set(name, o);
  o += name.length;
  irb.set(dataSize, o);
  o += dataSize.length;
  irb.set(dataPadded, o);

  const payload = new Uint8Array(sig.length + 1 + irb.length); // +1 for the NUL after "Photoshop 3.0"
  payload.set(sig, 0);
  payload[sig.length] = 0x00;
  payload.set(irb, sig.length + 1);

  const len = payload.length + 2;
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xed;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

/** Hand-built little-endian EXIF: IFD0 has Orientation=6 and an ExifIFD pointer; ExifIFD has PixelXDimension=400/PixelYDimension=600. No thumbnail. */
function buildSyntheticExifWithDims(): Uint8Array {
  const tiff = new Uint8Array(68);
  const dv = new DataView(tiff.buffer);
  tiff[0] = 0x49;
  tiff[1] = 0x49; // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true); // IFD0 at offset 8

  dv.setUint16(8, 2, true); // IFD0: 2 entries
  dv.setUint16(10, 0x0112, true); // Orientation
  dv.setUint16(12, 3, true); // SHORT
  dv.setUint32(14, 1, true); // count 1
  dv.setUint16(18, 6, true); // value 6 (rotate 90 CW)

  dv.setUint16(22, 0x8769, true); // ExifIFD pointer
  dv.setUint16(24, 4, true); // LONG
  dv.setUint32(26, 1, true);
  dv.setUint32(30, 38, true); // ExifIFD at offset 38

  dv.setUint32(34, 0, true); // IFD0 next-IFD offset: none

  dv.setUint16(38, 2, true); // ExifIFD: 2 entries
  dv.setUint16(40, 0xa002, true); // PixelXDimension
  dv.setUint16(42, 4, true); // LONG
  dv.setUint32(44, 1, true);
  dv.setUint32(48, 400, true);

  dv.setUint16(52, 0xa003, true); // PixelYDimension
  dv.setUint16(54, 4, true); // LONG
  dv.setUint32(56, 1, true);
  dv.setUint32(60, 600, true);

  dv.setUint32(64, 0, true); // ExifIFD next-IFD offset: none

  return wrapAsApp1(tiff);
}

const THUMBNAIL_PATTERN = new TextEncoder().encode('UNIQUE_THUMBNAIL_MARKER_');

/** Hand-built little-endian EXIF: IFD0 has Orientation=3 and chains to IFD1, which describes an embedded thumbnail (tags 0x0201/0x0202) with a distinctive byte pattern as its "thumbnail data". */
function buildSyntheticExifWithThumbnail(): Uint8Array {
  const thumb = new Uint8Array(300);
  for (let i = 0; i < thumb.length; i++) {
    thumb[i] = THUMBNAIL_PATTERN[i % THUMBNAIL_PATTERN.length];
  }

  const tiff = new Uint8Array(56 + thumb.length);
  const dv = new DataView(tiff.buffer);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);

  dv.setUint16(8, 1, true); // IFD0: 1 entry
  dv.setUint16(10, 0x0112, true); // Orientation
  dv.setUint16(12, 3, true);
  dv.setUint32(14, 1, true);
  dv.setUint16(18, 3, true); // value 3 (180 degrees)
  dv.setUint32(22, 26, true); // IFD0 next-IFD offset -> IFD1 at 26

  dv.setUint16(26, 2, true); // IFD1: 2 entries
  dv.setUint16(28, 0x0201, true); // JPEGInterchangeFormat (thumbnail offset)
  dv.setUint16(30, 4, true);
  dv.setUint32(32, 1, true);
  dv.setUint32(36, 56, true); // thumbnail data starts at offset 56

  dv.setUint16(40, 0x0202, true); // JPEGInterchangeFormatLength
  dv.setUint16(42, 4, true);
  dv.setUint32(44, 1, true);
  dv.setUint32(48, thumb.length, true);

  dv.setUint32(52, 0, true); // IFD1 next-IFD offset: none

  tiff.set(thumb, 56);

  return wrapAsApp1(tiff);
}

function wrapAsApp1(tiff: Uint8Array): Uint8Array {
  const payload = new Uint8Array(6 + tiff.length);
  payload.set(new TextEncoder().encode('Exif'), 0);
  payload[4] = 0x00;
  payload[5] = 0x00;
  payload.set(tiff, 6);

  const len = payload.length + 2;
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractMetadata', () => {
  it('sees EXIF Orientation=6 on portrait-orientation6.jpg and normalises it to 1 in the extracted segment', () => {
    const src = fixture('portrait-orientation6.jpg');
    const meta = extractMetadata(src);
    expect(meta).not.toBeNull();
    expect(meta!.hadOrientation).toBe(true);
    expect(meta!.exif).toBeDefined();
    expect(readExifOrientation(meta!.exif!)).toBe(1);
  });

  it('extracts the Adobe RGB ICC profile byte-for-byte and identifies it via iccDescription', () => {
    const src = fixture('adobergb-square.jpg');
    const meta = extractMetadata(src);
    expect(meta).not.toBeNull();
    expect(meta!.icc.length).toBeGreaterThan(0);
    expect(meta!.iccDescription).toBe('Adobe RGB (1998)');

    const originalIccSegs = segmentsOf(src, 0xe2);
    expect(meta!.icc).toEqual(originalIccSegs);
  });

  it('returns null for plain JPEGs carrying no EXIF/ICC/IPTC', () => {
    expect(extractMetadata(fixture('square-3000.jpg'))).toBeNull();
    expect(extractMetadata(fixture('landscape-3x2.jpg'))).toBeNull();
  });

  it('returns null for a corrupt/non-JPEG file without throwing', () => {
    const src = fixture('corrupt.jpg');
    expect(() => extractMetadata(src)).not.toThrow();
    expect(extractMetadata(src)).toBeNull();
  });

  it('returns null for a PNG (not a JPEG) without throwing', () => {
    const src = fixture('transparent.png');
    expect(() => extractMetadata(src)).not.toThrow();
    expect(extractMetadata(src)).toBeNull();
  });

  it('drops the embedded EXIF thumbnail (IFD1) entirely, not just its pointer', () => {
    const exifSeg = buildSyntheticExifWithThumbnail();
    const base = fixture('square-3000.jpg');
    const synthetic = injectSegmentsAfterSOI(base, [exifSeg]);

    const meta = extractMetadata(synthetic);
    expect(meta).not.toBeNull();
    expect(meta!.exif).toBeDefined();

    // Orientation still comes through correctly despite IFD1 being dropped.
    expect(readExifOrientation(meta!.exif!)).toBe(1);

    // The rebuilt segment must be dramatically smaller than the source
    // (no ~300-byte thumbnail) and must not contain the thumbnail's
    // distinctive byte pattern anywhere — proving it was excluded, not
    // just orphaned by a zeroed pointer.
    expect(meta!.exif!.length).toBeLessThan(exifSeg.length / 2);
    expect(containsSequence(meta!.exif!, THUMBNAIL_PATTERN)).toBe(false);
  });
});

describe('spliceMetadata', () => {
  it('produces a spliced output where the EXIF Orientation reads 1 (the double-rotation regression test)', () => {
    const src = fixture('portrait-orientation6.jpg');
    const meta = extractMetadata(src)!;
    const encoded = fixture('landscape-3x2.jpg'); // stand-in for a bare canvas-encoded output
    const spliced = spliceMetadata(encoded, meta, { width: 3000, height: 3000 });

    assertFramingAndScanDataPreserved(spliced, encoded);

    const exifSegs = segmentsOf(spliced, 0xe1);
    expect(exifSegs.length).toBe(1);
    expect(readExifOrientation(exifSegs[0])).toBe(1);
  });

  it('round-trips the Adobe RGB ICC profile onto a freshly encoded JPEG', () => {
    const src = fixture('adobergb-square.jpg');
    const meta = extractMetadata(src)!;
    const encoded = fixture('square-3000.jpg');
    const spliced = spliceMetadata(encoded, meta, { width: 3000, height: 3000 });

    assertFramingAndScanDataPreserved(spliced, encoded);

    const splicedIcc = segmentsOf(spliced, 0xe2);
    expect(splicedIcc).toEqual(meta.icc);
  });

  it('is a safe, byte-identical no-op when there is nothing to splice', () => {
    const encoded = fixture('landscape-3x2.jpg');
    const emptyMeta: JpegMetadata = { icc: [], hadOrientation: false };
    const spliced = spliceMetadata(encoded, emptyMeta, { width: 3000, height: 3000 });
    expect(spliced).toEqual(encoded);
  });

  it('never throws on a malformed encoded buffer, and returns it unchanged', () => {
    const garbage = new Uint8Array([0xff, 0xd8, 1, 2, 3]); // SOI followed by nonsense
    const emptyMeta: JpegMetadata = { icc: [], hadOrientation: false };
    expect(() => spliceMetadata(garbage, emptyMeta, { width: 100, height: 100 })).not.toThrow();
    expect(spliceMetadata(garbage, emptyMeta, { width: 100, height: 100 })).toEqual(garbage);
  });

  it('updates PixelXDimension/PixelYDimension to the output size while forcing Orientation to 1', () => {
    const exifSeg = buildSyntheticExifWithDims();
    const base = fixture('square-3000.jpg');
    const synthetic = injectSegmentsAfterSOI(base, [exifSeg]);

    const meta = extractMetadata(synthetic)!;
    expect(meta.hadOrientation).toBe(true);
    // Not yet patched at extraction time — extractMetadata doesn't know the output size.
    expect(readExifPixelDims(meta.exif!)).toEqual({ x: 400, y: 600 });

    const encoded = fixture('landscape-3x2.jpg');
    const spliced = spliceMetadata(encoded, meta, { width: 3000, height: 3000 });
    assertFramingAndScanDataPreserved(spliced, encoded);

    const exifSegs = segmentsOf(spliced, 0xe1);
    expect(exifSegs.length).toBe(1);
    expect(readExifOrientation(exifSegs[0])).toBe(1);
    expect(readExifPixelDims(exifSegs[0])).toEqual({ x: 3000, y: 3000 });
  });

  it('splits a large ICC profile across multiple APP2 chunks and round-trips their order and count', () => {
    const chunkCap = 60000; // per-chunk profile-data cap, comfortably under the 65533-byte segment ceiling
    const totalProfile = 150000; // forces 3 chunks: well over the 65533-byte single-segment limit
    const chunks = buildIccChunks(totalProfile, chunkCap);
    expect(chunks.length).toBe(3);

    const base = fixture('landscape-3x2.jpg');
    const synthetic = injectSegmentsAfterSOI(base, chunks);

    const meta = extractMetadata(synthetic);
    expect(meta).not.toBeNull();
    expect(meta!.icc.length).toBe(3);
    expect(meta!.icc).toEqual(chunks);

    const encoded = fixture('square-3000.jpg');
    const spliced = spliceMetadata(encoded, meta!, { width: 3000, height: 3000 });
    assertFramingAndScanDataPreserved(spliced, encoded);

    const splicedChunks = segmentsOf(spliced, 0xe2);
    expect(splicedChunks).toEqual(chunks);
  });

  it('round-trips a synthetic Photoshop IRB / IPTC APP13 segment', () => {
    const iptcSeg = buildPhotoshopIrbSegment();
    const base = fixture('square-3000.jpg');
    const synthetic = injectSegmentsAfterSOI(base, [iptcSeg]);

    const meta = extractMetadata(synthetic);
    expect(meta).not.toBeNull();
    expect(meta!.iptc).toBeDefined();
    expect(meta!.iptc).toEqual(iptcSeg);

    const encoded = fixture('landscape-3x2.jpg');
    const spliced = spliceMetadata(encoded, meta!, { width: 3000, height: 3000 });
    assertFramingAndScanDataPreserved(spliced, encoded);

    const splicedIptc = segmentsOf(spliced, 0xed);
    expect(splicedIptc.length).toBe(1);
    expect(splicedIptc[0]).toEqual(iptcSeg);
  });

  it('strips any APP1/APP2 the encoder itself emitted before inserting the preserved segments', () => {
    // Simulate a canvas encoder that (unusually) emitted its own APP1/APP2 —
    // spliceMetadata must remove those, not stack ours on top.
    const foreignExif = wrapAsApp1(new Uint8Array(8)); // garbage TIFF, only used to prove removal
    const encodedBase = fixture('square-3000.jpg');
    const encodedWithForeignSegments = injectSegmentsAfterSOI(encodedBase, [foreignExif]);

    const src = fixture('portrait-orientation6.jpg');
    const meta = extractMetadata(src)!;
    const spliced = spliceMetadata(encodedWithForeignSegments, meta, { width: 3000, height: 3000 });

    const exifSegs = segmentsOf(spliced, 0xe1);
    expect(exifSegs.length).toBe(1); // only ours, the foreign one was stripped
    expect(readExifOrientation(exifSegs[0])).toBe(1);
  });
});
