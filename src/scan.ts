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
import { SUPPORTED_EXTENSIONS, KNOWN_UNSUPPORTED_EXTENSIONS, DECODE_ONLY_EXTENSIONS } from './types';

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

// ---------------------------------------------------------------------------
// File System Access path
// ---------------------------------------------------------------------------

/**
 * Walk one directory handle, one level deep (batches are flat — see
 * PLAN.md). Sub-folders are ignored entirely: they're neither processed nor
 * reported, since a nested folder isn't a file the user expected touched.
 */
export async function scanEntries(
  dir: FileSystemDirectoryHandle,
): Promise<{ images: ScannedFile[]; skipped: { name: string; reason: string }[] }> {
  const images: ScannedFile[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
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
      images.push({ name, handle: fileHandle, size });
    } else if (reason !== 'JUNK') {
      skipped.push({ name, reason });
    }
  }

  images.sort(byNameAlphabetical);
  skipped.sort(byNameAlphabetical);
  return { images, skipped };
}

/**
 * Read-only lookup of the default `resized` output folder inside the chosen
 * input folder. Returns null if it doesn't exist yet — it is never created
 * here, only when the user confirms the batch.
 */
export async function findDefaultOutputDir(inputDir: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await inputDir.getDirectoryHandle('resized', { create: false });
  } catch {
    return null;
  }
}

/** Names of files already present in a (possibly nonexistent) output folder. */
export async function getExistingNames(dir: FileSystemDirectoryHandle | null): Promise<Set<string>> {
  const names = new Set<string>();
  if (!dir) return names;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') names.add(name);
  }
  return names;
}

/** Full read-only scan: triaged file list plus collision check against outputDir. */
export async function scanDirectory(
  inputDir: FileSystemDirectoryHandle,
  outputDir: FileSystemDirectoryHandle | null,
): Promise<ScanResult> {
  const [{ images, skipped }, existingOutputNames] = await Promise.all([
    scanEntries(inputDir),
    getExistingNames(outputDir),
  ]);
  return { images, skipped, existingOutputNames };
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
export function triageFiles(files: Iterable<File>): { images: ScannedFile[]; skipped: { name: string; reason: string }[] } {
  const images: ScannedFile[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split('/').filter(Boolean);
    if (parts.length > 2) continue; // nested sub-folder entry, ignore silently
    const name = parts.length > 0 ? parts[parts.length - 1] : file.name;
    const reason = triageOne(name);
    if (reason === null) {
      images.push({ name, file, size: file.size });
    } else if (reason !== 'JUNK') {
      skipped.push({ name, reason });
    }
  }

  images.sort(byNameAlphabetical);
  skipped.sort(byNameAlphabetical);
  return { images, skipped };
}

export function scanFileList(files: FileList | File[]): ScanResult {
  const { images, skipped } = triageFiles(Array.from(files));
  // The fallback path delivers a fresh .zip every run — there is no existing
  // output folder to collide with.
  return { images, skipped, existingOutputNames: new Set() };
}

// ---------------------------------------------------------------------------
// Drag-and-drop
// ---------------------------------------------------------------------------

/**
 * Resolve a dropped item to either a live directory handle (preferred, File
 * System Access capable browsers) or a flat array of Files (legacy entries
 * API, Firefox/Safari). Returns null if the drop wasn't a folder.
 */
export async function resolveDroppedItem(item: DataTransferItem): Promise<{ kind: 'handle'; handle: FileSystemDirectoryHandle } | { kind: 'files'; files: File[] } | null> {
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

/** One level deep only, matching the flat-batch assumption elsewhere. */
async function readEntryFilesFlat(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
  const reader = dirEntry.createReader();
  const allEntries: FileSystemEntry[] = [];
  // readEntries() must be called repeatedly until it yields an empty array —
  // a single call isn't guaranteed to return everything in large folders.
  while (true) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    allEntries.push(...batch);
  }

  const files: File[] = [];
  for (const entry of allEntries) {
    if (entry.isFile) {
      try {
        files.push(await entryToFile(entry as FileSystemFileEntry));
      } catch {
        // Unreadable entry; triage will simply never see it.
      }
    }
  }
  return files;
}
