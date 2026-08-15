/**
 * Directory traversal, format triage and collision detection.
 *
 * Scanning is strictly read-only: nothing here creates or writes a file or
 * folder. The one exception that might look like a write — checking whether
 * an output folder already has files in it — is done with a `create: false`
 * lookup, so a folder that doesn't exist yet is simply reported as empty
 * rather than being created.
 */

import type { ScannedFile, ScanResult } from './types';
import {
  SUPPORTED_EXTENSIONS,
  KNOWN_UNSUPPORTED_EXTENSIONS,
  DECODE_ONLY_EXTENSIONS,
  SCAN_EXCLUDED_TOP_LEVEL,
  OUTPUT_PATH_SEGMENTS,
  MAX_SCAN_DEPTH,
} from './types';

// ---------------------------------------------------------------------------
// Ambient types for the File System Access API surface TypeScript's bundled
// lib.dom.d.ts doesn't (yet) ship: the global pickers, directory iteration,
// and permission methods. These augment the global scope for the whole
// program (tsconfig can't be touched), scoped narrowly to what we actually
// call.
// ---------------------------------------------------------------------------

export interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | string;
}

export type FileSystemPermissionState = 'granted' | 'denied' | 'prompt';

declare global {
  function showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    keys(): AsyncIterableIterator<string>;
    values(): AsyncIterableIterator<FileSystemHandle>;
    [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemPermissionState>;
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemPermissionState>;
  }

  interface DataTransferItem {
    getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
  }
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/** OS-generated clutter that shows up in real folders. Skipped without comment. */
const OS_JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);

const UNSUPPORTED_REASONS: Record<string, string> = {
  '.tif': "TIF files can't be opened by web browsers.",
  '.tiff': "TIFF files can't be opened by web browsers.",
  '.heic': "HEIC files (the format iPhones save photos in) can't be opened by web browsers.",
  '.heif': "HEIF files can't be opened by web browsers.",
  '.raw': "RAW camera files can't be opened by web browsers.",
  '.cr2': "Canon RAW (.cr2) files can't be opened by web browsers.",
  '.nef': "Nikon RAW (.nef) files can't be opened by web browsers.",
  '.arw': "Sony RAW (.arw) files can't be opened by web browsers.",
  '.dng': "DNG RAW files can't be opened by web browsers.",
  '.psd': "Photoshop (.psd) files can't be opened by web browsers.",
};

/**
 * Browsers can open these but can't save them back out, and we won't write
 * JPEG bytes under a .gif/.bmp name. See DECODE_ONLY_EXTENSIONS in types.ts.
 */
const DECODE_ONLY_REASON = (ext: string): string =>
  `${ext.slice(1).toUpperCase()} files can't be saved back out by web browsers. Convert this one to JPEG first, then run it again.`;

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return ''; // no extension, or a dotfile like ".gitignore"
  return name.slice(dot).toLowerCase();
}

const SUPPORTED_SET = new Set<string>(SUPPORTED_EXTENSIONS);
const KNOWN_UNSUPPORTED_SET = new Set<string>(KNOWN_UNSUPPORTED_EXTENSIONS);
const DECODE_ONLY_SET = new Set<string>(DECODE_ONLY_EXTENSIONS);

/** Decide what to do with one filename. Returns null for files to process. */
function triageOne(name: string): string | null {
  const lower = name.toLowerCase();
  if (OS_JUNK_NAMES.has(lower)) return 'JUNK'; // sentinel: skip silently
  const ext = getExtension(name);
  if (SUPPORTED_SET.has(ext)) return null;
  if (DECODE_ONLY_SET.has(ext)) return DECODE_ONLY_REASON(ext);
  if (KNOWN_UNSUPPORTED_SET.has(ext)) return UNSUPPORTED_REASONS[ext] ?? "This file type can't be opened by web browsers.";
  if (ext === '') return "This file doesn't look like an image (no file extension).";
  return `${ext.toUpperCase()} files aren't a type this tool recognizes as an image.`;
}

