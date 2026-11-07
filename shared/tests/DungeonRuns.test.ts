import { describe, it, expect } from 'vitest';
import * as shared from '../src/index';
import { SEED_DUNGEONS, validateDungeonEntry } from '../src/systems/DungeonTypes';
import type { DungeonDefinition, DungeonFloor } from '../src/systems/DungeonTypes';
import { generateDevWorld } from '../src/seed/SeedDevWorld';
import { sanitizeCombatPrefs, DEFAULT_COMBAT_PREFS } from '../src/systems/ForecastTypes';

const OLD_FLOOR_FIELDS = ['checkpoints', 'maxWipes', 'checkpointRewardFraction'];

describe('dungeon runs', () => {
  it('ship no flag or retry helpers', () => {
    for (const name of [
      'DEFAULT_MAX_WIPES', 'DEFAULT_CHECKPOINT_REWARD_FRACTION', 'DUNGEON_CHECKPOINT_TTL_MS', 'floorCheckpoints', 'floorMaxWipes',
      'floorCheckpointRewardFraction', 'clampCheckpointPhase', 'checkpointPhaseKey', 'isDungeonCheckpointFresh', 'isBossMonster',
      'encounterCanFieldBoss', 'floorCanFieldBoss',
    ]) {
      expect(shared, name).not.toHaveProperty(name);
    }
  });

  it('seed floors with no flag fields', () => {
    const seeded = [...Object.values(SEED_DUNGEONS), ...generateDevWorld().dungeons];
    expect(seeded.length).toBeGreaterThan(1);
    for (const dungeon of seeded) {
      for (const floor of dungeon.floors) {
        for (const field of OLD_FLOOR_FIELDS) expect(floor, `${dungeon.id} floor ${floor.floorNumber}`).not.toHaveProperty(field);
      }
    }
  });

  it('let a party enter a dungeon whose stored floors still carry the old fields, however malformed', () => {
    const floor = {
      floorNumber: 1,
      gridShape: { cols: 3, rows: 3 },
      encounterTable: [],
      checkpoints: 'nonsense',
      maxWipes: -4,
      checkpointRewardFraction: 99,
    } as unknown as DungeonFloor;
    const dungeon: DungeonDefinition = { id: 'old', name: 'Old', floors: [floor] };
    const members = [{ username: 'a', level: 5, className: 'Knight' as const, hasRequiredItem: true }];
    expect(validateDungeonEntry(dungeon, members)).toBeNull();
  });
});

describe('sanitizeCombatPrefs', () => {
  it('accepts only the offered thresholds and defaults to 25', () => {
    expect(sanitizeCombatPrefs({ autoRetreatBelowPct: 40 })).toEqual({ autoRetreatBelowPct: 40 });
    expect(sanitizeCombatPrefs({ autoRetreatBelowPct: 0 })).toEqual({ autoRetreatBelowPct: 0 });
    expect(sanitizeCombatPrefs({ autoRetreatBelowPct: 50 })).toEqual(DEFAULT_COMBAT_PREFS);
    expect(sanitizeCombatPrefs(undefined)).toEqual({ autoRetreatBelowPct: 25 });
    expect(sanitizeCombatPrefs('junk')).toEqual({ autoRetreatBelowPct: 25 });
  });
});
