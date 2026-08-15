import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZipWriter, crc32, MAX_SAFE_ZIP_BYTES } from '../src/zip';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Plain byte-for-byte equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

/** A WritableStream that just collects everything written to it in order. */
function createCollectingSink() {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return { stream, chunks };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Build a complete archive in memory from a list of [name, bytes] entries. */
async function buildArchive(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  const { stream, chunks } = createCollectingSink();
  const writer = new ZipWriter(stream.getWriter());
  for (const [name, data] of entries) {
    await writer.add(name, data);
  }
  await writer.finish();
  return concat(chunks);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Write archive bytes to a temp .zip file and return its path. */
function writeArchiveToDisk(bytes: Uint8Array): string {
  const dir = makeTempDir();
  const zipPath = join(dir, 'archive.zip');
  writeFileSync(zipPath, bytes);
  return zipPath;
}

/** Extract a zip file with the system `unzip` binary; returns the extraction dir. */
function extractWithSystemUnzip(zipPath: string): string {
  const dir = makeTempDir();
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir]);
  return dir;
}

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

describe('crc32', () => {
  it('matches the standard test vector for "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('is deterministic and content-sensitive', () => {
    const a = new TextEncoder().encode('hello world');
    const b = new TextEncoder().encode('hello worlD');
    expect(crc32(a)).toBe(crc32(a));
    expect(crc32(a)).not.toBe(crc32(b));
  });
});

// ---------------------------------------------------------------------------
// Empty and single-entry archives
// ---------------------------------------------------------------------------

describe('empty archive', () => {
  it('produces a spec-correct minimal EOCD-only archive', async () => {
    const bytes = await buildArchive([]);
    // Just the 22-byte EOCD record, no local headers, no central directory,
    // every count field zeroed. Confirmed byte-for-byte identical to what
    // Python's stdlib zipfile produces for an empty archive.
    expect(bytes.length).toBe(22);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x06054b50); // EOCD signature
    expect(view.getUint16(8, true)).toBe(0); // entries on this disk
    expect(view.getUint16(10, true)).toBe(0); // total entries
    expect(view.getUint32(12, true)).toBe(0); // central directory size
    expect(view.getUint32(16, true)).toBe(0); // central directory offset

    // A zero-entry zip is a recognized edge case: even genuine tools (e.g.
    // Python's zipfile) produce byte-identical output, and the system
    // `unzip` warns "zipfile is empty" with a non-zero exit code for any
    // such archive, real or ours — that's expected behaviour, not a defect.
    const zipPath = writeArchiveToDisk(bytes);
    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync('unzip', ['-l', zipPath]).toString();
    } catch (err) {
      const e = err as { status: number; stdout: Uint8Array; stderr: Uint8Array };
      exitCode = e.status;
      output = e.stdout.toString() + e.stderr.toString();
    }
    expect(exitCode).toBe(1);
    expect(output).toContain('zipfile is empty');
  });
});

