/**
 * Store-only (uncompressed) streaming ZIP writer.
 *
 * Why store-only: this writer exists purely for the Firefox/Safari fallback
 * path (PLAN.md §4.5), and its entries are already-compressed JPEGs/PNGs.
 * Deflating them again would cost CPU for ~0 size benefit, so every entry is
 * written with compression method 0 and no dependency on a deflate library.
 *
 * Streaming: add() writes the local file header + entry bytes straight to
 * the sink as soon as it is called, so a caller processing a 500-image batch
 * never has to hold more than one entry in memory at a time. Only the small
 * per-entry central-directory records (name + a handful of numbers) are
 * buffered, to be flushed by finish().
 *
 * No dependencies, no DOM APIs, no Node APIs — just Uint8Array and the Web
 * Streams `WritableStreamDefaultWriter`, which exists in every modern
 * browser and (as of Node 18+) under Node/vitest too.
 *
 * ---------------------------------------------------------------------
 * ZIP binary layout reference (all multi-byte integers little-endian):
 *
 * Local file header (one per entry, immediately before its data):
 *   offset  size  field
 *   0       4     signature                 0x04034b50
 *   4       2     version needed to extract
 *   6       2     general purpose bit flag  (bit 11 = UTF-8 name/comment)
 *   8       2     compression method        0 = store
 *   10      2     last mod file time        (MS-DOS time)
 *   12      2     last mod file date        (MS-DOS date)
 *   14      4     CRC-32
 *   18      4     compressed size
 *   22      4     uncompressed size
 *   26      2     file name length (n)
 *   28      2     extra field length (m)
 *   30      n     file name
 *   30+n    m     extra field
 *   -- entry bytes follow directly after --
 *
 * Central directory file header (one per entry, all together at the end):
 *   offset  size  field
 *   0       4     signature                 0x02014b50
 *   4       2     version made by
 *   6       2     version needed to extract
 *   8       2     general purpose bit flag
 *   10      2     compression method
 *   12      2     last mod file time
 *   14      2     last mod file date
 *   16      4     CRC-32
 *   20      4     compressed size
 *   24      4     uncompressed size
 *   28      2     file name length (n)
 *   30      2     extra field length (m)
 *   32      2     file comment length (k)
 *   34      2     disk number start
 *   36      2     internal file attributes
 *   38      4     external file attributes
 *   42      4     relative offset of local header
 *   46      n     file name
 *   46+n    m     extra field
 *   46+n+m  k     file comment
 *
 * End of central directory record (EOCD, once, at the very end):
 *   offset  size  field
 *   0       4     signature                 0x06054b50
 *   4       2     number of this disk
 *   6       2     disk where CD starts
 *   8       2     number of CD records on this disk
 *   10      2     total number of CD records
 *   12      4     size of central directory (bytes)
 *   16      4     offset of start of CD, relative to start of archive
 *   20      2     comment length
 * ---------------------------------------------------------------------
 *
 * UTF-8 filename compatibility note: setting general-purpose bit 11 (the
 * "language encoding flag" / EFS bit) is the modern, spec-correct way to
 * say "the name field is UTF-8". In practice, macOS's bundled `unzip`
 * (Info-ZIP 6.00 with Apple modifications) does not reliably honour that
 * bit and instead falls back to decoding the name as if it were CP437,
 * silently mangling anything outside ASCII (verified against a real
 * `CARAMELCAFÉ.jpg` fixture — see test/zip.test.ts). The fix, used by
 * every zip writer that cares about old Info-ZIP compatibility, is to
 * *also* emit an Info-ZIP "Unicode Path" extra field (header ID 0x7075)
 * alongside the name in both the local and central directory headers.
 * Tools that don't understand bit 11 but do understand this legacy extra
 * field (which is most of them, including Apple's unzip) use it instead.
 * We set both, belt and braces:
 *
 * Info-ZIP Unicode Path extra field (per entry):
 *   offset  size  field
 *   0       2     header ID                 0x7075
 *   2       2     data size (5 + n)
 *   4       1     version                   1
 *   5       4     CRC-32 of the name field bytes (as stored, i.e. our
 *                 UTF-8 encoding — lets the reader confirm this extra
 *                 field still matches the name field it's attached to)
 *   9       n     UTF-8 file name (no trailing NUL)
 */

// ---------------------------------------------------------------------------
// Limits (requirement 6: no Zip64 in v1 — reject instead of emitting a
// corrupt archive once the classic ZIP format's 32-bit fields would overflow)
// ---------------------------------------------------------------------------

