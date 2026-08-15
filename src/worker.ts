/**
 * Runs inside a dedicated Web Worker (one per pool slot, reused across
 * files). Per request: decode with a hard stretch to 3000x3000, encode,
 * splice EXIF/ICC back in for JPEGs, and reply with the finished blob.
 *
 * This file never touches the filesystem — writing the result (to a
 * directory or into a zip) is the main thread's job. That keeps the worker
 * protocol identical for both output modes.
 *
 * The project's tsconfig combines the "DOM" and "WebWorker" lib options so
 * that main-thread and worker code can share one program. Those two libs
 * disagree about the type of a few ambient globals (`self` chief among
 * them), which `skipLibCheck` papers over everywhere except right here,
 * where we actually use them — so `self` is re-declared locally with its
 * correct worker-scoped type, shadowing the ambiguous global just for this
 * module.
 */

declare const self: DedicatedWorkerGlobalScope;

import type { ResizeRequest, ResizeResponse } from './types';
import { TARGET_WIDTH, TARGET_HEIGHT } from './types';
import { extractMetadata, spliceMetadata } from './jpeg-metadata';

function safeReason(context: string): string {
  switch (context) {
    case 'decode':
      return "This file is damaged or isn't a real image, so it couldn't be opened.";
    case 'canvas':
      return "This browser couldn't create the image needed to resize this file.";
    default:
      return 'Something went wrong while resizing this file.';
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, {
      resizeWidth: TARGET_WIDTH,
      resizeHeight: TARGET_HEIGHT,
      resizeQuality: 'high',
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
    });
  } catch {
    throw new Error(safeReason('decode'));
  }
}

function encode(bitmap: ImageBitmap, mimeType: ResizeRequest['mimeType'], quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(TARGET_WIDTH, TARGET_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(safeReason('canvas'));
  try {
    ctx.drawImage(bitmap, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
  } finally {
    // Free the decoded bitmap the moment its pixels are on the canvas. A
    // 3000x3000 RGBA bitmap is ~36MB; batches can run 500+ images, so this
    // eager close is what keeps memory flat across a whole run.
    bitmap.close();
  }
  const options = mimeType === 'image/png' ? { type: mimeType } : { type: mimeType, quality };
  return canvas.convertToBlob(options);
}

/**
 * Carries EXIF/ICC/IPTC from the source JPEG onto the freshly-encoded blob.
 * JPEG-only (see PLAN.md §4.4); PNG/WebP outputs are returned unchanged.
 * A splice failure never fails the file — it just ships without the
 * original metadata, which is still a correctly resized image.
 */
async function withMetadata(
  sourceFile: File,
  encoded: Blob,
  mimeType: ResizeRequest['mimeType'],
): Promise<{ blob: Blob; metadataPreserved: boolean }> {
  if (mimeType !== 'image/jpeg') {
    return { blob: encoded, metadataPreserved: false };
  }
  try {
    const sourceBytes = new Uint8Array(await sourceFile.arrayBuffer());
    const meta = extractMetadata(sourceBytes);
    if (!meta) return { blob: encoded, metadataPreserved: false };

    const encodedBytes = new Uint8Array(await encoded.arrayBuffer());
    const splicedBytes = spliceMetadata(encodedBytes, meta, { width: TARGET_WIDTH, height: TARGET_HEIGHT });
    // Re-wrap in a concrete Uint8Array<ArrayBuffer> — spliceMetadata's return
    // type is buffer-generic, and Blob only accepts views over a real
    // ArrayBuffer (not the wider ArrayBufferLike, which also covers
    // SharedArrayBuffer).
    return { blob: new Blob([new Uint8Array(splicedBytes)], { type: 'image/jpeg' }), metadataPreserved: true };
  } catch {
    return { blob: encoded, metadataPreserved: false };
  }
}

async function handleRequest(request: ResizeRequest): Promise<ResizeResponse> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(request.file);
  } catch (err) {
    return { id: request.id, name: request.name, ok: false, reason: err instanceof Error ? err.message : safeReason('decode') };
  }

  try {
    const encoded = await encode(bitmap, request.mimeType, request.quality);
    const { blob, metadataPreserved } = await withMetadata(request.file, encoded, request.mimeType);
    return { id: request.id, name: request.name, ok: true, blob, metadataPreserved };
  } catch (err) {
    return {
      id: request.id,
      name: request.name,
      ok: false,
      reason: err instanceof Error && err.message ? err.message : safeReason('encode'),
    };
  }
}

self.onmessage = (event: MessageEvent<ResizeRequest>) => {
  const request = event.data;
  handleRequest(request)
    .then((response) => self.postMessage(response))
    .catch(() => {
      // handleRequest already catches everything it can meaningfully report
      // on; this is the last-resort net so one file can never take down the
      // worker (and therefore the rest of the batch) by throwing past it.
      self.postMessage({
        id: request.id,
        name: request.name,
        ok: false,
        reason: safeReason('unknown'),
      } satisfies ResizeResponse);
    });
};