describe('single-entry archive', () => {
  it('round-trips one fixture file byte-for-byte through real unzip', async () => {
    const original = readFixture('square-3000.jpg');
    const bytes = await buildArchive([['square-3000.jpg', original]]);

    const zipPath = writeArchiveToDisk(bytes);

    // Integrity check via the real unzip tool.
    const testOutput = execFileSync('unzip', ['-t', zipPath]).toString();
    expect(testOutput).toMatch(/No errors detected/);

    const extractDir = extractWithSystemUnzip(zipPath);
    const extracted = readFileSync(join(extractDir, 'square-3000.jpg'));
    expect(bytesEqual(extracted, original)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-entry archive with real fixture bytes, including the accented /
// spaced filenames called out in PLAN.md as the classic gotcha.
// ---------------------------------------------------------------------------

describe('multi-entry archive with unzip verification', () => {
  const fixtureNames = [
    'square-3000.jpg',
    'landscape-3x2.jpg',
    'portrait-orientation6.jpg',
    'adobergb-square.jpg',
    'transparent.png',
    'CARAMELCAFÉ.jpg',
    'OFF WHITE 90H.jpg',
  ];

  async function buildFixtureArchive() {
    const entries: [string, Uint8Array][] = fixtureNames.map((name) => [name, readFixture(name)]);
    const bytes = await buildArchive(entries);
    const zipPath = writeArchiveToDisk(bytes);
    return zipPath;
  }

  it('passes unzip -t integrity check', async () => {
    const zipPath = await buildFixtureArchive();
    const output = execFileSync('unzip', ['-t', zipPath]).toString();
    expect(output).toMatch(/No errors detected/);
  });

  it('lists every entry via unzip -l', async () => {
    const zipPath = await buildFixtureArchive();
    const listing = execFileSync('unzip', ['-l', zipPath]).toString();
    expect(listing).toContain('7 files');

    // ASCII-safe names round-trip through -l's own text formatting cleanly.
    // The accented name (CARAMELCAFÉ.jpg) is deliberately not asserted
    // here: this specific macOS-bundled Info-ZIP build has a display-only
    // bug in its `-l` listing formatter for non-ASCII bytes (it prints
    // "CARAMELCAF\xC3?.jpg" — the raw UTF-8 lead byte followed by a
    // literal '?'), even though the archive's central directory holds the
    // correct UTF-8 name. This is cosmetic to `-l`'s stdout formatting,
    // not an archive defect: the "extracts every file byte-identical"
    // test below proves the same build's actual *extraction* path (the
    // one that matters — it creates the real file on disk) decodes and
    // creates CARAMELCAFÉ.jpg correctly.
    for (const name of fixtureNames) {
      if (/^[\x20-\x7e]*$/.test(name)) {
        expect(listing).toContain(name);
      }
    }
  });

  it('extracts every file byte-identical to the source, with names intact', async () => {
    const zipPath = await buildFixtureArchive();
    const extractDir = extractWithSystemUnzip(zipPath);

    // macOS filesystems may hand back filenames in a different Unicode
    // normalization form (NFD) than the UTF-8 bytes we wrote (NFC), even
    // though the underlying characters are the same. Normalize before
    // comparing so this test verifies content, not incidental encoding.
    const extractedNames = readdirSync(extractDir).map((n) => n.normalize('NFC'));
    for (const name of fixtureNames) {
      expect(extractedNames).toContain(name.normalize('NFC'));
    }

    for (const name of fixtureNames) {
      const original = readFixture(name);
      const onDiskName = readdirSync(extractDir).find((n) => n.normalize('NFC') === name.normalize('NFC'));
      expect(onDiskName).toBeDefined();
      const extracted = readFileSync(join(extractDir, onDiskName!));
      expect(bytesEqual(extracted, original)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard rails: entry count and total size limits (no Zip64 in v1)
// ---------------------------------------------------------------------------

describe('size and count guard rails', () => {
  it('rejects adding an entry once the 65535 entry-count limit is reached', async () => {
    const { stream } = createCollectingSink();
    const writer = new ZipWriter(stream.getWriter());

    // Directly seed the entry count to the limit rather than performing
    // 65535 real writes, which would make this test needlessly slow. The
    // writer only checks entries.length before doing any work, so this
    // exercises exactly the guard the real path would hit.
    (writer as unknown as { entries: unknown[] }).entries.length = 65535;

    await expect(writer.add('one-too-many.jpg', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /maximum 65535 entries/,
    );
  });

  it('rejects an entry that would push the archive past MAX_SAFE_ZIP_BYTES', async () => {
    const { stream } = createCollectingSink();
    const writer = new ZipWriter(stream.getWriter());

    // Fast-forward the internal offset to just under the limit instead of
    // actually streaming 4 GiB of data through the test.
    (writer as unknown as { offset: number }).offset = MAX_SAFE_ZIP_BYTES - 10;

    const tooBig = new Uint8Array(1000);
    await expect(writer.add('huge.jpg', tooBig)).rejects.toThrow(/4 GiB/);
  });

  it('does not mutate state when a guard rail rejects the entry', async () => {
    const { stream } = createCollectingSink();
    const writer = new ZipWriter(stream.getWriter());
    (writer as unknown as { entries: unknown[] }).entries.length = 65535;

    await expect(writer.add('rejected.jpg', new Uint8Array([1]))).rejects.toThrow();
    // The entry count guard should still trip identically on a second call
    // (i.e. the failed add didn't accidentally get appended).
    expect((writer as unknown as { entries: unknown[] }).entries.length).toBe(65535);
  });

  it('MAX_SAFE_ZIP_BYTES is exactly 4 GiB - 1', () => {
    expect(MAX_SAFE_ZIP_BYTES).toBe(4 * 1024 * 1024 * 1024 - 1);
  });
});

// ---------------------------------------------------------------------------
// Duplicate names and lifecycle
// ---------------------------------------------------------------------------

describe('duplicate entry names', () => {
  it('rejects a second add() with a name already used', async () => {
    const { stream } = createCollectingSink();
    const writer = new ZipWriter(stream.getWriter());
    await writer.add('same.jpg', new Uint8Array([1, 2, 3]));
    await expect(writer.add('same.jpg', new Uint8Array([4, 5, 6]))).rejects.toThrow(/duplicate/i);
  });
});

describe('writer lifecycle', () => {
  it('rejects add() after finish() has been called', async () => {
    const { stream } = createCollectingSink();
    const writer = new ZipWriter(stream.getWriter());
    await writer.add('a.jpg', new Uint8Array([1]));
    await writer.finish();
    await expect(writer.add('b.jpg', new Uint8Array([2]))).rejects.toThrow();
  });

  it('finish() is idempotent (a second call does not throw)', async () => {
    const { stream } = createCollectingSink();
    const writer = new ZipWriter(stream.getWriter());
    await writer.add('a.jpg', new Uint8Array([1]));
    await writer.finish();
    await expect(writer.finish()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UTF-8 / language-encoding flag
// ---------------------------------------------------------------------------

describe('UTF-8 filename encoding', () => {
  it('sets bit 11 of the general purpose flag in both local and central headers', async () => {
    const bytes = await buildArchive([['CARAMELCAFÉ.jpg', new Uint8Array([1, 2, 3])]]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Local file header general purpose flag is at offset 6.
    const localFlag = view.getUint16(6, true);
    expect(localFlag & (1 << 11)).not.toBe(0);

    // Find the central directory header signature (0x02014b50) and check
    // its general purpose flag at relative offset 8.
    let cdOffset = -1;
    for (let i = 0; i < bytes.length - 4; i++) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x01 &&
        bytes[i + 3] === 0x02
      ) {
        cdOffset = i;
        break;
      }
    }
    expect(cdOffset).toBeGreaterThan(-1);
    const cdFlag = view.getUint16(cdOffset + 8, true);
    expect(cdFlag & (1 << 11)).not.toBe(0);
  });
});