/** Largest total archive size the classic (non-Zip64) format can address. */
export const MAX_SAFE_ZIP_BYTES = 4 * 1024 * 1024 * 1024 - 1; // 4 GiB - 1

/** Classic ZIP central directory record/entry counts are 16-bit fields. */
const MAX_ENTRIES = 65535;

/**
 * External file attributes for a regular file, `-rw-r--r--` (unix mode
 * 0o100644), packed into the high 16 bits the way `version made by` = UNIX
 * host tells readers to interpret this field. Needed because setting the
 * UNIX host byte (see finish() below) makes Info-ZIP-derived readers treat
 * this field as a permission bit mask rather than ignoring it — leaving it
 * 0 extracts every file with mode 000 (unreadable).
 */
const UNIX_REGULAR_FILE_ATTR = (0o100644 << 16) >>> 0;

// ---------------------------------------------------------------------------
// CRC-32 (standard IEEE 802.3 polynomial, table built once at module load)
// ---------------------------------------------------------------------------

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 of `data`, IEEE polynomial, matches every standard zip tool. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// MS-DOS date/time encoding
// ---------------------------------------------------------------------------

/**
 * Pack a JS Date into MS-DOS time/date fields. DOS dates start at 1980 and
 * dates before that clamp to the epoch; DOS time has 2-second resolution.
 */
function toDosDateTime(date: Date): { time: number; date: number } {
  let year = date.getFullYear();
  if (year < 1980) year = 1980;

  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { time: dosTime & 0xffff, date: dosDate & 0xffff };
}

// ---------------------------------------------------------------------------
// Little-endian byte writers
// ---------------------------------------------------------------------------

function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * Build the Info-ZIP Unicode Path extra field for one entry (see the
 * compatibility note in the module header comment above).
 */
function buildUnicodePathExtraField(nameBytes: Uint8Array): Uint8Array {
  const field = new Uint8Array(9 + nameBytes.length);
  const view = new DataView(field.buffer);
  writeUint16LE(view, 0, 0x7075); // header ID: Info-ZIP Unicode Path
  writeUint16LE(view, 2, 5 + nameBytes.length); // data size
  field[4] = 1; // version
  writeUint32LE(view, 5, crc32(nameBytes)); // CRC-32 of the name field bytes
  field.set(nameBytes, 9);
  return field;
}

// ---------------------------------------------------------------------------
// Central directory bookkeeping
// ---------------------------------------------------------------------------

interface CentralDirEntry {
  nameBytes: Uint8Array;
  extraField: Uint8Array;
  crc: number;
  size: number;
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
}

const textEncoder = new TextEncoder();

export class ZipWriter {
  private readonly sink: WritableStreamDefaultWriter<Uint8Array>;
  private readonly entries: CentralDirEntry[] = [];
  private readonly usedNames = new Set<string>();
  private offset = 0; // running byte position in the archive being streamed
  private finished = false;

  constructor(sink: WritableStreamDefaultWriter<Uint8Array>) {
    this.sink = sink;
  }

  /**
   * Add one entry, streaming its local file header and bytes to the sink
   * immediately. Rejects (without writing anything for this entry) if doing
   * so would exceed the classic ZIP format's limits, or if the entry count
   * is already at the 16-bit maximum.
   *
   * Duplicate names: rather than silently overwriting one entry's directory
   * record with another's (which produces an archive most unzip tools will
   * only partially extract), a duplicate name is rejected outright. Callers
   * that need "last write wins" behaviour should de-duplicate names before
   * calling add().
   */
  async add(name: string, data: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new Error(`ZipWriter: cannot add "${name}" after finish() has been called.`);
    }

    if (this.usedNames.has(name)) {
      throw new Error(
        `ZipWriter: duplicate entry name "${name}". Each archive entry needs a unique name; ` +
          `rename or skip this file before adding it.`,
      );
    }

    if (this.entries.length >= MAX_ENTRIES) {
      throw new Error(
        `ZipWriter: cannot add "${name}" — archive already has the maximum ${MAX_ENTRIES} entries ` +
          `that the ZIP format supports without Zip64 (not implemented). Split the batch into ` +
          `multiple downloads.`,
      );
    }

    const nameBytes = textEncoder.encode(name);
    const extraField = buildUnicodePathExtraField(nameBytes);

    // Local header (30 bytes fixed) + name + extra field + entry bytes, all
    // about to be appended to the archive at the current offset.
    const localHeaderOffset = this.offset;
    const projectedTotal = this.offset + 30 + nameBytes.length + extraField.length + data.length;
    if (projectedTotal > MAX_SAFE_ZIP_BYTES) {
      throw new Error(
        `ZipWriter: adding "${name}" would push the archive past ${MAX_SAFE_ZIP_BYTES} bytes ` +
          `(4 GiB), which the ZIP format needs Zip64 extensions to address — not implemented in ` +
          `this build. Split the batch into multiple smaller downloads.`,
      );
    }

