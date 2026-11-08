import { describe, it, expect } from 'vitest';
import type { DungeonDefinition, ZoneDefinition } from '@idle-party-rpg/shared';
import { findContentProblems, formatPublishRefusal } from '../src/game/ContentValidation.js';
import type { ContentSnapshot } from '../src/game/VersionStore.js';
import { fakeWorldMeta } from './testGrids.js';

describe('formatPublishRefusal', () => {
  it('lists every problem when there are only a few', () => {
    expect(formatPublishRefusal(['A is broken.', 'B is broken.'])).toBe(
      "Can't publish: the draft has 2 problem(s). A is broken. B is broken.",
    );
  });

  it('shows the first five problems and counts the rest', () => {
    const problems = Array.from({ length: 8 }, (_, i) => `P${i}.`);
    expect(formatPublishRefusal(problems)).toBe(
      "Can't publish: the draft has 8 problem(s). P0. P1. P2. P3. P4. (+3 more)",
    );
  });
});

describe('zone and floor pay fields', () => {
  const zone = (extra: object) => ({ id: 'isle', displayName: 'Isle', levelRange: [1, 2], encounterTable: [], ...extra }) as ZoneDefinition;
  const dungeon = (extra: object) => ({
    id: 'den',
    name: 'Den',
    floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [], ...extra }],
  }) as unknown as DungeonDefinition;
  const problems = (zones: ZoneDefinition[], dungeons: DungeonDefinition[]) => findContentProblems({
    monsters: [], items: [], zones, encounters: [], skills: [], dungeons,
    world: { tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() },
  } as unknown as ContentSnapshot).filter(p => /starterZone|Factor/.test(p));

  it('accepts absent and valid values', () => {
    expect(problems([zone({}), zone({ starterZone: true }), zone({ starterZone: false })], [dungeon({}), dungeon({ xpFactor: 0, coinFactor: 1 }), dungeon({ xpFactor: 0.03 })])).toEqual([]);
  });

  it.each([1.5, -0.1, 'half', null, Number.NaN])('calls a floor factor of %s a problem', (bad) => {
    expect(problems([], [dungeon({ xpFactor: bad })]).join()).toMatch(/xpFactor must be a number from 0 to 1/);
    expect(problems([], [dungeon({ coinFactor: bad })]).join()).toMatch(/coinFactor must be a number from 0 to 1/);
  });

  it('calls a starter zone flag that is not a boolean a problem', () => {
    expect(problems([zone({ starterZone: 1 })], []).join()).toMatch(/starterZone must be true or false/);
  });
});
