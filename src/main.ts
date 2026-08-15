/**
 * App state machine and wiring. This is the only module that knows about
 * every other module — ui.ts renders, scan.ts reads, pool.ts dispatches,
 * and this file decides what happens next and owns the one piece of state
 * that matters most: nothing gets written until the user confirms.
 */

import type { ScannedFile, ScanResult, CollisionPolicy, FileOutcome, BatchSummary, ResizeResponse } from './types';
import { JPEG_QUALITY, OUTPUT_PATH_SEGMENTS } from './types';
import { detectCapabilities } from './capabilities';
import * as scan from './scan';
import type { FileWithPath } from './scan';
import { WorkerPool } from './pool';
import * as ui from './ui';
import { ZipWriter } from './zip';

// ---------------------------------------------------------------------------
// Ambient type for showSaveFilePicker — used only for the fallback ZIP
// path, and only as progressive enhancement (see createZipSink below).
// ---------------------------------------------------------------------------

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}

declare global {
  function showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}

// ---------------------------------------------------------------------------
// DOM mount points
// ---------------------------------------------------------------------------

const appRoot = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const bannerRoot = document.getElementById('banner');

if (!appRoot || !modalRoot || !bannerRoot) {
  throw new Error('index.html is missing a required mount point (#app, #modal-root or #banner).');
}

const capabilities = detectCapabilities();
ui.renderBanner(bannerRoot, capabilities.warning);

// ---------------------------------------------------------------------------
// Session state. One batch at a time, reset between runs by "start over".
// ---------------------------------------------------------------------------

interface Session {
  inputDirHandle: FileSystemDirectoryHandle | null;
  inputLabel: string;
  outputDirHandle: FileSystemDirectoryHandle | null;
  outputLabel: string;
  scanResult: ScanResult | null;
  pool: WorkerPool | null;
  lastZipBlob: Blob | null;
  lastZipName: string;
}

function freshSession(): Session {
  dirCache.clear();
  return {
    inputDirHandle: null,
    inputLabel: '',
    outputDirHandle: null,
    outputLabel: '',
    scanResult: null,
    pool: null,
    lastZipBlob: null,
    lastZipName: 'resized.zip',
  };
}

let session = freshSession();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mimeTypeForName(name: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  // .jpg/.jpeg re-encode as JPEG, matching the source. .bmp/.gif/.avif are
  // decodable but the canvas encoder can't write those formats back out, so
  // they're re-encoded as JPEG q0.92 too — see worker.ts for the rationale.
  return 'image/jpeg';
}

function sanitizeFilenamePart(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'resized';
}

function folderLabelFromFiles(files: (File | FileWithPath)[]): string {
  // Only webkitdirectory paths carry the chosen folder's own name as their
  // first segment. Dropped-folder paths are already relative to it, so there
  // is nothing to recover and the generic label stands.
  for (const item of files) {
    if (!(item instanceof File)) continue;
    if (!item.webkitRelativePath) continue;
    const first = item.webkitRelativePath.split('/')[0];
    if (first) return first;
  }
  return 'the selected folder';
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Idle
// ---------------------------------------------------------------------------

function showIdle(): void {
  session = freshSession();
  ui.clearModal(modalRoot!);
  ui.renderIdle(appRoot!, capabilities, {
    onChooseFolder: handleChooseFolder,
    onFallbackFilesChosen: handleFallbackFilesChosen,
    onDrop: handleDrop,
  });
}

async function handleChooseFolder(): Promise<void> {
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    await beginScanFromHandle(handle);
  } catch (err) {
    if (!isAbortError(err)) {
      // Scanning couldn't even start; nothing was written, so just stay put.
      console.error('Folder selection failed', err);
    }
  }
}

function handleFallbackFilesChosen(files: FileList): void {
  beginScanFromFiles(Array.from(files));
}

async function handleDrop(dataTransfer: DataTransfer): Promise<void> {
  const item = dataTransfer.items && dataTransfer.items.length > 0 ? dataTransfer.items[0] : null;
  if (!item) return;
  try {
    const resolved = await scan.resolveDroppedItem(item);
    if (!resolved) return; // not a folder; silently ignore rather than alarm a non-technical user
    if (resolved.kind === 'handle') {
      await beginScanFromHandle(resolved.handle);
    } else {
      beginScanFromFiles(resolved.files);
    }
  } catch (err) {
    console.error('Could not read the dropped folder', err);
  }
}

// ---------------------------------------------------------------------------
// Scanning (read-only)
// ---------------------------------------------------------------------------

async function beginScanFromHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  session = freshSession();
  session.inputDirHandle = handle;
  session.inputLabel = handle.name;
  session.outputDirHandle = await scan.findDefaultOutputDir(handle);
  session.outputLabel = `${handle.name}/${OUTPUT_PATH_SEGMENTS.join('/')}/`;
  session.scanResult = await scan.scanDirectory(handle, session.outputDirHandle);
  showConfirm();
}

