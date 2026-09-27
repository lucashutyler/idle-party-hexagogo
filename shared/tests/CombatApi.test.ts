import { describe, it, expect } from 'vitest';
import * as shared from '../src/index';
import * as timing from '../src/systems/CombatTiming';

describe('combat public API', () => {
  it('exports the timeline engine and drops the turn-based entry points', () => {
    for (const name of [
      'processCombatStep', 'advanceCombat', 'createPartyCombatState', 'buildClientCombatSnapshot',
      'findTarget', 'applyMonsterResistance', 'wouldHaveEffect', 'isInterruptFlashMode', 'effectiveCooldownMs',
      'getSkillTrigger', 'getSkillCardType', 'getMonsterSkillCastTimeMs',
    ]) {
      expect(typeof (shared as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(shared).not.toHaveProperty('processPartyTick');
    expect(shared).not.toHaveProperty('RUN_AVAILABLE_ROUNDS');
    expect(shared.SKILL_TRIGGER_VALUES).toHaveLength(5);
    expect(Object.keys(shared.SKILL_CARD_TYPE_INFO)).toHaveLength(7);
    expect(shared.GAME_VERSION).toBe('2026.09.26.1');
  });

  it('exports every timing constant with the spec values', () => {
    const expected = {
      COMBAT_STEP_MS: 100,
      BASE_ACTION_INTERVAL_MS: 1000,
      MIN_MONSTER_ACTION_INTERVAL_MS: 300,
      STATUS_PULSE_MS: 1000,
      STUN_MS: 1000,
      SCORCH_MS: 2000,
      MIN_COOLDOWN_MS: 1000,
      INTERRUPT_DELAY_MS: 300,
      RUN_AVAILABLE_MS: 5000,
      KILL_BEAT_MS: 800,
      FIRST_ACTION_PLAYER_MS: 1000,
      FIRST_ACTION_MONSTER_MS: 1400,
      STALEMATE_WINDOW_MS: 30000,
      LOW_HP_THRESHOLD: 0.5,
      COMBAT_SEND_MS: 200,
      COMBAT_SNAPSHOT_MS: 500,
      PLAYBACK_DELAY_MS: 300,
      STATE_LOG_TAIL: 100,
    };
    expect({ ...timing }).toEqual(expected);
    for (const [name, value] of Object.entries(expected)) {
      expect((shared as Record<string, unknown>)[name], name).toBe(value);
    }
  });
});
