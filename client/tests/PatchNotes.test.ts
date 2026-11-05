import { describe, expect, it } from 'vitest';
import { GAME_VERSION } from '@idle-party-rpg/shared';
import { PATCH_NOTES } from '../src/screens/PatchNotes';

describe('PATCH_NOTES', () => {
  it('leads with the entry for the current GAME_VERSION', () => {
    expect(PATCH_NOTES[0].version).toBe(GAME_VERSION);
  });
});
