/**
 * All DOM rendering. Every state (idle / confirm / running / done) has one
 * render function that clears its mount point and rebuilds from scratch —
 * the UI is small enough that this is simpler and safer than diffing, and
 * it means every render is a true reflection of the state passed in.
 *
 * Nothing here talks to the filesystem, the worker pool, or scan.ts. It
 * only renders view models and reports user actions back through the
 * handlers it's given.
 */

import type { Capabilities, OutputMode, FileOutcome, BatchSummary, CollisionPolicy } from './types';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function clear(root: HTMLElement): void {
  root.replaceChildren();
}

function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Banner (persistent, shown once at startup, independent of app state)
// ---------------------------------------------------------------------------

export function renderBanner(root: HTMLElement, warning: string | null): void {
  clear(root);
  if (!warning) return;
  root.append(el('div', { class: 'banner', role: 'status' }, [warning]));
}

// ---------------------------------------------------------------------------
// Idle
// ---------------------------------------------------------------------------

export interface IdleHandlers {
  onChooseFolder: () => void;
  onFallbackFilesChosen: (files: FileList) => void;
  onDrop: (dataTransfer: DataTransfer) => void;
}

export function renderIdle(root: HTMLElement, capabilities: Capabilities, handlers: IdleHandlers): void {
  clear(root);

  const card = el('section', { class: 'card idle-card' });
  card.append(el('h1', { class: 'title' }, ['Resize to 3000 × 3000']));

  const dropZone = el('div', { class: 'drop-zone', role: 'group', 'aria-label': 'Choose or drop a folder of photos' });

  const dropLabel = capabilities.outputMode === 'directory'
    ? 'Drop a folder here'
    : 'Choose a folder of photos';
  dropZone.append(el('p', { class: 'drop-zone-label' }, [dropLabel]));

  if (capabilities.outputMode === 'directory') {
    dropZone.append(el('p', { class: 'drop-zone-or' }, ['or']));
  }

  const chooseButton = el('button', { class: 'btn btn-primary btn-large', type: 'button' }, ['Choose folder…']);
  chooseButton.addEventListener('click', () => {
    if (capabilities.outputMode === 'directory') {
      handlers.onChooseFolder();
    } else {
      fallbackInput.click();
    }
  });
  dropZone.append(chooseButton);

  // Fallback (Firefox/Safari): a hidden native folder input, triggered by
  // the same "Choose folder…" button so the UI reads identically either way.
  const fallbackInput = el('input', {
    class: 'visually-hidden',
    type: 'file',
    webkitdirectory: '',
    multiple: '',
    'aria-hidden': 'true',
    tabindex: '-1',
  });
  fallbackInput.addEventListener('change', () => {
    if (fallbackInput.files && fallbackInput.files.length > 0) {
      handlers.onFallbackFilesChosen(fallbackInput.files);
    }
  });
  dropZone.append(fallbackInput);

  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('drop-zone-active');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drop-zone-active');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drop-zone-active');
    if (event.dataTransfer) handlers.onDrop(event.dataTransfer);
  });

  card.append(dropZone);
  card.append(el('p', { class: 'reassurance' }, ['🔒 Your images never leave this computer.']));
  root.append(card);
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ConfirmViewModel {
  inputLabel: string;
  outputLabel: string;
  outputMode: OutputMode;
  imageCount: number;
  /** How many folders contributed images, so a recursive scan is visible. */
  folderCount: number;
  skipped: { name: string; reason: string }[];
  canChangeOutput: boolean;
}

export interface ConfirmHandlers {
  onConfirm: () => void;
  onChangeOutput: () => void;
  onStartOver: () => void;
}