function byNameAlphabetical(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** Groups a folder's images together and keeps folders in a predictable order. */
function byPathAlphabetical(a: { relativePath: string }, b: { relativePath: string }): number {
  return a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' });
}

const EXCLUDED_TOP_LEVEL_SET = new Set<string>(SCAN_EXCLUDED_TOP_LEVEL);

/** A file plus its path relative to the chosen root, for APIs that don't carry one. */
export interface FileWithPath {
  file: File;
  relativePath: string;
}

// ---------------------------------------------------------------------------
// File System Access path
// ---------------------------------------------------------------------------

/**
 * Walk a directory handle recursively, collecting every image beneath it and
 * recording each one's path relative to the root that was chosen.
 *
 * The tool's own output folder is never descended into — `resized`, plus
 * `done` from an interim version that nested output as `done/resized`.
 * Scanning those would mean re-resizing our own output on a second run.
 *
 * Depth is capped at MAX_SCAN_DEPTH. Handle-based traversal can't follow a
 * symlink loop the way a filesystem walk can, but a cap costs nothing and
 * turns a pathological tree into a partial result rather than a hung tab.
 */
export async function scanEntries(
  dir: FileSystemDirectoryHandle,
): Promise<{ images: ScannedFile[]; skipped: { name: string; reason: string }[]; folderCount: number }> {
  const images: ScannedFile[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const foldersWithImages = new Set<string>();

  async function walk(current: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return;

    for await (const [name, handle] of current.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;

      if (handle.kind === 'directory') {
        // Only the top level is excluded: a subfolder legitimately called
        // "done" deeper in someone's tree is their data, not our output.
        if (depth === 0 && EXCLUDED_TOP_LEVEL_SET.has(name.toLowerCase())) continue;
        await walk(handle as FileSystemDirectoryHandle, relativePath, depth + 1);
        continue;
      }

      const reason = triageOne(name);
      if (reason === null) {
        const fileHandle = handle as FileSystemFileHandle;
        let size = 0;
        try {
          const f = await fileHandle.getFile();
          size = f.size;
        } catch {
          // Metadata read failed; still list the file, worker will surface
          // the real error at resize time rather than dropping it silently.
        }
        images.push({ name, relativePath, handle: fileHandle, size });
        foldersWithImages.add(prefix);
      } else if (reason !== 'JUNK') {
        skipped.push({ name: relativePath, reason });
      }
    }
  }

  await walk(dir, '', 0);

  images.sort(byPathAlphabetical);
  skipped.sort(byNameAlphabetical);
  return { images, skipped, folderCount: foldersWithImages.size };
}

/**
 * Read-only lookup of the default `resized` output folder inside the chosen
 * input folder. Returns null if it doesn't exist yet — nothing is created
 * here, only when the user confirms the batch.
 */
export async function findDefaultOutputDir(inputDir: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  let current = inputDir;
  for (const segment of OUTPUT_PATH_SEGMENTS) {
    try {
      current = await current.getDirectoryHandle(segment, { create: false });
    } catch {
      return null;
    }
  }
  return current;
}

/**
 * Relative paths of files already in a (possibly nonexistent) output folder.
 * Recursive, so a collision is detected at the same path the write would use.
 */
export async function getExistingNames(dir: FileSystemDirectoryHandle | null): Promise<Set<string>> {
  const names = new Set<string>();
  if (!dir) return names;

  async function walk(current: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return;
    for await (const [name, handle] of current.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') {
        names.add(relativePath);
      } else {
        await walk(handle as FileSystemDirectoryHandle, relativePath, depth + 1);
      }
    }
  }

  await walk(dir, '', 0);
  return names;
}

/** Full read-only scan: triaged file list plus collision check against outputDir. */
export async function scanDirectory(
  inputDir: FileSystemDirectoryHandle,
  outputDir: FileSystemDirectoryHandle | null,
): Promise<ScanResult> {
  const [{ images, skipped, folderCount }, existingOutputNames] = await Promise.all([
    scanEntries(inputDir),
    getExistingNames(outputDir),
  ]);
  return { images, skipped, existingOutputNames, folderCount };
}

// ---------------------------------------------------------------------------
// Fallback path (Firefox/Safari): a flat FileList from <input webkitdirectory>
// or from a dropped folder read through the legacy webkitGetAsEntry() API.
// ---------------------------------------------------------------------------

/**
 * Triage a flat list of File objects. Used by the fallback input and by
 * drag-and-drop when only the legacy entries API is available. Files that
 * arrived via `webkitdirectory` carry a `webkitRelativePath` like
 * `3320/photo.jpg`; anything nested more than one level deep is a
 * sub-folder and is ignored, matching the File System Access path.
 */
export function triageFiles(
  files: Iterable<File | FileWithPath>,
): { images: ScannedFile[]; skipped: { name: string; reason: string }[]; folderCount: number } {
  const images: ScannedFile[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const foldersWithImages = new Set<string>();

  for (const item of files) {
    const file = item instanceof File ? item : item.file;
    // webkitdirectory paths are prefixed with the selected folder's own name
    // ("3320/sub/img.jpg"); that first segment is the root the user picked,
    // so it is dropped to make the path relative to it. Drag-and-drop entries
    // arrive already relative and carry their path explicitly.
    const rawPath = item instanceof File ? file.webkitRelativePath || file.name : item.relativePath;
    const parts = rawPath.split('/').filter(Boolean);
    const relativeParts = item instanceof File && file.webkitRelativePath ? parts.slice(1) : parts;

    if (relativeParts.length === 0) continue;
    if (relativeParts.length > 1 && EXCLUDED_TOP_LEVEL_SET.has(relativeParts[0].toLowerCase())) {
      continue; // our own output from a previous run
    }

    const name = relativeParts[relativeParts.length - 1];
    const relativePath = relativeParts.join('/');
    const reason = triageOne(name);
    if (reason === null) {
      images.push({ name, relativePath, file, size: file.size });
      foldersWithImages.add(relativeParts.slice(0, -1).join('/'));
    } else if (reason !== 'JUNK') {
      skipped.push({ name: relativePath, reason });
    }
  }

  images.sort(byPathAlphabetical);
  skipped.sort(byNameAlphabetical);
  return { images, skipped, folderCount: foldersWithImages.size };
}

export function scanFileList(files: FileList | (File | FileWithPath)[]): ScanResult {
  const { images, skipped, folderCount } = triageFiles(Array.from(files as Iterable<File | FileWithPath>));
  // The fallback path delivers a fresh .zip every run — there is no existing
  // output folder to collide with.
  return { images, skipped, existingOutputNames: new Set(), folderCount };
}

// ---------------------------------------------------------------------------
// Drag-and-drop
// ---------------------------------------------------------------------------

/**
 * Resolve a dropped item to either a live directory handle (preferred, File
 * System Access capable browsers) or a flat array of Files (legacy entries
 * API, Firefox/Safari). Returns null if the drop wasn't a folder.
 */
export async function resolveDroppedItem(item: DataTransferItem): Promise<{ kind: 'handle'; handle: FileSystemDirectoryHandle } | { kind: 'files'; files: FileWithPath[] } | null> {
  if (typeof item.getAsFileSystemHandle === 'function') {
    const handle = await item.getAsFileSystemHandle();
    if (handle && handle.kind === 'directory') {
      return { kind: 'handle', handle: handle as FileSystemDirectoryHandle };
    }
    if (handle) return null; // a single file was dropped, not a folder
  }

  const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
  if (entry && entry.isDirectory) {
    const files = await readEntryFilesFlat(entry as FileSystemDirectoryEntry);
    return { kind: 'files', files };
  }

  return null;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/**
 * Recursive walk of a dropped folder via the legacy entries API, carrying each
 * file's path relative to the dropped root. File objects from this API have no
 * webkitRelativePath, so the path is tracked alongside them explicitly.
 */
async function readEntryFilesFlat(dirEntry: FileSystemDirectoryEntry, prefix = '', depth = 0): Promise<FileWithPath[]> {
  if (depth > MAX_SCAN_DEPTH) return [];

  const reader = dirEntry.createReader();
  const allEntries: FileSystemEntry[] = [];
  // readEntries() must be called repeatedly until it yields an empty array —
  // a single call isn't guaranteed to return everything in large folders.
  while (true) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    allEntries.push(...batch);
  }

  const files: FileWithPath[] = [];
  for (const entry of allEntries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      try {
        files.push({ file: await entryToFile(entry as FileSystemFileEntry), relativePath });
      } catch {
        // Unreadable entry; triage will simply never see it.
      }
    } else if (entry.isDirectory) {
      if (depth === 0 && EXCLUDED_TOP_LEVEL_SET.has(entry.name.toLowerCase())) continue;
      files.push(...(await readEntryFilesFlat(entry as FileSystemDirectoryEntry, relativePath, depth + 1)));
    }
  }
  return files;
}
