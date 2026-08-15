/**
 * @vitest-environment happy-dom
 *
 * Boot smoke test.
 *
 * This exists because of a real failure: `freshSession()` referenced a `const`
 * declared further down the file, and ran at module load. TypeScript compiled
 * it, the bundle built, every other test passed — and the deployed page threw
 * `ReferenceError: Cannot access 'dirCache' before initialization` before it
 * rendered anything, so users got a blank white screen with no explanation.
 *
 * Unit tests on pure modules cannot catch that class of bug. Importing the
 * entry point and asserting something reaches the DOM can.
 */

import { beforeEach, expect, it, vi } from 'vitest';

function mountPoints(): void {
  document.body.innerHTML = '<div id="banner"></div><main id="app"></main><div id="modal-root"></div>';
}

beforeEach(() => {
  vi.resetModules();
  mountPoints();
});

it('boots without throwing and renders the idle screen', async () => {
  // A module-load error surfaces here as a rejected import.
  await import('../src/main');

  const app = document.getElementById('app');
  expect(app, '#app should exist').not.toBeNull();
  expect(app!.children.length, 'idle screen should have rendered something').toBeGreaterThan(0);
});

it('offers a way to choose a folder', async () => {
  await import('../src/main');

  // Whichever path the environment takes — directory picker or the
  // <input webkitdirectory> fallback — the user must have some control to
  // start from. A page that renders but offers no entry point is still broken.
  const app = document.getElementById('app')!;
  const controls = app.querySelectorAll('button, input[type="file"], label');
  expect(controls.length).toBeGreaterThan(0);
});

it('renders a reassurance that images stay on the device', async () => {
  await import('../src/main');

  // Promised explicitly in PLAN.md §3 and relied on in GUIDE.md.
  const text = document.getElementById('app')!.textContent ?? '';
  expect(text.toLowerCase()).toContain('never leave');
});