export function renderConfirm(root: HTMLElement, vm: ConfirmViewModel, handlers: ConfirmHandlers): void {
  clear(root);

  const card = el('section', { class: 'card' });
  card.append(el('h1', { class: 'title' }, ['Ready to resize']));

  // Naming the folder count makes it obvious the scan went into subfolders —
  // without it, a user seeing one number can't tell whether nested batches
  // were picked up.
  const where = vm.folderCount > 1
    ? `${vm.inputLabel}, across ${formatCount(vm.folderCount, 'folder')}`
    : vm.inputLabel;
  const summaryLine = vm.skipped.length > 0
    ? `Found ${formatCount(vm.imageCount, 'image')} in ${where}. ${formatCount(vm.skipped.length, 'file')} skipped.`
    : `Found ${formatCount(vm.imageCount, 'image')} in ${where}.`;
  card.append(el('p', { class: 'summary-line' }, [summaryLine]));

  if (vm.skipped.length > 0) {
    const details = el('details', { class: 'skip-details' });
    details.append(el('summary', {}, ['Why were these skipped?']));
    const list = el('ul', { class: 'reason-list' });
    for (const s of vm.skipped) {
      list.append(el('li', {}, [el('strong', {}, [s.name]), ` — ${s.reason}`]));
    }
    details.append(list);
    card.append(details);
  }

  const outputRow = el('div', { class: 'output-row' });
  const outputText = vm.outputMode === 'directory'
    ? `They'll be saved to ${vm.outputLabel}`
    : "They'll be delivered as a single .zip file you download when it's done.";
  outputRow.append(el('span', {}, [outputText]));
  if (vm.canChangeOutput) {
    const changeBtn = el('button', { class: 'btn btn-link', type: 'button' }, ['Change…']);
    changeBtn.addEventListener('click', handlers.onChangeOutput);
    outputRow.append(changeBtn);
  }
  card.append(outputRow);

  const actions = el('div', { class: 'actions' });
  const confirmBtn = el('button', { class: 'btn btn-primary btn-large', type: 'button' }, [
    `Resize ${formatCount(vm.imageCount, 'image')}`,
  ]);
  confirmBtn.disabled = vm.imageCount === 0;
  confirmBtn.addEventListener('click', handlers.onConfirm);
  actions.append(confirmBtn);

  const startOverBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, ['Choose a different folder']);
  startOverBtn.addEventListener('click', handlers.onStartOver);
  actions.append(startOverBtn);

  card.append(actions);
  card.append(el('p', { class: 'reassurance' }, ['🔒 Your images never leave this computer.']));
  root.append(card);
}

// ---------------------------------------------------------------------------
// Collision modal
// ---------------------------------------------------------------------------

export interface CollisionHandlers {
  onChoose: (policy: CollisionPolicy) => void;
  onCancel: () => void;
}

