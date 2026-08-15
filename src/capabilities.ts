/**
 * Feature detection. Everything else in the app asks this module "what can
 * this browser do?" exactly once, up front, rather than sprinkling
 * `typeof window.showDirectoryPicker === 'function'` checks everywhere.
 */

import type { Capabilities, OutputMode } from './types';

const EDGE_CHROME_HINT =
  'For the best experience, open this tool in Microsoft Edge or Google Chrome.';

export function detectCapabilities(): Capabilities {
  const fileSystemAccess = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';

  let directoryInput = false;
  if (typeof document !== 'undefined') {
    const probe = document.createElement('input');
    directoryInput = 'webkitdirectory' in probe;
  }

  let outputMode: OutputMode;
  let warning: string | null;

  if (fileSystemAccess && offscreenCanvas) {
    outputMode = 'directory';
    warning = null;
  } else if (directoryInput && offscreenCanvas) {
    outputMode = 'zip';
    warning =
      `${EDGE_CHROME_HINT} This browser can still resize your photos, but ` +
      "they'll arrive as a single .zip file to unzip yourself, instead of " +
      'being saved straight into a folder.';
  } else if (!offscreenCanvas) {
    outputMode = 'zip';
    warning = `This browser is missing features this tool needs to run at all. ${EDGE_CHROME_HINT}`;
  } else {
    outputMode = 'zip';
    warning = `This browser can't select a folder of photos. ${EDGE_CHROME_HINT}`;
  }

  return { fileSystemAccess, directoryInput, offscreenCanvas, outputMode, warning };
}
