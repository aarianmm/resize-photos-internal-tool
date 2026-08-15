/**
 * Shared contracts between the UI, the worker pool, the metadata splicer and
 * the ZIP fallback. Every module in src/ conforms to what is declared here —
 * change a type in this file and you are changing an interface between
 * modules, so do it deliberately.
 */

/** Hard target. Non-square sources are stretched, never padded or cropped. */
export const TARGET_WIDTH = 3000;
export const TARGET_HEIGHT = 3000;

/** JPEG re-encode quality. See PLAN.md §2. */
export const JPEG_QUALITY = 0.92;

/**
 * Extensions we can both decode AND re-encode, so output keeps the source's
 * format and filename. Anything else is triaged out before work starts.
 */
export const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

/**
 * Formats browsers can decode but `convertToBlob` cannot write back. We could
 * resize these and emit JPEG bytes, but only under the original filename —
 * producing a `.gif` that is secretly a JPEG. Silently mislabelled files are
 * worse than a clearly reported skip, and the promise in PLAN.md §2 is that
 * format and filename are both unchanged. So we skip and say why.
 */
export const DECODE_ONLY_EXTENSIONS = ['.bmp', '.gif', '.avif'] as const;

/** Extensions we expect to meet and know we cannot handle, so we can say why. */
export const KNOWN_UNSUPPORTED_EXTENSIONS = ['.tif', '.tiff', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.psd'] as const;

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** One file found in the chosen folder, already triaged. */
export interface ScannedFile {
  /** Filename including extension, exactly as on disk. Never modified. */
  name: string;
  /** Handle in the input directory. Present on the File System Access path. */
  handle?: FileSystemFileHandle;
  /** Direct File. Present on the <input webkitdirectory> fallback path. */
  file?: File;
  size: number;
}

export interface ScanResult {
  /** Files we will process, in stable alphabetical order. */
  images: ScannedFile[];
  /** Files we will not process, with a plain-English reason for the user. */
  skipped: { name: string; reason: string }[];
  /** Names already present in the output directory (collision check). */
  existingOutputNames: Set<string>;
}

/** What to do when an output file of the same name already exists. */
export type CollisionPolicy = 'overwrite' | 'skip';

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

/** Main thread -> worker. One message per image. */
export interface ResizeRequest {
  id: number;
  name: string;
  /** The source bytes. Transferred, not copied. */
  file: File;
  /** Output MIME type, derived from the source extension. */
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  quality: number;
}

/** Worker -> main thread. Exactly one per request. */
export type ResizeResponse =
  | {
      id: number;
      name: string;
      ok: true;
      /** Encoded output, metadata already spliced in where applicable. */
      blob: Blob;
      /** True when EXIF/ICC were carried over from the source. */
      metadataPreserved: boolean;
    }
  | {
      id: number;
      name: string;
      ok: false;
      /** Message safe to show a non-technical user. */
      reason: string;
    };

// ---------------------------------------------------------------------------
// Results / reporting
// ---------------------------------------------------------------------------

export type FileStatus = 'ok' | 'skipped' | 'failed';

export interface FileOutcome {
  name: string;
  status: FileStatus;
  /** Present for 'skipped' and 'failed'. */
  reason?: string;
  bytesIn?: number;
  bytesOut?: number;
  metadataPreserved?: boolean;
}

export interface BatchSummary {
  outcomes: FileOutcome[];
  okCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// JPEG metadata (implemented in src/jpeg-metadata.ts)
// ---------------------------------------------------------------------------

/**
 * Marker segments lifted from a source JPEG, ready to splice onto a
 * canvas-encoded output. Each entry is a complete segment including its
 * 0xFF marker byte and 2-byte length field.
 */
export interface JpegMetadata {
  /** APP1 / EXIF, with Orientation normalised to 1 and dimensions updated. */
  exif?: Uint8Array;
  /** APP2 / ICC_PROFILE. May be several chunks; kept in original order. */
  icc: Uint8Array[];
  /** APP13 / Photoshop IPTC. */
  iptc?: Uint8Array;
  /** True when the source declared an orientation other than 1. */
  hadOrientation: boolean;
  /** Colour space named by the ICC profile description, when identifiable. */
  iccDescription?: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type OutputMode = 'directory' | 'zip';

export interface Capabilities {
  /** showDirectoryPicker + writable streams: the good path. */
  fileSystemAccess: boolean;
  /** <input webkitdirectory>: the fallback read path. */
  directoryInput: boolean;
  offscreenCanvas: boolean;
  outputMode: OutputMode;
  /** Non-null when the browser needs a warning shown up front. */
  warning: string | null;
}
