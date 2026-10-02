import { describe, it, expect, beforeEach } from 'vitest';
import { PatchNotesScreen } from '../src/screens/PatchNotesScreen';
import { PATCH_NOTES } from '../src/screens/PatchNotes';

describe('PatchNotesScreen', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="screen-patch-notes" class="screen"></div>';
  });

  it('throws when its container is missing', () => {
    document.body.innerHTML = '';
    expect(() => new PatchNotesScreen('screen-patch-notes')).toThrow(/not found/);
  });

  it('renders one entry per release, newest first', () => {
    new PatchNotesScreen('screen-patch-notes');
    const entries = document.querySelectorAll('.patch-note-entry');
    expect(entries).toHaveLength(PATCH_NOTES.length);
    expect(document.querySelector('.patch-note-version')!.textContent).toBe(PATCH_NOTES[0].version);
  });

  it('renders every bullet of the newest release', () => {
    new PatchNotesScreen('screen-patch-notes');
    const first = document.querySelector('.patch-note-entry')!;
    expect(first.querySelectorAll('.patch-note-items li')).toHaveLength(PATCH_NOTES[0].notes.length);
  });

  it('marks the list as the single scroll region', () => {
    new PatchNotesScreen('screen-patch-notes');
    // `.screen` is overflow:hidden, so without this the list would clip
    // instead of scrolling.
    expect(document.querySelector('.patch-notes-list.screen-scroll')).not.toBeNull();
  });

  it('escapes note text rather than interpolating it as markup', () => {
    // The previous in-Settings version interpolated `${n}` raw. Notes are
    // developer-authored so this was not a live vector, but a stray `<` in a
    // bullet would silently eat the rest of the line.
    const original = [...PATCH_NOTES];
    PATCH_NOTES.length = 0;
    PATCH_NOTES.push({ version: '9.9.9.9', notes: ['fixed <img src=x onerror=alert(1)> rendering'] });
    try {
      new PatchNotesScreen('screen-patch-notes');
      const li = document.querySelector('.patch-note-items li')!;
      expect(li.querySelector('img')).toBeNull();
      expect(li.textContent).toContain('<img src=x onerror=alert(1)>');
    } finally {
      PATCH_NOTES.length = 0;
      PATCH_NOTES.push(...original);
    }
  });
});