function beginScanFromFiles(files: (File | FileWithPath)[]): void {
  session = freshSession();
  session.inputLabel = folderLabelFromFiles(files);
  session.outputLabel = "a downloaded .zip file";
  session.lastZipName = `${sanitizeFilenamePart(session.inputLabel)}-resized.zip`;
  session.scanResult = scan.scanFileList(files);
  showConfirm();
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

function showConfirm(): void {
  const result = session.scanResult;
  if (!result) return;
  ui.clearModal(modalRoot!);
  ui.renderConfirm(
    appRoot!,
    {
      inputLabel: session.inputLabel,
      outputLabel: session.outputLabel,
      outputMode: capabilities.outputMode,
      imageCount: result.images.length,
      folderCount: result.folderCount,
      skipped: result.skipped,
      canChangeOutput: capabilities.outputMode === 'directory',
    },
    {
      onConfirm: handleConfirmClick,
      onChangeOutput: handleChangeOutput,
      onStartOver: showIdle,
    },
  );
}

async function handleChangeOutput(): Promise<void> {
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    session.outputDirHandle = handle;
    session.outputLabel = `${handle.name}/`;
    const existingOutputNames = await scan.getExistingNames(handle);
    if (session.scanResult) {
      session.scanResult = { ...session.scanResult, existingOutputNames };
    }
    showConfirm();
  } catch (err) {
    if (!isAbortError(err)) console.error('Could not open that folder', err);
  }
}

function handleConfirmClick(): void {
  const result = session.scanResult;
  if (!result) return;

  const collisionCount = result.images.filter((f) => result.existingOutputNames.has(f.relativePath)).length;
  if (collisionCount === 0) {
    void startBatch('overwrite');
    return;
  }

  ui.renderCollisionPrompt(modalRoot!, collisionCount, {
    onChoose: (policy: CollisionPolicy) => {
      ui.clearModal(modalRoot!);
      void startBatch(policy);
    },
    onCancel: () => ui.clearModal(modalRoot!),
  });
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

interface RunningState {
  total: number;
  completed: number;
  currentName: string;
  okCount: number;
  skippedCount: number;
  failedCount: number;
  startedAt: number;
  cancelling: boolean;
}

function renderRunningFrom(state: RunningState): void {
  const elapsedMs = performance.now() - state.startedAt;
  const remainingMs = state.completed > 0 && state.completed < state.total
    ? (elapsedMs / state.completed) * (state.total - state.completed)
    : null;
  ui.renderRunning(
    appRoot!,
    {
      total: state.total,
      completed: state.completed,
      currentName: state.currentName,
      okCount: state.okCount,
      skippedCount: state.skippedCount,
      failedCount: state.failedCount,
      elapsedMs,
      remainingMs,
      cancelling: state.cancelling,
    },
    {
      onCancel: () => {
        if (state.cancelling) return;
        state.cancelling = true;
        session.pool?.cancel();
        renderRunningFrom(state);
      },
    },
  );
}

/**
 * Resolve (creating as needed) the output subfolder for a relative path,
 * mirroring the source tree's shape.
 *
 * Results are cached as *promises*, not handles. Several workers finish at
 * once and will ask for the same new subfolder concurrently; caching the
 * in-flight promise means they all await one `getDirectoryHandle` call
 * instead of racing to create the same folder.
 */
const dirCache = new Map<string, Promise<FileSystemDirectoryHandle>>();

function resolveOutputSubdir(outputRoot: FileSystemDirectoryHandle, segments: string[]): Promise<FileSystemDirectoryHandle> {
  const key = segments.join('/');
  const cached = dirCache.get(key);
  if (cached) return cached;

  const parentSegments = segments.slice(0, -1);
  const created = (async () => {
    const parent = segments.length === 0 ? outputRoot : await resolveOutputSubdir(outputRoot, parentSegments);
    if (segments.length === 0) return parent;
    return parent.getDirectoryHandle(segments[segments.length - 1], { create: true });
  })();

  dirCache.set(key, created);
  return created;
}

async function writeToDirectory(outputDir: FileSystemDirectoryHandle, relativePath: string, blob: Blob): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean);
  const name = parts[parts.length - 1];
  const targetDir = await resolveOutputSubdir(outputDir, parts.slice(0, -1));
  const fileHandle = await targetDir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw err;
  }
}

