/**
 * A small pool of persistent Web Workers that pulls work from a shared
 * queue. Each worker handles one file at a time; as soon as it finishes it
 * asks for the next one. That pull model is what gives us backpressure for
 * free — the main thread never queues more in-flight work than there are
 * workers, so a 2000-image batch behaves the same as a 20-image one.
 *
 * Cancellation is cooperative: `cancel()` stops new work being handed out,
 * but a file a worker has already started is allowed to finish, so the
 * batch always stops cleanly *between* files, never mid-file.
 */

import type { ScannedFile, ResizeRequest, ResizeResponse } from './types';

export type MimeTypeFor = (name: string) => 'image/jpeg' | 'image/png' | 'image/webp';

export interface PoolRunOptions {
  files: ScannedFile[];
  mimeTypeFor: MimeTypeFor;
  quality: number;
  /** Called exactly once per file, in completion order (not input order). */
  onResult: (outcome: ResizeResponse) => void | Promise<void>;
  /** Called after each onResult, with the running completed/total count. */
  onProgress?: (completed: number, total: number) => void;
  /**
   * Called right as a file is handed to a worker (before it's decoded), so
   * the UI can show "what's happening right now" rather than only what's
   * finished. With multiple workers this can fire faster than the UI wants
   * to repaint — callers should treat it as "most recently started", not a
   * strict queue.
   */
  onFileStart?: (name: string) => void;
}

export interface PoolRunResult {
  cancelled: boolean;
}

function defaultPoolSize(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(1, Math.min(cores - 1, 4));
}

function readErrorMessage(): string {
  return 'This file could not be opened. It may have been moved, renamed, or deleted since scanning started.';
}

function sendRequest(worker: Worker, request: ResizeRequest): Promise<ResizeResponse> {
  return new Promise((resolve) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };
    const onMessage = (ev: MessageEvent<ResizeResponse>) => {
      cleanup();
      resolve(ev.data);
    };
    const onError = () => {
      cleanup();
      resolve({
        id: request.id,
        name: request.name,
        ok: false,
        reason: 'Something went wrong while resizing this file.',
      });
    };
    const onMessageError = onError;
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.postMessage(request);
  });
}

export class WorkerPool {
  private readonly size: number;
  private cancelled = false;

  constructor(size: number = defaultPoolSize()) {
    this.size = Math.max(1, size);
  }

  /** Stop dispatching new work. In-flight files are allowed to finish. */
  cancel(): void {
    this.cancelled = true;
  }

  async run(opts: PoolRunOptions): Promise<PoolRunResult> {
    this.cancelled = false;
    const { files, mimeTypeFor, quality, onResult, onProgress, onFileStart } = opts;
    const total = files.length;
    let nextIndex = 0;
    let completed = 0;

    if (total === 0) return { cancelled: false };

    const workerCount = Math.min(this.size, total);

    const runWorkerSlot = async (): Promise<void> => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      try {
        while (!this.cancelled) {
          const idx = nextIndex;
          if (idx >= total) break;
          nextIndex = idx + 1;
          const scanned = files[idx];

          onFileStart?.(scanned.name);
          const outcome = await this.processOne(worker, scanned, idx, mimeTypeFor, quality);
          completed += 1;
          await onResult(outcome);
          onProgress?.(completed, total);
        }
      } finally {
        worker.terminate();
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorkerSlot()));

    return { cancelled: this.cancelled };
  }

  private async processOne(
    worker: Worker,
    scanned: ScannedFile,
    id: number,
    mimeTypeFor: MimeTypeFor,
    quality: number,
  ): Promise<ResizeResponse> {
    let file: File;
    try {
      if (scanned.file) {
        file = scanned.file;
      } else if (scanned.handle) {
        file = await scanned.handle.getFile();
      } else {
        throw new Error('no source for file');
      }
    } catch {
      return { id, name: scanned.name, ok: false, reason: readErrorMessage() };
    }

    const request: ResizeRequest = {
      id,
      name: scanned.name,
      file,
      mimeType: mimeTypeFor(scanned.name),
      quality,
    };

    return sendRequest(worker, request);
  }
}