export function renderCollisionPrompt(root: HTMLElement, count: number, handlers: CollisionHandlers): void {
  clear(root);

  const overlay = el('div', { class: 'modal-overlay', role: 'presentation' });
  const dialog = el('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'collision-title' });

  dialog.append(el('h2', { id: 'collision-title' }, ['Some files already exist']));
  dialog.append(
    el('p', {}, [
      `${formatCount(count, 'file')} in the output folder already have the same name as files in this batch. What should happen to them?`,
    ]),
  );

  const actions = el('div', { class: 'actions actions-stacked' });

  const overwriteBtn = el('button', { class: 'btn btn-primary btn-large', type: 'button' }, ['Overwrite them']);
  overwriteBtn.addEventListener('click', () => handlers.onChoose('overwrite'));
  actions.append(overwriteBtn);

  const skipBtn = el('button', { class: 'btn btn-secondary btn-large', type: 'button' }, ['Skip files already done']);
  skipBtn.addEventListener('click', () => handlers.onChoose('skip'));
  actions.append(skipBtn);

  const cancelBtn = el('button', { class: 'btn btn-link', type: 'button' }, ['Cancel']);
  cancelBtn.addEventListener('click', handlers.onCancel);
  actions.append(cancelBtn);

  dialog.append(actions);
  overlay.append(dialog);
  root.append(overlay);
}

export function clearModal(root: HTMLElement): void {
  clear(root);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunningViewModel {
  total: number;
  completed: number;
  currentName: string;
  okCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  remainingMs: number | null;
  cancelling: boolean;
}

export interface RunningHandlers {
  onCancel: () => void;
}

export function renderRunning(root: HTMLElement, vm: RunningViewModel, handlers: RunningHandlers): void {
  clear(root);

  const card = el('section', { class: 'card' });
  card.append(el('h1', { class: 'title' }, ['Resizing…']));

  const progressBar = el('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(vm.total), 'aria-valuenow': String(vm.completed) });
  const percent = vm.total === 0 ? 0 : Math.round((vm.completed / vm.total) * 100);
  const fill = el('div', { class: 'progress-fill', style: `width: ${percent}%` });
  progressBar.append(fill);
  card.append(progressBar);

  card.append(el('p', { class: 'progress-count' }, [`${vm.completed} / ${vm.total}`]));

  if (vm.currentName) {
    card.append(el('p', { class: 'current-file' }, ['Working on ', el('strong', {}, [vm.currentName])]));
  }

  const timing = vm.remainingMs !== null
    ? `Elapsed ${formatDuration(vm.elapsedMs)} · about ${formatDuration(vm.remainingMs)} left`
    : `Elapsed ${formatDuration(vm.elapsedMs)}`;
  card.append(el('p', { class: 'timing' }, [timing]));

  if (vm.skippedCount > 0 || vm.failedCount > 0) {
    card.append(
      el('p', { class: 'running-issues' }, [
        `${vm.skippedCount} skipped · ${vm.failedCount} failed so far`,
      ]),
    );
  }

  const cancelBtn = el('button', { class: 'btn btn-secondary btn-large', type: 'button' }, [vm.cancelling ? 'Cancelling…' : 'Cancel']);
  cancelBtn.disabled = vm.cancelling;
  cancelBtn.addEventListener('click', handlers.onCancel);
  card.append(cancelBtn);

  root.append(card);
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

export interface DoneViewModel {
  summary: BatchSummary;
  outputLabel: string;
  outputMode: OutputMode;
}

export interface DoneHandlers {
  onDownloadCsv: () => void;
  onStartOver: () => void;
  onDownloadZip?: () => void;
}

export function renderDone(root: HTMLElement, vm: DoneViewModel, handlers: DoneHandlers): void {
  clear(root);

  const { summary } = vm;
  const card = el('section', { class: 'card' });
  card.append(el('h1', { class: 'title' }, [summary.cancelled ? 'Cancelled' : 'Done']));

  const stats = el('p', { class: 'done-stats' }, [
    `✅ ${summary.okCount} resized · ⚠️ ${summary.skippedCount} skipped · ❌ ${summary.failedCount} failed`,
  ]);
  card.append(stats);

  const outputText = vm.outputMode === 'directory'
    ? `Saved to ${vm.outputLabel}`
    : 'Your download should have started automatically.';
  card.append(el('p', { class: 'summary-line' }, [outputText]));

  const problems = summary.outcomes.filter((o) => o.status !== 'ok');
  if (problems.length > 0) {
    const details = el('details', { class: 'skip-details', open: 'open' });
    details.append(el('summary', {}, ['Files that need attention']));
    const list = el('ul', { class: 'reason-list' });
    for (const o of problems) {
      const icon = o.status === 'failed' ? '❌' : '⚠️';
      list.append(el('li', {}, [`${icon} `, el('strong', {}, [o.name]), ` — ${o.reason ?? 'Unknown reason.'}`]));
    }
    details.append(list);
    card.append(details);
  }

  const actions = el('div', { class: 'actions' });

  if (vm.outputMode === 'zip' && handlers.onDownloadZip) {
    const zipBtn = el('button', { class: 'btn btn-primary btn-large', type: 'button' }, ['Download .zip again']);
    zipBtn.addEventListener('click', handlers.onDownloadZip);
    actions.append(zipBtn);
  }

  const csvBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, ['Download report (.csv)']);
  csvBtn.addEventListener('click', handlers.onDownloadCsv);
  actions.append(csvBtn);

  const startOverBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, ['Resize another folder']);
  startOverBtn.addEventListener('click', handlers.onStartOver);
  actions.append(startOverBtn);

  card.append(actions);
  root.append(card);
}

// ---------------------------------------------------------------------------
// CSV report
// ---------------------------------------------------------------------------

function csvField(value: string | number | boolean | undefined): string {
  const str = value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCsv(outcomes: FileOutcome[]): string {
  const header = ['name', 'status', 'reason', 'bytes_in', 'bytes_out', 'metadata_preserved'];
  const lines = [header.join(',')];
  for (const o of outcomes) {
    lines.push(
      [
        csvField(o.name),
        csvField(o.status),
        csvField(o.reason),
        csvField(o.bytesIn),
        csvField(o.bytesOut),
        csvField(o.metadataPreserved),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename, class: 'visually-hidden' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a tick to start before revoking the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, mimeType = 'text/csv;charset=utf-8'): void {
  downloadBlob(filename, new Blob([text], { type: mimeType }));
}

// formatBytes is exported for callers that want to show sizes alongside the
// report (kept here so ui.ts stays the single home for display formatting).
export { formatBytes };