    const crc = crc32(data);
    const { time: dosTime, date: dosDate } = toDosDateTime(new Date());

    const header = new Uint8Array(30 + nameBytes.length + extraField.length);
    const view = new DataView(header.buffer);

    writeUint32LE(view, 0, 0x04034b50); // local file header signature
    writeUint16LE(view, 4, 20); // version needed to extract (2.0)
    writeUint16LE(view, 6, 1 << 11); // general purpose flag: bit 11 = UTF-8 name
    writeUint16LE(view, 8, 0); // compression method: store
    writeUint16LE(view, 10, dosTime);
    writeUint16LE(view, 12, dosDate);
    writeUint32LE(view, 14, crc);
    writeUint32LE(view, 18, data.length); // compressed size == uncompressed (store)
    writeUint32LE(view, 22, data.length);
    writeUint16LE(view, 26, nameBytes.length);
    writeUint16LE(view, 28, extraField.length);
    header.set(nameBytes, 30);
    header.set(extraField, 30 + nameBytes.length);

    await this.sink.write(header);
    if (data.length > 0) {
      await this.sink.write(data);
    }

    this.offset = projectedTotal;
    this.usedNames.add(name);
    this.entries.push({
      nameBytes,
      extraField,
      crc,
      size: data.length,
      dosTime,
      dosDate,
      localHeaderOffset,
    });
  }

  /**
   * Write the central directory + end-of-central-directory record, then
   * close the sink. After this resolves, no more entries can be added.
   */
  async finish(): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;

    const cdStart = this.offset;

    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.nameBytes.length + entry.extraField.length);
      const view = new DataView(record.buffer);

      writeUint32LE(view, 0, 0x02014b50); // central directory file header signature
      // Version made by: low byte = spec version (20 = 2.0), high byte =
      // host system. This MUST be UNIX (3), not the default MS-DOS/FAT (0):
      // verified against a real fixture that macOS's bundled Info-ZIP
      // `unzip` decodes the UTF-8 name field correctly (honouring bit 11,
      // below) only when the host byte says UNIX. With host = MS-DOS it
      // silently falls back to OEM/CP437 decoding and mangles anything
      // outside ASCII, regardless of the UTF-8 flag or the Unicode Path
      // extra field. See test/zip.test.ts for the accented-filename proof.
      writeUint16LE(view, 4, (3 << 8) | 20); // version made by: UNIX host, spec 2.0
      writeUint16LE(view, 6, 20); // version needed to extract
      writeUint16LE(view, 8, 1 << 11); // general purpose flag: UTF-8 name
      writeUint16LE(view, 10, 0); // compression method: store
      writeUint16LE(view, 12, entry.dosTime);
      writeUint16LE(view, 14, entry.dosDate);
      writeUint32LE(view, 16, entry.crc);
      writeUint32LE(view, 20, entry.size);
      writeUint32LE(view, 24, entry.size);
      writeUint16LE(view, 28, entry.nameBytes.length);
      writeUint16LE(view, 30, entry.extraField.length);
      writeUint16LE(view, 32, 0); // file comment length
      writeUint16LE(view, 34, 0); // disk number start
      writeUint16LE(view, 36, 0); // internal file attributes
      writeUint32LE(view, 38, UNIX_REGULAR_FILE_ATTR); // external file attributes: -rw-r--r--
      writeUint32LE(view, 42, entry.localHeaderOffset);
      record.set(entry.nameBytes, 46);
      record.set(entry.extraField, 46 + entry.nameBytes.length);

      await this.sink.write(record);
      this.offset += record.length;
    }

    const cdSize = this.offset - cdStart;

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    writeUint32LE(eocdView, 0, 0x06054b50); // EOCD signature
    writeUint16LE(eocdView, 4, 0); // number of this disk
    writeUint16LE(eocdView, 6, 0); // disk where CD starts
    writeUint16LE(eocdView, 8, this.entries.length); // CD records on this disk
    writeUint16LE(eocdView, 10, this.entries.length); // total CD records
    writeUint32LE(eocdView, 12, cdSize);
    writeUint32LE(eocdView, 16, cdStart);
    writeUint16LE(eocdView, 20, 0); // comment length

    await this.sink.write(eocd);
    this.offset += eocd.length;

    await this.sink.close();
  }
}
