import { describe, expect, it } from 'vitest';
import { contentFiles } from './install.js';
import type { ContentSnapshot } from './types.js';

function snapshot(): ContentSnapshot {
  return {
    monsters: { wolf: { id: 'wolf' } },
    items: {},
    zones: {},
    encounters: {},
    sets: {},
    shops: {},
    henchmen: {},
    tileTypes: {},
    recipes: {},
    npcs: {},
    quests: {},
    dungeons: { crypt: { id: 'crypt', name: 'Crypt' } },
    skills: {},
    skillSlotSchedules: { Knight: [{ type: 'passive', unlocksAtLevel: 1 }] },
    designNotes: {},
    world: { tiles: [] },
  } as unknown as ContentSnapshot;
}

describe('contentFiles', () => {
  it('writes sections as the arrays ContentStore loads', () => {
    const files = contentFiles(snapshot());
    expect(files['monsters.json']).toEqual([{ id: 'wolf' }]);
    expect(files['world.json']).toEqual({ tiles: [] });
    expect(files['skill-slots.json']).toEqual([{ className: 'Knight', slots: [{ type: 'passive', unlocksAtLevel: 1 }] }]);
  });

  it('adds the dungeon that stops DevSeed merging its world, and leaves the real ones intact', () => {
    const ids = (contentFiles(snapshot())['dungeons.json'] as { id: string }[]).map(d => d.id);
    expect(ids).toEqual(['crypt', 'dev_sunken_throne']);
  });
});
