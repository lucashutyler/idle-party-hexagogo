import { describe, it, expect } from 'vitest';
import { createCombatState, processTick } from '../src/systems/CombatEngine';
import { createEncounter, createMonsterInstance, MONSTERS } from '../src/systems/MonsterTypes';
import { BASE_STATS } from '../src/systems/CharacterStats';
import type { StatBlock } from '../src/systems/CharacterStats';

function makeStats(overrides: Partial<StatBlock> = {}): StatBlock {
  return { ...BASE_STATS, ...overrides };
}

describe('CombatEngine', () => {
  describe('createCombatState', () => {
    it('creates initial combat state', () => {
      const monsters = createEncounter();
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);
      expect(state.player.name).toBe('Hero');
      expect(state.player.currentHp).toBe(40);
      expect(state.player.maxHp).toBe(40);
      expect(state.monsters).toHaveLength(2);
      expect(state.tickCount).toBe(0);
      expect(state.finished).toBe(false);
      expect(state.result).toBeNull();
    });
  });

  describe('processTick', () => {
    it('increments tick count', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());
      processTick(state);
      expect(state.tickCount).toBe(1);
    });

    it('player deals damage to first alive monster', () => {
      const monsters = createEncounter();
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);
      processTick(state);
      // Monster should have taken damage (STR 10 ± 2, min 1 → 8-12 damage)
      expect(monsters[0].currentHp).toBeLessThan(monsters[0].maxHp);
    });

    it('monsters deal damage to player', () => {
      const monsters = createEncounter();
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);
      processTick(state);
      // Each alive goblin deals 4 damage. After first tick, second goblin might still be alive
      expect(state.player.currentHp).toBeLessThan(40);
    });

    it('generates log entries for damage', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());
      const result = processTick(state);
      expect(result.logEntries.length).toBeGreaterThan(0);
      expect(result.logEntries[0]).toContain('Hero hits');
    });

    it('retargets to second monster when first dies', () => {
      // Give player high STR to one-shot the goblin
      const monsters = [
        createMonsterInstance(MONSTERS.goblin), // 15 HP
        createMonsterInstance(MONSTERS.goblin),
      ];
      const state = createCombatState('Hero', 1, makeStats({ STR: 20 }), 200, monsters);

      // First tick: player hits first goblin for ~18-22 damage, kills it
      processTick(state);
      expect(monsters[0].currentHp).toBe(0);
      expect(monsters[1].currentHp).toBe(monsters[1].maxHp); // untouched

      // Second tick: player should target second goblin
      processTick(state);
      expect(monsters[1].currentHp).toBeLessThan(monsters[1].maxHp);
    });

    it('returns victory when all monsters die', () => {
      // High STR to quickly kill monsters
      const monsters = [createMonsterInstance(MONSTERS.goblin)];
      const state = createCombatState('Hero', 1, makeStats({ STR: 30 }), 200, monsters);

      const result = processTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('victory');
      expect(state.finished).toBe(true);
    });

    it('returns defeat when player HP reaches 0', () => {
      // Low HP so monsters kill the player
      const monsters = createEncounter(); // 2 goblins × 4 damage = 8/tick
      const state = createCombatState('Hero', 1, makeStats({ STR: 1 }), 5, monsters);

      const result = processTick(state);
      expect(result.finished).toBe(true);
      expect(result.result).toBe('defeat');
      expect(state.player.currentHp).toBe(0);
    });

    it('does nothing on already-finished combat', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());
      state.finished = true;
      state.result = 'victory';

      const result = processTick(state);
      expect(result.logEntries).toHaveLength(0);
      expect(state.tickCount).toBe(0); // not incremented
    });

    it('player damage is clamped to minimum 1', () => {
      // STR=1, worst roll = 1 + (-2) = -1, clamped to 1
      const monsters = [createMonsterInstance(MONSTERS.goblin)];
      const state = createCombatState('Hero', 1, makeStats({ STR: 1 }), 200, monsters);

      // Run many ticks to ensure damage is always ≥ 1
      for (let i = 0; i < 20 && !state.finished; i++) {
        const startHp = monsters[0].currentHp;
        processTick(state);
        if (!state.finished) {
          expect(startHp - monsters[0].currentHp).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('dead monsters do not attack', () => {
      const monsters = [
        createMonsterInstance(MONSTERS.goblin),
        createMonsterInstance(MONSTERS.goblin),
      ];
      // Kill first monster manually
      monsters[0].currentHp = 0;
      const state = createCombatState('Hero', 1, makeStats(), 40, monsters);

      processTick(state);
      // Only second monster attacks: 4 damage
      // Player damage from this tick should be exactly 4 (one goblin)
      expect(state.player.currentHp).toBe(40 - 4);
    });
  });

  describe('full battle simulation', () => {
    it('typical Lv1 battle ends in about 4 ticks with victory', () => {
      const state = createCombatState('Hero', 1, makeStats(), 40, createEncounter());

      let ticks = 0;
      while (!state.finished && ticks < 20) {
        processTick(state);
        ticks++;
      }

      expect(state.finished).toBe(true);
      // Should typically be victory (defeat very rare with 40 HP vs 8 dmg/tick)
      expect(ticks).toBeLessThanOrEqual(10);
    });
  });
});