async function createZipSink(suggestedName: string): Promise<{
  writer: WritableStreamDefaultWriter<Uint8Array>;
  finalize: () => Promise<void>;
}> {
  if (typeof showSaveFilePicker === 'function') {
    try {
      const handle = await showSaveFilePicker({
        suggestedName,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      const writer = writable.getWriter();
      return { writer, finalize: async () => {} };
    } catch {
      // Fall through to the in-memory fallback below — a failed/declined
      // save dialog shouldn't stop the batch from running.
    }
  }

  const chunks: Uint8Array[] = [];
  const collector = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  const writer = collector.getWriter();
  return {
    writer,
    finalize: async () => {
      const blob = new Blob(chunks.map((c) => c.slice()), { type: 'application/zip' });
      session.lastZipBlob = blob;
      ui.downloadBlob(suggestedName, blob);
    },
  };
}

async function startBatch(collisionPolicy: CollisionPolicy): Promise<void> {
  const result = session.scanResult;
  if (!result) return;

  const outcomes: FileOutcome[] = result.skipped.map((s) => ({ name: s.name, status: 'skipped', reason: s.reason }));

  let images: ScannedFile[] = result.images;
  if (collisionPolicy === 'skip') {
    const toSkip = images.filter((f) => result.existingOutputNames.has(f.relativePath));
    for (const f of toSkip) {
      outcomes.push({ name: f.relativePath, status: 'skipped', reason: 'Already resized — skipped, as requested.' });
    }
    images = images.filter((f) => !result.existingOutputNames.has(f.relativePath));
  }

  // The one moment anything is actually written: create the default output
  // folder now, if it didn't already exist when we scanned.
  let zipSink: { writer: WritableStreamDefaultWriter<Uint8Array>; finalize: () => Promise<void> } | null = null;
  let zipWriter: ZipWriter | null = null;

  if (capabilities.outputMode === 'directory') {
    if (!session.outputDirHandle) {
      // capabilities.outputMode === 'directory' implies the browser supports
      // showDirectoryPicker, which is always exercised before we get here
      // (either directly, or via a drag-and-drop handle) — so inputDirHandle
      // should always be set. This guard only protects against the
      // theoretical case of getAsFileSystemHandle() falling back to the
      // legacy Files-only drag-and-drop path on a directory-capable browser.
      if (!session.inputDirHandle) return;
      let dir = session.inputDirHandle;
      for (const segment of OUTPUT_PATH_SEGMENTS) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
      }
      session.outputDirHandle = dir;
    }
  } else {
    zipSink = await createZipSink(session.lastZipName);
    zipWriter = new ZipWriter(zipSink.writer);
  }

  const runningState: RunningState = {
    total: images.length,
    completed: 0,
    currentName: '',
    okCount: 0,
    skippedCount: outcomes.filter((o) => o.status === 'skipped').length,
    failedCount: 0,
    startedAt: performance.now(),
    cancelling: false,
  };
  renderRunningFrom(runningState);

  const pool = new WorkerPool();
  session.pool = pool;

  const outputDir = session.outputDirHandle;

  const handleResult = async (response: ResizeResponse): Promise<void> => {
    if (response.ok) {
      try {
        if (capabilities.outputMode === 'directory' && outputDir) {
          await writeToDirectory(outputDir, response.name, response.blob);
        } else if (zipWriter) {
          const bytes = new Uint8Array(await response.blob.arrayBuffer());
          await zipWriter.add(response.name, bytes);
        }
        outcomes.push({
          name: response.name,
          status: 'ok',
          bytesOut: response.blob.size,
          metadataPreserved: response.metadataPreserved,
        });
        runningState.okCount += 1;
      } catch {
        outcomes.push({ name: response.name, status: 'failed', reason: 'The resized file could not be saved.' });
        runningState.failedCount += 1;
      }
    } else {
      outcomes.push({ name: response.name, status: 'failed', reason: response.reason });
      runningState.failedCount += 1;
    }
  };

  const { cancelled } = await pool.run({
    files: images,
    mimeTypeFor: mimeTypeForName,
    quality: JPEG_QUALITY,
    onResult: handleResult,
    onProgress: (completed) => {
      runningState.completed = completed;
      renderRunningFrom(runningState);
    },
    onFileStart: (name) => {
      runningState.currentName = name;
      renderRunningFrom(runningState);
    },
  });

  if (zipWriter) {
    await zipWriter.finish();
  }
  if (zipSink) {
    await zipSink.finalize();
  }

  const elapsedMs = performance.now() - runningState.startedAt;
  const summary: BatchSummary = {
    outcomes,
    okCount: outcomes.filter((o) => o.status === 'ok').length,
    skippedCount: outcomes.filter((o) => o.status === 'skipped').length,
    failedCount: outcomes.filter((o) => o.status === 'failed').length,
    elapsedMs,
    cancelled,
  };

  showDone(summary);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

function showDone(summary: BatchSummary): void {
  ui.clearModal(modalRoot!);
  ui.renderDone(
    appRoot!,
    {
      summary,
      outputLabel: session.outputLabel,
      outputMode: capabilities.outputMode,
    },
    {
      onDownloadCsv: () => {
        const csv = ui.generateCsv(summary.outcomes);
        const name = `${sanitizeFilenamePart(session.inputLabel || 'resize')}-report.csv`;
        ui.downloadText(name, csv);
      },
      onStartOver: showIdle,
      onDownloadZip: session.lastZipBlob
        ? () => ui.downloadBlob(session.lastZipName, session.lastZipBlob as Blob)
        : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

showIdle();
