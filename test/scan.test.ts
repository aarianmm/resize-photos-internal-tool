/**
 * Triage rules. The point of these tests is the promise made in PLAN.md §2:
 * a file we accept comes back out with the same name and the same format.
 * Anything we cannot honour that promise for must be reported to the user by
 * name, never quietly transformed.
 */

import { describe, expect, it } from 'vitest';
import { triageFiles } from '../src/scan';

function fakeFile(name: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], name, { type: '' });
}

function reasonFor(name: string): string | undefined {
  return triageFiles([fakeFile(name)]).skipped.find((s) => s.name === name)?.reason;
}

function isAccepted(name: string): boolean {
  return triageFiles([fakeFile(name)]).images.some((i) => i.name === name);
}

describe('triage: accepted formats', () => {
  it('accepts the formats browsers can both decode and re-encode', () => {
    for (const name of ['a.jpg', 'b.jpeg', 'c.png', 'd.webp']) {
      expect(isAccepted(name), name).toBe(true);
    }
  });

  it('accepts regardless of extension case', () => {
    for (const name of ['SHOT.JPG', 'Shot.JpEg', 'X.PNG']) {
      expect(isAccepted(name), name).toBe(true);
    }
  });

  it('accepts the accented and spaced names real batches contain', () => {
    // Called out as a known gotcha in task.md.
    expect(isAccepted('CARAMELCAFÉ.jpg')).toBe(true);
    expect(isAccepted('OFF WHITE 90H.jpg')).toBe(true);
  });
});

describe('triage: decode-only formats are skipped, not silently converted', () => {
  // Browsers can open these but convertToBlob cannot write them back. Resizing
  // them would mean emitting JPEG bytes under a .gif/.bmp/.avif filename —
  // a file whose contents contradict its name. We skip and explain instead.
  for (const ext of ['gif', 'bmp', 'avif']) {
    it(`skips .${ext} with an explanation rather than mislabelling it`, () => {
      const name = `photo.${ext}`;
      expect(isAccepted(name)).toBe(false);
      const reason = reasonFor(name);
      expect(reason).toBeDefined();
      expect(reason).toContain(ext.toUpperCase());
      // The user needs to know what to do next, not just that it failed.
      expect(reason).toMatch(/convert/i);
    });
  }
});

describe('triage: undecodable formats', () => {
  it('explains .tif in terms a non-technical user understands', () => {
    const reason = reasonFor('scan.tif');
    expect(reason).toBeDefined();
    // No jargon, no error codes — PLAN.md §3.
    expect(reason).toMatch(/browser/i);
    expect(reason).not.toMatch(/error|exception|undefined|null/i);
  });

  it('names the format for each known camera/design type', () => {
    for (const name of ['a.heic', 'b.cr2', 'c.nef', 'd.arw', 'e.dng', 'f.psd', 'g.tiff']) {
      expect(reasonFor(name), name).toBeTruthy();
    }
  });

  it('handles files with no extension and unknown extensions', () => {
    expect(reasonFor('READMEFILE')).toMatch(/extension/i);
    expect(reasonFor('notes.txt')).toBeTruthy();
  });
});

describe('triage: OS clutter', () => {
  it('drops OS junk silently rather than reporting it as a problem', () => {
    // These appear in every real folder; listing them as "skipped" would
    // make a clean run look like it had failures.
    const result = triageFiles([
      fakeFile('.DS_Store'),
      fakeFile('Thumbs.db'),
      fakeFile('desktop.ini'),
      fakeFile('real.jpg'),
    ]);
    expect(result.images.map((i) => i.name)).toEqual(['real.jpg']);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('triage: ordering', () => {
  it('sorts numerically so 2.jpg precedes 10.jpg', () => {
    const result = triageFiles([fakeFile('10.jpg'), fakeFile('2.jpg'), fakeFile('1.jpg')]);
    expect(result.images.map((i) => i.name)).toEqual(['1.jpg', '2.jpg', '10.jpg']);
  });
});
