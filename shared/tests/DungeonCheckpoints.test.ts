import { describe, it, expect } from 'vitest';
import {
  floorCheckpoints,
  floorMaxWipes,
  floorCheckpointRewardFraction,
  clampCheckpointPhase,
  checkpointPhaseKey,
  isDungeonCheckpointFresh,
  DEFAULT_MAX_WIPES,
  DEFAULT_CHECKPOINT_REWARD_FRACTION,
  DUNGEON_CHECKPOINT_TTL_MS,
} from '../src/systems/DungeonTypes';
import type { DungeonFloor } from '../src/systems/DungeonTypes';
import { sanitizeCombatPrefs, DEFAULT_COMBAT_PREFS } from '../src/systems/ForecastTypes';

function floor(extra: Partial<DungeonFloor> = {}): DungeonFloor {
  return { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [], ...extra };
}

describe('dungeon checkpoint helpers', () => {
  it('sanitises checkpoints to descending fractions in (0,1)', () => {
    expect(floorCheckpoints(floor({ checkpoints: [0.33, 1, 0.66, 0, NaN, 0.66, -0.2] }))).toEqual([0.66, 0.33]);
    expect(floorCheckpoints(floor())).toEqual([]);
    expect(floorCheckpoints(undefined)).toEqual([]);
  });

  it('defaults wipes and reward fraction', () => {
    expect(floorMaxWipes(floor())).toBe(DEFAULT_MAX_WIPES);
    expect(floorMaxWipes(floor({ maxWipes: 0 }))).toBe(0);
    expect(floorMaxWipes(floor({ maxWipes: -1 }))).toBe(DEFAULT_MAX_WIPES);
    expect(floorCheckpointRewardFraction(floor())).toBe(DEFAULT_CHECKPOINT_REWARD_FRACTION);
    expect(floorCheckpointRewardFraction(floor({ checkpointRewardFraction: 0.3 }))).toBe(0.3);
    expect(floorCheckpointRewardFraction(floor({ checkpointRewardFraction: 4 }))).toBe(DEFAULT_CHECKPOINT_REWARD_FRACTION);
  });

  it('clamps a saved phase to the floor as currently authored', () => {
    const f = floor({ checkpoints: [0.66, 0.33] });
    expect(clampCheckpointPhase(2, f)).toBe(2);
    expect(clampCheckpointPhase(5, f)).toBe(2);
    expect(clampCheckpointPhase(NaN, f)).toBe(0);
    expect(clampCheckpointPhase(undefined, f)).toBe(0);
    expect(clampCheckpointPhase(2, floor())).toBe(0);
  });

  it('keys rewarded phases and expires checkpoints after 7 days', () => {
    expect(checkpointPhaseKey(2, 1)).toBe('2:1');
    const cp = { floorIndex: 2, phase: 1, wipes: 1, rewardedPhases: ['2:1'], at: 0 };
    expect(isDungeonCheckpointFresh(cp, DUNGEON_CHECKPOINT_TTL_MS - 1)).toBe(true);
    expect(isDungeonCheckpointFresh(cp, DUNGEON_CHECKPOINT_TTL_MS)).toBe(false);
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
